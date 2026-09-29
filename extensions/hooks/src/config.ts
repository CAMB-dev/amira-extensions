import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { ShellKind } from "./shell.ts"

/** When a hook runs. */
export type HookEvent = "afterEdit" | "beforeTool" | "afterTurn" | "sessionStart" | "sessionEnd"

export const EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "beforeTool",
  "afterEdit",
  "afterTurn",
  "sessionEnd",
]

/** How /hooks and notices name an event. */
export const EVENT_LABEL: Record<HookEvent, string> = {
  sessionStart: "session start",
  beforeTool: "before tool",
  afterEdit: "after edit",
  afterTurn: "after turn",
  sessionEnd: "session end",
}

/** Whether a hook's output goes to the model along with the tool's result (after edit). */
export type Feedback = "onError" | "always" | "never"

export type TurnReason = "done" | "error" | "aborted"

/** Where a hook was configured: the user's own settings, or files that came with the project. */
export type Origin = "user" | "project"

/** One argument test of a before-tool hook: the argument's text must match `re`. */
export interface ArgMatch {
  arg: string
  re: RegExp
}

export interface Hook {
  event: HookEvent
  /** Shown in notices and /hooks: `name`, or the command's first word, or the rule's action. */
  name: string
  /** A shell command line; before-tool rules may have none. */
  command?: string
  shell: ShellKind
  timeoutMs: number
  /** Absolute; default the project directory. */
  cwd?: string
  env: Record<string, string>
  origin: Origin
  /** The file it came from. */
  file: string
  /** Tool names or globs (before tool, after edit). */
  tools: string[]
  /** File globs (after edit); empty for every file. */
  files: string[]
  feedback: Feedback
  /** Before tool: every entry must match. */
  match: ArgMatch[]
  /** Before tool: what a matching call gets without running anything. */
  action?: "block" | "ask"
  reason?: string
  /** After turn: which endings run it. */
  on: TurnReason[]
  /** After turn: only turns in which a file was edited or written. */
  onlyAfterEdits: boolean
  /** Session start: which starts run it. */
  reasons: string[]
}

export interface HookOptions {
  /** false turns every hook off. Only the user's settings can set it. */
  enabled: boolean
  /** Projects whose hooks run without asking; only the user's settings can list them. */
  trustedProjects: string[]
  /** Show a notice for hooks that went well too (failures are always shown). */
  showSuccess: boolean
  /** Characters of a hook's output kept for the model and for /hooks. */
  maxOutputChars: number
  /** Timeout of hooks that set none. */
  timeoutMs: number
}

export const DEFAULT_OPTIONS: HookOptions = {
  enabled: true,
  trustedProjects: [],
  showSuccess: true,
  maxOutputChars: 4000,
  timeoutMs: 60_000,
}

export const DEFAULT_EDIT_TOOLS = ["edit", "write"]
/** No hook may run longer than this. */
export const MAX_TIMEOUT_MS = 30 * 60_000

export interface LoadedHooks {
  options: HookOptions
  /** User hooks first, then project hooks, each in file order. */
  hooks: Hook[]
  /** Files that had hooks, by origin, for /hooks. */
  files: { user: string[]; project: string[] }
  /**
   * A fingerprint of every project hook source as it is now; trust is given to it, so a
   * project that changes its hooks is asked about again. Undefined without project hooks.
   */
  projectHash?: string
  /** Unreadable files and invalid entries. */
  problems: string[]
}

/** Where hooks are read from: the user's settings, then the project's files (D35 order). */
export function hookSources(cwd: string, home: string): { file: string; origin: Origin; whole: boolean }[] {
  const project = path.join(cwd, ".amira")
  return [
    { file: path.join(home, "settings.json"), origin: "user", whole: false },
    { file: path.join(project, "settings.json"), origin: "project", whole: false },
    { file: path.join(project, "settings.local.json"), origin: "project", whole: false },
    { file: path.join(project, "hooks.json"), origin: "project", whole: true },
  ]
}

