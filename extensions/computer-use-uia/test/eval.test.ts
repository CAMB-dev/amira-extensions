import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolveModelInfo } from "@amira/ai"
import type { ToolResult } from "@amira/api"
import {
  aggregateTrials,
  assertDesktopAllowed,
  type EvalDependencies,
  type EvalFixture,
  type EvalMode,
  type EvalRunner,
  main,
  runEvaluation,
  TASKS,
  type TokenUsage,
  type TrialResult,
} from "../scripts/eval-desktop.ts"
import { createRunner } from "../scripts/eval-runner.ts"

// Fake-only: importing the harness never imports core or starts helpers/PowerShell/capture.
const consent = { allowDesktop: true, platform: "win32", env: {} }
const usage: TokenUsage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 }

function fake(run?: EvalRunner["run"], imageMode?: EvalMode) {
  const created: string[] = []
  const fixtureCloses: string[] = []
  const runnerCloses: string[] = []
  const actions: string[] = []
  let time = 0
  let runners = 0
  const dependencies: EvalDependencies = {
    now: () => (time += 25),
    createRunner() {
      const id = String(++runners)
      return {
        name: "fake-only",
        model: "fake/model",
        async run(request) {
          if (run) return run(request)
          await request.tools[0]!.execute({ window: request.window })
          await request.tools[1]!.execute({ window: request.window })
          return { usage }
        },
        close() {
          runnerCloses.push(id)
        },
      }
    },
    async createFixture(task, mode) {
      const window = `${task.id}-${mode}`
      created.push(window)
      let clicked = false
      const fixture: EvalFixture = {
        window,
        tools: [
          {
            name: "ui_tree",
            description: "Fake tree",
            parameters: { type: "object" },
            async execute(): Promise<ToolResult> {
              return {
                content: [
                  { type: "text", text: "fake tree" },
                  ...((imageMode ?? mode) === "screenshot+tree"
                    ? [{ type: "image" as const, mimeType: "image/png", data: "fake-not-a-capture" }]
                    : []),
                ],
              }
            },
          },
          {
            name: "ui_click",
            description: "Fake save",
            parameters: { type: "object" },
            async execute() {
              clicked = true
              actions.push(window)
              return { content: [{ type: "text", text: "clicked" }] }
            },
          },
        ],
        async verify() {
          return clicked
        },
        async close() {
          fixtureCloses.push(window)
        },
        stopped: () => false,
      }
      return fixture
    },
  }
  return { dependencies, created, fixtureCloses, runnerCloses, actions }
}

async function rejected(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "resolved",
    (error: unknown) => String(error),
  )
}

test("D113 refuses without exact consent before calling any runner or desktop dependency", async () => {
  const f = fake()
  let calls = 0
  f.dependencies.createRunner = () => {
    calls++
    throw new Error("must not run")
  }
  f.dependencies.createFixture = async () => {
    calls++
    throw new Error("must not run")
  }
  f.dependencies.now = () => {
    calls++
    throw new Error("must not run")
  }
  for (const env of [{}, { AMIRA_UIA_EVAL: "true" }, { AMIRA_UIA_EVAL: "0" }]) {
    expect(await rejected(runEvaluation({ env, platform: "win32" }, f.dependencies))).toContain("refused")
  }
  expect(calls).toBe(0)
  // Even an invalid external module is not imported before the gate.
  expect(await rejected(main(["--runner", "./this-module-must-not-be-imported.ts"], {}))).toContain("refused")
})

test("D113 accepts explicit opt-in, but refuses CI and non-Windows before dependencies", async () => {
  expect(() => assertDesktopAllowed(consent)).not.toThrow()
  expect(() => assertDesktopAllowed({ platform: "win32", env: { AMIRA_UIA_EVAL: "1" } })).not.toThrow()
  const f = fake()
  expect(await rejected(runEvaluation({ ...consent, env: { CI: "true" } }, f.dependencies))).toContain("CI")
  expect(await rejected(runEvaluation({ ...consent, platform: "linux" }, f.dependencies))).toContain(
    "Windows",
  )
  expect(f.created).toEqual([])
  expect(f.runnerCloses).toEqual([])
})

