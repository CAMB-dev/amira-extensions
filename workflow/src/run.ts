import type { ChildSession, JSONSchema, SpawnGroup, SubagentResult } from "@amira/api"
import { compileScript } from "./compile.ts"
import { callHash, Journal, type JournalEntry, type RunRecord, type RunStatus, writeRun } from "./journal.ts"
import type { WorkflowMeta } from "./meta.ts"
import { type AgentNode, type FlowNode, newFlow, phaseOf } from "./progress.ts"
import type { AgentOpts, HostMessage, WorkerMessage } from "./protocol.ts"
import type { Role } from "./roles.ts"
import { createWorktree, finishWorktree, type RunGit } from "./worktree.ts"

/** The Worker a run's script runs in; replaceable in tests. */
export interface ScriptWorker {
  postMessage(m: HostMessage): void
  onmessage: ((e: { data: WorkerMessage }) => void) | null
  onerror: ((e: { message?: string }) => void) | null
  terminate(): void
}

export function sandboxWorker(): ScriptWorker {
  return new Worker(new URL("./sandbox-worker.ts", import.meta.url).href) as unknown as ScriptWorker
}

export interface RunOptions {
  id: string
  /** Where run.json, script.ts and journal.jsonl go. */
  dir: string
  source: string
  /** The script's origin: a saved workflow's file, or "inline". */
  origin: string
  args: unknown
  group: SpawnGroup
  cwd: string
  home: string
  /** Journaled results of an earlier attempt of this run. */
  previous?: JournalEntry[]
  resumes?: number
  /** Token budget the script sees as budget.total. */
  budgetTokens?: number
  roles(): Map<string, Role>
  git: RunGit
  /** A saved workflow's source by name, for workflow(name, args). */
  loadWorkflow(name: string): string | undefined
  worker?: () => ScriptWorker
  /** Progress changed: redraw. */
  onChange(): void
}

export interface LogLine {
  level: "info" | "warning" | "error"
  text: string
  nest?: string
}

const WORKER_INSTRUCTIONS =
  "You are a sub-agent run by a workflow script: the task in the user message is one step of a larger plan. Work on your own; nobody will answer questions, so make reasonable assumptions and state them. Your final reply is the step's result and is all the workflow sees of your work, so make it complete and self-contained."

function label(prompt: string, given: unknown): string {
  if (typeof given === "string" && given.trim()) return given.replace(/\s+/g, " ").trim().slice(0, 60)
  const words = prompt.replace(/\s+/g, " ").trim().split(" ")
  const head = words.slice(0, 5).join(" ")
  return words.length > 5 ? `${head.slice(0, 40)}…` : head.slice(0, 40)
}

/** The fields of agent()'s options this run understands, checked. */
function cleanOpts(o: AgentOpts): AgentOpts | string {
  const out: AgentOpts = {}
  if (o.label !== undefined) out.label = String(o.label)
  if (o.phase !== undefined) out.phase = String(o.phase)
  if (o.role !== undefined) out.role = String(o.role)
  if (o.model !== undefined) {
    if (typeof o.model !== "string" || !/^[^/]+\/.+/.test(o.model))
      return 'opts.model must look like "provider/model"'
    out.model = o.model
  }
  if (o.isolation !== undefined) {
    if (o.isolation !== "none" && o.isolation !== "worktree")
      return 'opts.isolation must be "none" or "worktree"'
    out.isolation = o.isolation
  }
  if (o.schema !== undefined) {
    if (!o.schema || typeof o.schema !== "object" || Array.isArray(o.schema))
      return "opts.schema must be a JSON Schema object"
    out.schema = o.schema
  }
  return out
}

/**
 * One run of a workflow script: its Worker, the spawn group its agents run in, the journal
 * of their results and the progress tree frontends show.
 */
export class WorkflowRun {
  readonly id: string
  readonly meta: WorkflowMeta
  readonly flow: FlowNode
  readonly logs: LogLine[] = []
  readonly startedAt = Date.now()
  readonly journal: Journal
  status: RunStatus = "running"
  endedAt: number | undefined
  result: unknown
  error: string | undefined
  #opts: RunOptions
  #code: string
  #worker: ScriptWorker | undefined
  #delivered = 0
  #nests = new Map<string, FlowNode>()
  #nestCount = 0
  #live = new Set<ChildSession>()
  #spent = 0
  #finished!: (r: RunRecord) => void
  readonly done: Promise<RunRecord>

  constructor(opts: RunOptions) {
    this.#opts = opts
    this.id = opts.id
    const compiled = compileScript(opts.source)
    this.meta = compiled.meta
    this.#code = compiled.code
    this.flow = newFlow(this.meta.name, this.meta.phases)
    this.journal = new Journal(opts.dir, opts.previous ?? [])
    this.done = new Promise((resolve) => {
      this.#finished = resolve
    })
  }

  get group(): SpawnGroup {
    return this.#opts.group
  }

