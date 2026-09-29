import type { ExtensionAPI } from "@amira/api"
import { isRefName } from "./settings.ts"

export interface RunResult {
  ok: boolean
  /** Trimmed at the end. */
  output: string
  exitCode: number | null
  timedOut: boolean
}

/** Runs a program through the API (never spawning it ourselves), in `cwd`. */
export type Run = (
  argv: string[],
  opts: {
    cwd: string
    signal: AbortSignal
    timeoutMs?: number
    stdoutOnly?: boolean
    env?: Record<string, string>
  },
) => Promise<RunResult>

export function runner(api: Pick<ExtensionAPI, "runCommand">): Run {
  return async (argv, opts) => {
    try {
      const r = await api.runCommand(argv, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 60_000,
        ...(opts.stdoutOnly ? { stdoutOnly: true } : {}),
        // Nothing may wait for a terminal: a prompt for credentials or an editor would hang.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...opts.env },
        viaCmd: true,
      })
      return {
        ok: r.exitCode === 0 && !r.timedOut && !r.aborted,
        output: r.output.replace(/\s+$/, ""),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      }
    } catch (err) {
      // e.g. the program is not installed.
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false,
      }
    }
  }
}

/** Git in one repository. */
export class Git {
  constructor(
    readonly run: Run,
    readonly cwd: string,
    readonly signal: AbortSignal,
  ) {}

  exec(args: string[], opts: { timeoutMs?: number; stdoutOnly?: boolean } = {}): Promise<RunResult> {
    return this.run(["git", ...args], { cwd: this.cwd, signal: this.signal, ...opts })
  }

  /** Output of a git command that must succeed; throws with git's message otherwise. */
  async out(args: string[]): Promise<string> {
    const r = await this.exec(args, { stdoutOnly: true })
    if (!r.ok) {
      const why = (await this.exec(args)).output || `exit code ${r.exitCode}`
      throw new Error(`git ${args[0]} failed: ${why}`)
    }
    return r.output
  }

  /** The top of the work tree, or undefined outside a repository. */
  async root(): Promise<string | undefined> {
    const r = await this.exec(["rev-parse", "--show-toplevel"], { stdoutOnly: true })
    return r.ok && r.output ? r.output : undefined
  }

  /** The current branch, or undefined on a detached HEAD. */
  async branch(): Promise<string | undefined> {
    const r = await this.exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdoutOnly: true })
    return r.ok && r.output ? r.output : undefined
  }

  async exists(ref: string): Promise<boolean> {
    if (!isRefName(ref)) return false
    return (await this.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdoutOnly: true })).ok
  }

  async remotes(): Promise<string[]> {
    const r = await this.exec(["remote"], { stdoutOnly: true })
    return r.ok ? r.output.split(/\r?\n/).filter(Boolean) : []
  }

  /**
   * The branch to compare with: `wanted` (from the command or settings), else origin's default
   * branch, else main or master (local, then on origin).
   */
  async base(wanted: string | undefined): Promise<string> {
    if (wanted !== undefined) {
      if (!isRefName(wanted)) throw new Error(`"${wanted}" is not a branch name`)
      if (await this.exists(wanted)) return wanted
      for (const remote of await this.remotes()) {
        if (await this.exists(`${remote}/${wanted}`)) return `${remote}/${wanted}`
      }
      throw new Error(`there is no branch "${wanted}"`)
    }
    const head = await this.exec(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      stdoutOnly: true,
    })
    if (head.ok && head.output && (await this.exists(head.output))) {
      // Prefer the local branch of the same name when there is one and it is not behind.
      const local = head.output.replace(/^origin\//, "")
      if ((await this.exists(local)) && (await this.isAncestor(head.output, local))) return local
      return head.output
    }
    for (const name of ["main", "master", "origin/main", "origin/master", "trunk", "develop"]) {
      if (await this.exists(name)) return name
    }
    throw new Error("cannot tell which branch to compare with; name it, e.g. /review main")
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.exec(["merge-base", "--is-ancestor", a, b])).ok
  }

  /** `base` without a remote's name, as `gh pr create --base` wants it. */
  async branchName(base: string): Promise<string> {
    for (const remote of await this.remotes()) {
      if (base.startsWith(`${remote}/`)) return base.slice(remote.length + 1)
    }
    return base
  }
}

/**
 * A diff cut to `max` characters for a prompt. What is cut is named file by file (from the
 * stat), so the model knows what it did not see and can look.
 */
export function clipDiff(diff: string, max: number): { text: string; clipped: boolean } {
  if (diff.length <= max) return { text: diff, clipped: false }
  const files = diff.split(/(?=^diff --git )/m)
  const kept: string[] = []
  const left: string[] = []
  let used = 0
  for (const f of files) {
    if (used + f.length <= max) {
      kept.push(f)
      used += f.length
      continue
    }
    const name = /^diff --git a\/(.*?) b\//.exec(f)?.[1] ?? "(unknown file)"
    left.push(`${name} (${f.split("\n").length} lines)`)
  }
  // One file bigger than the whole allowance: show its start rather than nothing.
  if (!kept.length && files[0]) kept.push(files[0].slice(0, max))
  const note = `\n[The diff is cut here. Not shown${kept.length && left.length === files.length ? " in full" : ""}: ${left.join(", ")}.]\n`
  return { text: kept.join("") + note, clipped: true }
}