test("six fixed tasks run in both modes, independently graded, with actual usage and counted calls", async () => {
  const f = fake()
  const result = await runEvaluation(consent, f.dependencies)
  expect(TASKS.length).toBeGreaterThanOrEqual(5)
  expect(TASKS.length).toBeLessThanOrEqual(10)
  expect(result.trials).toHaveLength(12)
  expect(new Set(f.created).size).toBe(12)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(12)
  expect(result.trials.slice(0, 4).map((row) => row.mode)).toEqual([
    "tree-only",
    "screenshot+tree",
    "screenshot+tree",
    "tree-only",
  ])
  for (const trial of result.trials) {
    expect(trial).toMatchObject({ success: true, steps: 2, durationMs: 25, usage, model: "fake/model" })
    expect(trial.screenshotObservations).toBe(trial.mode === "screenshot+tree" ? 1 : 0)
  }
  for (const summary of result.summary) {
    expect(summary).toMatchObject({
      trials: 6,
      successes: 6,
      successRate: 1,
      steps: 12,
      meanSteps: 2,
      durationMs: 150,
      meanDurationMs: 25,
      tokens: 810,
      knownTokenSubtotal: 810,
      measuredTokenTrials: 6,
    })
  }
})

test("a runner's completion is not success; only independent fixture state is graded", async () => {
  const f = fake(async (request) => {
    await request.tools[0]!.execute({ window: request.window })
    return { usage: null }
  })
  const result = await runEvaluation(consent, f.dependencies)
  expect(result.trials.every((row) => !row.success && row.steps === 1 && row.usage === null)).toBe(true)
  expect(result.summary.every((row) => row.successRate === 0 && row.tokens === null)).toBe(true)
  expect(f.fixtureCloses).toHaveLength(12)
})

test("structured failed runner outcomes retain measured usage and cannot pass independent scoring", async () => {
  let verifications = 0
  const f = fake(async (request) => {
    await request.tools[0]!.execute({ window: request.window })
    await request.tools[1]!.execute({ window: request.window })
    return { usage, error: "Evaluation model turn budget exceeded (1)" }
  })
  const createFixture = f.dependencies.createFixture
  f.dependencies.createFixture = async (task, mode) => ({
    ...(await createFixture(task, mode)),
    async verify() {
      verifications++
      return true
    },
  })
  const report = await runEvaluation(consent, f.dependencies)
  expect(report.trials).toHaveLength(12)
  for (const trial of report.trials) {
    expect(trial).toMatchObject({
      success: false,
      error: "Evaluation model turn budget exceeded (1)",
      steps: 2,
      usage,
      durationMs: 25,
    })
  }
  expect(verifications).toBe(0)
  expect(report.summary.every((row) => row.successes === 0 && row.tokens === 810)).toBe(true)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(12)
})

test("aggregation never fabricates zero tokens for unknown usage or empty modes", () => {
  const row: TrialResult = {
    task: "profile",
    mode: "tree-only",
    runner: "fake-only",
    model: "fake/model",
    success: true,
    steps: 2,
    screenshotObservations: 0,
    durationMs: 10,
    usage,
  }
  const summary = aggregateTrials([
    row,
    { ...row, task: "unicode", success: false, usage: null, steps: 4, durationMs: 30 },
  ])
  expect(summary[0]).toMatchObject({
    trials: 2,
    successes: 1,
    successRate: 0.5,
    steps: 6,
    meanSteps: 3,
    durationMs: 40,
    meanDurationMs: 20,
    tokens: null,
    knownTokenSubtotal: 135,
    measuredTokenTrials: 1,
  })
  expect(summary[1]).toMatchObject({
    trials: 0,
    successRate: null,
    meanSteps: null,
    meanDurationMs: null,
    tokens: null,
    measuredTokenTrials: 0,
  })
})

test("tools refuse any foreign window before forwarding the call and cleanup always runs", async () => {
  const f = fake(async (request) => {
    await request.tools[0]!.execute({ window: request.window })
    await request.tools[1]!.execute({ window: "not-the-owned-fixture" })
    return { usage }
  })
  const result = await runEvaluation(consent, f.dependencies)
  expect(f.actions).toEqual([])
  expect(result.trials.every((row) => !row.success && row.error?.includes("owned fixture"))).toBe(true)
  expect(result.trials.every((row) => row.steps === 2 && row.usage === null)).toBe(true)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(12)
})

