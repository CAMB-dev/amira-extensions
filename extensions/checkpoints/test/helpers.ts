import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand } from "@amira/proc"
import type { Run } from "../src/git.ts"

export const run: Run = (argv, o) => runCommand(argv, o)

export async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await runCommand(["git", ...args], {
    cwd: dir,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    stdoutOnly: true,
    viaCmd: true,
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.output}`)
  return r.output
}

export function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `amira-ckpt-${prefix}-`))
}

export function write(dir: string, rel: string, data: string | Uint8Array) {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** A repository with one commit, and a user identity of its own. */
export async function repo(files: Record<string, string | Uint8Array> = { "a.txt": "one\n" }) {
  const dir = tmp("repo")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.name", "Test")
  await git(dir, "config", "user.email", "test@example.com")
  await git(dir, "config", "commit.gpgsign", "false")
  for (const [p, data] of Object.entries(files)) write(dir, p, data)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "init")
  return dir
}

/** Every file under `dir` (but .git), with its bytes as hex, by forward-slash path. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const e of readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = at ? `${at}/${e.name}` : e.name
      if (e.name === ".git") continue
      if (e.isDirectory()) walk(rel)
      else out[rel] = Buffer.from(readFileSync(path.join(dir, rel))).toString("hex")
    }
  }
  walk("")
  return out
}

/** What the user's own git state looks like: branch, index, status, stash, refs. */
export async function userState(dir: string) {
  return {
    head: await git(dir, "rev-parse", "HEAD"),
    branch: await git(dir, "symbolic-ref", "HEAD"),
    // What is staged; the index's stat data is git status's to refresh.
    staged: await git(dir, "ls-files", "--stage", "-z"),
    stash: await git(dir, "stash", "list"),
    refs: await git(
      dir,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
      "refs/stash",
    ),
  }
}

/** The user's index file, byte for byte (no git command runs in between to refresh it). */
export function indexBytes(dir: string): string {
  return Buffer.from(readFileSync(path.join(dir, ".git", "index"))).toString("hex")
}