/**
 * Reads every hook source. Settings files keep hooks under `extensions.hooks`; hooks.json holds
 * the same object at its top. Options (enabled, trustedProjects, ...) count only from the user's
 * settings: a project cannot switch hooks on for itself or trust itself.
 */
export function loadHooks(cwd: string, home: string, read: (file: string) => string = readText): LoadedHooks {
  const problems: string[] = []
  const hooks: Hook[] = []
  const files = { user: [] as string[], project: [] as string[] }
  let options = { ...DEFAULT_OPTIONS }
  const fingerprint: unknown[] = []
  const userFile = path.join(home, "settings.json")
  const sources = hookSources(cwd, home)
  // Run from the home directory, the user and project settings are the same file.
  const seen = new Set<string>()
  for (const src of sources) {
    const key = norm(src.file)
    if (seen.has(key)) continue
    seen.add(key)
    let text: string
    try {
      text = read(src.file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        problems.push(`${src.file}: cannot be read: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(text.replace(/^﻿/, ""))
    } catch (err) {
      problems.push(`${src.file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const section = src.whole
      ? json
      : (json as { extensions?: { hooks?: unknown } } | null)?.extensions?.hooks
    if (section === undefined || section === null) continue
    if (typeof section !== "object" || Array.isArray(section)) {
      problems.push(`${src.file}: ${src.whole ? "the file" : '"extensions.hooks"'} must be an object`)
      continue
    }
    const origin: Origin = norm(src.file) === norm(userFile) ? "user" : src.origin
    if (origin === "user") options = readOptions(section as Record<string, unknown>, src.file, problems)
    else {
      const ignored = Object.keys(section).filter((k) => OPTION_KEYS.has(k))
      if (ignored.length)
        problems.push(`${src.file}: ${ignored.join(", ")} only count in the user settings (ignored)`)
    }
    const parsed = parseHooks(section as Record<string, unknown>, {
      file: src.file,
      origin,
      cwd,
      defaultTimeoutMs: options.timeoutMs,
      problems,
    })
    if (origin === "project") {
      fingerprint.push({
        file: path.relative(cwd, src.file),
        hooks: pickEvents(section as Record<string, unknown>),
      })
    }
    if (parsed.length) files[origin].push(src.file)
    hooks.push(...parsed)
  }
  const out: LoadedHooks = { options, hooks, files, problems }
  if (hooks.some((h) => h.origin === "project")) {
    out.projectHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 32)
  }
  return out
}

function readText(file: string): string {
  return readFileSync(file, "utf8")
}

const OPTION_KEYS = new Set(["enabled", "trustedProjects", "showSuccess", "maxOutputChars", "timeoutMs"])

function pickEvents(section: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of EVENTS) if (section[e] !== undefined) out[e] = section[e]
  return out
}

function readOptions(section: Record<string, unknown>, file: string, problems: string[]): HookOptions {
  const o = { ...DEFAULT_OPTIONS }
  const bad = (key: string, what: string) => problems.push(`${file}: extensions.hooks.${key} must be ${what}`)
  if (section.enabled !== undefined) {
    if (typeof section.enabled === "boolean") o.enabled = section.enabled
    else bad("enabled", "true or false")
  }
  if (section.showSuccess !== undefined) {
    if (typeof section.showSuccess === "boolean") o.showSuccess = section.showSuccess
    else bad("showSuccess", "true or false")
  }
  if (section.trustedProjects !== undefined) {
    if (Array.isArray(section.trustedProjects) && section.trustedProjects.every((p) => typeof p === "string"))
      o.trustedProjects = section.trustedProjects as string[]
    else bad("trustedProjects", "a list of directories")
  }
  for (const key of ["maxOutputChars", "timeoutMs"] as const) {
    const v = section[key]
    if (v === undefined) continue
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) o[key] = Math.floor(v)
    else bad(key, "a positive number")
  }
  o.timeoutMs = Math.min(o.timeoutMs, MAX_TIMEOUT_MS)
  return o
}

interface ParseContext {
  file: string
  origin: Origin
  cwd: string
  defaultTimeoutMs: number
  problems: string[]
}

/** The hooks of one source's section; entries that do not fit are reported and skipped. */
export function parseHooks(section: Record<string, unknown>, ctx: ParseContext): Hook[] {
  const out: Hook[] = []
  for (const key of Object.keys(section)) {
    if (OPTION_KEYS.has(key) || (EVENTS as readonly string[]).includes(key)) continue
    ctx.problems.push(`${ctx.file}: unknown hooks key "${key}" (ignored)`)
  }
  for (const event of EVENTS) {
    const list = section[event]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      ctx.problems.push(`${ctx.file}: "${event}" must be a list of hooks`)
      continue
    }
    list.forEach((raw, i) => {
      const where = `${ctx.file}: ${event}[${i}]`
      const hook = parseHook(event, raw, ctx)
      if (typeof hook === "string") ctx.problems.push(`${where}: ${hook}`)
      else if (hook) out.push(hook)
    })
  }
  return out
}

