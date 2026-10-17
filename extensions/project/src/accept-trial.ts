import type { AcceptanceArtifact, SpecArtifact } from "./artifacts.ts"
import { localize } from "./language.ts"
import type { IterationState } from "./stage.ts"
import type { IterationStore } from "./store.ts"

/** A prompt is not human trial evidence. Only a later confirmed human receipt can
 * change pending into tried/problem/deferred, and never while silently replaying. */
export async function prepareManualTrial(
  store: IterationStore,
  state: IterationState,
  verdict: AcceptanceArtifact,
  spec: SpecArtifact,
  cwd: string,
  language: string,
): Promise<IterationState> {
  const ids = new Set(verdict.items.map((item) => item.itemId))
  const items = spec.items.filter((item) => item.ui && ids.has(item.id))
  if (verdict.outcome !== "pass" || !items.length || state.revisit) return state
  const saved = await store.saveArtifact(state.revision, {
    kind: "manual-trial",
    specHash: verdict.specHash,
    specRevision: verdict.specRevision,
    batchId: verdict.batchId,
    batchPlan: verdict.batchPlan,
    attemptId: verdict.attemptId,
    attempt: verdict.attempt,
    codeHash: verdict.codeHash,
    status: "pending",
    instructions: localize(
      language,
      `Manual trial pending. In ${cwd}, follow the approved UI verification instructions below. Use the implemented UI, not prototype code. Running automated checks alone is not a manual trial. Record tried, OK; tried, problem; or explicitly skip trial for now (not tried). No browser or GUI is launched automatically.`,
      `等待手动试用。请在 ${cwd} 按以下已批准的界面验证说明操作。试用实现后的界面，而非原型。仅运行自动检查不代表手动试用。请选择已试用且正常、已试用但有问题，或明确暂缓试用（未试用）。不会自动打开浏览器或界面。`,
      `手動試用待ち。${cwd} で以下の承認済み UI 検証手順に従ってください。試作ではなく実装済み UI を試します。自動チェックだけでは手動試用になりません。問題なし・問題あり・明示的な延期（未試用）を記録してください。ブラウザー等は自動起動しません。`,
    ),
    observe: items.flatMap((item) => [
      `${item.id}: ${item.description}`,
      ...item.verification.map((step) => `Verify: ${step}`),
      ...item.acceptanceCriteria.map((criterion) => `Observe: ${criterion}`),
    ]),
  })
  return store.dispatch(saved.state.revision, {
    type: "record-manual-trial",
    expectedRevision: saved.state.revision,
    status: "pending",
    artifact: saved.artifact,
  })
}
