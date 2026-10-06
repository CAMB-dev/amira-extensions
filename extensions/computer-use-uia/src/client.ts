import type { ExtensionAPI, PipeEvent, PipeProcess } from "@amira/api"
import type { UiaSettings } from "./settings.ts"
import { overlayReply, STOP_MESSAGE, StopState } from "./stop.ts"

export interface LaunchResult {
  window?: string
  pid: number
  title?: string
  instruction?: string
}

export interface WindowResult {
  window: string
  title: string
  process: string
  pid: number
  class: string
  bounds: { x: number; y: number; width: number; height: number }
  minimized: boolean
  foreground: boolean
}

export interface TreeResult {
  text: string
  nodes: number
  chars: number
  ms: number
  cut: boolean
}

interface Snapshot {
  refs: Set<string>
}

type Host = Pick<ExtensionAPI, "openPipe" | "backgroundJobs" | "cwd" | "reportError">
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Window-local snapshots; only exact launched identities are eligible for cleanup. */
export class UiaClient {
  private pipe?: PipeProcess
  private lifetime?: string
  private buffer = ""
  private nextId = 0
  private generation = 0
  private sessionEpoch = 0
  private readonly pending = new Map<number, Pending>()
  private readonly windows = new Map<string, Snapshot>()
  readonly emergency = new StopState()
  private overlay?: PipeProcess
  private helperIdentity?: { event: "owner"; pid: number; started: string }
  private overlayExited: Promise<void> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()
  private stopping = false
  private statePath: string
  private watchdog?: PipeProcess
  private lifetimeStarted?: string
  private pipeExited: Promise<void> = Promise.resolve()
  private watchdogExited: Promise<void> = Promise.resolve()
  private retired: Promise<void> = Promise.resolve()
  private stopWait: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: Host,
    readonly settings: UiaSettings,
    private readonly timeoutMs = 60_000,
    private readonly onStopped: () => void = () => {},
  ) {
    this.statePath = `${process.env.TEMP ?? process.env.TMP ?? host.cwd}/amira-uia-${crypto.randomUUID()}.json`
  }

  /** Serialize even direct callers: snapshots, focus and cleanup must not race. */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const epoch = this.sessionEpoch
    const run = this.queue.then(() => {
      if (epoch !== this.sessionEpoch)
        throw new Error(
          this.emergency.stopped ? STOP_MESSAGE : "UIA session ended before the request started",
        )
      return this.execute(method, params)
    })
    this.queue = run.catch(() => {})
    return run
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopping) throw new Error("computer-use-uia is stopping")
    if (!["windows", "tree"].includes(method)) this.emergency.assertAction()
    if (method === "windows") {
      if (params.filter !== undefined && typeof params.filter !== "string")
        throw new Error("filter must be a string")
      return this.request(method, params.filter === undefined ? {} : { filter: params.filter })
    }
    if (method === "launch") {
      if (typeof params.command !== "string" || !params.command.trim())
        throw new Error("command must be a program name or path")
      if (
        params.args !== undefined &&
        (!Array.isArray(params.args) || params.args.some((arg) => typeof arg !== "string"))
      )
        throw new Error("args must be a string array")
      if (params.cwd !== undefined && typeof params.cwd !== "string") throw new Error("cwd must be a string")
      const safe = {
        command: params.command,
        ...(params.args === undefined ? {} : { args: params.args }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      }
      const result = (await this.request(method, safe)) as LaunchResult
      if (
        !result ||
        !Number.isInteger(result.pid) ||
        result.pid <= 0 ||
        (result.window !== undefined && !/^[1-9]\d*$/.test(result.window))
      )
        throw new Error("Invalid helper launch response")
      return result
    }
    if (!["tree", "click", "type", "key", "focus", "close"].includes(method))
      throw new Error("Unknown UIA request")
    if (typeof params.window !== "string" || !/^[1-9]\d*$/.test(params.window))
      throw new Error("window must be a native window handle from ui_windows or ui_launch")
    let snapshot = this.windows.get(params.window)
    if (!snapshot) {
      snapshot = { refs: new Set() }
      this.windows.set(params.window, snapshot)
    }
    const safe: Record<string, unknown> = { window: params.window }
    if (method === "tree") {
      safe.depth = boundedInt(params.depth, 8, 0, 30, "depth")
      safe.maxNodes = boundedInt(params.maxNodes, 300, 1, 1000, "maxNodes")
      // A failed traversal also invalidates the previous snapshot.
      snapshot.refs.clear()
    }
    if (method === "click" || (method === "type" && params.ref !== undefined)) {
      if (typeof params.ref !== "string" || !snapshot.refs.has(params.ref))
        throw new Error("Refused: ref is not in this window's latest tree; call ui_tree first")
      safe.ref = params.ref
    }
    if (method === "type") {
      if (typeof params.text !== "string" || params.text.length > 20_000)
        throw new Error("text must be a string of at most 20000 characters")
      safe.text = params.text
    }
    if (method === "key") safe.keys = validateKeys(params.keys)
    const result = await this.request(method, safe)
    if (method === "tree") {
      const tree = result as TreeResult
      const formatted = formatTree(tree, safe.maxNodes as number)
      for (const line of formatted.text.split("\n")) {
        const ref = /^\s*(e\d+)\s/.exec(line)?.[1]
        if (ref && !/^\s*e\d+\s+unreadable\b/.test(line)) snapshot.refs.add(ref)
      }
      return formatted
    }
    if (method === "close") this.windows.delete(params.window)
    return result
  }

  private async start(): Promise<void> {
    if (this.pipe) return
    const previousGeneration = this.generation
    await this.retired
    if (this.stopping || previousGeneration !== this.generation)
      throw new Error("UIA session ended during startup")
    // Background jobs have an unload lifetime; pipes require this sentinel/watchdog bridge.
    let job = this.lifetime ? this.host.backgroundJobs.get(this.lifetime) : undefined
    if (!job || !["starting", "running"].includes(job.status)) {
      this.statePath = `${process.env.TEMP ?? process.env.TMP ?? this.host.cwd}/amira-uia-${crypto.randomUUID()}.json`
      job = this.host.backgroundJobs.start({
        command: "computer-use-uia lifetime (no desktop access)",
        argv: [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          `${import.meta.dir}/../helper/lifetime.ps1`,
          "-Sentinel",
        ],
        cwd: this.host.cwd,
      })
      this.lifetime = job.id
      const ready = await this.host.backgroundJobs.waitFor(job.id, {
        pattern: /UIA lifetime ready /,
        timeoutMs: this.timeoutMs,
      })
      if (ready.reason !== "match" || !ready.line) throw new Error("UIA lifetime process failed to start")
      const identity = JSON.parse(ready.line.slice(ready.line.indexOf("UIA lifetime ready ") + 19)) as {
        Pid: number
        Started: string
      }
      job = this.host.backgroundJobs.get(job.id)
      if (identity.Pid !== job?.pid || !/^\d+$/.test(identity.Started))
        throw new Error("UIA lifetime process has an invalid identity")
      this.lifetimeStarted = identity.Started
    }
    if (this.stopping || previousGeneration !== this.generation)
      throw new Error("UIA session ended during startup")
    if (!job?.pid || !this.lifetimeStarted) throw new Error("UIA lifetime process has no identity")
    if (!this.watchdog) await this.startWatchdog(job.pid, this.lifetimeStarted)
    if (this.stopping || previousGeneration !== this.generation)
      throw new Error("UIA session ended during startup")
    const generation = ++this.generation
    this.buffer = ""
    const exited = Promise.withResolvers<void>()
    this.pipeExited = exited.promise
    this.pipe = this.host.openPipe(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${import.meta.dir}/../helper/uia.ps1`,
        "-LifetimePid",
        String(job.pid),
        "-LifetimeStarted",
        this.lifetimeStarted,
        "-StatePath",
        this.statePath,
      ],
      {
        cwd: this.host.cwd,
        onEvent: (event) => {
          if (event.type === "exit") exited.resolve()
          if (generation === this.generation) this.event(event)
        },
      },
    )
    await this.startOverlay(job.pid, this.lifetimeStarted)
    if (this.stopping || generation !== this.generation) throw new Error("UIA session ended during startup")
  }

  /** Stop is out-of-band: retire even a helper blocked inside a synchronous UIA provider. */
  emergencyStop(): void {
    const changed = this.emergency.stop()
    if (!changed && !this.pipe && !this.overlay) return
    this.sessionEpoch++
    this.breakPipe(STOP_MESSAGE)
    if (changed) this.onStopped()
  }

  resume(): void {
    this.emergency.resume()
  }

  private async startOverlay(pid: number, started: string): Promise<void> {
    const ready = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<void>()
    this.overlayExited = exited.promise
    let buffer = ""
    const timer = setTimeout(
      () => ready.reject(new Error("UIA stop monitor failed to start")),
      this.timeoutMs,
    )
    const overlay = this.host.openPipe(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${import.meta.dir}/../helper/overlay.ps1`,
        "-Render",
        String(this.settings.overlay),
        "-StopHotkey",
        this.settings.stopHotkey,
        "-LifetimePid",
        String(pid),
        "-LifetimeStarted",
        started,
      ],
      {
        cwd: this.host.cwd,
        onEvent: (event) => {
          if (event.type === "exit") {
            exited.resolve()
            ready.reject(new Error("UIA stop monitor exited"))
            if (this.overlay === overlay) {
              this.overlay = undefined
              this.emergencyStop()
            }
          }
          if (event.type === "stderr" && event.data.includes("UIA input cleanup incomplete"))
            this.host.reportError(
              "computer-use-uia: input cleanup incomplete; release held keys/buttons manually",
            )
          if (event.type !== "stdout" || this.overlay !== overlay) return
          buffer += event.data
          if (buffer.length > 20_000) {
            this.emergencyStop()
            return
          }
          let newline = buffer.indexOf("\n")
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf("\n")
            if (!line) continue
            try {
              const reply = overlayReply(line)
              if (reply.event === "ready") ready.resolve()
              else if (reply.event === "stop") this.emergencyStop()
              else if (reply.event === "glided")
                this.pipe?.write(`${JSON.stringify({ method: "overlay_ack", id: reply.id })}\n`)
            } catch {
              this.emergencyStop()
            }
          }
        },
      },
    )
    this.overlay = overlay
    if (this.helperIdentity) overlay.write(`${JSON.stringify(this.helperIdentity)}\n`)
    try {
      await ready.promise
    } catch (error) {
      this.breakPipe("UIA stop monitor unavailable", 0)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async startWatchdog(pid: number, started: string): Promise<void> {
    const ready = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<void>()
    this.watchdogExited = exited.promise
    let output = ""
    const timer = setTimeout(() => ready.reject(new Error("UIA watchdog failed to start")), this.timeoutMs)
    const watchdog = this.host.openPipe(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${import.meta.dir}/../helper/lifetime.ps1`,
        "-StatePath",
        this.statePath,
        "-LifetimePid",
        String(pid),
        "-LifetimeStarted",
        started,
      ],
      {
        cwd: this.host.cwd,
        onEvent: (event) => {
          if (event.type === "stdout") {
            output = (output + event.data).slice(-1000)
            if (output.includes("UIA watchdog ready")) ready.resolve()
          }
          if (event.type === "stderr" && event.data.includes("UIA cleanup incomplete"))
            this.host.reportError(
              "computer-use-uia: cleanup incomplete; launch identities retained for retry",
            )
          if (event.type === "exit") {
            exited.resolve()
            ready.reject(new Error("UIA watchdog exited"))
            if (this.watchdog === watchdog) {
              this.watchdog = undefined
              if (!this.stopping) this.breakPipe("UIA watchdog exited; desktop control stopped")
            }
          }
        },
      },
    )
    this.watchdog = watchdog
    try {
      await ready.promise
    } catch (error) {
      if (this.watchdog === watchdog) this.watchdog = undefined
      this.retired = exited.promise
      watchdog.close(5000)
      await exited.promise
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private event(event: PipeEvent) {
    if (event.type === "exit") {
      // A stop-monitor kill and a helper exit may arrive on different pipes in either order.
      // Unexpected helper death must latch too, never let that race reopen desktop control.
      this.emergencyStop()
      return
    }
    if (event.type !== "stdout") return
    this.buffer += event.data
    if (this.buffer.length > 2_000_000) {
      this.breakPipe("UIA helper response exceeded the limit")
      return
    }
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf("\n")
      if (!line) continue
      try {
        const response = JSON.parse(line) as {
          id: number | null
          result?: unknown
          error?: string
          event?: string
          pid?: number
          started?: string
        }
        if (response.event === "helper") {
          if (
            !Number.isInteger(response.pid) ||
            !response.pid ||
            !response.started ||
            !/^\d+$/.test(response.started)
          ) {
            this.breakPipe("Invalid helper identity")
            return
          }
          this.helperIdentity = { event: "owner", pid: response.pid, started: response.started }
          this.overlay?.write(`${JSON.stringify(this.helperIdentity)}\n`)
          continue
        }
        if (response.event === "overlay" || response.event === "done") {
          if (!this.overlay) {
            this.emergencyStop()
            return
          }
          this.overlay.write(`${line}\n`)
          continue
        }
        if (response.id === null && response.error) {
          this.breakPipe(response.error)
          return
        }
        if (response.id === null) continue
        const pending = this.pending.get(response.id)
        if (!pending) continue
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.error) pending.reject(new Error(response.error))
        else pending.resolve(response.result)
      } catch {
        this.breakPipe("UIA helper sent invalid JSON")
        return
      }
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      await this.start()
    } catch (error) {
      if (this.emergency.stopped) throw new Error(STOP_MESSAGE)
      throw error
    }
    if (!["windows", "tree"].includes(method)) this.emergency.assertAction()
    if (!this.pipe || this.stopping) throw new Error("UIA helper exited before the request started")
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.breakPipe("UIA helper timed out"), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!["windows", "tree"].includes(method)) this.overlay?.write(`${JSON.stringify({ event: "busy" })}\n`)
      this.pipe?.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private failPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }

  private breakPipe(message: string, graceMs = 0) {
    const pipe = this.pipe
    const overlay = this.overlay
    // Failed in-flight requests must not continue acting after their error is returned.
    // Keep the independent input-release monitor alive long enough to process abort/EOF.
    overlay?.write(`${JSON.stringify({ event: "abort" })}\n`)
    this.pipe = undefined
    this.overlay = undefined
    overlay?.close(5000)
    this.helperIdentity = undefined
    this.generation++
    this.windows.clear()
    this.failPending(new Error(message))
    // Never overlap helpers writing the same launch journal during a restart.
    this.retired = Promise.all([this.pipeExited, this.overlayExited]).then(() => {})
    // No grace for failed actions: close(0) also covers startup before owner identity arrives.
    pipe?.close(graceMs)
  }

  /** EOF triggers helper finally cleanup. The sentinel covers host-driven unload too. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopWait
    this.stopping = true
    const pipe = this.pipe
    const watchdog = this.watchdog
    const overlay = this.overlay
    overlay?.write(`${JSON.stringify({ event: "abort" })}\n`)
    this.pipe = undefined
    this.watchdog = undefined
    this.overlay = undefined
    overlay?.close(5000)
    this.helperIdentity = undefined
    this.generation++
    this.sessionEpoch++
    this.windows.clear()
    this.failPending(new Error("UIA session ended"))
    pipe?.close(0)
    watchdog?.close(5000)
    this.stopWait = Promise.all([
      this.pipeExited,
      this.watchdogExited,
      this.overlayExited,
      ...(this.lifetime ? [this.host.backgroundJobs.stop(this.lifetime, 1000)] : []),
    ]).then(() => {})
    try {
      await this.stopWait
    } finally {
      this.lifetime = undefined
      this.lifetimeStarted = undefined
      this.stopping = false
    }
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

export function validateKeys(value: unknown): string {
  if (typeof value !== "string") throw new Error("keys must be a key chord such as ctrl+s or enter")
  const parts = value
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
  const key = parts.pop() ?? ""
  if (new Set(parts).size !== parts.length || parts.some((p) => !["ctrl", "alt", "shift"].includes(p)))
    throw new Error("Unsupported key modifiers (use ctrl, alt, shift)")
  if (parts.includes("alt") && key === "f4") throw new Error("alt+f4 is refused; use ui_close")
  if (
    (parts.includes("alt") && ["tab", "escape"].includes(key)) ||
    (parts.includes("ctrl") && key === "escape")
  )
    throw new Error("Desktop-switching key chords are refused")
  if (
    !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|tab|escape|space|backspace|delete|left|right|up|down|home|end|pageup|pagedown)$/.test(
      key,
    )
  )
    throw new Error("Unsupported key; use a single key or ctrl/alt/shift chord")
  return [...parts, key].join("+")
}

/** Defense in depth against oversized helper output; only retained refs become actionable. */
export function formatTree(tree: TreeResult, maxNodes: number): TreeResult {
  const lines = tree.text.split("\n").filter((line) => /^\s*e\d+\s/.test(line))
  const kept: string[] = []
  let chars = 0
  for (const line of lines.slice(0, maxNodes)) {
    if (chars + line.length + 1 > 200_000) break
    kept.push(line)
    chars += line.length + 1
  }
  const cut = tree.cut || kept.length < lines.length
  const text = kept.join("\n")
  return { text, nodes: kept.length, chars: text.length, ms: tree.ms, cut }
}
