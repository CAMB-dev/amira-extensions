import { createHash } from "node:crypto"
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
import { describeEstimate, estimate, readMeta, type WorkflowMeta } from "./meta.ts"
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

/** settings.json `extensions.workflow` (D81). */
export interface WorkflowSettings {
  /**
   * How a workflow starts: "ask" (default) asks the user to confirm every start, which is the
   * gate; "always" starts without asking; "never" starts none. ("explicit", the setting's
   * earlier default, reads as "ask".)
   */
  enabled?: "ask" | "always" | "never"
  /** Agents a run may start in all. Default 30. */
  maxAgents?: number
  /** Agents of a run working at once. Default 6. */
  maxConcurrent?: number
  /** Tokens and cost a run may spend. Default: no limit of its own (the tree's still applies). */
  budget?: { tokens?: number; costUsd?: number }
}

export const DEFAULT_MAX_AGENTS = 30
export const DEFAULT_MAX_CONCURRENT = 6

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined

/**
 * The `extensions.workflow` section of settings.json, checked: a field that does not fit is reported and
 * left at its default.
 */
export function readSettings(raw: unknown, report: (error: string) => void = () => {}): WorkflowSettings {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    report("settings: extensions.workflow must be an object; using the defaults")
    return {}
  }
  const r = raw as Record<string, unknown>
  const out: WorkflowSettings = {}
  const bad = (field: string, want: string) =>
    report(`settings: extensions.workflow.${field} must be ${want}; using the default`)
  if (r.enabled !== undefined) {
    if (r.enabled === "ask" || r.enabled === "always" || r.enabled === "never") out.enabled = r.enabled
    else if (r.enabled === "explicit") out.enabled = "ask"
    else bad("enabled", '"ask", "always" or "never"')
  }
  for (const key of ["maxAgents", "maxConcurrent"] as const) {
    if (r[key] === undefined) continue
    const n = positive(r[key])
    if (n !== undefined) out[key] = Math.floor(n)
    else bad(key, "a positive number")
  }
  if (r.budget !== undefined) {
    const b = r.budget && typeof r.budget === "object" ? (r.budget as Record<string, unknown>) : undefined
    const tokens = positive(b?.tokens)
    const costUsd = positive(b?.costUsd)
    if (
      !b ||
      (b.tokens !== undefined && tokens === undefined) ||
      (b.costUsd !== undefined && costUsd === undefined)
    ) {
      bad("budget", "{ tokens?, costUsd? } with positive numbers")
    } else if (tokens !== undefined || costUsd !== undefined) {
      out.budget = {
        ...(tokens !== undefined ? { tokens: Math.floor(tokens) } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      }
    }
  }
  return out
}

/**
 * "use a workflow", "run this as a workflow", "with a workflow", "via workflows": a verb or
 * preposition of using one, then the word. The bare word is not enough: "fix the failing
 * GitHub Actions workflow" or "our git workflow" do not ask for one. It no longer gates
 * anything: it tells the confirmation who wants the run, and lets a declined workflow be
 * proposed again.
 */
const ASK_EN =
  /\b(?:use|using|run|start|launch|kick off|spin up|do|try|with|via|through|as)\s+(?:(?:it|this|that|these|them|everything|the task|the work)\s+(?:as|with|via|through|using|in)\s+)?(?:(?:a|an|one|another|new|dynamic|multi-agent|small|big|quick)\s+)*workflows?\b/i
/** The tool or the command by name. */
const ASK_NAMED = /\bworkflow tool\b|(?:^|\s)\/workflow\b/i
/** 用工作流, 使用一个工作流, 通过 workflow, 启动工作流, 跑个工作流 ... */
const ASK_ZH =
  /(?:用|使用|采用|通过|借助|以|启动|开启|开|跑|运行)\s*(?:个|一个|一下|下)?\s*(?:工作流|workflow)/i