  get record(): RunRecord {
    return {
      id: this.id,
      meta: this.meta,
      args: this.#opts.args,
      source: this.#opts.origin,
      status: this.status,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.status === "done" ? { result: this.result } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.#opts.resumes ? { resumes: this.#opts.resumes } : {}),
    }
  }

  start(): void {
    writeRun(this.#opts.dir, this.record, this.#opts.source)
    const worker = (this.#opts.worker ?? sandboxWorker)()
    this.#worker = worker
    worker.onmessage = (e) => void this.#handle(e.data)
    worker.onerror = (e) =>
      this.#end("error", undefined, `the script crashed: ${e.message ?? "unknown error"}`)
    const total = this.#opts.budgetTokens
    this.#post({
      t: "run",
      code: this.#code,
      args: this.#opts.args ?? null,
      budgetTotal: total ?? null,
      spent: 0,
    })
  }

  /** Stops the run: its agents are stopped and the script is ended where it is. */
  stop(reason = "stopped by the user"): boolean {
    if (this.status !== "running") return false
    this.#end("stopped", undefined, reason)
    return true
  }

  /** The group's token use changed: the script's budget.spent() follows it. */
  budgetChanged(tokens: number): void {
    if (tokens === this.#spent || this.status !== "running") return
    this.#spent = tokens
    this.#post({ t: "budget", spent: tokens })
  }

  #post(m: HostMessage) {
    try {
      this.#worker?.postMessage(m)
    } catch {}
  }

