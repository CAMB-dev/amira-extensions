import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext } from "@amira/api"
import { batchProgress, reduceStage, validateIteration } from "../src/stage.ts"
import { runStageCommand, stageStatus } from "../src/stage-commands.ts"
import { commandHarness, consume, implement, startReview, summarize, trial } from "./batch-test-helper.ts"
import { bindingFixture, human, renewApproval } from "./iteration-binding-helper.ts"
import { legacyJournal } from "./legacy-batch-helper.ts"

setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("exact split plan B1=S1 B2=S2: /project next after B1 pass proposes B2, never completes", async () => {
  const f = await bindingFixture(roots, true)
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const saved = await f.store.saveArtifact(state.revision, f.verdict)
  state = await f.store.dispatch(saved.state.revision, {
    type: "finish-work",
    expectedRevision: saved.state.revision,
    attemptId: "A",
    changes: [],
    artifact: saved.artifact,
    acceptance: { verdict: "pass", failingItemIds: [], artifactId: saved.artifact.id },
  })
  const sum = await f.store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "accept",
    language: "en",
    summary: "B1 S1 passed; B2 S2 unreviewed",
    outputs: [saved.artifact.id],
    suggestion: "Prepare B2, do not claim the whole plan passed",
  })
  state = await f.store.dispatch(sum.state.revision, {
    type: "prepare-summary",
    expectedRevision: sum.state.revision,
    artifact: sum.artifact,
  })
  const output: string[] = []
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    ui: { select: async (_title: string, options: string[]) => options[0], confirm: async () => true },
    print: (text: string) => output.push(text),
  } as unknown as CommandContext
  state = await runStageCommand(
    "next",
    [],
    f.project,
    ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.completion).toBeUndefined()
  expect(state.stage).toBe("implement")
  expect(state.approvedContext?.batchId).toBe("B2")
  expect(state.approvedContext?.changes).toBeUndefined()
  expect(state.attempts).toHaveLength(1)
  expect(output.join("\n")).toContain("/project implement")
})

test("B1 pass: pending/cancel/stale approval, fresh B2 authorization/start, B2 pass and only then complete", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await summarize(f.store, await consume(f.store, review.state, review.verdict))
  const attempts = structuredClone(state.attempts)
  // Every alternate final route is rejected while B2 remains unconsumed.
  for (const kind of ["complete", "advance"] as const)
    expect(() =>
      reduceStage(state, {
        type: "propose-transition",
        expectedRevision: state.revision,
        proposal: {
          id: `bypass-${kind}`,
          from: "accept",
          to: null,
          kind,
          summaryId: state.summaryId!,
          suggestion: "Premature completion",
          skippedStages: [],
          context: f.context,
        },
      }),
    ).toThrow(/remaining|completion/)
  const absent = structuredClone(state)
  delete absent.batchManifests
  expect(() =>
    reduceStage(absent, {
      type: "propose-transition",
      expectedRevision: absent.revision,
      proposal: {
        id: "missing-membership",
        from: "accept",
        to: null,
        kind: "complete",
        summaryId: absent.summaryId!,
        suggestion: "Missing metadata",
        skippedStages: [],
        context: f.context,
      },
    }),
  ).toThrow(/manifest/)
  h.control.confirm = async () => false
  state = await h.run()
  expect(state.pending?.kind).toBe("next-batch")
  expect(state.pending?.context).toEqual({ ...f.context, batchId: "B2", changes: undefined })
  expect(state.batchResolutions).toEqual([])
  h.control.pick = async (_title, options) => options.find((option) => option === "Continue current stage")
  state = await h.run()
  expect(state.pending).toBeUndefined()
  expect(state.attempts).toEqual(attempts)
  h.control.pick = async (_title, options) => options[0]
  h.control.confirm = async () => {
    const current = await f.store.read()
    await f.store.saveArtifact(current.revision, {
      kind: "stage-summary",
      stage: "accept",
      language: "en",
      summary: "Concurrent evidence",
      outputs: [],
      suggestion: "Reload",
    })
    return true
  }
  await expect(h.run()).rejects.toThrow(/stale.*revision/i)
  state = await f.store.read()
  expect(state.stage).toBe("accept")
  expect(state.batchResolutions).toEqual([])
  h.control.confirm = async () => true
  state = await h.run()
  expect(state.stage).toBe("implement")
  expect(state.approvedContext?.changes).toBeUndefined()
  expect(state.attempts).toEqual(attempts)
  expect(state.batchResolutions).toMatchObject([
    { batchId: "B1", status: "accepted", attemptId: review.verdict.attemptId },
  ])
  expect(state.receipts.at(-1)?.context).toEqual(state.approvedContext)
  expect(h.dialogs.join("\n")).toContain('"batchId": "B2"')
  expect(h.dialogs.join("\n")).toContain(f.context.spec.hash)
  state = await implement(f.store, state)
  state = await h.run()
  expect(state.stage).toBe("accept")
  expect(state.approvedContext?.changes).toEqual(["diff:B2-fresh"])
  const b2 = await startReview(f.store, state, f.verdict)
  state = await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
  expect(state.completion).toBeUndefined()
  state = await h.run()
  expect(state.completion).toBe("accepted")
  expect(batchProgress(state).remaining).toEqual([])
  expect(state.batchResolutions?.map((entry) => [entry.batchId, entry.status])).toEqual([
    ["B1", "accepted"],
    ["B2", "accepted"],
  ])
  expect(state.attempts.slice(0, 1)).toEqual(attempts)
  expect(stageStatus(state, "en")).toContain("Accepted batches: B1, B2")
})

