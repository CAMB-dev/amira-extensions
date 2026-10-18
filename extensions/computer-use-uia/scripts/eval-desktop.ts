/**
 * D113, manual only: bun run eval:desktop --allow-desktop
 * Default driver: eval-runner.ts, using explicit AMIRA_UIA_EVAL_* provider environment.
 * Optional override: --runner ./runner.ts
 * Or set AMIRA_UIA_EVAL=1. Refuses CI and non-Windows hosts. Never run on an in-use desktop.
 *
 * Setup: `bun run link-amira <Amira checkout>` (the checkout needs `bun install`). No user
 * settings are read/written: the host has explicit in-memory evaluation settings. The trusted
 * optional external module must export `createRunner(): EvalRunner`, creating fresh model context per
 * trial. It must offer ONLY request.tools, send their complete ToolResult.content (including
 * images) to the SAME model in both modes, and return actual provider/session token usage.
 * Map Amira SubagentResult.usage directly; never estimate tokens from text/image size. Return
 * usage:null if unavailable. Input/output/cache counters are disjoint, as in @amira/ai Usage.
 *
 * Runner example shape (implement the model loop using your provider/session integration):
 * export function createRunner(): EvalRunner {
 *   return { name: "my-runner", model: "provider/model", async run(request) { ... }, close() { ... } }
 * }
 * Each tool retains its native schema, including request.window. execute() is fixture-scoped;
 * its context is supplied by this harness. Treat all UI content as untrusted data. Do not use
 * any other desktop access, tools, shell or file access in the runner. This interface is not
 * a security sandbox: modules are trusted code. No credentials are bundled.
 *
 * JSON goes to stdout: per-trial outcomes and per-mode aggregates. Steps count attempted runner
 * tool calls (reads included), not model turns. Time is solver wall time, excluding fixture
 * setup, independent scoring and teardown. Unknown usage stays null, including in totals;
 * knownTokenSubtotal and measuredTokenTrials describe partial coverage. Six fixed tasks run
 * on twelve fresh, uniquely titled owned forms, with counterbalanced mode order. This is a
 * small synthetic baseline, not evidence of general desktop performance. No screenshots or
 * unrelated window titles are saved. The helper/overlay do affect the real desktop after opt-in.
 *
 * Safe checks: bun test ./test/eval.test.ts; bunx tsc --noEmit
 * Never add the live evaluation to package test scripts or CI.
 */
import type { ToolDefinition, ToolResult } from "@amira/api"

export type EvalMode = "tree-only" | "screenshot+tree"
export const TASKS = [
  { id: "profile", prompt: 'Set Name to "Ada Lovelace" and Project to "Orion", then save the profile.' },
  { id: "unicode", prompt: 'Set Message to "café 你好", then save the message.' },
  { id: "preferences", prompt: "Enable reminders, disable telemetry, then apply preferences." },
  { id: "priority", prompt: "Choose High priority, then apply priority." },
  { id: "counter", prompt: "Increment the count exactly twice, then save the count." },
  { id: "release", prompt: 'Set Project to "Lyra", approve the release, then publish the release.' },
] as const
export type EvalTask = (typeof TASKS)[number]

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type EvalTool = Omit<ToolDefinition, "execute"> & {
  execute(params: Record<string, unknown>): Promise<ToolResult>
}

export interface EvalRequest {
  task: EvalTask
  mode: EvalMode
  window: string
  tools: EvalTool[]
  signal: AbortSignal
}

export interface EvalOutcome {
  usage: TokenUsage | null
  /** A failed solver outcome may still carry complete measured token usage. */
  error?: string
}

export interface EvalRunner {
  name: string
  model: string
  run(request: EvalRequest): Promise<EvalOutcome>
  /** Must cancel/drain model work, including after timeout. */
  close?(): void | Promise<void>
}

export interface EvalFixture {
  window: string
  tools: ToolDefinition[]
  verify(): Promise<boolean>
  close(): Promise<void>
  stopped(): boolean
}

export interface EvalDependencies {
  createRunner(): EvalRunner | Promise<EvalRunner>
  createFixture(task: EvalTask, mode: EvalMode): Promise<EvalFixture>
  now(): number
}

