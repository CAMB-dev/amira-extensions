export type Scope = "global" | "project"
export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryInput {
  name: string
  type: MemoryType
  description: string
  body: string
}

export interface Memory extends MemoryInput {
  updated: string
  text: string
}

export const FILE_BYTES = 4096
export const INDEX_BYTES = 8192
export const INDEX_LINES = 200

export class MemoryError extends Error {}

export function scopeOf(value: unknown): Scope {
  if (value !== "global" && value !== "project") throw new MemoryError("Choose scope global or project.")
  return value
}

export function checkName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) ||
    /^(?:memory|con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)
  ) {
    throw new MemoryError("Use a kebab-case name of 1–64 characters, starting with a letter (no paths).")
  }
}

function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length
    return sum - p * Math.log2(p)
  }, 0)
}

/** Deliberately conservative; never include rejected input in diagnostics. */
export function checkSecrets(text: string): void {
  const known =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-(?:live-|test-)?[a-z0-9_-]{12,}|\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S{8,}/i
  const assignment =
    /\b(?:password|passwd|pwd|secret|api[ _-]?key|access[ _-]?key|(?:access[ _-]?|auth[ _-]?)?token)["'`*_]*\s*(?:[:=]|\bis\b)\s*\S+/i
  const tokens = text.match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []
  // Hex has at most 4 bits/character; it needs its own threshold.
  const hexTokens = text.match(/\b[a-f0-9]{32,}\b/gi) ?? []
  if (
    known.test(text) ||
    assignment.test(text) ||
    tokens.some((token) => entropy(token) >= 4.2) ||
    hexTokens.some((token) => entropy(token.toLowerCase()) >= 3.5)
  ) {
    throw new MemoryError("Memory was not saved: remove credentials and secret-like strings, then try again.")
  }
}

export function serialize(input: MemoryInput, updated = new Date().toISOString()): Memory {
  checkName(input.name)
  if (!["user", "feedback", "project", "reference"].includes(input.type)) {
    throw new MemoryError("Choose type user, feedback, project or reference.")
  }
  if (
    typeof input.description !== "string" ||
    !input.description.trim() ||
    input.description.length > 240 ||
    /[\r\n\p{Cc}\p{Cf}\u2028\u2029]/u.test(input.description)
  ) {
    throw new MemoryError("Use a one-line description of 1–240 characters without control characters.")
  }
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new MemoryError("Write a concise fact in the memory body.")
  }
  checkSecrets(`${input.description}\n${input.body}`)
  if (/[\p{Cc}\p{Cf}]/u.test(input.body.replace(/[\n\r\t]/g, ""))) {
    throw new MemoryError("Remove control characters from the memory body.")
  }
  if (input.type === "feedback" || input.type === "project") {
    const why = /\*\*Why:\*\*([\s\S]*?)(?=\*\*How to apply:\*\*|$)/.exec(input.body)?.[1]?.trim()
    const how = /\*\*How to apply:\*\*([\s\S]*?)(?=\*\*Why:\*\*|$)/.exec(input.body)?.[1]?.trim()
    if (!why || !how) {
      throw new MemoryError("Feedback and project memories need **Why:** and **How to apply:** with reasons.")
    }
  }
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(updated) ||
    !Number.isFinite(Date.parse(updated)) ||
    new Date(updated).toISOString().slice(0, 10) !== updated.slice(0, 10)
  ) {
    throw new MemoryError("Use an ISO date for updated (YYYY-MM-DD or a UTC ISO timestamp).")
  }
  const description = input.description.trim()
  const body = input.body.trim()
  const text = `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\ntype: ${input.type}\nupdated: ${updated}\n---\n\n${body}\n`
  if (Buffer.byteLength(text) > FILE_BYTES)
    throw new MemoryError("Keep each memory under 4 KiB, including metadata.")
  return { ...input, description, body, updated, text }
}

export function parseMemory(text: string, name: string): Memory {
  checkName(name)
  if (Buffer.byteLength(text) > FILE_BYTES) throw new MemoryError("This memory exceeds the 4 KiB file limit.")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) throw new MemoryError("This memory needs valid Markdown frontmatter.")
  const fields = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description|type|updated): (.+)$/.exec(line)
    if (!field || fields.has(field[1]!)) throw new MemoryError("This memory has invalid metadata.")
    let value = field[2]!
    if (value.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value)
        if (typeof decoded !== "string") throw new Error()
        value = decoded
      } catch {
        throw new MemoryError("This memory has invalid quoted metadata.")
      }
    }
    fields.set(field[1]!, value)
  }
  if (fields.get("name") !== name) throw new MemoryError("The memory name must match its filename.")
  const memory = serialize(
    {
      name,
      description: fields.get("description") ?? "",
      type: fields.get("type") as MemoryType,
      body: match[2]!,
    },
    fields.get("updated") ?? "",
  )
  return { ...memory, text }
}

function inline(text: string): string {
  return text.replace(/[\\[\]<>`*_]/g, (char) => `\\${char}`)
}

export function indexText(memories: readonly Memory[]): string {
  return [
    "# Memory",
    "",
    ...memories.map((m) => `- [${m.name}](${m.name}.md) — ${inline(m.description)}`),
    "",
  ].join("\n")
}

export function newest(memories: Memory[]): Memory[] {
  return memories.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))
}

/** Only the injected index is capped; the complete index stays available on disk and in /memory list. */
export function cappedIndex(memories: readonly Memory[], invalid = 0): string {
  const note =
    "Some memories are omitted. Use /memory list to inspect them; consolidate overlapping memories."
  const warning = invalid
    ? "Invalid memory files were omitted. Inspect the scope directory to repair them."
    : ""
  const lines = ["# Memory", ""]
  for (const memory of memories) {
    const line = `- [${memory.name}](${memory.name}.md) — ${inline(memory.description)}`
    const candidate = [...lines, line, warning, note, ""].join("\n")
    if (candidate.split("\n").length > INDEX_LINES || Buffer.byteLength(candidate) > INDEX_BYTES) break
    lines.push(line)
  }
  const omitted = lines.length - 2 < memories.length
  if (warning) lines.push(warning)
  if (omitted) lines.push(note)
  if (!memories.length && !invalid) lines.push("No memories saved.")
  return `${lines.join("\n")}\n`
}
