import type { AnyEvent, ModelRef, SessionStatus } from "@amira/api"
import type { HerdrState, SessionReport, StateReport } from "./reporter.ts"
import { resumeArgv } from "./resume.ts"

/** herdr shows `--message` in a narrow sidebar. */
export const MAX_MESSAGE = 80

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** One line without control characters, at most MAX_MESSAGE characters, not read as a flag. */
export function cleanMessage(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+\s*/, "")
  if (!line) return undefined
  const chars = [...line]
  return chars.length > MAX_MESSAGE ? `${chars.slice(0, MAX_MESSAGE - 1).join("")}…` : line
}

/**
 * Amira's status as herdr's state. An error ends the turn and Amira waits for input, so it is
 * idle: blocked would read "needs a decision" until the next turn.
 */
export function herdrState(status: SessionStatus): HerdrState {
  return status === "working" ? "working" : status === "blocked" ? "blocked" : "idle"
}

export interface TrackerOptions {
  report: (report: StateReport) => void
  setSession: (session: SessionReport) => void
  release: () => void
  /** The current top-level session's id, from the host (finds the root after a reload). */
  currentSessionId?: () => string | undefined
}

/**
 * Follows the root session's events and tells the reporter what herdr should show. The root is
 * the session the user talks to: sub-agents (events with parentSessionId) never count, and
 * neither do other parentless sessions (extensions' own conversations) once the root is known.
 * A sub-agent's dialog (its permission question, say) shows as blocked too: it never blocks
 * the root's own status. The root's own approvals and questions already set its status, and
 * dialogs of the host (pickers the user opens, such as /model) do not count.
 */
export class Tracker {
  #opts: TrackerOptions
  #root: string | undefined
  /** Whether the root came with a resume command: Amira's main session always does when stored. */
  #rootResumable = false
  #status: SessionStatus | undefined
  #reason: string | undefined
  #model: ModelRef | undefined
  #resume: string[] | undefined
  /** Open dialogs, by request id, with their titles in the order they opened. */
  #dialogs = new Map<string, string | undefined>()
  #last: string | undefined

  constructor(opts: TrackerOptions) {
    this.#opts = opts
  }

  get root(): string | undefined {
    return this.#root
  }

  #isRoot(e: AnyEvent): boolean {
    if (e.parentSessionId !== undefined || e.sessionId === "host") return false
    if (this.#root !== undefined) return e.sessionId === this.#root
    // Loaded after the session started (a reload): take the host's word for which one is it.
    let current: string | undefined
    try {
      current = this.#opts.currentSessionId?.()
    } catch {}
    if (current !== e.sessionId) return false
    this.#root = e.sessionId
    return true
  }

  handle(e: AnyEvent): void {
    switch (e.type) {
      case "session.start": {
        if (e.parentSessionId !== undefined || e.sessionId === "host") return
        const resumable = !!e.data.resume?.length
        // A parentless session without a resume command (an extension's own conversation)
        // never replaces a root that has one.
        if (this.#root !== undefined && e.sessionId !== this.#root && !resumable && this.#rootResumable)
          return
        this.#root = e.sessionId
        this.#rootResumable = resumable
        this.#model = e.data.model
        this.#resume = e.data.resume ? [...e.data.resume] : undefined
        // A new, cleared, forked or resumed conversation waits for input.
        this.#status = "idle"
        this.#reason = undefined
        if (this.#resume) this.#tellSession()
        this.#update(true)
        return
      }
      case "model.changed":
        if (!this.#isRoot(e)) return
        this.#model = e.data.to
        if (this.#resume) {
          this.#tellSession()
          this.#update(true)
        }
        return
      case "status.changed":
        if (!this.#isRoot(e)) return
        this.#status = e.data.status
        this.#reason = e.data.reason
        this.#update()
        return
      case "ui.request":
        if (!this.#fromSubagent(e)) return
        // The same request again (a live list that changed) keeps its place.
        this.#dialogs.set(e.data.requestId, "title" in e.data ? e.data.title : undefined)
        this.#update()
        return
      case "ui.resolved":
        if (!this.#dialogs.delete(e.data.requestId)) return
        this.#update()
        return
      case "session.end":
        if (e.parentSessionId !== undefined || e.sessionId !== this.#root) return
        // A switch replaces the session in the same process: the next session.start reports it.
        if (e.data.reason === "switch") return
        this.#opts.release()
        return
    }
  }

  /**
   * Whether a dialog belongs to a session other than the root: a sub-agent's carries that
   * sub-agent's id (the approval's request.sessionId). Commands' and extensions' own dialogs
   * carry "host", and the root's own carry the root's id.
   */
  #fromSubagent(e: AnyEvent): boolean {
    if (e.parentSessionId !== undefined) return true
    return e.sessionId !== "host" && e.sessionId !== this.#root
  }

  #tellSession() {
    const argv = resumeArgv(this.#resume, this.#model)
    this.#opts.setSession({ id: this.#root!, ...(argv ? { argv } : {}) })
  }

  /** What herdr should show now; undefined before the root session is known. */
  current(): StateReport | undefined {
    if (this.#dialogs.size) {
      const titles = [...this.#dialogs.values()]
      const message = cleanMessage(titles[titles.length - 1]) ?? "waiting for your answer"
      return { state: "blocked", message }
    }
    if (this.#status === undefined) return undefined
    const state = herdrState(this.#status)
    const message = state === "blocked" ? cleanMessage(this.#reason) : undefined
    return { state, ...(message ? { message } : {}) }
  }

  /** Reports the state when it changed, or always when a session goes with it. */
  #update(force = false) {
    const report = this.current()
    if (!report) return
    const key = `${report.state}\n${report.message ?? ""}`
    if (!force && key === this.#last) return
    this.#last = key
    this.#opts.report(report)
  }
}
