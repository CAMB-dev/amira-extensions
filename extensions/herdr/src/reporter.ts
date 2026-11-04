/** What herdr shows for an agent. */
export type HerdrState = "working" | "idle" | "blocked"

/** The session herdr reopens in the pane after a restart. */
export interface SessionReport {
  id: string
  /** The resume command; unset when herdr would refuse it (the state is still reported). */
  argv?: string[]
}

export interface StateReport {
  state: HerdrState
  /** Why it is blocked: one line, short. */
  message?: string
}

/** Runs one herdr CLI call: true when it exited with 0. Never throws. */
export type RunHerdr = (argv: string[], timeoutMs: number, signal?: AbortSignal) => Promise<boolean>

export interface ReporterOptions {
  /** HERDR_BIN_PATH. */
  bin: string
  /** HERDR_PANE_ID. */
  pane: string
  run: RunHerdr
  now?: () => number
}

/** Identifies this integration to herdr (never starting with "herdr:"), and the name users see. */
export const SOURCE = "amira"
export const AGENT = "amira"
/** A report that takes longer is killed: herdr is local, and a stuck call must not pile up. */
export const REPORT_TIMEOUT_MS = 2000
/** Exit waits at most this long for the release. */
export const RELEASE_TIMEOUT_MS = 1000

/**
 * Sends reports to herdr through its CLI, one call at a time. A report made while a call runs
 * waits, and a newer one replaces it: herdr only needs the latest state. Every call gets a
 * strictly greater `--seq` (microseconds since the epoch, so it also grows across restarts),
 * and failures are ignored: herdr then falls back to reading the screen.
 */
export class Reporter {
  #opts: ReporterOptions
  #now: () => number
  #seq = 0
  #inFlight: Promise<void> | undefined
  #pending: StateReport | undefined
  /** A session not told yet: it goes with the next state report, and again if that one fails. */
  #session: SessionReport | undefined
  #released: Promise<void> | undefined
  #reported = false
  #abort = new AbortController()
  #disposed = false
  /** For tests and diagnostics: calls that failed or timed out. */
  failures = 0

  constructor(opts: ReporterOptions) {
    this.#opts = opts
    this.#now = opts.now ?? Date.now
  }

  /** The next sequence number: strictly increasing, and above any earlier run's. */
  nextSeq(): number {
    this.#seq = Math.max(Math.floor(this.#now() * 1000), this.#seq + 1)
    return this.#seq
  }

  /** Attaches `session` to the next state report (replacing one not sent yet). */
  setSession(session: SessionReport): void {
    this.#session = session
  }

  /** Reports a state; fire and forget. Ignored once released. */
  report(report: StateReport): void {
    if (this.#released || this.#disposed) return
    if (this.#inFlight) {
      this.#pending = report
      return
    }
    this.#launch(report)
  }

  #launch(report: StateReport): void {
    const session = this.#session
    this.#session = undefined
    const argv = [
      this.#opts.bin,
      "pane",
      "report-agent",
      this.#opts.pane,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--state",
      report.state,
      ...(report.message ? ["--message", report.message] : []),
      "--seq",
      String(this.nextSeq()),
      ...(session ? ["--agent-session-id", session.id] : []),
      ...(session?.argv ? ["--", ...session.argv] : []),
    ]
    this.#reported = true
    this.#inFlight = this.#call(argv, REPORT_TIMEOUT_MS, this.#abort.signal).then((ok) => {
      // Tell the session again with the next report, unless a newer one replaced it meanwhile.
      if (!ok && session && !this.#session) this.#session = session
      this.#inFlight = undefined
      const next = this.#pending
      this.#pending = undefined
      if (next && !this.#released && !this.#disposed) this.#launch(next)
    })
  }

  async #call(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    let ok = false
    try {
      ok = await this.#opts.run(argv, timeoutMs, signal)
    } catch {}
    if (!ok) this.failures++
    return ok
  }

  /**
   * Releases the pane, once: later calls get the same promise, and reports stop. Nothing is
   * sent when nothing was ever reported. Resolves when herdr answered or the call gave up.
   */
  release(signal?: AbortSignal): Promise<void> {
    if (this.#released) return this.#released
    this.#pending = undefined
    if (!this.#reported) {
      this.#released = Promise.resolve()
      return this.#released
    }
    const argv = [
      this.#opts.bin,
      "pane",
      "release-agent",
      this.#opts.pane,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--seq",
      String(this.nextSeq()),
    ]
    this.#released = this.#call(argv, RELEASE_TIMEOUT_MS, signal).then(() => {})
    return this.#released
  }

  get released(): boolean {
    return this.#released !== undefined
  }

  /** Resolves once no call runs and none waits (tests). */
  async idle(): Promise<void> {
    while (this.#inFlight) await this.#inFlight
  }

  /** Stops state reports still running (unload). A release keeps its own signal. */
  dispose(): void {
    this.#disposed = true
    this.#pending = undefined
    this.#abort.abort()
  }
}
