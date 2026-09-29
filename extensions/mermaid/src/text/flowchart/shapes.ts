/** Node boxes: one distinct border per Mermaid shape. */
import { center, maxWidth } from "../util.ts"
import type { Shape } from "./parse.ts"

export type Range = readonly [number, number]

export interface Box {
  w: number
  h: number
  /** Each row is exactly `w` columns wide (spaces where the shape is inset). */
  rows: string[]
  /** Columns of the top / bottom border where an edge may attach (the border is ─ there). */
  top: Range
  bottom: Range
  /** Rows of the left / right side where an edge may attach. */
  left: Range
  right: Range
}

const d = (n: number) => "─".repeat(Math.max(0, n))

function build(shape: Shape, content: string[], iw: number): Box {
  const n = content.length
  const c = content.map((l) => center(l, iw))
  const sides = (l: string, r: string, pad = " ") => c.map((x) => l + pad + x + pad + r)
  let rows: string[]
  let top: Range
  let bottom: Range
  let left: Range = [1, n]
  let right: Range = [1, n]
  switch (shape) {
    case "rect":
    case "round":
    case "stadium": {
      const [a, b, e, f] = shape === "rect" ? ["┌", "┐", "└", "┘"] : ["╭", "╮", "╰", "╯"]
      const [l, r] = shape === "stadium" ? ["(", ")"] : ["│", "│"]
      rows = [a + d(iw + 2) + b, ...sides(l, r), e + d(iw + 2) + f]
      top = bottom = [1, iw + 2]
      break
    }
    case "subroutine":
      rows = ["┌┬" + d(iw + 2) + "┬┐", ...sides("││", "││"), "└┴" + d(iw + 2) + "┴┘"]
      top = bottom = [2, iw + 3]
      break
    case "database":
      rows = ["╭" + d(iw + 2) + "╮", "├" + d(iw + 2) + "┤", ...sides("│", "│"), "╰" + d(iw + 2) + "╯"]
      top = bottom = [1, iw + 2]
      left = right = [2, n + 1]
      break
    case "circle":
      rows = [" ╭" + d(iw) + "╮ ", ...sides("(", ")"), " ╰" + d(iw) + "╯ "]
      top = bottom = [2, iw + 1]
      break
    case "dcircle":
      rows = [" ╭" + d(iw + 2) + "╮ ", ...sides("((", "))"), " ╰" + d(iw + 2) + "╯ "]
      top = bottom = [2, iw + 3]
      break
    case "asym":
      rows = [d(iw + 3) + "┐", ...sides(">", "│"), d(iw + 3) + "┘"]
      top = bottom = [1, iw + 2]
      break
    case "rhombus": {
      const mid = c.map((x, r) => {
        const [l, rr] = n % 2 === 1 && r === (n - 1) / 2 ? ["<", ">"] : r < n / 2 ? ["╱", "╲"] : ["╲", "╱"]
        return l + " " + x + " " + rr
      })
      rows = [" ╱" + d(iw) + "╲ ", ...mid, " ╲" + d(iw) + "╱ "]
      top = bottom = [2, iw + 1]
      break
    }
    case "hexagon":
      rows = ["╱" + d(iw + 2) + "╲", ...sides("│", "│"), "╲" + d(iw + 2) + "╱"]
      top = bottom = [1, iw + 2]
      break
    case "para":
      rows = [" ┌" + d(iw + 1) + "┐", ...sides("╱", "╱"), "└" + d(iw + 1) + "┘ "]
      top = [2, iw + 2]
      bottom = [1, iw + 1]
      break
    case "paraAlt":
      rows = ["┌" + d(iw + 1) + "┐ ", ...sides("╲", "╲"), " └" + d(iw + 1) + "┘"]
      top = [1, iw + 1]
      bottom = [2, iw + 2]
      break
    case "trap":
      rows = [" ┌" + d(iw) + "┐ ", ...sides("╱", "╲"), "└" + d(iw + 2) + "┘"]
      top = [2, iw + 1]
      bottom = [1, iw + 2]
      break
    case "trapAlt":
      rows = ["┌" + d(iw + 2) + "┐", ...sides("╲", "╱"), " └" + d(iw) + "┘ "]
      top = [1, iw + 2]
      bottom = [2, iw + 1]
      break
  }
  const w = shape === "subroutine" || shape === "dcircle" ? iw + 6 : iw + 4
  return { w, h: rows.length, rows, top, bottom, left, right }
}

export interface PortNeeds {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Builds the box for a node. `vertical` is true for TD/BT layouts (edges attach on top and
 * bottom); the box grows until every side can hold its port groups apart.
 */
export function makeBox(shape: Shape, lines: string[], needs: PortNeeds, vertical: boolean): Box {
  let iw = Math.max(1, maxWidth(lines))
  const content = lines.length ? [...lines] : [""]
  const span = (r: Range) => r[1] - r[0]
  for (let guard = 0; guard < 200; guard++) {
    const box = build(shape, content, iw)
    if (vertical) {
      const ok = (r: Range, k: number) => k < 2 || span(r) >= 2 * (k + 1)
      if (ok(box.top, needs.top) && ok(box.bottom, needs.bottom)) return box
      iw++
    } else {
      const ok = (r: Range, k: number) => k < 2 || span(r) >= 2 * (k - 1)
      if (ok(box.left, needs.left) && ok(box.right, needs.right)) return box
      if (guard % 2 === 0) content.push("")
      else content.unshift("")
    }
  }
  return build(shape, content, iw)
}

/** Offsets (within the range) for `k` port groups on one side. */
export function portSlots(r: Range, k: number, size: number, vertical: boolean): number[] {
  if (k <= 0) return []
  const [lo, hi] = r
  if (k === 1) return [Math.min(hi, Math.max(lo, Math.floor((size - 1) / 2)))]
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    out.push(vertical ? lo + Math.round(((i + 1) * (hi - lo)) / (k + 1)) : lo + Math.round((i * (hi - lo)) / (k - 1)))
  }
  return out
}
