import { DEFAULT_SERVERS, type ServerSpec } from "./servers.ts"

export type Severity = "error" | "warning" | "information" | "hint"

/** LSP's severity numbers by name. */
export const SEVERITY: Record<Severity, number> = { error: 1, warning: 2, information: 3, hint: 4 }
export const SEVERITY_NAME = ["", "error", "warning", "info", "hint"] as const

export interface LspSettings {
  enabled: boolean
  /** The least severe diagnostics fed back after edits. */
  severity: Severity
  /** Most diagnostic lines added to one result. */
  maxItems: number
  /** How long to wait for a server's diagnostics after an edit. */
  waitMs: number
  /** How long a server may take to start and initialize. */
  startupTimeoutMs: number
  /** How long `tsc --noEmit` (the fallback without a TypeScript server) may run. */
  tscTimeoutMs: number
  /** Tools whose successful calls get diagnostics for the file they wrote. */
  tools: string[]
  /** Server ids that are used; undefined means all. */
  languages: string[] | undefined
  servers: ServerSpec[]
  /** Problems found in the settings, reported once at load. */
  problems: string[]
}

export const DEFAULTS = {
  severity: "error" as Severity,
  maxItems: 20,
  waitMs: 4000,
  startupTimeoutMs: 20_000,
  tscTimeoutMs: 60_000,
  tools: ["edit", "write"],
}

/**
 * Reads `extensions.lsp`. Wrong values are reported and replaced by defaults, so a typo never
 * turns the extension off. A server entry replaces the built-in one with its id field by
 * field; an entry with a new id adds a server; `"enabled": false` drops one.
 */
export function readSettings(raw: unknown): LspSettings {
  const problems: string[] = []
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  if (raw !== undefined && (typeof raw !== "object" || raw === null))
    problems.push("extensions.lsp must be an object")

  const bool = (key: string, fallback: boolean) => {
    const v = s[key]
    if (v === undefined) return fallback
    if (typeof v === "boolean") return v
    problems.push(`extensions.lsp.${key} must be true or false`)
    return fallback
  }
  const num = (key: string, fallback: number, min: number) => {
    const v = s[key]
    if (v === undefined) return fallback
    if (typeof v === "number" && Number.isFinite(v) && v >= min) return v
    problems.push(`extensions.lsp.${key} must be a number of at least ${min}`)
    return fallback
  }
  const strings = (key: string): string[] | undefined => {
    const v = s[key]
    if (v === undefined) return undefined
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[]
    problems.push(`extensions.lsp.${key} must be a list of strings`)
    return undefined
  }

  let severity = DEFAULTS.severity
  if (s.severity !== undefined) {
    if (typeof s.severity === "string" && s.severity in SEVERITY) severity = s.severity as Severity
    else problems.push(`extensions.lsp.severity must be one of ${Object.keys(SEVERITY).join(", ")}`)
  }

  const servers = readServers(s.servers, problems)
  const languages = strings("languages")
  if (languages) {
    const known = new Set(servers.map((x) => x.id))
    for (const id of languages)
      if (!known.has(id)) problems.push(`extensions.lsp.languages: no server "${id}"`)
  }
  return {
    enabled: bool("enabled", true),
    severity,
    maxItems: Math.floor(num("maxItems", DEFAULTS.maxItems, 1)),
    waitMs: num("waitMs", DEFAULTS.waitMs, 0),
    startupTimeoutMs: num("startupTimeoutMs", DEFAULTS.startupTimeoutMs, 100),
    tscTimeoutMs: num("tscTimeoutMs", DEFAULTS.tscTimeoutMs, 100),
    tools: strings("tools") ?? DEFAULTS.tools,
    languages,
    servers: languages ? servers.filter((x) => languages.includes(x.id)) : servers,
    problems,
  }
}

function readServers(raw: unknown, problems: string[]): ServerSpec[] {
  const out = DEFAULT_SERVERS.map((s) => ({ ...s }))
  if (raw === undefined) return out
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("extensions.lsp.servers must be an object of servers by id")
    return out
  }
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const where = `extensions.lsp.servers.${id}`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} must be an object`)
      continue
    }
    const e = entry as Record<string, unknown>
    const index = out.findIndex((s) => s.id === id)
    if (e.enabled === false) {
      if (index >= 0) out.splice(index, 1)
      continue
    }
    const base: Partial<ServerSpec> = index >= 0 ? out[index]! : { id }
    const spec: Partial<ServerSpec> = { ...base }
    if (e.command !== undefined) {
      if (isStringList(e.command) && e.command.length) {
        spec.commands = [e.command]
        // A command of the user's own replaces the fallback too: they chose what runs.
        spec.tscFallback = false
      } else problems.push(`${where}.command must be a non-empty list of strings`)
    }
    if (e.extensions !== undefined) {
      if (isStringList(e.extensions)) {
        spec.extensions = e.extensions.map((x) => (x.startsWith(".") ? x : `.${x}`).toLowerCase())
      } else problems.push(`${where}.extensions must be a list of strings`)
    }
    if (e.rootMarkers !== undefined) {
      if (isStringList(e.rootMarkers)) spec.rootMarkers = e.rootMarkers
      else problems.push(`${where}.rootMarkers must be a list of strings`)
    }
    if (e.languageId !== undefined) {
      if (typeof e.languageId === "string") {
        spec.languageId = e.languageId
        spec.languageIds = {}
      } else problems.push(`${where}.languageId must be a string`)
    }
    if (e.settleMs !== undefined) {
      if (typeof e.settleMs === "number" && Number.isFinite(e.settleMs) && e.settleMs >= 0)
        spec.settleMs = e.settleMs
      else problems.push(`${where}.settleMs must be a number of at least 0`)
    }
    if (e.initializationOptions !== undefined) spec.initializationOptions = e.initializationOptions
    if (e.settings !== undefined) {
      if (e.settings && typeof e.settings === "object" && !Array.isArray(e.settings)) {
        spec.settings = e.settings as Record<string, unknown>
      } else problems.push(`${where}.settings must be an object`)
    }
    if (!spec.commands?.length || !spec.extensions?.length) {
      problems.push(`${where} needs "command" and "extensions"`)
      continue
    }
    const full: ServerSpec = {
      id,
      commands: spec.commands,
      extensions: spec.extensions,
      rootMarkers: spec.rootMarkers ?? [],
      languageId: spec.languageId ?? id,
      ...(spec.languageIds ? { languageIds: spec.languageIds } : {}),
      ...(spec.initializationOptions !== undefined
        ? { initializationOptions: spec.initializationOptions }
        : {}),
      ...(spec.settings ? { settings: spec.settings } : {}),
      ...(spec.tscFallback ? { tscFallback: true } : {}),
      ...(spec.settleMs !== undefined ? { settleMs: spec.settleMs } : {}),
    }
    // A user's server comes first, so it wins for extensions a built-in one claims too.
    if (index >= 0) out.splice(index, 1)
    out.unshift(full)
  }
  return out
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}
