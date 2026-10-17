import type { AcceptanceArtifact } from "./artifacts.ts"
import { localize } from "./language.ts"
import type { IterationState } from "./stage.ts"
import type { IterationStore } from "./store.ts"

export interface AcceptanceView {
  stateRevision: number
  attemptId: string
  attempt: number
  running: boolean
  total: number
  counts: Record<AcceptanceArtifact["items"][number]["status"], number>
  outcome?: AcceptanceArtifact["outcome"]
  sameModelFallback?: boolean
  manualTrial?: "pending" | "tried" | "problem" | "deferred"
  stale: boolean
  reason: string | null
  verified: boolean
}

/** Artifact-only panel refresh: never starts a model, Git command or approval dialog. */
export async function acceptanceView(
  store: IterationStore,
  state: IterationState,
  cached?: AcceptanceView,
): Promise<AcceptanceView | undefined> {
  if (cached?.stateRevision === state.revision) return cached
  const active = state.attempts.find((entry) => entry.id === state.activeAttemptId)
  const attempt =
    active?.stage === "accept" ? active : state.attempts.findLast((entry) => entry.stage === "accept")
  if (!attempt?.review) return undefined
  const counts: AcceptanceView["counts"] = { pass: 0, fail: 0, blocked: 0, "not-applicable": 0 }
  const ref = state.artifacts.find((entry) => entry.id === attempt.acceptance?.artifactId)
  const verdict = ref && (await store.readArtifact(ref))
  const planRef = state.artifacts.find((entry) => entry.id === attempt.context?.batchPlan?.artifactId)
  const plan = planRef && (await store.readArtifact(planRef))
  const total =
    plan?.kind === "batch-plan"
      ? (plan.batches.find((entry) => entry.id === attempt.context?.batchId)?.itemIds.length ?? 0)
      : 0
  if (verdict?.kind === "acceptance") for (const item of verdict.items) counts[item.status]++
  const sameAttempt = cached?.attemptId === attempt.id
  const latestSpec = state.artifacts.findLast((entry) => entry.kind === "spec")
  const reason =
    attempt.staleReason ??
    (latestSpec?.hash !== attempt.context?.spec?.hash
      ? "The spec changed; a fresh review is required."
      : sameAttempt
        ? (cached?.reason ?? null)
        : null)
  return {
    stateRevision: state.revision,
    attemptId: attempt.id,
    attempt: attempt.review.attempt,
    running: attempt.status === "working",
    total,
    counts,
    ...(verdict?.kind === "acceptance"
      ? { outcome: verdict.outcome, sameModelFallback: verdict.sameModelFallback }
      : {}),
    manualTrial:
      attempt.manualTrial?.status ??
      (active?.id === attempt.id ? state.manualTrial?.status : undefined) ??
      (attempt.acceptance?.manualTrialRequired ? "pending" : undefined),
    stale: !!reason || (sameAttempt && cached?.stale === true),
    reason,
    verified: sameAttempt && cached?.verified === true,
  }
}

export function acceptancePanelText(view: AcceptanceView, language: string): string {
  const counts = `${view.counts.pass} pass · ${view.counts.fail} fail · ${view.counts.blocked} blocked · ${view.counts["not-applicable"]} N/A / ${view.total}`
  const status = view.running ? "in progress" : (view.outcome ?? "interrupted")
  const trial = view.manualTrial
    ? ` · manual trial: ${view.manualTrial === "deferred" ? "deferred (not tried)" : view.manualTrial === "tried" ? "tried, OK" : view.manualTrial}`
    : ""
  const freshness = view.stale
    ? " · STALE — fresh review required"
    : view.outcome && !view.verified
      ? " · freshness: /project status"
      : ""
  return localize(
    language,
    `Acceptance ${view.attempt}: ${status} · ${counts}${trial}${view.sameModelFallback ? " · same-model" : ""}${freshness}`,
    `验收 ${view.attempt}：${status} · ${counts}${trial}${view.sameModelFallback ? " · 同模型" : ""}${freshness}`,
    `受け入れ確認 ${view.attempt}：${status} · ${counts}${trial}${view.sameModelFallback ? " · 同一モデル" : ""}${freshness}`,
  )
}
