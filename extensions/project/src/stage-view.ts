import { localize } from "./language.ts"
import type { IterationState, Stage } from "./stage.ts"

export function stageName(stage: Stage, language: string): string {
  const names: Record<Stage, [string, string, string]> = {
    design: ["design", "设计", "設計"],
    prototype: ["prototype", "原型", "プロトタイプ"],
    implement: ["implementation", "实现", "実装"],
    accept: ["acceptance", "验收", "受け入れ確認"],
  }
  return localize(language, ...names[stage])
}

export function statusName(status: IterationState["status"], language: string): string {
  const names: Record<IterationState["status"], [string, string, string]> = {
    idle: ["idle", "空闲", "待機中"],
    working: ["working", "进行中", "作業中"],
    "awaiting-confirmation": ["awaiting confirmation", "等待确认", "確認待ち"],
    interrupted: ["interrupted", "已中断", "中断"],
    blocked: ["blocked", "受阻", "ブロック中"],
  }
  return localize(language, ...names[status])
}

export function executionUnavailable(language: string): string {
  return localize(
    language,
    "Start an approved batch with /project implement or its approved review with /project accept. No work was started. Ship: coming later.",
    "用 /project implement 开始已批准的实现批次，或用 /project accept 开始已批准的验收。未启动任何工作。发布：稍后提供。",
    "承認済みバッチは /project implement、承認済みの確認は /project accept で開始します。作業は開始していません。リリースは今後対応。",
  )
}

/** Rendering never infers approval or advances work. Historical artifact text is not translated. */
export function nextSuggestion(state: IterationState, language: string, designAvailable = false): string {
  if (state.status === "awaiting-confirmation")
    return localize(
      language,
      "Review the saved summary and next step: /project next",
      "查看已保存的总结并确认下一步：/project next",
      "保存済みの要約と次の手順を確認：/project next",
    )
  if (state.revisit?.policy === "boundary" && state.status === "working")
    return localize(
      language,
      `Revisit ${stageName(state.revisit.target, language)} is queued until this batch finishes.`,
      `回访${stageName(state.revisit.target, language)}已排队，等待本批结束。`,
      `${stageName(state.revisit.target, language)}の再検討をこのバッチの終了まで予約しています。`,
    )
  if (state.revisit)
    return localize(
      language,
      `Review the request to revisit ${stageName(state.revisit.target, language)}: /project next`,
      `查看回访${stageName(state.revisit.target, language)}的请求：/project next`,
      `${stageName(state.revisit.target, language)}の再検討要求を確認：/project next`,
    )
  const trial = state.manualTrial?.status ?? (state.manualTrialRequired ? "pending" : undefined)
  const automatedPass =
    state.attempts.find((attempt) => attempt.id === state.activeAttemptId)?.acceptance?.verdict === "pass"
  if (state.stage === "accept" && trial === "problem")
    return state.status === "working"
      ? localize(
          language,
          "A human trial found a problem. Wait for the running review to finish, or explicitly interrupt with /project revisit design|prototype. No repair work has started.",
          "手动试用发现问题。请等待当前验收结束，或用 /project revisit design|prototype 明确中断。未开始修复工作。",
          "手動試用で問題が見つかりました。実行中の確認が完了するまで待つか、/project revisit design|prototype で明示的に中断してください。修正作業は開始していません。",
        )
      : localize(
          language,
          "A human trial found a problem. /project next reviews repair approval for the same pinned batch; a fresh review and trial are required after repair.",
          "手动试用发现问题。/project next 确认同一固定批次的修复审批；修复后必须重新验收和试用。",
          "手動試用で問題が見つかりました。/project next で同じ固定バッチの修正承認を確認します。修正後は新しい確認と試用が必要です。",
        )
  if (state.stage === "accept" && automatedPass && trial === "pending")
    return localize(
      language,
      `Batch ${state.approvedContext?.batchId ?? "—"} automated pass, manual trial pending · /project next reviews the trial prompt`,
      `批次 ${state.approvedContext?.batchId ?? "—"} 已通过自动验收，等待手动试用 · /project next 查看试用提示`,
      `バッチ ${state.approvedContext?.batchId ?? "—"} は自動確認済み、手動試用待ち · /project next で試用手順を確認`,
    )
  if (state.stage === "prototype")
    return localize(
      language,
      "Prototype variants: /project prototype · F6 returns to main · Compare and choose: /project prototype choose",
      "原型变体：/project prototype · F6 返回主会话 · 对比并选择：/project prototype choose",
      "プロトタイプ案：/project prototype · F6 でメインへ · 比較と選択：/project prototype choose",
    )
  if (state.status === "working")
    return localize(
      language,
      "Work is in progress. /project revisit design|prototype can interrupt or queue a revisit.",
      "工作进行中。/project revisit design|prototype 可中断当前工作或排队回访。",
      "作業中です。/project revisit design|prototype で中断または再検討を予約できます。",
    )
  if (state.stage === "accept" && state.phase === "complete")
    return localize(
      language,
      "Iteration complete · ship: coming later",
      "迭代已完成 · 发布：稍后提供",
      "イテレーション完了 · リリースは今後対応",
    )
  if (state.stage === "accept" && state.phase === "confirmed")
    return localize(
      language,
      "Start approved review: /project accept · F6 returns to main",
      "开始已批准的验收：/project accept · F6 返回主会话",
      "承認済み確認を開始：/project accept · F6 でメインへ",
    )
  if (state.stage === "implement")
    return localize(
      language,
      state.phase === "confirmed" && state.approvedContext?.spec
        ? "Start approved batch: /project implement · F6 returns to main"
        : state.phase === "summarized"
          ? "Implementation finished · propose acceptance: /project next"
          : "Review implementation spec: /project spec",
      state.phase === "confirmed" && state.approvedContext?.spec
        ? "开始已批准的批次：/project implement · F6 返回主会话"
        : "审阅实现规格：/project spec",
      state.phase === "confirmed" && state.approvedContext?.spec
        ? "承認済みバッチを開始：/project implement · F6 でメインへ"
        : "実装仕様を確認：/project spec",
    )
  if (state.stage !== "design") return executionUnavailable(language)
  return designAvailable
    ? localize(
        language,
        "Continue design decisions · F6 returns to main from design · /project next reviews the next step",
        "继续确认设计决策 · 设计会话中按 F6 返回主会话 · /project next 查看下一步",
        "設計の決定を続ける · 設計から F6 でメインに戻る · /project next で次の手順を確認",
      )
    : localize(
        language,
        "Open design conversation: /project design · /project next reviews the next step",
        "打开设计会话：/project design · /project next 查看下一步",
        "設計会話を開く：/project design · /project next で次の手順を確認",
      )
}
