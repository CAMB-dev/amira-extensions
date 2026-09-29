/** Text helpers that measure in terminal columns (Bun.stringWidth), never in UTF-16 units. */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment)
}

export function strWidth(s: string): number {
  return Bun.stringWidth(s)
}

export function maxWidth(lines: readonly string[]): number {
  let w = 0
  for (const l of lines) w = Math.max(w, strWidth(l))
  return w
}

/** Cuts `s` to at most `max` columns, ending with … when something was cut. */
export function truncate(s: string, max: number): string {
  if (strWidth(s) <= max) return s
  if (max <= 0) return ""
  let out = ""
  let w = 0
  for (const g of graphemes(s)) {
    const gw = strWidth(g)
    if (w + gw + 1 > max) break
    out += g
    w += gw
  }
  return out + "…"
}

interface Token {
  text: string
  spaceBefore: boolean
}

/** Splits text into wrap units: runs of narrow non-space characters, and single wide (CJK) characters. */
function tokens(text: string): Token[] {
  const out: Token[] = []
  let cur = ""
  let space = false
  const flush = () => {
    if (cur) out.push({ text: cur, spaceBefore: space })
    cur = ""
  }
  let pendingSpace = false
  for (const g of graphemes(text)) {
    if (/^\s+$/.test(g)) {
      if (cur) {
        flush()
      }
      pendingSpace = true
      continue
    }
    if (strWidth(g) >= 2) {
      if (cur) flush()
      out.push({ text: g, spaceBefore: pendingSpace })
      pendingSpace = false
      space = false
      continue
    }
    if (!cur) {
      space = pendingSpace
      pendingSpace = false
    }
    cur += g
  }
  flush()
  return out
}

/**
 * Word-wraps one paragraph (no newlines). Line i fits `widthOf(i)` columns (a lone wide
 * character may still exceed a width of 1). Linear in the length of the text.
 */
function wrapWith(text: string, widthOf: (line: number) => number): string[] {
  const toks = tokens(text)
  if (toks.length === 0) return [""]
  const lines: string[] = []
  let line = ""
  let lw = 0
  const cap = () => Math.max(1, widthOf(lines.length))
  for (const t of toks) {
    const sep = line && t.spaceBefore ? " " : ""
    const tw = strWidth(t.text)
    if (lw + sep.length + tw <= cap()) {
      line += sep + t.text
      lw += sep.length + tw
      continue
    }
    if (line) lines.push(line)
    line = ""
    lw = 0
    if (tw <= cap()) {
      line = t.text
      lw = tw
      continue
    }
    // A word longer than a line: cut it grapheme by grapheme.
    for (const g of graphemes(t.text)) {
      const gw = strWidth(g)
      if (lw + gw > cap() && line) {
        lines.push(line)
        line = ""
        lw = 0
      }
      line += g
      lw += gw
    }
  }
  if (line || lines.length === 0) lines.push(line)
  return lines
}

/** Word-wraps one paragraph (no newlines) to lines of at most `max` columns. */
export function wrapLine(text: string, max: number): string[] {
  return wrapWith(text, () => max)
}

/** Wraps text that may contain newlines. */
export function wrapText(text: string, max: number): string[] {
  return text.split("\n").flatMap((l) => wrapLine(l.trim(), max))
}

/** Wraps one paragraph so the first line fits `first` columns and later lines fit `rest` columns. */
export function wrapHanging(text: string, first: number, rest: number): string[] {
  return wrapWith(text, (i) => (i === 0 ? first : rest))
}

export function spaces(n: number): string {
  return n > 0 ? " ".repeat(n) : ""
}

/** Centers `s` in a field of `w` columns (extra space goes right). */
export function center(s: string, w: number): string {
  const sw = strWidth(s)
  const left = Math.floor((w - sw) / 2)
  return spaces(left) + s + spaces(w - sw - left)
}

/** Turns Mermaid label markup into plain text: <br> → newline, tags and markdown markers stripped, entities decoded. */
export function cleanLabel(raw: string): string {
  let s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) {
    s = s.slice(1, -1).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/__(.+?)__/g, "$1")
  }
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "")
  s = s.replace(/\bfa[bsrl]?:fa-[\w-]+\s*/g, "")
  s = s.replace(/#(\d+);/g, (_, n: string) => {
    const cp = Number(n)
    return cp <= 0x10ffff ? stripControls(String.fromCodePoint(cp)) : ""
  })
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " ", apos: "'" }
  s = s.replace(/[&#](quot|amp|lt|gt|nbsp|apos);/g, (_, n: string) => named[n] ?? "")
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
}

/** Terminal escape sequences and control characters (other than tab and newline). */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/** Removes escape sequences and control characters; tabs become spaces. */
export function stripControls(s: string): string {
  return s.replace(CONTROL, "").replace(/\t/g, " ")
}

/** Source lines with front matter, directives and %% comments removed. */
export function meaningfulLines(source: string): string[] {
  const lines = stripControls(source.replace(/\r\n?/g, "\n")).split("\n")
  let i = 0
  while (i < lines.length && lines[i]!.trim() === "") i++
  if (i < lines.length && lines[i]!.trim() === "---") {
    let j = i + 1
    while (j < lines.length && lines[j]!.trim() !== "---") j++
    if (j < lines.length) i = j + 1
  }
  const out: string[] = []
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (t === "" || t.startsWith("%%")) continue
    out.push(lines[i]!)
  }
  return out
}