test("missing screenshot cannot silently turn the comparison into two tree-only runs", async () => {
  const f = fake(undefined, "tree-only")
  const result = await runEvaluation(consent, f.dependencies)
  const screenshotRows = result.trials.filter((row) => row.mode === "screenshot+tree")
  expect(screenshotRows.every((row) => !row.success && row.error?.includes("omitted an image"))).toBe(true)
  expect(result.summary[0]!.successRate).toBe(1)
  expect(result.summary[1]!.successRate).toBe(0)
})

test("tree-only refuses accidental images, and both modes require a tree observation", async () => {
  const f = fake(undefined, "screenshot+tree")
  const result = await runEvaluation(consent, f.dependencies)
  expect(
    result.trials
      .filter((row) => row.mode === "tree-only")
      .every((row) => !row.success && row.error?.includes("included an image")),
  ).toBe(true)
  const noObservation = fake(async (request) => {
    await request.tools[1]!.execute({ window: request.window })
    return { usage }
  })
  const empty = await runEvaluation(consent, noObservation.dependencies)
  expect(empty.trials.every((row) => !row.success && row.error?.includes("observe"))).toBe(true)
})

test("step limits and invalid token counters fail instead of reporting invented metrics", async () => {
  const f = fake()
  const limited = await runEvaluation({ ...consent, maxSteps: 1 }, f.dependencies)
  expect(limited.trials.every((row) => !row.success && row.error?.includes("budget"))).toBe(true)
  expect(f.actions).toEqual([])
  const badUsage = fake(async (request) => {
    await request.tools[0]!.execute({ window: request.window })
    return { usage: { ...usage, input: -1 } }
  })
  const bad = await runEvaluation(consent, badUsage.dependencies)
  expect(bad.trials.every((row) => !row.success && row.usage === null && row.error?.includes("token"))).toBe(
    true,
  )
})

test("timeout bounds an uncooperative solver with or without a close hook", async () => {
  for (const close of [false, true]) {
    let aborted = 0
    const f = fake(async (request) => {
      request.signal.addEventListener("abort", () => aborted++, { once: true })
      return new Promise(() => {})
    })
    const createRunner = f.dependencies.createRunner
    f.dependencies.createRunner = async () => {
      const runner = await createRunner()
      return close ? runner : { name: runner.name, model: runner.model, run: runner.run }
    }
    const result = await runEvaluation({ ...consent, timeoutMs: 1 }, f.dependencies)
    expect(aborted).toBe(12)
    expect(
      result.trials.every((row) => !row.success && row.usage === null && row.error?.includes("timed out")),
    ).toBe(true)
    expect(f.fixtureCloses).toEqual(f.created)
    expect(f.runnerCloses).toHaveLength(close ? 12 : 0)
  }
})

test("bounded late outcomes validate counters and never replace the timeout error", async () => {
  for (const measured of [usage, { ...usage, input: -1 }, null]) {
    const f = fake(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => setTimeout(() => resolve({ usage: measured, error: "late runner failure" }), 0),
            { once: true },
          )
        }),
    )
    const report = await runEvaluation({ ...consent, timeoutMs: 1 }, f.dependencies)
    expect(report.trials).toHaveLength(12)
    for (const trial of report.trials) {
      expect(trial).toMatchObject({
        success: false,
        error: "Evaluation task timed out",
        usage: measured === usage ? usage : null,
      })
    }
  }
})

