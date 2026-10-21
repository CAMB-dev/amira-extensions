import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AcceptanceArtifact, SpecArtifact } from "../src/artifacts.ts"
import type { HumanReceipt, IterationState } from "../src/stage.ts"
import { createProject, DecisionStore, IterationStore } from "../src/store.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const spec: SpecArtifact = {
  kind: "spec",
  revision: 1,
  language: "en",
  summary: "A UI feature",
  body: "Implement S1.",
  decisionIds: [],
  items: [
    {
      id: "S1",
      description: "A usable control",
      constraints: [],
      verification: ["Run C1"],
      acceptanceCriteria: ["Expected control"],
      decisionIds: [],
      checkIds: ["C1"],
      ui: true,
    },
  ],
  checks: [{ id: "C1", command: "bun test" }],
}
function receipt(
  state: IterationState,
  subjectId: string,
  choice: string,
  context?: HumanReceipt["context"],
): HumanReceipt {
  return {
    id: `human-${state.revision}`,
    provenance: "human",
    projectId: state.projectId,
    iteration: state.iteration,
    revision: state.revision,
    subjectId,
    choice,
    reason: "Explicit fixture human choice",
    ...(context ? { context } : {}),
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-iteration-gates-"))
  roots.push(root)
  const project = await createProject(root, "Gates")
  const store = new IterationStore(project)
  const saved = await store.saveArtifact(0, spec)
  const savedPlan = await store.saveArtifact(1, {
    kind: "batch-plan",
    specHash: saved.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: ["src/ui.ts"] }],
  })
  const context = {
    spec: { artifactId: saved.artifact.id, revision: 1, hash: saved.artifact.hash },
    batchPlan: { artifactId: savedPlan.artifact.id, hash: savedPlan.artifact.hash },
    batchId: "B1",
    changes: ["diff:existing"],
    mode: "single" as const,
    model: "mock/coder",
  }
  let state = savedPlan.state
  const sum = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Review existing changes",
    outputs: [],
    suggestion: "Acceptance only",
  })
  state = await store.dispatch(sum.state.revision, {
    type: "prepare-summary",
    expectedRevision: sum.state.revision,
    artifact: sum.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "review-existing",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review existing changes",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: receipt(state, "review-existing", "accept", context),
  })
  state = await store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "review-1",
    review: { attempt: 1, codeHash: "b".repeat(64) },
  })
  const verdict: AcceptanceArtifact = {
    kind: "acceptance",
    specHash: saved.artifact.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: context.batchPlan,
    attemptId: "review-1",
    attempt: 1,
    codeHash: "b".repeat(64),
    reviewerModel: "mock/reviewer",
    implementerModels: ["mock/coder"],
    sameModelFallback: false,
    outcome: "pass",
    items: [{ itemId: "S1", status: "pass", evidence: ["C1 output"], reason: "Observed" }],
    checks: [
      {
        checkId: "C1",
        cwd: project.root,
        command: "bun test",
        startedAt: "2026-10-15T00:00:00Z",
        finishedAt: "2026-10-15T00:00:01Z",
        status: "passed",
        exitCode: 0,
        output: "1 pass",
      },
    ],
  }
  return { project, store, state, verdict, context }
}

test("UI acceptance cannot omit the manual-trial gate and a human deferral resolves pending, not tried", async () => {
  const f = await fixture()
  const saved = await f.store.saveArtifact(f.state.revision, f.verdict)
  let state = saved.state
  await expect(
    f.store.dispatch(state.revision, {
      type: "finish-work",
      expectedRevision: state.revision,
      attemptId: "review-1",
      changes: [],
      artifact: saved.artifact,
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: saved.artifact.id },
    }),
  ).rejects.toThrow(/manual|UI/i)
  state = await f.store.dispatch(state.revision, {
    type: "finish-work",
    expectedRevision: state.revision,
    attemptId: "review-1",
    changes: [],
    artifact: saved.artifact,
    acceptance: {
      verdict: "pass",
      failingItemIds: [],
      artifactId: saved.artifact.id,
      manualTrialRequired: true,
    },
  })
  const sum = await f.store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "accept",
    language: "en",
    summary: "Automated pass",
    outputs: [],
    suggestion: "Finish after manual trial",
  })
  state = await f.store.dispatch(sum.state.revision, {
    type: "prepare-summary",
    expectedRevision: sum.state.revision,
    artifact: sum.artifact,
  })
  const propose = () =>
    f.store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: "finish",
        from: "accept",
        to: null,
        kind: "complete",
        summaryId: state.summaryId!,
        suggestion: "Finish",
        skippedStages: [],
        context: f.context,
      },
    })
  await expect(propose()).rejects.toThrow(/manual/i)
  const pending = await f.store.saveArtifact(state.revision, {
    kind: "manual-trial",
    specHash: f.context.spec.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: f.context.batchPlan,
    attemptId: "review-1",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Run the local UI",
    observe: ["Try the control"],
    status: "pending",
  })
  state = await f.store.dispatch(pending.state.revision, {
    type: "record-manual-trial",
    expectedRevision: pending.state.revision,
    artifact: pending.artifact,
    status: "pending",
  })
  await expect(propose()).rejects.toThrow(/manual/i)
  const deferred = await f.store.saveArtifact(state.revision, {
    kind: "manual-trial",
    specHash: f.context.spec.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: f.context.batchPlan,
    attemptId: "review-1",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Run the local UI",
    observe: ["Try the control"],
    status: "deferred",
    result: "Human explicitly deferred",
  })
  state = await f.store.dispatch(deferred.state.revision, {
    type: "record-manual-trial",
    expectedRevision: deferred.state.revision,
    artifact: deferred.artifact,
    status: "deferred",
    receipt: receipt(deferred.state, deferred.artifact.id, "deferred"),
  })
  state = await propose()
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: receipt(state, "finish", "complete", f.context),
  })
  expect(state.completion).toBe("accepted")
  expect(state.manualTrial?.status).toBe("deferred")
}, 60000)

