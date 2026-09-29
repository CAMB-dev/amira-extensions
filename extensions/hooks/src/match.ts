import path from "node:path"
import type { Hook } from "./config.ts"

const globs = new Map<string, Bun.Glob>()
const glob = (pattern: string) => {
  let g = globs.get(pattern)
  if (!g) {
    g = new Bun.Glob(pattern)
    globs.set(pattern, g)
  }
  return g
}

/** Whether a tool name is one of `patterns`: names, or globs such as "*" or "mcp_*". */
export function toolMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => p === name || (/[*?[{]/.test(p) && glob(p).match(name)))
}

/**
 * Whether a file is one of `patterns` (all files when there are none). Globs are matched against
 * the path relative to the project, with forward slashes; a glob without a slash, such as
 * "*.ts", matches the file's name in any directory. Files outside the project are matched by
 * their absolute path.
 */
export function fileMatches(patterns: readonly string[], file: string, projectDir: string): boolean {
  if (!patterns.length) return true
  const rel = path.relative(projectDir, file)
  const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  const target = (inside ? rel : file).replaceAll("\\", "/")
  const base = path.basename(file)
  return patterns.some((p) => {
    const pattern = p.replaceAll("\\", "/").replace(/^\.\//, "")
    if (!pattern.includes("/")) return glob(pattern).match(base)
    return glob(pattern).match(target)
  })
}

/** An argument as the text its regular expressions test: strings as they are, the rest as JSON. */
function argText(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Whether a before-tool hook applies to this call: its tools, and every `match` entry. */
export function callMatches(hook: Hook, name: string, args: Readonly<Record<string, unknown>>): boolean {
  if (!toolMatches(hook.tools, name)) return false
  return hook.match.every((m) => {
    const text = argText(m.arg === "*" ? args : args[m.arg])
    return text !== undefined && m.re.test(text)
  })
}

/**
 * The file a finished edit or write changed: the absolute path its details carry, or its `path`
 * argument (`file_path` for tools shaped like Claude Code's) resolved against the project.
 */
export function editedFile(
  args: Readonly<Record<string, unknown>>,
  details: unknown,
  projectDir: string,
): string | undefined {
  const fromDetails = (details as { path?: unknown } | undefined)?.path
  if (typeof fromDetails === "string" && path.isAbsolute(fromDetails)) return fromDetails
  const arg =
    typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : ""
  return arg ? path.resolve(projectDir, arg) : undefined
}
