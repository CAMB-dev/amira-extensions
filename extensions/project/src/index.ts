import path from "node:path"
import type { CommandContext, Extension, PanelRenderOptions, SessionData, ToolLine } from "@amira/api"
import { Acceptances, checkAcceptanceFreshness } from "./accept.ts"
import { type AcceptanceView, acceptancePanelText, acceptanceView } from "./accept-view.ts"
import { configureAccounting, disposeAccounting, projectAccounting } from "./accounting.ts"
import type { PrototypeManifestArtifact } from "./artifacts.ts"
import { type CostLedger, costText } from "./cost.ts"
import { FileCostPersistence } from "./cost-storage.ts"
import { DesignSessions } from "./design.ts"
import { ProjectCommandError, projectError } from "./diagnostics.ts"
import { Implementations, implementationStatus } from "./implement.ts"
import { conversationLanguage, LanguagePolicy, localize, resolveLanguage, validLanguage } from "./language.ts"
import { runModeChange } from "./mode-change.ts"
import { latestPrototypeManifest, Prototypes, prototypePanelText } from "./prototype.ts"
import { supportsPrototype } from "./prototype-sessions.ts"
import { shipSummary } from "./ship.ts"
import { runShip } from "./ship-command.ts"
import { ShipStore } from "./ship-storage.ts"
import { runSpec } from "./spec.ts"
import { type IterationState, initialIteration } from "./stage.ts"
import { runStageCommand, stageStatus } from "./stage-commands.ts"
import { nextSuggestion, stageName, statusName } from "./stage-view.ts"
import {
  assertProjectWritable,
  createProject,
  discoverProject,
  HistoricalIterationReader,
  IterationStore,
  type Project,
  Registry,
  readProject,
} from "./store.ts"

export const ATTACHMENT_KEY = "project.attachment.v1"
export interface Attachment {
  projectId: string
  root: string
  attachedAt: string
}

export function restoreAttachment(data?: SessionData): Attachment | undefined {
  const records = data?.read(ATTACHMENT_KEY) ?? []
  for (const value of records.toReversed()) {
    if (!value || typeof value !== "object") continue
    const record = value as Partial<Attachment>
    if (
      typeof record.projectId === "string" &&
      typeof record.root === "string" &&
      typeof record.attachedAt === "string"
    )
      return record as Attachment
  }
  return undefined
}

export function panelLines(
  project: Project | undefined,
  error: string | undefined,
  collapsed: boolean,
  language?: string,
  designAvailable = false,
  iterationState?: IterationState,
  prototype?: PrototypeManifestArtifact,
  worktree?: string,
  acceptance?: AcceptanceView,
  executionProgress?: string,
  costs?: CostLedger,
): ToolLine[] {
  const lang = language ?? project?.marker.settings.language ?? "en"
  if (error)
    return [
      {
        kind: "warning",
        text: localize(
          lang,
          `Project unavailable: ${error}`,
          `项目不可用：${error}`,
          `プロジェクトを利用できません：${error}`,
        ),
        wrap: true,
      },
    ]
  if (!project) return []
  const name = project.marker.name
  const iteration = project.marker.currentIteration
  const state = iterationState ?? initialIteration(project.marker.id, iteration)
  const stage = stageName(state.stage, lang)
  const status = statusName(state.status, lang)
  const lines: ToolLine[] = [
    {
      kind: "accent",
      text: localize(
        lang,
        `Project ${name} · iteration ${iteration} · ${stage} · ${status}`,
        `项目 ${name} · 迭代 ${iteration} · ${stage} · ${status}`,
        `プロジェクト ${name} · イテレーション ${iteration} · ${stage} · ${status}`,
      ),
      wrap: true,
    },
    {
      kind: "muted",
      // Host panels receive the MAIN id even while native design has focus. Do not infer focus
      // or keep a stale "next: open" instruction after a saved design has become available.
      text: nextSuggestion(state, lang, designAvailable),
      wrap: true,
    },
  ]
  if (state.artifacts.some((entry) => entry.kind === "spec"))
    lines.push({
      kind: "muted",
      text: `${implementationStatus(state)}${worktree ? ` · ${worktree}` : ""}`,
      wrap: true,
    })
  if (costs)
    lines.push({
      kind: costs.policy.latch ? "warning" : "muted",
      text: costText(costs, lang).split("\n").slice(0, 2).join(" · "),
      wrap: true,
    })
  if (executionProgress) lines.push({ kind: "accent", text: executionProgress, wrap: true })
  if (acceptance)
    lines.push({
      kind: acceptance.stale ? "warning" : "muted",
      text: acceptancePanelText(acceptance, lang),
      wrap: true,
    })
  if (prototype)
    lines.push({
      kind: "muted",
      text: prototypePanelText(prototype, lang, !!state.prototypeChoice),
      wrap: true,
    })
  return collapsed ? lines.slice(0, 1) : lines
}

const HELP = `/project [list] — choose a known project or the nearest discovered project
/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]
/project switch [name, id, or directory]
/project status
/project cost [cap <USD>|raise <USD>|continue|remove]
/project design
/project prototype [<variant>|choose|run <variant>]
/project spec
/project mode
/project implement
/project accept
/project next
/project skip batch|design|prototype|implement|accept
/project revisit design|prototype
Attachment does not change the main session's working directory.
Prototype file tools are variant-scoped; shell uses current permissions. This is not a sandbox.
Spec and mode review: /project spec. Approved batch execution: /project implement. Acceptance: /project next, then /project accept. Ship: /project ship [status|reconcile|local-only|skip]. Close/archive UI: coming later.`

