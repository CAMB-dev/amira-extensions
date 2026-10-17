import { randomUUID } from "node:crypto"
import {
  type BatchPlanArtifact,
  type BatchResultArtifact,
  type CorrectionArtifact,
  type SpecArtifact,
  sameSpecItem,
} from "./artifacts.ts"
import { type AcceptedBatchRef, type ArtifactRef, type IterationState, normalizeIteration } from "./stage.ts"
import { DecisionStore, IterationStore, type Project } from "./store.ts"

const distinct = <T>(values: T[]) => [...new Set(values)]
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort())
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  return JSON.stringify(value)
}

export interface CorrectionInputs {
  revisitReceiptId: string
  /** Several unentered/execution-blocking revisits can share the same retained work. */
  revisitReceiptIds?: string[]
  previousSpec: SpecArtifact
  decisionLinks: { oldDecisionId: string; newDecisionId: string }[]
  affectedSpecItemIds: string[]
  changes: string[]
  worktree: { root: string; branch: string; cwd: string } | null
  implemented: { itemIds: string[]; changedFiles: string[]; pointer: string }[]
  accepted: { ref: AcceptedBatchRef; spec: SpecArtifact; itemIds: string[] }[]
}

/** Read exact recorded paths only. Legacy --stat output can abbreviate/quote paths;
 * those lines are not evidence of a filename and remain available as change pointers. */
function changedFiles(result: BatchResultArtifact): string[] {
  return result.changedFiles ?? []
}

