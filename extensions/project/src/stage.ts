export type Stage = "design" | "prototype" | "implement" | "accept"
export type ArtifactKind =
  | "prototype-manifest"
  | "stage-summary"
  | "spec"
  | "batch-plan"
  | "acceptance"
  | "manual-trial"
  | "correction"
  | "iteration-worktree"
  | "batch-result"
export interface ArtifactRef {
  id: string
  kind: ArtifactKind
  path: string
  hash: string
}
export interface ApprovalContext {
  spec?: { artifactId: string; revision: number; hash: string }
  batchId?: string
  batchPlan?: { artifactId: string; hash: string }
  mode?: "single" | "workflow" | "swarm"
  model?: string
  /** Existing code/diff pointers, including acceptance-only paths. */
  changes?: string[]
}
export interface HumanReceipt {
  id: string
  provenance: "human"
  projectId: string
  iteration: number
  /** The revision displayed to the human, before recording their answer. */
  revision: number
  subjectId: string
  choice: string
  reason: string
  context?: ApprovalContext
}
/** Membership copied by the store from an immutable, hash-checked plan. */
export interface BatchManifest {
  batchPlan: NonNullable<ApprovalContext["batchPlan"]>
  spec: NonNullable<ApprovalContext["spec"]>
  mode: NonNullable<ApprovalContext["mode"]>
  batchIds: string[]
}
export interface BatchResolution {
  context: ApprovalContext
  batchId: string
  status: "accepted" | "skipped"
  receiptId: string
  attemptId?: string
  manualTrial?: IterationState["manualTrial"]
}
export interface StageAttempt {
  id: string
  stage: Stage
  status: "working" | "finished" | "interrupted"
  changes: string[]
  context?: ApprovalContext
  manualTrial?: IterationState["manualTrial"]
  review?: { attempt: number; codeHash: string }
  /** Why the immutable verdict can no longer authorize acceptance. */
  staleReason?: string
  acceptance?: {
    verdict: "pass" | "fail" | "blocked"
    failingItemIds: string[]
    artifactId: string
    manualTrialRequired?: boolean
  }
}
export interface TransitionProposal {
  id: string
  from: Stage
  /** Null ends stage bookkeeping, not the iteration: no ship or execution. */
  to: Stage | null
  kind: "advance" | "skip" | "repair" | "revisit" | "complete" | "reapprove" | "next-batch" | "skip-batch"
  summaryId: string
  suggestion: string
  skippedBatchIds?: string[]
  skippedStages: Stage[]
  /** Enter implementation planning only; never authorizes start-work without spec/plan approval. */
  preparationOnly?: true
  context?: ApprovalContext
}
/** Immutable owner identity of a confirmed, consumed passing batch; never a display label. */
export interface AcceptedBatchRef {
  batchId: string
  spec: { artifactId: string; revision: number; hash: string }
  batchPlan: { artifactId: string; hash: string }
  resolutionReceiptId: string
  attemptId: string
}
export interface CorrectionRecord {
  id: string
  artifactId: string
  decisionLinks: { oldDecisionId: string; newDecisionId: string }[]
  affectedSpecItemIds: string[]
  affectedFiles: string[]
  changePointers: string[]
  acceptedBatches: AcceptedBatchRef[]
  impact: "mapped" | "needs-review"
}
export interface RevisitRequest {
  target: "design" | "prototype"
  policy: "interrupt" | "boundary"
  attemptId?: string
  receiptId: string
  correctionId?: string
}
export interface RevisitHistory extends RevisitRequest {
  transitionId?: string
  cancelReceiptId?: string
}
export interface CorrectionObligation {
  receiptId: string
  target: "design" | "prototype"
  attemptId: string
  correctionId?: string
}
export interface IterationState {
  schemaVersion: 1
  revision: number
  projectId: string
  iteration: number
  stage: Stage
  status: "idle" | "working" | "awaiting-confirmation" | "interrupted" | "blocked"
  phase: "ready" | "running" | "finished" | "summarized" | "proposed" | "confirmed" | "complete"
  artifacts: ArtifactRef[]
  attempts: StageAttempt[]
  receipts: HumanReceipt[]
  transitions: TransitionProposal[]
  skips: { stage: Stage; receiptId: string }[]
  corrections: CorrectionRecord[]
  activeAttemptId?: string
  summaryId?: string
  pending?: TransitionProposal
  approvedContext?: ApprovalContext
  /** Unresolved request only; returned and cancelled visits live in history. */
  revisit?: RevisitRequest
  revisitHistory?: RevisitHistory[]
  correctionObligations?: CorrectionObligation[]
  prototypeChoice?: { variantId: string | null; decisionId: string; receiptId: string }
  /** A UI acceptance result requires a resolved human trial, even if no prompt was recorded. */
  manualTrialRequired?: boolean
  manualTrial?: {
    status: "pending" | "tried" | "problem" | "deferred"
    artifactId: string
    receiptId?: string
  }
  batchManifests?: BatchManifest[]
  batchResolutions?: BatchResolution[]
  completion?: "accepted" | "skipped"
}

type AtRevision = { expectedRevision: number }
export type StageEvent = AtRevision &
  (
    | { type: "start-work"; attemptId: string; review?: StageAttempt["review"] }
    | {
        type: "finish-work"
        attemptId: string
        changes: string[]
        acceptance?: StageAttempt["acceptance"]
        artifact?: ArtifactRef
      }
    | { type: "prepare-summary"; artifact: ArtifactRef }
    | { type: "propose-transition"; proposal: TransitionProposal }
    | { type: "confirm-transition"; receipt: HumanReceipt }
    | { type: "cancel-transition" }
    | { type: "reopen-design" }
    /** Abandon only the identified pending prototype skip, never reset running work. */
    | { type: "reopen-prototype"; proposalId: string }
    | { type: "record-artifact"; artifact: ArtifactRef; manifest?: BatchManifest }
    | { type: "select-prototype"; variantId: string | null; decisionId: string; receipt: HumanReceipt }
    | {
        type: "request-revisit"
        target: "design" | "prototype"
        policy: "interrupt" | "boundary"
        attemptId?: string
        changes: string[]
        receipt: HumanReceipt
      }
    | { type: "cancel-revisit"; receipt: HumanReceipt }
    | {
        type: "record-correction"
        correction: CorrectionRecord
        artifact: ArtifactRef
        revisitReceiptId?: string
      }
    | {
        type: "record-manual-trial"
        status: "pending" | "tried" | "problem" | "deferred"
        artifact: ArtifactRef
        receipt?: HumanReceipt
      }
    | { type: "invalidate-review"; attemptId: string; reason: string }
    | { type: "interrupt-work"; attemptId: string; changes: string[] }
    /** Cancellation of an implementation lifecycle, including unapproved finalization. */
    | { type: "interrupt-batch"; attemptId: string; changes: string[] }
    | { type: "confirm-continuation"; receipt: HumanReceipt }
  )

