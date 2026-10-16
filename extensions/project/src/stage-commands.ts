import { randomUUID } from "node:crypto"
import type { CommandContext } from "@amira/api"
import type { StageSummaryArtifact } from "./artifacts.ts"
import { ProjectCommandError } from "./diagnostics.ts"
import { localize } from "./language.ts"
import { renderSpec } from "./spec.ts"
import {
  batchProgress,
  type HumanReceipt,
  hasManualProblem,
  type IterationState,
  normalizeIteration,
  reduceStage,
  type Stage,
  type TransitionProposal,
} from "./stage.ts"
import { executionUnavailable, nextSuggestion, stageName, statusName } from "./stage-view.ts"
import { DecisionStore, IterationStore, type Project, readDocument } from "./store.ts"

const stages: Stage[] = ["design", "prototype", "implement", "accept"]
export function isStage(value: string | undefined): value is Stage {
  return stages.includes(value as Stage)
}

function receipt(
  state: IterationState,
  subjectId: string,
  choice: string,
  reason: string,
  context?: HumanReceipt["context"],
): HumanReceipt {
  return {
    id: randomUUID(),
    provenance: "human",
    projectId: state.projectId,
    iteration: state.iteration,
    revision: state.revision,
    subjectId,
    choice,
    reason,
    ...(context ? { context } : {}),
  }
}

export function stageStatus(state: IterationState, language: string): string {
  state = normalizeIteration(state)
  const pending = state.pending
    ? `${state.pending.suggestion} (${state.pending.id}; r${state.revision})`
    : localize(language, "none", "无", "なし")
  const trial = state.manualTrial?.status ?? (state.manualTrialRequired ? "pending" : undefined)
  const automatedPass =
    state.attempts.find((attempt) => attempt.id === state.activeAttemptId)?.acceptance?.verdict === "pass"
  const trialText = trial
    ? localize(
        language,
        { pending: "pending", tried: "tried", problem: "problem", deferred: "deferred" }[trial],
        { pending: "待试用", tried: "已试用", problem: "发现问题", deferred: "已明确推迟" }[trial],
        { pending: "試用待ち", tried: "試用済み", problem: "問題あり", deferred: "明示的に延期" }[trial],
      )
    : localize(language, "not requested", "未要求", "未要求")
  const completion =
    state.completion === "skipped"
      ? localize(
          language,
          "Acceptance skipped — not a pass",
          "已跳过验收，不代表通过",
          "受け入れ確認をスキップ（合格ではありません）",
        )
      : state.completion === "accepted"
        ? localize(language, "Accepted", "已验收", "受け入れ済み")
        : state.stage === "accept" && automatedPass && trial === "pending"
          ? localize(
              language,
              `Batch ${state.approvedContext?.batchId ?? "—"} accepted, manual trial pending`,
              `批次 ${state.approvedContext?.batchId ?? "—"} 已通过自动验收，等待手动试用`,
              `バッチ ${state.approvedContext?.batchId ?? "—"} は自動確認済み、手動試用待ち`,
            )
          : ""
  return (
    localize(
      language,
      `Stage: ${stageName(state.stage, language)}\nStatus: ${statusName(state.status, language)} (r${state.revision})\nPending approval: ${pending}\nManual trial: ${trialText}`,
      `阶段：${stageName(state.stage, language)}\n状态：${statusName(state.status, language)}（r${state.revision}）\n待确认：${pending}\n手动试用：${trialText}`,
      `段階：${stageName(state.stage, language)}\n状態：${statusName(state.status, language)}（r${state.revision}）\n承認待ち：${pending}\n手動試用：${trialText}`,
    ) +
    (completion ? `\n${completion}` : "") +
    (batchProgress(state).manifest ? tBatchStatus(state, language) : "") +
    (state.revisit
      ? localize(
          language,
          `\nRevisit ${stageName(state.revisit.target, language)}: ${state.revisit.policy === "boundary" ? "queued until this batch finishes" : "interrupted; changes preserved"}`,
          `\n回访${stageName(state.revisit.target, language)}：${state.revisit.policy === "boundary" ? "已排队，等待本批结束" : "已中断，保留改动"}`,
          `\n${stageName(state.revisit.target, language)}の再検討：${state.revisit.policy === "boundary" ? "このバッチの終了まで予約中" : "中断済み、変更を保持"}`,
        )
      : "")
  )
}

