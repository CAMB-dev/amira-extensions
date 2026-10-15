import path from "node:path"
import type { CommandContext, Extension, PanelRenderOptions, SessionData, ToolLine } from "@amira/api"
import { DesignSessions } from "./design.ts"
import { conversationLanguage, LanguagePolicy, localize, resolveLanguage, validLanguage } from "./language.ts"
import { createProject, discoverProject, type Project, Registry, readProject } from "./store.ts"

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
  const lines: ToolLine[] = [
    {
      kind: "accent",
      text: localize(
        lang,
        `Project ${name} · iteration ${iteration} · design`,
        `项目 ${name} · 迭代 ${iteration} · 设计`,
        `プロジェクト ${name} · イテレーション ${iteration} · 設計`,
      ),
      wrap: true,
    },
    {
      kind: "muted",
      // Host panels receive the MAIN id even while native design has focus. Do not infer focus
      // or keep a stale "next: open" instruction after a saved design has become available.
      text: designAvailable
        ? localize(
            lang,
            "Continue design decisions · F6 returns to main from design",
            "继续确认设计决策 · 设计会话中按 F6 返回主会话",
            "設計の決定を続ける · 設計から F6 でメインに戻る",
          )
        : localize(
            lang,
            "Open design conversation: /project design",
            "打开设计会话：/project design",
            "設計会話を開く：/project design",
          ),
      wrap: true,
    },
  ]
  return collapsed ? lines.slice(0, 1) : lines
}