for (const stop of [false, true]) {
  test(`default runner retains fully measured usage after ${stop ? "stop" : "timeout"} cancels a blocked tool`, async () => {
    const f = fake()
    const interrupted = new AbortController()
    let streams = 0
    let toolAborts = 0
    let verifications = 0
    f.dependencies.createRunner = () =>
      createRunner({
        env: {
          AMIRA_UIA_EVAL_MODEL: "fake/model",
          AMIRA_UIA_EVAL_BASE_URL: "https://example.invalid/v1",
          AMIRA_UIA_EVAL_KEYLESS: "1",
        },
        createAi(options) {
          return {
            model: () => resolveModelInfo(options.providers![0]!, "fake/model"),
            async *stream() {
              streams++
              yield {
                type: "done",
                message: {
                  role: "assistant",
                  model: { provider: "uia-eval", model: "fake/model" },
                  content: [
                    {
                      type: "toolCall",
                      id: "blocked-tree",
                      name: "ui_tree",
                      args: { window: "owned-fixture" },
                    },
                  ],
                  usage,
                  stopReason: "toolUse",
                },
              }
            },
          }
        },
      })
    const createFixture = f.dependencies.createFixture
    f.dependencies.createFixture = async (task, mode) => {
      const fixture = await createFixture(task, mode)
      return {
        ...fixture,
        window: "owned-fixture",
        tools: [
          {
            ...fixture.tools[0]!,
            async execute(_params, context) {
              await new Promise<void>((resolve) => {
                context.signal!.addEventListener(
                  "abort",
                  () => {
                    toolAborts++
                    // Cancellation cleanup may complete on a later event-loop turn.
                    setTimeout(resolve, 0)
                  },
                  { once: true },
                )
                if (stop) interrupted.abort(new Error("fake emergency stop"))
              })
              throw new Error("tool cancelled after measured reply")
            },
          },
        ],
        stopped: () => stop && interrupted.signal.aborted,
        async verify() {
          verifications++
          return true
        },
      }
    }
    const report = await runEvaluation(
      { ...consent, timeoutMs: 5, signal: interrupted.signal },
      f.dependencies,
    )
    const count = stop ? 1 : 12
    expect(report.trials).toHaveLength(count)
    for (const trial of report.trials) {
      expect(trial).toMatchObject({
        success: false,
        steps: 1,
        usage,
        error: stop ? "fake emergency stop" : "Evaluation task timed out",
      })
    }
    expect(streams).toBe(count)
    expect(toolAborts).toBe(count)
    expect(verifications).toBe(0)
    expect(f.fixtureCloses).toEqual(f.created)
    if (stop) expect(report.aborted).toContain("without resuming")
    else expect(report.summary.every((row) => row.measuredTokenTrials === 6 && row.tokens === 810)).toBe(true)
  })
}

test("default runner timeout during an unreported request never substitutes an earlier measured turn", async () => {
  const f = fake()
  let requests = 0
  f.dependencies.createRunner = () => {
    let turns = 0
    return createRunner({
      env: {
        AMIRA_UIA_EVAL_MODEL: "fake/model",
        AMIRA_UIA_EVAL_BASE_URL: "https://example.invalid/v1",
        AMIRA_UIA_EVAL_KEYLESS: "1",
      },
      createAi(options) {
        return {
          model: () => resolveModelInfo(options.providers![0]!, "fake/model"),
          async *stream(_request, signal) {
            requests++
            if (++turns === 1) {
              yield {
                type: "done",
                message: {
                  role: "assistant",
                  model: { provider: "uia-eval", model: "fake/model" },
                  content: [
                    {
                      type: "toolCall",
                      id: "measured-tree",
                      name: "ui_tree",
                      args: { window: "owned-fixture" },
                    },
                  ],
                  usage,
                  stopReason: "toolUse",
                },
              }
              return
            }
            await new Promise<void>((resolve) => {
              signal!.addEventListener("abort", () => setTimeout(resolve, 0), { once: true })
            })
            signal!.throwIfAborted()
          },
        }
      },
    })
  }
  const createFixture = f.dependencies.createFixture
  f.dependencies.createFixture = async (task, mode) => ({
    ...(await createFixture(task, mode)),
    window: "owned-fixture",
  })
  const report = await runEvaluation({ ...consent, timeoutMs: 5 }, f.dependencies)
  expect(requests).toBe(24)
  expect(report.trials).toHaveLength(12)
  expect(
    report.trials.every(
      (trial) => !trial.success && trial.usage === null && trial.error === "Evaluation task timed out",
    ),
  ).toBe(true)
  expect(report.summary.every((row) => row.tokens === null && row.knownTokenSubtotal === 0)).toBe(true)
  expect(f.fixtureCloses).toEqual(f.created)
})

test("emergency stop aborts the evaluation without starting or resuming another fixture", async () => {
  const f = fake()
  const createFixture = f.dependencies.createFixture
  let verifications = 0
  f.dependencies.createFixture = async (task, mode) => ({
    ...(await createFixture(task, mode)),
    stopped: () => true,
    async verify() {
      verifications++
      return true
    },
  })
  const report = await runEvaluation(consent, f.dependencies)
  expect(report.aborted).toContain("without resuming")
  expect(report.trials).toHaveLength(1)
  expect(report.trials[0]).toMatchObject({ success: false, usage, steps: 2, durationMs: 25 })
  expect(report.trials[0]!.error).toContain("Desktop control stopped")
  expect(verifications).toBe(0)
  expect(f.created).toHaveLength(1)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(1)
})

