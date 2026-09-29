import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/** A language server this extension knows how to find and start. */
export interface ServerSpec {
  /** The name used in settings and /lsp, e.g. "typescript". */
  id: string
  /** File extensions it checks, with the dot, in lower case. */
  extensions: string[]
  /** Commands to try, in order; the first whose program is on PATH is used. */
  commands: string[][]
  /** Files or `*.ext` patterns that mark a project's root. */
  rootMarkers: string[]
  /** The LSP language id for an extension; `languageId` for any other. */
  languageIds?: Record<string, string>
  languageId: string
  initializationOptions?: unknown
  /** Sent with didChangeConfiguration and answered to workspace/configuration. */
  settings?: Record<string, unknown>
  /** Without a server: check TypeScript with `tsc --noEmit` instead. */
  tscFallback?: boolean
  /**
   * For a server that publishes diagnostics without a version: how long after its last
   * publish about a file to take that one as the answer (it may send another pass).
   * Default 200 ms.
   */
  settleMs?: number
}

export const DEFAULT_SERVERS: ServerSpec[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    commands: [["typescript-language-server", "--stdio"]],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageId: "typescript",
    languageIds: {
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
    tscFallback: true,
    // It publishes syntax errors first and type errors later, neither with a version.
    settleMs: 1200,
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    commands: [
      ["pyright-langserver", "--stdio"],
      ["basedpyright-langserver", "--stdio"],
    ],
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    languageId: "python",
  },
  {
    id: "rust",
    extensions: [".rs"],
    commands: [["rust-analyzer"]],
    rootMarkers: ["Cargo.toml"],
    languageId: "rust",
  },
  {
    id: "go",
    extensions: [".go"],
    commands: [["gopls"]],
    rootMarkers: ["go.work", "go.mod"],
    languageId: "go",
  },
  {
    id: "csharp",
    extensions: [".cs"],
    commands: [["csharp-ls"], ["OmniSharp", "-lsp"], ["omnisharp", "-lsp"]],
    rootMarkers: ["*.sln", "*.slnx", "*.csproj"],
    languageId: "csharp",
  },
]

export function languageIdFor(spec: ServerSpec, file: string): string {
  return spec.languageIds?.[path.extname(file).toLowerCase()] ?? spec.languageId
}

export function serverFor(specs: readonly ServerSpec[], file: string): ServerSpec | undefined {
  const ext = path.extname(file).toLowerCase()
  if (!ext) return undefined
  return specs.find((s) => s.extensions.includes(ext))
}

/** Looks a program up on PATH (on Windows with PATHEXT, so `.cmd` launchers count). */
export type Which = (program: string) => string | null

export const which: Which = (program) => Bun.which(program)

/**
 * The command to start `spec` with: the first candidate installed, its program replaced by
 * the full path found (so a `.cmd` launcher on Windows starts). Undefined when none is.
 */
export function findCommand(spec: ServerSpec, find: Which = which): string[] | undefined {
  for (const argv of spec.commands) {
    const [program, ...rest] = argv
    if (!program) continue
    const found = path.isAbsolute(program) ? (existsSync(program) ? program : null) : find(program)
    if (found) return [found, ...rest]
  }
  return undefined
}

/**
 * The folder a server is started for when checking `file`: the topmost folder with one of
 * the spec's root markers between the file and the working directory (so one server serves a
 * monorepo), or the nearest one when the file is outside the working directory. Without any
 * marker, the working directory (or, outside it, the file's own folder).
 */
export function findRoot(file: string, cwd: string, markers: readonly string[]): string {
  const inside = isInside(file, cwd)
  let dir = path.dirname(path.resolve(file))
  let found: string | undefined
  for (;;) {
    if (hasMarker(dir, markers)) {
      found = dir
      if (!inside) return dir
    }
    if (inside && samePath(dir, cwd)) break
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return found ?? (inside ? path.resolve(cwd) : path.dirname(path.resolve(file)))
}

function hasMarker(dir: string, markers: readonly string[]): boolean {
  for (const marker of markers) {
    if (marker.startsWith("*.")) {
      const ext = marker.slice(1).toLowerCase()
      try {
        if (readdirSync(dir).some((name) => name.toLowerCase().endsWith(ext))) return true
      } catch {}
    } else if (existsSync(path.join(dir, marker))) return true
  }
  return false
}

export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p)
    return process.platform === "win32" ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
