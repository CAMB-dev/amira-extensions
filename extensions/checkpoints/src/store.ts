import { lstatSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { firstLines, type Repo, zsplit } from "./git.ts"

/** Where every checkpoint ref lives: refs/amira/checkpoints/<session>/<n>. */
export const REF_PREFIX = "refs/amira/checkpoints/"

/** What a checkpoint was taken before. */
export type CheckpointKind = "turn" | "tool" | "restore"

/** What a checkpoint records about itself, in its commit message. */
export interface CheckpointMeta {
  v: 1
  kind: CheckpointKind
  /** When it was taken, in ms since the epoch. */
  ts: number
  /** The session's turn it was taken before (kind "turn"; "tool" ones carry their turn's). */
  turn?: number
  turnId?: string
  /** The message that started the turn, clipped. */
  prompt?: string
  /** The turn was started by a notice (e.g. background sub-agents' results), not by the user. */
  notice?: boolean
  /** The tool call it was taken before (kind "tool"). */
  tool?: string
  /** A few words on why (kind "restore": which checkpoint was restored). */
  note?: string
  /** Files changed since the session's previous checkpoint (the first few). */
  changed: string[]
  /** How many files that is; -1 for the session's first checkpoint. */
  changedCount: number
}

export interface Checkpoint {
  session: string
  n: number
  ref: string
  commit: string
  tree: string
  meta: CheckpointMeta
}

export interface StoreLimits {
  /** Files the user does not track that are larger are left out. */
  maxFileBytes: number
  /** With more untracked files than this, none of them is snapshotted (or, outside a repository, nothing is). */
  maxUntrackedFiles: number
  /** Untracked files together; the largest are left out until they fit. */
  maxUntrackedBytes: number
}

export const DEFAULT_STORE_LIMITS: StoreLimits = {
  maxFileBytes: 5_000_000,
  maxUntrackedFiles: 2000,
  maxUntrackedBytes: 200_000_000,
}

/** What a snapshot of the work tree left out. */
export interface Skipped {
  /** Untracked files over maxFileBytes, or left out to stay under maxUntrackedBytes. */
  large: string[]
  /** Untracked files not snapshotted because there were more than maxUntrackedFiles. */
  untracked: number
}

export interface Scan {
  tree: string
  skipped: Skipped
}

/** One file that differs between two trees (raw diff-tree). */
export interface Change {
  path: string
  /** A added, D deleted, M modified, T type changed. */
  status: string
  oldMode: string
  newMode: string
}

/** Checkpoints are off here, for a reason worth telling the user once. */
export class DisabledError extends Error {}

const MAX_CHANGED = 50
/** Scratch file names, unique in the process (stores of one repository share its directory). */
let tmpCount = 0
const GITLINK = "160000"

/**
 * Snapshots of one work tree as commits under private refs, made with an index of our own, so
 * the user's branch, index and stash are never touched. Untracked files are included (minus
 * what .gitignore ignores); line endings are kept byte for byte.
 */
export class CheckpointStore {
  readonly repo: Repo
  readonly limits: StoreLimits
  #queue: Promise<unknown> = Promise.resolve()
  /** Next number per session, once known. */
  #next = new Map<string, number>()
  /** The latest checkpoint per session, once known. */
  #last = new Map<string, Checkpoint | null>()
  /** Checkpoints per session, once known, so pruning lists them only when there are too many. */
  #count = new Map<string, number>()
  /** The ignore files as the last scan saw them; our index is checked for ignored files when they change. */
  #rules: string | undefined

  constructor(repo: Repo, limits: Partial<StoreLimits> = {}) {
    this.repo = repo
    this.limits = { ...DEFAULT_STORE_LIMITS, ...limits }
  }

  /** Runs one operation at a time: they share our index. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    this.#queue = run.catch(() => {})
    return run
  }

  #scratchFile(name: string): string {
    return path.join(this.repo.scratch, `${process.pid}-${++tmpCount}-${name}`)
  }

  /** Writes the work tree to the object store and returns its tree, without a checkpoint. */
  scan(signal?: AbortSignal): Promise<Scan> {
    return this.#locked(() => this.#scan(signal))
  }

  async #scan(signal?: AbortSignal): Promise<Scan> {
    const { git, root, mode } = this.repo
    const ours = { GIT_INDEX_FILE: this.repo.index }
    const sig = signal ? { signal } : {}
    // One listing: what the user tracks (tagged by -t) and what they neither track nor ignore.
    // Outside a repository nothing is tracked: every file not ignored counts as untracked.
    const listing = zsplit(
      await git.must(["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"], {
        stdoutOnly: true,
        ...sig,
        ...(mode === "shadow"
          ? { env: { GIT_INDEX_FILE: this.repo.noIndex } }
          : {}),
      }),
    )
    const tracked = new Set<string>()
    const untracked: string[] = []
    for (const entry of listing) {
      const p = entry.slice(2)
      if (entry.startsWith("? ")) untracked.push(p)
      else tracked.add(p)
    }
    // Files in our index that are ignored by now (and not tracked by the user); only looked
    // for when the ignore rules may have changed.
    const rules = [
      ...listing.map((e) => e.slice(2)).filter(isIgnoreFile),
      path.join(this.repo.gitDir, "info", "exclude"),
    ]
      .map((p) => `${p}:${stamp(path.resolve(root, p))}`)
      .join("\n")
    let ignored: string[] = []
    if (rules !== this.#rules) {
      ignored = zsplit(
        await git.must(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], {
          stdoutOnly: true,
          env: ours,
          ...sig,
        }),
      ).filter((p) => !tracked.has(p))
    }

    const skipped: Skipped = { large: [], untracked: 0 }
    let exclude: string[] = []
    if (untracked.length > this.limits.maxUntrackedFiles) {
      if (mode === "shadow") {
        throw new DisabledError(
          `${root} holds ${untracked.length} files (more than maxUntrackedFiles, ${this.limits.maxUntrackedFiles}) and is not a git repository, so checkpoints are off here`,
        )
      }
      skipped.untracked = untracked.length
      exclude = collapse(untracked, tracked)
    } else {
      const sized: { p: string; size: number }[] = []
      for (const p of untracked) {
        let size = 0
        try {
          const st = lstatSync(path.join(root, p))
          size = st.isFile() ? st.size : 0
        } catch {
          continue
        }
        if (size > this.limits.maxFileBytes) skipped.large.push(p)
        else sized.push({ p, size })
      }
      let total = sized.reduce((s, f) => s + f.size, 0)
      sized.sort((a, b) => b.size - a.size)
      for (const f of sized) {
        if (total <= this.limits.maxUntrackedBytes) break
        skipped.large.push(f.p)
        total -= f.size
      }
      exclude = skipped.large
    }

    const remove = [...ignored, ...exclude]
    if (remove.length) {
      const list = this.#scratchFile("remove")
      writeFileSync(list, `${remove.join("\0")}\0`)
      try {
        await git.must(
          [
            "rm",
            "--cached",
            "-r",
            "-q",
            "-f",
            "--ignore-unmatch",
            `--pathspec-from-file=${list}`,
            "--pathspec-file-nul",
          ],
          { env: { ...ours, GIT_LITERAL_PATHSPECS: "1" }, ...sig },
        )
      } finally {
        rmSync(list, { force: true })
      }
    }
    let add: string[] = ["add", "-A", "--ignore-errors"]
    let list: string | undefined
    if (exclude.length) {
      list = this.#scratchFile("add")
      const specs = [":/", ...exclude.map((p) => `:(top,literal,exclude)${p}`)]
      writeFileSync(list, `${specs.join("\0")}\0`)
      add = [...add, `--pathspec-from-file=${list}`, "--pathspec-file-nul"]
    }
    try {
      const r = await git.exec(add, { env: ours, ...sig })
      // --ignore-errors: unreadable files are left out, the rest is added; anything else fails.
      if (!r.ok && !/unable to index file|Permission denied|could not open/i.test(r.output)) {
        throw new Error(`git add failed: ${firstLines(r.output) || `exit ${r.code}`}`)
      }
    } finally {
      if (list) rmSync(list, { force: true })
    }
    const tree = (await git.must(["write-tree"], { env: ours, stdoutOnly: true, ...sig })).trim()
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git write-tree gave no tree: ${firstLines(tree)}`)
    this.#rules = rules
    return { tree, skipped }
  }

  /**
   * Takes a checkpoint of the work tree for `session`. With `skipUnchanged`, returns undefined
   * instead when nothing changed since the session's previous checkpoint.
   */
  create(
    session: string,
    meta: Omit<CheckpointMeta, "v" | "ts" | "changed" | "changedCount">,
    opts: { signal?: AbortSignal; skipUnchanged?: boolean; keep?: number } = {},
  ): Promise<{ checkpoint?: Checkpoint; skipped: Skipped }> {
    return this.#locked(async () => {
      const scan = await this.#scan(opts.signal)
      const prev = await this.#latest(session)
      if (opts.skipUnchanged && prev?.tree === scan.tree) return { skipped: scan.skipped }
      const checkpoint = await this.#commit(session, scan.tree, prev, meta, opts.signal)
      if (opts.keep) await this.#prune(session, opts.keep)
      return { checkpoint, skipped: scan.skipped }
    })
  }

  async #commit(
    session: string,
    tree: string,
    prev: Checkpoint | undefined,
    partial: Omit<CheckpointMeta, "v" | "ts" | "changed" | "changedCount">,
    signal?: AbortSignal,
  ): Promise<Checkpoint> {
    const { git } = this.repo
    const sig = signal ? { signal } : {}
    let changed: string[] = []
    let changedCount = -1
    if (prev) {
      const names = prev.tree === tree ? [] : await this.#names(prev.tree, tree, [], signal)
      changedCount = names.length
      changed = names.slice(0, MAX_CHANGED)
    }
    const meta: CheckpointMeta = { v: 1, ...partial, ts: Date.now(), changed, changedCount }
    const msgFile = this.#scratchFile("message")
    writeFileSync(msgFile, `amira checkpoint ${JSON.stringify(meta)}\n`)
    let commit: string
    try {
      commit = (
        await git.must(["commit-tree", "--no-gpg-sign", "-F", msgFile, tree], { stdoutOnly: true, ...sig })
      ).trim()
    } finally {
      rmSync(msgFile, { force: true })
    }
    const n = await this.#nextNumber(session)
    const ref = `${REF_PREFIX}${session}/${n}`
    await git.must(["update-ref", "--no-deref", ref, commit], sig)
    this.#next.set(session, n + 1)
    const count = this.#count.get(session)
    if (count !== undefined) this.#count.set(session, count + 1)
    const checkpoint: Checkpoint = { session, n, ref, commit, tree, meta }
    this.#last.set(session, checkpoint)
    return checkpoint
  }

  async #nextNumber(session: string): Promise<number> {
    const known = this.#next.get(session)
    if (known !== undefined) return known
    const all = await this.#list(session)
    return (all.at(-1)?.n ?? 0) + 1
  }

  async #latest(session: string): Promise<Checkpoint | undefined> {
    if (!this.#last.has(session)) this.#last.set(session, (await this.#list(session)).at(-1) ?? null)
    return this.#last.get(session) ?? undefined
  }

  /** A session's checkpoints, oldest first; without a session, every session's. */
  list(session?: string): Promise<Checkpoint[]> {
    return this.#locked(() => this.#list(session))
  }

  async #list(session?: string): Promise<Checkpoint[]> {
    const prefix = session ? `${REF_PREFIX}${session}/` : REF_PREFIX
    const out = await this.repo.git.must(
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(tree)%00%(subject)%00", prefix],
      { stdoutOnly: true },
    )
    const list: Checkpoint[] = []
    for (const record of out.split("\0\n")) {
      const [ref, commit, tree, subject] = record.replace(/^\r?\n/, "").split("\0")
      if (!ref || !commit || !tree || !subject) continue
      const m = /^refs\/amira\/checkpoints\/(.+)\/(\d+)$/.exec(ref)
      const meta = parseMeta(subject)
      if (!m || !meta) continue
      list.push({ session: m[1]!, n: Number(m[2]), ref, commit, tree, meta })
    }
    if (session) this.#count.set(session, list.length)
    return list.sort((a, b) => (a.session === b.session ? a.n - b.n : a.meta.ts - b.meta.ts))
  }

  /** Paths that differ between two trees, optionally only under `paths` (repository-relative). */
  async #names(a: string, b: string, paths: string[], signal?: AbortSignal): Promise<string[]> {
    return (await this.#changes(a, b, paths, signal)).map((c) => c.path)
  }

  async #changes(a: string, b: string, paths: string[], signal?: AbortSignal): Promise<Change[]> {
    const out = await this.repo.git.must(
      ["diff-tree", "-r", "-z", "--no-renames", "--raw", a, b, ...pathArgs(paths)],
      { stdoutOnly: true, ...(signal ? { signal } : {}) },
    )
    const parts = out.split("\0")
    const changes: Change[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const head = /^:(\d{6}) (\d{6}) \S+ \S+ (\w)/.exec(parts[i]!.trim())
      const p = parts[i + 1]
      if (!head || !p) continue
      changes.push({ oldMode: head[1]!, newMode: head[2]!, status: head[3]!, path: p })
    }
    return changes
  }

  /** What differs between two trees, optionally only under `paths`. */
  changes(a: string, b: string, paths: string[] = []): Promise<Change[]> {
    return this.#changes(a, b, paths)
  }

  /** A unified diff from tree `a` to tree `b`, for the user to look over. */
  async diff(a: string, b: string, paths: string[] = []): Promise<string> {
    const r = await this.repo.git.exec(
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", a, b, ...pathArgs(paths)],
      { stdoutOnly: true },
    )
    return r.ok ? r.output : ""
  }

  /**
   * Restores checkpoint `target` to the work tree, only under `paths` when given. Takes a
   * checkpoint of the current state first (returned as `safety`), so nothing is lost.
   * Submodules are left as they are.
   */
  restore(
    session: string,
    target: Checkpoint,
    opts: { paths?: string[]; turn?: number; keep?: number } = {},
  ): Promise<{ safety: Checkpoint; restored: Change[] }> {
    return this.#locked(async () => {
      const scan = await this.#scan()
      const prev = await this.#latest(session)
      const safety = await this.#commit(session, scan.tree, prev, {
        kind: "restore",
        note: `before restoring #${target.n}${opts.paths?.length ? ` (${opts.paths.join(", ")})` : ""}`,
        ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
      })
      const restored = (await this.#changes(scan.tree, target.tree, opts.paths ?? [])).filter(
        (c) => c.oldMode !== GITLINK && c.newMode !== GITLINK,
      )
      if (restored.length) await this.#write(target, scan.tree, restored)
      // The safety checkpoint itself is never pruned right away: it is the newest.
      if (opts.keep) await this.#prune(session, opts.keep)
      return { safety, restored }
    })
  }

  /** Writes `changes` from `target` into the work tree; `current` is the tree it has now. */
  async #write(target: Checkpoint, current: string, changes: Change[]) {
    const { git } = this.repo
    const index = this.#scratchFile("restore.index")
    const list = this.#scratchFile("restore")
    try {
      // Files the checkpoint lacks are removed: `git restore` removes paths its index tracks
      // and the source does not have. Its index is a throwaway copy of the current state.
      await git.must(["read-tree", current], { env: { GIT_INDEX_FILE: index } })
      writeFileSync(list, `${changes.map((c) => c.path).join("\0")}\0`)
      await git.must(
        [
          "restore",
          `--source=${target.commit}`,
          "--worktree",
          "--no-overlay",
          `--pathspec-from-file=${list}`,
          "--pathspec-file-nul",
        ],
        { env: { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" } },
      )
    } finally {
      rmSync(index, { force: true })
      rmSync(list, { force: true })
    }
  }

  /** Keeps the newest `keep` checkpoints of a session. */
  prune(session: string, keep: number): Promise<number> {
    return this.#locked(() => this.#prune(session, keep))
  }

  async #prune(session: string, keep: number): Promise<number> {
    const known = this.#count.get(session)
    if (known !== undefined && known <= keep) return 0
    const all = await this.#list(session)
    const drop = all.slice(0, Math.max(0, all.length - keep))
    for (const c of drop) await this.repo.git.exec(["update-ref", "-d", c.ref])
    this.#count.set(session, all.length - drop.length)
    return drop.length
  }

  /** Removes checkpoints older than `maxAgeMs`, of every session, at most `limit` at a time. */
  pruneOlder(maxAgeMs: number, limit = 200): Promise<number> {
    return this.#locked(async () => {
      const cutoff = Date.now() - maxAgeMs
      const old = (await this.#list()).filter((c) => c.meta.ts < cutoff).slice(0, limit)
      for (const c of old) {
        await this.repo.git.exec(["update-ref", "-d", c.ref])
        if (this.#last.get(c.session)?.n === c.n) this.#last.delete(c.session)
        this.#count.delete(c.session)
      }
      return old.length
    })
  }
}

