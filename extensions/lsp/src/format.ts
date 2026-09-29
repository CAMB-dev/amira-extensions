import path from "node:path"
import type { Diagnostic } from "./client.ts"
import { SEVERITY_NAME } from "./settings.ts"

/** Starts the text block added to a tool result, so presenters can find it again. */
export const HEADER = "LSP diagnostics"

/** What one file's check found. */
export interface FileReport {
  file: string
  diagnostics: Diagnostic[]
  /** Set when the file had problems reported before and has none now. */
  cleared?: boolean
}

export interface Counts {
  errors: number
  warnings: number
  /** Information and hints. */
  other: number
}

export function severityOf(d: Diagnostic): number {
  return typeof d.severity === "number" && d.severity >= 1 && d.severity <= 4 ? d.severity : 1
}

export function countOf(diagnostics: readonly Diagnostic[]): Counts {
  const c: Counts = { errors: 0, warnings: 0, other: 0 }
  for (const d of diagnostics) {
    const s = severityOf(d)
    if (s === 1) c.errors++
    else if (s === 2) c.warnings++
    else c.other++
  }
  return c
}

/** Diagnostics at `threshold` (a severity number) or more severe, most severe first, then by position. */
export function filterSorted(diagnostics: readonly Diagnostic[], threshold: number): Diagnostic[] {
  return diagnostics
    .filter((d) => severityOf(d) <= threshold)
    .sort(
      (a, b) =>
        severityOf(a) - severityOf(b) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    )
}

/** A path as the model is shown it: relative to the working directory when inside it, with `/`. */
export function displayPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file)
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file
  return shown.replace(/\\/g, "/")
}

/** One line: `src/a.ts:3:7 error Type 'x' is not assignable to 'y'. (2322)`. */
export function diagnosticLine(d: Diagnostic, shownPath: string): string {
  const first = d.message.split(/\r?\n/).find((l) => l.trim()) ?? ""
  const message = clip(first.trim().replace(/\s+/g, " "), 240)
  const code = d.code !== undefined && d.code !== "" ? ` (${d.code})` : ""
  const { line, character } = d.range.start
  return `${shownPath}:${line + 1}:${character + 1} ${SEVERITY_NAME[severityOf(d)]} ${message}${code}`
}

/**
 * The text added to a result: a header with the counts, then one line per diagnostic, at
 * most `maxItems` of them, and a line for each file whose earlier problems are gone.
 * Undefined when there is nothing to say.
 */
export function formatReports(
  reports: readonly FileReport[],
  opts: { cwd: string; threshold: number; maxItems: number },
): string | undefined {
  const lines: string[] = []
  const shownAll: Diagnostic[] = []
  let listed = 0
  let hidden = 0
  for (const r of reports) {
    const shown = displayPath(r.file, opts.cwd)
    const list = filterSorted(r.diagnostics, opts.threshold)
    shownAll.push(...list)
    if (!list.length) {
      if (r.cleared) lines.push(`${shown}: no problems now`)
      continue
    }
    for (const d of list) {
      if (listed >= opts.maxItems) hidden++
      else {
        lines.push(diagnosticLine(d, shown))
        listed++
      }
    }
  }
  if (!lines.length) return undefined
  if (hidden) lines.push(`… ${hidden} more (the diagnostics tool lists them all)`)
  return [`${HEADER}: ${describeCounts(countOf(shownAll))}`, ...lines].join("\n")
}

/** Short counts such as "2 errors · 1 warning", or "no problems". */
export function describeCounts(c: Counts): string {
  const parts: string[] = []
  if (c.errors) parts.push(plural(c.errors, "error"))
  if (c.warnings) parts.push(plural(c.warnings, "warning"))
  if (c.other) parts.push(`${c.other} info`)
  return parts.length ? parts.join(" · ") : "no problems"
}

/** The counts in the header of a diagnostics block (see formatReports). */
export function countsInText(block: string): Counts {
  const header = block.split("\n", 1)[0] ?? ""
  const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(header)?.[1] ?? 0)
  return { errors: n("error"), warnings: n("warning"), other: n("info") }
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
