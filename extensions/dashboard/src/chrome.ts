import type { ViewRenderOptions } from "@amira/api"

/** Repeat a host symbol to a cell budget, keeping a remainder as space. */
export function repeatCells(symbol: string, cells: number): string {
  const width = Bun.stringWidth(symbol)
  const budget = Math.max(0, Math.floor(cells))
  return width > 0
    ? symbol.repeat(Math.floor(budget / width)) + " ".repeat(budget % width)
    : " ".repeat(budget)
}

/** Decorate authored literals only. Interpolated source/user text is never rewritten. */
export function chrome(opts: Pick<ViewRenderOptions, "glyphs"> = {}) {
  const glyphs = opts.glyphs
  // API 0.1.49 exposes the rule profile, but not corners or disclosure symbols.
  const ascii = glyphs?.rule !== undefined && /^[\x20-\x7e]+$/.test(glyphs.rule)
  const symbols: Record<string, string> = {
    "─": glyphs?.rule ?? "─",
    "│": glyphs?.treePipe ?? "│",
    "·": glyphs?.separator ?? "·",
    "…": glyphs?.more ?? "…",
    ...(ascii
      ? {
          "╭": "+",
          "╮": "+",
          "╰": "+",
          "╯": "+",
          "├": "+",
          "└": "`",
          "▶": ">",
          "▸": ">",
          "▾": "v",
          "▏": "[",
          "▕": "]",
          "━": "=",
          "—": "-",
          "–": "-",
          "×": "x",
          "⋮": ":",
          "≡": "=",
          "✕": "x",
          "ⓘ": "i",
        }
      : {}),
  }
  return (literals: TemplateStringsArray, ...values: unknown[]): string =>
    literals.reduce(
      (result, literal, index) =>
        result +
        literal.replace(/[─│·…╭╮╰╯├└▶▸▾▏▕━—–×⋮≡✕ⓘ]/g, (symbol) => symbols[symbol] ?? symbol) +
        (index < values.length ? String(values[index]) : ""),
      "",
    )
}
