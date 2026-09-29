/**
 * A character grid. Text cells hold a grapheme (a wide one also claims the next cell); line
 * cells hold connection bits per line style, so crossing and merging lines turn into the right
 * junction glyph (┬ ┴ ├ ┤ ┼ …) when the grid is printed.
 */
import { graphemes, strWidth } from "./util.ts"

export const UP = 1
export const RIGHT = 2
export const DOWN = 4
export const LEFT = 8

export type Style = "solid" | "dotted" | "thick"

const SOLID = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"]
const THICK = [" ", "┃", "━", "┗", "┃", "┃", "┏", "┣", "━", "┛", "━", "┻", "┓", "┫", "┳", "╋"]

interface Cell {
  ch: string | null
  /** Right half of a wide character. */
  cont: boolean
  solid: number
  dotted: number
  thick: number
}

function emptyCell(): Cell {
  return { ch: null, cont: false, solid: 0, dotted: 0, thick: 0 }
}

export class Canvas {
  private rows: Cell[][] = []

  private cell(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0) return undefined
    let row = this.rows[y]
    if (!row) {
      for (let i = this.rows.length; i <= y; i++) this.rows[i] ??= []
      row = this.rows[y]!
    }
    let c = row[x]
    if (!c) {
      for (let i = row.length; i <= x; i++) row[i] ??= emptyCell()
      c = row[x]!
    }
    return c
  }

  get height(): number {
    return this.rows.length
  }

  /** Current character at a cell (" " for empty or line cells). */
  charAt(x: number, y: number): string {
    const c = this.rows[y]?.[x]
    return c?.ch ?? " "
  }

  /** True when the cell holds nothing at all. */
  isBlank(x: number, y: number): boolean {
    const c = this.rows[y]?.[x]
    if (!c) return true
    return !c.cont && (c.ch === null || c.ch === " ") && (c.solid | c.dotted | c.thick) === 0
  }

  hasLine(x: number, y: number): boolean {
    const c = this.rows[y]?.[x]
    return !!c && (c.solid | c.dotted | c.thick) !== 0
  }

  private clearAt(x: number, y: number): void {
    const c = this.cell(x, y)
    if (!c) return
    if (c.cont) {
      const left = this.cell(x - 1, y)
      if (left) left.ch = " "
    } else if (c.ch && strWidth(c.ch) >= 2) {
      const right = this.cell(x + 1, y)
      if (right) {
        right.cont = false
        right.ch = " "
      }
    }
    c.ch = null
    c.cont = false
    c.solid = c.dotted = c.thick = 0
  }

  /** Writes text starting at (x, y); it replaces whatever was there. */
  text(x: number, y: number, s: string): void {
    let cx = x
    for (const g of graphemes(s)) {
      const w = strWidth(g)
      if (w === 0) continue
      if (cx >= 0 && y >= 0) {
        this.clearAt(cx, y)
        if (w >= 2) this.clearAt(cx + 1, y)
        const c = this.cell(cx, y)!
        c.ch = g
        if (w >= 2) {
          const r = this.cell(cx + 1, y)!
          r.cont = true
        }
      }
      cx += w
    }
  }

  /** Adds connection bits to a cell (a text character there is replaced by the line). */
  bits(x: number, y: number, mask: number, style: Style): void {
    const c = this.cell(x, y)
    if (!c) return
    if (c.ch !== null || c.cont) this.clearAt(x, y)
    if (style === "solid") c.solid |= mask
    else if (style === "dotted") c.dotted |= mask
    else c.thick |= mask
  }

  /** Connects two orthogonally adjacent-or-aligned cells with a straight line. */
  line(x1: number, y1: number, x2: number, y2: number, style: Style): void {
    if (x1 === x2 && y1 === y2) return
    if (x1 === x2) {
      const step = y2 > y1 ? 1 : -1
      for (let y = y1; y !== y2; y += step) {
        this.bits(x1, y, step > 0 ? DOWN : UP, style)
        this.bits(x1, y + step, step > 0 ? UP : DOWN, style)
      }
    } else if (y1 === y2) {
      const step = x2 > x1 ? 1 : -1
      for (let x = x1; x !== x2; x += step) {
        this.bits(x, y1, step > 0 ? RIGHT : LEFT, style)
        this.bits(x + step, y1, step > 0 ? LEFT : RIGHT, style)
      }
    } else {
      throw new Error("canvas: diagonal line")
    }
  }

  /** Draws a polyline through orthogonal points. */
  path(points: ReadonlyArray<readonly [number, number]>, style: Style): void {
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!
      const [bx, by] = points[i]!
      this.line(ax, ay, bx, by, style)
    }
  }

  private glyph(c: Cell): string {
    const all = c.solid | c.dotted | c.thick
    if (all === 0) return " "
    if (c.thick === all && !c.solid && !c.dotted) return THICK[all]!
    if (c.dotted === all && !c.solid && !c.thick) {
      if (all === UP || all === DOWN || all === (UP | DOWN)) return "┆"
      if (all === LEFT || all === RIGHT || all === (LEFT | RIGHT)) return "┄"
    }
    return SOLID[all]!
  }

  toLines(): string[] {
    return this.rows.map((row) => {
      let s = ""
      for (const c of row) {
        if (!c || c.cont) continue
        s += c.ch ?? this.glyph(c)
      }
      return s.replace(/\s+$/, "")
    })
  }
}