export interface EvalOptions {
  allowDesktop?: boolean
  env?: Record<string, string | undefined>
  platform?: string
  timeoutMs?: number
  maxSteps?: number
  signal?: AbortSignal
}

export interface TrialResult {
  task: string
  mode: EvalMode
  runner: string
  model: string
  success: boolean
  steps: number
  screenshotObservations: number
  durationMs: number
  usage: TokenUsage | null
  error?: string
}

export function assertDesktopAllowed(options: EvalOptions): void {
  const env = options.env ?? process.env
  if (!options.allowDesktop && env.AMIRA_UIA_EVAL !== "1")
    throw new Error("Desktop evaluation refused: pass --allow-desktop or set AMIRA_UIA_EVAL=1")
  if (env.CI && env.CI !== "0" && env.CI !== "false")
    throw new Error("Desktop evaluation is manual-only and refuses CI")
  if ((options.platform ?? process.platform) !== "win32")
    throw new Error("Desktop evaluation requires an idle, unlocked Windows desktop")
}

function usageTotal(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

function validateUsage(usage: TokenUsage | null): TokenUsage | null {
  if (usage === null) return null
  if (
    !usage ||
    ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("Runner must return actual nonnegative integer token counters, or usage:null")
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }
}

export function aggregateTrials(trials: readonly TrialResult[]) {
  return (["tree-only", "screenshot+tree"] as const).map((mode) => {
    const rows = trials.filter((row) => row.mode === mode)
    const measured = rows.filter((row) => row.usage !== null)
    const sum = (get: (row: TrialResult) => number) => rows.reduce((total, row) => total + get(row), 0)
    const successes = rows.filter((row) => row.success).length
    const knownTokenSubtotal = measured.reduce((total, row) => total + usageTotal(row.usage!), 0)
    return {
      mode,
      trials: rows.length,
      successes,
      successRate: rows.length ? successes / rows.length : null,
      steps: sum((row) => row.steps),
      meanSteps: rows.length ? sum((row) => row.steps) / rows.length : null,
      durationMs: sum((row) => row.durationMs),
      meanDurationMs: rows.length ? sum((row) => row.durationMs) / rows.length : null,
      tokens: rows.length && measured.length === rows.length ? knownTokenSubtotal : null,
      knownTokenSubtotal,
      measuredTokenTrials: measured.length,
      screenshotObservations: sum((row) => row.screenshotObservations),
    }
  })
}

/** All dependency calls, including external module loading, happen AFTER the opt-in gate. */
export async function runEvaluation(options: EvalOptions, dependencies: EvalDependencies) {
  assertDesktopAllowed(options)
  const maxSteps = options.maxSteps ?? 40
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("maxSteps and timeoutMs must be positive integers")
  const trials: TrialResult[] = []
  let identity: string | undefined
  let aborted: string | undefined
  const stoppedMessage = "Desktop control stopped; evaluation aborted without resuming"
  evaluation: for (const [index, task] of TASKS.entries()) {
    const modes: EvalMode[] = index % 2 ? ["screenshot+tree", "tree-only"] : ["tree-only", "screenshot+tree"]
    for (const mode of modes) {
      options.signal?.throwIfAborted()
      const runner = await dependencies.createRunner()
      let fixture: EvalFixture | undefined
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!runner.name?.trim() || !runner.model?.trim())
          throw new Error("Runner must identify name and model")
        const currentIdentity = JSON.stringify([runner.name, runner.model])
        if (identity && identity !== currentIdentity)
          throw new Error("Use the same runner and model in both modes")
        identity = currentIdentity
        controller.signal.throwIfAborted()
        fixture = await dependencies.createFixture(task, mode)
        controller.signal.throwIfAborted()
        const own = fixture
        let active = true
        let steps = 0
        let screenshots = 0
        let observations = 0
        let observationError: string | undefined
        let inFlight: Promise<ToolResult> | undefined
        const tools = fixture.tools.map(
          (tool): EvalTool => ({
            ...tool,
            async execute(params) {
              if (!active || controller.signal.aborted) throw new Error("Evaluation trial has ended")
              if (inFlight) throw new Error("Evaluation tool calls must be serial")
              if (++steps > maxSteps) throw new Error("Evaluation step budget exceeded")
              if (params.window !== own.window)
                throw new Error("Evaluation tools only target the owned fixture")
              const pending = tool.execute(params, {
                cwd: process.cwd(),
                toolCallId: `eval-${task.id}-${mode}-${steps}`,
                signal: controller.signal,
                update() {},
              })
              inFlight = Promise.resolve(pending)
              try {
                const result = await inFlight
                if (tool.name === "ui_tree" && !result.isError) {
                  const hasImage = result.content.some((block) => block.type === "image")
                  if (hasImage !== (mode === "screenshot+tree")) {
                    observationError = `Observation mismatch: ${mode} ui_tree ${hasImage ? "included" : "omitted"} an image`
                    throw new Error(observationError)
                  }
                  observations++
                  if (hasImage) screenshots++
                }
                return result
              } finally {
                inFlight = undefined
              }
            },
          }),
        )
        const started = dependencies.now()
        let usage: TokenUsage | null = null
        let error: string | undefined
        let rejectAbort: (() => void) | undefined
        let solver: Promise<EvalOutcome> | undefined
        try {
          const deadline = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(controller.signal.reason ?? new Error("Evaluation interrupted"))
            controller.signal.addEventListener("abort", rejectAbort, { once: true })
            timer = setTimeout(() => controller.abort(new Error("Evaluation task timed out")), timeoutMs)
          })
          solver = runner.run({ task, mode, window: fixture.window, tools, signal: controller.signal })
          const result = await Promise.race([solver, deadline])
          usage = validateUsage(result.usage)
          if (result.error !== undefined) throw new Error(result.error || "Evaluation runner failed")
          if (steps > maxSteps) throw new Error("Evaluation step budget exceeded")
          if (inFlight) throw new Error("Runner returned before its tool call completed")
          if (observationError) throw new Error(observationError)
          if (!observations) throw new Error("Runner must observe the fixture through ui_tree")
          controller.signal.throwIfAborted()
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        } finally {
          active = false
          clearTimeout(timer)
          if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort)
          controller.abort()
          // Drain any abandoned call before scoring/cleanup; cancellation uses the client's guard.
          await inFlight?.catch(() => {})
          if (solver) {
            // The deadline can win before the runner delivers its structured cancellation outcome.
            // Recover only complete, validated usage; never replace the timeout/stop error. External
            // runners need not settle on abort, so do not wait indefinitely for their outcome.
            let drainTimer: ReturnType<typeof setTimeout> | undefined
            try {
              const result = await Promise.race([
                solver.catch(() => undefined),
                new Promise<undefined>((resolve) => {
                  drainTimer = setTimeout(() => resolve(undefined), 50)
                }),
              ])
              if (result) usage = validateUsage(result.usage)
            } catch {
              // Invalid or absent late usage stays unknown; the original trial error takes precedence.
            } finally {
              clearTimeout(drainTimer)
            }
          }
        }
        const durationMs = Math.max(0, dependencies.now() - started)
        if (fixture.stopped()) error ??= stoppedMessage
        let success = false
        if (!error) {
          try {
            success = await fixture.verify()
          } catch (cause) {
            error = `Verification failed: ${cause instanceof Error ? cause.message : String(cause)}`
          }
        }
        if (fixture.stopped()) {
          aborted = stoppedMessage
          error ??= stoppedMessage
          success = false
        }
        trials.push({
          task: task.id,
          mode,
          runner: runner.name,
          model: runner.model,
          success,
          steps,
          screenshotObservations: screenshots,
          durationMs,
          usage,
          ...(error ? { error } : {}),
        })
      } finally {
        clearTimeout(timer)
        controller.abort()
        options.signal?.removeEventListener("abort", abort)
        try {
          // Do not leave an owned desktop form alive while an external provider drains.
          await fixture?.close()
        } finally {
          await runner.close?.()
        }
      }
      // Include stops delivered while cleanup drains; never auto-resume or launch another form.
      if (fixture?.stopped()) aborted = stoppedMessage
      if (aborted) break evaluation
    }
  }
  return {
    benchmark: "D113",
    tasks: TASKS,
    trials,
    summary: aggregateTrials(trials),
    ...(aborted ? { aborted } : {}),
  }
}

