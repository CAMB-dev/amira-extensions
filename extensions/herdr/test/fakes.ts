import type { AnyEvent, EventMap, ExtensionAPI, RunCommandOptions, RunCommandResult } from "@amira/api"
import { createHerdrExtension, type Env } from "../src/index.ts"

export const ROOT = "s_root"
export const BIN = "/opt/herdr/bin/herdr"
export const PANE = "p_7"

export const herdrEnv = (extra: Env = {}): Env => ({
  HERDR_ENV: "1",
  HERDR_PANE_ID: PANE,
  HERDR_BIN_PATH: BIN,
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  ...extra,
})

/** A call to the fake runCommand; `finish` settles it with an exit code (0 by default). */
export interface Call {
  argv: string[]
  opts: RunCommandOptions
  finish: (exitCode?: number) => void
}

/**
 * A runCommand whose calls stay open until finished by hand (`auto` finishes each at once),
 * so tests can see what waits while a call runs.
 */
export function fakeRun(auto = true) {
  const calls: Call[] = []
  const run = (argv: string[], opts: RunCommandOptions) =>
    new Promise<RunCommandResult>((resolve) => {
      const finish = (exitCode = 0) =>
        resolve({
          output: "",
          exitCode,
          signalCode: null,
          timedOut: false,
          aborted: false,
          settled: true,
          contained: true,
          truncated: false,
        })
      calls.push({ argv, opts, finish })
      if (auto) finish()
    })
  return { run, calls }
}

/** The parts of the extension API this extension uses, with the handlers it registered. */
export function fakeApi(settings: Record<string, unknown> | undefined = undefined) {
  const handlers = new Map<string, ((e: AnyEvent) => void)[]>()
  const exits: ((signal: AbortSignal) => void | Promise<void>)[] = []
  const unloads: (() => void)[] = []
  const errors: string[] = []
  let currentSession: string | undefined
  const api = {
    cwd: "/work/proj",
    settings: settings ? { extensions: { herdr: settings } } : {},
    on: (type: string, handler: (e: AnyEvent) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
      return () => {}
    },
    onExit: (h: (signal: AbortSignal) => void | Promise<void>) => {
      exits.push(h)
      return () => {}
    },
    onUnload: (h: () => void) => {
      unloads.push(h)
      return () => {}
    },
    reportError: (e: string) => void errors.push(e),
    session: () => (currentSession ? { info: () => ({ id: currentSession }) } : undefined),
    runCommand: () => {
      throw new Error("tests pass their own runCommand")
    },
  }
  let seq = 0
  const emit = <K extends keyof EventMap>(
    type: K,
    data: EventMap[K],
    meta: { sessionId?: string; parentSessionId?: string } = {},
  ) => {
    const e = {
      seq: ++seq,
      ts: Date.now(),
      sessionId: meta.sessionId ?? ROOT,
      ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      type,
      data,
    } as AnyEvent
    for (const h of handlers.get(type) ?? []) h(e)
    // Awaiting it lets the calls this event started finish; not awaiting it keeps them running.
    return settle()
  }
  return {
    api: api as unknown as ExtensionAPI,
    handlers,
    exits,
    unloads,
    errors,
    emit,
    setCurrentSession: (id: string | undefined) => {
      currentSession = id
    },
  }
}

/** Lets promise callbacks run. */
export const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Loads the extension with fakes; returns them and helpers to read the calls. */
export function setup(
  opts: {
    env?: Env
    settings?: Record<string, unknown>
    auto?: boolean
    now?: () => number
    owner?: Record<symbol, unknown>
  } = {},
) {
  const env = opts.env ?? herdrEnv()
  const fake = fakeApi(opts.settings)
  const r = fakeRun(opts.auto ?? true)
  const owner = opts.owner ?? {}
  createHerdrExtension({
    runCommand: r.run,
    env,
    process: owner,
    ...(opts.now ? { now: opts.now } : {}),
  })(fake.api)
  /** Each call without the binary, pane and seq, e.g. ["report-agent", "--state", "idle"]. */
  const brief = () => r.calls.map((c) => briefArgv(c.argv))
  return { ...fake, ...r, env, owner, brief }
}

const DROP_WITH_VALUE = new Set(["--source", "--agent", "--seq"])

export function briefArgv(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (i === 0 || (i === 3 && argv[1] === "pane")) continue
    if (a === "pane" && i === 1) continue
    if (a === "--") {
      out.push(...argv.slice(i))
      break
    }
    if (DROP_WITH_VALUE.has(a)) {
      i++
      continue
    }
    out.push(a)
  }
  return out
}

export const seqOf = (argv: string[]) => Number(argv[argv.indexOf("--seq") + 1])

export const startData = (extra: Partial<EventMap["session.start"]> = {}): EventMap["session.start"] => ({
  reason: "startup",
  cwd: "/work/proj",
  model: { provider: "deepseek", model: "deepseek-chat" },
  resume: ["amira", "--resume", ROOT],
  ...extra,
})
