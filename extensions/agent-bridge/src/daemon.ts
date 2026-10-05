import { RpcClient, type RpcConnection } from "./rpc.ts"
import {
  BridgeError,
  type BridgeEvent,
  type BridgeState,
  EventJournal,
  errorMessage,
  type IdentityProbe,
  type JsonObject,
  object,
  processIdentity,
  publicState,
  redact,
  removeEndpoint,
  writeState,
} from "./storage.ts"
import { type ClientCall, type LocalServer, listenLocal } from "./transport.ts"

export interface DaemonOptions {
  home: string
  state: BridgeState
  amiraArgv: string[]
  rpc?: RpcConnection
  probe?: IdentityProbe
  now?: () => number
  tickMs?: number
  startupTimeoutMs?: number
  /** Test seam for an offline RPC fixture; never accepted over the public transport. */
  rpcArgs?: string[]
  listen?: typeof listenLocal
}
interface PendingRequest {
  request: JsonObject
  deadline: number
  cancelling: boolean
}
export type WaitUntil = "turn-end" | "reply" | "request" | "idle"

export function messageText(message: unknown): string {
  const content = object(message).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const value = object(block)
      return value.type === "text" && typeof value.text === "string" ? value.text : ""
    })
    .join("")
}
function usageOf(messages: unknown[]): JsonObject {
  const total: JsonObject = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let cost = 0
  let known = true
  for (const item of messages) {
    const message = object(item)
    if (message.role !== "assistant") continue
    const usage = object(message.usage)
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
      if (typeof usage[key] === "number") total[key] = Number(total[key]) + usage[key]
    }
    if (typeof usage.cost === "number") cost += usage.cost
    else known = false
  }
  return { ...total, cost: known ? cost : null }
}
function requiredText(call: ClientCall, key: string): string {
  const value = call[key]
  if (typeof value !== "string" || !value.trim()) throw new BridgeError(`${key} must be a nonempty string`)
  return value
}
export function cursorOf(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError("--since must be a nonnegative integer cursor")
  }
  return value
}