for (const whole of [false, true]) {
  test(`${whole ? "whole acceptance" : "current batch"} skip has exact plan-bound receipt and never claims pass`, async () => {
    const f = await bindingFixture(roots, true)
    const h = commandHarness(f.project)
    let state = await h.run("skip", [whole ? "accept" : "batch"])
    expect(state.batchResolutions?.map((entry) => [entry.batchId, entry.status])).toEqual(
      whole
        ? [
            ["B1", "skipped"],
            ["B2", "skipped"],
          ]
        : [["B1", "skipped"]],
    )
    expect(state.transitions.at(-1)?.skippedBatchIds).toEqual(whole ? ["B1", "B2"] : ["B1"])
    expect(state.receipts.at(-1)?.context?.batchPlan).toEqual(f.context.batchPlan)
    expect(h.output.join("\n")).toContain("No passing acceptance is claimed")
    if (!whole) {
      expect(state.approvedContext?.batchId).toBe("B2")
      expect(state.approvedContext?.changes).toBeUndefined()
      state = await implement(f.store, state)
      state = await h.run()
      const b2 = await startReview(f.store, state, f.verdict)
      state = await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
      state = await h.run()
    }
    expect(state.completion).toBe("skipped")
    expect(stageStatus(state, "en")).toContain("not a pass")
    expect(stageStatus(state, "en")).not.toMatch(/\nAccepted\n/)
  })
}

test("B1 passed then explicit B2 skip completes as skipped, preserving B1 acceptance", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  state = await implement(f.store, state)
  await h.run()
  state = await h.run("skip", ["batch"])
  expect(state.completion).toBe("skipped")
  expect(state.batchResolutions?.map((entry) => [entry.batchId, entry.status])).toEqual([
    ["B1", "accepted"],
    ["B2", "skipped"],
  ])
  expect(state.transitions.at(-1)?.skippedBatchIds).toEqual(["B2"])
})

