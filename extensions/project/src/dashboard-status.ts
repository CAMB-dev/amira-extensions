import {
  type ApprovalContext,
  batchProgress,
  type IterationState,
  type Stage,
  type StageAttempt,
} from "./stage.ts"

export interface StageDisplay {
  status: "queued" | "running" | "idle" | "done" | "failed" | "stopped"
  outcome: string
  attempt?: StageAttempt
  resolutionSummary?: string
}
// Property order is not approval identity; array order (including change pointers) is.
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item,
  )
const sameScope = (left?: ApprovalContext, right?: ApprovalContext) =>
  canonical(
    left && {
      spec: left.spec,
      batchPlan: left.batchPlan,
      batchId: left.batchId,
      mode: left.mode,
      model: left.model,
    },
  ) ===
  canonical(
    right && {
      spec: right.spec,
      batchPlan: right.batchPlan,
      batchId: right.batchId,
      mode: right.mode,
      model: right.model,
    },
  )

function attemptDisplay(attempt: StageAttempt, state: IterationState, current: boolean): StageDisplay {
  if (!current && attempt.status === "working") return { status: "stopped", outcome: "interrupted", attempt }
  if (attempt.staleReason) return { status: "idle", outcome: "stale review; fresh review required", attempt }
  if (attempt.status === "interrupted") return { status: "stopped", outcome: "interrupted", attempt }
  if (attempt.status === "working") return { status: "running", outcome: "working", attempt }
  if (attempt.stage !== "accept") return { status: "done", outcome: "finished", attempt }
  if (attempt.acceptance?.verdict !== "pass")
    return { status: "failed", outcome: attempt.acceptance?.verdict ?? "review unavailable", attempt }
  const trial =
    attempt.manualTrial?.status ??
    (current ? state.manualTrial?.status : undefined) ??
    (attempt.acceptance.manualTrialRequired ? "pending" : undefined)
  if (trial === "problem")
    return { status: "failed", outcome: "automated pass; human trial problem — repair required", attempt }
  if (trial === "pending")
    return { status: "idle", outcome: "automated pass; required human trial pending", attempt }
  return {
    status: "done",
    outcome: `automated pass${trial ? `; human trial ${trial === "deferred" ? "deferred (not tried)" : trial}` : ""}`,
    attempt,
  }
}

/** Display evidence, never execution authority. Current work requires its active approval-bound attempt. */
export function stageDisplay(state: IterationState, stage: Stage): StageDisplay {
  const progress = batchProgress(state)
  const accepted = progress.resolutions.filter((resolution) => resolution.status === "accepted").length
  const skipped = progress.resolutions.filter((resolution) => resolution.status === "skipped").length
  const resolutionSummary = progress.resolutions.length
    ? `${accepted} accepted / ${skipped} skipped`
    : undefined
  if (stage === "accept" && state.completion) {
    // Completion is authoritative. A previous review cannot turn a waived batch into a pass.
    if (state.completion === "skipped" || skipped)
      return {
        status: "stopped",
        outcome: accepted ? "completed with skips (not passed)" : "skipped (not passed)",
        resolutionSummary,
      }
    return { status: "done", outcome: "accepted", resolutionSummary }
  }
  const route = state.transitions.findLast(
    (transition) => transition.to === stage || transition.skippedStages.includes(stage),
  )
  const stageSkipped = route
    ? route.skippedStages.includes(stage)
    : state.skips.some((skip) => skip.stage === stage)
  if (stageSkipped) return { status: "stopped", outcome: "skipped (not passed)", resolutionSummary }
  const current = state.stage === stage && state.phase !== "complete"
  const attempts = state.attempts.filter((attempt) => attempt.stage === stage)
  if (current) {
    const active = attempts.find(
      (attempt) =>
        attempt.id === state.activeAttemptId &&
        canonical(attempt.context) === canonical(state.approvedContext),
    )
    if (active) return { ...attemptDisplay(active, state, true), resolutionSummary }
    const outcome =
      state.status === "blocked"
        ? "blocked"
        : state.status === "interrupted"
          ? "interrupted; approval required"
          : state.status === "awaiting-confirmation"
            ? "awaiting confirmation"
            : stage === "accept"
              ? "awaiting review"
              : stage === "implement"
                ? "awaiting implementation"
                : "awaiting execution"
    return {
      status: state.status === "blocked" ? "failed" : state.status === "interrupted" ? "stopped" : "idle",
      outcome,
      resolutionSummary,
    }
  }
  const previous =
    stage === "implement" || stage === "accept"
      ? attempts.findLast((attempt) => sameScope(attempt.context, state.approvedContext))
      : attempts.at(-1)
  if (previous) {
    const display = attemptDisplay(previous, state, false)
    return { ...display, outcome: `${display.outcome} (historical)`, resolutionSummary }
  }
  return { status: "queued", outcome: "queued", resolutionSummary }
}
