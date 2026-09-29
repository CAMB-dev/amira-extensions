/**
 * Reading a workflow script without running it: its `meta` literal and a rough estimate of
 * how many agents it starts, for the confirmation the user sees before a run.
 */

export interface WorkflowMeta {
  name: string
  description: string
  phases: string[]
}

/** A script that cannot be read: no meta, a meta that is not a plain literal, bad fields. */
export class ScriptError extends Error {
  override name = "ScriptError"
}

const NAME = /^[A-Za-z0-9][\w.-]*$/

/**
 * Finds `export const meta = { ... }` and parses the literal after it. Only a pure literal is
 * accepted (strings, numbers, booleans, null, arrays and objects; no expressions or template
 * substitutions), so reading it never runs any code.
 */
export function parseMeta(source: string): WorkflowMeta {
  return readMeta(source).meta
}

/** parseMeta, and where the literal ends in `source`. */
export function readMeta(source: string): { meta: WorkflowMeta; end: number } {
  const m = /(^|\n)\s*export\s+const\s+meta\s*(?::[^=]+)?=\s*/.exec(source)
  if (!m)
    throw new ScriptError("the script must start with `export const meta = { name, description, phases }`")
  const parser = new LiteralParser(source, m.index + m[0].length)
  let value: unknown
  try {
    value = parser.value()
  } catch (err) {
    throw new ScriptError(`meta must be a plain literal: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { meta: checkMeta(value), end: parser.at }
}

function checkMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScriptError("meta must be an object")
  const v = value as Record<string, unknown>
  if (typeof v.name !== "string" || !NAME.test(v.name)) {
    throw new ScriptError('meta.name must be a short name of letters, digits, "-", "_" and "."')
  }
  if (typeof v.description !== "string" || !v.description.trim()) {
    throw new ScriptError("meta.description must be a non-empty string")
  }
  const phases = v.phases ?? []
  if (!Array.isArray(phases) || !phases.every((p) => typeof p === "string" && p.trim())) {
    throw new ScriptError("meta.phases must be a list of phase titles")
  }
  return {
    name: v.name,
    description: v.description.replace(/\s+/g, " ").trim(),
    phases: phases.map((p) => p.trim()),
  }
}

/** A JSON5-ish literal reader: comments, single quotes, unquoted keys, trailing commas. */
class LiteralParser {
  constructor(
    private src: string,
    private i: number,
  ) {}

  /** Where the reader is: after a value(), just past it. */
  get at(): number {
    return this.i
  }

  value(): unknown {
    this.space()
    const c = this.src[this.i]
    if (c === "{") return this.object()
    if (c === "[") return this.array()
    if (c === '"' || c === "'" || c === "`") return this.string()
    if (c === "-" || (c !== undefined && /[0-9.]/.test(c))) return this.number()
    const word = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i))?.[0]
    if (word === "true" || word === "false" || word === "null") {
      this.i += word.length
      return word === "true" ? true : word === "false" ? false : null
    }
    throw new Error(
      `unexpected ${word ? `"${word}"` : c === undefined ? "end of script" : `"${c}"`} at ${this.where()}`,
    )
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    this.i++
    for (;;) {
      this.space()
      if (this.src[this.i] === "}") {
        this.i++
        return out
      }
      const c = this.src[this.i]
      let key: string
      if (c === '"' || c === "'") key = this.string()
      else {
        const word = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i))?.[0]
        if (!word) throw new Error(`expected a key at ${this.where()}`)
        key = word
        this.i += word.length
      }
      this.space()
      if (this.src[this.i] !== ":") throw new Error(`expected ":" after "${key}" at ${this.where()}`)
      this.i++
      out[key] = this.value()
      this.space()
      if (this.src[this.i] === ",") this.i++
      else if (this.src[this.i] !== "}") throw new Error(`expected "," or "}" at ${this.where()}`)
    }
  }

  private array(): unknown[] {
    const out: unknown[] = []
    this.i++
    for (;;) {
      this.space()
      if (this.src[this.i] === "]") {
        this.i++
        return out
      }
      out.push(this.value())
      this.space()
      if (this.src[this.i] === ",") this.i++
      else if (this.src[this.i] !== "]") throw new Error(`expected "," or "]" at ${this.where()}`)
    }
  }

  private string(): string {
    const quote = this.src[this.i]!
    let out = ""
    this.i++
    for (;;) {
      const c = this.src[this.i]
      if (c === undefined) throw new Error("unterminated string")
      if (c === quote) {
        this.i++
        return out
      }
      if (quote === "`" && c === "$" && this.src[this.i + 1] === "{") {
        throw new Error(`template substitutions are not allowed at ${this.where()}`)
      }
      if (c === "\n" && quote !== "`") throw new Error(`line break in a string at ${this.where()}`)
      if (c === "\\") {
        const n = this.src[this.i + 1]
        const map: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "\\": "\\",
          "'": "'",
          '"': '"',
          "`": "`",
        }
        if (n === "u") {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 2, this.i + 6), 16))
          this.i += 6
          continue
        }
        out += n !== undefined && n in map ? map[n] : (n ?? "")
        this.i += 2
        continue
      }
      out += c
      this.i++
    }
  }

  private number(): number {
    const m = /^-?(\d[\d_]*)?(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.i))
    const text = m?.[0] ?? ""
    const n = Number(text.replace(/_/g, ""))
    if (!text || Number.isNaN(n)) throw new Error(`bad number at ${this.where()}`)
    this.i += text.length
    return n
  }

  /** Skips whitespace and comments. */
  private space() {
    for (;;) {
      const rest = this.src.slice(this.i)
      const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest)
      if (!m) return
      this.i += m[0].length
    }
  }

  private where(): string {
    const line = this.src.slice(0, this.i).split("\n").length
    return `line ${line}`
  }
}

/** How many agents a run starts, as far as reading the script tells. */
export interface Estimate {
  /** agent() calls written in the script. */
  calls: number
  /** The count depends on data: calls in loops, map, pipeline or nested workflows. */
  dynamic: boolean
}

/** Strips comments and string contents, so counting calls does not see them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '""')
}

/** A dry parse: counts agent() calls and whether loops or pipelines make the count depend on data. */
export function estimate(source: string): Estimate {
  const code = codeOnly(source)
  const calls = (code.match(/(^|[^\w$.])agent\s*\(/g) ?? []).length
  const dynamic =
    /\b(for|while|do)\b\s*[({]?/.test(code) ||
    /\.(map|forEach|flatMap|reduce|filter)\s*\(/.test(code) ||
    /(^|[^\w$.])(pipeline|workflow)\s*\(/.test(code)
  return { calls, dynamic }
}

/** How many agents a run starts, in plain words: "4", "4 or more (some run in loops)". */
export function sizeLine(e: Estimate): string {
  if (!e.dynamic) return `${e.calls}`
  if (!e.calls) return "as many as its input needs"
  return `${e.calls} or more (some run in loops)`
}

/** Whether a run changes the user's files directly, or through worktrees merged back. */
export function workspaceLine(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  return /isolation\s*:\s*["'`]worktree["'`]/.test(code)
    ? "some agents work in their own git worktrees, merged into your working tree when they finish; the others work in it directly and can change your files."
    : "its agents work in your working tree and can change your files."
}
