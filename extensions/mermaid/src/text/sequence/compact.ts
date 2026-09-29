/**
 * The narrow-terminal fallback for sequence diagrams: one line per message.
 *
 *   Alice ─▶ Bob: Hello
 *   ┌ loop Every minute
 *   │ Bob ┄▶ Alice: Still here
 *   └
 */
import { strWidth, truncate, wrapHanging } from "../util.ts"
import type { Message, Sequence, SeqEvent } from "./parse.ts"

function arrow(m: Message): string {
  const line = m.line === "solid" ? "─" : "┄"
  const head = m.head === "arrow" ? "▶" : m.head === "cross" ? "×" : m.head === "async" ? "▷" : line
  return (m.both ? "◀" : "") + line + head
}

export function compactSequence(seq: Sequence, width: number): string[] {
  const out: string[] = []
  const name = (i: number) => seq.participants[i]!.label.replace(/\s*\n\s*/g, " ")
  const flat = (s: string) => s.replace(/\s*\n\s*/g, " ").trim()
  const emit = (prefix: string, head: string, text: string) => {
    const pw = strWidth(prefix)
    const full = text ? `${head}: ${text}` : head
    wrapHanging(full, width - pw, width - pw - 2).forEach((l, i) => out.push(truncate(prefix + (i ? "  " : "") + l, width)))
  }
  const walk = (evs: SeqEvent[], prefix: string) => {
    for (const e of evs) {
      if (e.t === "msg") emit(prefix, `${name(e.from)} ${arrow(e)} ${name(e.to)}`, flat(e.text))
      else if (e.t === "note") {
        const who = e.a === e.b ? name(e.a) : `${name(e.a)},${name(e.b)}`
        const where = e.pos === "over" ? "over" : `${e.pos} of`
        emit(prefix, `note ${where} ${who}`, flat(e.text))
      } else {
        e.sections.forEach((s, i) => {
          const head = s.label ? `${s.kw} ${flat(s.label)}` : s.kw
          const pw = strWidth(prefix)
          wrapHanging(head, width - pw - 2, width - pw - 4).forEach((l, k) =>
            out.push(truncate(prefix + (k ? "│   " : i ? "├ " : "┌ ") + l, width)),
          )
          walk(s.events, prefix + "│ ")
        })
        out.push(truncate(prefix + "└", width))
      }
    }
  }
  walk(seq.events, "")
  if (out.length === 0) out.push(truncate(seq.participants.map((_, i) => name(i)).join(", "), width))
  return out
}
