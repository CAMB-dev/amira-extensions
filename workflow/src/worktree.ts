import { createHash } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

/** Runs git in `cwd`; `stdoutOnly` keeps stderr out of output that is parsed. */
export type RunGit = (
  args: string[],
  cwd: string,
  stdoutOnly?: boolean,
) => Promise<{ output: string; ok: boolean }>

/**
 * A workflow agent's own checkout (isolation "worktree"), in the same place the agent
 * extension keeps sub-agents' worktrees (D62), so its sweep clears ones left behind.
 */
export interface Worktree {
  root: string
  dir: string
  cwd: string
  base: string
  patch: string
}

const SNAPSHOT_IDENTITY = ["-c", "user.name=Amira", "-c", "user.email=amira@localhost"]

function projectKey(root: string): string {
  const key = process.platform === "win32" ? root.toLowerCase() : root
  return `${path.basename(root)}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`
}

/** A worktree starting from the working tree as it is (uncommitted tracked changes included). */
export async function createWorktree(
  git: RunGit,
  opts: { cwd: string; home: string; name: string },
): Promise<Worktree | { error: string }> {
  const top = await git(["rev-parse", "--show-toplevel"], opts.cwd, true)
  if (!top.ok || !top.output.trim()) return { error: "not a git repository" }
  const root = path.normalize(top.output.trim())
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], root, true)
  if (!head.ok) return { error: "the repository has no commits yet" }
  const snapshot = await git([...SNAPSHOT_IDENTITY, "stash", "create"], root, true)
  const base = (snapshot.ok && snapshot.output.trim()) || head.output.trim()
  const dir = path.join(opts.home, "worktrees", projectKey(root), opts.name)
  mkdirSync(path.dirname(dir), { recursive: true })
  const add = await git(["worktree", "add", "--detach", dir, base], root)
  if (!add.ok) return { error: `git worktree add failed: ${add.output.trim()}` }
  const rel = path.relative(root, path.resolve(opts.cwd))
  const cwd = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(dir, rel) : dir
  return { root, dir, cwd, base, patch: `${dir}.diff` }
}

/**
 * Applies what the agent changed to the working tree when it applies cleanly, and removes the
 * worktree; otherwise (or when `merge` is false, for an agent that did not finish) the
 * worktree stays for review. Returns a line for the run's log.
 */
export async function finishWorktree(git: RunGit, wt: Worktree, merge: boolean): Promise<string> {
  await git(["add", "-A"], wt.dir)
  const diff = await git(["diff", "--cached", "--binary", `--output=${wt.patch}`, wt.base], wt.dir)
  if (!diff.ok) return `worktree ${wt.dir}: git diff failed; its changes stay there`
  const names = await git(["diff", "--cached", "--name-only", wt.base], wt.dir, true)
  const files = names.output.split(/\r?\n/).filter(Boolean)
  if (!files.length) {
    await remove(git, wt)
    return "worktree: no changes"
  }
  if (!merge) return `worktree kept at ${wt.dir} (${files.length} files changed; the agent did not finish)`
  const apply = await git(["apply", "--binary", "--whitespace=nowarn", wt.patch], wt.root)
  if (!apply.ok) {
    return `worktree NOT merged (${apply.output.trim().split("\n")[0] ?? "conflict"}); its changes stay in ${wt.dir}, patch ${wt.patch}`
  }
  await remove(git, wt)
  return `worktree merged: ${files.join(", ")}`
}

async function remove(git: RunGit, wt: Worktree) {
  const r = await git(["worktree", "remove", "--force", wt.dir], wt.root)
  if (!r.ok) {
    try {
      rmSync(wt.dir, { recursive: true, force: true })
    } catch {}
    await git(["worktree", "prune"], wt.root)
  }
  try {
    rmSync(wt.patch, { force: true })
  } catch {}
}