const stages: Stage[] = ["design", "prototype", "implement", "accept"]
const kinds: ArtifactKind[] = [
  "prototype-manifest",
  "stage-summary",
  "spec",
  "batch-plan",
  "acceptance",
  "manual-trial",
  "correction",
  "iteration-worktree",
  "batch-result",
]
const fail = (message: string): never => {
  throw new Error(`Invalid iteration transition: ${message}`)
}
const require = (condition: unknown, message: string): void => {
  if (!condition) fail(message)
}
type Check = (value: unknown) => boolean
const text: Check = (v) => typeof v === "string" && v.trim().length > 0
const integer: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const positive: Check = (v) => integer(v) && (v as number) > 0
const oneOf =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v)
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v)
const list =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check)
const object =
  (shape: Record<string, Check>): Check =>
  (v) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).every((key) => Object.hasOwn(shape, key)) &&
    Object.entries(shape).every(([key, check]) => check((v as Record<string, unknown>)[key]))
const artifactCheck = object({ id: text, kind: oneOf(...kinds), path: text, hash: text })
const contextCheck = object({
  spec: optional(object({ artifactId: text, revision: positive, hash: text })),
  batchId: optional(text),
  batchPlan: optional(object({ artifactId: text, hash: text })),
  mode: optional(oneOf("single", "workflow", "swarm")),
  model: optional(text),
  changes: optional(list(text)),
})
const receiptCheck = object({
  id: text,
  provenance: oneOf("human"),
  projectId: text,
  iteration: positive,
  revision: integer,
  subjectId: text,
  choice: text,
  reason: text,
  context: optional(contextCheck),
})
const acceptanceCheck = object({
  verdict: oneOf("pass", "fail", "blocked"),
  failingItemIds: list(text),
  artifactId: text,
  manualTrialRequired: optional((v) => typeof v === "boolean"),
})
const reviewCheck = object({
  attempt: positive,
  codeHash: (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
})
const manifestCheck = object({
  batchPlan: object({ artifactId: text, hash: text }),
  spec: object({ artifactId: text, revision: positive, hash: text }),
  mode: oneOf("single", "workflow", "swarm"),
  batchIds: list(text),
})
const trialCheck = object({
  status: oneOf("pending", "tried", "problem", "deferred"),
  artifactId: text,
  receiptId: optional(text),
})
const proposalCheck = object({
  id: text,
  from: oneOf(...stages),
  to: oneOf(...stages, null),
  kind: oneOf("advance", "skip", "repair", "revisit", "complete", "reapprove", "next-batch", "skip-batch"),
  summaryId: text,
  suggestion: text,
  skippedBatchIds: optional(list(text)),
  skippedStages: list(oneOf(...stages)),
  preparationOnly: optional(oneOf(true)),
  context: optional(contextCheck),
})
const acceptedBatchHashCheck: Check = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
const acceptedBatchCheck = object({
  batchId: text,
  spec: object({ artifactId: text, revision: positive, hash: acceptedBatchHashCheck }),
  batchPlan: object({ artifactId: text, hash: acceptedBatchHashCheck }),
  resolutionReceiptId: text,
  attemptId: text,
})
const correctionCheck = object({
  id: text,
  artifactId: text,
  decisionLinks: list(object({ oldDecisionId: text, newDecisionId: text })),
  affectedSpecItemIds: list(text),
  affectedFiles: list(text),
  changePointers: list(text),
  acceptedBatches: list(acceptedBatchCheck),
  impact: oneOf("mapped", "needs-review"),
})
const revisitShape = {
  target: oneOf("design", "prototype"),
  policy: oneOf("interrupt", "boundary"),
  attemptId: optional(text),
  receiptId: text,
  correctionId: optional(text),
}
const stateCheck = object({
  schemaVersion: oneOf(1),
  revision: integer,
  projectId: text,
  iteration: positive,
  stage: oneOf(...stages),
  status: oneOf("idle", "working", "awaiting-confirmation", "interrupted", "blocked"),
  phase: oneOf("ready", "running", "finished", "summarized", "proposed", "confirmed", "complete"),
  artifacts: list(artifactCheck),
  attempts: list(
    object({
      id: text,
      stage: oneOf(...stages),
      status: oneOf("working", "finished", "interrupted"),
      changes: list(text),
      context: optional(contextCheck),
      acceptance: optional(acceptanceCheck),
      review: optional(reviewCheck),
      staleReason: optional(text),
      manualTrial: optional(trialCheck),
    }),
  ),
  receipts: list(receiptCheck),
  transitions: list(proposalCheck),
  skips: list(object({ stage: oneOf(...stages), receiptId: text })),
  corrections: list(correctionCheck),
  activeAttemptId: optional(text),
  summaryId: optional(text),
  pending: optional(proposalCheck),
  approvedContext: optional(contextCheck),
  revisit: optional(object(revisitShape)),
  revisitHistory: optional(
    list(
      object({
        ...revisitShape,
        transitionId: optional(text),
        cancelReceiptId: optional(text),
      }),
    ),
  ),
  correctionObligations: optional(
    list(
      object({
        receiptId: text,
        target: oneOf("design", "prototype"),
        attemptId: text,
        correctionId: optional(text),
      }),
    ),
  ),
  prototypeChoice: optional(
    object({ variantId: (v) => v === null || text(v), decisionId: text, receiptId: text }),
  ),
  manualTrialRequired: optional((v) => typeof v === "boolean"),
  manualTrial: optional(
    object({
      status: oneOf("pending", "tried", "problem", "deferred"),
      artifactId: text,
      receiptId: optional(text),
    }),
  ),
  batchManifests: optional(list(manifestCheck)),
  batchResolutions: optional(
    list(
      object({
        context: contextCheck,
        batchId: text,
        status: oneOf("accepted", "skipped"),
        receiptId: text,
        attemptId: optional(text),
        manualTrial: optional(trialCheck),
      }),
    ),
  ),
  completion: optional(oneOf("accepted", "skipped")),
})
const eventChecks: Record<StageEvent["type"], Record<string, Check>> = {
  "start-work": { attemptId: text, review: optional(reviewCheck) },
  "finish-work": {
    attemptId: text,
    changes: list(text),
    acceptance: optional(acceptanceCheck),
    artifact: optional(artifactCheck),
  },
  "prepare-summary": { artifact: artifactCheck },
  "propose-transition": { proposal: proposalCheck },
  "confirm-transition": { receipt: receiptCheck },
  "cancel-transition": {},
  "reopen-design": {},
  "reopen-prototype": { proposalId: text },
  "record-artifact": { artifact: artifactCheck, manifest: optional(manifestCheck) },
  "select-prototype": { variantId: (v) => v === null || text(v), decisionId: text, receipt: receiptCheck },
  "request-revisit": {
    target: oneOf("design", "prototype"),
    policy: oneOf("interrupt", "boundary"),
    attemptId: optional(text),
    changes: list(text),
    receipt: receiptCheck,
  },
  "cancel-revisit": { receipt: receiptCheck },
  "record-correction": {
    correction: correctionCheck,
    artifact: artifactCheck,
    revisitReceiptId: optional(text),
  },
  "record-manual-trial": {
    status: oneOf("pending", "tried", "problem", "deferred"),
    artifact: artifactCheck,
    receipt: optional(receiptCheck),
  },
  "interrupt-work": { attemptId: text, changes: list(text) },
  "interrupt-batch": { attemptId: text, changes: list(text) },
  "confirm-continuation": { receipt: receiptCheck },
  "invalidate-review": { attemptId: text, reason: text },
}

// Object property order is not part of an exact approval context; array order is.
const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )

