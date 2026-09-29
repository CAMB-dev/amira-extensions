import {
  type Entry,
  formatDuration,
  formatTime,
  type ImagePart,
  type Part,
  type SubagentSection,
  type ToolCall,
  type Transcript,
  usageLine,
} from "./transcript.ts"

/**
 * The transcript as GitHub-flavoured Markdown: the conversation in order, each tool call a
 * collapsible `<details>` with its arguments and result, and every sub-agent in a section of
 * its own at the end. Images are named, not embedded.
 */
export function renderMarkdown(t: Transcript): string {
  const out: string[] = []
  out.push(`# Amira session ${t.sessionId}`, "")
  out.push(`- Directory: \`${t.cwd}\``)
  if (t.createdAt !== undefined) out.push(`- Started: ${formatTime(t.createdAt)}`)
  out.push(`- Exported: ${formatTime(t.exportedAt)}`)
  if (t.models.length) out.push(`- Models: ${t.models.map((m) => `\`${m}\``).join(", ")}`)
  out.push(`- Usage: ${usageLine(t.usage)}`)
  if (t.subagents.length) out.push(`- Sub-agents: ${t.subagents.length} (see [Sub-agents](#sub-agents))`)
  out.push("")
  renderEntries(out, t.entries, 2)
  if (t.subagents.length) {
    out.push("---", "", "## Sub-agents", "")
    for (const s of t.subagents) renderSubagent(out, s)
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`
}

function renderEntries(out: string[], entries: Entry[], level: number): void {
  const h = "#".repeat(level + 1)
  for (const e of entries) {
    if (e.kind === "user") {
      out.push("---", "", `${h} User`, "")
      if (e.display) out.push(`> ${escapeInline(e.display)}`, "")
      if (e.note) out.push(`*${escapeInline(e.note)}*`, "")
      if (e.display) out.push(details("Full message", fence(e.text)))
      else out.push(e.text, "")
      for (const img of e.images) out.push(imageLine(img), "")
      continue
    }
    if (e.kind === "notice") {
      out.push(
        `> **Notice (${escapeInline(e.origin)})**${e.display ? `: ${escapeInline(e.display)}` : ""}`,
        "",
      )
      out.push(details("Message", fence(e.text)))
      continue
    }
    out.push(`${h} Assistant${e.model ? ` · \`${e.model}\`` : ""}`, "")
    for (const p of e.parts) renderPart(out, p)
    if (e.stopReason) out.push(`*Stopped: ${e.stopReason}*`, "")
  }
}

function renderPart(out: string[], p: Part): void {
  if (p.kind === "text") {
    out.push(p.text, "")
    return
  }
  if (p.kind === "thinking") {
    out.push(details("Thinking", p.text))
    return
  }
  out.push(details(toolSummary(p.call), toolBody(p.call)))
}

function toolSummary(c: ToolCall): string {
  const mark = c.result === undefined ? " (no result)" : c.result.isError ? " ✗" : ""
  return `${escapeHtml(c.name)}${c.summary ? ` · ${escapeHtml(c.summary)}` : ""}${mark}`
}

function toolBody(c: ToolCall): string {
  const parts: string[] = []
  if (c.args !== "{}") parts.push("**Arguments**", "", fence(c.args, "json"))
  for (const s of c.subagents) parts.push(`Sub-agent: [${escapeInline(s.title)}](#${anchor(s.id)})`, "")
  if (c.result) {
    parts.push(c.result.isError ? "**Error**" : "**Result**", "", fence(c.result.text || "(empty)"))
    for (const img of c.result.images) parts.push(imageLine(img), "")
  }
  return parts.join("\n")
}

function renderSubagent(out: string[], s: SubagentSection): void {
  const facts = [s.role, s.status, s.model ? `\`${s.model}\`` : "", usageLine(s.usage)]
  if (s.durationMs !== undefined) facts.push(formatDuration(s.durationMs))
  out.push(`<a id="${anchor(s.id)}"></a>`, "")
  out.push(`### ${"↳ ".repeat(Math.max(0, s.depth - 1))}${escapeInline(s.title)}`, "")
  out.push(facts.filter(Boolean).join(" · "), "")
  if (s.error) out.push(`**Error:** ${escapeInline(s.error)}`, "")
  if (!s.entries.length) {
    out.push("*No conversation was recorded.*", "")
    return
  }
  const conversation: string[] = []
  renderEntries(conversation, s.entries, 3)
  out.push(details("Conversation", conversation.join("\n")))
}

function imageLine(img: ImagePart): string {
  const kb = Math.round((img.data.length * 3) / 4 / 1024)
  return `*[image: ${img.mimeType}, ${kb} KB]*`
}

/** A collapsed block; the blank lines let Markdown inside it render. */
function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body.trim()}\n\n</details>\n`
}

/** A fenced code block whose fence is longer than any run of backticks inside. */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = "`".repeat(longest + 1)
  return `${f}${lang}\n${text.replace(/\n+$/, "")}\n${f}\n`
}

export function anchor(id: string): string {
  return `subagent-${id.replace(/[^\w-]/g, "")}`
}

function escapeInline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1")
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