function help(language: string): string {
  return localize(
    language,
    HELP,
    `/project [list] — 选择已知项目或最近识别的项目\n/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]\n/project switch [name, id, or directory]\n/project status — 查看项目阶段和状态\n/project cost [cap <USD>|raise <USD>|continue|remove] — 查看花费并管理项目上限\n/project design — 打开设计会话\n/project prototype [<variant>|choose|run <variant>] — 查看原型变体、选择结论或显示运行命令\n/project next — 查看总结并确认下一步\n/project skip batch|design|prototype|implement|accept\n/project revisit design|prototype\n关联项目不会改变主会话工作目录。原型文件工具仅能写入各自目录，Shell 遵循当前权限模式；这不是沙箱。规格和执行模式审阅：/project spec；保留已完成批次并重新批准执行模式：/project mode；按已批准的模式实现批次：/project implement。验收：/project next 确认后用 /project accept。发布：/project ship [status|reconcile|local-only|skip]。关闭和归档界面将在后续版本提供。`,
    `/project [list] — 登録済みまたは最寄りのプロジェクトを選択\n/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]\n/project switch [name, id, or directory]\n/project status — 段階と状態を確認\n/project cost [cap <USD>|raise <USD>|continue|remove] — 費用とプロジェクト上限を確認\n/project design — 設計会話を開く\n/project prototype [<variant>|choose|run <variant>] — 案の表示・選択・実行コマンドの確認\n/project next — 要約を確認して次の手順を承認\n/project skip batch|design|prototype|implement|accept\n/project revisit design|prototype\n関連付けてもメインの作業ディレクトリは変わりません。試作のファイルツールは各案のディレクトリ内だけに書き込みます。シェルは現在の権限モードに従い、サンドボックスではありません。仕様と実行モードの確認：/project spec、完了済みバッチを保持してモードを再承認：/project mode、承認済みモードでのバッチ実装：/project implement。受け入れ確認：/project next で承認後 /project accept。リリース：/project ship [status|reconcile|local-only|skip]。終了・アーカイブの画面は今後対応予定です。`,
  )
}

/** Quotes allow explicit Windows directories with spaces; backslashes remain literal. */
export function words(text: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  for (const match of text.matchAll(re)) tokens.push(match[1] ?? match[2] ?? match[3]!)
  return tokens
}

interface PanelState {
  fingerprint: string
  project?: Project
  iteration?: IterationState
  error?: string
  refreshing?: boolean
  refreshedAt?: number
}