async function createDesktopFixture(task: EvalTask, mode: EvalMode): Promise<EvalFixture> {
  // Importing core installs process services: even these imports stay behind the opt-in gate.
  const [{ EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry }, { setup }] = await Promise.all([
    import("@amira/core"),
    import("../src/extension.ts"),
  ])
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "amira-uia-eval-"))
  const title = `Amira-UIA-eval-${crypto.randomUUID()}`
  const settings = {
    enabled: true,
    overlay: true,
    screenshot: mode === "screenshot+tree",
    screenshotMaxEdge: 1280,
    treeDensityThreshold: 0,
  }
  const registry = new ToolRegistry()
  const host = new ExtensionHost({
    bus: new EventBus(),
    tools: registry,
    interceptors: new InterceptorRegistry(),
    cwd: directory,
    settings: { extensions: { "computer-use-uia": settings } },
    settingsLayers: {
      extensions: [{ scope: "user", file: "eval:in-memory", value: { "computer-use-uia": settings } }],
    },
    // Avoid even defaulting settings persistence to ~/.amira.
    settingsSources: { cwd: directory, home: directory },
  })
  let client: ReturnType<typeof setup>
  const close = async () => {
    try {
      await client?.stop()
    } finally {
      host.unload("eval:uia")
    }
    // Preserve any diagnostic state if exact process cleanup failed.
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const loaded = await host.load((api) => {
      client = setup(api)
    }, "eval:uia")
    if (!loaded || !client) throw new Error("Evaluation extension did not load")
    const c = client
    const launched = (await c.call("launch", {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${import.meta.dir}/../helper/eval-window.ps1`,
        "-AllowDesktop",
        "-Title",
        title,
        "-Task",
        task.id,
      ],
    })) as { pid: number }
    // Never enumerate/log other window titles. PID + unique title, not an arbitrary discovery match.
    const result = (await c.call("windows", { filter: title })) as {
      windows: { window: string; pid: number; title: string }[]
    }
    const matches = result.windows.filter((entry) => entry.pid === launched.pid && entry.title === title)
    if (matches.length !== 1) throw new Error("Expected exactly one owned evaluation form")
    const window = matches[0]!.window
    await c.call("focus", { window })
    return {
      window,
      tools: ["ui_tree", "ui_click", "ui_scroll", "ui_type", "ui_key", "ui_focus"].map((name) => {
        const tool = registry.get(name)
        if (!tool) throw new Error(`Missing evaluation tool ${name}`)
        return tool
      }),
      async verify() {
        const tree = (await c.call("tree", { window })) as { text: string }
        // Only the form's own validation handler can produce this exact accessible label.
        return tree.text
          .split("\n")
          .some((line) => line.includes(` Text name="Evaluation passed: ${task.id}"`))
      },
      close,
      stopped: () => c.emergency.stopped,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const options: EvalOptions = { allowDesktop: args.includes("--allow-desktop"), env }
  assertDesktopAllowed(options)
  const runnerFlag = args.indexOf("--runner")
  const runnerPath = runnerFlag >= 0 ? args[runnerFlag + 1] : undefined
  if (runnerFlag >= 0 && (!runnerPath || runnerPath.startsWith("--")))
    throw new Error("Usage: bun run eval:desktop --allow-desktop [--runner ./runner.ts]")
  const { pathToFileURL } = await import("node:url")
  const { resolve } = await import("node:path")
  const module = runnerPath
    ? await import(pathToFileURL(resolve(runnerPath)).href)
    : await import("./eval-runner.ts")
  if (typeof module.createRunner !== "function")
    throw new Error("Runner must export createRunner(): EvalRunner")
  const controller = new AbortController()
  const stop = () => controller.abort(new Error("Evaluation interrupted"))
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const report = await runEvaluation(
      { ...options, signal: controller.signal },
      {
        createRunner: () => (runnerPath ? module.createRunner() : module.createRunner({ env })),
        createFixture: createDesktopFixture,
        now: () => performance.now(),
      },
    )
    console.log(JSON.stringify(report, null, 2))
    if (report.aborted) process.exitCode = 1
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
