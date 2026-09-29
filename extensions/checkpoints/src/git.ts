import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { RunCommandOptions, RunCommandResult } from "@amira/api"

/** ExtensionAPI.runCommand, or @amira/proc's runCommand in tests. */
export type Run = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

export interface GitResult {
  ok: boolean
  output: string
  code: number | null
}

export interface ExecOptions {
  /** Added to the environment (GIT_INDEX_FILE and the like). */
  env?: Record<string, string>
  signal?: AbortSignal
  /** Keep stderr out of output that is parsed. */
  stdoutOnly?: boolean
}

/** Variables that would point git somewhere else than where we mean. */
const INHERITED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_ATTR_SOURCE",
  "GIT_OBJECT_DIRECTORY",
]

const IDENTITY = {
  GIT_AUTHOR_NAME: "Amira checkpoints",
  GIT_AUTHOR_EMAIL: "amira@localhost",
  GIT_COMMITTER_NAME: "Amira checkpoints",
  GIT_COMMITTER_EMAIL: "amira@localhost",
}

/** Runs git through the host's runCommand, in one work tree, with fixed global options. */
export class Git {
  readonly #run: Run
  readonly #cwd: string
  readonly #timeoutMs: number
  #global: string[] = []

  constructor(run: Run, cwd: string, timeoutMs: number) {
    this.#run = run
    this.#cwd = cwd
    this.#timeoutMs = timeoutMs
  }

  /** Options every later call gets before its subcommand. */
  setGlobal(args: string[]): void {
    this.#global = args
  }