/** One daemon, one RPC child, one retained session. No independent agent loop. */
export class BridgeDaemon {
  readonly state: BridgeState
  readonly journal: EventJournal
  readonly rpc: RpcConnection
  readonly done: Promise<void>
  private resolveDone!: () => void
  private resolveRoot!: () => void
  private readonly rootReady: Promise<void>
  private readonly now: () => number
  private server?: LocalServer
  private timer?: ReturnType<typeof setInterval>
  private ready = false
  private stopping = false
  private failed = false
  private busy = false
  private readonly promotedTurns = new Set<string>()
  private activeCalls = 0
  private lastActivity: number
  private revision = 0
  private ticking = false
  private refreshing?: Promise<JsonObject>
  private recovering?: Promise<void>
  private lossVersion = 0
  private shutdown?: Promise<void>
  private snapshot: JsonObject = {}
  private messages: unknown[] = []
  private treeUsage: JsonObject = { tokens: 0, costUsd: null }
  private readonly tools = new Map<string, JsonObject>()
  private readonly subagents = new Map<string, JsonObject>()
  private projectionsUncertain = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: DaemonOptions) {
    this.state = options.state
    this.rpc = options.rpc ?? new RpcClient()
    this.journal = new EventJournal(options.home, this.state.id)
    this.now = options.now ?? Date.now
    this.lastActivity = this.now()
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
    this.rootReady = new Promise((resolve) => {
      this.resolveRoot = resolve
    })
    this.rpc.onEvent = (event) => this.onEvent(event)
    this.rpc.onExit = (exit) => {
      if (!this.stopping) {
        void this.fail(`RPC child exited (${exit.code ?? "unknown"})${exit.error ? `: ${exit.error}` : ""}`)
      }
    }
  }

  private persist(): void {
    writeState(this.options.home, this.state)
  }

  private append(type: string, data: JsonObject = {}, rpc?: JsonObject): BridgeEvent {
    // Even unexpected diagnostic text must not expose the transport credential.
    const safeData = JSON.parse(redact(JSON.stringify(data), this.state.token)) as JsonObject
    const safeRpc = rpc
      ? (JSON.parse(redact(JSON.stringify(rpc), this.state.token)) as JsonObject)
      : undefined
    const event = this.journal.append(type, safeData, safeRpc)
    this.notify()
    return event
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.initialize(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new BridgeError("RPC startup timed out")),
            this.options.startupTimeoutMs ?? 45_000,
          )
        }),
      ])
    } catch (error) {
      await this.fail(errorMessage(error))
      await this.done
      throw new BridgeError(this.state.error ?? errorMessage(error))
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async initialize(): Promise<void> {
    this.state.pid = process.pid
    const identity = await (this.options.probe ?? processIdentity)(process.pid)
    if (this.stopping) throw new BridgeError("Bridge startup cancelled")
    if (identity.kind !== "alive") throw new BridgeError("Cannot determine the bridge process start identity")
    this.state.processStart = identity.identity
    this.persist()
    this.server = await (this.options.listen ?? listenLocal)(this.options.home, this.state, (call, signal) =>
      this.handle(call, signal),
    )
    if (this.stopping) {
      this.finishServer()
      throw new BridgeError("Bridge startup cancelled")
    }
    const launch = this.state.launch
    const argv = [
      ...this.options.amiraArgv,
      "--rpc",
      "-C",
      launch.cwd,
      ...(launch.model ? ["-m", launch.model] : []),
      ...(launch.resume ? ["--resume", launch.resume] : []),
      ...(launch.mode !== "default" ? ["--permission-mode", launch.mode] : []),
      ...(this.options.rpcArgs ?? []),
    ]
    this.rpc.start(argv, { cwd: launch.cwd, env: { ...process.env, AMIRA_HOME: this.options.home } })
    await Promise.race([
      this.rootReady,
      this.rpc.exited.then(() => {
        throw new BridgeError("RPC child exited before readiness")
      }),
    ])
    await this.refresh()
    if (!this.state.sessionId) throw new BridgeError("RPC did not report an Amira session ID")
    if (launch.name) await this.rpc.call("session.rename", { title: launch.name })
    await this.readHistory()
    if (this.stopping || !this.rpc.alive) throw new BridgeError("RPC child exited during startup")
    this.ready = true
    this.state.status = this.busy ? "running" : "idle"
    this.persist()
    this.append("bridge.ready", { sessionId: this.state.sessionId })
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.fail(errorMessage(error)))
    }, this.options.tickMs ?? 1000)
  }

  private onEvent(event: JsonObject): void {
    if (this.failed) return
    const type = String(event.type)
    const data = object(event.data)
    if (type === "session.start" && !event.parentSessionId && !this.state.sessionId) {
      this.state.sessionId = typeof event.sessionId === "string" ? event.sessionId : null
      this.resolveRoot()
    }
    const root = event.sessionId === this.state.sessionId
    this.lastActivity = this.now()
    if (root && type === "turn.steer" && data.state === "promoted" && typeof data.nextTurnId === "string") {
      this.promotedTurns.add(data.nextTurnId)
    }
    if (root && type === "turn.start") {
      this.promotedTurns.delete(String(event.turnId))
      this.busy = true
      this.snapshot.turnId = event.turnId
      this.revision++
    }
    if (root && type === "turn.end") {
      this.busy = false
      delete this.snapshot.turnId
      this.revision++
    }
    if (root && type === "compact.start") {
      this.busy = true
      this.revision++
    }
    if (root && (type === "compact.end" || type === "compact.failed")) {
      // Compaction may be inside a running turn: state is authoritative.
      this.revision++
      if (this.ready) void this.refresh().catch((error) => this.fail(errorMessage(error)))
    }
    if (root && type === "status.changed") {
      this.snapshot.status = data.status
      this.revision++
      if (data.status === "working" || data.status === "blocked") this.busy = true
      if (data.status === "idle" || data.status === "error") this.busy = false
    }
    if (root && type === "model.changed") {
      const model = object(data.to)
      this.state.model = `${model.provider}/${model.model}`
      this.revision++
    }
    // History and events have independent delivery queues. Never add completion
    // usage to an unversioned history snapshot: it may already include that reply.
    const toolKey = `${String(event.sessionId)}:${String(data.toolCallId)}`
    if (type === "tool.execute.start") this.tools.set(toolKey, { ...data, sessionId: event.sessionId })
    if (type === "tool.execute.end") this.tools.delete(toolKey)
    if (type === "subagent.start" && typeof data.childSessionId === "string") {
      this.subagents.set(data.childSessionId, { ...data, state: data.queued ? "queued" : "working" })
    }
    if (type === "subagent.state" && typeof data.childSessionId === "string") {
      this.subagents.set(data.childSessionId, { ...this.subagents.get(data.childSessionId), ...data })
    }
    if (type === "subagent.end" && typeof data.childSessionId === "string")
      this.subagents.delete(data.childSessionId)
    // Each emitter reports the cumulative whole-tree ledger, including child replies.
    if (type === "budget.update")
      this.treeUsage = { ...data, costUsd: data.costUsd ?? null, uncertain: false }
    if (type === "ui.request") {
      this.observeRequest(data)
      this.revision++
    }
    if (type === "ui.resolved" && typeof data.requestId === "string") {
      this.pending.delete(data.requestId)
      this.revision++
    }
    if (this.ready && !this.stopping) {
      const status = this.busy ? "running" : "idle"
      if (this.state.status !== status || type === "model.changed") {
        this.state.status = status
        this.persist()
      }
    }
    if (type === "events.lost") {
      this.projectionsUncertain = true
      this.treeUsage = { ...this.treeUsage, uncertain: true }
    }
    this.append(type, data, event)
    if (type === "events.lost") {
      this.lossVersion++
      this.tools.clear()
      this.subagents.clear()
      this.startRecovery()
    }
  }

  private startRecovery(): void {
    if (this.recovering || this.stopping) return
    let recoveredVersion = -1
    this.recovering = (async () => {
      do {
        const version = this.lossVersion
        await this.recover()
        recoveredVersion = version
      } while (recoveredVersion !== this.lossVersion && !this.stopping)
    })()
      .catch((error) => this.fail(errorMessage(error)))
      .finally(() => {
        this.recovering = undefined
        // A new marker can arrive after the loop ends but before this continuation.
        if (recoveredVersion !== this.lossVersion) this.startRecovery()
        this.notify()
      })
  }

  private observeRequest(request: JsonObject): void {
    if (typeof request.requestId !== "string") return
    const previous = this.pending.get(request.requestId)
    this.pending.set(request.requestId, {
      request,
      deadline: previous?.deadline ?? this.now() + this.state.launch.requestTimeoutMinutes * 60_000,
      cancelling: previous?.cancelling ?? false,
    })
  }

  private refresh(): Promise<JsonObject> {
    this.refreshing ??= (async () => {
      let snapshot: JsonObject = {}
      for (let attempt = 0; attempt < 4; attempt++) {
        const revision = this.revision
        snapshot = await this.rpc.call("state")
        if (revision !== this.revision) continue
        this.snapshot = snapshot
        this.busy = snapshot.busy === true
        if (typeof snapshot.sessionId === "string") this.state.sessionId = snapshot.sessionId
        if (typeof snapshot.model === "string") this.state.model = snapshot.model
        const requests = Array.isArray(snapshot.uiRequests) ? snapshot.uiRequests.map(object) : []
        const ids = new Set(requests.map((request) => request.requestId))
        for (const id of this.pending.keys()) if (!ids.has(id)) this.pending.delete(id)
        for (const request of requests) this.observeRequest(request)
        if (this.ready && !this.stopping) {
          this.state.status = this.busy ? "running" : "idle"
          this.persist()
        }
        this.notify()
        return snapshot
      }
      // Events won every race with the snapshot. Keep the newer event projection.
      return snapshot
    })().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async readHistory(): Promise<void> {
    let applied = false
    const apply = (history: JsonObject) => {
      this.messages = Array.isArray(history.messages) ? history.messages : []
      applied = true
    }
    const history = await this.rpc.call("session.read", { what: "messages" }, 30_000, apply)
    // Minimal fake RPC implementations need not implement the wire-order hook.
    if (!applied) apply(history)
  }

  private async recover(): Promise<void> {
    const state = await this.refresh()
    await this.readHistory()
    const lastTurn = await this.rpc.call("session.read", { what: "lastTurn" })
    this.append("bridge.recovered", {
      state,
      messages: this.messages,
      lastTurn,
      projectionsUncertain: true,
      notice:
        "Lost events recovered from state and session.read; active tools and subagents remain uncertain",
    })
  }

  private pendingRequests(): JsonObject[] {
    return [...this.pending.values()].map(({ request, deadline }) => ({
      ...request,
      deadline: new Date(deadline).toISOString(),
      answer: `amira agent respond ${this.state.id} ${String(request.requestId)} '<value-json>'`,
    }))
  }

  private hasWork(): boolean {
    return (
      this.busy ||
      this.promotedTurns.size > 0 ||
      this.projectionsUncertain ||
      this.recovering !== undefined ||
      this.tools.size > 0 ||
      [...this.subagents.values()].some((child) => child.state !== "idle")
    )
  }

  status(): JsonObject {
    return {
      ...publicState(this.state),
      ready: this.ready,
      busy: this.busy,
      turnId: this.snapshot.turnId ?? null,
      currentTool: this.tools.values().next().value ?? null,
      tools: [...this.tools.values()],
      pendingRequests: this.pendingRequests(),
      subagents: [...this.subagents.values()],
      projectionsUncertain: this.projectionsUncertain,
      usage: { rootSession: usageOf(this.messages), currentRunTree: this.treeUsage },
      activeCalls: this.activeCalls,
      idleSeconds:
        this.hasWork() || this.pending.size > 0 || this.activeCalls > 0
          ? null
          : Math.max(0, (this.state.launch.idleMinutes * 60_000 - (this.now() - this.lastActivity)) / 1000),
      cursor: this.journal.cursor,
    }
  }

  read(since = 0): JsonObject {
    return { ...this.journal.read(since), pendingRequests: this.pendingRequests() }
  }

  private condition(until: WaitUntil, since: number): boolean {
    if (until === "idle") return !this.hasWork() && this.pending.size === 0
    if (until === "request") return this.pending.size > 0
    return this.journal.events.some((event) => {
      if (event.seq <= since) return false
      if (event.type === "bridge.recovered") {
        const turn = object(event.data.lastTurn)
        const alreadySeen = this.journal.events.some((previous) => {
          if (previous.seq > since) return false
          if (previous.type === "bridge.recovered") {
            const old = object(previous.data.lastTurn)
            return (
              old.turnId === turn.turnId &&
              (until === "turn-end" ? Boolean(old.reason) : old.text === turn.text)
            )
          }
          return (
            previous.sessionId === this.state.sessionId &&
            previous.turnId === turn.turnId &&
            (until === "turn-end"
              ? previous.type === "turn.end"
              : previous.type === "message.end" && messageText(previous.data.message) === turn.text)
          )
        })
        return !alreadySeen && (until === "turn-end" ? typeof turn.reason === "string" : Boolean(turn.text))
      }
      if (event.sessionId !== this.state.sessionId) return false
      return until === "turn-end"
        ? event.type === "turn.end"
        : event.type === "message.end" && Boolean(messageText(event.data.message))
    })
  }

  async wait(until: WaitUntil, since: number, timeoutMs: number, signal: AbortSignal): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.listeners.delete(check)
        signal.removeEventListener("abort", abort)
      }
      const finish = (error?: Error, timedOut = false) => {
        if (finished) return
        finished = true
        cleanup()
        if (error) reject(error)
        else resolve({ ...this.read(since), until, timedOut })
      }
      let checkingIdle = false
      const check = () => {
        if (this.failed) finish(new BridgeError(this.state.error ?? "RPC child failed", 1, "child_exit"))
        else if (this.stopping) finish(new BridgeError("Bridge is stopping", 3, "not_running"))
        else if (this.condition(until, since)) {
          if (until !== "idle") finish()
          else if (!checkingIdle && !finished) {
            checkingIdle = true
            void this.refresh().then(
              () => {
                checkingIdle = false
                if (!this.stopping && this.condition(until, since)) finish()
              },
              (error) => finish(new BridgeError(errorMessage(error))),
            )
          }
        }
      }
      const abort = () => finish(new BridgeError("Client disconnected"))
      // Register before inspection, in the same synchronous task: no event can be missed.
      this.listeners.add(check)
      signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => finish(undefined, true), timeoutMs)
      if (signal.aborted) abort()
      else check()
    })
  }

  async handle(call: ClientCall, signal: AbortSignal): Promise<JsonObject> {
    if (this.failed || this.stopping)
      throw new BridgeError(this.state.error ?? "Bridge is not running", 3, "not_running")
    if (call.op === "probe")
      return { ready: this.ready, id: this.state.id, sessionId: this.ready ? this.state.sessionId : null }
    if (!this.ready && call.op !== "stop") throw new BridgeError("Bridge is still starting")
    this.activeCalls++
    const previousActivity = this.lastActivity
    this.lastActivity = this.now()
    try {
      switch (call.op) {
        case "send":
        case "steer": {
          const text = requiredText(call, "text")
          if (call.steer !== undefined && typeof call.steer !== "boolean")
            throw new BridgeError("steer must be boolean")
          const cursor = this.journal.cursor
          const revision = this.revision
          const result = await this.rpc.call(
            call.op === "steer" || call.steer === true ? "steer" : "prompt",
            { text },
          )
          // Prompt acknowledges before turn.start, but a whole fast turn may also
          // have arrived in the same stdout chunk. Never overwrite newer events.
          if (revision === this.revision) this.busy = true
          this.state.status = this.busy ? "running" : "idle"
          this.persist()
          return { ...result, cursor }
        }
        case "read": {
          const since = cursorOf(call.since)
          if (call.all && call.lastTurn) throw new BridgeError("Choose --all or --last-turn, not both")
          if (call.all || call.lastTurn) {
            // A pre-request cursor is conservative: later wire events must remain
            // readable even if the history response and those events share a chunk.
            const cursor = this.journal.cursor
            return {
              ...(await this.rpc.call("session.read", { what: call.all ? "messages" : "lastTurn" })),
              cursor,
              pendingRequests: this.pendingRequests(),
            }
          }
          return this.read(since)
        }
        case "wait": {
          if (!["turn-end", "reply", "request", "idle"].includes(String(call.until)))
            throw new BridgeError("--until must be turn-end, reply, request, or idle")
          const timeout = call.timeout === undefined ? 60 : call.timeout
          if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 2_000_000)
            throw new BridgeError("--timeout must be between 0 and 2000000 seconds")
          await this.refresh()
          return await this.wait(call.until as WaitUntil, cursorOf(call.since), timeout * 1000, signal)
        }
        case "status": {
          await this.refresh()
          await this.readHistory()
          const status = this.status()
          // Show the countdown before this status call renewed the idle lease.
          status.idleSeconds =
            this.hasWork() || this.pending.size || this.activeCalls > 1
              ? null
              : Math.max(0, (this.state.launch.idleMinutes * 60_000 - (this.now() - previousActivity)) / 1000)
          return status
        }
        case "respond": {
          const requestId = requiredText(call, "requestId")
          if (!Object.hasOwn(call, "value")) throw new BridgeError("value is required; use null to cancel")
          const result = await this.rpc.call("ui.respond", { requestId, value: call.value })
          await this.refresh()
          return { ...result, requestId, cursor: this.journal.cursor }
        }
        case "abort":
          return await this.rpc.call("abort")
        case "stop":
          await this.stop("requested")
          if (this.failed) throw new BridgeError(this.state.error ?? "Bridge cleanup failed")
          return { id: this.state.id, status: this.state.status }
        default:
          throw new BridgeError(`Unknown bridge operation: ${call.op}`)
      }
    } finally {
      this.activeCalls--
      this.lastActivity = this.now()
    }
  }

  /** Public timer seam: tests can advance an injected clock and call tick directly. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopping || !this.ready) return
    this.ticking = true
    try {
      for (const [requestId, pending] of this.pending) {
        if (pending.deadline > this.now() || pending.cancelling) continue
        pending.cancelling = true
        this.append("bridge.request-timeout", {
          requestId,
          message: "Request timed out; cancelling with null",
        })
        try {
          await this.rpc.call("ui.respond", { requestId, value: null })
          this.pending.delete(requestId)
        } catch (error) {
          if (error instanceof BridgeError && error.code === "not_found") this.pending.delete(requestId)
          else throw error
        }
        this.lastActivity = this.now()
        this.notify()
      }
      if (this.activeCalls || this.pending.size || this.hasWork()) return
      if (this.now() - this.lastActivity < this.state.launch.idleMinutes * 60_000) return
      await this.refresh()
      if (
        !this.activeCalls &&
        !this.pending.size &&
        !this.hasWork() &&
        this.now() - this.lastActivity >= this.state.launch.idleMinutes * 60_000
      ) {
        await this.stop("idle timeout")
      }
    } finally {
      this.ticking = false
    }
  }

  async stop(reason = "requested"): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.stopping = true
    this.state.status = "stopping"
    this.persist()
    this.notify()
    this.shutdown = (async () => {
      if (this.timer) clearInterval(this.timer)
      this.append("bridge.stopping", { reason })
      if (this.rpc.alive) {
        try {
          await this.rpc.call("abort", {}, 3000)
        } catch {}
        this.rpc.close(2000)
        await this.awaitChildExit()
      }
      if (!this.failed) this.state.status = "exited"
      this.persist()
      this.append("bridge.exited", { reason, status: this.state.status })
      this.finishServer()
    })()
    return this.shutdown
  }

  private async awaitChildExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      this.rpc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 7000)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!exited) {
      this.rpc.close(0)
      this.failed = true
      this.state.status = "failed"
      this.state.error = "RPC child did not confirm exit after bounded process-tree cleanup"
    }
  }

  private async fail(message: string): Promise<void> {
    if (this.failed) return
    this.failed = true
    this.stopping = true
    this.state.status = "failed"
    this.state.error = redact(
      `${message}${this.rpc.stderrTail ? `\nRPC stderr:\n${this.rpc.stderrTail}` : ""}`,
      this.state.token,
    )
    if (this.timer) clearInterval(this.timer)
    this.persist()
    this.append("bridge.failed", { error: this.state.error })
    this.notify()
    if (this.rpc.alive) {
      this.rpc.close(1000)
      await this.awaitChildExit()
      this.persist()
    }
    this.finishServer()
  }

  private finishServer(): void {
    const close = this.server?.close() ?? Promise.resolve()
    void close.finally(() => {
      removeEndpoint(this.options.home, this.state)
      this.resolveDone()
    })
  }
}

function oneLine(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  return text.replace(/\s+/g, " ").slice(0, max)
}
/** Compact output uses completed assistant messages, never duplicate text deltas. */
export function formatRead(result: JsonObject, id: string): string {
  const lines: string[] = []
  const events = Array.isArray(result.events) ? (result.events as BridgeEvent[]) : []
  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case "message.end": {
        const text = messageText(data.message)
        if (text) lines.push(text)
        break
      }
      case "tool.execute.start":
        lines.push(`tool ${String(data.name)}: ${oneLine(data.args)}`)
        break
      case "tool.execute.end":
        lines.push(
          `tool ${String(data.name)}: ${object(data.result).isError || data.rejected ? "error" : "ok"} ${oneLine(object(data.result).content)}`,
        )
        break
      case "turn.steer":
        lines.push(`steer ${String(data.state)}${data.nextTurnId ? `: ${String(data.nextTurnId)}` : ""}`)
        break
      case "turn.end":
        lines.push(`turn end: ${String(data.reason)}${data.error ? ` — ${oneLine(data.error)}` : ""}`)
        break
      case "ui.request":
        lines.push(
          `request ${String(data.requestId)} (${String(data.kind)}): ${oneLine(data.title ?? "Answer required")}`,
        )
        lines.push(
          `answer: amira agent respond ${id} ${String(data.requestId)} '<value-json>' (null cancels)`,
        )
        break
      case "ui.resolved":
        lines.push(`request ${String(data.requestId)}: ${data.cancelled ? "cancelled" : "answered"}`)
        break
      case "bridge.request-timeout":
        lines.push(`request ${String(data.requestId)}: auto-cancelled with null`)
        break
      case "bridge.failed":
      case "extension.error":
      case "compact.failed":
        lines.push(`error: ${oneLine(data.error)}`)
        break
      case "model.retry":
        lines.push(`model retry ${String(data.attempt)}: ${oneLine(data.error)}`)
        break
      case "command.output":
      case "extension.notice":
        lines.push(`${String(data.level ?? "info")}: ${oneLine(data.text)}`)
        break
      case "events.lost":
        lines.push(`events lost: ${String(data.dropped)}; recovering state and session history`)
        break
      case "bridge.recovered":
        lines.push(String(data.notice))
        if (object(data.lastTurn).text) lines.push(String(object(data.lastTurn).text))
        if (object(data.lastTurn).reason)
          lines.push(`turn end (recovered): ${String(object(data.lastTurn).reason)}`)
        break
      case "bridge.exited":
        lines.push(`bridge exited: ${String(data.reason)}`)
        break
    }
  }
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      const value = object(message)
      const text = messageText(value)
      if (value.role === "toolResult")
        lines.push(
          `tool ${String(value.toolName ?? value.toolCallId)}: ${value.isError ? "error" : "ok"} ${oneLine(value.content)}`,
        )
      else if (text) lines.push(`${String(value.role)}: ${text}`)
    }
    if (result.reason) lines.push(`turn end: ${String(result.reason)}`)
    if (result.error) lines.push(`error: ${oneLine(result.error)}`)
  }
  if (Array.isArray(result.pendingRequests)) {
    for (const request of result.pendingRequests) {
      const value = object(request)
      lines.push(
        `pending request ${String(value.requestId)} (${String(value.kind)}): ${oneLine(value.title ?? "Answer required")}`,
      )
      lines.push(`answer: ${String(value.answer)} (null cancels)`)
    }
  }
  if (result.timedOut) lines.push("wait timed out")
  lines.push(`cursor: ${String(result.cursor ?? 0)}`)
  return `${lines.join("\n")}\n`
}