export function createProjectExtension(): Extension {
  return (api) => {
    const registry = new Registry(api.dataDir)
    const languagePolicy = new LanguagePolicy()
    const availableDesigns = new Set<string>()
    const designKey = (project: Project) => `${project.marker.id}/${project.marker.currentIteration}`
    const settings = api.settings.declare({
      fields: [
        {
          key: "reviewerModel",
          label: "Reviewer model",
          type: "text",
          default: "",
          description:
            "Configured provider/model must differ from every model that changed code in this batch. Empty uses a disclosed same-model fresh-session review.",
        },
        {
          key: "defaultProjectCapUsd",
          label: "Default project cap (USD)",
          type: "text",
          default: "",
          description:
            "Empty is uncapped. Applies when a project first initializes accounting. Change an existing cap with /project cost cap or raise; stage caps are not supported.",
          pattern: "(?:[0-9]+(?:\\.[0-9]+)?)?",
        },
        {
          key: "language",
          label: "Document language",
          type: "text",
          default: "conversation",
          description:
            "en, zh or ja, or conversation. Other valid tags use English with a notice. Project settings take precedence. New content only.",
          maxLength: 40,
          pattern: "conversation|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*",
        },
      ],
    })
    const designs = new DesignSessions(api, languagePolicy, () => settings.get().language)
    const prototypes = new Prototypes(api)
    const implementations = new Implementations(api, () => {
      for (const state of states.values()) state.refreshedAt = undefined
      api.requestRender()
    })
    const acceptances = new Acceptances(api, () => {
      for (const state of states.values()) state.refreshedAt = undefined
      api.requestRender()
    })
    const acceptancePanels = new Map<string, AcceptanceView>()
    const worktreePanels = new Map<string, string>()
    const panelArtifactRefs = new Map<string, { worktree?: string; prototype?: string }>()
    const prototypePanels = new Map<string, PrototypeManifestArtifact>()
    async function refreshPrototypePanel(project: Project, iteration?: IterationState) {
      // Panel artifact reads must not acquire writer claims or repair saved projections.
      const store = new IterationStore(project, {}, project.marker.currentIteration)
      const current = iteration ?? (await store.read())
      const view = await acceptanceView(store, current, acceptancePanels.get(designKey(project)))
      if (view) acceptancePanels.set(designKey(project), view)
      else acceptancePanels.delete(designKey(project))
      const key = designKey(project)
      const cached = panelArtifactRefs.get(key) ?? {}
      const worktreeRef = current.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
      if (worktreeRef && cached.worktree !== worktreeRef.id) {
        const worktree = await store.readArtifact(worktreeRef)
        if (worktree.kind === "iteration-worktree")
          worktreePanels.set(key, `${worktree.status}: ${worktree.cwd}`)
        cached.worktree = worktreeRef.id
      }
      const prototypeRef = current.artifacts.findLast((entry) => entry.kind === "prototype-manifest")
      if (prototypeRef && cached.prototype !== prototypeRef.id) {
        const saved = await latestPrototypeManifest(store, current)
        if (saved) prototypePanels.set(key, saved.manifest)
        cached.prototype = prototypeRef.id
      }
      panelArtifactRefs.set(key, cached)
    }
    const costPanels = new Map<string, CostLedger>()
    let panelGeneration = 0
    let unloaded = false
    configureAccounting(api, {
      defaultCapUsd: () => {
        const text = settings.get().defaultProjectCapUsd?.trim()
        if (!text) return undefined
        const cap = Number(text)
        if (!Number.isFinite(cap) || cap <= 0)
          throw new Error("Set a positive default project cap in USD, or leave it empty for no cap.")
        return cap
      },
      changed(project, ledger) {
        costPanels.set(project.marker.id, ledger)
      },
    })
    api.onUnload?.(() => {
      unloaded = true
      panelGeneration++
      states.clear()
      costPanels.clear()
      void disposeAccounting(api)
    })
    const states = new Map<string, PanelState>()
    const memoryAttachments = new Map<string, Attachment>()
    const active = (id: string) => api.session()?.info().id === id
    const attachmentFor = (id: string, data?: SessionData) =>
      restoreAttachment(data) ?? memoryAttachments.get(id)

    async function restorePanel(): Promise<void> {
      const session = api.session()
      if (!session || unloaded) return
      const id = session.info().id
      const attachment = attachmentFor(id, session.data)
      if (!attachment) return
      const generation = panelGeneration
      const fingerprint = JSON.stringify(attachment)
      const state: PanelState = { fingerprint, refreshing: true }
      states.set(id, state)
      const current = () =>
        !unloaded &&
        generation === panelGeneration &&
        api.session() === session &&
        active(id) &&
        states.get(id) === state &&
        JSON.stringify(attachmentFor(id, session.data)) === fingerprint
      try {
        const project = await readProject(attachment.root, attachment.projectId)
        if (!current()) return
        state.project = project
        // Display only: no accounting initialization, policy defaults, inventory recovery or repair.
        const cached = costPanels.get(project.marker.id)
        const ledger = await new FileCostPersistence(project).read()
        if (!current()) return
        const iteration = await new HistoricalIterationReader(project, project.marker.currentIteration).read()
        if (!current()) return
        // An accounting update during the read is newer than this restored display snapshot.
        if (costPanels.get(project.marker.id) === cached) {
          if (ledger) costPanels.set(project.marker.id, ledger)
          else costPanels.delete(project.marker.id)
        }
        state.iteration = iteration
        state.error = undefined
      } catch (error) {
        if (current())
          state.error = projectError(error, state.project ? displayLanguage(state.project) : "en")
      } finally {
        if (current()) {
          state.refreshing = false
          api.requestRender()
        }
      }
    }

    async function language(project: Project | undefined, ctx: CommandContext): Promise<string> {
      // Choose the winning source BEFORE validating; invalid lower-priority settings cannot veto it.
      const configured = project?.marker.settings.language ?? settings.get().language
      const inferred = conversationLanguage(ctx.session.messages())
      let result = configured === "conversation" ? (inferred ?? "conversation") : configured
      if (result === "conversation") {
        result =
          (await ctx.ui.input("Document language", {
            initial: "en",
            placeholder: "en, zh or ja",
            signal: ctx.signal,
          })) ?? ""
        if (!result)
          throw commandFailure(
            ctx,
            "No document language selected. Run the command again to continue.",
            "尚未选择文档语言。请重新运行命令后选择语言。",
            "文書の言語が選択されていません。コマンドを再実行して言語を選んでください。",
          )
      }
      if (!validLanguage(result) || result === "conversation")
        throw commandFailure(
          ctx,
          "Choose a valid document language tag, such as en, zh or ja.",
          "请选择有效的文档语言标签，例如 en、zh 或 ja。",
          "en、zh、ja など、有効な文書の言語タグを選んでください。",
        )
      return languagePolicy.resolve(result, (notice) => ctx.print(notice, "warning"))
    }

    function displayLanguage(
      project: Project,
      notify: (notice: string) => void = (notice) => api.notify(notice, "warning"),
    ): string {
      const tag = resolveLanguage(
        project.marker.settings.language,
        settings.get().language,
        conversationLanguage(api.session()?.messages() ?? []) ?? "en",
      )
      // Invalid settings are separately reported by the settings handler. Rendering must remain usable.
      return validLanguage(tag) ? languagePolicy.resolve(tag, notify) : "en"
    }

    function interfaceLanguage(ctx: CommandContext): string {
      const project = states.get(ctx.session.info().id)?.project
      if (project) return displayLanguage(project, (notice) => ctx.print(notice, "warning"))
      const tag = resolveLanguage(
        undefined,
        settings.get().language,
        conversationLanguage(ctx.session.messages?.() ?? []) ?? "en",
      )
      return validLanguage(tag) ? languagePolicy.resolve(tag, (notice) => ctx.print(notice, "warning")) : "en"
    }

    function commandFailure(ctx: CommandContext, en: string, zh: string, ja: string): Error {
      return new ProjectCommandError(localize(interfaceLanguage(ctx), en, zh, ja))
    }

    async function attach(project: Project, ctx: CommandContext, origin: string): Promise<void> {
      await registry.remember(project)
      if (!active(origin) || ctx.signal.aborted)
        throw commandFailure(
          ctx,
          "Main session changed. Run /project switch again in the intended session.",
          "主会话已改变。请在目标会话中重新运行 /project switch。",
          "メインセッションが変わりました。対象のセッションで /project switch を再実行してください。",
        )
      const snapshot: Attachment = {
        projectId: project.marker.id,
        root: project.root,
        attachedAt: new Date().toISOString(),
      }
      if (ctx.session.data) ctx.session.data.append(ATTACHMENT_KEY, snapshot)
      else memoryAttachments.set(origin, snapshot)
      const accounting = await projectAccounting(api, project)
      costPanels.set(project.marker.id, accounting.costs.snapshot())
      // Retain the selected marker/language even when its iteration data cannot be read.
      states.set(origin, { fingerprint: JSON.stringify(snapshot), project })
      const iteration = await new IterationStore(project).read()
      if (!active(origin) || ctx.signal.aborted)
        throw commandFailure(
          ctx,
          "Main session changed. Run this command again.",
          "主会话已改变，请重新运行此命令。",
          "メインセッションが変わりました。コマンドをもう一度実行してください。",
        )
      states.set(origin, { fingerprint: JSON.stringify(snapshot), project, iteration })
      const lang = displayLanguage(project, (notice) => ctx.print(notice, "warning"))
      ctx.print(
        localize(
          lang,
          `Attached project ${project.marker.name}. Main working directory unchanged.`,
          `已关联项目 ${project.marker.name}。主会话工作目录不变。`,
          `プロジェクト ${project.marker.name} を関連付けました。メインの作業ディレクトリは変更しません。`,
        ),
        "info",
        { persist: true },
      )
      if (!ctx.session.data || !ctx.session.info().file)
        ctx.print(
          localize(
            lang,
            "If this host is not storing sessions, the attachment lasts only for this run.",
            "如果宿主未保存会话，此关联仅在本次运行中有效。",
            "ホストがセッションを保存しない場合、関連付けは今回の実行中のみ有効です。",
          ),
          "warning",
        )
      api.requestRender()
    }

    async function attached(ctx: CommandContext, origin: string): Promise<Project> {
      let lang = interfaceLanguage(ctx)
      let selectedProject = states.get(origin)?.project
      const attachment = attachmentFor(origin, ctx.session.data)
      if (!attachment)
        throw commandFailure(
          ctx,
          "No project attached. Use /project to choose one, or /project new to create one.",
          "尚未关联项目。请使用 /project 选择项目，或用 /project new 创建。",
          "プロジェクトが関連付けられていません。/project で選択するか /project new で作成してください。",
        )
      try {
        const project = await readProject(attachment.root, attachment.projectId)
        // A validated marker is the current language source even if iteration loading fails.
        // Do not fall back to cached/pre-resume settings for compatibility diagnostics.
        selectedProject = project
        lang = displayLanguage(project, (notice) => ctx.print(notice, "warning"))
        const iteration = await new IterationStore(project).read()
        await refreshPrototypePanel(project, iteration)
        states.set(origin, { fingerprint: JSON.stringify(attachment), project, iteration })
        api.requestRender()
        return project
      } catch (error) {
        states.set(origin, {
          fingerprint: JSON.stringify(attachment),
          project: selectedProject,
          error: projectError(error, lang),
        })
        api.requestRender()
        throw new ProjectCommandError(
          localize(
            lang,
            `Attached project is missing, moved, or invalid at ${attachment.root}. ${projectError(error, lang)} Use /project switch explicitly; no replacement was attached.`,
            `关联的项目缺失、已移动或无效：${attachment.root}。${projectError(error, lang)} 请用 /project switch 明确选择项目，未自动替换项目。`,
            `関連付けたプロジェクトが見つからないか、移動または無効になっています：${attachment.root}。${projectError(error, lang)} /project switch で明示的に選択してください。別のプロジェクトには切り替えていません。`,
          ),
          { cause: error },
        )
      }
    }

    async function choose(ctx: CommandContext, origin: string, target?: string): Promise<void> {
      const known = await registry.list()
      const lang = interfaceLanguage(ctx)
      if (target) {
        const pathKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
        const matches = known.filter(
          (entry) =>
            entry.id === target ||
            entry.name === target ||
            pathKey(path.resolve(entry.root)) === pathKey(path.resolve(ctx.cwd, target)),
        )
        if (matches.length > 1)
          throw commandFailure(
            ctx,
            `More than one project matches ${target}. Use its full id or directory.`,
            `多个项目匹配 ${target}。请使用完整项目 ID 或目录。`,
            `${target} に一致するプロジェクトが複数あります。完全な ID またはディレクトリを指定してください。`,
          )
        const entry = matches[0]
        let project: Project
        try {
          project = entry
            ? await readProject(entry.root, entry.id)
            : await readProject(path.resolve(ctx.cwd, target))
        } catch (error) {
          throw new ProjectCommandError(
            localize(
              lang,
              `Project ${target} is missing, moved, or invalid: ${projectError(error, lang)}. Restore its directory or select another project.`,
              `项目 ${target} 缺失、已移动或无效：${projectError(error, lang)} 请恢复项目目录，或明确选择其他项目。`,
              `プロジェクト ${target} が見つからないか移動または無効になっています：${projectError(error, lang)} ディレクトリを復元するか、別のプロジェクトを明示的に選択してください。`,
            ),
            { cause: error },
          )
        }
        await attach(project, ctx, origin)
        return
      }
      let discovered: Project | undefined
      let discoveryError: string | undefined
      try {
        discovered = await discoverProject(ctx.cwd)
      } catch (error) {
        discoveryError = projectError(error, lang)
        ctx.print(
          localize(
            lang,
            `Project discovery failed: ${discoveryError}. Known projects remain available; no outer project was substituted.`,
            `项目识别失败：${discoveryError}。仍可选择已知项目；未替换为外层项目。`,
            `プロジェクトの検出に失敗しました：${discoveryError}。登録済みプロジェクトは選択できます。外側のプロジェクトには切り替えていません。`,
          ),
          "warning",
        )
      }
      const entries = [...known]
      if (
        discovered &&
        !entries.some((entry) => entry.id === discovered.marker.id && entry.root === discovered.root)
      )
        entries.push({
          id: discovered.marker.id,
          root: discovered.root,
          name: discovered.marker.name,
          lastUsed: "",
        })
      const checked = await Promise.all(
        entries.map(async (entry) => {
          try {
            return { entry, project: await readProject(entry.root, entry.id), error: undefined }
          } catch (error) {
            return { entry, project: undefined, error: projectError(error, lang) }
          }
        }),
      )
      if (!checked.length) {
        ctx.print(
          discoveryError
            ? localize(
                lang,
                "No known projects. Repair the local project marker, or explicitly /project switch <directory>.",
                "没有已知项目。请修复本地标记，或使用 /project switch <directory> 显式切换。",
                "登録済みプロジェクトはありません。マーカーを修復するか、/project switch <directory> で明示的に切り替えてください。",
              )
            : localize(
                lang,
                "No projects opened yet and no project marker found here. Use /project new to create one.",
                "尚未打开项目，此处也未找到标记。使用 /project new 创建项目。",
                "開いたプロジェクトはなく、ここにマーカーもありません。/project new で作成してください。",
              ),
        )
        return
      }
      const labels = checked.map(
        ({ entry, error }) =>
          `${error ? localize(lang, "[missing or invalid] ", "[缺失或无效] ", "[未検出または無効] ") : ""}${entry.name} — ${entry.root} (${entry.id})`,
      )
      if (ctx.frontend === "print") {
        ctx.print(
          localize(
            lang,
            `Projects\n${labels.join("\n")}\nUse /project switch <id> to attach. Missing projects are never replaced automatically.`,
            `项目\n${labels.join("\n")}\n使用 /project switch <id> 关联项目。不会自动替换缺失的项目。`,
            `プロジェクト\n${labels.join("\n")}\n/project switch <id> で関連付けます。見つからないプロジェクトを自動で置き換えることはありません。`,
          ),
        )
        return
      }
      const label = await ctx.ui.select(
        localize(
          lang,
          "Projects — attach to this main session",
          "项目 — 关联到当前主会话",
          "プロジェクト — このメインセッションに関連付ける",
        ),
        labels,
        {
          signal: ctx.signal,
        },
      )
      if (!label) return
      const selected = checked[labels.indexOf(label)]
      if (!selected?.project)
        throw commandFailure(
          ctx,
          `Project is missing, moved, or invalid. ${selected?.error ?? "Choose a listed project."}`,
          `项目缺失、已移动或无效。${selected?.error ?? "请从列表中选择项目。"}`,
          `プロジェクトが見つからないか移動または無効になっています。${selected?.error ?? "一覧から選択してください。"}`,
        )
      // Revalidate after the picker; never silently attach a replaced marker.
      await attach(await readProject(selected.entry.root, selected.entry.id), ctx, origin)
    }

    function render(opts: PanelRenderOptions): ToolLine[] {
      const attachment = attachmentFor(opts.sessionId, opts.data)
      if (!attachment) return []
      const fingerprint = JSON.stringify(attachment)
      let state = states.get(opts.sessionId)
      if (state?.fingerprint !== fingerprint) {
        state = { fingerprint }
        states.set(opts.sessionId, state)
      }
      if (!state.refreshing && (state.refreshedAt === undefined || opts.now - state.refreshedAt >= 1000)) {
        const captured = state
        const priorData = JSON.stringify([captured.project, captured.iteration])
        captured.refreshing = true
        captured.refreshedAt = opts.now
        void readProject(attachment.root, attachment.projectId)
          .then(async (project) => {
            captured.project = project
            const iteration = await new HistoricalIterationReader(
              project,
              project.marker.currentIteration,
            ).read()
            await refreshPrototypePanel(project, iteration)
            return { project, iteration }
          })
          .then(
            ({ project, iteration }) => {
              captured.refreshing = false
              if (states.get(opts.sessionId) !== captured) return
              const changed =
                captured.error !== undefined || priorData !== JSON.stringify([project, iteration])
              captured.project = project
              captured.iteration = iteration
              captured.error = undefined
              if (changed) api.requestRender()
            },
            (error) => {
              captured.refreshing = false
              if (states.get(opts.sessionId) !== captured) return
              const errorText = projectError(
                error,
                captured.project ? displayLanguage(captured.project) : "en",
              )
              const changed = captured.error !== errorText
              captured.error = errorText
              if (changed) api.requestRender()
            },
          )
      }
      return panelLines(
        state.project,
        state.error,
        opts.collapsed,
        state.project && displayLanguage(state.project),
        !!state.project && availableDesigns.has(designKey(state.project)),
        state.iteration,
        state.project && prototypePanels.get(designKey(state.project)),
        state.project && worktreePanels.get(designKey(state.project)),
        state.project && acceptancePanels.get(designKey(state.project)),
        state.project && implementations.progress(state.project),
        state.project && costPanels.get(state.project.marker.id),
      )
    }
    api.registerPanel({ id: "project", order: 10, render })
    settings.onChange((values) => {
      if (!validLanguage(values.language))
        api.notify(
          "Project Document language must be a language tag (en, zh, ja) or conversation. A valid project override still takes precedence.",
          "warning",
        )
      designs.settingsChanged()
      panelGeneration++
      states.clear()
      api.requestRender()
    })
    // Read branch-local records again after resume, clear, fork or rewind; owned handles remain independent.
    api.on("session.start", (event) => {
      if (unloaded || !active(event.sessionId)) return
      panelGeneration++
      states.clear()
      costPanels.clear()
      api.requestRender()
      return restorePanel()
    })
    api.registerCommand({
      name: "project",
      description: "Attach a project, inspect its status, or open its saved design conversation",
      args: {
        hint: "[list|new|switch|status|design|prototype|spec|implement|accept|ship|next|skip|revisit]",
        complete: (prefix) =>
          [
            "list",
            "new",
            "switch",
            "status",
            "cost",
            "design",
            "prototype",
            "spec",
            "mode",
            "implement",
            "accept",
            "ship",
            "next",
            "skip",
            "revisit",
            "help",
          ]
            .filter((item) => item.startsWith(prefix))
            .map((value) => ({ value })),
      },
      async run(args, ctx) {
        const origin = ctx.session.info().id
        try {
          if (
            designs.isDesignSession(origin) ||
            prototypes.sessions.isPrototypeSession(origin) ||
            !active(origin)
          )
            throw commandFailure(
              ctx,
              "Project commands are available in the main conversation only. Press F6 to return to main.",
              "项目命令仅可在主会话中运行。请按 F6 返回主会话。",
              "プロジェクトのコマンドはメインセッション専用です。F6 でメインに戻ってください。",
            )
          const tokens = words(args)
          const verb = tokens.shift() ?? "list"
          if (verb === "help") {
            ctx.print(help(interfaceLanguage(ctx)))
            return
          }
          if (verb === "cost") {
            const attachment = attachmentFor(origin, ctx.session.data)
            if (!attachment) throw new Error("No project attached. Use /project switch first.")
            const project = await readProject(attachment.root, attachment.projectId)
            const accounting = await projectAccounting(api, project)
            await accounting.settled()
            const action = tokens.shift()
            if (action) {
              if (!["cap", "raise", "continue", "remove"].includes(action))
                throw new Error("Use /project cost [cap <USD>|raise <USD>|continue|remove].")
              const amount = action === "cap" || action === "raise" ? Number(tokens.shift()) : undefined
              if (tokens.length) throw new Error("Use /project cost [cap <USD>|raise <USD>|continue|remove].")
              ctx.signal.throwIfAborted()
              const selected = attachmentFor(origin, ctx.session.data)
              const current = await readProject(project.root, project.marker.id)
              if (
                !active(origin) ||
                selected?.projectId !== project.marker.id ||
                selected.root !== project.root ||
                current.marker.currentIteration !== project.marker.currentIteration
              )
                throw new Error("Main session or project changed. Run the command again.")
              await assertProjectWritable(project)
              await accounting.costs.configure(
                action as "cap" | "raise" | "continue" | "remove",
                amount,
                origin,
              )
              ctx.print(
                "Cost policy saved. Stopped attempts were not resumed; approve a fresh continuation or attempt before starting work.",
              )
            }
            const ledger = accounting.costs.snapshot()
            costPanels.set(project.marker.id, ledger)
            ctx.print(
              costText(ledger, displayLanguage(project)) +
                "\nReported-spend stop only: in-flight work, late receipts and unknown prices can exceed the cap.\nUse /project cost continue to acknowledge current unpriced coverage or continue at the current subtotal; new spend is checked again.",
            )
            api.requestRender()
          } else if (verb === "list" || verb === "switch") {
            await choose(ctx, origin, tokens.join(" ") || undefined)
          } else if (verb === "new") {
            let root = ctx.cwd
            let selectedLanguage: string | undefined
            let commitDocuments = false
            const nameParts: string[] = []
            while (tokens.length) {
              const token = tokens.shift()!
              if (token === "--root") {
                const value = tokens.shift()
                if (!value) throw new Error(HELP)
                root = path.resolve(ctx.cwd, value)
              } else if (token === "--language") {
                selectedLanguage = tokens.shift()
                if (!selectedLanguage || !validLanguage(selectedLanguage))
                  throw commandFailure(
                    ctx,
                    "Use --language with a valid language tag.",
                    "请在 --language 后提供有效的语言标签，例如 en、zh 或 ja。",
                    "--language に en、zh、ja などの有効な言語タグを指定してください。",
                  )
              } else if (token === "--commit-documents") commitDocuments = true
              else if (token.startsWith("--")) throw new Error(HELP)
              else nameParts.push(token)
            }
            const name =
              nameParts.join(" ") ||
              (await ctx.ui.input("Project name", { signal: ctx.signal, placeholder: path.basename(root) }))
            if (!name) return
            const mustChooseLanguage =
              !selectedLanguage &&
              settings.get().language === "conversation" &&
              !conversationLanguage(ctx.session.messages())
            const chosenLanguage =
              selectedLanguage ?? (mustChooseLanguage ? await language(undefined, ctx) : undefined)
            if (!active(origin) || ctx.signal.aborted)
              throw commandFailure(
                ctx,
                "Main session changed. Run /project new again in the intended session.",
                "主会话已改变。请在目标会话中重新运行 /project new。",
                "メインセッションが変わりました。対象のセッションで /project new を再実行してください。",
              )
            // Following an extension default must not silently pin it as a project override.
            const project = await createProject(root, name, {
              ...(chosenLanguage ? { language: chosenLanguage } : {}),
              commitDocuments,
            })
            await attach(project, ctx, origin)
          } else if (verb === "ship") {
            const project = await attached(ctx, origin)
            const checkOrigin = () => {
              ctx.signal.throwIfAborted()
              const selected = attachmentFor(origin, ctx.session.data)
              if (
                !active(origin) ||
                selected?.projectId !== project.marker.id ||
                selected.root !== project.root
              )
                throw new Error("Main session or attached project changed. Run the command again.")
            }
            await runShip(api, project, tokens, ctx, displayLanguage(project), checkOrigin, async () => {
              await designs.quiesce(project)
              await prototypes.sessions.quiesce(project)
              await implementations.quiesce(project)
              await acceptances.quiesce(project)
            })
            const current = await readProject(project.root, project.marker.id)
            states.set(origin, {
              fingerprint: JSON.stringify(attachmentFor(origin, ctx.session.data)),
              project: current,
              iteration: await new IterationStore(current).read(),
            })
            api.requestRender()
          } else if (verb === "spec" || verb === "mode" || verb === "implement" || verb === "accept") {
            if (tokens.length) throw new Error(HELP)
            const project = await attached(ctx, origin)
            const checkOrigin = () => {
              ctx.signal.throwIfAborted()
              const selected = attachmentFor(origin, ctx.session.data)
              if (
                !active(origin) ||
                selected?.projectId !== project.marker.id ||
                selected.root !== project.root
              )
                throw new Error("Main session or attached project changed. Run the command again.")
            }
            try {
              if (verb === "spec")
                await runSpec(api, project, ctx, displayLanguage(project), checkOrigin, async () => {
                  await designs.quiesce(project)
                  await prototypes.sessions.quiesce(project)
                })
              else if (verb === "mode")
                await runModeChange(api, project, ctx, displayLanguage(project), checkOrigin, async () => {
                  await implementations.quiesce(project)
                  await acceptances.quiesce(project)
                })
              else if (verb === "implement")
                await implementations.run(project, ctx, displayLanguage(project), checkOrigin)
              else {
                const current = await new IterationStore(project).read()
                if (current.stage !== "accept")
                  throw new Error(
                    "Confirm acceptance with /project next first. Running implementation was not stopped.",
                  )
                await implementations.quiesce(project)
                checkOrigin()
                await acceptances.run(
                  project,
                  ctx,
                  displayLanguage(project),
                  checkOrigin,
                  settings.get().reviewerModel.trim() || undefined,
                )
              }
            } finally {
              if (active(origin)) await attached(ctx, origin)
              api.requestRender()
            }
          } else if (verb === "prototype") {
            const project = await attached(ctx, origin)
            const checkOrigin = () => {
              ctx.signal.throwIfAborted()
              const selected = attachmentFor(origin, ctx.session.data)
              if (
                !active(origin) ||
                selected?.projectId !== project.marker.id ||
                selected.root !== project.root
              )
                throw new Error("Main session or attached project changed. Run /project prototype again.")
            }
            try {
              await prototypes.run(
                tokens,
                project,
                ctx,
                displayLanguage(project),
                checkOrigin,
                async () => {
                  checkOrigin()
                  await attached(ctx, origin)
                },
                () => designs.quiesce(project),
              )
            } finally {
              if (active(origin)) await attached(ctx, origin)
            }
          } else if (verb === "next" || verb === "skip" || verb === "revisit") {
            const project = await attached(ctx, origin)
            const checkOrigin = () => {
              if (!active(origin) || ctx.signal.aborted)
                throw commandFailure(
                  ctx,
                  "Main session changed or command cancelled. Run this command again.",
                  "主会话已改变或命令已取消。请重新运行此命令。",
                  "メインセッションが変わったか、コマンドがキャンセルされました。もう一度実行してください。",
                )
              const selected = attachmentFor(origin, ctx.session.data)
              if (selected?.projectId !== project.marker.id || selected.root !== project.root)
                throw commandFailure(
                  ctx,
                  "Attached project changed while the dialog was open. Run this command again.",
                  "对话框打开期间关联的项目已改变。请重新运行此命令。",
                  "ダイアログを開いている間に関連付けたプロジェクトが変わりました。コマンドを再実行してください。",
                )
            }
            try {
              let current =
                verb === "next" ? await new IterationStore(project).read() : states.get(origin)?.iteration
              if (
                verb === "next" &&
                current?.stage === "prototype" &&
                !current.revisit &&
                !current.pending &&
                current.artifacts.some((artifact) => artifact.kind === "prototype-manifest")
              ) {
                // Revisit/skip handling belongs to the stage engine. Without a manifest
                // no prototype choice can exist, so avoid extra journal scans on that path.
                if (await prototypes.recoverChoice(project, displayLanguage(project), checkOrigin))
                  current = await new IterationStore(project).read()
              }
              if (
                verb === "next" &&
                current?.stage === "prototype" &&
                !current.revisit &&
                !current.pending &&
                ["ready", "confirmed", "running"].includes(current.phase) &&
                !current.prototypeChoice
              ) {
                const lang = displayLanguage(project)
                const choices = [
                  localize(lang, "Open prototype variants", "打开原型变体", "プロトタイプ案を開く"),
                  localize(lang, "Skip prototype", "跳过原型", "プロトタイプをスキップ"),
                ]
                const choice = await ctx.ui.select(
                  localize(lang, "Prototype next step", "原型下一步", "プロトタイプの次の手順"),
                  choices,
                  { signal: ctx.signal, sessionId: origin },
                )
                checkOrigin()
                if (choice === choices[0])
                  await prototypes.run(
                    [],
                    project,
                    ctx,
                    lang,
                    checkOrigin,
                    async () => {
                      checkOrigin()
                      await attached(ctx, origin)
                    },
                    () => designs.quiesce(project),
                  )
                else if (choice === choices[1])
                  await runStageCommand("skip", ["prototype"], project, ctx, lang, checkOrigin, async () => {
                    await designs.quiesce(project)
                    await prototypes.sessions.quiesce(project)
                    await implementations.quiesce(project)
                    await acceptances.quiesce(project)
                  })
                return
              }
              if (
                verb === "next" &&
                current?.stage === "implement" &&
                !current.pending &&
                !current.revisit &&
                !current.approvedContext &&
                !current.activeAttemptId
              ) {
                const draftRef = current.artifacts.findLast((entry) => entry.kind === "batch-plan")
                const draft = draftRef && (await new IterationStore(project).readArtifact(draftRef))
                if (draft?.kind === "batch-plan" && draft.modeChange) {
                  await runModeChange(api, project, ctx, displayLanguage(project), checkOrigin, async () => {
                    await implementations.quiesce(project)
                    await acceptances.quiesce(project)
                  })
                  return
                }
                const choice = await ctx.ui.confirm(
                  "Generate implementation spec",
                  "Generate an English spec from verified decisions and confirmed prototype conclusions, with a summary in your language? No implementation starts.",
                  { signal: ctx.signal, sessionId: origin },
                )
                checkOrigin()
                if (choice === true)
                  await runSpec(api, project, ctx, displayLanguage(project), checkOrigin, async () => {
                    await designs.quiesce(project)
                    await prototypes.sessions.quiesce(project)
                  })
                return
              }
              await runStageCommand(
                verb,
                tokens,
                project,
                ctx,
                displayLanguage(project),
                checkOrigin,
                async () => {
                  await designs.quiesce(project)
                  await prototypes.sessions.quiesce(project)
                  await implementations.quiesce(project)
                  await acceptances.quiesce(project)
                },
                (iteration) => {
                  states.set(origin, {
                    fingerprint: JSON.stringify(attachmentFor(origin, ctx.session.data)),
                    project,
                    iteration,
                  })
                  api.requestRender()
                },
                async () => {
                  await runSpec(api, project, ctx, displayLanguage(project), checkOrigin, async () => {
                    await designs.quiesce(project)
                    await prototypes.sessions.quiesce(project)
                  })
                },
                async () => {
                  await implementations.quiesce(project)
                  checkOrigin()
                  await acceptances.run(
                    project,
                    ctx,
                    displayLanguage(project),
                    checkOrigin,
                    settings.get().reviewerModel.trim() || undefined,
                  )
                },
                async () => {
                  const freshness = await checkAcceptanceFreshness(api, project, ctx)
                  const view = acceptancePanels.get(designKey(project))
                  if (view)
                    acceptancePanels.set(designKey(project), { ...view, ...freshness, verified: true })
                  return freshness
                },
              )
            } finally {
              if (active(origin)) {
                const iteration = await new IterationStore(project).read()
                const selected = attachmentFor(origin, ctx.session.data)
                if (
                  active(origin) &&
                  selected?.projectId === project.marker.id &&
                  selected.root === project.root
                ) {
                  await refreshPrototypePanel(project, iteration)
                  states.set(origin, { fingerprint: JSON.stringify(selected), project, iteration })
                  api.requestRender()
                }
              }
            }
          } else if (verb === "status" || verb === "design") {
            if (tokens.length) throw new Error(HELP)
            const project = await attached(ctx, origin)
            if (!active(origin) || ctx.signal.aborted)
              throw commandFailure(
                ctx,
                "Main session changed. Run this command again.",
                "主会话已改变，请重新运行此命令。",
                "メインセッションが変わりました。コマンドをもう一度実行してください。",
              )
            if (verb === "design") {
              const store = new IterationStore(project)
              const iteration = await store.read()
              if (
                iteration.stage === "design" &&
                !iteration.pending &&
                ["finished", "summarized"].includes(iteration.phase) &&
                iteration.status === "idle"
              ) {
                const reopened = await store.dispatch(iteration.revision, {
                  type: "reopen-design",
                  expectedRevision: iteration.revision,
                })
                states.set(origin, {
                  fingerprint: JSON.stringify(attachmentFor(origin, ctx.session.data)),
                  project,
                  iteration: reopened,
                })
              }
              const chosenLanguage = await language(project, ctx)
              if (!active(origin) || ctx.signal.aborted)
                throw commandFailure(
                  ctx,
                  "Main session changed. Run /project design again.",
                  "主会话已改变。请重新运行 /project design。",
                  "メインセッションが変わりました。/project design を再実行してください。",
                )
              await designs.open(project, ctx, chosenLanguage)
              availableDesigns.add(designKey(project))
              api.requestRender()
            } else {
              const lang = displayLanguage(project, (notice) => ctx.print(notice, "warning"))
              if (supportsPrototype(api.apiVersion) && states.get(origin)?.iteration?.stage === "prototype")
                await prototypes.refresh(project, ctx, lang)
              const iteration = await new IterationStore(project).read()
              await refreshPrototypePanel(project, iteration)
              const view = acceptancePanels.get(designKey(project))
              if (view?.outcome && !view.running) {
                const freshness = await checkAcceptanceFreshness(api, project, ctx)
                acceptancePanels.set(designKey(project), { ...view, ...freshness, verified: true })
              }
              states.set(origin, {
                fingerprint: JSON.stringify(attachmentFor(origin, ctx.session.data)),
                project,
                iteration,
              })
              ctx.print(
                localize(
                  lang,
                  `${project.marker.name}\nDirectory: ${project.root}\nIteration: ${project.marker.currentIteration}`,
                  `${project.marker.name}\n目录：${project.root}\n迭代：${project.marker.currentIteration}`,
                  `${project.marker.name}\nディレクトリ：${project.root}\nイテレーション：${project.marker.currentIteration}`,
                ) +
                  `\n${stageStatus(iteration, lang)}\n${implementationStatus(iteration)}${implementations.progress(project) ? `\n${implementations.progress(project)}` : ""}${worktreePanels.has(designKey(project)) ? `\nWorktree: ${worktreePanels.get(designKey(project))}` : ""}\n${nextSuggestion(iteration, lang, availableDesigns.has(designKey(project)))}` +
                  (acceptancePanels.has(designKey(project))
                    ? `\n${acceptancePanelText(acceptancePanels.get(designKey(project))!, lang)}`
                    : "") +
                  (prototypePanels.has(designKey(project))
                    ? `\n${prototypePanelText(prototypePanels.get(designKey(project))!, lang, !!iteration.prototypeChoice)}`
                    : "") +
                  localize(
                    lang,
                    "\nAcceptance: /project next, then /project accept. Ship: /project ship. Close/archive UI: coming later.",
                    "\n验收：/project next 确认后用 /project accept。发布：/project ship。关闭和归档界面：后续版本提供。",
                    "\n受け入れ確認：/project next で承認後 /project accept。リリース：/project ship。終了・アーカイブの画面は今後対応予定です。",
                  ),
              )
              const ship = await new ShipStore(project).latest()
              if (ship) ctx.print(shipSummary(ship))
              api.requestRender()
            }
          } else if (["prototype", "implement", "accept", "archive", "iteration"].includes(verb)) {
            ctx.print(
              localize(
                interfaceLanguage(ctx),
                "Coming later: execution is not available yet. This step stores stage state and human approvals only; no work was started.",
                "后续版本提供：执行尚未开放。当前仅保存阶段状态和用户审批，未启动任何工作。",
                "実行はまだ利用できません。現在は段階の状態と承認のみを保存します。作業は開始していません。",
              ),
            )
          } else throw new Error(HELP)
        } catch (error) {
          const lang = interfaceLanguage(ctx)
          ctx.print(message(error) === HELP ? help(lang) : projectError(error, lang), "error")
        }
      },
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default createProjectExtension()