test("emergency stop during verification retains report evidence but prevents later launches", async () => {
  const f = fake()
  const createFixture = f.dependencies.createFixture
  f.dependencies.createFixture = async (task, mode) => {
    const fixture = await createFixture(task, mode)
    let stopped = false
    return {
      ...fixture,
      stopped: () => stopped,
      async verify() {
        if (mode === "screenshot+tree") {
          stopped = true
          throw new Error("the user stopped desktop control")
        }
        return fixture.verify()
      },
    }
  }
  const report = await runEvaluation(consent, f.dependencies)
  expect(report.aborted).toContain("without resuming")
  expect(report.trials).toHaveLength(2)
  expect(report.trials[0]!.success).toBe(true)
  expect(report.trials[1]).toMatchObject({
    success: false,
    usage,
    steps: 2,
    durationMs: 25,
    error: "Verification failed: the user stopped desktop control",
  })
  expect(f.created).toHaveLength(2)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(2)
})

test("an emergency stop delivered while cleanup drains still prevents the next launch", async () => {
  const f = fake()
  const createFixture = f.dependencies.createFixture
  f.dependencies.createFixture = async (task, mode) => {
    const fixture = await createFixture(task, mode)
    let stopped = false
    return {
      ...fixture,
      stopped: () => stopped,
      async close() {
        await fixture.close()
        stopped = true
      },
    }
  }
  const report = await runEvaluation(consent, f.dependencies)
  expect(report.aborted).toContain("without resuming")
  expect(report.trials).toHaveLength(1)
  expect(f.created).toHaveLength(1)
  expect(f.fixtureCloses).toEqual(f.created)
  expect(f.runnerCloses).toHaveLength(1)
})

test("fixture startup failures still close owned runners", async () => {
  const startup = fake()
  startup.dependencies.createFixture = async () => {
    throw new Error("fake startup failure")
  }
  expect(await rejected(runEvaluation(consent, startup.dependencies))).toContain("startup failure")
  expect(startup.runnerCloses).toHaveLength(1)
})

test("verification exceptions retain completed trials and failed trial metrics, then continue", async () => {
  const scoring = fake()
  const createFixture = scoring.dependencies.createFixture
  scoring.dependencies.createFixture = async (task, mode) => {
    const fixture = await createFixture(task, mode)
    return {
      ...fixture,
      verify: async () => {
        if (task.id === "profile" && mode === "screenshot+tree")
          throw new Error("fake scoring capture failure")
        return fixture.verify()
      },
    }
  }
  const report = await runEvaluation(consent, scoring.dependencies)
  expect(report.trials).toHaveLength(12)
  expect(report.trials[0]).toMatchObject({ success: true, steps: 2, usage, durationMs: 25 })
  expect(report.trials[1]).toMatchObject({
    success: false,
    error: "Verification failed: fake scoring capture failure",
    steps: 2,
    usage,
    durationMs: 25,
    screenshotObservations: 1,
  })
  expect(report.trials.slice(2).every((trial) => trial.success)).toBe(true)
  expect(report.summary[1]).toMatchObject({ successes: 5, measuredTokenTrials: 6, tokens: 810 })
  expect(scoring.fixtureCloses).toEqual(scoring.created)
  expect(scoring.runnerCloses).toHaveLength(12)
})

test("source contracts only: fixture has its own gate and no live evaluation is added to tests", () => {
  const source = readFileSync(new URL("../scripts/eval-desktop.ts", import.meta.url), "utf8")
  const fixture = readFileSync(new URL("../helper/eval-window.ps1", import.meta.url), "utf8")
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  expect(fixture.indexOf("Desktop evaluation refused")).toBeLessThan(fixture.indexOf("Add-Type"))
  expect(fixture).toContain("[System.Windows.Forms.Application]::Run($form)")
  expect(fixture).toContain("Evaluation passed: ")
  expect(fixture).not.toMatch(/Start-Process|SendKeys|CopyFromScreen|Get-Process/)
  expect(source).toContain('screenshot: mode === "screenshot+tree"')
  expect(source).toContain("treeDensityThreshold: 0")
  expect(source).toContain("settingsSources: { cwd: directory, home: directory }")
  expect(source).toContain('c.call("windows", { filter: title })')
  expect(pkg.scripts.test).not.toContain("eval-desktop")
  expect(pkg.scripts.test).not.toContain("eval-window")
})
