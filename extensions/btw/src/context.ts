import type { Message } from "@amira/api"

const CONTEXT_CHARS = 60_000
const SUMMARY_CHARS = 240

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line
}

/** Plain context only: no images, reasoning, tool blocks or provider replay metadata. */
export function buildContext(messages: readonly Message[], budget = CONTEXT_CHARS): string {
  if (budget <= 0) return ""
  const recent: string[] = []
  let remaining = Math.floor(budget)
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!
    const text = message.content
      .flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "toolCall") return [`[Tool call: ${part.name} ${short(JSON.stringify(part.args))}]`]
        return []
      })
      .join("\n")
    if (!text) continue
    const entry =
      message.role === "toolResult"
        ? `[Tool result: ${message.toolName}${message.isError ? " (error)" : ""}: ${short(text)}]`
        : `${message.role}:\n${text}`
    // Trim from the oldest end, including a partial oldest message when necessary.
    const suffix = recent.length ? "\n\n" : ""
    const chunk = `${entry}${suffix}`.slice(-remaining)
    recent.push(chunk)
    remaining -= chunk.length
  }
  return recent.reverse().join("")
}
