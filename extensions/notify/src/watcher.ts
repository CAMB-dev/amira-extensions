import type { AnyEvent } from "@amira/api"
import type { Notification } from "./channels.ts"
import type { NotifySettings } from "./settings.ts"

export interface WatcherOptions {
  settings: () => NotifySettings
  /** Where a notification goes (through the Notifier's gates). */
  notify: (n: Notification) => void
  /** The notifications' title, e.g. "Amira · my-project". */
  title: string
  /** Whether the user's terminal has focus; undefined while unknown. */
  focused?: () => boolean | undefined
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Background completions arriving this close together make one notification. */
export const BATCH_MS = 1500

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** "45s", "2m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

interface Child {
  parent: string
  title: string
  groupId?: string
  /** The parent's tool call that started it, when a tool did. */
  toolCallId?: string
}

/**
 * Turns the event stream into notifications: a top-level turn that ran long ended, a question
 * waits for an answer, background sub-agents or spawn groups (workflows, swarms) of a top-level
 * session finished. Pure bookkeeping on events: whether the user is away is the Notifier's.
 */
export class Watcher {
  #opts: WatcherOptions
  #set: (fn: () => void, ms: number) => unknown
  #clear: (timer: unknown) => void
  /** Sub-agents by session id; their own sessions are not top-level. */
  #children = new Map<string, Child>()
  /** Groups by id, with the session that created them. */
  #groups = new Map<string, string>()
  /** Top-level sessions in a turn, with when it started. */
  #turns = new Map<string, number>()
  /** The last reply text of each top-level session's running turn. */
  #lastText = new Map<string, string>()
  /** Background work that finished while its session was in a turn, told when the turn ends. */
  #finishedDuringTurn = new Map<string, string[]>()
  /** Tool calls of top-level sessions still running: a sub-agent ending inside one ran in the foreground. */
  #openCalls = new Set<string>()
  /** Open dialogs waiting for their delay to pass. */
  #dialogs = new Map<string, unknown>()
  /** Background completions gathered for one notification. */
  #batch: { parent: string; what: string }[] = []
  #batchTimer: unknown

  constructor(opts: WatcherOptions) {
    this.#opts = opts
    this.#set = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clear = opts.clearTimer ?? ((t) => clearTimeout(t as never))
  }

  #topLevel(sessionId: string, parentSessionId?: string): boolean {
    return parentSessionId === undefined && sessionId !== "host" && !this.#children.has(sessionId)
  }