test("blocked command evidence finishes acceptance as blocked, never pass", async () => {
  const f = await fixture()
  const blocked: AcceptanceArtifact = {
    ...f.verdict,
    outcome: "blocked",
    items: [{ itemId: "S1", status: "blocked", evidence: ["Permission denied"], reason: "Check denied" }],
    checks: f.verdict.checks.map((check) => ({ ...check, status: "blocked", exitCode: null })),
  }
  const saved = await f.store.saveArtifact(f.state.revision, blocked)
  const state = await f.store.dispatch(saved.state.revision, {
    type: "finish-work",
    expectedRevision: saved.state.revision,
    attemptId: "review-1",
    changes: [],
    artifact: saved.artifact,
    acceptance: {
      verdict: "blocked",
      failingItemIds: [],
      artifactId: saved.artifact.id,
      manualTrialRequired: true,
    },
  })
  expect(state.status).toBe("blocked")
  expect(state.completion).toBeUndefined()
}, 60000)

test("pre-verdict manual trial cannot satisfy a different acceptance attempt", async () => {
  const f = await fixture()
  const trial = {
    kind: "manual-trial" as const,
    specHash: f.context.spec.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: f.context.batchPlan,
    attemptId: "review-1",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Try the local control",
    observe: ["Control responds"],
    status: "pending" as const,
  }
  const pending = await f.store.saveArtifact(f.state.revision, trial)
  let state = await f.store.dispatch(pending.state.revision, {
    type: "record-manual-trial",
    expectedRevision: pending.state.revision,
    artifact: pending.artifact,
    status: "pending",
  })
  const tried = await f.store.saveArtifact(state.revision, {
    ...trial,
    status: "tried",
    result: "Human tried the control",
  })
  state = await f.store.dispatch(tried.state.revision, {
    type: "record-manual-trial",
    expectedRevision: tried.state.revision,
    artifact: tried.artifact,
    status: "tried",
    receipt: receipt(tried.state, tried.artifact.id, "tried"),
  })
  await expect(f.store.saveArtifact(state.revision, { ...f.verdict, attempt: 2 })).rejects.toThrow(
    /active review attempt/,
  )
  expect((await f.store.read()).status).toBe("working")
  const matchingAttempt = await f.store.saveArtifact(state.revision, f.verdict)
  state = await f.store.dispatch(matchingAttempt.state.revision, {
    type: "finish-work",
    expectedRevision: matchingAttempt.state.revision,
    attemptId: "review-1",
    changes: [],
    artifact: matchingAttempt.artifact,
    acceptance: {
      verdict: "pass",
      failingItemIds: [],
      artifactId: matchingAttempt.artifact.id,
      manualTrialRequired: true,
    },
  })
  expect(state.manualTrial?.status).toBe("tried")
  expect(state.status).toBe("idle")
}, 60000)

test("design evidence shares the iteration claim and invalidates stale stage revisions before publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-design-claim-"))
  roots.push(root)
  const project = await createProject(root, "Design claim")
  const store = new IterationStore(project)
  const before = await store.read()
  const records = await store.guardDesignRevision(before.revision, () =>
    new DecisionStore(project).record(
      [
        {
          question: "Choose storage",
          options: [
            { label: "Local", description: "Offline" },
            { label: "Remote", description: "Sync" },
          ],
        },
      ],
      [{ selected: ["Local"] }],
      { sessionId: "design", askId: "direct-human", language: "en" },
    ),
  )
  expect(records).toHaveLength(1)
  expect((await store.read()).revision).toBe(before.revision + 1)
  await expect(
    store.dispatch(before.revision, {
      type: "start-work",
      expectedRevision: before.revision,
      attemptId: "stale",
    }),
  ).rejects.toThrow(/stale/i)
  expect(await new DecisionStore(project).records()).toHaveLength(1)
})