function tBatchStatus(state: IterationState, language: string): string {
  const { resolutions, remaining } = batchProgress(state)
  const accepted =
    resolutions
      .filter((entry) => entry.status === "accepted")
      .map((entry) => entry.batchId)
      .join(", ") || "—"
  const skipped =
    resolutions
      .filter((entry) => entry.status === "skipped")
      .map((entry) => entry.batchId)
      .join(", ") || "—"
  return localize(
    language,
    `\nBatch: ${state.approvedContext?.batchId}\nAccepted batches: ${accepted}\nSkipped batches (not passed): ${skipped}\nUnresolved batches: ${remaining.join(", ") || "—"}`,
    `\n批次：${state.approvedContext?.batchId}\n已验收批次：${accepted}\n已跳过批次（未通过）：${skipped}\n未解决批次：${remaining.join("、") || "—"}`,
    `\nバッチ：${state.approvedContext?.batchId}\n受け入れ済み：${accepted}\nスキップ（合格ではありません）：${skipped}\n未解決：${remaining.join("、") || "—"}`,
  )
}

/** Commands only publish bookkeeping and human receipts. No stage executor is called here. */
export async function runStageCommand(
  verb: "next" | "skip" | "revisit",
  args: string[],
  project: Project,
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
  quiesce: () => Promise<void>,
  changed: (state: IterationState) => void = () => {},
  generateSpec?: () => Promise<void>,
): Promise<IterationState> {
  const store = new IterationStore(project)
  let state = normalizeIteration(await store.read())
  const t = (en: string, zh: string, ja: string) => localize(language, en, zh, ja)
  const ask = async (title: string, options: string[]) => {
    checkOrigin()
    changed(state)
    const answer = await ctx.ui.select(title, options, {
      signal: ctx.signal,
      sessionId: ctx.session.info().id,
    })
    checkOrigin()
    return answer
  }
  const confirm = async (title: string, body: string) => {
    checkOrigin()
    changed(state)
    const answer = await ctx.ui.confirm(title, body, { signal: ctx.signal, sessionId: ctx.session.info().id })
    checkOrigin()
    return answer === true
  }
  const summary = async (payload: StageSummaryArtifact) => {
    checkOrigin()
    const saved = await store.saveArtifact(state.revision, payload)
    state = saved.state
    state = await store.dispatch(state.revision, {
      type: "prepare-summary",
      expectedRevision: state.revision,
      artifact: saved.artifact,
    })
  }
  const showSummary = async () => {
    const ref = state.artifacts.find((a) => a.id === (state.pending?.summaryId ?? state.summaryId))
    if (!ref) return
    const data = await store.readArtifact(ref)
    if (data.kind === "stage-summary") ctx.print(`${data.summary}\n\n${data.suggestion}`)
    if (state.pending?.to === "implement" && state.pending.context?.spec && state.pending.context.batchPlan) {
      const specRef = state.artifacts.find((entry) => entry.id === state.pending!.context!.spec!.artifactId)!
      const planRef = state.artifacts.find(
        (entry) => entry.id === state.pending!.context!.batchPlan!.artifactId,
      )!
      const spec = await store.readArtifact(specRef)
      const plan = await store.readArtifact(planRef)
      if (spec.kind === "spec" && plan.kind === "batch-plan")
        ctx.print(renderSpec(spec, plan), "info", { markdown: true })
    }
  }
  const approve = async () => {
    const pending = state.pending!
    if (
      !(await confirm(
        t("Confirm stage change", "确认阶段变更", "段階の変更を確認"),
        `${pending.suggestion}${pending.context ? `\n\n${JSON.stringify(pending.context, null, 2)}` : ""}\n\n${executionUnavailable(language)}`,
      ))
    )
      return
    checkOrigin()
    await quiesce()
    checkOrigin()
    state = await store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: receipt(
        state,
        pending.id,
        pending.to ?? pending.kind,
        t("Confirmed the displayed stage change", "已确认所展示的阶段变更", "表示された段階の変更を確認"),
        pending.context,
      ),
    })
    ctx.print(`${stageStatus(state, language)}\n${nextSuggestion(state, language)}`)
  }
  const propose = async (proposal: TransitionProposal) => {
    checkOrigin()
    state = await store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal,
    })
  }
  const skipBatch = async (all: boolean) => {
    const { manifest, remaining } = batchProgress(state)
    const source = state.approvedContext
    if (
      (state.stage !== "accept" && (all || state.stage !== "implement")) ||
      !manifest ||
      !source?.batchId ||
      (all ? !remaining.length : !remaining.includes(source.batchId))
    )
      throw new ProjectCommandError(
        t(
          "Skip a batch only from its pinned implementation or acceptance stage.",
          "请在固定计划的实现或验收阶段跳过批次。",
          "固定された計画の実装または受け入れ確認でバッチをスキップしてください。",
        ),
      )
    if (state.status === "working" || state.revisit)
      throw new ProjectCommandError(
        t(
          "Finish or interrupt current work and resolve the revisit before skipping batches.",
          "请先完成或中断当前工作，并处理回访请求，然后跳过批次。",
          "バッチをスキップする前に現在の作業を完了または中断し、再検討の要求を解決してください。",
        ),
      )
    const skippedBatchIds = all ? remaining : [source.batchId]
    const next = remaining.find((id) => !skippedBatchIds.includes(id))
    const context = next ? { ...source, batchId: next } : { ...source }
    if (next) delete context.changes
    if (state.pending)
      state = await store.dispatch(state.revision, {
        type: "cancel-transition",
        expectedRevision: state.revision,
      })
    await summary({
      kind: "stage-summary",
      stage: state.stage,
      language,
      outputs: state.attempts.find((entry) => entry.id === state.activeAttemptId)?.changes ?? [],
      summary: t(
        `Explicitly skip batches: ${skippedBatchIds.join(", ")}. No passing acceptance is claimed for these batches. Existing attempts and verdicts are preserved.`,
        `明确跳过批次：${skippedBatchIds.join("、")}。不声称这些批次已通过验收。保留已有工作记录和结果。`,
        `バッチを明示的にスキップ：${skippedBatchIds.join("、")}。合格は主張しません。既存の作業記録と判定を保持します。`,
      ),
      suggestion: t(
        "Review the explicit batch skip; not a pass.",
        "确认明确跳过批次；不代表通过。",
        "バッチの明示的なスキップを確認（合格ではありません）。",
      ),
    })
    await propose({
      id: randomUUID(),
      from: state.stage,
      to: next ? "implement" : null,
      kind: all ? "skip" : "skip-batch",
      summaryId: state.summaryId!,
      skippedStages: all ? ["accept"] : [],
      skippedBatchIds,
      context,
      suggestion: t(
        `Skip batches ${skippedBatchIds.join(", ")} — not a pass${next ? `; prepare ${next} for fresh implementation approval` : "; complete bookkeeping, do not ship"}`,
        `跳过批次 ${skippedBatchIds.join("、")}，不代表通过${next ? `；准备 ${next} 的新实现审批` : "；完成记录，不会发布"}`,
        `バッチ ${skippedBatchIds.join("、")} をスキップ（合格ではありません）${next ? `。${next} の新しい実装承認を準備` : "。記録を完了しリリースしません"}`,
      ),
    })
    await showSummary()
    await approve()
  }
  const skip = async (stage: Stage) => {
    if (stage === "accept" && state.stage === "accept") return skipBatch(true)
    if (stage !== state.stage)
      throw new ProjectCommandError(
        t(
          "Only the current stage can be skipped.",
          "只能跳过当前阶段。",
          "スキップできるのは現在の段階だけです。",
        ),
      )
    if (state.stage === "prototype" && state.phase === "running" && state.activeAttemptId) {
      await quiesce()
      checkOrigin()
      const attempt = state.attempts.find((entry) => entry.id === state.activeAttemptId)!
      state = await store.dispatch(state.revision, {
        type: "interrupt-work",
        expectedRevision: state.revision,
        attemptId: attempt.id,
        changes: attempt.changes,
      })
    }
    if (state.activeAttemptId && state.stage !== "prototype")
      throw new ProjectCommandError(
        t(
          "This stage has an attempt. Finish it or revisit instead of skipping its evidence.",
          "当前阶段已有工作记录。请完成工作或回访，不要跳过已有证据。",
          "作業記録があります。完了または再検討し、証拠をスキップしないでください。",
        ),
      )
    const target = stages[stages.indexOf(stage) + 1] ?? null
    const context = state.stage === "prototype" ? undefined : state.approvedContext
    if (
      (target === "implement" &&
        stage !== "prototype" &&
        !(context?.spec && context.batchPlan && context.batchId && context.mode && context.model)) ||
      (target === "accept" && !(context?.spec && context.batchPlan && context.changes?.length))
    ) {
      // Spec/plan approval and existing-change selection arrive with the execution steps.
      ctx.print(executionUnavailable(language))
      return
    }
    if (state.pending)
      state = await store.dispatch(state.revision, {
        type: "cancel-transition",
        expectedRevision: state.revision,
      })
    if (state.phase !== "summarized")
      await summary({
        kind: "stage-summary",
        stage,
        language,
        outputs: [],
        summary: t(
          `No ${stageName(stage, language)} output is claimed. You requested an explicit skip.`,
          `不声称已有${stageName(stage, language)}产出。你请求明确跳过此阶段。`,
          `${stageName(stage, language)}の成果は主張しません。明示的なスキップを要求しました。`,
        ),
        suggestion: t(
          `Skip ${stageName(stage, language)}${stage === "accept" ? " (not a pass)" : ""}?`,
          `跳过${stageName(stage, language)}${stage === "accept" ? "（不代表通过）" : ""}？`,
          `${stageName(stage, language)}をスキップ${stage === "accept" ? "（合格ではありません）" : ""}しますか？`,
        ),
      })
    await propose({
      id: randomUUID(),
      from: stage,
      to: target,
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: t(
        `Skip ${stageName(stage, language)}${target ? ` → ${stageName(target, language)}` : " — not a pass; no shipping"}`,
        `跳过${stageName(stage, language)}${target ? ` → ${stageName(target, language)}` : "，不代表通过；不会发布"}`,
        `${stageName(stage, language)}をスキップ${target ? ` → ${stageName(target, language)}` : "（合格ではありません。リリースしません）"}`,
      ),
      skippedStages: [stage],
      ...(stage === "prototype" && !context ? { preparationOnly: true as const } : {}),
      ...(context ? { context } : {}),
    })
    await showSummary()
    await approve()
  }

  if (verb === "skip") {
    if (args.length === 1 && args[0] === "batch") {
      await skipBatch(false)
      return state
    }
    if (args.length !== 1 || !isStage(args[0]))
      throw new ProjectCommandError(
        t(
          "Use /project skip design|prototype|implement|accept|batch",
          "用法：/project skip design|prototype|implement|accept|batch",
          "使用方法：/project skip design|prototype|implement|accept|batch",
        ),
      )
    await skip(args[0])
    return state
  }
  if (verb === "revisit") {
    const target = args[0]
    if (args.length !== 1 || (target !== "design" && target !== "prototype"))
      throw new ProjectCommandError(
        t(
          "Use /project revisit design|prototype",
          "用法：/project revisit design|prototype",
          "使用方法：/project revisit design|prototype",
        ),
      )
    if (stages.indexOf(target) >= stages.indexOf(state.stage) || state.pending || state.revisit) {
      ctx.print(
        t(
          "Choose an earlier stage to revisit. Resolve any pending proposal with /project next first.",
          "请选择更早的阶段回访。如有待确认方案，请先使用 /project next 处理。",
          "前の段階を選んでください。承認待ちの提案があれば先に /project next で処理してください。",
        ),
      )
      return state
    }
    const options =
      state.status === "working"
        ? [
            t("Interrupt and preserve changes", "中断并保留改动", "中断して変更を保持"),
            t("Wait until this batch finishes", "等本批结束后再回访", "このバッチの終了まで待つ"),
          ]
        : [
            t("Revisit and preserve history", "回访并保留历史", "履歴を保持して再検討"),
            t("Keep current stage", "保持当前阶段", "現在の段階を保持"),
          ]
    const selected = await ask(
      t(
        `Revisit ${stageName(target, language)}?`,
        `回访${stageName(target, language)}？`,
        `${stageName(target, language)}を再検討しますか？`,
      ),
      options,
    )
    if (!selected || !options.includes(selected)) return state
    if (state.status !== "working" && selected === options[1]) return state
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)
    let changes = attempt?.changes ?? []
    if (selected === options[0]) {
      await quiesce()
      checkOrigin()
      const worktreeRef = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
      if (worktreeRef && state.stage === "implement") {
        const worktree = await store.readArtifact(worktreeRef)
        if (worktree.kind === "iteration-worktree") changes = [...new Set([...changes, worktree.root])]
      }
    }
    state = await store.dispatch(state.revision, {
      type: "request-revisit",
      expectedRevision: state.revision,
      target,
      policy: selected === options[0] ? "interrupt" : "boundary",
      ...(attempt ? { attemptId: attempt.id } : {}),
      changes,
      receipt: receipt(state, attempt?.id ?? `revisit:${state.stage}`, target, selected),
    })
    if (selected === options[1]) {
      ctx.print(stageStatus(state, language))
      return state
    }
  } else if (args.length)
    throw new ProjectCommandError(t("Use /project next", "用法：/project next", "使用方法：/project next"))

  if (state.stage === "design" && state.status === "working" && state.activeAttemptId) {
    if (
      !(await confirm(
        t(
          "Recover unfinished design bookkeeping?",
          "恢复未完成的设计状态？",
          "未完了の設計状態を復元しますか？",
        ),
        t(
          "Stop and preserve the existing attempt. Reopening alone never replays work.",
          "停止并保留已有工作记录。仅重新打开不会重放工作。",
          "既存の作業記録を停止して保持します。開き直すだけでは作業を再実行しません。",
        ),
      ))
    )
      return state
    await quiesce()
    checkOrigin()
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)!
    state = await store.dispatch(state.revision, {
      type: "interrupt-work",
      expectedRevision: state.revision,
      attemptId: attempt.id,
      changes: attempt.changes,
    })
  }
  if (
    (state.status === "interrupted" || state.status === "blocked") &&
    !state.revisit &&
    !hasManualProblem(state)
  ) {
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)!
    if (
      !(await confirm(
        t("Confirm continuation", "确认继续", "続行を確認"),
        t(
          "Keep the interrupted attempt and prepare a fresh continuation. No executor will start.",
          "保留中断记录并准备一次新的继续操作。不会启动执行器。",
          "中断した記録を保持して新しく続行を準備します。実行処理は開始しません。",
        ),
      ))
    )
      return state
    state = await store.dispatch(state.revision, {
      type: "confirm-continuation",
      expectedRevision: state.revision,
      receipt: receipt(
        state,
        attempt.id,
        "resume",
        t("Confirmed continuation", "已确认继续", "続行を確認"),
        attempt.context,
      ),
    })
  }
  const recordManualTrial = async () => {
    const review = state.attempts.find((attempt) => attempt.id === state.activeAttemptId)
    if (!review?.review || review.stage !== "accept" || !["working", "finished"].includes(review.status))
      return state
    const ref = state.artifacts.find((a) => a.id === state.manualTrial!.artifactId)!
    const prior = await store.readArtifact(ref)
    if (prior.kind !== "manual-trial")
      throw new ProjectCommandError(
        t(
          "Manual trial artifact is missing",
          "手动试用产物缺失。请保留已有证据并检查当前迭代文件。",
          "手動試用の成果物が見つかりません。既存の証拠を保持し、現在のイテレーションのファイルを確認してください。",
        ),
      )
    if (
      prior.attemptId !== review.id ||
      prior.attempt !== review.review.attempt ||
      prior.codeHash !== review.review.codeHash ||
      prior.specHash !== review.context?.spec?.hash ||
      prior.specRevision !== review.context?.spec?.revision ||
      prior.batchId !== review.context?.batchId ||
      prior.batchPlan.artifactId !== review.context?.batchPlan?.artifactId ||
      prior.batchPlan.hash !== review.context?.batchPlan?.hash
    ) {
      ctx.print(
        t(
          "This trial belongs to an earlier review and remains history. Prepare a prompt for the current review instead.",
          "此试用属于之前的验收，已保留为历史。请为当前验收准备新的试用提示。",
          "この試用は以前の確認に属する履歴です。現在の確認用に新しい試用手順を準備してください。",
        ),
      )
      return state
    }
    ctx.print(`${prior.instructions}\n${prior.observe.join("\n")}`)
    const choices = [
      t("Record tried", "记录已试用", "試用済みとして記録"),
      t("Record a problem", "记录发现问题", "問題を記録"),
      t("Explicitly defer trial", "明确推迟试用", "試用を明示的に延期"),
    ]
    const selected = await ask(t("Record manual UI trial", "记录手动界面试用", "手動 UI 試用を記録"), choices)
    const index = selected ? choices.indexOf(selected) : -1
    if (index < 0) return state
    const status = (["tried", "problem", "deferred"] as const)[index]!
    const saved = await store.saveArtifact(state.revision, { ...prior, status, result: selected! })
    state = saved.state
    if (
      !(await confirm(
        t("Confirm manual trial record", "确认手动试用记录", "手動試用の記録を確認"),
        selected!,
      ))
    )
      return state
    state = await store.dispatch(state.revision, {
      type: "record-manual-trial",
      expectedRevision: state.revision,
      status,
      artifact: saved.artifact,
      receipt: receipt(state, saved.artifact.id, status, selected!),
    })
    ctx.print(`${stageStatus(state, language)}\n${nextSuggestion(state, language)}`)
    return state
  }
  if (state.revisit && ["ready", "confirmed", "finished", "summarized", "complete"].includes(state.phase)) {
    if (state.phase !== "summarized")
      await summary({
        kind: "stage-summary",
        stage: state.stage,
        language,
        summary: t(
          "Revisit requested. Existing attempt and change pointers are preserved; no repository reset was performed.",
          "已请求回访。保留已有工作和改动指针，未重置仓库。",
          "再検討を要求しました。作業と変更参照を保持し、リポジトリはリセットしていません。",
        ),
        outputs: state.attempts.find((a) => a.id === state.revisit?.attemptId)?.changes ?? [],
        suggestion: t(
          "Return to the earlier stage; new decisions require a linked correction record before implementation.",
          "返回前序阶段；实现前需要将新决策关联到修正记录。",
          "前の段階に戻ります。実装前に新しい決定を修正記録に関連付けてください。",
        ),
      })
    await propose({
      id: randomUUID(),
      from: state.stage,
      to: state.revisit!.target,
      kind: "revisit",
      summaryId: state.summaryId!,
      suggestion: t(
        `Return to ${stageName(state.revisit!.target, language)}; preserve changes`,
        `返回${stageName(state.revisit!.target, language)}，保留改动`,
        `${stageName(state.revisit!.target, language)}に戻り変更を保持`,
      ),
      skippedStages: [],
    })
    await showSummary()
    await approve()
    return state
  }
  if (state.pending) {
    await showSummary()
    const actions = {
      confirm: t("Confirm proposed next step", "确认建议的下一步", "提案された次の手順を確認"),
      alternative: t("Choose an alternative", "选择其他方案", "別の案を選ぶ"),
      skip: t("Skip current stage", "跳过当前阶段", "現在の段階をスキップ"),
      continue: t("Continue current stage", "继续当前阶段", "現在の段階を続ける"),
      generate: t("Generate implementation spec", "生成实现规格", "実装仕様を生成"),
    }
    const canGenerate = !!generateSpec && ["design", "prototype"].includes(state.stage)
    const choices = [actions.confirm, actions.alternative, actions.skip, actions.continue]
    if (canGenerate) choices.push(actions.generate)
    const selected = await ask(t("Choose the next step", "选择下一步", "次の手順を選ぶ"), choices)
    if (selected === undefined || !choices.includes(selected)) return state
    if (generateSpec && canGenerate && selected === actions.generate) {
      state = await store.dispatch(state.revision, {
        type: "cancel-transition",
        expectedRevision: state.revision,
      })
      await generateSpec()
      return store.read()
    }
    if (selected === actions.confirm) await approve()
    else if (selected === actions.skip) await skip(state.stage)
    else if (selected === actions.continue) {
      checkOrigin()
      state = await store.dispatch(
        state.revision,
        state.revisit
          ? {
              type: "cancel-revisit",
              expectedRevision: state.revision,
              receipt: receipt(
                state,
                state.revisit.receiptId,
                "cancel-revisit",
                t(
                  "Continue current stage; cancel the revisit request",
                  "继续当前阶段；取消回访请求",
                  "現在の段階を続け、再検討の要求を取り消す",
                ),
              ),
            }
          : state.stage === "prototype" && state.pending?.kind === "skip"
            ? {
                type: "reopen-prototype",
                expectedRevision: state.revision,
                proposalId: state.pending.id,
              }
            : {
                type: "cancel-transition",
                expectedRevision: state.revision,
              },
      )
      if (state.stage === "design")
        state = await store.dispatch(state.revision, {
          type: "reopen-design",
          expectedRevision: state.revision,
        })
      ctx.print(nextSuggestion(state, language))
    } else if (selected === actions.alternative) {
      const base = reduceStage(state, { type: "cancel-transition", expectedRevision: state.revision })
      const proposals = stages
        .filter((s) => stages.indexOf(s) > stages.indexOf(base.stage))
        .flatMap((to) => {
          const proposal: TransitionProposal = {
            ...state.pending!,
            id: randomUUID(),
            to,
            skippedStages: stages.slice(stages.indexOf(base.stage) + 1, stages.indexOf(to)),
            suggestion: t(
              `Continue to ${stageName(to, language)}`,
              `继续进入${stageName(to, language)}`,
              `${stageName(to, language)}に進む`,
            ),
          }
          try {
            reduceStage(base, { type: "propose-transition", expectedRevision: base.revision, proposal })
            return [proposal]
          } catch {
            return []
          }
        })
      const option = await ask(
        t(
          "Choose an alternative (unavailable stages need approved artifacts)",
          "选择其他方案（后续阶段需要已审批的产物）",
          "別の案を選ぶ（後続段階には承認済み成果物が必要）",
        ),
        proposals.map((p) => p.suggestion),
      )
      const proposal = proposals.find((p) => p.suggestion === option)
      if (proposal) {
        state = await store.dispatch(state.revision, {
          type: "cancel-transition",
          expectedRevision: state.revision,
        })
        await propose(proposal)
        await approve()
      } else ctx.print(executionUnavailable(language))
    }
    return state
  }
  // Pending transitions/revisits take precedence; interrupted trials are immutable history,
  // not a dialog that can prevent the human from changing or continuing stages.
  const currentReview = state.attempts.find((attempt) => attempt.id === state.activeAttemptId)
  if (
    !state.revisit &&
    state.stage === "accept" &&
    state.manualTrial &&
    state.manualTrial.status === "pending" &&
    ["running", "finished", "summarized"].includes(state.phase) &&
    currentReview?.stage === "accept" &&
    ["working", "finished"].includes(currentReview.status)
  )
    return recordManualTrial()
  const manualRepair = hasManualProblem(state)
  if (manualRepair && currentReview?.status === "working") {
    ctx.print(`${stageStatus(state, language)}\n${nextSuggestion(state, language)}`)
    return state
  }
  let problemSummaryReady = false
  if (manualRepair && state.phase === "summarized" && state.summaryId) {
    const ref = state.artifacts.find((artifact) => artifact.id === state.summaryId)!
    const saved = await store.readArtifact(ref)
    problemSummaryReady =
      saved.kind === "stage-summary" && saved.outputs.includes(state.manualTrial!.artifactId)
  }
  if (manualRepair && ["finished", "summarized"].includes(state.phase) && !problemSummaryReady)
    await summary({
      kind: "stage-summary",
      stage: "accept",
      language,
      outputs: [
        ...(currentReview?.acceptance ? [currentReview.acceptance.artifactId] : []),
        state.manualTrial!.artifactId,
        ...(state.manualTrial!.receiptId ? [state.manualTrial!.receiptId] : []),
      ],
      summary: t(
        "The human UI trial found a problem. The automated verdict and trial evidence remain unchanged.",
        "手动界面试用发现问题。保留原自动验收结果和试用证据。",
        "手動 UI 試用で問題が見つかりました。自動判定と試用の証拠をそのまま保持します。",
      ),
      suggestion: t(
        "Review repair approval for the same pinned spec, plan and batch; no work starts automatically.",
        "确认同一固定规格、计划和批次的修复审批；不会自动开始工作。",
        "同じ固定仕様・計画・バッチの修正承認を確認します。作業は自動開始しません。",
      ),
    })
  if (state.stage === "design" && ["ready", "confirmed", "finished", "summarized"].includes(state.phase)) {
    const design = await readDocument(project, "design.md")
    const decisions = await new DecisionStore(project).records()
    if (!design.trim() && !decisions.length) {
      ctx.print(
        t(
          "No design summary is ready. Continue /project design, or explicitly skip design.",
          "尚无可用的设计总结。请继续 /project design，或明确跳过设计。",
          "設計の要約はまだありません。/project design を続けるか、明示的に設計をスキップしてください。",
        ),
      )
      const choices = [
        t("Continue design", "继续设计", "設計を続ける"),
        t("Skip design", "跳过设计", "設計をスキップ"),
      ]
      if ((await ask(t("Choose the next step", "选择下一步", "次の手順を選ぶ"), choices)) === choices[1])
        await skip("design")
      return state
    }
    if (
      !(await confirm(
        t("Prepare the design summary?", "准备设计总结？", "設計の要約を準備しますか？"),
        t(
          "Use saved design and confirmed decisions. This does not approve the next stage.",
          "使用已保存的设计和已确认的决策。这不会批准进入下一阶段。",
          "保存済みの設計と確認済みの決定を使います。次の段階は承認しません。",
        ),
      ))
    )
      return state
    await quiesce()
    checkOrigin()
    if (state.phase === "ready" || state.phase === "confirmed") {
      const attemptId = randomUUID()
      state = await store.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId,
      })
      state = await store.dispatch(state.revision, {
        type: "finish-work",
        expectedRevision: state.revision,
        attemptId,
        changes: [],
      })
    }
    if (state.phase === "finished")
      await summary({
        kind: "stage-summary",
        stage: "design",
        language,
        summary: t(
          `Saved design (document text is reference, not approval):\n${design}\nConfirmed decisions: ${decisions.map((d) => d.id).join(", ") || "none"}`,
          `已保存的设计（文档仅供参考，不代表批准）：\n${design}\n已确认决策：${decisions.map((d) => d.id).join("、") || "无"}`,
          `保存済みの設計（文書は参考情報であり承認ではありません）：\n${design}\n確認済みの決定：${decisions.map((d) => d.id).join("、") || "なし"}`,
        ),
        outputs: decisions.map((d) => d.id),
        suggestion: t(
          "Continue to prototype; use /project prototype to review variants after confirmation.",
          "继续进入原型阶段；确认后使用 /project prototype 查看变体。",
          "プロトタイプに進みます。確認後 /project prototype で案を確認してください。",
        ),
      })
    await propose({
      id: randomUUID(),
      from: "design",
      to: "prototype",
      kind: "advance",
      summaryId: state.summaryId!,
      suggestion: t("Continue to prototype", "继续进入原型阶段", "プロトタイプに進む"),
      skippedStages: [],
    })
    await showSummary()
    // Persist the proposal first, then offer confirmation / alternative / skip on this same command.
    return runStageCommand("next", [], project, ctx, language, checkOrigin, quiesce, changed, generateSpec)
  }
  if (state.phase === "summarized" && state.summaryId && state.stage !== "design") {
    const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)
    const repair = state.stage === "accept" && (attempt?.acceptance?.verdict === "fail" || manualRepair)
    const nextBatch =
      !repair && state.stage === "accept" && attempt?.acceptance?.verdict === "pass"
        ? batchProgress(state).remaining.find((id) => id !== state.approvedContext?.batchId)
        : undefined
    const context =
      state.stage !== "prototype" && state.approvedContext
        ? { ...state.approvedContext, ...(nextBatch ? { batchId: nextBatch } : {}) }
        : undefined
    if (nextBatch && context) delete context.changes
    if (state.stage === "implement" && context) context.changes = attempt?.changes ?? []
    const to = repair || nextBatch ? "implement" : (stages[stages.indexOf(state.stage) + 1] ?? null)
    const proposal: TransitionProposal = {
      id: randomUUID(),
      from: state.stage,
      to,
      kind: repair ? "repair" : nextBatch ? "next-batch" : to === null ? "complete" : "advance",
      summaryId: state.summaryId,
      ...(state.stage === "prototype" && !context ? { preparationOnly: true as const } : {}),
      suggestion: nextBatch
        ? t(
            `Batch ${state.approvedContext?.batchId} passed; prepare ${nextBatch} for fresh implementation approval`,
            `批次 ${state.approvedContext?.batchId} 已通过；准备 ${nextBatch} 的新实现审批`,
            `バッチ ${state.approvedContext?.batchId} は合格。${nextBatch} の新しい実装承認を準備`,
          )
        : repair
          ? manualRepair
            ? t(
                "Return to implementation to repair the human-reported UI problem in this same pinned batch",
                "返回实现阶段，修复同一固定批次中人工报告的界面问题",
                "同じ固定バッチの人が報告した UI の問題を修正するため実装に戻る",
              )
            : t(
                `Return to implementation for failing items: ${attempt!.acceptance!.failingItemIds.join(", ")}`,
                `返回实现阶段修复未通过条目：${attempt!.acceptance!.failingItemIds.join("、")}`,
                `不合格の項目を修正するため実装に戻る：${attempt!.acceptance!.failingItemIds.join("、")}`,
              )
          : to
            ? t(
                `Continue to ${stageName(to, language)}`,
                `继续进入${stageName(to, language)}`,
                `${stageName(to, language)}に進む`,
              )
            : t(
                "Complete acceptance bookkeeping; do not ship",
                "完成验收记录，不会发布",
                "受け入れ確認の記録を完了（リリースしません）",
              ),
      skippedStages: [],
      ...(context ? { context } : {}),
    }
    try {
      reduceStage(state, { type: "propose-transition", expectedRevision: state.revision, proposal })
    } catch {
      await showSummary()
      ctx.print(`${stageStatus(state, language)}\n${executionUnavailable(language)}`)
      return state
    }
    await propose(proposal)
    return runStageCommand("next", [], project, ctx, language, checkOrigin, quiesce, changed, generateSpec)
  }
  const suggestion = nextSuggestion(state, language)
  const unavailable = executionUnavailable(language)
  ctx.print(
    `${stageStatus(state, language)}\n${suggestion}${suggestion === unavailable ? "" : `\n${unavailable}`}`,
  )
  return state
}