  handle(e: AnyEvent): void {
    const s = this.#opts.settings()
    switch (e.type) {
      case "turn.start":
        if (this.#topLevel(e.sessionId, e.parentSessionId)) {
          this.#turns.set(e.sessionId, e.ts)
          this.#lastText.delete(e.sessionId)
          // Background results not told yet usually start this very turn (as its notice): they
          // are told with its end, which also catches a turn that ends before the batch would.
          const mine = this.#batch.filter((b) => b.parent === e.sessionId)
          if (mine.length) {
            this.#batch = this.#batch.filter((b) => b.parent !== e.sessionId)
            this.#finishedDuringTurn.set(e.sessionId, [
              ...(this.#finishedDuringTurn.get(e.sessionId) ?? []),
              ...mine.map((b) => b.what),
            ])
          }
        }
        return
      case "message.end": {
        if (!this.#turns.has(e.sessionId)) return
        const text = e.data.message.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim()
        if (text) this.#lastText.set(e.sessionId, text)
        return
      }
      case "turn.end":
        this.#turnEnded(e.sessionId, e.ts, e.data.reason, e.data.error)
        return
      case "tool.execute.start":
        if (this.#topLevel(e.sessionId, e.parentSessionId)) this.#openCalls.add(e.data.toolCallId)
        return
      case "tool.execute.end":
        this.#openCalls.delete(e.data.toolCallId)
        return
      case "subagent.start":
        this.#children.set(e.data.childSessionId, {
          parent: e.sessionId,
          title: e.data.title || e.data.role || "sub-agent",
          ...(e.data.groupId ? { groupId: e.data.groupId } : {}),
          ...(e.data.toolCallId ? { toolCallId: e.data.toolCallId } : {}),
        })
        return
      case "subagent.end": {
        const child = this.#children.get(e.data.childSessionId)
        // Members of a group are told about with their group; stopped ones by whoever stopped them.
        if (!child || child.groupId || e.data.status === "aborted") return
        if (!this.#topLevel(child.parent)) return
        // Ending while the call that started it still runs: it ran in the foreground, part of the turn.
        if (child.toolCallId && this.#openCalls.has(child.toolCallId)) return
        const what =
          e.data.status === "error"
            ? `◆ ${child.title} failed${e.data.error ? `: ${clip(oneLine(e.data.error), 120)}` : ""}`
            : `◆ ${child.title} finished (${duration(e.data.durationMs)})`
        this.#backgroundDone(child.parent, what)
        return
      }
      case "group.start":
        this.#groups.set(e.data.group.id, e.data.group.parentSessionId)
        return
      case "group.end": {
        const g = e.data.group
        const parent = this.#groups.get(g.id) ?? g.parentSessionId
        this.#groups.delete(g.id)
        if (!this.#topLevel(parent)) return
        this.#backgroundDone(parent, `◆ ${g.name}: ${g.endReason ?? "ended"}`)
        return
      }
      case "ui.request": {
        if (!s.events.dialog) return
        const { requestId, title } = e.data
        const fire = () => {
          this.#dialogs.delete(requestId)
          const body = s.preview
            ? `Waiting for your answer: ${clip(oneLine(title), 200)}`
            : "Waiting for your answer"
          this.#opts.notify({ kind: "dialog", title: this.#opts.title, body })
        }
        // Where the terminal never said whether it has focus (many report only changes), a
        // question the user may be looking at waits as long as a long turn before it notifies.
        const unknown = s.when === "unfocused" && this.#opts.focused?.() === undefined
        const delay = unknown ? Math.max(s.dialogDelaySeconds, s.longTurnSeconds) : s.dialogDelaySeconds
        this.#dialogs.set(requestId, this.#set(fire, delay * 1000))
        return
      }
      case "ui.resolved": {
        const t = this.#dialogs.get(e.data.requestId)
        if (t !== undefined) this.#clear(t)
        this.#dialogs.delete(e.data.requestId)
        return
      }
      case "session.start":
        // A fresh or resumed conversation: a turn of the one before will not end any more.
        if (e.data.reason !== "startup") {
          this.#turns.delete(e.sessionId)
          this.#finishedDuringTurn.delete(e.sessionId)
        }
        return
    }
  }

  #turnEnded(sessionId: string, ts: number, reason: string, error?: string) {
    const started = this.#turns.get(sessionId)
    if (started === undefined) return
    this.#turns.delete(sessionId)
    const text = this.#lastText.get(sessionId)
    this.#lastText.delete(sessionId)
    const s = this.#opts.settings()
    const background = s.events.background ? (this.#finishedDuringTurn.get(sessionId) ?? []) : []
    this.#finishedDuringTurn.delete(sessionId)
    const ran = ts - started
    // An interrupted turn: the user just pressed the key.
    const long = s.events.turn && reason !== "aborted" && ran >= s.longTurnSeconds * 1000
    if (!long && !background.length) return
    const lines: string[] = []
    if (long) {
      if (reason === "error")
        lines.push(`Failed after ${duration(ran)}${error ? `: ${clip(oneLine(error), 160)}` : ""}`)
      else {
        lines.push(`Done after ${duration(ran)}`)
        if (s.preview && text) lines.push(clip(oneLine(text), 200))
      }
    }
    lines.push(...background)
    this.#opts.notify({ kind: long ? "turn" : "background", title: this.#opts.title, body: lines.join("\n") })
  }

  #backgroundDone(parent: string, what: string) {
    if (!this.#opts.settings().events.background) return
    // Its report goes to the running turn; the turn's end tells about both.
    if (this.#turns.has(parent)) {
      const list = this.#finishedDuringTurn.get(parent) ?? []
      list.push(what)
      this.#finishedDuringTurn.set(parent, list)
      return
    }
    this.#batch.push({ parent, what })
    if (this.#batchTimer !== undefined) return
    this.#batchTimer = this.#set(() => {
      this.#batchTimer = undefined
      const done = this.#batch.splice(0).map((b) => b.what)
      if (!done.length) return
      const head = done.length > 1 ? [`${done.length} background tasks ended`] : []
      this.#opts.notify({ kind: "background", title: this.#opts.title, body: [...head, ...done].join("\n") })
    }, BATCH_MS)
  }

  /** Drops every pending timer (the extension is being unloaded). */
  dispose(): void {
    for (const t of this.#dialogs.values()) this.#clear(t)
    this.#dialogs.clear()
    if (this.#batchTimer !== undefined) this.#clear(this.#batchTimer)
    this.#batchTimer = undefined
    this.#batch = []
  }
}