/** Only authoritative records and immutable iteration artifacts enter model context. */
export async function correctionInputs(
  project: Project,
  state: IterationState,
): Promise<CorrectionInputs | null> {
  state = normalizeIteration(state)
  const store = new IterationStore(project)
  const outstanding: NonNullable<IterationState["correctionObligations"]> = []
  for (const obligation of state.correctionObligations ?? []) {
    if (
      !state.revisitHistory?.some((visit) => visit.receiptId === obligation.receiptId && visit.transitionId)
    )
      continue
    const mapping = state.corrections.find((entry) => entry.id === obligation.correctionId)
    if (mapping?.impact === "mapped") {
      const ref = state.artifacts.find((entry) => entry.id === mapping.artifactId)!
      const payload = await store.readArtifact(ref)
      // Mapping is bookkeeping, not approval. Cancel/retry must keep this
      // context until a human consumes that exact revision's authorization.
      if (
        payload.kind === "correction" &&
        state.transitions.some(
          (transition) =>
            (transition.to === "implement" || transition.to === "accept") &&
            transition.context?.spec?.hash === payload.specHash &&
            transition.context.spec.revision === payload.specRevision,
        )
      )
        continue
    }
    outstanding.push(obligation)
  }
  const pending = outstanding[0]
  // A confirmed revisit remains an execution obligation after either earlier
  // stage is skipped. The visible stage is not the owner of that obligation.
  const visit = pending
    ? state.revisitHistory?.find((entry) => entry.receiptId === pending.receiptId && entry.transitionId)
    : state.revisitHistory?.findLast((entry) => entry.transitionId && entry.target === state.stage)
  if (!visit) return null
  const obligation = state.correctionObligations?.find((entry) => entry.receiptId === visit.receiptId)
  const owner = state.attempts.find((entry) => entry.id === obligation?.attemptId)?.context?.spec
  const previousRef = owner
    ? state.artifacts.find((entry) => entry.id === owner.artifactId && entry.hash === owner.hash)
    : state.artifacts.findLast((entry) => entry.kind === "spec")
  if (!previousRef) return null
  const previous = await store.readArtifact(previousRef)
  if (previous.kind !== "spec") throw new Error("Correction requires its previous saved spec.")
  const decisions = await new DecisionStore(project).records()
  const ancestors = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    return distinct(
      (decisions.find((entry) => entry.id === id)?.supersedes ?? []).flatMap((old) => [
        old,
        ...ancestors(old, seen),
      ]),
    )
  }
  const decisionLinks = decisions
    .filter((entry) => !entry.supersededBy.length)
    .flatMap((entry) =>
      ancestors(entry.id)
        .filter((id) => previous.decisionIds.includes(id))
        .map((oldDecisionId) => ({ oldDecisionId, newDecisionId: entry.id })),
    )
  if (!decisionLinks.length)
    throw new Error(
      "Revisited work needs a verified new decision explicitly superseding a previous spec decision before generating a correction.",
    )
  const affectedSpecItemIds = previous.items
    .filter((item) => item.decisionIds.some((id) => decisionLinks.some((edge) => edge.oldDecisionId === id)))
    .map((item) => item.id)
  const implemented: CorrectionInputs["implemented"] = []
  const accepted: CorrectionInputs["accepted"] = []
  for (const ref of state.artifacts.filter((entry) => entry.kind === "batch-result")) {
    const result = await store.readArtifact(ref)
    if (result.kind !== "batch-result") continue
    const planRef = state.artifacts.find(
      (entry) =>
        entry.id === result.context.batchPlan?.artifactId && entry.hash === result.context.batchPlan.hash,
    )
    const specRef = state.artifacts.find(
      (entry) => entry.id === result.context.spec?.artifactId && entry.hash === result.context.spec.hash,
    )
    const plan = planRef && (await store.readArtifact(planRef))
    const spec = specRef && (await store.readArtifact(specRef))
    if (
      plan?.kind !== "batch-plan" ||
      spec?.kind !== "spec" ||
      plan.specHash !== specRef?.hash ||
      plan.specRevision !== spec.revision ||
      result.context.spec?.revision !== spec.revision
    )
      throw new Error("Correction result requires its exact saved spec and batch plan.")
    const batch = plan.batches.find((entry) => entry.id === result.context.batchId)
    if (!batch) throw new Error("Correction result requires its saved batch.")
    implemented.push({ itemIds: batch.itemIds, changedFiles: changedFiles(result), pointer: ref.path })
  }
  for (const resolution of state.batchResolutions ?? []) {
    const { context } = resolution
    if (resolution.status !== "accepted" || !resolution.attemptId || !context.spec || !context.batchPlan)
      continue
    const specRef = state.artifacts.find(
      (entry) => entry.id === context.spec!.artifactId && entry.hash === context.spec!.hash,
    )
    const planRef = state.artifacts.find(
      (entry) => entry.id === context.batchPlan!.artifactId && entry.hash === context.batchPlan!.hash,
    )
    const spec = specRef && (await store.readArtifact(specRef))
    const plan = planRef && (await store.readArtifact(planRef))
    const batch = plan?.kind === "batch-plan" && plan.batches.find((entry) => entry.id === resolution.batchId)
    if (spec?.kind !== "spec" || !batch)
      throw new Error("Correction requires the original qualified accepted spec and plan.")
    accepted.push({
      ref: {
        batchId: resolution.batchId,
        spec: context.spec,
        batchPlan: context.batchPlan,
        resolutionReceiptId: resolution.receiptId,
        attemptId: resolution.attemptId,
      },
      spec,
      itemIds: batch.itemIds,
    })
  }
  const worktreeRef = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  const worktree = worktreeRef && (await store.readArtifact(worktreeRef))
  return {
    revisitReceiptId: visit.receiptId,
    ...(outstanding.length > 1 ? { revisitReceiptIds: outstanding.map((entry) => entry.receiptId) } : {}),
    previousSpec: previous,
    decisionLinks,
    affectedSpecItemIds,
    changes: distinct([
      ...state.attempts.flatMap((entry) => entry.changes),
      ...implemented.map((entry) => entry.pointer),
    ]),
    worktree:
      worktree?.kind === "iteration-worktree" && worktree.status === "ready"
        ? { root: worktree.root, branch: worktree.branch, cwd: worktree.cwd }
        : null,
    implemented,
    accepted,
  }
}

/** Acceptance survives only identical item semantics AND identical exact check definitions.
 * Qualified references still need the store's confirmedAcceptedEvidence validation. */
export function preservedCorrectionEvidence(
  spec: SpecArtifact,
  context: CorrectionInputs,
): NonNullable<BatchPlanArtifact["preservedItems"]> {
  return spec.items.flatMap((item) => {
    if (context.affectedSpecItemIds.includes(item.id)) return []
    const accepted = context.accepted.find(
      (entry) => entry.itemIds.includes(item.id) && sameSpecItem(entry.spec, spec, item.id),
    )
    return accepted ? [{ itemId: item.id, acceptedBatch: accepted.ref }] : []
  })
}

export function preservedCorrectionItems(spec: SpecArtifact, context: CorrectionInputs): string[] {
  return preservedCorrectionEvidence(spec, context).map((entry) => entry.itemId)
}

/** Keep the complete spec, but schedule only changed or unresolved work, never replay
 * identical accepted items. The store must validate uncovered IDs against this evidence. */
