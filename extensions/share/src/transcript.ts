import type { Message, SubagentInfo, Usage } from "@amira/api"
import type { Redactor } from "./redact.ts"

/**
 * A session laid out for export, independent of the format: turns of the conversation with
 * each tool call next to its result, and the sub-agents' own conversations. Every text in it
 * has been through the redactor already.
 */
export interface Transcript {
  sessionId: string
  cwd: string
  createdAt?: number
  exportedAt: number
  /** "provider/model" of every model that replied, in order of first reply. */
  models: string[]
  /** The session's own replies; sub-agents' are with each of them. */
  usage: Usage
  entries: Entry[]
  subagents: SubagentSection[]
}

export interface ImagePart {
  mimeType: string
  /** Base64. */
  data: string
}

export type Entry =
  | {
      kind: "user"
      text: string
      /** What the user typed, when the message stands for more (a command, a skill). */
      display?: string
      note?: string
      images: ImagePart[]
    }
  /** A message the user did not write, e.g. a background sub-agent's report. */
  | { kind: "notice"; origin: string; text: string; display?: string }
  | { kind: "assistant"; model: string; parts: Part[]; stopReason?: string }

export type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; call: ToolCall }

export interface ToolCall {
  id: string
  name: string
  /** A few words about what it did, e.g. the command or the file. */
  summary: string
  /** Its arguments as indented JSON. */
  args: string
  result?: { text: string; isError: boolean; images: ImagePart[] }
  /** Sub-agents this call started (their sections' ids). */
  subagents: { id: string; title: string }[]
}

export interface SubagentSection {
  id: string
  title: string
  role: string
  status: string
  depth: number
  task: string
  model?: string
  usage: Usage
  durationMs?: number
  error?: string
  entries: Entry[]
}

export interface TranscriptSource {
  sessionId: string
  cwd: string
  createdAt?: number
  messages: readonly Message[]
  subagents: SubagentInfo[]
  subagentMessages(id: string): readonly Message[] | undefined
}

export function buildTranscript(src: TranscriptSource, redact: Redactor, now = Date.now()): Transcript {
  const byCall = new Map<string, { id: string; title: string }[]>()
  for (const s of src.subagents) {
    if (!s.toolCallId) continue
    const list = byCall.get(s.toolCallId) ?? []
    list.push({ id: s.id, title: redact(s.title) })
    byCall.set(s.toolCallId, list)
  }
  const models: string[] = []
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const m of src.messages) {
    if (m.role !== "assistant") continue
    const ref = `${m.model.provider}/${m.model.model}`
    if (!models.includes(ref)) models.push(ref)
    addUsage(usage, m.usage)
  }
  return {
    sessionId: src.sessionId,
    cwd: redact(src.cwd),
    ...(src.createdAt !== undefined ? { createdAt: src.createdAt } : {}),
    exportedAt: now,
    models,
    usage,
    entries: entriesOf(src.messages, redact, byCall),
    subagents: src.subagents.map((s) => ({
      id: s.id,
      title: redact(s.title),
      role: s.role,
      status: s.status,
      depth: s.depth,
      task: redact(s.task),
      ...(s.model ? { model: `${s.model.provider}/${s.model.model}` } : {}),
      usage: s.usage,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.error ? { error: redact(s.error) } : {}),
      entries: entriesOf(src.subagentMessages(s.id) ?? [], redact, byCall),
    })),
  }
}

function addUsage(total: Usage, u: Usage | undefined): void {
  if (!u) return
  total.input += u.input
  total.output += u.output
  total.cacheRead += u.cacheRead
  total.cacheWrite += u.cacheWrite
  if (u.cost !== undefined) total.cost = (total.cost ?? 0) + u.cost
}

function entriesOf(
  messages: readonly Message[],
  redact: Redactor,
  byCall: Map<string, { id: string; title: string }[]>,
): Entry[] {
  const out: Entry[] = []
  const calls = new Map<string, ToolCall>()
  for (const m of messages) {
    if (m.role === "user") {
      const text = redact(m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
      const images = m.content.flatMap((b) =>
        b.type === "image" ? [{ mimeType: b.mimeType, data: b.data }] : [],
      )
      const display = m.display?.text.trim() ? redact(m.display.text) : undefined
      if (m.display?.origin) {
        out.push({ kind: "notice", origin: m.display.origin, text, ...(display ? { display } : {}) })
        continue
      }
      out.push({
        kind: "user",
        text,
        ...(display && display !== text ? { display } : {}),
        ...(m.display?.note ? { note: redact(m.display.note) } : {}),
        images,
      })
      continue
    }
    if (m.role === "assistant") {
      const parts: Part[] = []
      for (const b of m.content) {
        if (b.type === "text") {
          if (b.text.trim()) parts.push({ kind: "text", text: redact(b.text) })
        } else if (b.type === "thinking") {
          if (b.text.trim()) parts.push({ kind: "thinking", text: redact(b.text) })
        } else {
          const call: ToolCall = {
            id: b.id,
            name: b.name,
            summary: redact(summarize(b.name, b.args)),
            args: redact(JSON.stringify(b.args ?? {}, null, 2)),
            subagents: byCall.get(b.id) ?? [],
          }
          calls.set(b.id, call)
          parts.push({ kind: "tool", call })
        }
      }
      out.push({
        kind: "assistant",
        model: `${m.model.provider}/${m.model.model}`,
        parts,
        ...(m.stopReason && m.stopReason !== "end" && m.stopReason !== "toolUse"
          ? { stopReason: m.stopReason }
          : {}),
      })
      continue
    }
    const call = calls.get(m.toolCallId)
    const result = {
      text: redact(m.content.map((b) => (b.type === "text" ? b.text : "")).join("")),
      isError: m.isError,
      images: m.content.flatMap((b) => (b.type === "image" ? [{ mimeType: b.mimeType, data: b.data }] : [])),
    }
    if (call) call.result = result
    else {
      // A result without its call (cut by a compaction): shown on its own.
      out.push({
        kind: "assistant",
        model: "",
        parts: [
          {
            kind: "tool",
            call: { id: m.toolCallId, name: m.toolName, summary: "", args: "{}", result, subagents: [] },
          },
        ],
      })
    }
  }
  return out
}

/** Arguments that say best what a call of a tool did, in order of preference. */
const SUMMARY_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "url",
  "query",
  "title",
  "name",
  "task",
  "prompt",
]

/** One line about a tool call: its most telling argument, cut to 80 characters. */
export function summarize(name: string, args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return ""
  if (name === "agent" && Array.isArray(args.tasks)) {
    const titles = args.tasks.flatMap((t) =>
      t && typeof t === "object" && typeof (t as { title?: unknown }).title === "string"
        ? [(t as { title: string }).title]
        : [],
    )
    if (titles.length) return oneLine(titles.join(", "))
  }
  for (const key of SUMMARY_KEYS) {
    const v = args[key]
    if (typeof v === "string" && v.trim()) return oneLine(v)
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim())
  return typeof first === "string" ? oneLine(first) : ""
}

function oneLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "2026-09-29 14:05" in local time. */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A line about tokens and cost, e.g. "12.3k tokens · $0.0042". */
export function usageLine(u: Usage): string {
  const cost = u.cost !== undefined ? ` · $${u.cost.toFixed(u.cost < 0.01 ? 4 : 2)}` : ""
  return `${formatTokens(totalTokens(u))} tokens${cost}`
}