  async exec(args: string[], opts: ExecOptions = {}): Promise<GitResult> {
    const env: Record<string, string | undefined> = { ...process.env, ...IDENTITY }
    for (const k of INHERITED) delete env[k]
    Object.assign(env, opts.env)
    // Another Amira (or the user's git) may hold the index lock for a moment.
    for (let attempt = 0; ; attempt++) {
      const r = await this.#run(["git", ...this.#global, ...args], {
        cwd: this.#cwd,
        env,
        timeoutMs: this.#timeoutMs,
        signal: opts.signal ?? new AbortController().signal,
        viaCmd: true,
        ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
      })
      const result = { ok: r.exitCode === 0 && !r.timedOut && !r.aborted, output: r.output, code: r.exitCode }
      if (r.timedOut) result.output = `timed out after ${this.#timeoutMs} ms`
      if (r.aborted) result.output = "aborted"
      const lock = !result.ok && /Unable to create '([^']+\.lock)'/.exec(r.output)?.[1]
      if (lock && attempt < 8 && !opts.signal?.aborted) {
        // A git stopped in the middle (Amira exited, a snapshot timed out) leaves its lock
        // behind; one that old is nobody's. A live one goes away in a moment.
        if (ageMs(lock) > STALE_LOCK_MS) rmSync(lock, { force: true })
        else await Bun.sleep(100 + attempt * 100)
        continue
      }
      return result
    }
  }

  /** Like exec, but throws with git's message when it fails. */
  async must(args: string[], opts: ExecOptions = {}): Promise<string> {
    const r = await this.exec(args, opts)
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${firstLines(r.output) || `exit ${r.code}`}`)
    return r.output
  }
}

/** A lock file older than this is left over from a git that was stopped. */
export const STALE_LOCK_MS = 15_000

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export function firstLines(text: string, n = 3): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(" / ")
}

/** Splits -z output. */
export function zsplit(output: string): string[] {
  return output.split("\0").filter((s) => s.length > 0)
}

/** The first object id in git's output (stderr may come first). */
export function objectId(output: string): string | undefined {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/m.exec(output)?.[0]
}

/** Where a directory's checkpoints live: its own repository, or a shadow one. */
export interface Repo {
  mode: "git" | "shadow"
  /** The top of the work tree snapshots cover. */
  root: string
  /** The repository's own git directory (per worktree), or the shadow repository. */
  gitDir: string
  /** Our own index, never the user's. */
  index: string
  /** Scratch files: pathspec lists, temporary indexes. */
  scratch: string
  /** The user's index (git mode only). */
  userIndex?: string
  /** An empty tree, written to the repository. */
  emptyTree: string
  /** Line endings and filters are left alone (git 2.40 and newer). */
  raw: boolean
  git: Git
}

export type RepoResult = Repo | { disabled: string }

/** A short, stable name for a directory, as in ~/.amira/checkpoints/<name>. */
export function projectName(dir: string): string {
  const key = process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir)
  const base = path.basename(dir).replace(/[^\w.-]+/g, "_") || "root"
  return `${base}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`
}

/** Patterns a shadow repository never snapshots, on top of the directory's own .gitignore files. */
export const SHADOW_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".tox/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  ".gradle/",
  ".idea/",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
]

/**
 * Finds the repository `cwd` belongs to. Outside of one, a shadow repository under `home`
 * whose work tree is `cwd` (unless `shadow` is false).
 */
export async function openRepo(
  run: Run,
  opts: { cwd: string; home: string; shadow: boolean; timeoutMs: number },
): Promise<RepoResult> {
  const probe = new Git(run, opts.cwd, opts.timeoutMs)
  const version = await probe.exec(["--version"], { stdoutOnly: true })
  if (!version.ok) return { disabled: "git was not found; checkpoints need git" }
  const m = /(\d+)\.(\d+)/.exec(version.output)
  const raw = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40))

  const top = await probe.exec(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { stdoutOnly: true })
  let root: string
  let gitDir: string
  let mode: Repo["mode"]
  let userIndex: string | undefined
  const [topLine, dirLine] = top.output.split(/\r?\n/)
  if (top.ok && topLine && dirLine) {
    mode = "git"
    root = path.normalize(topLine.trim())
    gitDir = path.normalize(dirLine.trim())
    const idx = await probe.exec(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      stdoutOnly: true,
    })
    userIndex = idx.ok && idx.output.trim() ? path.normalize(idx.output.trim()) : path.join(gitDir, "index")
  } else {
    const inside = await probe.exec(["rev-parse", "--git-dir"], { stdoutOnly: true })
    if (inside.ok) return { disabled: "this directory is inside a git directory, not a work tree" }
    if (!opts.shadow) return { disabled: "not a git repository (extensions.checkpoints.nonGit is off)" }
    mode = "shadow"
    root = path.resolve(opts.cwd)
    gitDir = path.join(opts.home, "checkpoints", projectName(root), "git")
    if (!existsSync(path.join(gitDir, "HEAD"))) {
      mkdirSync(gitDir, { recursive: true })
      const init = await probe.exec(["init", "--bare", "--quiet", gitDir])
      if (!init.ok) return { disabled: `could not set up ${gitDir}: ${firstLines(init.output)}` }
      mkdirSync(path.join(gitDir, "info"), { recursive: true })
      writeFileSync(path.join(gitDir, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`)
    }
  }

  const scratch = path.join(gitDir, "amira-checkpoints")
  mkdirSync(scratch, { recursive: true })
  const noAttributes = path.join(scratch, "no-attributes")
  if (!existsSync(noAttributes)) writeFileSync(noAttributes, "")
  const git = new Git(run, root, opts.timeoutMs)
  const global = [
    ...(mode === "shadow" ? [`--git-dir=${gitDir}`, `--work-tree=${root}`] : []),
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.attributesFile=${noAttributes}`,
    "-c",
    "gc.auto=0",
  ]
  git.setGlobal(global)
  // An empty index file name gives an empty index: its tree is the empty tree, now stored.
  const empty = await git.exec(["write-tree"], { env: { GIT_INDEX_FILE: path.join(scratch, "empty.index") } })
  const emptyTree = objectId(empty.output)
  if (!empty.ok || !emptyTree) return { disabled: `git write-tree failed: ${firstLines(empty.output)}` }
  // Attributes read from an empty tree: no eol conversion or filters, so snapshots hold the
  // files byte for byte and restores write them back the same way.
  if (raw) git.setGlobal([...global, `--attr-source=${emptyTree}`])
  return {
    mode,
    root,
    gitDir,
    index: path.join(scratch, "index"),
    scratch,
    ...(userIndex ? { userIndex } : {}),
    emptyTree,
    raw,
    git,
  }
}
