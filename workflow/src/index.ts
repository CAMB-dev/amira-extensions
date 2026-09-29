import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type {
  CommandCandidate,
  CommandContext,
  ExtensionAPI,
  PendingNotice,
  SpawnGroup,
  SpawnGroupOptions,
  ToolDefinition,
  ToolPresenter,
  ToolResult,
  UiApi,
  UserMessage,
  ViewDefinition,
  ViewLine,
} from "@amira/api"
import { compileScript } from "./compile.ts"
import { type JournalEntry, listRuns, readJournal, readRun } from "./journal.ts"
import { describeEstimate, estimate, type WorkflowMeta } from "./meta.ts"
import { countsLine, formatDuration, formatTokens, totals, treeLines } from "./progress.ts"
import { loadRoles } from "./roles.ts"
import { type ScriptWorker, WorkflowRun } from "./run.ts"
import { findSaved, listSaved } from "./saved.ts"
import type { RunGit } from "./worktree.ts"

export { compileScript } from "./compile.ts"
export { callHash, Journal, readJournal } from "./journal.ts"
export { estimate, parseMeta, ScriptError } from "./meta.ts"
export { treeLines } from "./progress.ts"
export { WorkflowRun } from "./run.ts"

export const WORKFLOW_TOOL = "workflow"
export const VIEW_KIND = "workflow"

/** settings.json `workflow` (D81). */
export interface WorkflowSettings {
  /**
   * When the model may start a workflow: "explicit" (default) only when the user asked for one
   * (their message mentions a workflow, or they used /workflow); "always"; "never".
   * Every start is still confirmed by the user.
   */
  enabled?: "explicit" | "always" | "never"
  /** Agents a run may start in all. Default 30. */
  maxAgents?: number
  /** Agents of a run working at once. Default 6. */
  maxConcurrent?: number
  /** Tokens and cost a run may spend. Default: no limit of its own (the tree's still applies). */
  budget?: { tokens?: number; costUsd?: number }
}

export const DEFAULT_MAX_AGENTS = 30
export const DEFAULT_MAX_CONCURRENT = 6

/** Whether a user's message asks for a workflow. */
export function asksForWorkflow(text: string): boolean {
  return /\bworkflows?\b/i.test(text) || /工作流/.test(text)
}

function messageText(m: UserMessage): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** "Explore → Verify → Report". */
function phasesLine(meta: WorkflowMeta): string {
  return meta.phases.length ? meta.phases.join(" → ") : "(none declared)"
}

export interface WorkflowExtensionOptions {
  /** Replaces the sandbox Worker, for tests. */
  worker?: () => ScriptWorker
  /** Replaces git, for tests. */
  git?: RunGit
}

interface Launch {
  source: string
  origin: string
  args: unknown
  /** Resuming this run: its id and journal. */
  resume?: { id: string; previous: JournalEntry[]; resumes: number }
  ui: UiApi
  signal?: AbortSignal
  createGroup(opts: SpawnGroupOptions): SpawnGroup
  notice: PendingNotice | undefined
  /** How the result reaches the commander when there is no notice. */
  send?: (message: UserMessage) => void
}

