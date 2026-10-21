import { expect, setDefaultTimeout, test } from "bun:test"
import type { AcceptanceArtifact } from "../src/artifacts.ts"
import type { ApprovalContext } from "../src/stage.ts"
import type { IterationStore } from "../src/store.ts"
import { frontendFingerprint } from "./frontend-fingerprint.ts"
import { frontend, frontendSuite } from "./frontend-harness.ts"

setDefaultTimeout(300_000)

/** Mirrors the split-plan regression manifest: B1=S1, B2=S2, no checks or UI trial. */
async function splitReview(store: IterationStore) {
  const initial = await store.read()
  const spec = await store.saveArtifact(initial.revision, {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "Two items",
    body: "Implement S1 and S2.",
    decisionIds: [],
    checks: [],
    items: ["S1", "S2"].map((id) => ({
      id,
      description: id,
      constraints: [],
      verification: ["Inspect output"],
      acceptanceCriteria: ["Works"],
      decisionIds: [],
      checkIds: [],
      ui: false,
    })),
  })
  const plan = await store.saveArtifact(spec.state.revision, {
    kind: "batch-plan",
    specHash: spec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [
      { id: "B1", itemIds: ["S1"], decisionIds: [], files: [] },
      { id: "B2", itemIds: ["S2"], decisionIds: [], files: [] },
    ],
  })
  const context = {
    spec: { artifactId: spec.artifact.id, revision: 1, hash: spec.artifact.hash },
    batchPlan: { artifactId: plan.artifact.id, hash: plan.artifact.hash },
    batchId: "B1",
    mode: "single" as const,
    model: "offline/coder",
    changes: ["diff:existing"],
  }
  await proposeReview(store, context, "design")
  return context
}

async function proposeReview(store: IterationStore, context: ApprovalContext, from: "design" | "implement") {
  let state = await store.read()
  const summary = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: from,
    language: "en",
    summary: `Review the saved implementation for ${context.batchId}`,
    outputs: context.changes ?? [],
    suggestion: "Review existing implementation",
  })
  state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: `frontend-review-${context.batchId}`,
      from,
      to: "accept",
      kind: from === "design" ? "skip" : "advance",
      summaryId: state.summaryId!,
      suggestion: `Review ${context.batchId}`,
      skippedStages: from === "design" ? ["design", "prototype", "implement"] : [],
      context,
    },
  })
}

async function passReview(f: Awaited<ReturnType<typeof frontend>>, batchId: "B1" | "B2") {
  const { store } = f
  const codeHash = await frontendFingerprint(f.project, store)
  let state = await store.read()
  const context = state.approvedContext!
  const attemptId = `frontend-accept-${batchId}`
  const attempt = batchId === "B1" ? 1 : 2
  state = await store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId,
    review: { attempt, codeHash },
  })
  const verdict: AcceptanceArtifact = {
    kind: "acceptance",
    specHash: context.spec!.hash,
    specRevision: context.spec!.revision,
    batchId,
    batchPlan: context.batchPlan!,
    attemptId,
    attempt,
    codeHash,
    reviewerModel: "offline/reviewer",
    implementerModels: ["offline/coder"],
    sameModelFallback: false,
    outcome: "pass",
    checks: [],
    items: [
      {
        itemId: batchId === "B1" ? "S1" : "S2",
        status: "pass",
        evidence: ["Observed output"],
        reason: "Works",
      },
    ],
  }
  const saved = await store.saveArtifact(state.revision, verdict)
  state = await store.dispatch(saved.state.revision, {
    type: "finish-work",
    expectedRevision: saved.state.revision,
    attemptId,
    changes: [],
    artifact: saved.artifact,
    acceptance: { verdict: "pass", failingItemIds: [], artifactId: saved.artifact.id },
  })
  const summary = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "accept",
    language: "en",
    summary: batchId === "B1" ? "B1 S1 passed; B2 S2 unreviewed" : "B2 S2 passed",
    outputs: [saved.artifact.id],
    suggestion:
      batchId === "B1" ? "Prepare B2, do not claim the whole plan passed" : "All planned batches passed",
  })
  return store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
}

async function confirmReview(f: Awaited<ReturnType<typeof frontend>>) {
  f.send("next")
  await f.dialog("Choose the next step")
  f.terminal.send("\r")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  await f.visible("acceptance · idle")
}

