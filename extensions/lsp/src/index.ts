import path from "node:path"
import type {
  Extension,
  ExtensionAPI,
  InterceptorMap,
  StatusTone,
  ToolDefinition,
  ToolLine,
  ToolPresenter,
  ToolResult,
} from "@amira/api"
import { textResult } from "@amira/api"
import type { Diagnostic } from "./client.ts"
import {
  type Counts,
  countOf,
  countsInText,
  describeCounts,
  diagnosticLine,
  displayPath,
  type FileReport,
  filterSorted,
  formatReports,
  HEADER,
  plural,
} from "./format.ts"
import { checkBudgetMs, type FileCheck, type ServerDescription, ServerManager } from "./manager.ts"
import { isFile, which as pathWhich, type Which } from "./servers.ts"
import { type LspSettings, readSettings, SEVERITY, type Severity } from "./settings.ts"
import { fileKey } from "./uri.ts"

export { LspClient } from "./client.ts"
export * from "./format.ts"
export { ServerManager } from "./manager.ts"
export * from "./servers.ts"
export { readSettings } from "./settings.ts"
export { parseTscOutput } from "./tsc.ts"
export * from "./uri.ts"

export const DIAGNOSTICS_TOOL = "diagnostics"
/** Diagnostic lines the diagnostics tool returns at most. */
const TOOL_MAX_ITEMS = 100
/** Diagnostic lines under an edit in the transcript's summary view. */
const SUMMARY_LINES = 3
/** tool.call.after priority: late, so formatters (default 0) have changed the file first. */
export const LSP_PRIORITY = 100

export interface LspExtensionOptions {
  /** Looks programs up on PATH; tests pass their own. */
  which?: Which
}

interface Touched {
  file: string
}

export interface DiagnosticsDetails {
  path: string
  source?: string
  counts?: Counts
}

/** The diagnostics block a result carries (see formatReports), if any. */
export function lspBlock(result: ToolResult): string | undefined {
  for (const b of result.content) if (b.type === "text" && b.text.startsWith(HEADER)) return b.text
  return undefined
}

/** The block's diagnostic lines as presenter lines. */
function blockLines(block: string): ToolLine[] {
  return block
    .split("\n")
    .slice(1)
    .map((text) => {
      const kind = / error /.test(text) ? "error" : / warning /.test(text) ? "warning" : "muted"
      return { kind, text }
    })
}

/** A presenter that adds the diagnostics a result carries to the one below it. */
export function withDiagnostics(below: ToolPresenter | undefined): ToolPresenter {
  return {
    ...below,
    result(call) {
      const base = below?.result ? below.result(call) : undefined
      const block = lspBlock(call.result)
      if (!block || base === undefined) return base
      return `${base} · ${describeCounts(countsInText(block)).replace("no problems", "problems fixed")}`
    },
    body(call, opts) {
      const base = below?.body ? below.body(call, opts) : []
      const block = lspBlock(call.result)
      if (!block) return base
      let lines = blockLines(block)
      if (opts.detail === "summary" && lines.length > SUMMARY_LINES) {
        const rest = lines.length - SUMMARY_LINES
        lines = [...lines.slice(0, SUMMARY_LINES), { kind: "muted", text: `… ${plural(rest, "more line")}` }]
      }
      return [...lines, ...base]
    },
  }
}

const diagnosticsPresenter: ToolPresenter<{ path?: string }, DiagnosticsDetails> = {
  summary: (args) => String(args.path ?? ""),
  result(call) {
    if (call.result.isError) return undefined
    const counts = call.result.details?.counts
    return counts ? describeCounts(counts) : undefined
  },
  body(call) {
    if (call.result.isError) return []
    const block = lspBlock(call.result)
    return block ? blockLines(block) : []
  },
}

/** The file a successful edit or write changed: the absolute path in its details, else its `path` argument. */
export function editedFile(
  v: Pick<InterceptorMap["tool.call.after"], "args" | "cwd" | "result">,
): string | undefined {
  const details = v.result.details as { path?: unknown } | undefined
  if (typeof details?.path === "string" && path.isAbsolute(details.path)) return details.path
  const arg = v.args.path ?? v.args.file_path
  return typeof arg === "string" && arg ? path.resolve(v.cwd, arg) : undefined
}

export function createLspExtension(options: LspExtensionOptions = {}): Extension {
  return (api: ExtensionAPI) => {
    const settings = readSettings(api.settings.extensions?.lsp)
    for (const problem of settings.problems) api.reportError(`lsp: ${problem}`)
    if (!settings.enabled) return
    if (typeof api.openPipe !== "function" || typeof api.decorateToolRenderer !== "function") {
      api.reportError("lsp: this Amira is too old for the lsp extension (it needs ExtensionAPI.openPipe)")
      return
    }
    setUp(api, settings, options.which ?? pathWhich)
  }
}

