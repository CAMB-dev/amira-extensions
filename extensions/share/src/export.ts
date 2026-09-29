import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandCandidate, CommandContext } from "@amira/api"
import { renderHtml } from "./html.ts"
import { renderMarkdown } from "./markdown.ts"
import type { Redactor } from "./redact.ts"
import type { ShareSettings } from "./settings.ts"
import { buildTranscript, type TranscriptSource } from "./transcript.ts"

export type ExportFormat = "md" | "html"

export interface ExportArgs {
  format?: ExportFormat
  path?: string
  session?: string
}

/** Splits on spaces, keeping "quoted parts" (with spaces) together. */
export function splitArgs(args: string): string[] {
  const out: string[] = []
  for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

/** `[md|html] [path] [--session <id>]`, in any order. */
export function parseExportArgs(args: string): ExportArgs {
  const out: ExportArgs = {}
  const words = splitArgs(args)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === "--session" || w === "-s") {
      const id = words[++i]
      if (!id) throw new Error("--session needs a session id (see /resume)")
      out.session = id
    } else if (w.startsWith("--session=")) out.session = w.slice("--session=".length)
    else if ((w === "md" || w === "html" || w === "markdown") && out.format === undefined)
      out.format = w === "html" ? "html" : "md"
    else if (w.startsWith("-") && w.length > 1) throw new Error(`unknown option ${w}`)
    else if (out.path === undefined) out.path = w
    else throw new Error(`one path only, got "${out.path}" and "${w}"`)
  }
  return out
}

/** The format a path's extension implies. */
function formatOf(file: string): ExportFormat | undefined {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".md" || ext === ".markdown") return "md"
  if (ext === ".html" || ext === ".htm") return "html"
  return undefined
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** /export: writes the session (this one, or a stored one) as Markdown or HTML. */
export async function runExport(
  args: string,
  ctx: CommandContext,
  deps: { settings: ShareSettings; redact: Redactor; now?: () => number },
): Promise<void> {
  const a = parseExportArgs(args)
  const now = deps.now?.() ?? Date.now()
  const src = sourceFor(ctx, a.session)
  if (!src.messages.length) {
    ctx.print("Nothing to export yet: the session has no messages.", "warning")
    return
  }
  const format = a.format ?? (a.path ? formatOf(a.path) : undefined) ?? deps.settings.exportFormat
  const name = `${src.sessionId}-${stamp(now)}.${format}`
  let file: string
  let madeDefaultDir = false
  if (a.path) {
    const target = path.resolve(ctx.cwd, a.path)
    const isDir = /[\\/]$/.test(a.path) || (existsSync(target) && statSync(target).isDirectory())
    file = isDir ? path.join(target, name) : target
  } else {
    const dir = path.resolve(ctx.cwd, deps.settings.exportDir)
    madeDefaultDir = !existsSync(dir)
    file = path.join(dir, name)
  }
  const transcript = buildTranscript(src, deps.redact, now)
  const text = format === "html" ? renderHtml(transcript) : deps.redact(renderMarkdown(transcript))
  mkdirSync(path.dirname(file), { recursive: true })
  // Exports are for sharing on purpose, not for committing by accident.
  if (madeDefaultDir) writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n")
  writeFileSync(file, text)
  const shown = path.relative(ctx.cwd, file)
  const where = shown && !shown.startsWith("..") && !path.isAbsolute(shown) ? shown : file
  const subs = src.subagents.length
  ctx.print(
    `Exported session ${src.sessionId} (${src.messages.length} messages${subs ? `, ${subs} sub-agent${subs === 1 ? "" : "s"}` : ""}) as ${format === "html" ? "HTML" : "Markdown"} to ${where}. Secrets that look like keys or tokens were replaced with [REDACTED]; check before sharing.`,
  )
}

function sourceFor(ctx: CommandContext, sessionId: string | undefined): TranscriptSource {
  const s = ctx.session
  const info = s.info()
  if (sessionId !== undefined && sessionId !== info.id) {
    if (!s.readSession)
      throw new Error("this version of Amira cannot read stored sessions; update it to export one")
    const stored = s.readSession(sessionId)
    if (!stored) throw new Error(`no stored session ${sessionId} in this directory (see /resume)`)
    return {
      sessionId: stored.id,
      cwd: stored.cwd,
      createdAt: stored.createdAt,
      messages: stored.messages,
      subagents: stored.subagents,
      subagentMessages: (id) => stored.subagentMessages(id),
    }
  }
  // The file has the whole conversation, including what a compaction replaced.
  const stored = s.readSession?.(info.id)
  if (stored?.messages.length) {
    return {
      sessionId: info.id,
      cwd: info.cwd,
      createdAt: stored.createdAt,
      messages: stored.messages,
      subagents: s.subagents(),
      subagentMessages: (id) => s.subagentMessages(id),
    }
  }
  return {
    sessionId: info.id,
    cwd: info.cwd,
    messages: s.messages(),
    subagents: s.subagents(),
    subagentMessages: (id) => s.subagentMessages(id),
  }
}

export function completeExport(
  prefix: string,
  ctx: { session: CommandContext["session"] },
): CommandCandidate[] {
  const words = splitArgs(prefix)
  const last = /\s$/.test(prefix) ? "" : (words.at(-1) ?? "")
  const before = words.slice(0, last ? -1 : undefined)
  const head = before.length ? `${before.join(" ")} ` : ""
  if (before.at(-1) === "--session" || before.at(-1) === "-s") {
    return ctx.session.sessions().map((s) => ({
      value: `${head}${s.id}`,
      description: s.firstUserText.slice(0, 60),
    }))
  }
  const out: CommandCandidate[] = []
  if (!before.some((w) => w === "md" || w === "html")) {
    out.push(
      { value: `${head}md`, description: "Markdown" },
      { value: `${head}html`, description: "self-contained HTML" },
    )
  }
  if (!before.includes("--session"))
    out.push({ value: `${head}--session `, description: "export a stored session" })
  return out
}