test("each batch needs its own consumed passing evidence and resolved trial; problem cannot advance", async () => {
  const f = await bindingFixture(roots, true, true)
  const h = commandHarness(f.project)
  let state = f.state
  for (const batchId of ["B1", "B2"]) {
    expect(state.approvedContext?.batchId).toBe(batchId)
    let review = await startReview(f.store, state, f.verdict)
    // Publication does not consume the pass.
    const published = await f.store.saveArtifact(review.state.revision, review.verdict)
    expect(published.state.batchResolutions).toEqual(batchId === "B1" ? [] : state.batchResolutions!)
    expect(published.state.attempts.at(-1)?.acceptance).toBeUndefined()
    state = await f.store.dispatch(published.state.revision, {
      type: "finish-work",
      expectedRevision: published.state.revision,
      attemptId: review.verdict.attemptId,
      changes: [],
      artifact: published.artifact,
      acceptance: {
        verdict: "pass",
        artifactId: published.artifact.id,
        failingItemIds: [],
        manualTrialRequired: true,
      },
    })
    state = await summarize(f.store, state)
    state = await h.run()
    expect(state.pending).toBeUndefined()
    expect(state.completion).toBeUndefined()
    state = await trial(f.store, state, review.verdict, "pending")
    state = await trial(f.store, state, review.verdict, "problem")
    const proposal = {
      id: `ignore-problem-${batchId}`,
      from: "accept" as const,
      to: batchId === "B1" ? ("implement" as const) : null,
      kind: batchId === "B1" ? ("next-batch" as const) : ("complete" as const),
      summaryId: state.summaryId!,
      suggestion: "Ignore manual problem",
      skippedStages: [],
      context: batchId === "B1" ? { ...f.context, batchId: "B2", changes: undefined } : state.approvedContext,
    }
    expect(() =>
      reduceStage(state, { type: "propose-transition", expectedRevision: state.revision, proposal }),
    ).toThrow(/manual/)
    const problemAttempt = structuredClone(state.attempts.at(-1))
    state = await h.run()
    expect(state.stage).toBe("implement")
    expect(state.approvedContext?.batchId).toBe(batchId)
    expect(state.transitions.at(-1)?.kind).toBe("repair")
    state = await implement(f.store, state, [`diff:${batchId}-manual-repair`])
    state = await h.run()
    review = await startReview(f.store, state, { ...f.verdict, codeHash: "f".repeat(64) })
    state = await summarize(f.store, await consume(f.store, review.state, review.verdict, true))
    state = await trial(f.store, state, review.verdict, "pending")
    expect(state.attempts.find((entry) => entry.id === problemAttempt?.id)).toEqual(problemAttempt)
    state = await trial(f.store, state, review.verdict, "tried")
    state = await h.run()
    if (batchId === "B1") {
      expect(state.stage).toBe("implement")
      expect(state.manualTrial).toBeUndefined()
      state = await implement(f.store, state)
      state = await h.run()
      const stale = {
        ...review.verdict,
        batchId: "B2",
        items: [{ itemId: "S2", status: "pass" as const, evidence: ["Old trial"], reason: "Stale" }],
      }
      await expect(trial(f.store, state, stale, "pending")).rejects.toThrow(
        /active|current|attempt|boundary/i,
      )
    }
  }
  expect(state.completion).toBe("accepted")
  expect(state.batchResolutions?.every((entry) => entry.manualTrial?.status === "tried")).toBe(true)
  expect(new Set(state.batchResolutions?.map((entry) => entry.manualTrial?.artifactId)).size).toBe(2)
}, 300_000)

