import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext } from "@amira/api"
import { reduceStage } from "../src/stage.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { nextSuggestion } from "../src/stage-view.ts"
import { commandHarness, consume, startReview, summarize, trial } from "./batch-test-helper.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("a problem during running review waits; a blocked automated result cannot continue past it", async () => {
  const f = await bindingFixture(roots, true, true)
  const h = commandHarness(f.project)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await trial(f.store, review.state, review.verdict, "pending")
  state = await trial(f.store, state, review.verdict, "problem")
  const running = structuredClone(state)
  state = await h.run()
  expect(state).toEqual(running)
  expect(h.dialogs).toEqual([])
  expect(h.output.join("\n")).toContain("Wait for the running review to finish")
  for (const language of ["en", "zh", "ja"])
    expect(nextSuggestion(state, language)).toContain("/project revisit")
  state = await consume(
    f.store,
    state,
    {
      ...review.verdict,
      outcome: "blocked",
      items: review.verdict.items.map((item) => ({ ...item, status: "blocked" })),
    },
    true,
  )
  expect(() =>
    reduceStage(state, {
      type: "confirm-continuation",
      expectedRevision: state.revision,
      receipt: human(state, state.activeAttemptId!, "resume"),
    }),
  ).toThrow(/problem|repair/)
  state = await h.run()
  expect(state.stage).toBe("implement")
  expect(state.transitions.at(-1)?.kind).toBe("repair")
  expect(state.attempts.at(-1)?.acceptance?.verdict).toBe("blocked")
})

test("manual repair cancellation and stale approval preserve the problem and require fresh confirmation", async () => {
  const f = await bindingFixture(roots, true, true)
  const h = commandHarness(f.project)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await summarize(f.store, await consume(f.store, review.state, review.verdict, true))
  state = await trial(f.store, state, review.verdict, "pending")
  state = await trial(f.store, state, review.verdict, "problem")
  const original = structuredClone(state.attempts)
  h.control.confirm = async () => false
  state = await h.run()
  expect(state.pending?.kind).toBe("repair")
  h.control.pick = async (_title, options) => options.find((option) => option === "Continue current stage")
  state = await h.run()
  expect(state.pending).toBeUndefined()
  expect(state.manualTrial?.status).toBe("problem")
  h.control.pick = async (_title, options) => options[0]
  state = await h.run()
  const approval = human(state, state.pending!.id, "implement")
  const staleRevision = state.revision
  state = (
    await f.store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "accept",
      language: "en",
      outputs: [],
      summary: "Concurrent evidence",
      suggestion: "Reload approval",
    })
  ).state
  await expect(
    f.store.dispatch(staleRevision, {
      type: "confirm-transition",
      expectedRevision: staleRevision,
      receipt: approval,
    }),
  ).rejects.toThrow(/stale.*revision/i)
  expect(state.stage).toBe("accept")
  expect(state.attempts).toEqual(original)
  h.control.confirm = async () => true
  state = await h.run()
  expect(state.stage).toBe("implement")
  expect(state.attempts).toEqual(original)
  expect(state.batchResolutions).toEqual([])
})