function setUp(api: ExtensionAPI, settings: LspSettings, which: Which) {
  const threshold = SEVERITY[settings.severity]
  const tools = new Set(settings.tools)
  let checking = 0
  /** The last diagnostics each checked file had, by fileKey. */
  const known = new Map<string, { file: string; diagnostics: Diagnostic[] }>()
  /** Files each session changed in the current batch of tool calls, not checked yet. */
  const touched = new Map<string, Map<string, Touched>>()

  const manager = new ServerManager(settings, {
    openPipe: (argv, opts) => api.openPipe(argv, opts),
    runCommand: (argv, opts) => api.runCommand(argv, opts),
    which,
    reportError: (message) => api.reportError(message),
    onChange: () => api.requestRender(),
  })

  /** Records fresh results; returns the reports to show, with files whose problems are gone marked. */
  const record = (checks: FileCheck[], limit: number): FileReport[] => {
    const reports: FileReport[] = []
    for (const c of checks) {
      if (!c.fresh) continue
      const key = fileKey(c.file)
      const before = known.get(key)
      const had = before ? filterSorted(before.diagnostics, limit).length > 0 : false
      known.set(key, { file: c.file, diagnostics: c.diagnostics })
      reports.push({ file: c.file, diagnostics: c.diagnostics, ...(had ? { cleared: true } : {}) })
    }
    return reports
  }

  const totals = (): Counts => {
    const all: Diagnostic[] = []
    for (const k of known.values()) all.push(...filterSorted(k.diagnostics, threshold))
    return countOf(all)
  }

  let tone: StatusTone = "muted"
  api.registerStatusItem({
    id: "lsp",
    align: "right",
    order: 5,
    get tone() {
      return tone
    },
    text() {
      if (checking > 0) {
        tone = "muted"
        return "lsp …"
      }
      if (!manager.running && !known.size) return undefined
      const c = totals()
      tone = c.errors ? "error" : c.warnings ? "warning" : "muted"
      return c.errors || c.warnings || c.other ? `lsp ${describeCounts(c)}` : "lsp ✓"
    },
  })

  const check = async (files: string[], cwd: string, signal: AbortSignal, waitMs?: number) => {
    checking++
    api.requestRender()
    try {
      const checks = await manager.check(files, cwd, signal, waitMs)
      // Files that are gone take their old problems with them.
      for (const file of files) if (!isFile(file)) known.delete(fileKey(file))
      return checks
    } finally {
      checking--
      api.requestRender()
    }
  }

  // After the last edit of a batch, check every file the batch changed and add what the
  // servers found to that call's result.
  // A check keeps to its budget; the margin covers syncing files and formatting the report.
  const timeoutMs = checkBudgetMs(settings) + 5000
  api.intercept(
    "tool.call.after",
    async (v, ctx) => {
      if (!tools.has(v.name)) return { action: "pass" }
      let mine = touched.get(ctx.sessionId)
      if (!v.rejected && !v.result.isError) {
        const file = editedFile(v)
        if (file && manager.specFor(file)) {
          mine ??= new Map()
          touched.set(ctx.sessionId, mine)
          mine.set(fileKey(file), { file })
        }
      }
      // A later edit in the same batch reports for all of them.
      if (v.pending.some((p) => tools.has(p.name))) return { action: "pass" }
      if (!mine?.size) return { action: "pass" }
      touched.delete(ctx.sessionId)
      const files = [...mine.values()].map((t) => t.file)
      const checks = await check(files, v.cwd, ctx.signal)
      const text = formatReports(record(checks, threshold), {
        cwd: v.cwd,
        threshold,
        maxItems: settings.maxItems,
      })
      if (!text) return { action: "pass" }
      const result: ToolResult = { ...v.result, content: [...v.result.content, { type: "text", text }] }
      return { action: "modify", value: { ...v, result } }
    },
    // After handlers that change the file (e.g. a formatter hook), so the check sees the result.
    { timeoutMs, priority: LSP_PRIORITY },
  )

  const tool: ToolDefinition<{ path: string; severity?: Severity }> = {
    name: DIAGNOSTICS_TOOL,
    description: [
      "Errors and warnings a language server reports for one file (TypeScript/JavaScript, Python, Rust, Go, C#, as installed).",
      "Edits and writes already get the new errors back in their result; use this to check a file you did not just change, or to see warnings.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or path relative to the working directory" },
        severity: {
          type: "string",
          enum: ["error", "warning", "information", "hint"],
          description: 'The least severe to list. Default "warning".',
        },
      },
      required: ["path"],
    },
    concurrency: "parallel",
    async execute(params, ctx) {
      if (typeof params.path !== "string" || !params.path) return textResult("path is required", true)
      const file = path.resolve(ctx.cwd, params.path)
      const shown = displayPath(file, ctx.cwd)
      if (!isFile(file)) {
        if (known.delete(fileKey(file))) api.requestRender()
        return textResult(`${shown} is not a file`, true)
      }
      const spec = manager.specFor(file)
      if (!spec) {
        return textResult(
          `No language server is set up for ${path.extname(file) || "files like"} ${shown}.`,
          true,
        )
      }
      const level = SEVERITY[params.severity && params.severity in SEVERITY ? params.severity : "warning"]
      const checks = await check([file], ctx.cwd, ctx.signal)
      const c = checks[0]
      if (!c) {
        const commands = spec.commands.map((argv) => argv[0]).join(" or ")
        return textResult(
          `No ${spec.id} language server is installed (looked for ${commands} on PATH).`,
          true,
        )
      }
      if (!c.fresh) {
        return textResult(
          `The ${c.source} server did not report on ${shown} in time; try again shortly.`,
          true,
        )
      }
      record(checks, threshold)
      const counts = countOf(filterSorted(c.diagnostics, level))
      const text =
        formatReports([{ file, diagnostics: c.diagnostics }], {
          cwd: ctx.cwd,
          threshold: level,
          maxItems: TOOL_MAX_ITEMS,
        }) ?? `No problems in ${shown} (${c.source}).`
      const details: DiagnosticsDetails = { path: file, source: c.source, counts }
      return { content: [{ type: "text", text }], details }
    },
  }
  api.registerTool(tool)
  api.registerToolRenderer(DIAGNOSTICS_TOOL, diagnosticsPresenter)
  for (const name of tools) api.decorateToolRenderer(name, withDiagnostics)

  api.registerCommand({
    name: "lsp",
    description: "Language servers: which run, which are missing; /lsp restart stops them all",
    args: {
      hint: "[restart]",
      complete: () => [{ value: "restart", description: "Stop every server; they start again when needed" }],
    },
    async run(args, ctx) {
      if (args === "restart") {
        await manager.restart()
        known.clear()
        ctx.print("Language servers stopped; they start again with the next edit.")
        return
      }
      if (args) throw new Error(`unknown argument "${args}" (try /lsp or /lsp restart)`)
      ctx.print(describe(manager.describe(), known, ctx.cwd, threshold))
    },
  })

  api.on("session.end", () => {
    void manager.stopAll()
  })
}

