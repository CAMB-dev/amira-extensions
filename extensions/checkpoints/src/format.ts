import type { Message, UserMessage } from "@amira/api"
import type { Checkpoint } from "./store.ts"

export const PROMPT_CHARS = 200

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** What the user sees of a message: its display text, or its text. */
export function messageText(m: UserMessage): string {
  if (m.display?.text) return m.display.text
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

/** The prompt as a checkpoint records it. */
export function promptOf(m: UserMessage): string {
  return clip(oneLine(messageText(m)), PROMPT_CHARS)
}

export function time(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (now - ts < 20 * 3600_000 && new Date(now).getDate() === d.getDate()) return hm
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`
}

/** What a checkpoint was taken before, in a few words. */
export function what(c: Checkpoint, width = 60): string {
  const m = c.meta
  if (m.kind === "tool") return clip(`before ${m.tool ?? "a tool call"}`, width)
  if (m.kind === "restore") return clip(m.note ?? "before a restore", width)
  const head = `${m.notice ? "notice" : "turn"} ${m.turn ?? "?"} · `
  return `${head}“${clip(m.prompt ?? "", Math.max(8, width - head.length - 2))}”`
}

export function files(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`
}

/** One row of a list, e.g. `#12  14:02  turn 5 · “fix the parser” · 3 files changed since`. */
export function row(c: Checkpoint, since: number | undefined, width = 60): string {
  const tail = since === undefined ? "" : ` · ${since ? `${files(since)} changed since` : "no changes since"}`
  return `#${c.n}  ${time(c.meta.ts)}  ${what(c, width)}${tail}`
}

/**
 * Where the message that started checkpoint `target`'s turn is in `messages`: the very message
 * when it is known (`prompts`, by turn id), otherwise by its text, matching the session's turn
 * checkpoints to its user messages from the newest back. Undefined when it is not there (cut
 * off or summarized away).
 */
export function promptIndex(
  messages: readonly Message[],
  target: Checkpoint,
  list: Checkpoint[],
  prompts: Map<string, UserMessage>,
): number | undefined {
  if (target.meta.kind !== "turn") return undefined
  const known = target.meta.turnId ? prompts.get(target.meta.turnId) : undefined
  if (known) {
    const i = messages.indexOf(known)
    return i >= 0 ? i : undefined
  }
  const turns = list.filter((c) => c.session === target.session && c.meta.kind === "turn" && c.n >= target.n)
  turns.sort((a, b) => b.n - a.n)
  let limit = messages.length
  for (const c of turns) {
    let found = -1
    for (let i = limit - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === "user" && promptOf(m) === c.meta.prompt) {
        found = i
        break
      }
    }
    if (c.n === target.n) return found >= 0 ? found : undefined
    if (found >= 0) limit = found
  }
  return undefined
}

/** Keeps a diff to what a dialog can show. */
export function clipDiff(diff: string, maxLines = 400): string {
  const lines = diff.split("\n")
  if (lines.length <= maxLines) return diff
  return `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines`
}
