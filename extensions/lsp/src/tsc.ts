import { existsSync } from "node:fs"
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

/** The project's own tsc (node_modules/.bin, looking up from `from`), else one on PATH. */
export function findTsc(from: string, find: Which, binLookup = localBin): string | undefined {
  let dir = path.resolve(from)
  for (;;) {
    const local = binLookup(path.join(dir, "node_modules", ".bin"), "tsc")
    if (local) return local
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return find("tsc") ?? undefined
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
  /** Diagnostics by fileKey, for every file asked about (empty when it has none). */
  byFile: Map<string, Diagnostic[]>
  /** Why there is nothing to go on (tsc failed to run or timed out). */
  error?: string
}

/**
 * Checks `files` with tsc: once per tsconfig.json they belong to; files outside any project
 * are checked on their own, with modern defaults.
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
  for (const file of files) byFile.set(fileKey(file), [])
  for (const [project, members] of byProject) {
    const cwd = project ? path.dirname(project) : root
    const argv = project
      ? [...tsc, "--noEmit", "--pretty", "false", "-p", project]
      : [
          ...tsc,
          "--noEmit",
          "--pretty",
          "false",
          "--skipLibCheck",
          "--target",
          "esnext",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          ...members,
        ]
    let result: RunCommandResult
    try {
      result = await run(argv, { cwd, timeoutMs: opts.timeoutMs, signal: opts.signal })
    } catch (err) {
      return { byFile, error: `tsc failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (result.timedOut) return { byFile, error: `tsc took longer than ${opts.timeoutMs} ms` }
    if (result.aborted) return { byFile, error: "aborted" }
    const found = parseTscOutput(result.output, cwd)
    // Exit 1 or 2 with nothing parsed: tsc itself failed (bad tsconfig, crash).
    if (result.exitCode !== 0 && found.size === 0) {
      const text = result.output.trim().split("\n").slice(0, 3).join(" ")
      return { byFile, error: `tsc exited with code ${result.exitCode}${text ? `: ${text}` : ""}` }
    }
    for (const file of members) byFile.set(fileKey(file), found.get(fileKey(file)) ?? [])
  }
  return { byFile }
}