/** The text /lsp prints. */
export function describe(
  servers: ServerDescription[],
  known: Map<string, { file: string; diagnostics: Diagnostic[] }>,
  cwd: string,
  threshold: number,
): string {
  const width = Math.max(...servers.map((s) => s.id.length), 4)
  const lines = ["Language servers:"]
  for (const s of servers) {
    const head = `  ${s.id.padEnd(width)}  `
    const pad = " ".repeat(head.length)
    const program = (argv0: string) => path.basename(argv0).replace(/\.(exe|cmd|bat)$/i, "")
    if (s.running.length) {
      for (const [i, r] of s.running.entries()) {
        const state = r.state === "ready" ? "running" : r.state
        const root = path.relative(cwd, r.root) === "" ? "." : displayPath(r.root, cwd)
        const name = r.serverInfo ?? program(r.program)
        lines.push(`${i ? pad : head}${state} · ${name} · ${root} · ${plural(r.files, "file")} open`)
      }
    } else if (s.command) {
      lines.push(
        `${head}installed: ${program(s.command[0] ?? "")} (starts with the first ${s.extensions[0]} file)`,
      )
    } else if (s.fallback)
      lines.push(
        `${head}no server installed; falls back to ${s.fallback} (the project's tsc, else one on PATH)`,
      )
    else lines.push(`${head}not installed`)
    for (const f of s.failed) lines.push(`${pad}failed: ${f}`)
  }
  const problems = [...known.values()]
    .map((k) => ({ file: k.file, list: filterSorted(k.diagnostics, threshold) }))
    .filter((k) => k.list.length)
  if (problems.length) {
    lines.push("", "Problems in files checked:")
    for (const p of problems) {
      lines.push(`  ${displayPath(p.file, cwd)}: ${describeCounts(countOf(p.list))}`)
      for (const d of p.list.slice(0, 3)) lines.push(`    ${diagnosticLine(d, displayPath(p.file, cwd))}`)
    }
  }
  return lines.join("\n")
}

export default createLspExtension()