export function correctionBatches(
  context: CorrectionInputs,
  spec: SpecArtifact,
  batches: BatchPlanArtifact["batches"],
): BatchPlanArtifact["batches"] {
  const preserved = preservedCorrectionItems(spec, context)
  const result = batches
    .flatMap((batch) => {
      const itemIds = batch.itemIds.filter((id) => !preserved.includes(id))
      return itemIds.length
        ? [
            {
              ...batch,
              itemIds,
              decisionIds: distinct(
                spec.items.filter((item) => itemIds.includes(item.id)).flatMap((item) => item.decisionIds),
              ),
            },
          ]
        : []
    })
    .map((batch, index) => ({ ...batch, id: `R${spec.revision}-B${index + 1}` }))
  const covered = result.flatMap((batch) => batch.itemIds)
  if (
    new Set(covered).size !== covered.length ||
    spec.items.some((item) => !preserved.includes(item.id) && !covered.includes(item.id))
  )
    throw new Error("Correction plan must cover every changed or unresolved spec item exactly once.")
  if (!result.length)
    throw new Error(
      "Correction has no actionable batch; record a superseding requirement before implementation.",
    )
  return result
}

export function correctionArtifact(
  context: CorrectionInputs,
  spec: SpecArtifact,
  ref: ArtifactRef,
  batchId: string,
): CorrectionArtifact {
  return {
    kind: "correction",
    specHash: ref.hash,
    specRevision: spec.revision,
    batchId,
    oldDecisionIds: distinct(context.decisionLinks.map((edge) => edge.oldDecisionId)),
    newDecisionIds: distinct(context.decisionLinks.map((edge) => edge.newDecisionId)),
    summary: spec.summary,
    mappings: context.decisionLinks.map((edge) => {
      const previousIds = context.previousSpec.items
        .filter((item) => item.decisionIds.includes(edge.oldDecisionId))
        .map((item) => item.id)
      const itemIds = spec.items
        .filter((item) => previousIds.includes(item.id) || item.decisionIds.includes(edge.newDecisionId))
        .map((item) => item.id)
      if (!itemIds.length)
        throw new Error(
          "A retired affected requirement needs an explicit correction item describing its removal.",
        )
      return {
        ...edge,
        itemIds,
        changedFiles: distinct(
          context.implemented
            .filter((entry) => entry.itemIds.some((id) => previousIds.includes(id)))
            .flatMap((entry) => entry.changedFiles),
        ),
        acceptedBatches: context.accepted
          .filter((entry) => entry.itemIds.some((id) => previousIds.includes(id)))
          .map((entry) => entry.ref),
      }
    }),
  }
}

export async function recordCorrection(
  store: IterationStore,
  state: IterationState,
  context: CorrectionInputs,
  spec: SpecArtifact,
  ref: ArtifactRef,
  batchId: string,
): Promise<{ state: IterationState; artifact: ArtifactRef }> {
  const payload = correctionArtifact(context, spec, ref, batchId)
  const saved = await store.saveArtifact(state.revision, payload)
  const uniqueAccepted = [
    ...new Map(
      payload.mappings.flatMap((entry) => entry.acceptedBatches).map((entry) => [canonical(entry), entry]),
    ).values(),
  ]
  state = saved.state
  let artifact = saved.artifact
  for (const [index, revisitReceiptId] of distinct([
    context.revisitReceiptId,
    ...(context.revisitReceiptIds ?? []),
  ]).entries()) {
    if (index > 0) {
      // Each receipt consumes its own immutable artifact. Reusing an already
      // consumed reference would temporarily orphan earlier correction evidence
      // in the store's register/consume reducer boundary.
      const next = await store.saveArtifact(state.revision, payload)
      state = next.state
      artifact = next.artifact
    }
    state = await store.dispatch(state.revision, {
      type: "record-correction",
      expectedRevision: state.revision,
      artifact,
      revisitReceiptId,
      correction: {
        id: randomUUID(),
        artifactId: artifact.id,
        decisionLinks: context.decisionLinks,
        affectedSpecItemIds: distinct(payload.mappings.flatMap((entry) => entry.itemIds)),
        affectedFiles: distinct(payload.mappings.flatMap((entry) => entry.changedFiles)),
        changePointers: context.changes,
        acceptedBatches: uniqueAccepted,
        impact: "mapped",
      },
    })
  }
  return { state, artifact: saved.artifact }
}
