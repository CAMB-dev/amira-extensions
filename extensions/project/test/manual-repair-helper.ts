import type { IterationStore } from "../src/store.ts"

/** Publish execution-owned data only; terminal input must approve the proposal. */
export async function proposeUiReview(store: IterationStore) {
  const initial = await store.read()
  const spec = await store.saveArtifact(initial.revision, {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "Offline UI review",
    body: "S1: show a control.",
    decisionIds: [],
    checks: [],
    items: [
      {
        id: "S1",
        description: "Control",
        constraints: [],
        verification: ["Try the control"],
        acceptanceCriteria: ["Control responds"],
        decisionIds: [],
        checkIds: [],
        ui: true,
      },
    ],
  })
  const plan = await store.saveArtifact(spec.state.revision, {
    kind: "batch-plan",
    specHash: spec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: [] }],
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
    outputs: context.changes,
    summary: "Review the existing control",
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
      id: "frontend-manual-repair-review",
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
