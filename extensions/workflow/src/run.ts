import type { ChildSession, JSONSchema, SpawnGroup, SubagentResult } from "@amira/api"
import { compileScript } from "./compile.ts"
import { callHash, Journal, type JournalEntry, type RunRecord, type RunStatus, writeRun } from "./journal.ts"
import type { WorkflowMeta } from "./meta.ts"
import { type AgentNode, type FlowNode, newFlow, phaseOf, totals } from "./progress.ts"
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
  startedBy?: { sessionId: string; label: string }
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
  #pending = new Set<Promise<void>>()
  /** True only once all in-flight calls and their journals have settled. */
  settled = false
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
    const t = totals(this.flow)
    return {
      id: this.id,
      meta: this.meta,
      args: this.#opts.args,
      source: this.#opts.origin,
      status: this.status,
      ...(this.#opts.startedBy ? { startedBy: { ...this.#opts.startedBy } } : {}),
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.status === "done" ? { result: this.result } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.#opts.resumes ? { resumes: this.#opts.resumes } : {}),
      totals: {
        tokens: t.tokens ?? null,
        cost: t.cost ?? null,
        durationMs: Math.max(0, (this.endedAt ?? Date.now()) - this.startedAt),
        agents: t.agents,
        byStatus: t.byStatus,
      },
    }
  }

  start(): void {
    writeRun(this.#opts.dir, this.record, this.#opts.source)
    const worker = (this.#opts.worker ?? sandboxWorker)()
    this.#worker = worker
    // A member ending (or an ancestor budget) ends its group, even if the script is waiting.
    void this.#opts.group.ended().then((info) => this.stop(info.endReason ?? "its agent group ended"))
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
      case "agent": {
        const pending = this.#agent(m)
        this.#pending.add(pending)
        try {
          await pending
        } finally {
          this.#pending.delete(pending)
        }
        break
      }
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
    node.nest = nest
    this.#nests.set(nest, node)
    phaseOf(this.flow, this.flow.current).items.push(node)
    this.#log("info", `workflow ${compiled.meta.name} started`)
    this.#reply(m.id, { ok: true, value: { code: compiled.code, args: m.args, name: nest } })
  }

  async #agent(m: Extract<WorkerMessage, { t: "agent" }>) {
    const startedAt = Date.now()
    const cleaned = cleanOpts(m.opts ?? {})
    const opts = typeof cleaned === "string" ? (m.opts ?? {}) : cleaned
    const flow = this.#flowOf(m.nest)
    // Capture the phase at invocation, not when a parallel call eventually finishes.
    const phase = typeof opts.phase === "string" ? opts.phase : flow.current
    const node: AgentNode = {
      kind: "agent",
      call: m.id,
      label: label(m.prompt, opts.label),
      status: "queued",
      prompt: m.prompt,
      startedAt,
      tokens: 0,
      cost: 0,
      ...(typeof opts.model === "string" ? { model: opts.model } : {}),
    }
    phaseOf(flow, phase).items.push(node)
    let hash: string
    let hashError: string | undefined
    try {
      hash = callHash(m.prompt, opts, m.nest)
    } catch {
      hash = "invalid-options"
      hashError = "agent options must be JSON serializable"
    }
    const key = this.journal.key(hash)
    let text = ""
    let value: unknown
    let error: string | undefined
    let tree: Awaited<ReturnType<typeof createWorktree>> | undefined
    let child: ChildSession | undefined
    try {
      // Failed calls still cross the replay frontier, including invalid options and roles.
      const hit = this.journal.replay(key, m.seen, this.#delivered)
      if (typeof cleaned === "string") throw new Error(cleaned)
      if (hashError) throw new Error(hashError)
      if (hit) {
        node.status = "cached"
        node.childId = hit.sessionId
        node.model = hit.model
        text = hit.text
        value = hit.value
      } else {
        const role = opts.role ? this.#opts.roles().get(opts.role) : undefined
        if (opts.role && !role) {
          throw new Error(
            `unknown role "${opts.role}"; known roles: ${[...this.#opts.roles().keys()].join(", ")}`,
          )
        }
        node.model = opts.model ?? role?.model
        if ((opts.isolation ?? role?.isolation ?? "none") === "worktree") {
          tree = await createWorktree(this.#opts.git, {
            cwd: this.#opts.cwd,
            home: this.#opts.home,
            name: `${this.id}_${m.id}`,
          })
          if ("error" in tree) {
            this.#log(
              "warning",
              `${node.label}: no worktree (${tree.error}); it works in the shared directory`,
              m.nest,
            )
            tree = undefined
          }
        }
        if (this.status !== "running") {
          node.status = "aborted"
          error = this.error ?? "the workflow ended before the agent started"
        } else {
          try {
            child = this.#opts.group.spawn({
              title: node.label,
              prompt: m.prompt,
              ...(opts.role ? { role: opts.role } : {}),
              ...(node.model ? { model: node.model } : {}),
              ...(role?.tools ? { tools: role.tools } : {}),
              // Workflow agents cannot start orchestrators or inherit a member's private tools.
              excludeTools: [
                "swarm",
                "workflow",
                "start_workflow",
                "workflow_status",
                "stop_workflow",
                "send_message",
                "list_agents",
                "blackboard_read",
                "blackboard_write",
                "finish",
              ],
              ...(opts.schema ? { schema: opts.schema as JSONSchema } : {}),
              ...(tree && !("error" in tree) ? { cwd: tree.cwd } : {}),
              systemPrompt: [
                WORKER_INSTRUCTIONS,
                tree && !("error" in tree)
                  ? `You work in your own git worktree (${tree.cwd}); when you finish, your changes are merged into the main working tree.`
                  : "",
                role?.prompt ?? "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            })
          } catch (err) {
            throw new Error(
              `agent "${node.label}" could not start: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          node.childId = child.id
          node.model = `${child.model.provider}/${child.model.model}`
          // A child's usage is unknown until reported; a pre-spawn failure spends zero.
          node.tokens = undefined
          node.cost = undefined
          this.#opts.onChange()
          const watching = this.#watch(child, node).catch(() => ({ tokens: -1, unknownCost: true }))
          const r: SubagentResult = await child.result()
          const observed = await watching
          node.status = r.status
          node.tokens = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite
          // Host aggregates can contain only the priced part of a child's usage. Unobserved
          // work (such as commander consultations) cannot establish a complete known cost.
          node.cost = !observed.unknownCost && observed.tokens === node.tokens ? r.usage.cost : undefined
          text = r.text
          value = r.value
          if (r.status !== "done") error = r.error ?? r.status
        }
      }
    } catch (err) {
      node.status = this.status === "running" ? "error" : "aborted"
      error = err instanceof Error ? err.message : String(err)
      if (child) {
        try {
          child.abort(error)
        } catch {}
      }
    } finally {
      if (tree && !("error" in tree)) {
        try {
          const line = await finishWorktree(this.#opts.git, tree, node.status === "done")
          node.note = line
          this.#log(
            line.includes("NOT merged") || line.includes("kept") ? "warning" : "info",
            `${node.label}: ${line}`,
            m.nest,
          )
        } catch (err) {
          node.status = "error"
          error = `worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      node.durationMs = Math.max(0, Date.now() - startedAt)
      node.text = text
      if (error !== undefined) node.note = error
      const status = node.status === "queued" || node.status === "working" ? "aborted" : node.status
      node.status = status
      this.journal.record({
        key,
        call: m.id,
        attempt: this.#opts.resumes ?? 0,
        label: node.label,
        prompt: m.prompt,
        status,
        startedAt,
        durationMs: node.durationMs,
        text,
        ...(phase !== undefined ? { phase } : {}),
        ...(m.nest ? { nest: m.nest } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(node.tokens !== undefined ? { tokens: node.tokens } : {}),
        ...(node.cost !== undefined ? { cost: node.cost } : {}),
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.childId ? { sessionId: node.childId } : {}),
      })
      this.#opts.onChange()
    }
    if (node.status === "done" || node.status === "cached") {
      this.#reply(m.id, { ok: true, value: opts.schema ? value : text })
    } else {
      const message = child
        ? `agent "${node.label}" ${node.status === "aborted" ? "was stopped" : "failed"}: ${error ?? node.status}`
        : (error ?? node.status)
      this.#reply(m.id, { ok: false, error: message })
    }
  }

  /** Follows only the child's own usage; descendants are not counted twice. */
  async #watch(child: ChildSession, node: AgentNode) {
    let tokens = 0
    let unknownCost = false
    for await (const e of child.events) {
      if (e.sessionId !== child.id) continue
      if (e.type === "session.start") {
        node.status = "working"
        this.#opts.onChange()
      } else if (e.type === "message.end") {
        const u = e.data.message.usage
        if (u?.cost === undefined) unknownCost = true
        if (u) {
          tokens += u.input + u.output + u.cacheRead + u.cacheWrite
          node.tokens = tokens
          node.cost = !unknownCost ? (node.cost ?? 0) + (u.cost ?? 0) : undefined
        } else {
          node.cost = undefined
        }
        this.#opts.onChange()
      }
    }
    return { tokens, unknownCost }
  }

  async #end(status: Exclude<RunStatus, "running">, value?: unknown, error?: string) {
    if (this.status !== "running") return
    this.status = status
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
    await Promise.allSettled([...this.#pending])
    this.endedAt = Date.now()
    this.settled = true
    writeRun(this.#opts.dir, this.record)
    this.#opts.onChange()
    this.#finished(this.record)
  }
}
