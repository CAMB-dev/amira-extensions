/**
 * Mermaid → Unicode box-drawing text, for terminals. Supports flowchart/graph and
 * sequenceDiagram; every line fits the requested width (measured with Bun.stringWidth).
 */
import { renderFlowchart } from "./flowchart/index.ts"
import { meaningfulLines, strWidth, truncate } from "./util.ts"

export type LineKind = "text" | "muted" | "accent" | "code"

/** One output line: plain text, no escape sequences, no newlines. */
export interface DiagramLine {
  kind: LineKind
  text: string
}

/**
 * The diagram's type from its first meaningful line: "flowchart" (also for `graph`),
 * "sequence", or the raw keyword (e.g. "pie", "gantt", "classDiagram") or undefined for empty
 * input. Skips blank lines, `%%` comments, and a leading `---` front-matter block.
 */
export function diagramType(source: string): string | undefined {
  const first = meaningfulLines(source)[0]
  if (first === undefined) return undefined
  const word = /^\s*([^\s;:{]+)/.exec(first)?.[1]
  if (!word) return undefined
  if (/^(graph|flowchart|flowchart-elk)$/i.test(word)) return "flowchart"
  if (word === "sequenceDiagram") return "sequence"
  return word
}

/** Below this width nothing useful fits. */
const MIN_WIDTH = 4

/**
 * Text rendering for flowchart/graph and sequenceDiagram; undefined for other types or source
 * it cannot parse. Every returned line has Bun.stringWidth(text) <= width (never overflow, for
 * any width >= 1; for absurdly small widths it may return undefined instead).
 */
export function renderMermaidText(source: string, width: number): DiagramLine[] | undefined {
  if (!Number.isFinite(width) || width < MIN_WIDTH) return undefined
  const w = Math.floor(width)
  let lines: string[] | undefined
  try {
    const type = diagramType(source)
    if (type === "flowchart") lines = renderFlowchart(source, w)?.lines
  } catch {
    return undefined
  }
  if (!lines || lines.length === 0) return undefined
  return lines.map((l) => {
    const text = l.replace(/\s+$/, "")
    return { kind: "code" as const, text: strWidth(text) <= w ? text : truncate(text, w) }
  })
}