const isIgnoreFile = (p: string) => p === ".gitignore" || p.endsWith("/.gitignore")

/** A file's size and modification time, or "-" when it is missing. */
function stamp(file: string): string {
  try {
    const st = statSync(file)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return "-"
  }
}

function parseMeta(subject: string): CheckpointMeta | undefined {
  const at = subject.indexOf("{")
  if (!subject.startsWith("amira checkpoint") || at < 0) return undefined
  try {
    const meta = JSON.parse(subject.slice(at)) as CheckpointMeta
    if (meta?.v !== 1 || typeof meta.ts !== "number") return undefined
    return { ...meta, changed: Array.isArray(meta.changed) ? meta.changed : [] }
  } catch {
    return undefined
  }
}

/** Literal, repository-relative pathspecs. */
function pathArgs(paths: string[]): string[] {
  return paths.length ? ["--", ...paths.map((p) => `:(top,literal)${p}`)] : []
}

/**
 * The fewest paths that cover every untracked file: each file's topmost directory that holds
 * no tracked file, or the file itself.
 */
export function collapse(untracked: string[], tracked: Set<string>): string[] {
  const trackedDirs = new Set<string>()
  for (const t of tracked) {
    const parts = t.split("/")
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join("/"))
  }
  const out = new Set<string>()
  for (const u of untracked) {
    const parts = u.split("/")
    let pick = u
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      if (!trackedDirs.has(dir)) {
        pick = dir
        break
      }
    }
    out.add(pick)
  }
  return [...out]
}