function unique(values: string[], name: string): void {
  require(new Set(values).size === values.length, `duplicate ${name}`)
}
function artifact(state: IterationState, id: string, kind: ArtifactKind): void {
  require(state.artifacts.some((entry) => entry.id === id && entry.kind === kind), `missing ${kind} artifact`)
}
function checkContext(state: IterationState, context?: ApprovalContext): void {
  checkPlan(state, context)
  if (context?.spec) {
    artifact(state, context.spec.artifactId, "spec")
    require(state.artifacts.find((a) => a.id === context.spec?.artifactId)?.hash ===
      context.spec.hash, "spec hash")
  }
}
function checkPlan(state: IterationState, context?: ApprovalContext): void {
  if (!context?.batchPlan) return
  artifact(state, context.batchPlan.artifactId, "batch-plan")
  require(state.artifacts.find((a) => a.id === context.batchPlan?.artifactId)?.hash ===
    context.batchPlan.hash, "batch plan hash")
}
function checkAcceptance(state: IterationState, attempt: StageAttempt): void {
  if (!attempt.acceptance) return
  require(attempt.stage === "accept" &&
    (attempt.status === "finished" ||
      (attempt.status === "interrupted" && !!attempt.staleReason)), "acceptance attempt")
  artifact(state, attempt.acceptance.artifactId, "acceptance")
  unique(attempt.acceptance.failingItemIds, "failing spec items")
  require(attempt.acceptance.verdict === "fail"
    ? attempt.acceptance.failingItemIds.length > 0
    : attempt.acceptance.failingItemIds.length === 0, "failing spec item IDs do not match verdict")
}
/** Structural/reference validation only; the store owns paths, hashes and durable human evidence. */
export function validateIteration(value: unknown): asserts value is IterationState {
  require(stateCheck(value), "invalid state schema")
  const state = value as IterationState
  unique(
    state.artifacts.map((a) => a.id),
    "artifacts",
  )
  unique(
    state.attempts.map((a) => a.id),
    "attempts",
  )
  unique(
    state.receipts.map((r) => r.id),
    "receipts",
  )
  unique(
    state.transitions.map((p) => p.id),
    "transitions",
  )
  unique(
    state.corrections.map((c) => c.id),
    "corrections",
  )
  for (const receipt of state.receipts) {
    require(receipt.projectId === state.projectId &&
      receipt.iteration === state.iteration, "receipt identity")
    require(receipt.revision < state.revision, "receipt revision")
    checkContext(state, receipt.context)
  }
  let reviewOrdinal = 0
  for (const attempt of state.attempts) {
    if (attempt.stage === "accept") {
      reviewOrdinal += 1
      require(attempt.review?.attempt === reviewOrdinal, "acceptance review ordinal")
    } else require(!attempt.review, "review only for acceptance")
    checkContext(state, attempt.context)
    checkAcceptance(state, attempt)
    if (attempt.manualTrial) {
      require(attempt.stage === "accept", "manual trial only for acceptance")
      artifact(state, attempt.manualTrial.artifactId, "manual-trial")
      require(attempt.manualTrial.status === "pending" ||
        state.receipts.some(
          (receipt) =>
            receipt.id === attempt.manualTrial?.receiptId &&
            receipt.subjectId === attempt.manualTrial.artifactId &&
            receipt.choice === attempt.manualTrial.status,
        ), "attempt manual trial receipt")
    }
    require(attempt.status !== "working" || attempt.id === state.activeAttemptId, "orphan working attempt")
  }
  const active = state.attempts.find((a) => a.id === state.activeAttemptId)
  require(!active?.manualTrial ||
    !state.manualTrial ||
    canonical(active.manualTrial) === canonical(state.manualTrial), "active manual trial mismatch")
  require(!state.activeAttemptId || (active && active.stage === state.stage), "active attempt reference")
  require(state.status !== "working" ||
    (state.phase === "running" && active?.status === "working"), "working phase")
  require(state.phase !== "running" || state.status === "working", "running status")
  require(active?.status !== "working" || state.phase === "running", "active work phase")
  require(!active?.acceptance?.manualTrialRequired ||
    state.manualTrialRequired, "missing manual trial requirement")
  require(!["ready", "confirmed", "complete"].includes(state.phase) ||
    state.status === "idle", "idle phase status")
  require(state.phase !== "finished" || (active && active.status !== "working"), "finished attempt")
  require(state.status !== "interrupted" || active?.status === "interrupted", "interrupted attempt")
  require(state.status !== "blocked" || active?.acceptance?.verdict === "blocked", "blocked acceptance")
  require((state.phase === "proposed") === !!state.pending, "pending phase")
  require((state.status === "awaiting-confirmation") === !!state.pending, "pending status")
  if (state.summaryId) artifact(state, state.summaryId, "stage-summary")
  require(state.phase !== "summarized" || !!state.summaryId, "missing summary")
  if (state.pending) {
    require(state.pending.from === state.stage, "proposal stage")
    artifact(state, state.pending.summaryId, "stage-summary")
    checkContext(state, state.pending.context)
  }
  checkContext(state, state.approvedContext)
  for (const transition of state.transitions) {
    artifact(state, transition.summaryId, "stage-summary")
    checkContext(state, transition.context)
    const approval = state.receipts.find((r) => r.subjectId === transition.id)
    require(approval &&
      approval.choice === (transition.to ?? transition.kind) &&
      canonical(approval.context) === canonical(transition.context), "transition human approval")
  }
  const receiptExists = (id: string) => state.receipts.some((r) => r.id === id)
  for (const skip of state.skips) require(receiptExists(skip.receiptId), "skip receipt")
  if (state.prototypeChoice) require(receiptExists(state.prototypeChoice.receiptId), "prototype receipt")
  if (state.manualTrial) {
    artifact(state, state.manualTrial.artifactId, "manual-trial")
    require(state.manualTrial.status === "pending" ||
      (!!state.manualTrial.receiptId && receiptExists(state.manualTrial.receiptId)), "manual trial receipt")
  }
  for (const correction of state.corrections) {
    artifact(state, correction.artifactId, "correction")
    require(correction.decisionLinks.length > 0, "missing decision traceability")
    require(correction.decisionLinks.every(
      (link) => link.oldDecisionId !== link.newDecisionId,
    ), "self-superseding decision")
  }
  for (const visit of [state.revisit, ...(state.revisitHistory ?? [])].filter(
    (v): v is RevisitRequest => !!v,
  )) {
    if (visit.attemptId) {
      require(state.attempts.some(
        (a) => a.id === visit.attemptId && stages.indexOf(visit.target) < stages.indexOf(a.stage),
      ), "revisit attempt")
    }
    const request = state.receipts.find((r) => r.id === visit.receiptId)
    require(request &&
      request.choice === visit.target &&
      (visit.attemptId
        ? request.subjectId === visit.attemptId
        : stages.some(
            (stage) =>
              request.subjectId === `revisit:${stage}` &&
              stages.indexOf(visit.target) < stages.indexOf(stage),
          )), "revisit provenance")
    require(receiptExists(visit.receiptId), "revisit receipt")
    require(!visit.correctionId ||
      state.corrections.some((c) => c.id === visit.correctionId), "revisit correction")
  }
  unique(
    (state.revisitHistory ?? []).map((visit) => visit.receiptId),
    "revisit history",
  )
  for (const visit of state.revisitHistory ?? []) {
    require(!!visit.transitionId !== !!visit.cancelReceiptId, "revisit history resolution")
    if (visit.transitionId)
      require(state.transitions.some(
        (transition) =>
          transition.id === visit.transitionId &&
          transition.kind === "revisit" &&
          transition.to === visit.target,
      ), "revisit history transition")
    if (visit.cancelReceiptId)
      require(state.receipts.some(
        (receipt) =>
          receipt.id === visit.cancelReceiptId &&
          receipt.subjectId === visit.receiptId &&
          receipt.choice === "cancel-revisit",
      ), "revisit cancellation receipt")
  }
  unique(
    (state.correctionObligations ?? []).map((obligation) => obligation.receiptId),
    "correction obligations",
  )
  for (const obligation of state.correctionObligations ?? []) {
    require([state.revisit, ...(state.revisitHistory ?? [])].some(
      (visit) => visit?.receiptId === obligation.receiptId && visit.target === obligation.target,
    ), "correction obligation revisit")
    require(state.attempts.some(
      (attempt) =>
        attempt.id === obligation.attemptId && (attempt.stage === "implement" || attempt.stage === "accept"),
    ), "correction obligation attempt")
    require(!obligation.correctionId ||
      state.corrections.some(
        (correction) => correction.id === obligation.correctionId,
      ), "correction obligation record")
  }
  require(!state.completion
    ? state.phase !== "complete"
    : ["complete", "summarized", "proposed"].includes(state.phase), "completion phase")
  require(!state.completion ||
    (state.stage === "accept" &&
      (state.status === "idle" ||
        (state.pending?.kind === "revisit" && state.status === "awaiting-confirmation"))), "completion stage")
  for (const manifest of state.batchManifests ?? []) {
    checkContext(state, manifest)
    require(manifest.batchIds.length > 0, "empty batch manifest")
    unique(manifest.batchIds, "manifest batches")
  }
  unique(
    (state.batchManifests ?? []).map((entry) => entry.batchPlan.artifactId),
    "batch manifests",
  )
  unique(
    (state.batchResolutions ?? []).map((entry) => `${entry.context.batchPlan?.artifactId}:${entry.batchId}`),
    "batch resolutions",
  )
  for (const resolution of state.batchResolutions ?? []) {
    const progress = batchProgress(state, resolution.context)
    require(progress.manifest?.batchIds.includes(resolution.batchId) &&
      resolution.context.batchId === resolution.batchId, "resolution batch membership")
    const approval = state.receipts.find((r) => r.id === resolution.receiptId)
    const transition = state.transitions.find((p) => p.id === approval?.subjectId)
    require(approval &&
      (transition?.from === "accept" ||
        (transition?.from === "implement" && transition.kind === "skip-batch")) &&
      samePlan(approval.context, resolution.context), "batch resolution human approval")
    if (resolution.status === "accepted") {
      const attempt = state.attempts.find((a) => a.id === resolution.attemptId)
      require(attempt?.stage === "accept" &&
        attempt.status === "finished" &&
        attempt.acceptance?.verdict === "pass" &&
        canonical(attempt.context) === canonical(resolution.context), "batch resolution consumed pass")
      require(transition!.from === "accept" &&
        ["complete", "next-batch"].includes(transition!.kind), "accepted batch transition")
      const trial = resolution.manualTrial ?? attempt?.manualTrial
      require(!attempt?.acceptance?.manualTrialRequired || !!trial, "batch resolution manual trial required")
      if (trial) {
        artifact(state, trial.artifactId, "manual-trial")
        require(["tried", "deferred"].includes(trial.status) &&
          state.receipts.some(
            (r) => r.id === trial.receiptId && r.subjectId === trial.artifactId && r.choice === trial.status,
          ), "batch resolution manual trial unresolved")
      }
    } else
      require(["skip", "skip-batch"].includes(transition!.kind) &&
        transition!.skippedBatchIds?.includes(resolution.batchId), "skipped batch receipt")
  }
  if (state.completion) {
    const transition = state.transitions.at(-1)
    require(transition?.to === null, "completion transition")
    // Old journal snapshots remain readable. New transitions always require a manifest;
    // the store reconstructs only validated consumed legacy evidence before use.
    if (state.batchManifests !== undefined) {
      const progress = batchProgress(state)
      require(progress.manifest &&
        progress.remaining.length === 0, "completion needs every pinned-plan batch resolved")
      const skipped = progress.resolutions.some((entry) => entry.status === "skipped")
      require(state.completion ===
        (skipped ? "skipped" : "accepted"), "completion must not present skipped batches as pass")
      if (!skipped) require(manualTrialResolved(state), "completion manual trial")
      require(["complete", "skip", "skip-batch"].includes(transition!.kind), "completion kind")
    } else if (state.completion === "accepted") {
      require(transition?.kind === "complete" &&
        state.attempts.findLast((a) => a.stage === "accept")?.acceptance?.verdict ===
          "pass", "legacy completion verdict")
    } else require(transition?.kind === "skip", "legacy skipped completion kind")
  }
}

