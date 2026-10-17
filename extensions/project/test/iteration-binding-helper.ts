import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AcceptanceArtifact, BatchPlanArtifact, SpecArtifact } from "../src/artifacts.ts"
import type { ApprovalContext, HumanReceipt, IterationState } from "../src/stage.ts"
import { createProject, IterationStore } from "../src/store.ts"

export function human(state: IterationState, subjectId: string, choice: string): HumanReceipt {
  return {
    id: `human-${state.revision}`,
    provenance: "human",
    projectId: state.projectId,
    iteration: state.iteration,
    revision: state.revision,
    subjectId,
    choice,
    reason: "Explicit offline regression approval",
    ...((state.pending?.context ?? state.approvedContext)
      ? { context: state.pending?.context ?? state.approvedContext }
      : {}),
  }
}

export async function renewApproval(store: IterationStore, state: IterationState, context: ApprovalContext) {
  const saved = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: state.stage,
    language: "en",
    summary: "Review the pinned plan",
    outputs: [],
    suggestion: "Renew authorization",
  })
  state = await store.dispatch(saved.state.revision, {
    type: "prepare-summary",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: `renew-${state.revision}`,
      from: state.stage,
      to: state.stage,
      kind: "reapprove",
      summaryId: state.summaryId!,
      suggestion: "Review",
      skippedStages: [],
      context,
    },
  })
  return store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, state.pending!.id, state.stage),
  })
}

export async function bindingFixture(
  roots: string[],
  split = false,
  ui = false,
  mode: BatchPlanArtifact["mode"] = "single",
) {
  const root = await mkdtemp(path.join(tmpdir(), "project-binding-"))
  roots.push(root)
  const project = await createProject(root, "Binding")
  const store = new IterationStore(project)
  const spec: SpecArtifact = {
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
      ui,
    })),
  }
  const savedSpec = await store.saveArtifact(0, spec)
  const plan: BatchPlanArtifact = {
    kind: "batch-plan",
    specHash: savedSpec.artifact.hash,
    specRevision: 1,
    mode,
    batches: split
      ? ["S1", "S2"].map((id, index) => ({ id: `B${index + 1}`, itemIds: [id], decisionIds: [], files: [] }))
      : [{ id: "B1", itemIds: ["S1", "S2"], decisionIds: [], files: [] }],
  }
  const savedPlan = await store.saveArtifact(savedSpec.state.revision, plan)
  const context = {
    spec: { artifactId: savedSpec.artifact.id, revision: 1, hash: savedSpec.artifact.hash },
    batchPlan: { artifactId: savedPlan.artifact.id, hash: savedPlan.artifact.hash },
    batchId: "B1",
    mode,
    model: "offline/coder",
    changes: ["diff:existing"],
  }
  const summary = await store.saveArtifact(savedPlan.state.revision, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Ready for review",
    outputs: [],
    suggestion: "Review existing implementation",
  })
  let state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "accept-existing",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "accept-existing", "accept"),
  })
  const verdict: AcceptanceArtifact = {
    kind: "acceptance",
    specHash: savedSpec.artifact.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: context.batchPlan,
    attemptId: "A",
    attempt: 1,
    codeHash: "a".repeat(64),
    reviewerModel: "offline/reviewer",
    implementerModels: ["offline/coder"],
    sameModelFallback: false,
    outcome: "pass",
    checks: [],
    items: (split ? ["S1"] : ["S1", "S2"]).map((itemId) => ({
      itemId,
      status: "pass",
      evidence: ["Observed output"],
      reason: "Works",
    })),
  }
  return { project, store, state, plan, savedPlan, context, verdict }
}
