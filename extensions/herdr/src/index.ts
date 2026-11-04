import type {
  AnyEvent,
  EventMap,
  Extension,
  ExtensionAPI,
  RunCommandOptions,
  RunCommandResult,
} from "@amira/api"
import { RELEASE_TIMEOUT_MS, Reporter, type RunHerdr } from "./reporter.ts"
import { Tracker } from "./tracker.ts"

export * from "./reporter.ts"
export * from "./resume.ts"
export * from "./tracker.ts"

export type Env = Record<string, string | undefined>
export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

/** Set for everything Amira starts, so an Amira run from inside this one stays quiet. */
export const NESTED_VAR = "AMIRA_HERDR_PANE"
/** Marks this process as the one that set NESTED_VAR, so a reload is not taken for nesting. */
const OWNER = Symbol.for("amira.herdr.owner")

/** What the extension uses from the outside world; tests pass fakes. */
export interface HerdrDeps {
  /** Default: the host's runCommand. */
  runCommand?: RunCommand
  /** Default: process.env. NESTED_VAR is set on it. */
  env?: Env
  /** Holds the reload marker; default: globalThis. */
  process?: Record<symbol, unknown>
  now?: () => number
}

export interface HerdrPane {
  pane: string
  bin: string
}

/** The pane to report to, or why not: outside herdr, turned off, or nested in another Amira. */
export function detect(
  env: Env,
  settings: Record<string, unknown> | undefined,
  owner: Record<symbol, unknown> = globalThis as never,
): HerdrPane | { inactive: "not in herdr" | "disabled" | "nested" } {
  if (settings?.enabled === false) return { inactive: "disabled" }
  const pane = env.HERDR_PANE_ID?.trim()
  const bin = env.HERDR_BIN_PATH?.trim()
  if (env.HERDR_ENV !== "1" || !pane || !bin) return { inactive: "not in herdr" }
  // The variable came from a parent Amira that reports for this pane already.
  if (env[NESTED_VAR] === pane && owner[OWNER] !== pane) return { inactive: "nested" }
  return { pane, bin }
}

const WATCHED: (keyof EventMap)[] = [
  "session.start",
  "session.end",
  "status.changed",
  "model.changed",
  "ui.request",
  "ui.resolved",
]

export function createHerdrExtension(deps: HerdrDeps = {}): Extension {
  return (api: ExtensionAPI) => {
    const env = deps.env ?? process.env
    const owner = deps.process ?? (globalThis as never)
    const found = detect(env, api.settings.extensions?.herdr, owner)
    if ("inactive" in found) return
    env[NESTED_VAR] = found.pane
    owner[OWNER] = found.pane

    const runCommand: RunCommand = deps.runCommand ?? ((argv, opts) => api.runCommand(argv, opts))
    const run: RunHerdr = async (argv, timeoutMs, signal) => {
      const r = await runCommand(argv, {
        cwd: api.cwd,
        timeoutMs,
        signal: signal ?? AbortSignal.timeout(timeoutMs + 500),
        maxOutputChars: 4000,
      })
      return r.exitCode === 0 && !r.timedOut && !r.aborted
    }
    const reporter = new Reporter({ ...found, run, ...(deps.now ? { now: deps.now } : {}) })
    const tracker = new Tracker({
      report: (r) => reporter.report(r),
      setSession: (s) => reporter.setSession(s),
      release: () => void reporter.release(),
      currentSessionId: () => api.session()?.info().id,
    })
    for (const type of WATCHED) {
      api.on(type, (e) => {
        try {
          tracker.handle(e as AnyEvent)
        } catch {}
      })
    }
    api.onExit(async (signal) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELEASE_TIMEOUT_MS)
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      await Promise.race([reporter.release(signal), limit])
      clearTimeout(timer)
    })
    api.onUnload(() => reporter.dispose())
  }
}

export default createHerdrExtension()
