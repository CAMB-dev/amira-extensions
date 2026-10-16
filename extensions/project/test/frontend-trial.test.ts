import { expect, setDefaultTimeout, test } from "bun:test"
import type { IterationStore } from "../src/store.ts"
import { ESC, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"

setDefaultTimeout(120_000)

/** Execution-owned evidence only: the pending transition is approved through the actual terminal. */
async function proposeUiReview(store: IterationStore) {
  const initial = await store.read()
  const spec = await store.saveArtifact(initial.revision, {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "An offline UI review",
    body: "S1: show a local control.",
    decisionIds: [],
    items: [
      {
        id: "S1",
        description: "Local control",
        constraints: [],
        verification: ["Try the control"],
        acceptanceCriteria: ["Control responds"],
        decisionIds: [],
        checkIds: [],
        ui: true,
      },
    ],
    checks: [],
  })
  const plan = await store.saveArtifact(spec.state.revision, {
    kind: "batch-plan",
    specHash: spec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: ["src/control.ts"] }],
  })
  const context = {
    spec: { artifactId: spec.artifact.id, revision: 1, hash: spec.artifact.hash },
    batchPlan: { artifactId: plan.artifact.id, hash: plan.artifact.hash },
    batchId: "B1",
    mode: "single" as const,
    model: "mock/frontend",
    changes: ["diff:offline-control"],
  }
  const summary = await store.saveArtifact(plan.state.revision, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Review the existing local control",
    outputs: context.changes,
    suggestion: "Review existing implementation; no executor starts",
  })
  const state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "frontend-ui-review",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review existing implementation; no executor starts",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  return context
}

async function pendingTrial(f: Awaited<ReturnType<typeof frontend>>) {
  const context = await proposeUiReview(f.store)
  f.send("next")
  await f.dialog("Choose the next step")
  f.terminal.send("\r")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  await f.visible("acceptance · idle")
  const approved = await f.store.read()
  expect(approved.receipts).toHaveLength(1)
  const attemptId = "frontend-ui-review-1"
  const codeHash = "c".repeat(64)
  const started = await f.store.dispatch(approved.revision, {
    type: "start-work",
    expectedRevision: approved.revision,
    attemptId,
    review: { attempt: 1, codeHash },
  })
  const trial = await f.store.saveArtifact(started.revision, {
    kind: "manual-trial",
    specHash: context.spec.hash,
    specRevision: 1,
    batchPlan: context.batchPlan,
    batchId: "B1",
    attemptId,
    attempt: 1,
    codeHash,
    instructions: "Open the offline local control",
    observe: ["Try the control and observe its response"],
    status: "pending",
  })
  return f.store.dispatch(trial.state.revision, {
    type: "record-manual-trial",
    expectedRevision: trial.state.revision,
    artifact: trial.artifact,
    status: "pending",
  })
}

async function interruptForDesign(f: Awaited<ReturnType<typeof frontend>>) {
  f.send("revisit design")
  await f.dialog("Revisit design?")
  expect(f.live()).toContain("Interrupt and preserve changes")
  f.terminal.send("\r")
  await waitFor(() => f.host.ui.pending.length > 0, "dialog following interrupt", 20_000)
  // Fail immediately on the regression: the old UI trial must not preempt the revisit confirmation.
  expect(f.host.ui.pending[0]?.title).toBe("Confirm stage change")
  await f.dialog("Confirm stage change")
  expect(f.live()).toContain("Return to design; preserve changes")
  expect(f.live()).not.toContain("Record manual UI trial")
}

frontendSuite("frontend-trial", () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    test(`${mode}: pending manual trial cannot preempt revisit or resurrect after cancellation and explicit continuation`, async () => {
      const f = await frontend(mode)
      try {
        const before = await pendingTrial(f)
        await interruptForDesign(f)
        f.terminal.send(ESC)
        await f.dismissed()
        const pending = await f.store.read()
        expect(pending.pending?.kind).toBe("revisit")
        expect(pending.revisit?.policy).toBe("interrupt")
        expect(pending.attempts.at(-1)?.status).toBe("interrupted")
        f.send("next")
        await f.dialog("Choose the next step")
        f.terminal.send("\x1b[B\x1b[B\x1b[B\r")
        await f.dismissed()
        await f.visible("acceptance · interrupted")
        const cancelled = await f.store.read()
        expect(cancelled.revisit).toBeUndefined()
        expect(cancelled.pending).toBeUndefined()
        expect(cancelled.manualTrial).toBeUndefined()
        expect(cancelled.revisitHistory?.at(-1)?.cancelReceiptId).toBeDefined()
        f.send("next")
        await f.dialog("Confirm continuation")
        expect(f.live()).toContain("No executor will start")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.visible("acceptance · idle")
        const continued = await f.store.read()
        expect(continued.manualTrial).toBeUndefined()
        expect(continued.manualTrialRequired).not.toBe(true)
        expect(continued.attempts).toEqual(cancelled.attempts)
        expect(continued.artifacts.slice(0, before.artifacts.length)).toEqual(before.artifacts)
        expect(continued.receipts.at(-1)?.choice).toBe("resume")
        expect(continued.completion).toBeUndefined()
        await f.command("next", "Acceptance: coming next")
        await f.command("status", "Manual trial: not requested")
        expect(f.host.ui.pending).toEqual([])
        expect((await f.store.read()).revision).toBe(continued.revision)
        expect(f.mock.requests).toEqual([])
      } finally {
        await f.cleanup()
      }
    })

    test(`${mode}: confirming design revisit retires the old pending trial while preserving bound evidence`, async () => {
      const f = await frontend(mode)
      try {
        const before = await pendingTrial(f)
        await interruptForDesign(f)
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.visible("design · idle")
        const returned = await f.store.read()
        expect(returned.transitions.at(-1)?.kind).toBe("revisit")
        expect(returned.manualTrial).toBeUndefined()
        expect(returned.manualTrialRequired).not.toBe(true)
        expect(returned.artifacts.slice(0, before.artifacts.length)).toEqual(before.artifacts)
        expect(returned.attempts.at(-1)?.status).toBe("interrupted")
        expect(returned.completion).toBeUndefined()
        f.send("next")
        await f.dialog("Choose the next step")
        expect(f.live()).toContain("Continue design")
        expect(f.live()).not.toContain("Record manual UI trial")
        f.terminal.send(ESC)
        await f.dismissed()
        await f.command("status", "Manual trial: not requested")
        expect(f.mock.requests).toEqual([])
      } finally {
        await f.cleanup()
      }
    })
  }
})