export function initialIteration(projectId: string, iteration: number): IterationState {
  const state: IterationState = {
    schemaVersion: 1,
    revision: 0,
    projectId,
    iteration,
    stage: "design",
    status: "idle",
    phase: "ready",
    artifacts: [],
    attempts: [],
    receipts: [],
    transitions: [],
    skips: [],
    corrections: [],
    revisitHistory: [],
    correctionObligations: [],
    batchManifests: [],
    batchResolutions: [],
  }
  validateIteration(state)
  return state
}

function addArtifact(
  state: IterationState,
  ref: ArtifactRef,
  kind?: ArtifactKind,
  consumePublished = false,
): void {
  require(!kind || ref.kind === kind, `expected ${kind} artifact`)
  const existing = state.artifacts.find((a) => a.id === ref.id || a.path === ref.path)
  if (existing) {
    require(consumePublished &&
      canonical(existing) === canonical(ref), "artifact already recorded or mismatched")
    return
  }
  state.artifacts.push(ref)
}
function addReceipt(
  state: IterationState,
  receipt: HumanReceipt,
  subject: string,
  choice: string,
  context?: ApprovalContext,
): void {
  require(receipt.projectId === state.projectId &&
    receipt.iteration === state.iteration, "human receipt identity")
  require(receipt.revision === state.revision, "stale human approval revision")
  require(receipt.subjectId === subject && receipt.choice === choice, "human receipt choice")
  require(canonical(receipt.context) === canonical(context), "human approval context mismatch")
  require(!state.receipts.some((r) => r.id === receipt.id), "duplicate human receipt")
  state.receipts.push(receipt)
}
function running(state: IterationState, id: string): StageAttempt {
  require(state.phase === "running" &&
    state.status === "working" &&
    state.activeAttemptId === id, "not active work")
  return state.attempts.find((a) => a.id === id)!
}
function interrupt(state: IterationState, id: string, changes: string[]): void {
  const attempt = running(state, id)
  attempt.changes = [...new Set([...attempt.changes, ...changes])]
  attempt.status = "interrupted"
  // Trial artifacts retain their own attempt/snapshot bindings as immutable history.
  // An interrupted review must never keep a live trial pointer that can block a revisit.
  if (attempt.stage === "accept") {
    delete state.manualTrial
    delete state.manualTrialRequired
  }
  state.status = "interrupted"
  state.phase = "finished"
}
/** Metadata proof only; the store also verifies the immutable trial payload before repair. */
export function hasManualProblem(state: IterationState): boolean {
  const active = state.attempts.find((a) => a.id === state.activeAttemptId)
  const trial = active?.manualTrial
  return !!(
    state.stage === "accept" &&
    active?.stage === "accept" &&
    ["working", "finished"].includes(active.status) &&
    active.review &&
    samePlan(active.context, state.approvedContext) &&
    active.context?.batchId === state.approvedContext?.batchId &&
    trial?.status === "problem" &&
    canonical(trial) === canonical(state.manualTrial) &&
    state.artifacts.some((a) => a.id === trial.artifactId && a.kind === "manual-trial") &&
    state.receipts.some(
      (r) =>
        r.id === trial.receiptId &&
        r.provenance === "human" &&
        r.projectId === state.projectId &&
        r.iteration === state.iteration &&
        r.revision >= 0 &&
        r.revision < state.revision &&
        r.subjectId === trial.artifactId &&
        r.choice === "problem" &&
        !r.context,
    )
  )
}
function checkRepair(state: IterationState, proposal: TransitionProposal): void {
  const active = state.attempts.find((a) => a.id === state.activeAttemptId)
  require(state.stage === "accept" &&
    proposal.to === "implement" &&
    !state.revisit &&
    active?.status === "finished", "invalid repair route or unsafe work boundary")
  require(active?.acceptance?.verdict === "fail" ||
    hasManualProblem(state), "repair needs failing acceptance or a bound human manual problem")
  require(samePlan(active?.context, proposal.context) &&
    active?.context?.batchId ===
      proposal.context?.batchId, "repair must keep the failing batch and pinned plan")
  require(proposal.skippedStages.length === 0, "repair cannot skip")
}
function manualTrialResolved(state: IterationState): boolean {
  const active = state.attempts.find((a) => a.id === state.activeAttemptId)
  const trial = active ? active.manualTrial : state.manualTrial
  const required = state.manualTrialRequired || active?.acceptance?.manualTrialRequired
  return trial ? ["tried", "deferred"].includes(trial.status) : !required
}
function samePlan(left?: ApprovalContext, right?: ApprovalContext): boolean {
  return (
    !!left?.spec &&
    !!left.batchPlan &&
    canonical(left.spec) === canonical(right?.spec) &&
    canonical(left.batchPlan) === canonical(right?.batchPlan) &&
    left.mode === right?.mode
  )
}
export function batchProgress(state: IterationState, context = state.approvedContext) {
  const manifest = state.batchManifests?.find((entry) => samePlan(entry, context))
  const resolutions = (state.batchResolutions ?? []).filter((entry) => samePlan(entry.context, context))
  const remaining =
    manifest?.batchIds.filter((id) => !resolutions.some((entry) => entry.batchId === id)) ?? []
  return { manifest, resolutions, remaining }
}
function currentPass(state: IterationState): StageAttempt {
  const active = state.attempts.find((a) => a.id === state.activeAttemptId)
  require(active?.stage === "accept" &&
    active.status === "finished" &&
    active.acceptance?.verdict === "pass" &&
    samePlan(active.context, state.approvedContext) &&
    active.context?.batchId ===
      state.approvedContext?.batchId, "acceptance is not a pass for the current batch")
  require(manualTrialResolved(state), "manual UI trial unresolved")
  return active!
}
function checkBatchRoute(state: IterationState, proposal: TransitionProposal): void {
  const source = state.approvedContext
  const { manifest, remaining, resolutions } = batchProgress(state)
  const skip = proposal.kind === "skip" || proposal.kind === "skip-batch"
  require(manifest &&
    source?.batchId &&
    (remaining.includes(source.batchId) ||
      (proposal.kind === "skip" && remaining.length > 0 && manifest.batchIds.includes(source.batchId)) ||
      (!skip &&
        resolutions.some(
          (entry) => entry.batchId === source.batchId && entry.status === "accepted",
        ))), "missing unresolved pinned batch manifest")
  const expectedSkipped = proposal.kind === "skip" ? remaining : skip ? [source!.batchId!] : []
  require(canonical(proposal.skippedBatchIds ?? []) ===
    canonical(expectedSkipped), "exact skipped batch IDs required")
  if (skip)
    require(!state.attempts.some(
      (a) => a.id === state.activeAttemptId && a.status === "working",
    ), "cannot skip running work")
  else currentPass(state)
  const rest = remaining.filter((id) => id !== source!.batchId && !expectedSkipped.includes(id))
  if (proposal.to === null) {
    require(rest.length === 0, "remaining pinned-plan batches are unresolved")
    require(samePlan(source, proposal.context) &&
      proposal.context?.batchId === source!.batchId, "completion needs exact current plan and batch context")
  } else {
    require(proposal.to === "implement" &&
      proposal.skippedStages.length === 0 &&
      samePlan(source, proposal.context) &&
      proposal.context?.batchId === rest[0] &&
      !!rest.length, "next batch must be the next unresolved pinned-plan batch")
    require(!proposal.context?.changes?.length, "next batch cannot inherit previous changes")
  }
}
function resolveBatches(state: IterationState, proposal: TransitionProposal, receiptId: string): void {
  const context = state.approvedContext!
  const skipped = proposal.skippedBatchIds ?? []
  const active = skipped.length ? undefined : currentPass(state)
  state.batchResolutions ??= []
  for (const batchId of skipped.length ? skipped : [context.batchId!]) {
    if (state.batchResolutions.some((entry) => samePlan(entry.context, context) && entry.batchId === batchId))
      continue
    state.batchResolutions.push({
      context: { ...context, batchId },
      batchId,
      status: skipped.length ? "skipped" : "accepted",
      receiptId,
      ...(active
        ? { attemptId: active.id, ...(active.manualTrial ? { manualTrial: active.manualTrial } : {}) }
        : {}),
    })
  }
}
/** Migrate optional lists without dropping the old singleton's correction gate. */
function migrateRevisits(state: IterationState): void {
  const missingHistory = state.revisitHistory === undefined
  const missingObligations = state.correctionObligations === undefined
  state.revisitHistory ??= []
  state.correctionObligations ??= []
  if (missingHistory) {
    for (const transition of state.transitions.filter((p) => p.kind === "revisit")) {
      const approval = state.receipts.find((r) => r.subjectId === transition.id)!
      const request = state.receipts.findLast(
        (r) =>
          r.revision < approval.revision &&
          r.choice === transition.to &&
          (r.subjectId === `revisit:${transition.from}` ||
            state.attempts.some((a) => a.id === r.subjectId && a.stage === transition.from)),
      )
      require(request, "historical revisit request missing")
      const visit =
        state.revisit?.receiptId === request!.id
          ? state.revisit
          : {
              receiptId: request!.id,
              target: transition.to as "design" | "prototype",
              policy: "interrupt" as const,
              ...(request!.subjectId.startsWith("revisit:") ? {} : { attemptId: request!.subjectId }),
            }
      state.revisitHistory.push({ ...visit, transitionId: transition.id })
    }
  }
  const visit = state.revisit
  if (visit) {
    const request = state.receipts.find((r) => r.id === visit.receiptId)!
    const returned = state.transitions.find(
      (transition) =>
        transition.kind === "revisit" &&
        transition.to === visit.target &&
        state.receipts.some((r) => r.subjectId === transition.id && r.revision > request.revision),
    )
    if (returned) {
      if (!state.revisitHistory.some((v) => v.receiptId === visit.receiptId)) {
        state.revisitHistory.push({ ...visit, transitionId: returned.id })
      }
      delete state.revisit
    }
  }
  for (const request of [
    visit,
    ...(missingObligations ? state.revisitHistory.filter((entry) => entry.transitionId) : []),
  ]) {
    if (!request || state.correctionObligations.some((o) => o.receiptId === request.receiptId)) continue
    const sourceIndex = state.attempts.findIndex((a) => a.id === request.attemptId)
    const priorAttempts = sourceIndex < 0 ? state.attempts : state.attempts.slice(0, sourceIndex + 1)
    const previous = priorAttempts.findLast((a) => a.stage === "implement" || a.stage === "accept")
    if (previous)
      state.correctionObligations.push({
        receiptId: request.receiptId,
        target: request.target,
        attemptId: previous.id,
        correctionId: request.correctionId,
      })
  }
}
function canResumeAfterRevisit(state: IterationState, context?: ApprovalContext): void {
  for (const obligation of state.correctionObligations ?? []) {
    const previous = state.attempts.find((a) => a.id === obligation.attemptId)!
    const correction = state.corrections.find((c) => c.id === obligation.correctionId)
    require(correction?.impact === "mapped", "revisit needs mapped correction")
    require(!previous.context?.spec ||
      previous.context.spec.hash !== context?.spec?.hash, "correction needs revised spec")
  }
}
function canImplement(state: IterationState, context?: ApprovalContext): void {
  require(context?.spec &&
    context.batchPlan &&
    context.batchId &&
    context.mode &&
    context.model, "implementation needs spec/batch-plan/batch/mode/model approval")
  checkContext(state, context)
  canResumeAfterRevisit(state, context)
  require(batchProgress(state, context).manifest?.batchIds.includes(
    context!.batchId!,
  ), "missing pinned batch manifest")
}