for (const outcome of ["fail", "blocked"] as const) {
  test(`${outcome} cannot resolve either batch; repair/continuation retains history and batch`, async () => {
    const f = await bindingFixture(roots, true)
    const h = commandHarness(f.project)
    let state = f.state
    for (const batchId of ["B1", "B2"]) {
      const review = await startReview(f.store, state, f.verdict)
      const verdict = {
        ...review.verdict,
        outcome,
        items: review.verdict.items.map((entry) => ({ ...entry, status: outcome })),
      }
      state = await consume(f.store, review.state, verdict)
      const oldAttempt = structuredClone(state.attempts.at(-1))
      const resolved = structuredClone(state.batchResolutions)
      if (outcome === "fail") state = await summarize(f.store, state)
      state = await h.run()
      expect(state.completion).toBeUndefined()
      expect(state.batchResolutions).toEqual(resolved)
      expect(state.approvedContext?.batchId).toBe(batchId)
      expect(state.attempts.find((entry) => entry.id === verdict.attemptId)).toEqual(oldAttempt)
      if (outcome === "fail") {
        expect(state.stage).toBe("implement")
        state = await implement(f.store, state, [`diff:${batchId}-repair`])
        state = await h.run()
      }
      const retry = await startReview(f.store, state, f.verdict)
      await summarize(f.store, await consume(f.store, retry.state, retry.verdict))
      state = await h.run()
      expect(state.batchResolutions?.at(-1)?.attemptId).toBe(retry.verdict.attemptId)
      if (batchId === "B1") {
        expect(state.stage).toBe("implement")
        expect(state.approvedContext?.batchId).toBe("B2")
        expect(state.completion).toBeUndefined()
        state = await implement(f.store, state)
        state = await h.run()
      }
    }
    expect(state.completion).toBe("accepted")
  })
}

test("replanning isolates batch resolutions and store rejects forged manifest membership", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  const review = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, review.state, review.verdict))
  let state = await h.run()
  const oldResolutions = structuredClone(state.batchResolutions)
  const newPlan = await f.store.saveArtifact(state.revision, { ...f.plan })
  state = await renewApproval(f.store, newPlan.state, {
    ...f.context,
    batchPlan: { artifactId: newPlan.artifact.id, hash: newPlan.artifact.hash },
    batchId: "B2",
    mode: "single",
    changes: undefined,
  })
  expect(batchProgress(state).remaining).toEqual(["B1", "B2"])
  expect(state.batchResolutions).toEqual(oldResolutions)
  expect(state.approvedContext?.batchPlan?.artifactId).not.toBe(f.context.batchPlan.artifactId)
  const forged = structuredClone(state)
  forged.batchManifests!.at(-1)!.batchIds = ["B2"]
  // Pure metadata cannot be introduced through a model-selected artifact event.
  await expect(
    f.store.dispatch(state.revision, {
      type: "record-artifact",
      expectedRevision: state.revision,
      artifact: newPlan.artifact,
      manifest: forged.batchManifests!.at(-1),
    }),
  ).rejects.toThrow(/manifest|immutable|membership/)
  const missingResolution = structuredClone(state)
  missingResolution.phase = "complete"
  missingResolution.completion = "accepted"
  expect(() => validateIteration(missingResolution)).toThrow(/completion/)
  expect((await f.store.read()).batchResolutions).toEqual(oldResolutions)
})

