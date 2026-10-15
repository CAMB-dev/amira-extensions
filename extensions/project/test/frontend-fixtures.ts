import { createHash } from "node:crypto"
import type { ApprovalContext, HumanReceipt, IterationState } from "../src/stage.ts"
import type { IterationStore } from "../src/store.ts"

function human(
  state: IterationState,
  subjectId: string,
  choice: string,
  context?: ApprovalContext,
): HumanReceipt {
  return {
    id: `frontend-human-${state.revision}`,
    provenance: "human",
    projectId: state.projectId,
    iteration: state.iteration,
    revision: state.revision,
    subjectId,
    choice,
    reason: "Explicit offline fixture approval before opening the frontend",
    ...(context ? { context } : {}),
  }
}

/** The durable boundary a process can leave between recording a revisit request and publishing its summary. */
export async function unresolvedRevisit(store: IterationStore) {
  const state = await store.read()
  return store.dispatch(state.revision, {
    type: "request-revisit",
    expectedRevision: state.revision,
    target: "design",
    policy: "interrupt",
    changes: [],
    receipt: human(state, `revisit:${state.stage}`, "design"),
  })
}

/** Exact request -> summary -> (crash before proposal) boundary from the acceptance review. */
export async function summarizedRevisit(store: IterationStore) {
  const requested = await unresolvedRevisit(store)
  const saved = await store.saveArtifact(requested.revision, {
    kind: "stage-summary",
    stage: requested.stage,
    language: "en",
    summary: "Revisit requested; existing history is preserved.",
    outputs: [],
    suggestion: "Return to design; preserve changes",
  })
  return store.dispatch(saved.state.revision, {
    type: "prepare-summary",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
  })
}

/** Seed only execution-owned bookkeeping through the real store; every completed-state revisit uses terminal input. */
export async function completed(store: IterationStore, completion: "accepted" | "skipped") {
  const initial = await store.read()
  const spec = await store.saveArtifact(initial.revision, {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "An offline non-UI fixture",
    body: "S1: expose the local result.",
    decisionIds: [],
    items: [
      {
        id: "S1",
        description: "Local result",
        constraints: [],
        verification: ["Inspect the result"],
        acceptanceCriteria: ["Expected local result"],
        decisionIds: [],
        checkIds: [],
        ui: false,
      },
    ],
    checks: [],
  })
  const plan = await store.saveArtifact(spec.state.revision, {
    kind: "batch-plan",
    specHash: spec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: ["src/result.ts"] }],
  })
  const batchPlan = { artifactId: plan.artifact.id, hash: plan.artifact.hash }
  const context = {
    spec: { artifactId: spec.artifact.id, revision: 1, hash: spec.artifact.hash },
    batchPlan,
    batchId: "B1",
    mode: "single" as const,
    model: "mock/frontend",
    changes: ["diff:existing-offline"],
  }
  let state = plan.state
  const summarize = async (stage: "design" | "accept") => {
    const summary = await store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage,
      language: "en",
      summary: "Saved offline fixture evidence",
      outputs: [],
      suggestion: "Confirm the fixture bookkeeping",
    })
    state = await store.dispatch(summary.state.revision, {
      type: "prepare-summary",
      expectedRevision: summary.state.revision,
      artifact: summary.artifact,
    })
  }
  await summarize("design")
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "frontend-existing",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review existing offline changes",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "frontend-existing", "accept", context),
  })
  if (completion === "accepted") {
    const attemptId = "frontend-review-1"
    const codeHash = createHash("sha256").update("offline existing result fixture").digest("hex")
    state = await store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId,
      review: { attempt: 1, codeHash },
    })
    const verdict = await store.saveArtifact(state.revision, {
      kind: "acceptance",
      specHash: spec.artifact.hash,
      specRevision: 1,
      batchPlan,
      batchId: "B1",
      attemptId,
      attempt: 1,
      codeHash,
      reviewerModel: "mock/reviewer",
      implementerModels: ["mock/frontend"],
      sameModelFallback: false,
      outcome: "pass",
      checks: [],
      items: [
        {
          itemId: "S1",
          status: "pass",
          evidence: ["Observed expected result"],
          reason: "Expected result present",
        },
      ],
    })
    state = await store.dispatch(verdict.state.revision, {
      type: "finish-work",
      expectedRevision: verdict.state.revision,
      attemptId,
      changes: [],
      artifact: verdict.artifact,
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: verdict.artifact.id },
    })
  }
  await summarize("accept")
  const kind = completion === "accepted" ? "complete" : "skip"
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: `frontend-${completion}`,
      from: "accept",
      to: null,
      kind,
      summaryId: state.summaryId!,
      suggestion: completion === "accepted" ? "Record accepted evidence" : "Skip acceptance — not a pass",
      skippedStages: completion === "skipped" ? ["accept"] : [],
      ...(completion === "skipped" ? { skippedBatchIds: ["B1"] } : {}),
      context,
    },
  })
  return store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, `frontend-${completion}`, kind, context),
  })
}
