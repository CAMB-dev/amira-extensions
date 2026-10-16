import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function unavailable(detail: string, cause?: unknown): Error {
  return new Error(`Prototype advisory scan unavailable: ${detail}`, { cause })
}

/**
 * Git owns ignore syntax and tracked-file semantics, including effective
 * configured/user excludes, repository .gitignore and info/exclude rules.
 * The caller must not walk symlinks (Git also refuses symlink .gitignore files).
 * Paths are project-relative, forward-slash strings; directories end in '/'.
 */
export async function createPrototypeScanIgnore(root: string): Promise<{
  ignored(paths: readonly string[]): Promise<Set<string>>
  /** Index paths under this project, relative to it (not the enclosing repository root). */
  tracked(): Promise<Set<string>>
  close(): Promise<void>
}> {
  const directory = await realpath(root).catch((error: unknown) => {
    throw unavailable("cannot access the project root.", error)
  })
  const temporary = await mkdtemp(path.join(tmpdir(), "amira-prototype-ignore-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT(?:_|$)/i.test(key)))
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    LC_ALL: "C",
    LANG: "C",
  })
  const options = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${path.join(temporary, "no-hooks")}`,
  ]
  function git(args: string[], input = ""): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        [...options, ...args],
        {
          cwd: directory,
          env,
          shell: false,
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed || error.signal)) {
            reject(unavailable("Git could not run; install Git and retry the scan.", error))
          } else {
            resolve({ status: typeof error?.code === "number" ? error.code : 0, stdout, stderr })
          }
        },
      )
      // Early Git exit can close stdin before a batch is written; its exit status
      // remains authoritative and the callback reports spawn/timeout failures.
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    })
  }
  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    await rm(temporary, { recursive: true, force: true })
    closed = true
  }
  try {
    const discovery = await git(["rev-parse", "--show-toplevel"])
    const repository: string[] = []
    if (discovery.status !== 0) {
      if (discovery.status !== 128 || !discovery.stderr.startsWith("fatal: not a git repository")) {
        throw unavailable(`Git repository discovery failed: ${discovery.stderr.trim()}`)
      }
      // Never initialize or write an index in the project. An empty bare repo
      // supplies Git's ignore engine for ordinary non-Git project directories.
      const metadata = path.join(temporary, "metadata")
      const initialized = await git(["init", "--bare", "--quiet", "--template=", metadata])
      if (initialized.status !== 0) {
        throw unavailable(`Git temporary metadata initialization failed: ${initialized.stderr.trim()}`)
      }
      repository.push(`--git-dir=${metadata}`, `--work-tree=${directory}`)
    }
    return {
      async tracked() {
        if (closed) throw unavailable("the ignore scan is already closed.")
        try {
          const result = await git([...repository, "ls-files", "--cached", "-z", "--", "."])
          if (result.status !== 0)
            throw unavailable(`Git tracked-file lookup failed: ${result.stderr.trim()}`)
          return new Set(result.stdout.split("\0").filter(Boolean))
        } catch (error) {
          await close()
          throw error
        }
      },
      async ignored(paths) {
        if (closed) throw unavailable("the ignore scan is already closed.")
        if (paths.length === 0) return new Set()
        try {
          const result = await git([...repository, "check-ignore", "--stdin", "-z"], `${paths.join("\0")}\0`)
          if (result.status !== 0 && result.status !== 1) {
            throw unavailable(`Git ignore check failed: ${result.stderr.trim()}`)
          }
          return new Set(result.stdout.split("\0").filter(Boolean))
        } catch (error) {
          await close()
          throw error
        }
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