frontendSuite("frontend-batch", () => {
  for (const outcome of ["pass", "skip"] as const) {
    test(`fullscreen: B1 pass proposes exact B2, starts no executor, and only B2 ${outcome} permits overall completion`, async () => {
      const f = await frontend()
      try {
        f.agent.permissions.setMode("auto")
        const context = await splitReview(f.store)
        await confirmReview(f)
        const first = await passReview(f, "B1")
        f.send("next")
        await f.dialog("Choose the next step")
        const proposed = await f.store.read()
        expect(proposed.pending?.to).toBe("implement")
        expect(proposed.pending?.context).toEqual({
          spec: context.spec,
          batchPlan: context.batchPlan,
          batchId: "B2",
          mode: context.mode,
          model: context.model,
        })
        expect(proposed.pending?.kind).toBe("next-batch")
        expect(proposed.completion).toBeUndefined()
        expect(proposed.attempts).toEqual(first.attempts)
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        expect(f.live()).toContain("Batch B1 passed; prepare B2")
        expect(f.live()).toContain('"batchId": "B2"')
        expect(f.live()).toContain("Ship requires separate approval: /project ship.")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.visible("implementation · idle")
        const second = await f.store.read()
        expect(second.approvedContext).toEqual(proposed.pending?.context)
        expect(second.receipts.at(-1)?.context).toEqual(proposed.pending?.context)
        expect(second.attempts).toEqual(first.attempts)
        expect(second.activeAttemptId).toBeUndefined()
        expect(second.completion).toBeUndefined()
        expect(f.mock.requests).toEqual([])
        await f.command("next", "Ship requires separate approval: /project ship.")
        await f.command("status", "Stage: implementation")
        expect(f.live()).toContain("Batch: B2")
        expect(f.live()).toContain("Accepted batches: B1")
        expect(f.live()).toContain("Unresolved batches: B2")
        expect(f.live()).toContain("Skipped batches (not passed): —")
        expect(f.live()).not.toMatch(/(?:^|\n)\s*Accepted\s*(?:\n|$)/)
        expect((await f.store.read()).revision).toBe(second.revision)
        // Only execution evidence is seeded; the move to acceptance is again approved in the real UI.
        let state = await f.store.dispatch(second.revision, {
          type: "start-work",
          expectedRevision: second.revision,
          attemptId: "frontend-implement-B2",
        })
        state = await f.store.dispatch(state.revision, {
          type: "finish-work",
          expectedRevision: state.revision,
          attemptId: "frontend-implement-B2",
          changes: ["diff:B2"],
        })
        await proposeReview(f.store, { ...second.approvedContext!, changes: ["diff:B2"] }, "implement")
        await confirmReview(f)
        if (outcome === "pass") {
          const passed = await passReview(f, "B2")
          expect(passed.completion).toBeUndefined()
          f.send("next")
          await f.dialog("Choose the next step")
          const complete = await f.store.read()
          expect(complete.pending?.kind).toBe("complete")
          expect(complete.pending?.to).toBeNull()
          expect(complete.completion).toBeUndefined()
          f.terminal.send("\r")
          await f.dialog("Confirm stage change")
          f.terminal.send("\x1b[B\r")
          await f.dismissed()
          await f.command("status", "Accepted")
          const accepted = await f.store.read()
          expect(accepted.completion).toBe("accepted")
          expect(accepted.batchResolutions?.map(({ batchId, status }) => ({ batchId, status }))).toEqual([
            { batchId: "B1", status: "accepted" },
            { batchId: "B2", status: "accepted" },
          ])
        } else {
          f.send("skip accept")
          await f.dialog("Confirm stage change")
          const skipped = await f.store.read()
          expect(skipped.pending?.to).toBeNull()
          expect(skipped.pending?.skippedBatchIds).toEqual(["B2"])
          expect(skipped.completion).toBeUndefined()
          expect(skipped.attempts.filter((attempt) => attempt.stage === "accept")).toHaveLength(1)
          f.terminal.send("\x1b[B\r")
          await f.dismissed()
          await f.command("status", "Acceptance skipped — not a pass")
          const complete = await f.store.read()
          expect(complete.completion).toBe("skipped")
          expect(complete.batchResolutions?.map(({ batchId, status }) => ({ batchId, status }))).toEqual([
            { batchId: "B1", status: "accepted" },
            { batchId: "B2", status: "skipped" },
          ])
        }
        expect(f.mock.requests).toEqual([])
      } finally {
        await f.cleanup()
      }
    })
  }
})