type Handlers = {
  [K in StageEvent["type"]]: (state: IterationState, event: Extract<StageEvent, { type: K }>) => void
}
const handlers: Handlers = {
  "start-work": (state, event) => {
    require(state.phase === "ready" || state.phase === "confirmed", "work must be separately confirmed")
    require(state.status === "idle", "work is not idle")
    require(!state.attempts.some((a) => a.id === event.attemptId), "duplicate attempt")
    if (state.stage !== "design") require(state.phase === "confirmed", "missing transition approval")
    if (state.stage === "prototype") delete state.prototypeChoice
    if (state.stage === "implement") canImplement(state, state.approvedContext)
    if (state.stage === "implement")
      require(batchProgress(state).remaining.includes(
        state.approvedContext?.batchId ?? "",
      ), "batch already resolved or missing membership")
    if (state.stage === "accept") {
      require(state.approvedContext?.spec &&
        state.approvedContext.batchPlan &&
        state.approvedContext.changes?.length, "acceptance needs spec/batch-plan and actual change pointers")
      canResumeAfterRevisit(state, state.approvedContext)
      require(batchProgress(state).remaining.includes(
        state.approvedContext?.batchId ?? "",
      ), "batch already resolved or missing membership")
      require(batchProgress(state).manifest?.batchIds.includes(
        state.approvedContext!.batchId!,
      ), "missing pinned batch manifest")
      require(event.review?.attempt ===
        state.attempts.filter((a) => a.stage === "accept").length + 1, "acceptance review ordinal")
      delete state.manualTrial
      delete state.manualTrialRequired
    }
    require(state.stage === "accept" || !event.review, "review only for acceptance")
    state.attempts.push({
      id: event.attemptId,
      stage: state.stage,
      status: "working",
      changes: [],
      context: state.approvedContext,
      ...(event.review ? { review: event.review } : {}),
    })
    state.activeAttemptId = event.attemptId
    state.phase = "running"
    state.status = "working"
    delete state.summaryId
  },
  "finish-work": (state, event) => {
    const attempt = running(state, event.attemptId)
    require((state.stage === "accept") ===
      !!event.acceptance, "acceptance result required only for acceptance")
    require((state.stage === "accept") ===
      !!event.artifact, "acceptance artifact required only for acceptance")
    if (event.artifact) {
      addArtifact(state, event.artifact, "acceptance", true)
      require(event.acceptance?.artifactId === event.artifact.id, "acceptance artifact reference")
    }
    attempt.status = "finished"
    attempt.changes = [...new Set([...attempt.changes, ...event.changes])]
    attempt.acceptance = event.acceptance
    if (event.acceptance?.manualTrialRequired !== undefined) {
      state.manualTrialRequired = event.acceptance.manualTrialRequired
    }
    state.phase = "finished"
    state.status = event.acceptance?.verdict === "blocked" ? "blocked" : "idle"
  },
  "prepare-summary": (state, event) => {
    require(state.phase === "finished" ||
      state.phase === "ready" ||
      state.phase === "confirmed" ||
      (state.phase === "summarized" && (state.stage === "accept" || state.stage === "implement")) ||
      (state.phase === "complete" && state.revisit), "work not at summary boundary")
    addArtifact(state, event.artifact, "stage-summary", true)
    state.summaryId = event.artifact.id
    state.phase = "summarized"
  },
  "propose-transition": (state, event) => {
    const proposal = event.proposal
    require(state.phase === "summarized" && proposal.summaryId === state.summaryId, "summary not prepared")
    require(proposal.from === state.stage, "wrong proposal stage")
    require(!state.transitions.some((p) => p.id === proposal.id), "duplicate proposal")
    checkContext(state, proposal.context)
    const from = stages.indexOf(state.stage)
    const to = proposal.to === null ? stages.length : stages.indexOf(proposal.to)
    const active = state.attempts.find((a) => a.id === state.activeAttemptId)
    if (proposal.kind === "revisit") {
      require(state.revisit &&
        proposal.to === state.revisit.target &&
        active?.status !== "working", "revisit not drained")
      require(proposal.skippedStages.length === 0, "revisit cannot skip")
    } else if (proposal.kind === "reapprove") {
      require((state.stage === "implement" || state.stage === "accept") &&
        proposal.to === state.stage &&
        state.status === "idle" &&
        !active &&
        !state.revisit, "reapproval needs idle unstarted implementation or acceptance")
      require(proposal.skippedStages.length === 0, "reapproval cannot skip")
    } else if (proposal.kind === "next-batch" || proposal.kind === "skip-batch") {
      require((state.stage === "accept" || (state.stage === "implement" && proposal.kind === "skip-batch")) &&
        !state.revisit, "batch resolution needs current implementation or acceptance")
      checkBatchRoute(state, proposal)
    } else if (proposal.kind === "repair") {
      checkRepair(state, proposal)
    } else {
      require(!state.revisit, "queued revisit must be handled first")
      require(to > from, "transition must move forward")
      const skipped = stages.slice(from + (proposal.kind === "skip" ? 0 : 1), to)
      require(JSON.stringify(skipped) ===
        JSON.stringify(proposal.skippedStages), "exact skipped stages required")
      if (proposal.kind === "skip")
        require(!active ||
          state.stage === "accept" ||
          (state.stage === "prototype" &&
            proposal.preparationOnly &&
            active.status !== "working"), "cannot skip an executed stage")
      else require(active?.status === "finished", "stage work not finished")
      if (state.stage === "prototype" && proposal.kind !== "skip") {
        require(state.prototypeChoice, "prototype needs a human-selected variant")
      }
      require(proposal.kind !== "complete" ||
        (state.stage === "accept" && proposal.to === null), "invalid completion")
      require(proposal.to !== null || state.stage === "accept", "only acceptance can complete")
      require(proposal.to !== null ||
        proposal.kind === "complete" ||
        proposal.kind === "skip", "completion kind required")
      if (state.stage === "accept") checkBatchRoute(state, proposal)
    }
    if (proposal.preparationOnly)
      require(state.stage === "prototype" &&
        proposal.to === "implement" &&
        ["advance", "skip"].includes(proposal.kind) &&
        !proposal.context, "planning-only approval is restricted to prototype → implementation without execution context")
    if (proposal.to === "implement" && !proposal.preparationOnly) canImplement(state, proposal.context)
    if (proposal.to === "accept") {
      require(proposal.context?.spec &&
        proposal.context.batchPlan &&
        proposal.context.changes?.length, "acceptance needs spec/batch-plan and actual change pointers")
      canResumeAfterRevisit(state, proposal.context)
      require(batchProgress(state, proposal.context).manifest?.batchIds.includes(
        proposal.context!.batchId!,
      ), "missing pinned batch manifest")
    }
    state.pending = proposal
    state.phase = "proposed"
    state.status = "awaiting-confirmation"
  },
  "confirm-transition": (state, event) => {
    require(state.phase === "proposed" && state.pending, "no pending transition")
    const proposal = state.pending!
    if (proposal.kind === "repair") checkRepair(state, proposal)
    addReceipt(state, event.receipt, proposal.id, proposal.to ?? proposal.kind, proposal.context)
    if (
      (state.stage === "accept" &&
        ["complete", "skip", "next-batch", "skip-batch"].includes(proposal.kind)) ||
      (state.stage === "implement" && proposal.kind === "skip-batch")
    ) {
      checkBatchRoute(state, proposal)
      resolveBatches(state, proposal, event.receipt.id)
    }
    state.transitions.push(proposal)
    if (proposal.kind === "revisit") {
      state.revisitHistory!.push({ ...state.revisit!, transitionId: proposal.id })
      delete state.revisit
      delete state.completion
      if (proposal.from === "accept") {
        delete state.manualTrial
        delete state.manualTrialRequired
      }
    }
    for (const stage of proposal.skippedStages) {
      state.skips.push({ stage, receiptId: event.receipt.id })
      if (stage === "prototype") delete state.prototypeChoice
    }
    state.approvedContext = proposal.context
    if (
      ["next-batch", "skip-batch", "repair", "revisit"].includes(proposal.kind) ||
      (proposal.kind === "skip" && state.stage === "accept")
    ) {
      delete state.manualTrial
      delete state.manualTrialRequired
    }
    delete state.pending
    delete state.activeAttemptId
    delete state.summaryId
    state.status = "idle"
    if (proposal.to === null) {
      state.stage = "accept"
      state.completion = batchProgress(state, proposal.context).resolutions.some(
        (entry) => entry.status === "skipped",
      )
        ? "skipped"
        : "accepted"
      state.phase = "complete"
    } else {
      state.stage = proposal.to
      state.phase = "confirmed"
      if (proposal.kind === "revisit" && (proposal.to === "design" || proposal.to === "prototype"))
        delete state.prototypeChoice
    }
  },
  "cancel-transition": (state) => {
    require(state.phase === "proposed" && state.pending, "no pending transition")
    delete state.pending
    state.phase = "summarized"
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)
    state.status =
      attempt?.status === "interrupted"
        ? "interrupted"
        : attempt?.acceptance?.verdict === "blocked"
          ? "blocked"
          : "idle"
  },
  "reopen-design": (state) => {
    require(state.stage === "design" &&
      state.status === "idle" &&
      !state.pending &&
      ["ready", "finished", "summarized", "confirmed"].includes(state.phase), "design is not idle")
    delete state.activeAttemptId
    delete state.summaryId
    delete state.approvedContext
    state.phase = "ready"
    state.status = "idle"
  },
  "reopen-prototype": (state, event) => {
    const proposal = state.pending
    const attempt = state.attempts.find((entry) => entry.id === state.activeAttemptId)
    require(state.stage === "prototype" &&
      state.phase === "proposed" &&
      state.status === "awaiting-confirmation" &&
      proposal?.id === event.proposalId &&
      proposal.from === "prototype" &&
      proposal.to === "implement" &&
      proposal.kind === "skip" &&
      proposal.preparationOnly === true &&
      !proposal.context &&
      proposal.skippedStages.length === 1 &&
      proposal.skippedStages[0] === "prototype" &&
      !state.revisit, "prototype resume needs the matching pending skip")
    require(attempt?.status !== "working", "prototype work must be drained before resuming")
    require(!state.prototypeChoice ||
      attempt?.status === "finished", "chosen prototype needs its finished attempt")
    delete state.pending
    delete state.summaryId
    state.status = "idle"
    // Continue means the stage is editable again, even if it had a conclusion.
    // Retire only live pointers: the previous decision, receipt, manifest and
    // finished/interrupted attempts remain history and a new choice supersedes them.
    delete state.prototypeChoice
    delete state.activeAttemptId
    state.phase = "confirmed"
  },
  "record-artifact": (state, event) => {
    require(state.phase !== "complete" &&
      state.phase !== "proposed", "artifact publication not at writable boundary")
    require(event.artifact.kind === "spec" ||
      event.artifact.kind === "batch-plan", "use dedicated evidence event")
    addArtifact(state, event.artifact)
    if (event.manifest) {
      require(event.artifact.kind === "batch-plan" &&
        event.manifest.batchPlan.artifactId === event.artifact.id &&
        event.manifest.batchPlan.hash === event.artifact.hash, "manifest artifact mismatch")
      state.batchManifests ??= []
      state.batchManifests.push(event.manifest)
    }
  },
  "select-prototype": (state, event) => {
    require(state.stage === "prototype" &&
      ["running", "finished", "summarized"].includes(state.phase), "not prototype selection")
    addReceipt(state, event.receipt, event.variantId ?? "none", event.variantId ?? "none")
    state.prototypeChoice = {
      variantId: event.variantId,
      decisionId: event.decisionId,
      receiptId: event.receipt.id,
    }
  },
  "request-revisit": (state, event) => {
    require(stages.indexOf(event.target) < stages.indexOf(state.stage), "revisit needs an earlier stage")
    require(!state.revisit, "revisit already requested")
    require(!state.pending &&
      ["ready", "confirmed", "running", "finished", "summarized", "complete"].includes(
        state.phase,
      ), "revisit not at writable boundary")
    const isRunning = state.phase === "running"
    require(isRunning || event.policy === "interrupt", "only running work can queue a revisit")
    const attempt = event.attemptId
      ? state.attempts.find(
          (a) => a.id === event.attemptId && a.id === state.activeAttemptId && a.stage === state.stage,
        )
      : undefined
    require(!event.attemptId || attempt, "revisit attempt is not active")
    if (isRunning) running(state, event.attemptId!)
    require(attempt || event.changes.length === 0, "revisit changes need an attempt")
    addReceipt(state, event.receipt, event.attemptId ?? `revisit:${state.stage}`, event.target)
    state.revisit = {
      target: event.target,
      policy: event.policy,
      attemptId: event.attemptId,
      receiptId: event.receipt.id,
    }
    const previous = state.attempts.findLast((a) => a.stage === "implement" || a.stage === "accept")
    if (previous)
      state.correctionObligations!.push({
        receiptId: event.receipt.id,
        target: event.target,
        attemptId: previous.id,
      })
    if (attempt) attempt.changes = [...new Set([...attempt.changes, ...event.changes])]
    if (isRunning && event.policy === "interrupt") interrupt(state, event.attemptId!, event.changes)
    if (!isRunning) {
      if (state.phase === "summarized") state.phase = state.activeAttemptId ? "finished" : "confirmed"
      delete state.summaryId
    }
  },
  "cancel-revisit": (state, event) => {
    require(state.revisit, "no revisit request")
    const visit = state.revisit!
    addReceipt(state, event.receipt, visit.receiptId, "cancel-revisit")
    if (state.pending) {
      require(state.pending.kind === "revisit", "pending transition is not a revisit")
      handlers["cancel-transition"](state, { type: "cancel-transition", expectedRevision: state.revision })
    }
    state.revisitHistory!.push({ ...visit, cancelReceiptId: event.receipt.id })
    delete state.revisit
    // No earlier-stage work was entered for this request. Requiring a correction for
    // its cancellation would strand explicit continuation, since there is no new decision
    // to map. Duties from already-returned visits remain intact and still gate execution.
    state.correctionObligations = state.correctionObligations!.filter(
      (obligation) => obligation.receiptId !== visit.receiptId,
    )
    if (state.completion) {
      state.phase = "complete"
      state.status = "idle"
      delete state.summaryId
    }
  },
  "record-correction": (state, event) => {
    const visit = state.revisitHistory!.findLast(
      (visit) =>
        !!visit.transitionId &&
        (event.revisitReceiptId ? visit.receiptId === event.revisitReceiptId : visit.target === state.stage),
    )
    const obligation = state.correctionObligations!.find((entry) => entry.receiptId === visit?.receiptId)
    require(visit && (visit.target === state.stage || obligation), "no reopened stage")
    const planning =
      state.status === "idle" &&
      !state.pending &&
      !state.revisit &&
      ["design", "prototype", "implement"].includes(state.stage) &&
      ["ready", "confirmed", "finished", "summarized"].includes(state.phase)
    const stageWork =
      visit!.target === state.stage && ["running", "finished", "summarized"].includes(state.phase)
    require(planning || stageWork, "correction not at writable boundary")
    addArtifact(state, event.artifact, "correction", true)
    require(event.correction.artifactId === event.artifact.id, "correction artifact reference")
    require(!state.corrections.some((c) => c.id === event.correction.id), "duplicate correction")
    for (const ref of event.correction.acceptedBatches) {
      require(state.batchResolutions?.some(
        (resolution) =>
          resolution.status === "accepted" &&
          resolution.batchId === ref.batchId &&
          canonical(resolution.context.spec) === canonical(ref.spec) &&
          canonical(resolution.context.batchPlan) === canonical(ref.batchPlan) &&
          resolution.receiptId === ref.resolutionReceiptId &&
          resolution.attemptId === ref.attemptId,
      ), "correction requires qualified confirmed accepted batch evidence")
    }
    state.corrections.push(event.correction)
    visit!.correctionId = event.correction.id
    if (obligation) obligation.correctionId = event.correction.id
  },
  "record-manual-trial": (state, event) => {
    require(state.stage === "accept" &&
      ["running", "finished", "summarized"].includes(state.phase), "not manual trial boundary")
    const prior = state.attempts.find((a) => a.id === state.activeAttemptId)?.manualTrial
    require(prior?.status !== "problem", "manual problem requires repair and a fresh review attempt")
    require(event.status !== "pending" || !event.receipt, "pending prompt is not human trial")
    if (event.status !== "pending") {
      require(state.manualTrial && event.receipt, "manual trial needs prompt and human receipt")
      addReceipt(state, event.receipt!, event.artifact.id, event.status)
    }
    addArtifact(state, event.artifact, "manual-trial", true)
    state.manualTrial = { status: event.status, artifactId: event.artifact.id, receiptId: event.receipt?.id }
    const active = state.attempts.find((a) => a.id === state.activeAttemptId)
    require(active?.stage === "accept" &&
      (active.status === "working" || active.status === "finished"), "manual trial needs current review")
    active!.manualTrial = state.manualTrial
  },
  "interrupt-work": (state, event) => interrupt(state, event.attemptId, event.changes),
  "interrupt-batch": (state, event) => {
    const attempt = state.attempts.find((entry) => entry.id === event.attemptId)
    require(state.stage === "implement" &&
      state.activeAttemptId === event.attemptId &&
      ["running", "finished", "summarized", "proposed"].includes(state.phase) &&
      attempt?.stage === "implement" &&
      ["working", "finished"].includes(attempt.status), "not an active implementation lifecycle")
    require(!state.pending ||
      (state.pending.kind === "advance" &&
        state.pending.to === "accept"), "cannot cancel another pending transition")
    attempt!.status = "interrupted"
    attempt!.changes = [...new Set([...attempt!.changes, ...event.changes])]
    state.status = "interrupted"
    state.phase = "finished"
    delete state.pending
    delete state.summaryId
  },
  "invalidate-review": (state, event) => {
    const attempt = state.attempts.find((entry) => entry.id === event.attemptId)
    require(state.stage === "accept" &&
      state.activeAttemptId === event.attemptId &&
      attempt?.status === "finished" &&
      attempt.acceptance &&
      state.phase !== "complete", "only an unconsumed finished review can become stale")
    require(!(state.batchResolutions ?? []).some(
      (entry) => entry.attemptId === event.attemptId,
    ), "accepted history must remain intact")
    attempt!.staleReason = event.reason
    attempt!.status = "interrupted"
    state.phase = "finished"
    state.status = "interrupted"
    delete state.pending
    delete state.summaryId
  },
  "confirm-continuation": (state, event) => {
    require(!hasManualProblem(state), "manual problem requires repair, not continuation")
    require((state.status === "interrupted" || state.status === "blocked") &&
      !state.revisit, "no interrupted or blocked continuation")
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)!
    addReceipt(state, event.receipt, attempt.id, "resume", attempt.context)
    if (attempt.stage === "accept") {
      delete state.manualTrial
      delete state.manualTrialRequired
    }
    state.approvedContext = attempt.context
    state.status = "idle"
    state.phase = "confirmed"
    delete state.activeAttemptId
    delete state.summaryId
  },
}

/** Inert legacy-state migration; no revision change or mutation of the durable input. */
export function normalizeIteration(state: IterationState): IterationState {
  validateIteration(state)
  const normalized = structuredClone(state)
  migrateRevisits(normalized)
  validateIteration(normalized)
  return normalized
}

/** Pure bookkeeping: no IO, timestamps, execution, model calls, or automatic restart. */
export function reduceStage(state: IterationState, event: StageEvent): IterationState {
  validateIteration(state)
  require(event && Object.hasOwn(eventChecks, event.type), "unknown event")
  require(object({ type: oneOf(event.type), expectedRevision: integer, ...eventChecks[event.type] })(
    event,
  ), "invalid event schema")
  require(event.expectedRevision === state.revision, "stale event revision")
  const next = normalizeIteration(state)
  const handler = handlers[event.type] as (state: IterationState, event: StageEvent) => void
  handler(next, structuredClone(event))
  require(state.revision < Number.MAX_SAFE_INTEGER, "revision exhausted")
  next.revision += 1
  validateIteration(next)
  return next
}
