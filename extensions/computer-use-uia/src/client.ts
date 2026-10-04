import type { ExtensionAPI, PipeEvent, PipeProcess } from "@amira/api"
import type { App } from "./settings.ts"

export interface LaunchResult {
  window: string
  pid: number
  title: string
}

export interface TreeResult {
  text: string
  nodes: number
  chars: number
  ms: number
  cut: boolean
}

interface OwnedWindow extends LaunchResult {
  refs: Set<string>
}

type Host = Pick<ExtensionAPI, "openPipe" | "backgroundJobs" | "cwd">
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Both sides guard ownership; a crashed helper invalidates all handles and snapshots. */
export class UiaClient {
  private pipe?: PipeProcess
  private lifetime?: string
  private buffer = ""
  private nextId = 0
  private generation = 0
  private readonly pending = new Map<number, Pending>()
  private readonly windows = new Map<string, OwnedWindow>()
  private queue: Promise<unknown> = Promise.resolve()
  private stopping = false
  private readonly statePath: string

  constructor(
    private readonly host: Host,
    readonly apps: Record<string, App>,
    private readonly timeoutMs = 60_000,
  ) {
    this.statePath = `${process.env.TEMP ?? process.env.TMP ?? host.cwd}/amira-uia-${crypto.randomUUID()}.json`
  }

  /** Serialize even direct callers: snapshots, focus and cleanup must not race. */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const run = this.queue.then(() => this.execute(method, params))
    this.queue = run.catch(() => {})
    return run
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopping) throw new Error("computer-use-uia is stopping")
    if (method === "launch") {
      if (typeof params.app !== "string" || !Object.hasOwn(this.apps, params.app))
        throw new Error(`Unknown app. Allowed apps: ${Object.keys(this.apps).join(", ") || "(none)"}`)
      const result = (await this.request(method, { app: params.app })) as LaunchResult
      if (!result || !/^\d+$/.test(result.window) || !Number.isInteger(result.pid) || result.pid <= 0)
        throw new Error("Invalid helper launch response")
      this.windows.set(result.window, { ...result, refs: new Set() })
      return { window: result.window, pid: result.pid, title: result.title }
    }
    if (!["tree", "click", "type", "key", "close"].includes(method))
      throw new Error("Unknown UIA request")
    const owned = typeof params.window === "string" ? this.windows.get(params.window) : undefined
    if (!owned) throw new Error("Refused: window was not obtained from this extension's launch")
    const safe: Record<string, unknown> = { window: owned.window }
    if (method === "tree") {
      safe.depth = boundedInt(params.depth, 8, 0, 30, "depth")
      safe.maxNodes = boundedInt(params.maxNodes, 300, 1, 1000, "maxNodes")
      // A failed traversal also invalidates the previous snapshot.
      owned.refs.clear()
    }
    if (method === "click" || (method === "type" && params.ref !== undefined)) {
      if (typeof params.ref !== "string" || !owned.refs.has(params.ref))
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
        if (ref) owned.refs.add(ref)
      }
      return formatted
    }
    if (method === "close") this.windows.delete(owned.window)
    return result
  }

  private async start(): Promise<void> {
    if (this.pipe) return
    const previousGeneration = this.generation
    // API 0.1.27 lacks an unload hook. Background jobs DO have an unload lifetime.
    // The helper monitors this exact sentinel process while awaiting stdin.
    let job = this.lifetime ? this.host.backgroundJobs.get(this.lifetime) : undefined
    if (!job || !["starting", "running"].includes(job.status)) {
      job = this.host.backgroundJobs.start({
        command: "computer-use-uia lifetime (no desktop access)",
        argv: [
          "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", `${import.meta.dir}/../helper/lifetime.ps1`, "-StatePath", this.statePath,
        ],
        cwd: this.host.cwd,
      })
      this.lifetime = job.id
      const ready = await this.host.backgroundJobs.waitFor(job.id, {
        pattern: /UIA lifetime ready/,
        timeoutMs: this.timeoutMs,
      })
      if (ready.reason !== "match") throw new Error("UIA lifetime process failed to start")
      job = this.host.backgroundJobs.get(job.id)
    }
    if (this.stopping || previousGeneration !== this.generation) throw new Error("UIA session ended during startup")
    if (!job?.pid) throw new Error("UIA lifetime process has no PID")
    const generation = ++this.generation
    this.buffer = ""
    this.pipe = this.host.openPipe([
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", `${import.meta.dir}/../helper/uia.ps1`,
      "-AppsJson", JSON.stringify(this.apps), "-LifetimePid", String(job.pid), "-StatePath", this.statePath,
    ], {
      cwd: this.host.cwd,
      onEvent: (event) => {
        if (generation === this.generation) this.event(event)
      },
    })
  }

  private event(event: PipeEvent) {
    if (event.type === "exit") {
      this.pipe = undefined
      this.windows.clear()
      this.failPending(new Error("UIA helper exited; old windows and refs are invalid. Launch again."))
      return
    }
    if (event.type !== "stdout") return
    this.buffer += event.data
    if (this.buffer.length > 2_000_000) {
      this.breakPipe("UIA helper response exceeded the limit")
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        const response = JSON.parse(line) as { id: number; result?: unknown; error?: string }
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
    await this.start()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.breakPipe("UIA helper timed out"), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
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

  private breakPipe(message: string) {
    const pipe = this.pipe
    this.pipe = undefined
    this.generation++
    this.windows.clear()
    this.failPending(new Error(message))
    // EOF gives the helper a chance to close even packaged launch hand-offs.
    pipe?.close(5000)
  }

  /** EOF triggers helper finally cleanup. The sentinel covers host-driven unload too. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    const pipe = this.pipe
    this.pipe = undefined
    this.generation++
    this.windows.clear()
    this.failPending(new Error("UIA session ended"))
    pipe?.close(5000)
    if (this.lifetime) await this.host.backgroundJobs.stop(this.lifetime, 1000)
    this.lifetime = undefined
    this.stopping = false
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
  const parts = value.toLowerCase().split("+").map((p) => p.trim())
  const key = parts.pop() ?? ""
  if (new Set(parts).size !== parts.length || parts.some((p) => !["ctrl", "alt", "shift"].includes(p)))
    throw new Error("Unsupported key modifiers (use ctrl, alt, shift)")
  if (parts.includes("alt") && key === "f4") throw new Error("alt+f4 is refused; use ui_close")
  if ((parts.includes("alt") && ["tab", "escape"].includes(key)) || (parts.includes("ctrl") && key === "escape"))
    throw new Error("Desktop-switching key chords are refused")
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|tab|escape|space|backspace|delete|left|right|up|down|home|end|pageup|pagedown)$/.test(key))
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
