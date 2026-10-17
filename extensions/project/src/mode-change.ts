import { randomUUID } from "node:crypto"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import type { BatchPlanArtifact, SpecArtifact } from "./artifacts.ts"
import { discoverModes } from "./execution-modes.ts"
import { localize } from "./language.ts"
import { renderSpec } from "./spec.ts"
import { type ApprovalContext, type ArtifactRef, batchProgress, type IterationState } from "./stage.ts"
import { IterationStore, type Project } from "./store.ts"

type Source = ApprovalContext &
  Required<Pick<ApprovalContext, "spec" | "batchPlan" | "batchId" | "mode" | "model">>
const isSource = (source: ApprovalContext | undefined): source is Source =>
  !!(source?.spec && source.batchPlan && source.batchId && source.mode && source.model)
const contextKey = (context?: ApprovalContext) =>
  JSON.stringify([
    context?.spec?.artifactId,
    context?.spec?.revision,
    context?.spec?.hash,
    context?.batchPlan?.artifactId,
    context?.batchPlan?.hash,
    context?.batchId,
    context?.mode,
    context?.model,
    context?.changes,
  ])

async function reviewModePlan(
  store: IterationStore,
  state: IterationState,
  specRef: ArtifactRef,
  spec: SpecArtifact,
  planRef: ArtifactRef,
  plan: BatchPlanArtifact,
  source: Source,
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
): Promise<IterationState> {
  const t = (en: string, zh: string, ja: string) => localize(language, en, zh, ja)
  const context = { ...source, mode: plan.mode, batchPlan: { artifactId: planRef.id, hash: planRef.hash } }
  const progress = batchProgress(state, source)
  const description = `Change mode ${source.mode} → ${plan.mode}; keep spec r${spec.revision} (${source.spec.hash}), selected batch ${source.batchId}, model ${source.model} and the existing iteration worktree. Schedule only ${plan.batches.map((batch) => batch.id).join(", ")}. Retain original resolved evidence: ${progress.resolutions.map((resolution) => `${resolution.batchId}: ${resolution.status} (receipt ${resolution.receiptId})`).join("; ") || "None"}. New plan: ${planRef.hash}.`
  ctx.print(renderSpec(spec, plan), "info", { markdown: true, persist: true })
  if (state.pending) {
    if (state.pending.kind !== "reapprove" || contextKey(state.pending.context) !== contextKey(context))
      throw new Error("Another proposal needs review; this mode draft cannot replace it.")
  } else {
    const summary = await store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "implement",
      language,
      summary: description,
      outputs: [specRef.id, planRef.id],
      suggestion: "Review and approve this mode-only replacement. No execution starts automatically.",
    })
    state = await store.dispatch(summary.state.revision, {
      type: "prepare-summary",
      expectedRevision: summary.state.revision,
      artifact: summary.artifact,
    })
    state = await store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: randomUUID(),
        from: "implement",
        to: "implement",
        kind: "reapprove",
        summaryId: summary.artifact.id,
        skippedStages: [],
        context,
        suggestion: description,
      },
    })
  }
  ctx.print(description, "info", { persist: true })
  checkOrigin()
  const approved = await ctx.ui.confirm(
    t("Approve execution mode change", "批准执行模式变更", "実行モードの変更を承認"),
    description,
    { signal: ctx.signal, sessionId: ctx.session.info().id },
  )
  checkOrigin()
  // Escape preserves the exact draft/proposal, never a launch authorization.
  if (approved !== true) return state
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: {
      id: randomUUID(),
      provenance: "human",
      projectId: state.projectId,
      iteration: state.iteration,
      revision: state.revision,
      subjectId: state.pending!.id,
      choice: "implement",
      context,
      reason: "Approved the exact mode-only plan replacement with original completed-batch evidence retained",
    },
  })
  ctx.print(
    t(
      "Execution mode approved. /project implement starts the selected unresolved batch separately.",
      "执行模式已批准。用 /project implement 单独开始所选的未解决批次。",
      "実行モードを承認しました。/project implement で選択した未解決バッチを別途開始します。",
    ),
  )
  return state
}

