import path from "node:path"
import {
  type BatchPlanArtifact,
  type CorrectionArtifact,
  type IterationArtifact,
  type SpecArtifact,
  type SpecCheck,
  sameSpecItem,
} from "./artifacts.ts"
import { requiredChecks } from "./spec-integrity.ts"
import {
  type AcceptedBatchRef,
  type ApprovalContext,
  type ArtifactRef,
  type BatchResolution,
  batchProgress,
  type CorrectionRecord,
  type IterationState,
  initialIteration,
} from "./stage.ts"
import { IterationStore, type Project } from "./store.ts"

export interface ShipEvidence {
  status: "verified" | "stale" | "unavailable"
  reason?: string
  state: IterationState
  checks: SpecCheck[]
  skipped: string[]
  references: unknown
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  return JSON.stringify(value)
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const sameSet = (left: string[], right: string[]) =>
  left.length === right.length && new Set(left).size === left.length && left.every((id) => right.includes(id))
const cwdKey = (cwd: string) => {
  const resolved = path.resolve(cwd)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
class EvidenceError extends Error {
  constructor(
    readonly status: "stale" | "unavailable",
    message: string,
  ) {
    super(message)
  }
}
function prove(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EvidenceError("unavailable", message)
}

/** Resolve human consumption and immutable evidence, not content freshness. Ship must
 * separately run these full checks on the reviewed candidate and delivered tree.
 * Historical code hashes include HEAD and cannot survive a legitimate commit comparison. */
export async function resolveShipEvidence(project: Project): Promise<ShipEvidence> {
  const store = new IterationStore(project)
  let state = initialIteration(project.marker.id, project.marker.currentIteration)
  let checks: SpecCheck[] = []
  let skipped: string[] = []
  let references: unknown = null
  try {
    state = await store.read()
    if (
      state.pending ||
      state.revisit ||
      state.status === "working" ||
      state.attempts.some((attempt) => attempt.status === "working")
    )
      throw new EvidenceError(
        "stale",
        "Pending transitions, revisits or active writers must settle before ship.",
      )
    prove(
      state.phase === "complete" && !!state.completion,
      "No complete, human-consumed acceptance boundary is available for ship.",
    )
    prove(state.status === "idle", "Ship requires an idle completion boundary.")
    const progress = batchProgress(state)
    prove(
      progress.manifest && !progress.remaining.length,
      "Every pinned-plan batch needs a consumed accepted resolution or explicit human skip.",
    )

    // readArtifact checks committed membership, schema, hash and iteration identity.
    const artifacts = new Map<string, IterationArtifact>()
    const read = async (ref: ArtifactRef) => {
      let artifact = artifacts.get(ref.id)
      if (!artifact) {
        artifact = await store.readArtifact(ref)
        artifacts.set(ref.id, artifact)
      }
      return artifact
    }
    const saved = (id: string, hash?: string) => {
      const ref = state.artifacts.find((entry) => entry.id === id && (!hash || entry.hash === hash))
      prove(ref, `Missing exact committed evidence reference: ${id}`)
      return ref
    }
    const bound = async (context: ApprovalContext) => {
      prove(context.spec && context.batchPlan && context.mode, "Missing pinned spec, batch plan or mode.")
      const specRef = saved(context.spec.artifactId, context.spec.hash)
      const spec = await read(specRef)
      const planRef = saved(context.batchPlan.artifactId, context.batchPlan.hash)
      const plan = await read(planRef)
      prove(
        spec.kind === "spec" && spec.revision === context.spec.revision,
        "Pinned spec revision is unavailable.",
      )
      prove(
        plan.kind === "batch-plan" &&
          plan.specHash === specRef.hash &&
          plan.specRevision === spec.revision &&
          plan.mode === context.mode,
        "Pinned plan does not match its exact spec and mode.",
      )
      return { spec, specRef, plan, planRef }
    }
    const validated = new Map<string, { spec: SpecArtifact; itemIds: string[] }>()
    const validateResolution = async (resolution: BatchResolution) => {
      const identity = `${resolution.context.batchPlan?.artifactId}:${resolution.batchId}:${resolution.receiptId}`
      const prior = validated.get(identity)
      if (prior) return prior
      const { spec, plan } = await bound(resolution.context)
      const batch = plan.batches.find((entry) => entry.id === resolution.batchId)
      prove(batch, "Consumed resolution is not a member of its original pinned plan.")
      // Reducer/store load validates provenance, exact plan-qualified receipt,
      // transition, consumed attempt and manual trial ownership for all resolutions.
      if (resolution.status === "accepted") {
        const attempt = state.attempts.find((entry) => entry.id === resolution.attemptId)
        prove(attempt?.acceptance && attempt.review, "Consumed acceptance review is unavailable.")
        if (attempt.staleReason) throw new EvidenceError("stale", attempt.staleReason)
        const evidenceRef = saved(attempt.acceptance.artifactId)
        const evidence = await read(evidenceRef)
        prove(
          evidence.kind === "acceptance" &&
            evidence.outcome === "pass" &&
            evidence.attemptId === attempt.id &&
            evidence.attempt === attempt.review.attempt &&
            evidence.codeHash === attempt.review.codeHash &&
            evidence.batchId === resolution.batchId &&
            evidence.specHash === resolution.context.spec!.hash &&
            evidence.specRevision === resolution.context.spec!.revision &&
            equal(evidence.batchPlan, resolution.context.batchPlan),
          "Resolution must consume its exact passing acceptance artifact.",
        )
        prove(
          sameSet(
            batch.itemIds,
            evidence.items.map((entry) => entry.itemId),
          ),
          "Acceptance does not cover every original batch item.",
        )
        const worktreeRef = state.artifacts
          .slice(
            0,
            state.artifacts.findIndex((ref) => ref.id === evidenceRef.id),
          )
          .findLast((ref) => ref.kind === "iteration-worktree")
        const worktree = worktreeRef && (await read(worktreeRef))
        prove(
          !worktree || (worktree.kind === "iteration-worktree" && worktree.status === "ready"),
          "Acceptance checkout evidence is unavailable.",
        )
        const cwd = worktree?.kind === "iteration-worktree" ? worktree.cwd : project.root
        const agreed = requiredChecks(spec, batch.itemIds)
        prove(
          sameSet(
            agreed.map((entry) => entry.id),
            evidence.checks.map((entry) => entry.checkId),
          ) &&
            evidence.checks.every((check) => {
              const exact = agreed.find((entry) => entry.id === check.checkId)
              return (
                exact &&
                check.command === exact.command &&
                cwdKey(check.cwd) === cwdKey(path.resolve(cwd, exact.cwd ?? ".")) &&
                check.status === "passed" &&
                check.exitCode === 0
              )
            }),
          "Acceptance must retain every passing exact check command/cwd.",
        )
        const trialRequired = spec.items.some((item) => batch.itemIds.includes(item.id) && item.ui)
        prove(
          (attempt.acceptance.manualTrialRequired ?? false) === trialRequired,
          "Acceptance lost its original UI trial requirement.",
        )
        const trial = resolution.manualTrial ?? attempt.manualTrial
        prove(!trialRequired || trial, "Acceptance requires a resolved human UI trial.")
        if (trial) {
          const payload = await read(saved(trial.artifactId))
          prove(
            payload.kind === "manual-trial" &&
              payload.status === trial.status &&
              ["tried", "deferred"].includes(payload.status) &&
              payload.attemptId === evidence.attemptId &&
              payload.attempt === evidence.attempt &&
              payload.codeHash === evidence.codeHash &&
              payload.batchId === evidence.batchId &&
              equal(payload.batchPlan, evidence.batchPlan) &&
              payload.specHash === evidence.specHash &&
              payload.specRevision === evidence.specRevision,
            "Resolved manual trial does not match its original acceptance review.",
          )
        }
      }
      const result = { spec, itemIds: batch.itemIds }
      validated.set(identity, result)
      return result
    }
    const accepted = async (ref: AcceptedBatchRef) => {
      const resolution = state.batchResolutions?.find(
        (entry) =>
          entry.status === "accepted" &&
          entry.batchId === ref.batchId &&
          entry.receiptId === ref.resolutionReceiptId &&
          entry.attemptId === ref.attemptId &&
          equal(entry.context.spec, ref.spec) &&
          equal(entry.context.batchPlan, ref.batchPlan),
      )
      prove(resolution, "Missing qualified human-confirmed historical accepted resolution.")
      return validateResolution(resolution)
    }
    prove(state.approvedContext, "Missing completion approval context.")
    const current = await bound(state.approvedContext)
    if (
      state.artifacts.findLast((ref) => ref.kind === "spec")?.id !== current.specRef.id ||
      state.artifacts.findLast((ref) => ref.kind === "batch-plan")?.id !== current.planRef.id
    )
      throw new EvidenceError(
        "stale",
        "A newer spec or batch plan needs human approval and completion before ship.",
      )
    checks = requiredChecks(current.spec)
    try {
      await store.assertCurrentSpecDecisions(current.spec)
    } catch (error) {
      throw new EvidenceError("stale", error instanceof Error ? error.message : String(error))
    }
    const corrections: { record: CorrectionRecord; ref: ArtifactRef; payload: CorrectionArtifact }[] = []
    for (const record of state.corrections) {
      const ref = saved(record.artifactId)
      const payload = await read(ref)
      prove(payload.kind === "correction", "Recorded correction artifact is unavailable.")
      const owners = payload.mappings.flatMap((mapping) => mapping.acceptedBatches)
      prove(
        sameSet([...new Set(owners.map(canonical))], record.acceptedBatches.map(canonical)) &&
          sameSet(
            [...new Set(payload.mappings.flatMap((mapping) => mapping.itemIds))],
            record.affectedSpecItemIds,
          ) &&
          sameSet(
            [...new Set(payload.mappings.flatMap((mapping) => mapping.changedFiles))],
            record.affectedFiles,
          ) &&
          sameSet(
            [
              ...new Set(
                payload.mappings.map(({ oldDecisionId, newDecisionId }) =>
                  canonical({ oldDecisionId, newDecisionId }),
                ),
              ),
            ],
            record.decisionLinks.map(canonical),
          ),
        "Correction record does not match its immutable impact mapping.",
      )
      for (const owner of owners) await accepted(owner)
      corrections.push({ record, ref, payload })
    }
    for (const obligation of state.correctionObligations ?? []) {
      const correction = corrections.find((entry) => entry.record.id === obligation.correctionId)
      if (
        correction?.record.impact !== "mapped" ||
        !state.transitions.some(
          (transition) =>
            ["implement", "accept"].includes(transition.to ?? "") &&
            transition.context?.spec?.hash === correction.payload.specHash &&
            transition.context.spec.revision === correction.payload.specRevision &&
            state.receipts.some((receipt) => receipt.subjectId === transition.id),
        )
      )
        throw new EvidenceError("stale", "An unresolved correction obligation still blocks ship.")
    }
    const visiting = new Set<string>()
    const coverage = async (plan: BatchPlanArtifact, spec: SpecArtifact, planId: string): Promise<void> => {
      prove(!visiting.has(planId), "Cyclic historical plan evidence is unavailable.")
      visiting.add(planId)
      const covered = plan.batches.flatMap((batch) => batch.itemIds)
      for (const entry of plan.preservedItems ?? []) {
        const correction = corrections.filter(
          ({ payload }) => payload.specHash === plan.specHash && payload.specRevision === plan.specRevision,
        )
        prove(
          correction.length &&
            !correction.some(({ payload }) =>
              payload.mappings.some((mapping) => mapping.itemIds.includes(entry.itemId)),
            ),
          "Preserved items require an exact correction and cannot retain affected requirements.",
        )
        const original = await accepted(entry.acceptedBatch)
        prove(
          original.itemIds.includes(entry.itemId) && sameSpecItem(original.spec, spec, entry.itemId),
          "Preserved item changed its stable identity, semantics or exact checks.",
        )
        covered.push(entry.itemId)
      }
      if (plan.modeChange) {
        const sourceRef = saved(plan.modeChange.previousPlan.artifactId, plan.modeChange.previousPlan.hash)
        const source = await read(sourceRef)
        prove(
          source.kind === "batch-plan" &&
            source.specHash === plan.specHash &&
            source.specRevision === plan.specRevision &&
            source.mode !== plan.mode &&
            state.artifacts.findIndex((ref) => ref.id === sourceRef.id) <
              state.artifacts.findIndex((ref) => ref.id === planId),
          "Mode change lost its original pinned plan.",
        )
        await coverage(source, spec, sourceRef.id)
        const sourceProgress = batchProgress(state, {
          spec: { artifactId: current.specRef.id, hash: source.specHash, revision: source.specRevision },
          batchPlan: { artifactId: sourceRef.id, hash: sourceRef.hash },
          mode: source.mode,
        })
        // Only resolutions consumed before the replacement can have been carried.
        const carried = plan.modeChange.carriedResolutions
        for (const ref of carried) {
          const resolution = sourceProgress.resolutions.find(
            (entry) => entry.batchId === ref.batchId && entry.receiptId === ref.receiptId,
          )
          prove(resolution, "Mode change carried an unavailable historical resolution.")
          const original = await validateResolution(resolution)
          covered.push(...original.itemIds)
        }
        prove(
          equal(plan.preservedItems ?? [], source.preservedItems ?? []) &&
            equal(
              plan.batches,
              source.batches.filter((batch) => !carried.some((ref) => ref.batchId === batch.id)),
            ),
          "Mode change must retain unchanged unresolved batches and preserved items.",
        )
      }
      prove(
        sameSet(
          covered,
          spec.items.map((item) => item.id),
        ),
        "Pinned plan must cover all current items through scheduled, carried or preserved evidence.",
      )
      visiting.delete(planId)
    }
    await coverage(current.plan, current.spec, current.planRef.id)
    for (const resolution of progress.resolutions) await validateResolution(resolution)
    skipped = progress.resolutions.filter((entry) => entry.status === "skipped").map((entry) => entry.batchId)
    references = {
      spec: current.specRef,
      batchPlan: current.planRef,
      resolutions: progress.resolutions,
      preservedItems: current.plan.preservedItems ?? [],
      corrections: corrections.map(({ ref }) => ref),
    }
    const latest = await store.read()
    if (latest.revision !== state.revision)
      throw new EvidenceError("stale", "Iteration evidence changed while ship evidence was being resolved.")
    return { status: "verified", state, checks, skipped, references }
  } catch (error) {
    return {
      status: error instanceof EvidenceError ? error.status : "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      state,
      checks,
      skipped,
      references,
    }
  }
}
