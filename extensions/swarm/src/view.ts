import type { ViewControl, ViewDefinition, ViewLine, ViewRenderOptions } from "@amira/api"
import type { MemberView, SwarmSnapshot, TimelineEntry } from "./swarm.ts"

export const VIEW_KIND = "swarm"

/** What `/swarm view` opens: a swarm as it stands at each redraw, and what the keys may do. */
export interface SwarmViewData {
  snapshot(): SwarmSnapshot | undefined
  /** Absent for a swarm read back from the session, which only shows. */
  control?: {
    tell(to: string, text: string): string | undefined
    /** A message to every member: how many it went to, or the problem. */
    tellAll?(text: string): number | string
    pause(name?: string): string | undefined
    resume(name?: string): string | undefined
    stopMember(name: string): string | undefined
    stop(): void
  }
  /** The last thing a key did, shown in the header. */
  flash?: string
}

const STATUS_MARK: Record<MemberView["status"], string> = {
  queued: "○",
  working: "●",
  idle: "◌",
  paused: "‖",
  ended: "✓",
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function timelineLine(e: TimelineEntry): ViewLine {
  const t = clock(e.at)
  switch (e.kind) {
    case "message":
      return {
        kind: e.from === "user" ? "accent" : "text",
        // The user reads this view: their own messages are "you → …".
        text: `${t} ✉ ${e.from === "user" ? "you" : e.from} → ${e.to}: ${oneLine(e.text)}`,
      }
    case "board":
      return { kind: "success", text: `${t} ✎ ${e.from} wrote ${e.key}: ${oneLine(e.text)}` }
    case "finish":
      return { kind: "success", text: `${t} ✓ ${e.from} finished: ${oneLine(e.text)}` }
    case "end":
      return { kind: "warning", text: `${t} ■ ended: ${e.text}` }
    default:
      return { kind: "muted", text: `${t} · ${e.text}` }
  }
}

export function memberLine(m: MemberView): ViewLine {
  const done = m.result !== undefined ? " · finished" : ""
  const note = m.status === "ended" && m.note ? ` · ${oneLine(m.note)}` : ""
  return {
    kind: m.status === "working" ? "accent" : m.status === "ended" ? "muted" : "text",
    text: `${STATUS_MARK[m.status]} ${m.name} · ${m.role} · ${m.status} · ${m.turns} turns · ${m.messagesSent} sent${done}${note}`,
  }
}

function header(s: SwarmSnapshot, now: number): string {
  const until = s.endedAt ?? now
  const parts = [
    s.state,
    `${s.members.length} members`,
    `${s.messages} messages`,
    `${s.board.length} keys`,
    ...(s.tokens !== undefined ? [`${s.tokens} tokens`] : []),
    elapsed(until - s.startedAt),
  ]
  return parts.join(" · ")
}

export const swarmView: ViewDefinition<SwarmViewData> = {
  kind: VIEW_KIND,
  title(data) {
    const s = data.snapshot()
    return s ? `Swarm ${s.id} · ${s.goal}` : "Swarm"
  },
  header(data, opts: ViewRenderOptions) {
    const s = data.snapshot()
    if (!s) return [{ kind: "muted", text: "This swarm is gone." }]
    const lines: ViewLine[] = [{ kind: "muted", text: header(s, opts.now) }]
    if (s.endReason) lines.push({ kind: "warning", text: `Ended: ${s.endReason}` })
    if (data.flash) lines.push({ kind: "accent", text: data.flash })
    return lines
  },
  render(data) {
    const s = data.snapshot()
    if (!s) return []
    const out: ViewLine[] = [{ kind: "accent", text: "Members" }]
    for (const m of s.members) {
      out.push(memberLine(m))
      if (m.result) out.push({ kind: "muted", text: `    ${oneLine(m.result)}` })
    }
    out.push({ kind: "text", text: "" }, { kind: "accent", text: "Blackboard" })
    if (!s.board.length) out.push({ kind: "muted", text: "(empty)" })
    for (const e of s.board) {
      out.push({
        kind: "text",
        text: `▸ ${e.key} · by ${e.by} · ${e.writes} write${e.writes === 1 ? "" : "s"}`,
      })
      for (const l of e.value.split("\n")) out.push({ kind: "code", text: `  ${l}` })
    }
    out.push({ kind: "text", text: "" }, { kind: "accent", text: "Timeline" })
    for (const e of s.timeline) out.push(timelineLine(e))
    return out
  },
  keys: [
    {
      key: "m",
      label: "message",
      run(data, view) {
        void act(data, view, "Message a member (name: text; all: every member)", (c, answer) => {
          const m = /^@?([A-Za-z][\w-]*)\s*[:,]?\s+([\s\S]+)$/.exec(answer)
          if (!m) return 'Write it as "name: text".'
          if (m[1]!.toLowerCase() === "all" && c.tellAll) {
            const sent = c.tellAll(m[2]!)
            return typeof sent === "string" ? sent : `Sent to all (${sent} member${sent === 1 ? "" : "s"}).`
          }
          return c.tell(m[1]!, m[2]!) ?? `Sent to ${m[1]}.`
        })
      },
    },
    {
      key: "p",
      label: "pause/resume",
      run(data, view) {
        void act(data, view, "Pause or resume which member? (all: the whole swarm)", (c, answer) => {
          const name = answer.toLowerCase() === "all" ? undefined : answer
          const s = data.snapshot()
          const paused = name
            ? s?.members.find((m) => m.name.toLowerCase() === name.toLowerCase())?.status === "paused"
            : s?.state === "paused"
          const problem = paused ? c.resume(name) : c.pause(name)
          return problem ?? `${paused ? "Resumed" : "Paused"} ${name ?? "the swarm"}.`
        })
      },
    },
    {
      key: "x",
      label: "stop member",
      run(data, view) {
        void act(
          data,
          view,
          "Stop which member?",
          (c, answer) => c.stopMember(answer) ?? `Stopping ${answer}.`,
        )
      },
    },
    {
      key: "s",
      label: "stop swarm",
      run(data, view) {
        void act(data, view, 'Type "yes" to stop the whole swarm', (c, answer) => {
          if (answer.toLowerCase() !== "yes") return "Not stopped."
          c.stop()
          return "Stopping the swarm."
        })
      },
    },
  ],
}

async function act(
  data: SwarmViewData,
  view: ViewControl,
  title: string,
  run: (c: NonNullable<SwarmViewData["control"]>, answer: string) => string,
) {
  const c = data.control
  const s = data.snapshot()
  if (!c || !s || s.state === "ended" || s.state === "ending") {
    data.flash = "The swarm is not running."
    view.requestRender()
    return
  }
  const answer = await view.prompt(title)
  if (answer === undefined) return
  data.flash = run(c, answer)
  view.requestRender()
}
