import { randomUUID } from "node:crypto"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import { localize } from "./language.ts"
import { prototypeAvailability } from "./project-cleanup.ts"
import {
  ProjectLifecycleController,
  type ProjectLifecycleOperation,
  readContinuationState,
} from "./project-lifecycle.ts"
import { prototypeComparison } from "./prototype.ts"
import { stageStatus } from "./stage-commands.ts"
import {
  HistoricalIterationReader,
  LifecycleStore,
  type Project,
  projectLifecycle,
  readProject,
} from "./store.ts"

const usage =
  "Use /project iteration [<number>|close|new|continue|recover|cleanup] or /project archive or /project restore."
function operationText(operation: ProjectLifecycleOperation): string {
  return `${operation.action}: ${operation.status} · iteration ${operation.iteration} · receipt ${operation.receipt.id}\n${operation.owners.map((owner) => `${owner.role}: ${owner.status} — ${owner.key}${owner.error ? `: ${owner.error}` : ""}`).join("\n")}${operation.errors.length ? `\n${operation.errors.join("\n")}` : ""}`
}

/** No tool/model/runtime work in inspection. Every administrative effect gets a new confirmation. */
export async function runLifecycleCommand(
  api: ExtensionAPI,
  project: Project,
  verb: "iteration" | "archive" | "restore",
  args: string[],
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
  quiesce?: () => Promise<void>,
): Promise<void> {
  const controller = new ProjectLifecycleController(api, project, { quiesce })
  const lifecycle = projectLifecycle(project)
  const current = lifecycle.iterations[project.marker.currentIteration]!
  const action = verb === "iteration" ? (args[0] ?? "status") : verb
  if (args.length > (verb === "iteration" ? 1 : 0)) throw new Error(usage)
  if (action === "status") {
    ctx.print(
      localize(
        language,
        `Project: ${lifecycle.status} · iteration ${project.marker.currentIteration}: ${current.status} · ship: ${current.ship}`,
        `项目：${lifecycle.status} · 迭代 ${project.marker.currentIteration}：${current.status} · 发布：${current.ship}`,
        `プロジェクト：${lifecycle.status} · イテレーション ${project.marker.currentIteration}：${current.status} · リリース：${current.ship}`,
      ),
    )
    if (lifecycle.status === "active" && current.continuationRequired)
      ctx.print(
        localize(
          language,
          "Read-only until fresh continuation approval: /project iteration continue",
          "只读，需重新批准继续：/project iteration continue",
          "継続の再承認まで読み取り専用：/project iteration continue",
        ),
      )
    for (const operation of await controller.read())
      ctx.print(operationText(operation), operation.status === "failed" ? "warning" : "info")
    return
  }
  if (/^[1-9][0-9]*$/.test(action)) {
    const iteration = Number(action)
    const reader = new HistoricalIterationReader(project, iteration)
    const state = await reader.read()
    ctx.print(
      `${project.marker.name} · iteration ${iteration}\n${stageStatus(state, language)}\n${state.artifacts.map((ref) => `${ref.kind}: ${ref.id}`).join("\n")}`,
    )
    const ref = state.artifacts.findLast((entry) => entry.kind === "prototype-manifest")
    if (ref) {
      const manifest = await reader.readArtifact(ref)
      if (manifest.kind === "prototype-manifest")
        ctx.print(
          await prototypeComparison(
            manifest,
            language,
            await prototypeAvailability(project, iteration, manifest),
          ),
        )
    }
    return
  }
  if (!["close", "new", "archive", "restore", "continue", "recover"].includes(action)) throw new Error(usage)
  // Refuse invalid closure/advancement before asking a misleading confirmation.
  if (action === "close" && !["shipped", "skipped"].includes(current.ship))
    throw new Error("Close requires shipped or explicitly ship-skipped evidence. Review /project ship first.")
  if (action === "new" && (lifecycle.status !== "active" || current.status !== "closed"))
    throw new Error("Restore the project and close its current iteration before starting another.")
  if (action === "continue" && (current.status !== "open" || lifecycle.status !== "active"))
    throw new Error("Only a restored open iteration needs explicit continuation.")
  const reviewedState =
    action === "continue" || action === "close" ? await readContinuationState(project) : undefined
  const prompts: Record<string, [string, string, string]> = {
    close: ["Close iteration", "关闭迭代", "イテレーションを終了"],
    new: ["Start next iteration", "开始下一轮迭代", "次のイテレーションを開始"],
    archive: ["Archive project", "归档项目", "プロジェクトをアーカイブ"],
    restore: ["Restore project", "恢复项目", "プロジェクトを復元"],
    continue: ["Approve iteration continuation", "批准继续迭代", "イテレーションの継続を承認"],
    recover: ["Recover lifecycle publication", "恢复生命周期记录", "ライフサイクル記録を復旧"],
  }
  const detail =
    action === "archive"
      ? localize(
          language,
          "End this project? Stop all project work and archive all owned histories. The project becomes read-only and hidden by default. Retain worktrees, branches, prototypes, design and decisions; cleanup needs separate confirmation.",
          "结束此项目？停止全部项目工作并归档所有专属会话。项目将只读并默认隐藏。保留工作树、分支、原型、设计和决策；清理需要另行确认。",
          "このプロジェクトを終了しますか？全作業を停止し、すべての専用履歴をアーカイブします。読み取り専用となり通常の一覧から非表示になります。作業ツリー・ブランチ・試作・設計・決定は保持し、削除には別の確認が必要です。",
        )
      : action === "close"
        ? localize(
            language,
            `Close iteration ${project.marker.currentIteration} (${current.ship})? Drain and archive its conversations. Keep all artifacts and resources. The project remains active; no next iteration starts automatically.`,
            `关闭迭代 ${project.marker.currentIteration}（${current.ship}）？停止并归档本轮会话，保留所有产物和资源。项目保持活跃，不会自动开始下一轮。`,
            `イテレーション ${project.marker.currentIteration}（${current.ship}）を終了しますか？専用会話を停止・アーカイブし、成果物とリソースは保持します。プロジェクトは継続しますが、次回は自動開始しません。`,
          )
        : action === "new"
          ? localize(
              language,
              "Initialize a fresh next iteration from project design and decisions? Retain old history. Do not open conversations, create a worktree or start work.",
              "基于项目设计和决策初始化下一轮？保留旧历史，不打开会话、不创建工作树、不启动工作。",
              "設計と決定を引き継いで次回を初期化しますか？以前の履歴を保持し、会話・作業ツリー・作業は開始しません。",
            )
          : action === "restore"
            ? localize(
                language,
                "Restore project metadata only? No conversation, question, provider or worker resumes. Closed iterations stay historical. An open iteration remains read-only until you review /project iteration continue; interrupted work then needs normal fresh stage approval.",
                "仅恢复项目元数据？不会恢复会话、问题、执行服务或工作进程。已关闭的迭代仍为历史；开放的迭代保持只读，需用 /project iteration continue 审阅，之后仍需正常阶段审批。",
                "プロジェクト情報だけを復元しますか？会話・質問・実行サービス・ワーカーは再開しません。終了済みの回は履歴のままです。継続は /project iteration continue で確認し、その後に通常の段階承認を行ってください。",
              )
            : action === "continue"
              ? localize(
                  language,
                  "Approve a fresh continuation of these exact saved stage inputs? Reopen ordinary project editing; only eligible design/prototype conversations may be unarchived. Old workers stay archived. No turn or execution starts; unfinished work still needs normal stage approval.",
                  "批准基于下列精确阶段输入继续迭代？重新允许编辑项目，仅可能解档符合条件的设计或原型会话。旧工作会话仍归档，不启动模型请求或执行；未完成的工作仍需正常阶段审批。",
                  "以下の段階入力に対する新しい継続を承認しますか？通常の編集を再許可し、対象の設計・試作会話だけを復元できます。以前のワーカーはアーカイブのままで、実行は開始せず、未完了の作業には段階の承認が必要です。",
                )
              : localize(
                  language,
                  "Finish an interrupted local lifecycle publication only? No host operation, tool, provider or model is replayed. Inspect the result before explicitly retrying archive or close.",
                  "仅完成中断的本地生命周期写入？不会重放宿主操作、工具、执行服务或模型请求。请检查结果后再明确重试归档或关闭。",
                  "中断したローカル記録の公開だけを完了しますか？ホスト操作・ツール・実行サービス・モデルは再実行しません。結果を確認し、アーカイブや終了は明示的に再試行してください。",
                )
  const title = prompts[action]!
  checkOrigin()
  if (
    !(await ctx.ui.confirm(
      localize(language, ...title),
      `${project.marker.name}\n${project.root}\n\n${detail}${reviewedState ? `\n\n${stageStatus(reviewedState, language)}\nStage revision: ${reviewedState.revision}\nExact saved context:\n${JSON.stringify(reviewedState.approvedContext ?? null, null, 2)}` : ""}`,
      { signal: ctx.signal, sessionId: ctx.session.info().id },
    ))
  )
    return
  checkOrigin()
  const observed = await readProject(project.root, project.marker.id)
  if (
    observed.marker.currentIteration !== project.marker.currentIteration ||
    projectLifecycle(observed).revision !== lifecycle.revision
  )
    throw new Error("Project lifecycle changed during confirmation. Review it and confirm again.")
  checkOrigin()
  const receipt = { id: randomUUID(), sessionId: ctx.session.info().id, date: new Date().toISOString() }
  if (action === "archive" || action === "close") {
    const previous = (await controller.read()).at(-1)
    checkOrigin()
    const retry =
      lifecycle.status === "archive-pending" ||
      current.status === "close-pending" ||
      (!!previous && previous.action === action && previous.status !== "completed")
    const result =
      action === "archive"
        ? await controller.archive(lifecycle.revision, receipt, { retry })
        : await controller.close(lifecycle.revision, receipt, {
            retry,
            stageRevision: reviewedState!.revision,
          })
    ctx.print(operationText(result.operation), result.operation.status === "failed" ? "warning" : "info", {
      persist: true,
    })
    if (result.operation.status === "failed")
      ctx.print(
        "Work remains fenced. Inspect /project iteration, then explicitly retry the same archive or close command. No resources were deleted.",
        "warning",
      )
  } else if (action === "restore") {
    await controller.restore(lifecycle.revision, receipt)
    ctx.print(
      localize(
        language,
        "Project restored. No work resumed. Use /project iteration new after closed work, or /project iteration continue to review an open interrupted iteration.",
        "项目已恢复，未恢复执行。已关闭的工作请用 /project iteration new；开放的迭代请用 /project iteration continue 审阅。",
        "プロジェクトを復元しました。作業は再開していません。終了済みなら /project iteration new、中断した回は /project iteration continue で確認してください。",
      ),
    )
  } else if (action === "new") {
    const next = await controller.nextIteration(lifecycle.revision, receipt)
    ctx.print(
      localize(
        language,
        `Iteration ${next.marker.currentIteration} initialized. No work started.`,
        `迭代 ${next.marker.currentIteration} 已初始化，未启动工作。`,
        `イテレーション ${next.marker.currentIteration} を初期化しました。作業は開始していません。`,
      ),
    )
  } else if (action === "continue") {
    await controller.continueConversation(lifecycle.revision, receipt, {
      retry: true,
      stageRevision: reviewedState!.revision,
    })
    const approved = (await controller.read()).some(
      (operation) => operation.action === "continue-conversation" && operation.receipt.id === receipt.id,
    )
    ctx.print(
      !approved
        ? localize(
            language,
            "Saved continuation result recovered. No work or host operation was replayed.",
            "继续迭代的结果记录已恢复，未重放工作或宿主操作。",
            "継続の結果記録を復旧しました。作業やホスト操作は再実行していません。",
          )
        : localize(
            language,
            "Fresh iteration continuation approved. No work started; old workers remain archived. Follow the current stage gates before starting a fresh attempt.",
            "已重新批准继续迭代，未启动工作，旧工作会话仍归档。启动新尝试前请按当前阶段审批。",
            "継続を改めて承認しました。作業は開始せず、以前のワーカーはアーカイブのままです。新しい試行には現在の段階承認が必要です。",
          ),
    )
  } else {
    await new LifecycleStore(project).recover()
    ctx.print(
      "Local lifecycle publication recovered. No work or host operation was replayed. Inspect /project iteration before retrying an unfinished operation.",
    )
  }
}
