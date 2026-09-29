import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RunCommandOptions, RunCommandResult } from "@amira/api"
import type { Diagnostic } from "./client.ts"
import type { Which } from "./servers.ts"
import { fileKey } from "./uri.ts"

/**
 * The fallback for TypeScript without a language server: `tsc --noEmit` over the project
 * (the nearest tsconfig.json), keeping what it reports about the files asked for.
 */

export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

/**
 * The project's own tsc (node_modules/.bin, looking up from `from`), else one on PATH. The
 * search stops at the repository's root (the folder with `.git`) and never reaches the home
 * folder or above it, so a stray node_modules higher up is not run.
 */
export function findTsc(
  from: string,
  find: Which,
  binLookup = localBin,
  home = os.homedir(),
): string | undefined {
  let dir = path.resolve(from)
  const inHome = isBelow(dir, home)
  for (;;) {
    if (inHome && !isBelow(dir, home)) break
    const local = binLookup(path.join(dir, "node_modules", ".bin"), "tsc")
    if (local) return local
    if (existsSync(path.join(dir, ".git"))) break
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return find("tsc") ?? undefined
}

/** Whether `dir` is strictly inside `top`. */
function isBelow(dir: string, top: string): boolean {
  const rel = path.relative(path.resolve(top), dir)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function localBin(dir: string, program: string): string | undefined {
  if (!existsSync(dir)) return undefined
  return Bun.which(program, { PATH: dir }) ?? undefined
}

/** The nearest tsconfig.json from the file's folder up to `root` (inclusive). */
export function findTsconfig(file: string, root: string): string | undefined {
  let dir = path.dirname(path.resolve(file))
  const top = path.resolve(root)
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json")
    if (existsSync(candidate)) return candidate
    if (fileKey(dir) === fileKey(top)) return undefined
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/**
 * The files `tsc --listFiles` listed (absolute paths, one per line, among its diagnostics),
 * by fileKey.
 */
export function parseTscFileList(output: string): Set<string> {
  const out = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(line)) continue
    if (/\(\d+,\d+\): (?:error|warning|message) TS\d+/.test(line)) continue
    out.add(fileKey(line.trim()))
  }
  return out
}

/** Reads `tsc --pretty false` output: `file(line,col): error TS1234: message`, with indented continuations. */
export function parseTscOutput(output: string, cwd: string): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>()
  let last: Diagnostic | undefined
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/.exec(line)
    if (m) {
      const [, file, row, col, kind, code, message] = m
      const pos = { line: Number(row) - 1, character: Number(col) - 1 }
      last = {
        range: { start: pos, end: pos },
        severity: kind === "error" ? 1 : kind === "warning" ? 2 : 3,
        code: code!,
        source: "tsc",
        message: message!,
      }
      const key = fileKey(path.resolve(cwd, file!))
      const list = out.get(key) ?? []
      list.push(last)
      out.set(key, list)
    } else if (last && /^\s+\S/.test(line)) {
      last.message += `\n${line.trim()}`
    } else last = undefined
  }
  return out
}

export interface TscRun {
  /** Diagnostics by fileKey, for every file asked about that tsc checked (empty when it has none). */
  byFile: Map<string, Diagnostic[]>
  /**
   * Files asked about that are not part of their project (excluded, outside `include`, or a
   * tsconfig with only references), by fileKey: why tsc could not tell about them.
   */
  notChecked: Map<string, string>
  /** Why there is nothing to go on (tsc failed to run or timed out). */
  error?: string
}

/**
 * Checks `files` with tsc: once per tsconfig.json they belong to; files outside any project
 * are checked on their own, with modern defaults. `timeoutMs` is for all the runs together.
 */
export async function runTsc(
  tsc: string[],
  files: string[],
  root: string,
  run: RunCommand,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<TscRun> {
  const byProject = new Map<string, string[]>()
  for (const file of files) {
    const project = findTsconfig(file, root) ?? ""
    byProject.set(project, [...(byProject.get(project) ?? []), file])
  }
  const byFile = new Map<string, Diagnostic[]>()
  const notChecked = new Map<string, string>()
  const deadline = Date.now() + opts.timeoutMs
  const failed = (error: string): TscRun => ({ byFile: new Map(), notChecked: new Map(), error })
  const late = failed(`tsc took longer than ${opts.timeoutMs} ms`)
  for (const [project, members] of byProject) {
    const cwd = project ? path.dirname(project) : root
    // --listFiles: which files the project has, so one it leaves out is not called clean.
    const argv = project
      ? [...tsc, "--noEmit", "--pretty", "false", "--listFiles", "-p", project]
      : [
          ...tsc,
          "--noEmit",
          "--pretty",
          "false",
          "--listFiles",
          "--skipLibCheck",
          "--target",
          "esnext",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          ...members,
        ]
    const left = deadline - Date.now()
    if (left <= 0) return late
    let result: RunCommandResult
    try {
      result = await run(argv, { cwd, timeoutMs: left, signal: opts.signal })
    } catch (err) {
      return failed(`tsc failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (result.timedOut) return late
    if (result.aborted) return failed("aborted")
    const found = parseTscOutput(result.output, cwd)
    // Exit 1 or 2 with nothing parsed: tsc itself failed (bad tsconfig, crash).
    if (result.exitCode !== 0 && found.size === 0) {
      const text = result.output.trim().split("\n").slice(0, 3).join(" ")
      return failed(`tsc exited with code ${result.exitCode}${text ? `: ${text}` : ""}`)
    }
    const listed = parseTscFileList(result.output)
    for (const file of members) {
      const key = fileKey(file)
      if (listed.has(key)) byFile.set(key, found.get(key) ?? [])
      else if (!project) notChecked.set(key, "tsc did not list it among the files it checked")
      else {
        const name = path.relative(root, project) || project
        notChecked.set(
          key,
          listed.size
            ? `it is not part of the project ${name} (excluded, or outside its "include")`
            : `${name} has no files of its own (a tsconfig with only "references" is not checked)`,
        )
      }
    }
  }
  return { byFile, notChecked }
}