/** Change orchestration, not requirements, batch identity, worktree or completed evidence. */
export async function runModeChange(
  api: ExtensionAPI,
  project: Project,
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
  quiesce: () => Promise<void>,
): Promise<IterationState> {
  const store = new IterationStore(project)
  const state = await store.read()
  checkOrigin()
  if (
    state.stage !== "implement" ||
    state.revisit ||
    state.activeAttemptId ||
    !["idle", "awaiting-confirmation"].includes(state.status)
  )
    throw new Error(
      "Change mode only for the current idle approved batch. If interrupted, review continuation with /project next first.",
    )
  let candidate = state.approvedContext
  let draft: { ref: ArtifactRef; plan: BatchPlanArtifact } | undefined
  if (!candidate) {
    // Publication retires the old permission before asking. A cancelled proposal,
    // stale writer or interrupted publication must not force spec regeneration.
    const ref = state.artifacts.findLast((entry) => entry.kind === "batch-plan")
    const plan = ref && (await store.readArtifact(ref))
    if (
      ref &&
      plan?.kind === "batch-plan" &&
      plan.modeChange &&
      ["ready", "summarized", "proposed"].includes(state.phase)
    ) {
      candidate = state.receipts.find((receipt) => receipt.id === plan.modeChange!.sourceApprovalId)?.context
      draft = { ref, plan }
    }
  }
  if (!isSource(candidate) || (!draft && (state.phase !== "confirmed" || state.pending)))
    throw new Error(
      "Change mode only for the current idle approved batch. If interrupted, review continuation with /project next first.",
    )
  const source = candidate
  const specRef = state.artifacts.find((ref) => ref.id === source.spec.artifactId)!
  if (!specRef || state.artifacts.findLast((ref) => ref.kind === "spec")?.id !== specRef.id)
    throw new Error("A newer spec needs review; mode change cannot adopt different requirements.")
  const spec = await store.readArtifact(specRef)
  if (spec.kind !== "spec") throw new Error("Missing approved spec")
  await store.assertCurrentSpecDecisions(spec)
  if (draft) {
    await quiesce()
    checkOrigin()
    return reviewModePlan(
      store,
      state,
      specRef,
      spec,
      draft.ref,
      draft.plan,
      source,
      ctx,
      language,
      checkOrigin,
    )
  }
  const planRef = state.artifacts.find((ref) => ref.id === source.batchPlan.artifactId)!
  const previous = await store.readArtifact(planRef)
  if (previous.kind !== "batch-plan") throw new Error("Missing approved plan")
  const progress = batchProgress(state)
  if (!progress.remaining.includes(source.batchId)) throw new Error("The selected batch is already resolved")
  const sourceApproval = state.receipts.findLast(
    (receipt) =>
      ["implement", "resume"].includes(receipt.choice) && contextKey(receipt.context) === contextKey(source),
  )
  if (!sourceApproval) throw new Error("Missing original human implementation approval for this mode change")
  const t = (en: string, zh: string, ja: string) => localize(language, en, zh, ja)
  const modes = discoverModes(api).filter((mode) => mode !== source.mode)
  if (!modes.length) {
    ctx.print(
      t(
        "No other compatible execution mode is available. No plan was changed.",
        "没有其他兼容的执行模式。计划未改变。",
        "他の対応する実行モードはありません。計画は変更していません。",
      ),
      "warning",
    )
    return state
  }
  const labels: string[] = modes.map((mode) =>
    mode === "single"
      ? t("Single agent", "单代理", "単一エージェント")
      : mode === "workflow"
        ? "Workflow"
        : "Swarm",
  )
  checkOrigin()
  const selected = await ctx.ui.select(
    t("Change execution mode", "更改执行模式", "実行モードを変更"),
    labels,
    { signal: ctx.signal, sessionId: ctx.session.info().id },
  )
  checkOrigin()
  const index = labels.indexOf(selected ?? "")
  if (index < 0) return state
  await quiesce()
  checkOrigin()
  const plan: BatchPlanArtifact = {
    ...previous,
    mode: modes[index]!,
    batches: previous.batches.filter((batch) => progress.remaining.includes(batch.id)),
    modeChange: {
      previousPlan: source.batchPlan,
      sourceApprovalId: sourceApproval.id,
      batchId: source.batchId,
      carriedResolutions: progress.resolutions.map(({ batchId, receiptId }) => ({ batchId, receiptId })),
    },
  }
  const saved = await store.saveArtifact(state.revision, plan)
  return reviewModePlan(
    store,
    saved.state,
    specRef,
    spec,
    saved.artifact,
    plan,
    source,
    ctx,
    language,
    checkOrigin,
  )
}