for (const split of [false, true]) {
  test(`legacy consumed B1 pass ${split ? "does not invent B2 completion" : "safely reconstructs a single-batch completion"}`, async () => {
    const f = await bindingFixture(roots, split)
    let state = await f.store.dispatch(f.state.revision, {
      type: "start-work",
      expectedRevision: f.state.revision,
      attemptId: f.verdict.attemptId,
      review: { attempt: f.verdict.attempt, codeHash: f.verdict.codeHash },
    })
    state = await summarize(f.store, await consume(f.store, state, f.verdict))
    const attempts = structuredClone(state.attempts)
    if (split) {
      // Reproduce the pre-fix terminal snapshot: a valid consumed B1 pass with
      // human completion, but B2 never executed or skipped.
      const proposal = {
        id: "legacy-premature-complete",
        from: "accept" as const,
        to: null,
        kind: "complete" as const,
        summaryId: state.summaryId!,
        suggestion: "Legacy final completion after B1",
        skippedStages: [],
        context: f.context,
      }
      const receipt = human(state, proposal.id, "complete")
      const legacy = {
        ...state,
        revision: state.revision + 1,
        phase: "complete" as const,
        completion: "accepted" as const,
        transitions: [...state.transitions, proposal],
        receipts: [...state.receipts, receipt],
        activeAttemptId: undefined,
        summaryId: undefined,
      }
      await legacyJournal(f.project, legacy)
    } else {
      state = await commandHarness(f.project).run()
      expect(state.completion).toBe("accepted")
      await legacyJournal(f.project)
    }
    state = await f.store.read()
    expect(state.attempts).toEqual(attempts)
    expect(state.batchResolutions).toMatchObject([
      { batchId: "B1", status: "accepted", attemptId: f.verdict.attemptId },
    ])
    expect(state.batchManifests?.[0]?.batchIds).toEqual(split ? ["B1", "B2"] : ["B1"])
    if (split) {
      expect(state.completion).toBeUndefined()
      expect(batchProgress(state).remaining).toEqual(["B2"])
      state = await commandHarness(f.project).run()
      expect(state.stage).toBe("implement")
      expect(state.approvedContext?.batchId).toBe("B2")
      expect(state.completion).toBeUndefined()
      expect(state.batchResolutions).toHaveLength(1)
    } else expect(state.completion).toBe("accepted")
  })
}

test("interrupted reviews and published-but-unconsumed pass never resolve either batch", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  let state = f.state
  for (const batchId of ["B1", "B2"]) {
    const review = await startReview(f.store, state, f.verdict)
    const saved = await f.store.saveArtifact(review.state.revision, review.verdict)
    state = await f.store.dispatch(saved.state.revision, {
      type: "interrupt-work",
      expectedRevision: saved.state.revision,
      attemptId: review.verdict.attemptId,
      changes: [`diff:${batchId}-interrupted`],
    })
    const count = batchId === "B1" ? 0 : 1
    expect(state.batchResolutions).toHaveLength(count)
    state = await h.run()
    expect(state.batchResolutions).toHaveLength(count)
    expect(state.completion).toBeUndefined()
    const retry = await startReview(f.store, state, f.verdict)
    await summarize(f.store, await consume(f.store, retry.state, retry.verdict))
    state = await h.run()
    expect(state.attempts.find((entry) => entry.id === review.verdict.attemptId)?.status).toBe("interrupted")
    if (batchId === "B1") {
      state = await implement(f.store, state)
      state = await h.run()
    }
  }
  expect(state.completion).toBe("accepted")
  expect(state.batchResolutions?.map((entry) => entry.attemptId)).toEqual(["review-2", "review-4"])
})

test("B2 implementation authorization/start can be interrupted and explicitly batch-skipped without claiming acceptance", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "B2-started",
  })
  const workingRevision = state.revision
  await expect(h.run("skip", ["batch"])).rejects.toThrow(/interrupt current work/)
  expect((await f.store.read()).revision).toBe(workingRevision)
  state = await f.store.dispatch(state.revision, {
    type: "interrupt-work",
    expectedRevision: state.revision,
    attemptId: "B2-started",
    changes: ["diff:B2-preserved"],
  })
  state = await h.run("skip", ["batch"])
  expect(state.completion).toBe("skipped")
  expect(state.stage).toBe("accept")
  expect(state.batchResolutions?.map((entry) => [entry.batchId, entry.status])).toEqual([
    ["B1", "accepted"],
    ["B2", "skipped"],
  ])
  expect(state.attempts.find((entry) => entry.id === "B2-started")).toMatchObject({
    status: "interrupted",
    changes: ["diff:B2-preserved"],
  })
  expect(state.attempts.find((entry) => entry.id === "B2-started")?.acceptance).toBeUndefined()
  expect(state.transitions.at(-1)?.from).toBe("implement")
  expect(state.transitions.at(-1)?.skippedBatchIds).toEqual(["B2"])
  expect(h.output.join("\n")).toContain("No passing acceptance is claimed")
})