const COMMON = ["name", "command", "shell", "timeoutMs", "cwd", "env", "disabled"]
const ALLOWED: Record<HookEvent, string[]> = {
  afterEdit: [...COMMON, "files", "tools", "feedback"],
  beforeTool: [...COMMON, "tools", "match", "ignoreCase", "action", "reason"],
  afterTurn: [...COMMON, "on", "onlyAfterEdits"],
  sessionStart: [...COMMON, "reasons"],
  sessionEnd: COMMON,
}

const strList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "")

/** A hook, undefined for a disabled one, or what is wrong with the entry. */
function parseHook(event: HookEvent, raw: unknown, ctx: ParseContext): Hook | string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must be an object"
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter((k) => !ALLOWED[event].includes(k))
  if (unknown.length)
    return `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}`
  if (r.disabled === true) return undefined
  if (r.command !== undefined && (typeof r.command !== "string" || !r.command.trim()))
    return '"command" must be a command line'
  const command = typeof r.command === "string" ? r.command.trim() : undefined
  if (r.name !== undefined && (typeof r.name !== "string" || !r.name.trim())) return '"name" must be text'
  if (r.shell !== undefined && r.shell !== "bash" && r.shell !== "powershell")
    return '"shell" must be "bash" or "powershell"'
  let timeoutMs = ctx.defaultTimeoutMs
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== "number" || !Number.isFinite(r.timeoutMs) || r.timeoutMs < 1)
      return '"timeoutMs" must be a positive number'
    timeoutMs = Math.min(Math.floor(r.timeoutMs), MAX_TIMEOUT_MS)
  }
  if (r.cwd !== undefined && (typeof r.cwd !== "string" || !r.cwd)) return '"cwd" must be a directory'
  const env: Record<string, string> = {}
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== "object" || Array.isArray(r.env)) return '"env" must be an object of texts'
    for (const [k, v] of Object.entries(r.env)) {
      if (typeof v !== "string") return `"env.${k}" must be text`
      env[k] = v
    }
  }
  const hook: Hook = {
    event,
    name: "",
    shell: r.shell === "powershell" ? "powershell" : "bash",
    timeoutMs,
    env,
    origin: ctx.origin,
    file: ctx.file,
    tools: [],
    files: [],
    feedback: "onError",
    match: [],
    on: ["done"],
    onlyAfterEdits: false,
    reasons: [],
  }
  if (command) hook.command = command
  if (typeof r.cwd === "string") hook.cwd = path.resolve(ctx.cwd, r.cwd)

  if (event === "afterEdit") {
    if (!command) return '"command" is required'
    if (r.files !== undefined && !strList(r.files)) return '"files" must be a list of globs'
    if (r.tools !== undefined && !strList(r.tools)) return '"tools" must be a list of tool names'
    if (r.feedback !== undefined && !["onError", "always", "never"].includes(r.feedback as string))
      return '"feedback" must be "onError", "always" or "never"'
    hook.files = (r.files as string[] | undefined) ?? []
    hook.tools = (r.tools as string[] | undefined) ?? DEFAULT_EDIT_TOOLS
    hook.feedback = (r.feedback as Feedback | undefined) ?? "onError"
  }
  if (event === "beforeTool") {
    if (r.tools !== undefined && !strList(r.tools)) return '"tools" must be a list of tool names'
    hook.tools = (r.tools as string[] | undefined) ?? ["*"]
    if (r.ignoreCase !== undefined && typeof r.ignoreCase !== "boolean")
      return '"ignoreCase" must be true or false'
    if (r.match !== undefined) {
      if (!r.match || typeof r.match !== "object" || Array.isArray(r.match))
        return '"match" must map argument names to regular expressions'
      for (const [arg, src] of Object.entries(r.match)) {
        if (typeof src !== "string") return `"match.${arg}" must be a regular expression`
        try {
          hook.match.push({ arg, re: new RegExp(src, r.ignoreCase ? "i" : "") })
        } catch (err) {
          return `"match.${arg}": ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
    if (r.action !== undefined && r.action !== "block" && r.action !== "ask")
      return '"action" must be "block" or "ask"'
    if (r.reason !== undefined && typeof r.reason !== "string") return '"reason" must be text'
    if (r.action && command) return 'use either "action" or "command", not both'
    if (!r.action && !command) return 'needs "action" ("block" or "ask") or a "command"'
    if (r.action) hook.action = r.action as "block" | "ask"
    if (typeof r.reason === "string" && r.reason.trim()) hook.reason = r.reason.trim()
  }
  if (event === "afterTurn") {
    if (!command) return '"command" is required'
    if (r.on !== undefined) {
      if (!strList(r.on) || !r.on.every((x) => ["done", "error", "aborted"].includes(x)))
        return '"on" must list "done", "error" or "aborted"'
      hook.on = r.on as TurnReason[]
    }
    if (r.onlyAfterEdits !== undefined && typeof r.onlyAfterEdits !== "boolean")
      return '"onlyAfterEdits" must be true or false'
    hook.onlyAfterEdits = r.onlyAfterEdits === true
  }
  if (event === "sessionStart") {
    if (!command) return '"command" is required'
    if (r.reasons !== undefined) {
      if (!strList(r.reasons) || !r.reasons.every((x) => ["startup", "resume", "clear", "fork"].includes(x)))
        return '"reasons" must list "startup", "resume", "clear" or "fork"'
      hook.reasons = r.reasons as string[]
    }
  }
  if (event === "sessionEnd" && !command) return '"command" is required'
  hook.name = typeof r.name === "string" ? r.name.trim() : defaultName(hook)
  return hook
}

/** The command's program name (without a path), or the rule's action. */
function defaultName(h: Hook): string {
  if (!h.command) return h.action ?? "rule"
  const first = h.command.split(/\s+/)[0] ?? h.command
  const program =
    first
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .pop() || first
  // `npx prettier ...` reads better as prettier.
  if (["npx", "bunx", "pnpx", "uvx", "pipx"].includes(program)) return h.command.split(/\s+/)[1] ?? program
  if (program === "bun" || program === "npm" || program === "pnpm" || program === "yarn")
    return h.command.split(/\s+/).slice(0, 2).join(" ")
  return program
}

/** Whether `cwd` is one of the directories or inside one. */
export function isListed(cwd: string, list: readonly string[]): boolean {
  const dir = norm(cwd)
  return list.some((entry) => {
    if (!entry) return false
    const root = norm(entry)
    return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

export function norm(p: string): string {
  const r = path.resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
}
