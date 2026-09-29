import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { RunCommandOptions, RunCommandResult } from "@amira/api"

/** ExtensionAPI.runCommand, or @amira/proc's runCommand in tests. */
export type Run = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

export interface GitResult {
  ok: boolean
  output: string
  code: number | null
  /** It ran out of time. */
  timedOut: boolean
}

/** A git command that ran out of time. */
export class GitTimeoutError extends Error {}

export interface ExecOptions {
  /** Added to the environment (GIT_INDEX_FILE and the like). */
  env?: Record<string, string>
  signal?: AbortSignal
  /** Keep stderr out of output that is parsed. */
  stdoutOnly?: boolean
  /** Instead of the timeout the Git was made with. */
  timeoutMs?: number
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
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_QUARANTINE_PATH",
  // Configuration given on the command line of a git that started Amira (git -c, a hook).
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
]

/** GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>, which go with GIT_CONFIG_COUNT. */
const INHERITED_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i

/** The environment git runs in: the process's, minus what would point it elsewhere. */
export function gitEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...IDENTITY }
  const drop = new Set(INHERITED)
  // Windows environment names are case-insensitive.
  for (const k of Object.keys(env)) {
    if (drop.has(k.toUpperCase()) || INHERITED_PATTERN.test(k)) delete env[k]
  }
  return env
}

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

  /** Where our own index files live: only locks there (and on our refs) are ever removed. */
  #own: string | undefined

  setOwnDir(dir: string): void {
    this.#own = path.resolve(dir).toLowerCase()
  }

  /**
   * Whether a lock git could not take was left by a git that is gone. Only locks of ours count:
   * on an index file of a process (`<pid>-...` in our directory) that is no longer running, or
   * of this process, whose git commands on its own files run one at a time (each has exited
   * before the next starts, so a lock found then was left by one that was stopped); and on a
   * checkpoint ref, which update-ref holds for a moment only, when it is old. Never one of the
   * user's, nor another live process's.
   */
  #isStale(lock: string): boolean {
    const p = path.resolve(lock).toLowerCase()
    if (this.#own && p.startsWith(this.#own + path.sep)) {
      const owner = lockOwner(p)
      return owner !== undefined && (owner === process.pid || !alive(owner))
    }
    return /[\\/]refs[\\/]amira[\\/]checkpoints[\\/]/.test(p) && ageMs(lock) > STALE_LOCK_MS
  }

  async exec(args: string[], opts: ExecOptions = {}): Promise<GitResult> {
    const env = gitEnv()
    Object.assign(env, opts.env)
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs
    // Another Amira (or the user's git) may hold the index lock for a moment.
    for (let attempt = 0; ; attempt++) {
      const r = await this.#run(["git", ...this.#global, ...args], {
        cwd: this.#cwd,
        env,
        timeoutMs,
        signal: opts.signal ?? new AbortController().signal,
        viaCmd: true,
        ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
      })
      const result: GitResult = {
        ok: r.exitCode === 0 && !r.timedOut && !r.aborted,
        output: r.output,
        code: r.exitCode,
        timedOut: r.timedOut,
      }
      if (r.timedOut) result.output = `timed out after ${timeoutMs} ms`
      if (r.aborted) result.output = "aborted"
      const lock = !result.ok && /Unable to create '([^']+\.lock)'/.exec(r.output)?.[1]
      if (lock && attempt < 8 && !opts.signal?.aborted) {
        // A git stopped in the middle (Amira exited, a snapshot timed out) leaves its lock
        // behind. A live one goes away in a moment; one that cannot be removed (Windows: still
        // open) counts as live.
        if (!(this.#isStale(lock) && removed(lock))) await Bun.sleep(100 + attempt * 100)
        continue
      }
      return result
    }
  }

  /** Like exec, but throws with git's message when it fails. */
  async must(args: string[], opts: ExecOptions = {}): Promise<string> {
    const r = await this.exec(args, opts)
    if (!r.ok) throw gitError(args[0] ?? "", r)
    return r.output
  }
}

