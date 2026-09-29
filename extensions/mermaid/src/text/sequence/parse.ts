/** A lenient parser for Mermaid sequenceDiagram source. */
import { cleanLabel, meaningfulLines } from "../util.ts"

export interface Participant {
  id: string
  label: string
  actor: boolean
}

export type LineType = "solid" | "dotted"
export type HeadType = "arrow" | "open" | "cross" | "async"

export interface Message {
  t: "msg"
  from: number
  to: number
  line: LineType
  head: HeadType
  /** Arrowheads at both ends (`<<->>`). */
  both: boolean
  text: string
}

export interface Note {
  t: "note"
  pos: "left" | "right" | "over"
  a: number
  b: number
  text: string
}

export interface Section {
  /** The keyword that opened the section: loop, alt, else, par, and, … */
  kw: string
  label: string
  events: SeqEvent[]
}

export interface Block {
  t: "block"
  sections: Section[]
}

export type SeqEvent = Message | Note | Block

export interface Sequence {
  participants: Participant[]
  events: SeqEvent[]
}

const ARROWS: ReadonlyArray<readonly [string, LineType, HeadType, boolean]> = [
  ["<<-->>", "dotted", "arrow", true],
  ["<<->>", "solid", "arrow", true],
  ["-->>", "dotted", "arrow", false],
  ["->>", "solid", "arrow", false],
  ["--x", "dotted", "cross", false],
  ["-x", "solid", "cross", false],
  ["--)", "dotted", "async", false],
  ["-)", "solid", "async", false],
  ["-->", "dotted", "open", false],
  ["->", "solid", "open", false],
]

const MESSAGE = new RegExp(
  "^(.+?)\\s*(" +
    ARROWS.map(([a]) => a.replace(/[()]/g, "\\$&")).join("|") +
    ")\\s*([+-]?)\\s*([^:]+?)\\s*(?::(.*))?$",
)

const OPENERS = new Set(["loop", "alt", "opt", "par", "par_over", "critical", "break", "rect", "box"])
const SKIP = /^(activate|deactivate|destroy|title|accTitle|accDescr|links?|properties|details)\b/

function unquote(s: string): string {
  const t = s.trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
}

export function parseSequence(source: string): Sequence | undefined {
  const lines = meaningfulLines(source)
  if (lines.length === 0 || !/^\s*sequenceDiagram\b/.test(lines[0]!)) return undefined
  const participants: Participant[] = []
  const index = new Map<string, number>()
  const ref = (rawId: string): number => {
    const id = unquote(rawId)
    let i = index.get(id)
    if (i === undefined) {
      i = participants.length
      participants.push({ id, label: id, actor: false })
      index.set(id, i)
    }
    return i
  }

  const root: Section = { kw: "", label: "", events: [] }
  // Open blocks; `transparent` ones (rect, box) have no frame of their own.
  const stack: Array<{ block: Block; transparent: boolean }> = []
  const current = (): SeqEvent[] => {
    const top = stack[stack.length - 1]
    return top ? top.block.sections[top.block.sections.length - 1]!.events : root.events
  }
  let number = 0
  let numbering = false

  for (const raw of lines.slice(1)) {
    const st = raw.trim().replace(/;$/, "")
    if (!st) continue
    const low = st.toLowerCase()
    if (/^autonumber\b/.test(st)) {
      numbering = !/\boff\b/.test(st)
      const start = /^autonumber\s+(\d+)/.exec(st)
      if (start) number = Number(start[1]) - 1
      continue
    }
    if (SKIP.test(st)) continue
    const part = /^(?:create\s+)?(participant|actor)\s+(.+)$/.exec(st)
    if (part) {
      let rest = part[2]!.replace(/@\{.*\}\s*$/, "").trim()
      let label: string | undefined
      const as = /^(.+?)\s+as\s+(.+)$/.exec(rest)
      if (as) {
        rest = as[1]!
        label = cleanLabel(as[2]!)
      }
      const i = ref(rest)
      participants[i]!.actor = part[1] === "actor"
      if (label !== undefined) participants[i]!.label = label
      continue
    }
    const note = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:(.*)$/i.exec(st)
    if (note) {
      const who = note[2]!.split(",").map((s) => s.trim()).filter(Boolean)
      if (!who.length) continue
      const a = ref(who[0]!)
      const b = who.length > 1 ? ref(who[1]!) : a
      const kind = note[1]!.toLowerCase()
      current().push({
        t: "note",
        pos: kind === "over" ? "over" : kind === "left of" ? "left" : "right",
        a: Math.min(a, b),
        b: Math.max(a, b),
        text: cleanLabel(note[3]!),
      })
      continue
    }
    const opener = /^(\w+)\b\s*(.*)$/.exec(st)
    if (opener && OPENERS.has(opener[1]!)) {
      const kw = opener[1]!
      const block: Block = { t: "block", sections: [{ kw: kw === "par_over" ? "par" : kw, label: cleanLabel(opener[2]!), events: [] }] }
      const transparent = kw === "rect" || kw === "box"
      if (!transparent) current().push(block)
      stack.push({ block, transparent })
      continue
    }
    if (/^(else|and|option)\b/.test(st)) {
      const top = stack[stack.length - 1]
      const m = /^(\w+)\b\s*(.*)$/.exec(st)!
      if (top && !top.transparent) top.block.sections.push({ kw: m[1]!, label: cleanLabel(m[2]!), events: [] })
      continue
    }
    if (low === "end") {
      const top = stack.pop()
      if (top?.transparent) current().push(...top.block.sections.flatMap((s) => s.events))
      continue
    }
    const msg = MESSAGE.exec(st)
    if (msg) {
      const arrow = ARROWS.find(([a]) => a === msg[2])!
      const from = ref(msg[1]!)
      const to = ref(msg[4]!)
      let text = cleanLabel(msg[5] ?? "")
      if (numbering) {
        number++
        text = text ? `${number}. ${text}` : `${number}.`
      }
      current().push({ t: "msg", from, to, line: arrow[1], head: arrow[2], both: arrow[3], text })
      continue
    }
    // Anything else is ignored.
  }
  // Close blocks left open at the end of the source.
  while (stack.length) {
    const top = stack.pop()!
    if (top.transparent) current().push(...top.block.sections.flatMap((s) => s.events))
  }
  if (participants.length === 0) return undefined
  return { participants, events: root.events }
}