const HELP = `/project [list] — choose a known project or the nearest discovered project
/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]
/project switch [name, id, or directory]
/project status
/project design
Attachment does not change the main session's working directory.
Prototypes, implementation, acceptance, ship and archive: coming later.`

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
  error?: string
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
    const states = new Map<string, PanelState>()
    const memoryAttachments = new Map<string, Attachment>()
    const active = (id: string) => api.session()?.info().id === id
    const attachmentFor = (id: string, data?: SessionData) =>
      restoreAttachment(data) ?? memoryAttachments.get(id)

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
        if (!result) throw new Error("No document language selected. Run the command again to continue.")
      }
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
        conversationLanguage(ctx.session.messages()) ?? "en",
      )
      return validLanguage(tag) ? languagePolicy.resolve(tag, (notice) => ctx.print(notice, "warning")) : "en"
    }

    async function attach(project: Project, ctx: CommandContext, origin: string): Promise<void> {
      await registry.remember(project)
      if (!active(origin) || ctx.signal.aborted)
        throw new Error("Main session changed. Run /project switch again in the intended session.")
      const snapshot: Attachment = {
        projectId: project.marker.id,
        root: project.root,
        attachedAt: new Date().toISOString(),
      }
      if (ctx.session.data) ctx.session.data.append(ATTACHMENT_KEY, snapshot)
      else memoryAttachments.set(origin, snapshot)
      states.set(origin, { fingerprint: JSON.stringify(snapshot), project })
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
      const attachment = attachmentFor(origin, ctx.session.data)
      if (!attachment)
        throw new Error("No project attached. Use /project to choose one, or /project new to create one.")
      try {
        const project = await readProject(attachment.root, attachment.projectId)
        states.set(origin, { fingerprint: JSON.stringify(attachment), project })
        api.requestRender()
        return project
      } catch (error) {
        states.set(origin, { fingerprint: JSON.stringify(attachment), error: message(error) })
        api.requestRender()
        throw new Error(
          `Attached project is missing, moved, or invalid at ${attachment.root}. ${message(error)} Use /project switch explicitly; no replacement was attached.`,
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
          throw new Error(`More than one project matches ${target}. Use its full id or directory.`)
        const entry = matches[0]
        let project: Project
        try {
          project = entry
            ? await readProject(entry.root, entry.id)
            : await readProject(path.resolve(ctx.cwd, target))
        } catch (error) {
          throw new Error(
            `Project ${target} is missing, moved, or invalid: ${message(error)}. Restore its directory or select another project.`,
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
        discoveryError = message(error)
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
            return { entry, project: undefined, error: message(error) }
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
        throw new Error(
          `Project is missing, moved, or invalid. ${selected?.error ?? "Choose a listed project."}`,
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
        const captured = state
        void readProject(attachment.root, attachment.projectId).then(
          (project) => {
            captured.project = project
            api.requestRender()
          },
          (error) => {
            captured.error = message(error)
            api.requestRender()
          },
        )
      }
      return panelLines(
        state.project,
        state.error,
        opts.collapsed,
        state.project && displayLanguage(state.project),
        !!state.project && availableDesigns.has(designKey(state.project)),
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
      states.clear()
      api.requestRender()
    })
    // Read branch-local records again after resume, clear, fork or rewind; owned handles remain independent.
    api.on("session.start", () => {
      states.clear()
      api.requestRender()
    })
    api.registerCommand({
      name: "project",
      description: "Attach a project, inspect its status, or open its saved design conversation",
      args: {
        hint: "[list|new|switch|status|design]",
        complete: (prefix) =>
          ["list", "new", "switch", "status", "design", "help"]
            .filter((item) => item.startsWith(prefix))
            .map((value) => ({ value })),
      },
      async run(args, ctx) {
        const origin = ctx.session.info().id
        try {
          const tokens = words(args)
          const verb = tokens.shift() ?? "list"
          if (verb === "help") {
            ctx.print(HELP)
            return
          }
          if (verb === "list" || verb === "switch") {
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
                  throw new Error("Use --language with a valid language tag.")
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
              throw new Error("Main session changed. Run /project new again in the intended session.")
            // Following an extension default must not silently pin it as a project override.
            const project = await createProject(root, name, {
              ...(chosenLanguage ? { language: chosenLanguage } : {}),
              commitDocuments,
            })
            await attach(project, ctx, origin)
          } else if (verb === "status" || verb === "design") {
            if (tokens.length) throw new Error(HELP)
            const project = await attached(ctx, origin)
            if (!active(origin) || ctx.signal.aborted)
              throw new Error("Main session changed. Run this command again.")
            if (verb === "design") {
              const chosenLanguage = await language(project, ctx)
              if (!active(origin) || ctx.signal.aborted)
                throw new Error("Main session changed. Run /project design again.")
              await designs.open(project, ctx, chosenLanguage)
              availableDesigns.add(designKey(project))
              api.requestRender()
            } else {
              states.set(origin, {
                fingerprint: JSON.stringify(attachmentFor(origin, ctx.session.data)),
                project,
              })
              ctx.print(
                localize(
                  displayLanguage(project, (notice) => ctx.print(notice, "warning")),
                  `${project.marker.name}\nDirectory: ${project.root}\nIteration: ${project.marker.currentIteration}\nStage: design\nNext: /project design — open design conversation\nPrototypes, implementation, acceptance, ship and archive: coming later.`,
                  `${project.marker.name}\n目录：${project.root}\n迭代：${project.marker.currentIteration}\n阶段：设计\n下一步：/project design — 打开设计会话\n原型、实现、验收、发布和归档：后续版本提供。`,
                  `${project.marker.name}\nディレクトリ：${project.root}\nイテレーション：${project.marker.currentIteration}\n段階：設計\n次の手順：/project design — 設計会話を開く\nプロトタイプ、実装、受け入れ確認、リリース、アーカイブは今後対応予定です。`,
                ),
              )
              api.requestRender()
            }
          } else if (["prototype", "implement", "accept", "ship", "archive", "iteration"].includes(verb)) {
            ctx.print(
              localize(
                interfaceLanguage(ctx),
                "Coming later: this batch supports project discovery and design only.",
                "后续版本提供：当前批次仅支持项目识别与设计。",
                "今後対応予定です。現在はプロジェクトの検出と設計のみ利用できます。",
              ),
            )
          } else throw new Error(HELP)
        } catch (error) {
          ctx.print(message(error), "error")
        }
      },
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default createProjectExtension()
