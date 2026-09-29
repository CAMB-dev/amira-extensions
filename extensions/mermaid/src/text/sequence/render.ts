/**
 * Sequence diagram as text: participant boxes (actors as stick figures) over │ lifelines,
 * messages as arrows with the label above, notes as boxes, and blocks (loop, alt, …) as
 * frames with the keyword on the top border and ┄ separators between sections.
 */
import { Canvas, LEFT, RIGHT, type Style } from "../canvas.ts"
import { maxWidth, strWidth, truncate, wrapText } from "../util.ts"
import type { Block, Message, Note, Sequence, SeqEvent } from "./parse.ts"

export interface SequenceOptions {
  /** Maximum width of message, note and participant text before wrapping. */
  wrap: number
  /** Blank columns between neighbouring participant boxes. */
  gap: number
}

type Op =
  | { t: "msg"; e: Message; y: number; lines: string[] }
  | { t: "self"; e: Message; y: number; h: number; lines: string[] }
  | { t: "note"; e: Note; y: number; lines: string[]; x0: number; w: number }
  | { t: "frame"; y0: number; y1: number; l: number; r: number; seps: Array<{ y: number; text: string }>; title: string }

export function layoutSequence(seq: Sequence, o: SequenceOptions): string[] {
  const P = seq.participants.length
  const names = seq.participants.map((p) => wrapText(p.label, o.wrap))
  const boxW = seq.participants.map((p, i) => (p.actor ? Math.max(maxWidth(names[i]!), 3) : maxWidth(names[i]!) + 4))
  const lw = boxW.map((w) => Math.floor(w / 2))
  const rw = boxW.map((w, i) => w - 1 - lw[i]!)
  const wrapped = new Map<SeqEvent, string[]>()
  const textOf = (e: Message | Note) => {
    let t = wrapped.get(e)
    if (!t) wrapped.set(e, (t = e.text ? wrapText(e.text, o.wrap) : []))
    return t
  }

  // ---- horizontal: minimum distances between lifelines ------------------------------------
  const dist = new Map<string, number>()
  const need = (i: number, j: number, d: number) => {
    if (i < 0 || j >= P || i >= j) return
    const k = `${i},${j}`
    dist.set(k, Math.max(dist.get(k) ?? 0, d))
  }
  for (let i = 0; i + 1 < P; i++) need(i, i + 1, rw[i]! + 1 + o.gap + lw[i + 1]!)
  let leftNeed = 0
  const visit = (evs: SeqEvent[]) => {
    for (const e of evs) {
      if (e.t === "block") {
        e.sections.forEach((s) => visit(s.events))
        continue
      }
      const tw = maxWidth(textOf(e))
      if (e.t === "msg") {
        if (e.from === e.to) {
          need(e.from, e.from + 1, tw + 7)
        } else need(Math.min(e.from, e.to), Math.max(e.from, e.to), tw + 4)
      } else {
        const nw = tw + 4
        if (e.pos === "right") {
          need(e.a, e.a + 1, nw + 3)
        } else if (e.pos === "left") {
          need(e.a - 1, e.a, nw + 3)
          if (e.a === 0) leftNeed = Math.max(leftNeed, nw + 1)
        } else if (e.a === e.b) {
          need(e.a - 1, e.a, Math.floor(nw / 2) + 3)
          need(e.a, e.a + 1, nw - Math.floor(nw / 2) + 2)
        } else need(e.a, e.b, nw - 5)
      }
    }
  }
  visit(seq.events)
  const xs: number[] = []
  for (let j = 0; j < P; j++) {
    let x = 0
    for (let i = 0; i < j; i++) {
      const d = dist.get(`${i},${j}`)
      if (d !== undefined) x = Math.max(x, xs[i]! + d)
    }
    xs.push(j === 0 ? 0 : Math.max(x, xs[j - 1]! + 1))
  }

  // ---- vertical: one pass assigns rows and frame extents ----------------------------------
  const headH = Math.max(...seq.participants.map((p, i) => (p.actor ? 3 + names[i]!.length : 2 + names[i]!.length)))
  const ops: Op[] = []
  let y = headH + 1
  const lifelines = new Set(xs)
  type Ext = [number, number]
  const walk = (evs: SeqEvent[]): Ext => {
    let ext: Ext = [Infinity, -Infinity]
    const add = (l: number, r: number) => (ext = [Math.min(ext[0], l), Math.max(ext[1], r)])
    for (const e of evs) {
      if (e.t === "msg") {
        const lines = textOf(e)
        const xa = xs[e.from]!
        if (e.from === e.to) {
          const h = Math.max(2, lines.length + 1)
          ops.push({ t: "self", e, y, h, lines })
          add(xa, xa + 4 + (lines.length ? 1 + maxWidth(lines) : 0))
          y += h
        } else {
          const xb = xs[e.to]!
          ops.push({ t: "msg", e, y, lines })
          add(Math.min(xa, xb), Math.max(xa, xb))
          y += lines.length + 1
        }
      } else if (e.t === "note") {
        const lines = textOf(e)
        const w = Math.max(maxWidth(lines), 1) + 4
        let x0: number
        let nw = w
        const xa = xs[e.a]!
        if (e.pos === "right") x0 = xa + 2
        else if (e.pos === "left") x0 = xa - 1 - w
        else if (e.a === e.b) x0 = xa - Math.floor(w / 2)
        else {
          const xb = xs[e.b]!
          nw = Math.max(w, xb - xa + 5)
          x0 = Math.floor((xa + xb) / 2) - Math.floor(nw / 2)
        }
        ops.push({ t: "note", e, y, lines: lines.length ? lines : [""], x0, w: nw })
        add(x0, x0 + nw - 1)
        y += Math.max(lines.length, 1) + 2
      } else {
        const [l, r] = frame(e)
        add(l, r)
      }
    }
    return ext
  }
  const frame = (b: Block): Ext => {
    const y0 = y
    y++
    const seps: Array<{ y: number; text: string }> = []
    let ext: Ext = [Infinity, -Infinity]
    b.sections.forEach((s, i) => {
      if (i > 0) {
        seps.push({ y, text: truncate(`${s.kw}${s.label ? ` [${s.label}]` : ""}`, o.wrap * 2) })
        y++
      }
      const e = walk(s.events)
      ext = [Math.min(ext[0], e[0]), Math.max(ext[1], e[1])]
    })
    const y1 = y
    y++
    if (!Number.isFinite(ext[0])) ext = [xs[0]!, xs[0]!]
    let l = ext[0] - 2
    let r = ext[1] + 2
    while (lifelines.has(l)) l--
    const s0 = b.sections[0]!
    const title = truncate(`${s0.kw}${s0.label ? ` [${s0.label}]` : ""}`, o.wrap * 2)
    const widest = Math.max(strWidth(title), ...seps.map((s) => strWidth(s.text)))
    r = Math.max(r, l + widest + 5)
    while (lifelines.has(r)) r++
    ops.push({ t: "frame", y0, y1, l, r, seps, title })
    return [l, r]
  }
  const ext = walk(seq.events)
  const yEnd = y + 1

  // ---- shift so nothing is left of column 0 -----------------------------------------------
  let minX = Math.min(...xs.map((x, i) => x - lw[i]!), xs[0]! - leftNeed)
  if (Number.isFinite(ext[0])) minX = Math.min(minX, ext[0])
  for (const op of ops) {
    if (op.t === "frame") minX = Math.min(minX, op.l)
    if (op.t === "note") minX = Math.min(minX, op.x0)
  }
  const sx = (x: number) => x - minX

  // ---- draw ------------------------------------------------------------------------------------
  const cv = new Canvas()
  for (let i = 0; i < P; i++) cv.line(sx(xs[i]!), headH, sx(xs[i]!), yEnd - 1, "solid")

  const frames = ops.filter((op) => op.t === "frame")
  for (const f of frames) {
    const l = sx(f.l)
    const r = sx(f.r)
    cv.path(
      [
        [l, f.y0],
        [r, f.y0],
        [r, f.y1],
        [l, f.y1],
        [l, f.y0],
      ],
      "solid",
    )
    for (const s of f.seps) {
      cv.line(l, s.y, r, s.y, "dotted")
      cv.bits(l, s.y, RIGHT, "solid")
      cv.bits(r, s.y, LEFT, "solid")
    }
  }

  const arrowGlyph = (m: Message, right: boolean) =>
    m.head === "arrow" ? (right ? "▶" : "◀") : m.head === "cross" ? "×" : m.head === "async" ? (right ? "▷" : "◁") : ""
  for (const op of ops) {
    if (op.t === "msg") {
      const m = op.e
      const xa = sx(xs[m.from]!)
      const xb = sx(xs[m.to]!)
      const dirR = xb > xa
      const step = dirR ? 1 : -1
      const ay = op.y + op.lines.length
      const style: Style = m.line
      const endX = m.head === "open" ? xb : xb - step
      const startX = m.both ? xa + step : xa
      cv.line(startX, ay, endX, ay, style)
      if (m.head !== "open") cv.text(xb - step, ay, arrowGlyph(m, dirR))
      if (m.both) cv.text(xa + step, ay, arrowGlyph(m, !dirR))
    } else if (op.t === "self") {
      const m = op.e
      const x = sx(xs[m.from]!)
      const yb = op.y + op.h - 1
      const style: Style = m.line
      cv.path(
        [
          [x, op.y],
          [x + 3, op.y],
          [x + 3, yb],
          [m.head === "open" ? x : x + 1, yb],
        ],
        style,
      )
      if (m.head !== "open") cv.text(x + 1, yb, arrowGlyph(m, false))
    }
  }
  // Notes and text go over the lines.
  for (const op of ops) {
    if (op.t === "note") {
      const x0 = sx(op.x0)
      const iw = op.w - 4
      cv.text(x0, op.y, "┌" + "─".repeat(op.w - 2) + "┐")
      op.lines.forEach((l, i) => {
        const pad = iw - strWidth(l)
        const left = Math.floor(pad / 2)
        cv.text(x0, op.y + 1 + i, "│ " + " ".repeat(left) + l + " ".repeat(pad - left) + " │")
      })
      cv.text(x0, op.y + 1 + op.lines.length, "└" + "─".repeat(op.w - 2) + "┘")
    } else if (op.t === "msg") {
      const xa = sx(xs[op.e.from]!)
      const xb = sx(xs[op.e.to]!)
      const lo = Math.min(xa, xb)
      const mid = Math.floor((xa + xb) / 2)
      op.lines.forEach((l, i) => {
        const w = strWidth(l)
        cv.text(Math.max(lo + 2, mid - Math.floor(w / 2)), op.y + i, l)
      })
    } else if (op.t === "self") {
      const x = sx(xs[op.e.from]!)
      op.lines.forEach((l, i) => cv.text(x + 5, op.y + i, l))
    } else if (op.t === "frame") {
      const l = sx(op.l)
      cv.text(l + 2, op.y0, ` ${op.title} `)
      for (const s of op.seps) cv.text(l + 2, s.y, ` ${s.text} `)
    }
  }

  // Participant headers.
  seq.participants.forEach((p, i) => {
    const x = sx(xs[i]!)
    const lines = names[i]!
    if (p.actor) {
      const top = headH - 3 - lines.length
      cv.text(x, top, "○")
      cv.text(x - 1, top + 1, "╶┼╴")
      cv.text(x - 1, top + 2, "╱ ╲")
      lines.forEach((l, k) => cv.text(x - Math.floor(strWidth(l) / 2), top + 3 + k, l))
    } else {
      const w = boxW[i]!
      const x0 = x - lw[i]!
      const top = headH - 2 - lines.length
      cv.text(x0, top, "┌" + "─".repeat(w - 2) + "┐")
      lines.forEach((l, k) => {
        const pad = w - 4 - strWidth(l)
        const left = Math.floor(pad / 2)
        cv.text(x0, top + 1 + k, "│ " + " ".repeat(left) + l + " ".repeat(pad - left) + " │")
      })
      cv.text(x0, headH - 1, "└" + "─".repeat(w - 2) + "┘")
      cv.text(x, headH - 1, "┬")
    }
  })

  const out = cv.toLines()
  while (out.length && out[0] === "") out.shift()
  return out
}
