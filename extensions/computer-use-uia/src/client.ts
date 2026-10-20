import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import type { ExtensionAPI, PipeEvent, PipeProcess } from "@amira/api"
import { type CustodyOffer, SessionCustody } from "./custody.ts"
import {
  type Observation,
  type ScreenshotGeometry,
  screenshotPoint,
  selectTree,
  validateScreenshot,
} from "./perception.ts"
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

export interface TreeResult extends Observation {}

interface Snapshot {
  refs: Set<string>
  screenshot?: ScreenshotGeometry
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
  private readonly protectedWindows = new Set<string>()
  readonly emergency = new StopState()
  private overlay?: PipeProcess
  private overlayError?: string
  private overlayClass?: string
  private overlayPid?: number
  private arming?: { id: number; resolve(): void; reject(error: Error): void }
  private hiding?: { id: number; resolve(): void; reject(error: Error): void }
  private actionActive = false
  private helperIdentity?: { event: "owner"; pid: number; started: string }
  private overlayExited: Promise<void> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()
  private stopping = false
  private journalKey = randomBytes(32)
  private journalNonce = crypto.randomUUID()
  private helperPid?: number
  private writerConfirmed = false
  private readonly jobRequests = new Map<string, { pipe: PipeProcess; generation: number }>()
  private readonly helperRetirements = new Map<
    number,
    { watchdog: PipeProcess; pid: number; started: string; resolve(): void; reject(error: Error): void }
  >()
  private stopCleanup?: { promise: Promise<void>; resolve(): void; watchdog: PipeProcess }
  private custodyCleanup?: Promise<void>
  private custodyCleanupAgain = false
  private statePath: string
  private watchdog?: PipeProcess
  private custody?: SessionCustody
  private readonly custodiedJobs = new Set<string>()
  private watchdogStarted = false
  private lifetimeStarted?: string
  private pipeExited: Promise<void> = Promise.resolve()
  private watchdogExited: Promise<void> = Promise.resolve()
  private retired: Promise<void> = Promise.resolve()
  private retirementRecovery?: () => Promise<void>
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
  call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const epoch = this.sessionEpoch
    const queuedWhileStopped = this.emergency.stopped && !["windows", "tree", "find"].includes(method)
    const run = this.queue.then(async () => {
      if (signal?.aborted) throw new Error("UIA request cancelled")
      if (queuedWhileStopped) throw new Error(STOP_MESSAGE)
      if (epoch !== this.sessionEpoch)
        throw new Error(
          this.emergency.stopped ? STOP_MESSAGE : "UIA session ended before the request started",
        )
      // A queued cancellation must not retire another request's provider.
      const cancel = () =>
        ["windows", "tree", "find"].includes(method) ? this.cancelRead() : this.emergencyStop()
      signal?.addEventListener("abort", cancel, { once: true })
      try {
        return await this.execute(method, params)
      } finally {
        signal?.removeEventListener("abort", cancel)
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopping) throw new Error("computer-use-uia is stopping")
    if (!["windows", "tree", "find"].includes(method)) this.emergency.assertAction()
    if (method === "windows") {
      if (params.filter !== undefined && typeof params.filter !== "string")
        throw new Error("filter must be a string")
      const result = (await this.request(
        method,
        params.filter === undefined ? {} : { filter: params.filter },
      )) as {
        windows: WindowResult[]
        cut?: boolean
        note?: string
      }
      // The helper revalidates every target, including handles never listed here.
      this.protectedWindows.clear()
      for (const window of result.windows) {
        if (
          (typeof window.class === "string" &&
            ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "AmiraPointerOverlay"].includes(
              window.class,
            )) ||
          (window.class === this.overlayClass &&
            window.pid === this.overlayPid &&
            this.overlayPid !== undefined) ||
          window.pid === process.pid
        )
          this.protectedWindows.add(window.window)
      }
      const windows = result.windows.slice(0, 200).map((window) => ({
        ...window,
        title: window.title.slice(0, 120),
      }))
      const cut =
        result.cut ||
        result.windows.length > 200 ||
        result.windows.some((window) => window.title.length > 120)
      return cut
        ? {
            ...result,
            windows,
            cut: true,
            note: result.note ?? "Window output cut (200 windows / 120-character titles)",
          }
        : { ...result, windows }
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
    if (!["tree", "find", "click", "scroll", "type", "key", "focus", "close"].includes(method))
      throw new Error("Unknown UIA request")
    if (typeof params.window !== "string" || !/^[1-9]\d*$/.test(params.window))
      throw new Error("window must be a native window handle from ui_windows or ui_launch")
    if (!["tree", "find"].includes(method) && this.protectedWindows.has(params.window))
      throw new Error("Refused: shell, system, overlay and Amira windows cannot be controlled")
    let snapshot = this.windows.get(params.window)
    if (!snapshot) {
      snapshot = { refs: new Set() }
      this.windows.set(params.window, snapshot)
    }
    const safe: Record<string, unknown> = { window: params.window }
    if (method === "tree" || method === "find") {
      if (method === "tree") {
        safe.depth = boundedInt(params.depth, 8, 0, 30, "depth")
        safe.maxNodes = boundedInt(params.maxNodes, 300, 1, 1000, "maxNodes")
        safe.screenshot = this.settings.screenshot
        safe.screenshotMaxEdge = this.settings.screenshotMaxEdge
      } else {
        for (const key of ["name", "role", "automationId"]) {
          const value = params[key]
          if (value === undefined) continue
          if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonempty string`)
          if (key === "role" && !/^[a-z]+$/i.test(value))
            throw new Error("role must be a ControlType name without 'ControlType.' (for example Button)")
          safe[key] = value
        }
        if ([safe.name, safe.role, safe.automationId].every((value) => value === undefined))
          throw new Error("ui_find requires at least one of name, role or automationId")
        safe.maxResults = boundedInt(params.maxResults, 20, 1, 100, "maxResults")
      }
      if (params.root !== undefined) {
        if (typeof params.root !== "string" || !snapshot.refs.has(params.root))
          throw new Error("Invalid or stale root ref; call ui_tree without root to get fresh refs")
        safe.root = params.root
      }
      safe.treeDensityThreshold = this.settings.treeDensityThreshold
      // Resolve root against the old generation before replacing it. A failed
      // traversal/capture also invalidates the previous snapshot and coordinates.
      snapshot.refs.clear()
      snapshot.screenshot = undefined
    }
    const coordinateAction = method === "scroll" || (method === "click" && params.ref === undefined)
    if (coordinateAction) {
      const image = snapshot.screenshot
      if (!image || params.screenshot !== image.id)
        throw new Error("Refused: screenshot is not this window's latest observation; call ui_tree first")
      screenshotPoint(image, params.x, params.y)
      safe.x = params.x
      safe.y = params.y
      safe.screenshot = image.id
      if (method === "scroll") {
        safe.delta = boundedInt(params.delta, 0, -10, 10, "delta")
        if (safe.delta === 0) throw new Error("delta must be nonzero wheel notches (-10 to 10)")
      }
    }
    if (
      method === "click" &&
      params.ref !== undefined &&
      [params.x, params.y, params.screenshot].some((value) => value !== undefined)
    )
      throw new Error("Use either ref or screenshot/x/y, not both")
    if ((method === "click" && !coordinateAction) || (method === "type" && params.ref !== undefined)) {
      if (typeof params.ref !== "string" || !snapshot.refs.has(params.ref))
        throw new Error(
          "Refused: ref is not in this window's latest tree/find snapshot; call ui_tree or ui_find first",
        )
      safe.ref = params.ref
    }
    if (method === "type") {
      if (typeof params.text !== "string" || params.text.length > 20_000)
        throw new Error("text must be a string of at most 20000 characters")
      safe.text = params.text
    }
    if (method === "key") safe.keys = validateKeys(params.keys)
    const result = await this.request(method, safe)
    if (method === "tree" || method === "find") {
      const tree = result as TreeResult
      const formatted =
        method === "find"
          ? { ...formatTree(tree, safe.maxResults as number), search: true }
          : selectTree(
              {
                ...formatTree(tree, safe.maxNodes as number),
                ...(this.settings.screenshot
                  ? { screenshot: validateScreenshot(tree.screenshot, this.settings.screenshotMaxEdge) }
                  : {}),
              },
              this.settings.treeDensityThreshold,
            )
      // Retain only coordinate metadata, not a PNG per observed window.
      const image = formatted.screenshot
      snapshot.screenshot = image && {
        id: image.id,
        width: image.width,
        height: image.height,
        bounds: image.bounds,
        scaleX: image.scaleX,
        scaleY: image.scaleY,
        dpi: image.dpi,
      }
      for (const line of formatted.text.split("\n")) {
        const ref = /^\s*(e\d+)\s/.exec(line)?.[1]
        if (ref && !/^\s*e\d+\s+unreadable\b/.test(line)) snapshot.refs.add(ref)
      }
      return formatted
    }
    if (method === "close") this.windows.delete(params.window)
    return result
  }

  private rotateJournal(): void {
    // Called only after the previous watchdog exited. Independent custody still
    // retains the original kernel jobs; this journal is never recovery authority.
    for (const path of [this.statePath, `${this.statePath}.tmp`]) {
      try {
        rmSync(path, { force: true })
      } catch {
        this.host.reportError("computer-use-uia: could not remove retired launch journal")
      }
    }
    this.statePath = `${process.env.TEMP ?? process.env.TMP ?? this.host.cwd}/amira-uia-${crypto.randomUUID()}.json`
    this.journalKey = randomBytes(32)
    this.journalNonce = crypto.randomUUID()
  }

  private async start(): Promise<void> {
    if (this.pipe) return
    const previousGeneration = this.generation
    await this.confirmRetirement()
    if (this.stopCleanup || this.custodyCleanup) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            // A second stop can enqueue another pass while the first acknowledgement settles.
            // Follow the live gates until all requested passes finish, not a stale snapshot.
            while (this.stopCleanup || this.custodyCleanup)
              await Promise.all([this.stopCleanup?.promise, this.custodyCleanup])
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("UIA stop cleanup timed out; restart refused")),
              Math.min(10_000, this.timeoutMs),
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (this.stopping || previousGeneration !== this.generation)
      throw new Error("UIA session ended during startup")
    // Background jobs have an unload lifetime; pipes require this sentinel/watchdog bridge.
    let job = this.lifetime ? this.host.backgroundJobs.get(this.lifetime) : undefined
    if (!job || !["starting", "running"].includes(job.status)) {
      // A new sentinel means a new session. Drain the old owner before rotating secrets.
      const watchdog = this.watchdog
      this.watchdog = undefined
      watchdog?.close(15_000)
      await this.watchdogExited
      await this.custody?.stop()
      this.custody = undefined
      if (this.stopping || previousGeneration !== this.generation)
        throw new Error("UIA session ended during startup")
      this.rotateJournal()
      this.watchdogStarted = false
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
    if (!this.custody) {
      this.custody = new SessionCustody(this.host, this.timeoutMs, () => {
        if (this.stopping) return
        this.host.reportError("computer-use-uia: independent custody owner exited; restart the session")
        const changed = this.emergency.stop()
        this.sessionEpoch++
        this.breakPipe("UIA custody owner exited; desktop control stopped")
        if (changed) this.onStopped()
      })
    }
    await this.custody.start(job.pid, this.lifetimeStarted)
    if (this.stopping || previousGeneration !== this.generation)
      throw new Error("UIA session ended during custody startup")
    if (!this.watchdog) {
      // Replacement watchdogs get fresh journals, but custody keeps all earlier
      // authenticated cleanup duplicates for this same session lifetime.
      if (this.watchdogStarted) {
        await this.watchdogExited
        this.rotateJournal()
      }
      await this.startWatchdog(job.pid, this.lifetimeStarted)
      this.watchdogStarted = true
    }
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
        "-AmiraPid",
        String(process.pid),
        "-Overlay",
        String(this.settings.overlay),
      ],
      {
        cwd: this.host.cwd,
        onEvent: (event) => {
          if (event.type === "exit") {
            exited.resolve()
            for (const [job, origin] of this.jobRequests)
              if (origin.generation === generation) this.jobRequests.delete(job)
          }
          if (generation === this.generation) this.event(event)
        },
      },
    )
    this.pipe.write(
      `${JSON.stringify({ event: "journal-key", key: this.journalKey.toString("base64"), nonce: this.journalNonce })}\n`,
    )
    if (this.settings.overlay) await this.tryOverlay(job.pid, this.lifetimeStarted)
    if (this.stopping || generation !== this.generation) throw new Error("UIA session ended during startup")
  }

  /** Stop is out-of-band: retire even a helper blocked inside a synchronous UIA provider. */
  emergencyStop(): void {
    const changed = this.emergency.stop()
    this.sessionEpoch++
    if (this.watchdog && !this.stopCleanup) {
      this.stopCleanup = { ...Promise.withResolvers<void>(), watchdog: this.watchdog }
      this.watchdog.write(`${JSON.stringify({ event: "stop" })}\n`)
    }
    // Start exact-helper retirement NOW, even if a prior stop's custody pass is pending.
    this.breakPipe(STOP_MESSAGE)
    this.requestCustodyCleanup()
    if (changed) this.onStopped()
  }

  private requestCustodyCleanup(): void {
    if (this.custodyCleanup) {
      this.custodyCleanupAgain = true
      return
    }
    this.custodyCleanupAgain = false
    const custody = this.custody
    if (!custody) return
    const watchdogCleanup = this.stopCleanup?.promise
    const retirement = this.confirmRetirement()
    const cleanup = (async () => {
      const timer = setTimeout(
        () => {
          this.host.reportError(
            "computer-use-uia: session headless cleanup incomplete; confirmation still pending",
          )
        },
        Math.min(10_000, this.timeoutMs),
      )
      try {
        // A pre-retirement pass can preserve a rootless launch which becomes abandoned
        // immediately afterwards. Also wait for the watchdog's own drain/exit checkpoint.
        await retirement
        await watchdogCleanup
        if (await custody.stopHeadless())
          this.host.reportError("computer-use-uia: session headless cleanup incomplete")
      } catch {
        this.host.reportError(
          "computer-use-uia: session headless cleanup incomplete; retirement or custody unconfirmed",
        )
      } finally {
        clearTimeout(timer)
      }
    })()
    this.custodyCleanup = cleanup
    void cleanup.then(() => {
      if (this.custodyCleanup !== cleanup) return
      this.custodyCleanup = undefined
      // Include requests arriving even between settlement and this continuation. Coalesce a
      // burst into one more post-retirement pass; never drop it behind the stopped latch.
      if (this.custodyCleanupAgain) this.requestCustodyCleanup()
    })
  }

  resume(): void {
    this.emergency.resume()
  }

  /** Cancelling a read retires its provider without changing the action stop latch. */
  cancelRead(): void {
    this.breakPipe("UIA read cancelled")
  }

  private async tryOverlay(pid: number, started: string): Promise<void> {
    try {
      await this.startOverlay(pid, started)
      this.overlayError = undefined
    } catch (error) {
      this.overlayError = error instanceof Error ? error.message : String(error)
      this.host.reportError(`computer-use-uia: ${this.overlayError}`)
    }
  }

  private overlayUnavailable(message: string): void {
    this.overlayError = message
    this.arming?.reject(new Error(message))
    this.hiding?.reject(new Error(message))
    const overlay = this.overlay
    this.overlay = undefined
    overlay?.write(`${JSON.stringify({ event: "exit" })}\n`)
    overlay?.close(5000)
    this.host.reportError(`computer-use-uia: ${message}`)
    // A running action cannot continue without its stop monitor. This is an error,
    // not a user stop; startup/read failures keep the helper available for reads.
    if (this.actionActive) this.breakPipe(message)
  }

  private async startOverlay(pid: number, started: string): Promise<void> {
    const generation = this.generation
    await this.overlayExited
    if (this.stopping || generation !== this.generation)
      throw new Error("UIA session ended during overlay startup")
    const ready = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<void>()
    this.overlayExited = exited.promise
    let hasExited = false
    let buffer = ""
    const timer = setTimeout(
      () => ready.reject(new Error("UIA stop monitor failed to start")),
      this.timeoutMs,
    )
    let overlay: PipeProcess | undefined
    try {
      overlay = this.host.openPipe(
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
              hasExited = true
              exited.resolve()
              ready.reject(new Error("UIA stop monitor exited"))
              if (this.overlay === overlay)
                this.overlayUnavailable(this.overlayError ?? "UIA stop monitor exited")
            }
            if (event.type === "stderr" && event.data.includes("UIA input cleanup incomplete"))
              this.host.reportError(
                "computer-use-uia: input cleanup incomplete; release held keys/buttons manually",
              )
            if (event.type !== "stdout" || hasExited || this.stopping) return
            const current = this.overlay === overlay
            // While retiring, accept only its physical stop. Replacement startup
            // waits for this monitor's exit, so it cannot stop a later generation.
            if (!current && (this.overlay || this.pipe)) return
            buffer += event.data
            if (buffer.length > 20_000) {
              const message = "UIA stop monitor response exceeded the limit"
              ready.reject(new Error(message))
              this.overlayUnavailable(message)
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
                if (!current) {
                  if (reply.event === "stop") this.emergencyStop()
                  continue
                }
                if (reply.event === "ready") {
                  this.overlayClass = reply.class
                  this.overlayPid = reply.pid
                  ready.resolve()
                } else if (reply.event === "stop") this.emergencyStop()
                else if (reply.event === "glided")
                  this.pipe?.write(`${JSON.stringify({ method: "overlay_ack", id: reply.id })}\n`)
                else if (reply.event === "armed" && reply.id === this.arming?.id) this.arming.resolve()
                else if (reply.event === "hidden" && reply.id === this.hiding?.id) this.hiding.resolve()
                else if (reply.event === "error") {
                  ready.reject(new Error(reply.error))
                  this.overlayUnavailable(reply.error)
                }
              } catch {
                const message = "UIA stop monitor sent an invalid response"
                ready.reject(new Error(message))
                this.overlayUnavailable(message)
              }
            }
          },
        },
      )
      this.overlay = overlay
      if (this.helperIdentity) overlay.write(`${JSON.stringify(this.helperIdentity)}\n`)
      await ready.promise
    } catch (error) {
      if (overlay && this.overlay === overlay)
        this.overlayUnavailable(error instanceof Error ? error.message : String(error))
      if (!overlay) exited.resolve()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async startWatchdog(pid: number, started: string): Promise<void> {
    const ready = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<void>()
    this.watchdogExited = exited.promise
    let watchdogPid: number | undefined
    let output = ""
    let stderr = ""
    const reportStderr = (line: string) => {
      if (line.includes("still starting") || line.includes("Launch root registration pending"))
        this.host.reportError(`computer-use-uia: ${line}`)
      if (line.includes("untrusted launch journal"))
        this.host.reportError("computer-use-uia: untrusted launch journal; cleanup refused")
      if (line.includes("UIA cleanup incomplete"))
        this.host.reportError("computer-use-uia: cleanup incomplete; launch identities retained for retry")
    }
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
          if (event.type === "spawned") watchdogPid = event.pid
          if (event.type === "stdout") {
            output += event.data
            let newline = output.indexOf("\n")
            while (newline >= 0) {
              const line = output.slice(0, newline).trim()
              output = output.slice(newline + 1)
              newline = output.indexOf("\n")
              if (!line) continue
              if (line === "UIA watchdog ready") ready.resolve()
              else {
                try {
                  const reply = JSON.parse(line) as {
                    event?: string
                    job?: string
                    handle?: number
                    parentHandle?: number
                    parentPid?: number
                    parentStarted?: string
                    incomplete?: boolean
                    failed?: boolean
                    generation?: number
                    pid?: number
                    started?: string
                    session?: string
                    transfer?: string
                    writerPid?: number
                    writerStarted?: string
                  }
                  if (reply.event === "job-custody")
                    void this.acceptCustody(watchdog, watchdogPid, reply as CustodyOffer)
                  if (
                    reply.event === "writer-accepted" &&
                    this.helperIdentity &&
                    reply.generation === this.generation &&
                    reply.pid === this.helperIdentity?.pid &&
                    reply.started === this.helperIdentity?.started
                  ) {
                    this.writerConfirmed = true
                    this.pipe?.write(`${JSON.stringify({ method: "writer_ack" })}\n`)
                  }
                  if (reply.event === "job-created" && typeof reply.job === "string") {
                    const origin = this.jobRequests.get(reply.job)
                    this.jobRequests.delete(reply.job)
                    if (
                      origin &&
                      this.watchdog === watchdog &&
                      origin.pipe === this.pipe &&
                      origin.generation === this.generation &&
                      this.custodiedJobs.delete(reply.job) &&
                      Number.isSafeInteger(reply.handle) &&
                      reply.handle! > 0 &&
                      Number.isSafeInteger(reply.parentHandle) &&
                      reply.parentHandle! > 0 &&
                      Number.isInteger(reply.parentPid) &&
                      reply.parentPid! > 0 &&
                      reply.parentPid === this.custody?.identity?.pid &&
                      typeof reply.parentStarted === "string" &&
                      reply.parentStarted === this.custody?.identity?.started
                    )
                      origin.pipe.write(
                        `${JSON.stringify({ method: "job_ack", job: reply.job, handle: reply.handle, parentHandle: reply.parentHandle, parentPid: reply.parentPid, parentStarted: reply.parentStarted })}\n`,
                      )
                    else if (origin)
                      origin.pipe.write(
                        `${JSON.stringify({ method: "job_ack", job: reply.job, handle: reply.handle, parentHandle: reply.parentHandle, parentPid: reply.parentPid, parentStarted: reply.parentStarted, rejected: true })}\n`,
                      )
                  }
                  if (reply.event === "root-registered" && typeof reply.job === "string") {
                    const origin = this.jobRequests.get(reply.job)
                    this.jobRequests.delete(reply.job)
                    if (origin?.pipe === this.pipe && origin?.generation === this.generation)
                      origin.pipe.write(`${JSON.stringify({ method: "root_ack", job: reply.job })}\n`)
                  }
                  if (reply.event === "retired" && typeof reply.generation === "number") {
                    const retirement = this.helperRetirements.get(reply.generation)
                    if (
                      retirement?.watchdog === watchdog &&
                      retirement.pid === reply.pid &&
                      retirement.started === reply.started &&
                      typeof reply.failed === "boolean"
                    ) {
                      if (reply.failed)
                        retirement.reject(new Error("UIA helper retirement failed; restart refused"))
                      else retirement.resolve()
                    }
                  }
                  if (reply.event === "stopped") {
                    if (reply.incomplete)
                      this.host.reportError(
                        "computer-use-uia: headless cleanup incomplete; launch journal retained",
                      )
                    this.finishWatchdogCleanup(watchdog)
                  }
                } catch {
                  this.host.reportError("computer-use-uia: invalid watchdog response")
                }
              }
            }
          }
          if (event.type === "stderr") {
            stderr += event.data
            let newline = stderr.indexOf("\n")
            while (newline >= 0) {
              reportStderr(stderr.slice(0, newline).trim())
              stderr = stderr.slice(newline + 1)
              newline = stderr.indexOf("\n")
            }
          }
          if (event.type === "exit") {
            if (stderr.trim()) reportStderr(stderr.trim())
            stderr = ""
            exited.resolve()
            ready.reject(new Error("UIA watchdog exited"))
            this.finishWatchdogCleanup(watchdog)
            if (this.watchdog === watchdog) {
              this.watchdog = undefined
              if (!this.stopping) {
                const changed = this.emergency.stop()
                this.sessionEpoch++
                this.host.reportError(
                  "computer-use-uia: watchdog exited; session custody retains previous launches",
                )
                this.breakPipe("UIA watchdog exited; desktop control stopped")
                if (changed) this.onStopped()
              }
            }
          }
        },
      },
    )
    this.watchdog = watchdog
    watchdog.write(
      `${JSON.stringify({ event: "journal-key", key: this.journalKey.toString("base64"), nonce: this.journalNonce })}\n`,
    )
    watchdog.write(
      `${JSON.stringify({ event: "custody-session", session: this.custody!.session, ...this.custody!.identity })}\n`,
    )
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

  private async acceptCustody(
    watchdog: PipeProcess,
    pid: number | undefined,
    offer: CustodyOffer,
  ): Promise<void> {
    const origin = this.jobRequests.get(offer.job)
    const custody = this.custody
    try {
      if (
        !custody ||
        this.watchdog !== watchdog ||
        !origin ||
        origin.pipe !== this.pipe ||
        origin.generation !== this.generation ||
        offer.pid !== pid ||
        offer.writerPid !== this.helperIdentity?.pid ||
        offer.writerStarted !== this.helperIdentity?.started
      )
        throw new Error("Invalid custody source identity; launch refused")
      await custody.retain(offer)
      // A late duplicate remains safe in the session owner, but can never unlock
      // a retired helper or a replacement watchdog/session.
      if (
        this.stopping ||
        this.custody !== custody ||
        this.watchdog !== watchdog ||
        origin.pipe !== this.pipe ||
        origin.generation !== this.generation
      )
        return
      this.custodiedJobs.add(offer.job)
      watchdog.write(`${JSON.stringify({ ...offer, event: "custody-accepted" })}\n`)
    } catch (error) {
      watchdog.write(`${JSON.stringify({ event: "custody-rejected", job: offer.job })}\n`)
      if (this.watchdog === watchdog && origin?.pipe === this.pipe) {
        const message = error instanceof Error ? error.message : String(error)
        this.host.reportError(`computer-use-uia: ${message}`)
        this.breakPipe(message)
      }
    }
  }

  private async commitLaunchRoot(root: {
    job: string
    pid?: number
    started?: string
    threadId?: number
  }): Promise<void> {
    const pipe = this.pipe
    const watchdog = this.watchdog
    const custody = this.custody
    const origin = { pipe: pipe!, generation: this.generation }
    try {
      if (!pipe || !watchdog || !custody || !Number.isInteger(root.threadId) || root.threadId! <= 0)
        throw new Error("Invalid launch commit; custody unavailable")
      this.jobRequests.set(root.job, origin)
      // Custody must know the exact native job root and grace timestamp BEFORE it can run,
      // including if this watchdog dies immediately after its resume call.
      await custody.rememberRoot(root.job, root.pid!, root.started!)
      if (
        this.stopping ||
        this.pipe !== pipe ||
        this.watchdog !== watchdog ||
        this.custody !== custody ||
        this.generation !== origin.generation ||
        this.jobRequests.get(root.job) !== origin
      )
        return
      watchdog.write(`${JSON.stringify({ ...root, event: "launch-root", generation: origin.generation })}\n`)
    } catch (error) {
      if (this.pipe === pipe && this.watchdog === watchdog) {
        const message = error instanceof Error ? error.message : String(error)
        this.host.reportError(`computer-use-uia: ${message}`)
        this.breakPipe(message)
      }
    }
  }

  private event(event: PipeEvent) {
    if (event.type === "spawned") {
      this.helperPid = event.pid
      this.watchdog?.write(
        `${JSON.stringify({ event: "helper-spawned", pid: event.pid, generation: this.generation })}\n`,
      )
      return
    }
    if (event.type === "stderr" && event.data.includes("skipping animation wait"))
      this.host.reportError(`computer-use-uia: ${event.data.trim()}`)
    if (event.type === "exit") {
      // A stop-monitor kill and a helper exit may arrive on different pipes in either order.
      // Unexpected helper death must latch too, never let that race reopen desktop control.
      // Crash/restart latches actions, but must not invoke the explicit stop kill rule.
      const changed = this.emergency.stop()
      this.sessionEpoch++
      this.helperIdentity = undefined // The native exit is already confirmed; no retirement needed.
      this.breakPipe(STOP_MESSAGE)
      if (changed) this.onStopped()
      return
    }
    if (event.type !== "stdout") return
    this.buffer += event.data
    // A bounded PNG can exceed the old text-only ceiling (base64 adds one third).
    const responseLimit = this.settings.screenshot
      ? Math.ceil(((this.settings.screenshotMaxEdge ** 2 * 4 + 1_048_576) * 4) / 3) + 250_000
      : 2_000_000
    if (this.buffer.length > responseLimit) {
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
          job?: string
          failed?: boolean
          threadId?: number
        }
        if (response.event === "launch-finished" && typeof response.job === "string") {
          this.watchdog?.write(
            `${JSON.stringify({ event: "launch-finished", job: response.job, failed: response.failed, generation: this.generation })}\n`,
          )
          continue
        }
        if (response.event === "create-job" && typeof response.job === "string") {
          const pipe = this.pipe
          const watchdog = this.watchdog
          const generation = this.generation
          const job = response.job
          // The private, PID/start-time-verified writer may create new unnamed jobs.
          // Journal records authorize adoption only, never gate fresh launches.
          if (
            !this.helperIdentity ||
            !this.writerConfirmed ||
            !pipe ||
            !watchdog ||
            !/^amira-uia-job-[0-9a-f-]{36}$/.test(job)
          ) {
            this.breakPipe("Unverified launch job request; launch refused")
            return
          }
          this.jobRequests.set(job, { pipe, generation })
          watchdog.write(`${JSON.stringify({ event: "create-job", job })}\n`)
          continue
        }
        if (
          response.event === "launch-root" &&
          this.helperIdentity &&
          this.writerConfirmed &&
          this.pipe &&
          response.job
        ) {
          void this.commitLaunchRoot({
            job: response.job,
            pid: response.pid,
            started: response.started,
            threadId: response.threadId,
          })
          continue
        }
        if (response.event === "helper") {
          if (
            this.helperIdentity ||
            response.pid !== this.helperPid ||
            !Number.isInteger(response.pid) ||
            !response.pid ||
            !response.started ||
            !/^\d+$/.test(response.started)
          ) {
            this.breakPipe("Invalid helper identity")
            return
          }
          this.helperIdentity = { event: "owner", pid: response.pid, started: response.started }
          this.watchdog?.write(
            `${JSON.stringify({ event: "writer", pid: response.pid, started: response.started, generation: this.generation })}\n`,
          )
          this.overlay?.write(`${JSON.stringify(this.helperIdentity)}\n`)
          continue
        }
        if (response.event === "overlay" || response.event === "done") {
          // Rendering acknowledgements are advisory; the helper skips slow animations.
          this.overlay?.write(`${line}\n`)
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
    const action = !["windows", "tree", "find"].includes(method)
    const alreadyStarted = !!this.pipe
    try {
      await this.start()
      if (
        (action || (method === "tree" && this.settings.screenshot)) &&
        alreadyStarted &&
        this.settings.overlay &&
        !this.overlay &&
        this.lifetimeStarted
      ) {
        const job = this.lifetime ? this.host.backgroundJobs.get(this.lifetime) : undefined
        if (job?.pid) await this.tryOverlay(job.pid, this.lifetimeStarted)
      }
    } catch (error) {
      if (this.emergency.stopped) throw new Error(STOP_MESSAGE)
      throw error
    }
    if (action) this.emergency.assertAction()
    if (!this.pipe || this.stopping) throw new Error("UIA helper exited before the request started")
    const id = ++this.nextId
    if (method === "tree" && this.settings.screenshot && this.overlay) {
      const overlay = this.overlay
      const hidden = Promise.withResolvers<void>()
      this.hiding = { id, ...hidden }
      const timer = setTimeout(
        () => hidden.reject(new Error("UIA overlay did not hide; screenshot refused")),
        Math.min(5000, this.timeoutMs),
      )
      try {
        overlay.write(`${JSON.stringify({ event: "observe", id })}\n`)
        await hidden.promise
        if (this.overlay !== overlay) throw new Error("UIA overlay changed before capture")
      } catch (error) {
        if (this.overlay === overlay)
          this.overlayUnavailable(error instanceof Error ? error.message : String(error))
        if (this.emergency.stopped) throw new Error(STOP_MESSAGE)
        throw error
      } finally {
        clearTimeout(timer)
        this.hiding = undefined
      }
    }
    if (action && this.settings.overlay) {
      if (!this.overlay) throw new Error(this.overlayError ?? "UIA stop monitor unavailable")
      const overlay = this.overlay
      const armed = Promise.withResolvers<void>()
      this.arming = { id, ...armed }
      const timer = setTimeout(
        () => armed.reject(new Error("UIA stop monitor did not arm; desktop action refused")),
        Math.min(5000, this.timeoutMs),
      )
      try {
        overlay.write(`${JSON.stringify({ event: "busy", id })}\n`)
        await armed.promise
        if (this.overlay !== overlay) throw new Error(this.overlayError ?? "UIA stop monitor unavailable")
      } catch (error) {
        if (this.emergency.stopped) throw new Error(STOP_MESSAGE)
        this.overlayUnavailable(error instanceof Error ? error.message : String(error))
        throw error
      } finally {
        clearTimeout(timer)
        this.arming = undefined
      }
      this.emergency.assertAction()
    }
    if (!this.pipe || this.stopping) throw new Error("UIA helper exited before the request started")
    this.actionActive = action
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (action) {
            this.emergency.stop()
            this.sessionEpoch++
          }
          this.breakPipe("UIA helper timed out")
        }, this.timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        const safe =
          action && this.overlayClass && this.overlayPid
            ? { ...params, overlayClass: this.overlayClass, overlayPid: this.overlayPid }
            : params
        this.pipe?.write(`${JSON.stringify({ id, method, params: safe })}\n`)
      })
    } finally {
      this.actionActive = false
      if (action) this.overlay?.write(`${JSON.stringify({ event: "done" })}\n`)
    }
  }

  private failPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }

  private finishWatchdogCleanup(watchdog: PipeProcess): void {
    const cleanup = this.stopCleanup
    if (!cleanup || cleanup.watchdog !== watchdog) return
    cleanup.resolve()
    this.stopCleanup = undefined
  }

  /** One identity-bound confirmation rule for both replacement and post-stop classification. */
  private async confirmRetirement(): Promise<void> {
    const retired = this.retired
    const recover = this.retirementRecovery
    try {
      await retired
    } catch (error) {
      if (!recover) throw error
      await recover()
      // Never overwrite a newer helper's retirement/recovery gate.
      if (this.retired === retired) {
        this.retirementRecovery = undefined
        this.retired = Promise.resolve()
      }
    }
  }

  private async retireHelper(pipe: PipeProcess | undefined, graceMs = 0): Promise<void> {
    if (!pipe) return
    const identity = this.helperIdentity
    const exited = this.pipeExited
    const generation = this.generation
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("UIA helper retirement timed out; restart refused")),
        Math.min(10_000, this.timeoutMs),
      )
    })
    try {
      if (!identity) {
        // Before the writer announcement no launch can execute. After an exit this is a no-op.
        pipe.close(graceMs)
        await Promise.race([exited, timeout])
        return
      }
      const watchdog = this.watchdog
      if (watchdog) {
        const acknowledged = Promise.withResolvers<void>()
        this.helperRetirements.set(generation, {
          watchdog,
          pid: identity.pid,
          started: identity.started,
          ...acknowledged,
        })
        watchdog.write(
          `${JSON.stringify({ event: "retire", pid: identity.pid, started: identity.started, generation })}\n`,
        )
        const helperExited = await Promise.race([
          exited.then(() => true),
          acknowledged.promise.then(() => exited).then(() => true),
          this.watchdogExited.then(() => false),
          timeout,
        ])
        if (helperExited) {
          pipe.close(graceMs)
          return
        }
      }
      // openPipe.close() tree-kills on Windows. If the owner died, use a headless
      // exact-handle reaper instead; never cascade retirement into launched apps.
      const done = Promise.withResolvers<void>()
      try {
        this.host.openPipe(
          [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            `${import.meta.dir}/../helper/lifetime.ps1`,
            "-RetirePid",
            String(identity.pid),
            "-RetireStarted",
            identity.started,
          ],
          {
            cwd: this.host.cwd,
            onEvent: (event) => {
              if (event.type === "exit") {
                if (event.code !== 0) done.reject(new Error("UIA helper retirement failed; restart refused"))
                else done.resolve()
              }
            },
          },
        )
      } catch {
        done.reject(new Error("UIA helper retirement failed; restart refused"))
      }
      await Promise.race([Promise.all([exited, done.promise]), timeout])
      pipe.close(graceMs)
    } catch (error) {
      this.host.reportError(`computer-use-uia: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      clearTimeout(timer)
      this.helperRetirements.delete(generation)
    }
  }

  private breakPipe(message: string, graceMs = 0) {
    const pipe = this.pipe
    const overlay = this.overlay
    const retirement = pipe ? this.retireHelper(pipe, graceMs) : this.retired
    // Failed in-flight requests must not continue acting after their error is returned.
    // Keep the independent input-release monitor alive long enough to process abort/EOF.
    overlay?.write(`${JSON.stringify({ event: "abort" })}\n`)
    this.pipe = undefined
    this.overlay = undefined
    overlay?.close(5000)
    this.helperIdentity = undefined
    this.helperPid = undefined
    this.writerConfirmed = false
    this.custodiedJobs.clear()
    // Keep pending transfers until their original helper exits so a late reply
    // can be explicitly rejected there, never delivered to a replacement helper.
    this.generation++
    this.windows.clear()
    this.protectedWindows.clear()
    this.arming?.reject(new Error(message))
    this.hiding?.reject(new Error(message))
    this.failPending(new Error(message))
    // Never overlap helpers writing the same launch journal during a restart.
    const exited = this.pipeExited
    const overlayExited = this.overlayExited
    if (pipe) {
      let confirmedGone = false
      void exited.then(() => {
        confirmedGone = true
      })
      this.retirementRecovery = async () => {
        if (!confirmedGone)
          throw new Error(
            "UIA helper retirement failed; restart refused: old helper exit is unconfirmed; retry /uia resume after it exits",
          )
        // A native exit notification is identity-bound to this exact pipe generation.
        // Only then is a host pipe close safe (it must never tree-kill a live helper).
        pipe.close(graceMs)
        await overlayExited
      }
    }
    this.retired = Promise.all([retirement, exited, overlayExited]).then(() => {})
    // Retain the rejection to fail closed at start()/stop(), without an unhandled void-stop rejection.
    void this.retired.catch(() => {})
  }

  /** Independent custody EOF/sentinel death drains ALL original and replacement trees. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopWait
    this.stopping = true
    const watchdog = this.watchdog
    // Teardown uses the same identity-bound retirement/recovery gate as interruption.
    // Even a failed stop must not permit a replacement while the old helper is alive.
    this.breakPipe("UIA session ended")
    this.watchdog = undefined
    this.sessionEpoch++
    // Watchdog EOF grace (3 s), helper retirement (1 s), then two 2 s job drains.
    watchdog?.close(15_000)
    // Independent duplicates survive watchdog crashes/replacement. Producer
    // retirement and complete job drains run before this separate owner exits.
    const custody = this.custody
    let custodyDrained = !custody
    const custodyStopped = custody?.stop().then(() => {
      custodyDrained = true
    })
    // Retirement is bounded and proves helper exit on success. Do not separately
    // await an immortal pipe after a retirement failure, but still drain the owner.
    this.stopWait = Promise.allSettled([
      this.retired,
      this.watchdogExited,
      this.overlayExited,
      ...(custodyStopped ? [custodyStopped] : []),
      ...(this.lifetime ? [this.host.backgroundJobs.stop(this.lifetime, 1000)] : []),
    ]).then((results) => {
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })
    try {
      await this.stopWait
    } finally {
      this.lifetime = undefined
      this.lifetimeStarted = undefined
      if (custodyDrained && this.custody === custody) this.custody = undefined
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
  return {
    text,
    nodes: kept.length,
    chars: text.length,
    ms: tree.ms,
    cut,
    ...(tree.cached === undefined ? {} : { cached: tree.cached }),
    ...(tree.fallback === undefined ? {} : { fallback: tree.fallback }),
    ...(tree.visited === undefined ? {} : { visited: tree.visited }),
    ...(tree.retried === undefined ? {} : { retried: tree.retried }),
    ...(tree.chromiumSparse === undefined ? {} : { chromiumSparse: tree.chromiumSparse }),
  }
}