  #reply(id: number, r: { ok: true; value: unknown } | { ok: false; error: string }) {
    if (this.status !== "running") return
    this.#delivered++
    this.#post({ ...r, t: "result", id, spent: this.#spent } as HostMessage)
  }

  #log(level: LogLine["level"], text: string, nest?: string) {
    this.logs.push({ level, text, ...(nest ? { nest } : {}) })
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500)
    this.#opts.onChange()
  }

  #flowOf(nest: string | undefined): FlowNode {
    return (nest && this.#nests.get(nest)) || this.flow
  }

  async #handle(m: WorkerMessage) {
    if (this.status !== "running") return
    switch (m.t) {
      case "phase": {
        const flow = this.#flowOf(m.nest)
        flow.current = m.title
        phaseOf(flow, m.title)
        this.#opts.onChange()
        break
      }
      case "log":
        this.#log(m.level, m.msg, m.nest)
        break
      case "agent":
        await this.#agent(m)
        break
      case "workflow":
        this.#nested(m)
        break
      case "nestEnd": {
        const node = this.#nests.get(m.nest)
        if (node) node.state = m.ok ? "done" : "error"
        this.#log(
          m.ok ? "info" : "warning",
          `workflow ${node?.name ?? m.nest} ${m.ok ? "finished" : "failed"}`,
        )
        break
      }
      case "done":
        this.#end("done", m.value)
        break
      case "error":
        this.#end("error", undefined, m.message)
        break
    }
  }

  #nested(m: Extract<WorkerMessage, { t: "workflow" }>) {
    const source = this.#opts.loadWorkflow(m.name)
    if (source === undefined) {
      this.#reply(m.id, {
        ok: false,
        error: `no saved workflow named "${m.name}" (in .amira/workflows or ~/.amira/workflows)`,
      })
      return
    }
    let compiled: ReturnType<typeof compileScript>
    try {
      compiled = compileScript(source)
    } catch (err) {
      this.#reply(m.id, {
        ok: false,
        error: `workflow "${m.name}": ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    const nest = `${compiled.meta.name}#${++this.#nestCount}`
    const node = newFlow(compiled.meta.name, compiled.meta.phases)
    this.#nests.set(nest, node)
    phaseOf(this.flow, this.flow.current).items.push(node)
    this.#log("info", `workflow ${compiled.meta.name} started`)
    this.#reply(m.id, { ok: true, value: { code: compiled.code, args: m.args, name: nest } })
  }

  async #agent(m: Extract<WorkerMessage, { t: "agent" }>) {
    const opts = cleanOpts(m.opts ?? {})
    if (typeof opts === "string") {
      this.#reply(m.id, { ok: false, error: opts })
      return
    }
    const flow = this.#flowOf(m.nest)
    const node: AgentNode = {
      kind: "agent",
      call: m.id,
      label: label(m.prompt, opts.label),
      status: "queued",
      tokens: 0,
    }
    phaseOf(flow, opts.phase ?? flow.current).items.push(node)
    const key = this.journal.key(callHash(m.prompt, opts, m.nest))
    const hit = this.journal.replay(key, m.seen, this.#delivered)
    if (hit) {
      node.status = "cached"
      node.tokens = hit.tokens
      if (hit.cost !== undefined) node.cost = hit.cost
      this.#opts.onChange()
      this.#reply(m.id, { ok: true, value: opts.schema ? hit.value : hit.text })
      return
    }
    const role = opts.role ? this.#opts.roles().get(opts.role) : undefined
    if (opts.role && !role) {
      node.status = "error"
      node.note = `unknown role ${opts.role}`
      this.#opts.onChange()
      this.#reply(m.id, {
        ok: false,
        error: `unknown role "${opts.role}"; known roles: ${[...this.#opts.roles().keys()].join(", ")}`,
      })
      return
    }
    const isolation = opts.isolation ?? role?.isolation ?? "none"
    let wt: Awaited<ReturnType<typeof createWorktree>> | undefined
    if (isolation === "worktree") {
      wt = await createWorktree(this.#opts.git, {
        cwd: this.#opts.cwd,
        home: this.#opts.home,
        name: `${this.id}_${m.id}`,
      })
      if ("error" in wt) {
        this.#log(
          "warning",
          `${node.label}: no worktree (${wt.error}); it works in the shared directory`,
          m.nest,
        )
        wt = undefined
      }
      if (this.status !== "running") return
    }
    const tree = wt && !("error" in wt) ? wt : undefined
    let child: ChildSession
    try {
      child = this.#opts.group.spawn({
        title: node.label,
        prompt: m.prompt,
        ...(opts.role ? { role: opts.role } : {}),
        ...((opts.model ?? role?.model) ? { model: opts.model ?? role?.model } : {}),
        ...(role?.tools ? { tools: role.tools } : {}),
        ...(opts.schema ? { schema: opts.schema as JSONSchema } : {}),
        ...(tree ? { cwd: tree.cwd } : {}),
        systemPrompt: [
          WORKER_INSTRUCTIONS,
          tree
            ? `You work in your own git worktree (${tree.cwd}); when you finish, your changes are merged into the main working tree.`
            : "",
          role?.prompt ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      })
    } catch (err) {
      node.status = "error"
      node.note = err instanceof Error ? err.message : String(err)
      if (tree) await finishWorktree(this.#opts.git, tree, false)
      this.#opts.onChange()
      this.#reply(m.id, { ok: false, error: `agent "${node.label}" could not start: ${node.note}` })
      return
    }
    node.childId = child.id
    this.#live.add(child)
    this.#opts.onChange()
    const watching = this.#watch(child, node)
    const r: SubagentResult = await child.result()
    await watching
    this.#live.delete(child)
    node.status = r.status === "done" ? "done" : r.status
    node.durationMs = r.durationMs
    node.tokens = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite
    if (r.usage.cost !== undefined) node.cost = r.usage.cost
    if (tree) {
      const line = await finishWorktree(this.#opts.git, tree, r.status === "done")
      node.note = line
      this.#log(
        line.includes("NOT merged") || line.includes("kept") ? "warning" : "info",
        `${node.label}: ${line}`,
        m.nest,
      )
    }
    if (r.status !== "done") node.note = r.error ?? r.status
    this.#opts.onChange()
    if (r.status === "done") {
      this.journal.record({
        key,
        label: node.label,
        ...((opts.phase ?? flow.current) ? { phase: opts.phase ?? flow.current } : {}),
        ...(m.nest ? { nest: m.nest } : {}),
        text: r.text,
        ...(r.value !== undefined ? { value: r.value } : {}),
        tokens: node.tokens,
        ...(node.cost !== undefined ? { cost: node.cost } : {}),
        durationMs: r.durationMs,
        sessionId: r.sessionId,
      })
      this.#reply(m.id, { ok: true, value: opts.schema ? r.value : r.text })
    } else {
      this.#reply(m.id, {
        ok: false,
        error: `agent "${node.label}" ${r.status === "aborted" ? "was stopped" : "failed"}: ${r.error ?? r.status}`,
      })
    }
  }

  /** Follows a child for the progress tree: when it starts working and the tokens it (and its own sub-agents) use. */
  async #watch(child: ChildSession, node: AgentNode) {
    for await (const e of child.events) {
      if (e.type === "session.start" && e.sessionId === child.id) {
        node.status = "working"
        node.startedAt = e.ts
        this.#opts.onChange()
      } else if (e.type === "message.end") {
        const u = e.data.message.usage
        if (!u) continue
        node.tokens += u.input + u.output + u.cacheRead + u.cacheWrite
        if (u.cost !== undefined) node.cost = (node.cost ?? 0) + u.cost
        this.#opts.onChange()
      }
    }
  }

  #end(status: Exclude<RunStatus, "running">, value?: unknown, error?: string) {
    if (this.status !== "running") return
    this.status = status
    this.endedAt = Date.now()
    if (status === "done") this.result = value
    if (error !== undefined) this.error = error
    this.flow.state = status === "done" ? "done" : "error"
    for (const n of this.#nests.values())
      if (n.state === "running") n.state = status === "done" ? "done" : "error"
    try {
      this.#worker?.terminate()
    } catch {}
    this.#worker = undefined
    // Agents the script did not wait for end with it.
    this.#opts.group.end(
      status === "done"
        ? "the workflow finished"
        : `the workflow ${status === "stopped" ? "was stopped" : "failed"}`,
    )
    if (status !== "done") this.#log(status === "stopped" ? "warning" : "error", error ?? status)
    writeRun(this.#opts.dir, this.record)
    this.#opts.onChange()
    this.#finished(this.record)
  }
}