test("repair requires a real current human problem, never a recommendation, stale receipt or different artifact", async () => {
  const f = await bindingFixture(roots, true, true)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await summarize(f.store, await consume(f.store, review.state, review.verdict, true))
  state = await trial(f.store, state, review.verdict, "pending")
  const proposal = {
    id: "manual-repair",
    kind: "repair" as const,
    from: "accept" as const,
    to: "implement" as const,
    summaryId: state.summaryId!,
    suggestion: "Model recommends repair",
    skippedStages: [],
    context: f.context,
  }
  await expect(
    f.store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal,
    }),
  ).rejects.toThrow(/human|problem/)
  const pendingRef = state.artifacts.find((a) => a.id === state.manualTrial!.artifactId)!
  const prompt = await f.store.readArtifact(pendingRef)
  if (prompt.kind !== "manual-trial") throw new Error("Missing trial fixture")
  await expect(
    f.store.dispatch(state.revision, {
      type: "record-manual-trial",
      expectedRevision: state.revision,
      status: "problem",
      artifact: pendingRef,
      receipt: { ...human(state, pendingRef.id, "problem"), context: undefined },
    }),
  ).rejects.toThrow(/immutable|status/)
  for (const wrong of [
    { attemptId: "old-review" },
    { attempt: 2 },
    { codeHash: "d".repeat(64) },
    { batchId: "B2" },
    { specRevision: 2 },
    { batchPlan: { ...prompt.batchPlan, hash: "d".repeat(64) } },
  ])
    await expect(
      f.store.saveArtifact(state.revision, {
        ...prompt,
        ...wrong,
        status: "problem",
        result: "Observed UI issue",
      }),
    ).rejects.toThrow(/bind|attempt|snapshot|spec|plan|batch/i)
  state = await trial(f.store, state, review.verdict, "problem")
  for (const mutate of [
    (s: typeof state) => {
      s.receipts = s.receipts.filter((r) => r.id !== s.manualTrial!.receiptId)
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.choice = "tried"
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.subjectId = "wrong-trial"
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.revision = s.revision
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.projectId = "another-project"
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.iteration += 1
    },
    (s: typeof state) => {
      s.receipts.at(-1)!.context = f.context
    },
    (s: typeof state) => {
      s.manualTrial!.artifactId = f.context.batchPlan.artifactId
    },
    (s: typeof state) => {
      s.attempts.at(-1)!.context = { ...f.context, batchId: "B2" }
    },
    (s: typeof state) => {
      s.attempts.at(-1)!.status = "interrupted"
    },
  ]) {
    const bad = structuredClone(state)
    mutate(bad)
    expect(() =>
      reduceStage(bad, {
        type: "propose-transition",
        expectedRevision: bad.revision,
        proposal,
      }),
    ).toThrow()
  }
  for (const status of ["pending", "tried", "deferred", "problem"] as const) {
    state = await f.store.read()
    await expect(trial(f.store, state, review.verdict, status)).rejects.toThrow(/problem|repair/)
  }
  state = await f.store.read()
  expect(state.manualTrial?.status).toBe("problem")
  for (const context of [
    { ...f.context, batchId: "B2" },
    { ...f.context, spec: { ...f.context.spec, revision: 2 } },
    { ...f.context, batchPlan: { ...f.context.batchPlan, hash: "c".repeat(64) } },
  ])
    expect(() =>
      reduceStage(state, {
        type: "propose-transition",
        expectedRevision: state.revision,
        proposal: { ...proposal, context },
      }),
    ).toThrow()
})

test("en/zh/ja next commands explain same-batch human repair without inventing failing item IDs", async () => {
  const f = await bindingFixture(roots, true, true)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await summarize(f.store, await consume(f.store, review.state, review.verdict, true))
  state = await trial(f.store, state, review.verdict, "pending")
  state = await trial(f.store, state, review.verdict, "problem")
  for (const [language, expected] of [
    ["en", "human-reported UI problem"],
    ["zh", "人工报告的界面问题"],
    ["ja", "人が報告した UI の問題"],
  ]) {
    const ctx = {
      signal: new AbortController().signal,
      session: { info: () => ({ id: "main" }) },
      ui: { select: async (_title: string, options: string[]) => options[0], confirm: async () => false },
      print: () => {},
    } as unknown as CommandContext
    state = await runStageCommand(
      "next",
      [],
      f.project,
      ctx,
      language!,
      () => {},
      async () => {},
    )
    expect(state.pending?.kind).toBe("repair")
    expect(state.pending?.suggestion).toContain(expected!)
    expect(state.pending?.context).toEqual(f.context)
    expect(state.attempts.at(-1)?.acceptance?.failingItemIds).toEqual([])
    state = await f.store.dispatch(state.revision, {
      type: "cancel-transition",
      expectedRevision: state.revision,
    })
    expect(nextSuggestion(state, language!)).toContain("/project next")
  }
})
