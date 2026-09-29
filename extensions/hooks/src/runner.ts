import type { RunCommandOptions, RunCommandResult } from "@amira/api"
import type { Hook } from "./config.ts"
import { type ShellDeps, shellLaunch } from "./shell.ts"

/** One run of a hook's command, as /hooks lists it. */
export interface HookRun {
  id: number
  hook: Hook
  /** What it ran for: the file (after edit), the tool (before tool), the turn's ending. */
  target?: string
  startedAt: number
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** The command could not be started; the message says why. */
  error?: string
  /** Its output (stdout and stderr together), without colors, cut to maxOutputChars. */
  output: string
  /** Characters cut from the middle of the output. */
  cut: number
  /** Exit code 0, in time. */
  ok: boolean
  /** For a before-tool rule that decided without a command: what it decided. */
  verdict?: string
}

export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

export interface RunContext {
  runCommand: RunCommand
  projectDir: string
  /** Variables about what it runs for: AMIRA_TOOL, AMIRA_FILE, ... */
  vars: Record<string, string | undefined>
  /** Sent as JSON on stdin. */
  input: Record<string, unknown>
  signal: AbortSignal
  maxOutputChars: number
  id: number
  target?: string
  shell?: ShellDeps
  /** The process environment the command starts from. */
  baseEnv?: Record<string, string | undefined>
  now?: () => number
}

/** Runs a hook's command in its shell, with its timeout; never throws. */
export async function runHook(hook: Hook, ctx: RunContext): Promise<HookRun> {
  const now = ctx.now ?? Date.now
  const startedAt = now()
  const done = (r: Partial<HookRun>): HookRun => ({
    id: ctx.id,
    hook,
    ...(ctx.target !== undefined ? { target: ctx.target } : {}),
    startedAt,
    durationMs: Math.max(0, now() - startedAt),
    exitCode: null,
    timedOut: false,
    aborted: false,
    output: "",
    cut: 0,
    ok: false,
    ...r,
  })
  if (!hook.command) return done({ error: "no command" })
  const launch = shellLaunch(hook.shell, hook.command, ctx.shell)
  if ("error" in launch) return done({ error: launch.error })
  const env: Record<string, string | undefined> = {
    ...(ctx.baseEnv ?? process.env),
    ...launch.env,
    AMIRA_HOOK: hook.name,
    AMIRA_EVENT: hook.event,
    AMIRA_PROJECT_DIR: ctx.projectDir,
    ...ctx.vars,
    ...hook.env,
  }
  let result: RunCommandResult
  try {
    result = await ctx.runCommand(launch.argv, {
      cwd: hook.cwd ?? ctx.projectDir,
      env,
      timeoutMs: hook.timeoutMs,
      signal: ctx.signal,
      stdin: JSON.stringify({ event: hook.event, hook: hook.name, projectDir: ctx.projectDir, ...ctx.input }),
    })
  } catch (err) {
    return done({ error: err instanceof Error ? err.message : String(err) })
  }
  const { text, cut } = capOutput(cleanOutput(result.output), ctx.maxOutputChars)
  return done({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    output: text,
    cut,
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
  })
}

/** Output without terminal escapes (colors, cursor moves), carriage returns or trailing blanks. */
export function cleanOutput(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
      .replace(/\x1b[@-_]/g, "")
      .replace(/\r\n/g, "\n")
      // A progress line redrawn with \r: keep what it ended as.
      .split("\n")
      .map((l) => l.slice(l.lastIndexOf("\r") + 1).trimEnd())
      .join("\n")
      .replace(/^\n+|\n+$/g, "")
  )
}

/**
 * At most `max` characters: the start (where formatters and linters report) and the longer end
 * (where test runners sum up), cut at line breaks where it can, with a line saying how much
 * went.
 */
export function capOutput(s: string, max: number): { text: string; cut: number } {
  if (s.length <= max) return { text: s, cut: 0 }
  const headMax = Math.floor(max * 0.3)
  const tailMax = max - headMax
  let head = s.slice(0, headMax)
  const nl = head.lastIndexOf("\n")
  if (nl > headMax / 2) head = head.slice(0, nl)
  let tail = s.slice(s.length - tailMax)
  const first = tail.indexOf("\n")
  if (first !== -1 && first < tailMax / 2) tail = tail.slice(first + 1)
  const cut = s.length - head.length - tail.length
  return { text: `${head}\n… ${cut} characters cut …\n${tail}`, cut }
}

/** The last `n` non-empty lines, for a notice. */
export function lastLines(s: string, n: number): string[] {
  return s
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
}

/** "exit 1", "timed out after 30s", ... */
export function outcome(run: HookRun): string {
  if (run.verdict) return run.verdict
  if (run.error) return `could not run: ${run.error}`
  if (run.timedOut) return `timed out after ${seconds(run.hook.timeoutMs)}`
  if (run.aborted) return "stopped"
  if (run.ok) return "ok"
  return run.exitCode === null ? "killed" : `exit ${run.exitCode}`
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}