export function createWorkflowExtension(opts: WorkflowExtensionOptions = {}) {
  return (api: ExtensionAPI) => {
    const settings = (): WorkflowSettings => (api.settings as { workflow?: WorkflowSettings }).workflow ?? {}
    const runs = new Map<string, WorkflowRun>()
    /** Which session started each run. */
    const owners = new Map<string, string>()
    let root: string | undefined
    let sessionFile: string | undefined
    /** The user's last message asked for a workflow (or /workflow was used). */
    let explicit = false

    const git: RunGit =
      opts.git ??
      (async (args, cwd, stdoutOnly = false) => {
        const r = await api.runCommand(["git", ...args], {
          cwd,
          timeoutMs: 120_000,
          signal: new AbortController().signal,
          stdoutOnly,
          viaCmd: true,
        })
        return { output: r.output, ok: r.exitCode === 0 }
      })

    /** Where runs are kept: next to the session files, else in Amira's home. */
    const runsRoot = () =>
      sessionFile ? path.join(path.dirname(sessionFile), "workflows") : path.join(api.home, "workflow-runs")

    const loadWorkflow = (name: string) => {
      const saved = findSaved(api.cwd, api.home, name)
      if (!saved) return undefined
      try {
        return readFileSync(saved.file, "utf8")
      } catch {
        return undefined
      }
    }

    const latest = (): WorkflowRun | undefined => [...runs.values()].at(-1)

    const noticeFor = (run: WorkflowRun): UserMessage => {
      const t = totals(run.flow)
      const took = formatDuration((run.endedAt ?? Date.now()) - run.startedAt)
      const ended = run.status === "done" ? "finished" : run.status === "stopped" ? "was stopped" : "failed"
      const head = `Workflow run ${run.id} (${run.meta.name}) ${ended} after ${took}: ${t.agents} agent${t.agents === 1 ? "" : "s"}, ${t.failed} failed, ${formatTokens(t.tokens)} tokens. (Sent automatically; the user did not write this message.)`
      const body =
        run.status === "done"
          ? `Result:\n${JSON.stringify(run.result, null, 2) ?? "null"}`
          : `Error: ${run.error ?? run.status}\nAgents that finished are journaled: resume the run with the workflow tool ({"resume": "${run.id}"}) once the cause is fixed, and they are not run again.`
      return {
        role: "user",
        content: [{ type: "text", text: `${head}\n\n${body}` }],
        display: {
          text: `◆ workflow ${run.meta.name} ${ended} · ${t.agents} agents · ${took} · ${formatTokens(t.tokens)} tok`,
          origin: "workflow",
        },
      }
    }

    const confirmText = (meta: WorkflowMeta, source: string, resume?: Launch["resume"]) => {
      const s = settings()
      const limits = [
        `at most ${s.maxAgents ?? DEFAULT_MAX_AGENTS} agents`,
        `${s.maxConcurrent ?? DEFAULT_MAX_CONCURRENT} at once`,
        s.budget?.tokens !== undefined ? `${formatTokens(s.budget.tokens)} tokens` : "",
        s.budget?.costUsd !== undefined ? `$${s.budget.costUsd}` : "",
      ].filter(Boolean)
      return [
        meta.description,
        `Phases: ${phasesLine(meta)}`,
        `Estimate: ${describeEstimate(estimate(source))}`,
        `Limits: ${limits.join(", ")}`,
        ...(resume ? [`Resumes run ${resume.id}: ${resume.previous.length} journaled results are reused where the script is unchanged.`] : []),
      ].join("\n")
    }

    /** Asks the user, then starts the run in the background. Returns the run, or why it did not start. */
    const launch = async (l: Launch): Promise<WorkflowRun | string> => {
      let meta: WorkflowMeta
      try {
        meta = compileScript(l.source).meta
      } catch (err) {
        return `The script cannot run: ${errorText(err)}`
      }
      const ok = await l.ui.confirm(
        `${l.resume ? "Resume" : "Start"} workflow "${meta.name}"?`,
        confirmText(meta, l.source, l.resume),
        l.signal ? { signal: l.signal } : {},
      )
      if (ok !== true) {
        l.notice?.cancel()
        return ok === false ? "The user declined to start the workflow." : "Nobody confirmed the workflow, so it did not start."
      }
      const s = settings()
      let group: SpawnGroup
      try {
        group = l.createGroup({
          name: `workflow ${meta.name}`,
          maxAgents: s.maxAgents ?? DEFAULT_MAX_AGENTS,
          maxConcurrent: s.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
          ...(s.budget ? { budget: s.budget } : {}),
          compact: true,
        } as SpawnGroupOptions)
      } catch (err) {
        l.notice?.cancel()
        return `The workflow could not start: ${errorText(err)}`
      }
      const id = l.resume?.id ?? `wf_${crypto.randomUUID().slice(0, 8)}`
      let run: WorkflowRun
      try {
        run = new WorkflowRun({
          id,
          dir: path.join(runsRoot(), id),
          source: l.source,
          origin: l.origin,
          args: l.args,
          group,
          cwd: api.cwd,
          home: api.home,
          ...(l.resume ? { previous: l.resume.previous, resumes: l.resume.resumes } : {}),
          ...(s.budget?.tokens !== undefined ? { budgetTokens: s.budget.tokens } : {}),
          roles: () => loadRoles(api.cwd, api.home),
          git,
          loadWorkflow,
          ...(opts.worker ? { worker: opts.worker } : {}),
          onChange: () => {
            setStatus(run)
            api.requestRender()
          },
        })
      } catch (err) {
        group.end("the workflow could not start")
        l.notice?.cancel()
        return `The script cannot run: ${errorText(err)}`
      }
      runs.delete(id)
      runs.set(id, run)
      if (root) owners.set(id, root)
      run.done.then(() => {
        setStatus(run)
        const message = noticeFor(run)
        if (l.notice) l.notice.deliver(message)
        else l.send?.(message)
      })
      run.start()
      setStatus(run)
      return run
    }

    /** The group's one-line status in the transcript: phase and counts. */
    const setStatus = (run: WorkflowRun) => {
      const g = run.group as SpawnGroup & { setStatus?: (text: string) => void }
      const phase = run.flow.current ? `${run.flow.current} · ` : ""
      g.setStatus?.(`${run.id} · ${phase}${countsLine(run.flow)}`)
    }

    /** A run to resume: its stored script and journal. */
    const resumable = (id: string): { source: string; args: unknown; previous: JournalEntry[]; resumes: number } | string => {
      const live = runs.get(id)
      if (live?.status === "running") return `Run ${id} is still running.`
      const dir = [path.join(runsRoot(), id), path.join(api.home, "workflow-runs", id)].find((d) => existsSync(d))
      const stored = dir ? readRun(dir) : undefined
      if (!dir || !stored) return `No workflow run ${id} was found.`
      return {
        source: stored.script,
        args: stored.record.args,
        previous: readJournal(dir),
        resumes: (stored.record.resumes ?? 0) + 1,
      }
    }

    const gate = (): string | undefined => {
      const mode = settings().enabled ?? "explicit"
      if (mode === "never") return "Workflows are turned off in settings (workflow.enabled: never)."
      if (mode === "always" || explicit) return undefined
      return "The user has not asked for a workflow, so none may be started. If a workflow would help (many agents fanning out, verifying each other, or a long pipeline), propose it: describe the plan and its rough size, and let the user ask for it (e.g. by saying so, or with /workflow). Otherwise use the agent tool."
    }

    type Params = { script?: string; name?: string; args?: unknown; resume?: string }
    const tool: ToolDefinition<Params> & { mainOnly: boolean } = {
      name: WORKFLOW_TOOL,
      mainOnly: true,
      description: `Runs a workflow: a TypeScript script that orchestrates many sub-agents (fan-out, verification, pipelines) deterministically, in the background. Only use it when the user asked for a workflow; otherwise propose one. Load the "workflow" skill first for how to write scripts. The script runs in a sandbox with only agent(prompt, {label, phase, schema, role, model, isolation}), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args, budget and workflow(name, args); it starts with \`export const meta = { name, description, phases }\` and its top level ends with \`return result\`. The user confirms every start. The call returns at once with the run's id; the script's return value comes back to you by itself as a message when the run ends: end your turn instead of waiting. Give "script" (the source), or "name" (a saved workflow from .amira/workflows or ~/.amira/workflows), and "args" for the script. "resume" with a run id reruns that run (with "script" or "name" to use an edited script), replaying unchanged agent calls from its journal.`,
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "The workflow script (TypeScript)." },
          name: { type: "string", description: "A saved workflow to run instead of a script." },
          args: { description: "Passed to the script as `args` (any JSON value)." },
          resume: { type: "string", description: "Id of an earlier run to resume (wf_...)." },
        },
      },
      concurrency: "serial",
      async execute(p, ctx) {
        const session = ctx.session
        if (!session?.createGroup || session.depth > 0) {
          return textResult("Workflows can only be started from the main session.", true)
        }
        const refused = gate()
        if (refused) return textResult(refused, true)
        let source = p.script
        let origin = "inline"
        let args = p.args
        let resume: Launch["resume"]
        if (p.resume) {
          const r = resumable(p.resume)
          if (typeof r === "string") return textResult(r, true)
          resume = { id: p.resume, previous: r.previous, resumes: r.resumes }
          source ??= p.name ? undefined : r.source
          args ??= r.args
        }
        if (source === undefined && p.name) {
          const saved = findSaved(api.cwd, api.home, p.name)
          if (!saved) {
            const names = listSaved(api.cwd, api.home).map((w) => w.name)
            return textResult(`No saved workflow "${p.name}". Saved workflows: ${names.join(", ") || "none"}.`, true)
          }
          source = readFileSync(saved.file, "utf8")
          origin = saved.file
        }
        if (source === undefined) return textResult('Give "script", "name" or "resume".', true)
        const notice = session.expectNotice?.()
        const run = await launch({
          source,
          origin,
          args,
          ...(resume ? { resume } : {}),
          ui: api.ui,
          signal: ctx.signal,
          createGroup: (o) => session.createGroup!(o),
          notice,
        })
        if (typeof run === "string") return textResult(run, true)
        return textResult(
          `Started workflow run ${run.id} (${run.meta.name}) in the background. Its result comes to you by itself as a message when it ends: do not wait or poll; end your turn now unless there is other work. The user can watch it with /workflow view ${run.id}.`,
        )
      },
    }

    const presenter: ToolPresenter<Params> = {
      summary(args) {
        if (args.resume) return `· resume ${args.resume}`
        if (args.name) return `· ${args.name}`
        const name = /name\s*:\s*["'`]([^"'`]+)/.exec(args.script ?? "")?.[1]
        return name ? `· ${name}` : "· script"
      },
      result(call) {
        if (call.result.isError) return undefined
        const id = /run (wf_\w+)/.exec(call.text)?.[1]
        return id ? `started ${id} in the background · /workflow view ${id}` : undefined
      },
    }

    type ViewData = { id?: string }
    const runOf = (d: ViewData) => (d.id ? runs.get(d.id) : latest())
    const view: ViewDefinition<ViewData> = {
      kind: VIEW_KIND,
      title(d) {
        const run = runOf(d)
        return run ? `Workflow ${run.meta.name} · ${run.id} · ${run.status}` : "Workflow"
      },
      header(d, o) {
        const run = runOf(d)
        if (!run) return [{ kind: "muted", text: "No workflow has run in this session." }]
        const took = formatDuration((run.endedAt ?? o.now) - run.startedAt)
        return [
          { kind: "muted", text: run.meta.description },
          { kind: "text", text: `${countsLine(run.flow)} · ${took}` },
          ...(run.error ? [{ kind: "error" as const, text: run.error }] : []),
        ]
      },
      render(d, o) {
        const run = runOf(d)
        if (!run) return []
        const lines: ViewLine[] = treeLines(run.flow, o.now)
        if (run.logs.length) {
          lines.push({ kind: "text", text: "" }, { kind: "muted", text: "Log" })
          for (const l of run.logs.slice(-50)) {
            lines.push({ kind: l.level === "info" ? "text" : l.level, text: `  ${l.nest ? `[${l.nest.split("#")[0]}] ` : ""}${l.text}` })
          }
        }
        return lines
      },
      keys: [
        {
          key: "x",
          label: "stop",
          run(d, v) {
            runOf(d)?.stop()
            v.requestRender()
          },
        },
      ],
      follow: false,
    }

    const listText = () => {
      const saved = listSaved(api.cwd, api.home)
      const lines = ["Saved workflows (run with /workflow <name> [args]):"]
      if (!saved.length) lines.push("  none (save scripts in .amira/workflows/*.ts or ~/.amira/workflows/*.ts)")
      for (const w of saved) {
        lines.push(`  ${w.name} (${w.scope})${w.meta ? ` - ${w.meta.description}` : ` - cannot read: ${w.problem}`}`)
      }
      const recent = [...runs.values()].reverse()
      const stored = listRuns(runsRoot()).filter((r) => !runs.has(r.id))
      if (recent.length || stored.length) {
        lines.push("Runs:")
        for (const r of recent) lines.push(`  ${r.id} ${r.meta.name} · ${r.status} · ${countsLine(r.flow)}`)
        for (const r of stored.slice(0, 10)) lines.push(`  ${r.id} ${r.meta.name} · ${r.status} (earlier)`)
      }
      lines.push("Also: /workflow view [id], /workflow stop [id], /workflow resume <id>, /workflow <task> to ask for a workflow.")
      return lines.join("\n")
    }

    /** `/workflow <name> [args]`: args as JSON when they parse, else the text itself. */
    const parseArgs = (text: string): unknown => {
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }

    const commandLaunch = async (ctx: CommandContext, l: Omit<Launch, "ui" | "createGroup" | "notice" | "send">) => {
      const control = ctx.session as typeof ctx.session & { expectNotice?: () => PendingNotice }
      if (!control.createGroup) throw new Error("workflows need an agent tree, which this frontend does not have")
      const notice = control.expectNotice?.()
      const run = await launch({
        ...l,
        ui: ctx.ui,
        signal: ctx.signal,
        createGroup: (o) => control.createGroup!(o),
        notice,
        send: (m) => void ctx.session.send(messageText(m), m.display ? { display: m.display } : {}).catch(() => {}),
      })
      if (typeof run === "string") ctx.print(run, "warning")
      else ctx.print(`Started workflow run ${run.id} (${run.meta.name}); /workflow view ${run.id} shows its progress.`)
    }

    api.registerCommand({
      name: "workflow",
      description: "Run a saved workflow, ask for one, or watch and stop runs",
      args: {
        hint: "[name [args] | view [id] | stop [id] | resume <id> | task]",
        complete: (): CommandCandidate[] => [
          ...listSaved(api.cwd, api.home).map((w) => ({ value: w.name, ...(w.meta ? { description: w.meta.description } : {}) })),
          { value: "view", description: "show a run's progress tree" },
          { value: "stop", description: "stop a run" },
          { value: "resume", description: "resume a run from its journal" },
          { value: "list", description: "saved workflows and runs" },
        ],
      },
      async run(text, ctx) {
        const [first = "", ...rest] = text.split(/\s+/)
        const tail = text.slice(first.length).trim()
        if (!first || first === "list") {
          ctx.print(listText())
          return
        }
        if (first === "view") {
          const id = rest[0]
          const run = id ? runs.get(id) : latest()
          if (!run) throw new Error(id ? `no workflow run ${id} in this session` : "no workflow has run in this session")
          if (!ctx.openView) {
            ctx.print(`${run.meta.name} ${run.id} · ${run.status} · ${countsLine(run.flow)}`)
            return
          }
          ctx.openView({ kind: VIEW_KIND, data: { id: run.id } })
          return
        }
        if (first === "stop") {
          const id = rest[0]
          const run = id ? runs.get(id) : [...runs.values()].reverse().find((r) => r.status === "running")
          if (!run?.stop()) throw new Error(id ? `workflow run ${id} is not running` : "no workflow is running")
          ctx.print(`Stopped workflow run ${run.id}.`)
          return
        }
        if (first === "resume") {
          const id = rest[0]
          if (!id) throw new Error("usage: /workflow resume <run id>")
          const r = resumable(id)
          if (typeof r === "string") throw new Error(r)
          const newer = rest.length > 1 ? parseArgs(rest.slice(1).join(" ")) : undefined
          await commandLaunch(ctx, {
            source: r.source,
            origin: "resume",
            args: newer ?? r.args,
            resume: { id, previous: r.previous, resumes: r.resumes },
          })
          return
        }
        const saved = findSaved(api.cwd, api.home, first)
        if (saved) {
          await commandLaunch(ctx, {
            source: readFileSync(saved.file, "utf8"),
            origin: saved.file,
            args: parseArgs(tail),
          })
          return
        }
        // Not a saved workflow: a task the user wants done with one.
        explicit = true
        await ctx.session.send(`Use a workflow (the workflow tool) for this task: ${text}`, {
          display: { text: `/workflow ${text}` },
        })
      },
    })

    api.registerView(view)
    api.registerTool(tool)
    api.registerToolRenderer(WORKFLOW_TOOL, presenter)
    api.registerStatusItem({
      id: "workflow",
      align: "right",
      tone: "accent",
      text() {
        const live = [...runs.values()].filter((r) => r.status === "running")
        if (!live.length) return undefined
        const r = live.at(-1)!
        const t = totals(r.flow)
        return `workflow ${r.meta.name} ${t.finished}/${t.agents}${live.length > 1 ? ` (+${live.length - 1})` : ""}`
      },
    })

    api.on("session.start", (e) => {
      if (e.parentSessionId !== undefined) return
      if (root && root !== e.sessionId) {
        // Another conversation took over (/clear, /resume): its runs have nobody to report to.
        for (const [id, owner] of owners) if (owner !== e.sessionId) runs.get(id)?.stop("its session was closed")
      }
      root = e.sessionId
      if (e.data.sessionFile) sessionFile = e.data.sessionFile
      explicit = false
    })
    api.on("session.end", () => {
      for (const r of runs.values()) r.stop("the session ended")
    })
    api.on("turn.start", (e) => {
      if (e.parentSessionId !== undefined || e.sessionId !== root) return
      const prompt = e.data.prompt
      // A notice (a sub-agent's or a workflow's result) is not the user asking.
      if (prompt.display?.origin) return
      explicit = asksForWorkflow(messageText(prompt)) || asksForWorkflow(prompt.display?.text ?? "")
    })
    api.on("turn.steer", (e) => {
      if (e.parentSessionId !== undefined || e.sessionId !== root || e.data.state !== "queued") return
      const m = e.data.message
      if (!m.display?.origin && asksForWorkflow(messageText(m))) explicit = true
    })
    api.on("group.update", (e) => {
      for (const r of runs.values()) if (r.group.id === e.data.group.id) r.budgetChanged(e.data.group.tokens)
    })
  }
}

export default createWorkflowExtension()