/** Whether a user's message asks for a workflow (see ASK_EN). */
export function asksForWorkflow(text: string): boolean {
  return ASK_EN.test(text) || ASK_NAMED.test(text) || ASK_ZH.test(text)
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
  /**
   * Who wants the run: "user" when they ran /workflow or their latest message asks for a
   * workflow, else "model" (the model proposes it). Shown in the confirmation.
   */
  initiator: "user" | "model"
  /** Resuming this run: its id and journal. */
  resume?: { id: string; dir: string; previous: JournalEntry[]; resumes: number }
  ui: UiApi
  signal?: AbortSignal
  createGroup(opts: SpawnGroupOptions): SpawnGroup
  /**
   * Takes the notice the result is delivered as. Called only once the run starts: a pending
   * notice keeps print and RPC mode waiting, so one taken for a run that never starts would
   * keep them waiting forever.
   */
  expectNotice(): PendingNotice | undefined
  /** How the result reaches the commander when there is no notice. */
  send?: (message: UserMessage) => void
}

export function createWorkflowExtension(opts: WorkflowExtensionOptions = {}) {
  return (api: ExtensionAPI) => {
    const reported = new Set<string>()
    const settings = (): WorkflowSettings =>
      readSettings(api.settings.extensions?.workflow, (error) => {
        if (reported.has(error)) return
        reported.add(error)
        api.reportError(error)
      })
    const runs = new Map<string, WorkflowRun>()
    /** Which session started each run. */
    const owners = new Map<string, string>()
    let root: string | undefined
    let sessionFile: string | undefined
    /** The user's last message asked for a workflow (or /workflow was used). */
    let explicit = false
    /**
     * Workflows the user turned down in this session, by `name:<meta.name>` and
     * `hash:<hash of the script after its meta>` (so a renamed copy is the same workflow): the
     * model may not propose them again unless the user asks.
     */
    const declined = new Set<string>()
    const declineKeys = (meta: WorkflowMeta, source: string) => {
      let body = source
      try {
        body = source.slice(readMeta(source).end)
      } catch {}
      return [`name:${meta.name}`, `hash:${createHash("sha256").update(body.trim()).digest("hex")}`]
    }

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

    const confirmText = (
      meta: WorkflowMeta,
      source: string,
      initiator: Launch["initiator"],
      resume?: Launch["resume"],
    ) => {
      const s = settings()
      const limits = [
        `at most ${s.maxAgents ?? DEFAULT_MAX_AGENTS} agents`,
        `${s.maxConcurrent ?? DEFAULT_MAX_CONCURRENT} at once`,
        s.budget?.tokens !== undefined ? `${formatTokens(s.budget.tokens)} tokens` : "",
        s.budget?.costUsd !== undefined ? `$${s.budget.costUsd}` : "",
      ].filter(Boolean)
      return [
        initiator === "user" ? "You asked for this workflow." : "The model proposes this workflow.",
        meta.description,
        `Phases: ${phasesLine(meta)}`,
        `Estimate: ${describeEstimate(estimate(source))}`,
        `Limits: ${limits.join(", ")}`,
        ...(resume
          ? [
              `Resumes run ${resume.id}: ${resume.previous.length} journaled results are reused where the script is unchanged.`,
            ]
          : []),
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
      const s = settings()
      const mode = s.enabled ?? "ask"
      if (mode === "never")
        return "Workflows are turned off in settings (extensions.workflow.enabled: never)."
      const keys = declineKeys(meta, l.source)
      if (l.initiator === "model" && keys.some((k) => declined.has(k))) {
        return `The user already declined the workflow "${meta.name}" in this session, so it was not proposed again. Do not propose it again, renamed or reworded; carry on without it (e.g. with the agent tool) unless the user asks for a workflow.`
      }
      if (mode === "ask") {
        const ok = await l.ui.confirm(
          `${l.resume ? "Resume" : "Start"} workflow "${meta.name}"?`,
          confirmText(meta, l.source, l.initiator, l.resume),
          l.signal ? { signal: l.signal } : {},
        )
        if (ok !== true) {
          for (const k of keys) declined.add(k)
          if (ok === false) {
            return `The user declined the workflow "${meta.name}", so it did not start. Do not propose it again in this session unless the user asks for it; carry on without it (e.g. with the agent tool), or ask the user how they want to proceed.`
          }
          const how =
            l.origin === "inline" || l.origin === "resume"
              ? `save the script as .amira/workflows/${meta.name}.ts and run /workflow ${meta.name}`
              : `run /workflow ${meta.name}`
          return `Nobody confirmed the workflow "${meta.name}", so it did not start: the confirmation was dismissed, or nobody can answer it here (print mode, or an rpc client that does not answer dialogs). Do not propose it again in this session unless the user asks. To start it themselves, the user can ${how} in the interactive UI, or set extensions.workflow.enabled to "always" in settings.json to start workflows without confirming.`
        }
      }
      let group: SpawnGroup
      try {
        group = l.createGroup({
          name: `workflow ${meta.name}`,
          maxAgents: s.maxAgents ?? DEFAULT_MAX_AGENTS,
          maxConcurrent: s.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
          ...(s.budget ? { budget: s.budget } : {}),
          compact: true,
        })
      } catch (err) {
        return `The workflow could not start: ${errorText(err)}`
      }
      const id = l.resume?.id ?? `wf_${crypto.randomUUID().slice(0, 8)}`
      let run: WorkflowRun
      try {
        run = new WorkflowRun({
          id,
          // A resumed run stays where it was, so its journal keeps every attempt's results.
          dir: l.resume?.dir ?? path.join(runsRoot(), id),
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
        return `The script cannot run: ${errorText(err)}`
      }
      runs.delete(id)
      runs.set(id, run)
      if (root) owners.set(id, root)
      const notice = l.expectNotice()
      run.done.then(() => {
        setStatus(run)
        const message = noticeFor(run)
        if (notice) notice.deliver(message)
        else l.send?.(message)
      })
      run.start()
      setStatus(run)
      return run
    }

    /** The group's one-line status in the transcript: phase and counts. */
    const setStatus = (run: WorkflowRun) => {
      const phase = run.flow.current ? `${run.flow.current} · ` : ""
      run.group.setStatus(`${run.id} · ${phase}${countsLine(run.flow)}`)
    }

    /** A run to resume: its stored script and journal. */
    const resumable = (
      id: string,
    ): { dir: string; source: string; args: unknown; previous: JournalEntry[]; resumes: number } | string => {
      const live = runs.get(id)
      if (live?.status === "running") return `Run ${id} is still running.`
      const dir = [path.join(runsRoot(), id), path.join(api.home, "workflow-runs", id)].find((d) =>
        existsSync(d),
      )
      const stored = dir ? readRun(dir) : undefined
      if (!dir || !stored) return `No workflow run ${id} was found.`
      return {
        dir,
        source: stored.script,
        args: stored.record.args,
        previous: readJournal(dir),
        resumes: (stored.record.resumes ?? 0) + 1,
      }
    }

    type Params = { script?: string; name?: string; args?: unknown; resume?: string }
    const tool: ToolDefinition<Params> = {
      name: WORKFLOW_TOOL,
      mainOnly: true,
      description: `Runs a workflow: a TypeScript script that orchestrates many sub-agents (fan-out, verification, pipelines) deterministically, in the background. Use it when a workflow clearly helps (many agents fanning out, checking each other's work, or a long pipeline); for one or two sub-agents use the agent tool. Calling it proposes the workflow: the user sees its name, description, phases and estimated size and approves or declines it. When the user declines one, do not call it again for the same workflow unless they ask. Load the "workflow" skill first for how to write scripts. The script runs in a sandbox with only agent(prompt, {label, phase, schema, role, model, isolation}), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args, budget and workflow(name, args); it starts with \`export const meta = { name, description, phases }\` and its top level ends with \`return result\`. The call returns at once with the run's id; the script's return value comes back to you by itself as a message when the run ends: end your turn instead of waiting. Give "script" (the source), or "name" (a saved workflow from .amira/workflows or ~/.amira/workflows), and "args" for the script. "resume" with a run id reruns that run (with "script" or "name" to use an edited script), replaying unchanged agent calls from its journal.`,
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
        let source = p.script
        let origin = "inline"
        let args = p.args
        let resume: Launch["resume"]
        if (p.resume) {
          const r = resumable(p.resume)
          if (typeof r === "string") return textResult(r, true)
          resume = { id: p.resume, dir: r.dir, previous: r.previous, resumes: r.resumes }
          source ??= p.name ? undefined : r.source
          args ??= r.args
        }
        if (source === undefined && p.name) {
          const saved = findSaved(api.cwd, api.home, p.name)
          if (!saved) {
            const names = listSaved(api.cwd, api.home).map((w) => w.name)
            return textResult(
              `No saved workflow "${p.name}". Saved workflows: ${names.join(", ") || "none"}.`,
              true,
            )
          }
          source = readFileSync(saved.file, "utf8")
          origin = saved.file
        }
        if (source === undefined) return textResult('Give "script", "name" or "resume".', true)
        const run = await launch({
          source,
          origin,
          args,
          initiator: explicit ? "user" : "model",
          ...(resume ? { resume } : {}),
          ui: api.ui,
          signal: ctx.signal,
          createGroup: (o) => session.createGroup!(o),
          expectNotice: () => session.expectNotice?.(),
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
            lines.push({
              kind: l.level === "info" ? "text" : l.level,
              text: `  ${l.nest ? `[${l.nest.split("#")[0]}] ` : ""}${l.text}`,
            })
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
      if (!saved.length)
        lines.push("  none (save scripts in .amira/workflows/*.ts or ~/.amira/workflows/*.ts)")
      for (const w of saved) {
        lines.push(
          `  ${w.name} (${w.scope})${w.meta ? ` - ${w.meta.description}` : ` - cannot read: ${w.problem}`}`,
        )
      }
      const recent = [...runs.values()].reverse()
      const stored = listRuns(runsRoot()).filter((r) => !runs.has(r.id))
      if (recent.length || stored.length) {
        lines.push("Runs:")
        for (const r of recent) lines.push(`  ${r.id} ${r.meta.name} · ${r.status} · ${countsLine(r.flow)}`)
        for (const r of stored.slice(0, 10)) lines.push(`  ${r.id} ${r.meta.name} · ${r.status} (earlier)`)
      }
      lines.push(
        "Also: /workflow view [id], /workflow stop [id], /workflow resume <id>, /workflow <task> to ask for a workflow.",
      )
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

    const commandLaunch = async (
      ctx: CommandContext,
      l: Omit<Launch, "ui" | "createGroup" | "expectNotice" | "send" | "initiator">,
    ) => {
      const control = ctx.session
      if (!control.createGroup)
        throw new Error("workflows need an agent tree, which this frontend does not have")
      const run = await launch({
        ...l,
        initiator: "user",
        ui: ctx.ui,
        signal: ctx.signal,
        createGroup: (o) => control.createGroup!(o),
        expectNotice: () => control.expectNotice?.(),
        send: (m) =>
          void ctx.session.send(messageText(m), m.display ? { display: m.display } : {}).catch(() => {}),
      })
      if (typeof run === "string") ctx.print(run, "warning")
      else
        ctx.print(
          `Started workflow run ${run.id} (${run.meta.name}); /workflow view ${run.id} shows its progress.`,
        )
    }

    api.registerCommand({
      name: "workflow",
      description: "Run a saved workflow, ask for one, or watch and stop runs",
      args: {
        hint: "[name [args] | view [id] | stop [id] | resume <id> | task]",
        complete: (): CommandCandidate[] => [
          ...listSaved(api.cwd, api.home).map((w) => ({
            value: w.name,
            ...(w.meta ? { description: w.meta.description } : {}),
          })),
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
          if (!run)
            throw new Error(
              id ? `no workflow run ${id} in this session` : "no workflow has run in this session",
            )
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
          if (!run?.stop())
            throw new Error(id ? `workflow run ${id} is not running` : "no workflow is running")
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
            resume: { id, dir: r.dir, previous: r.previous, resumes: r.resumes },
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
        for (const [id, owner] of owners)
          if (owner !== e.sessionId) runs.get(id)?.stop("its session was closed")
      }
      root = e.sessionId
      if (e.data.sessionFile) sessionFile = e.data.sessionFile
      explicit = false
      declined.clear()
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