/** The error for a git command that failed. */
export function gitError(command: string, r: GitResult): Error {
  const text = `git ${command} failed: ${firstLines(r.output) || `exit ${r.code}`}`
  return r.timedOut ? new GitTimeoutError(text) : new Error(text)
}

/** A lock on a checkpoint ref older than this is left over from a git that was stopped. */
export const STALE_LOCK_MS = 15_000

/** Whether a process is running (EPERM: it is, but not ours to signal). */
export function alive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The process a file of ours belongs to: `<pid>-index`, `<pid>-3-restore.index.lock`... */
export function lockOwner(file: string): number | undefined {
  const m = /^(\d+)-/.exec(path.basename(file))
  return m ? Number(m[1]) : undefined
}

/** Removes a file; false when it could not be (it is still open, say). */
function removed(file: string): boolean {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

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
  /** This process's own index, never the user's nor another process's. */
  index: string
  /** An index file that never exists: an empty index, for reading only. */
  noIndex: string
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
  // No hooks run for our commands (update-ref runs reference-transaction hooks).
  const noHooks = path.join(scratch, "no-hooks")
  mkdirSync(noHooks, { recursive: true })
  const git = new Git(run, root, opts.timeoutMs)
  git.setOwnDir(scratch)
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
    `core.hooksPath=${noHooks}`,
    "-c",
    "gc.auto=0",
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
  ]
  git.setGlobal(global)
  // The empty tree, stored (hashed from an empty file: no index, so no lock to wait on).
  const empty = await git.exec(["hash-object", "-t", "tree", "-w", noAttributes], { stdoutOnly: true })
  const emptyTree = objectId(empty.output)
  if (!empty.ok || !emptyTree) return { disabled: `git hash-object failed: ${firstLines(empty.output)}` }
  // Attributes read from an empty tree: no eol conversion or filters, so snapshots hold the
  // files byte for byte and restores write them back the same way.
  if (raw) git.setGlobal([...global, `--attr-source=${emptyTree}`])
  return {
    mode,
    root,
    gitDir,
    index: ownIndex(scratch),
    noIndex: path.join(scratch, "none.index"),
    scratch,
    ...(userIndex ? { userIndex } : {}),
    emptyTree,
    raw,
    git,
  }
}

/** The index the last process to exit left, for the next one to start from. */
const SHARED_INDEX = "index"
const leaveAtExit = new Set<string>()

/**
 * This process's own index, `<pid>-index`: every Amira in the repository has its own, so none
 * waits on (or breaks) another's lock. It starts as a copy of the newest index another process
 * left, so the first snapshot does not hash every file again, and at exit it is left for the
 * next one. Files of processes that are no longer running are removed.
 */
function ownIndex(scratch: string): string {
  const own = path.join(scratch, `${process.pid}-index`)
  let names: string[] = []
  try {
    names = readdirSync(scratch)
  } catch {}
  const seeds: { file: string; live: boolean; mtime: number }[] = []
  const dead: string[] = []
  for (const name of names) {
    const file = path.join(scratch, name)
    const owner = lockOwner(name)
    const live = owner === undefined || alive(owner)
    if (name === SHARED_INDEX || (owner !== undefined && owner !== process.pid && name === `${owner}-index`)) {
      try {
        seeds.push({ file, live: name !== SHARED_INDEX && live, mtime: statSync(file).mtimeMs })
      } catch {}
    }
    if (!live) dead.push(file)
  }
  if (!existsSync(own)) {
    // Rather an index nobody is writing to; then the newest.
    seeds.sort((a, b) => Number(a.live) - Number(b.live) || b.mtime - a.mtime)
    for (const seed of seeds) {
      try {
        copyFileSync(seed.file, own)
        break
      } catch {}
    }
  }
  for (const file of dead) removed(file)
  if (!leaveAtExit.has(own)) {
    leaveAtExit.add(own)
    process.once("exit", () => {
      try {
        renameSync(own, path.join(scratch, SHARED_INDEX))
      } catch {
        removed(own)
      }
    })
  }
  return own
}
