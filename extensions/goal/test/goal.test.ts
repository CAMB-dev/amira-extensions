import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { Agent, EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { AgentTree, ExtensionHost } from "@amira/host"
import { parseGoalArgs } from "../src/args.ts"
import goalExtension from "../src/index.ts"
import type { GoalRunResult, GoalStatusSnapshot } from "../src/types.ts"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setupHost(
  steps: MockStep[],
  opts: {
    onCommand?: (argv: string[]) => Promise<{ exitCode: number; output: string }>
    pairPeers?: { name: string; role: string }[]
    spentUsd?: () => number
  } = {},
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-goal-test-"))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    bus,
    interceptors,
    tools,
    tree,
    sections: [{ name: "identity", text: "You are a test agent." }],
  })
  const host = new ExtensionHost({
    bus,
    interceptors,
    tools,
    ai,
    cwd,
    frontend: "print",
    settings: {},
    conversations: { ai, tools, tree, home: cwd, agent: () => agent },
  })
  const sessionData = new Map<string, unknown[]>()
  const sessionControl = {
    info: () => ({
      id: agent.sessionId,
      cwd,
      model: { provider: "mock", model: "test" },
      thinking: undefined,
      fastMode: { requested: false, applied: false },
      contextWindow: 128_000,
      busy: agent.busy,
      shell: "sh" as const,
      permissions: { mode: "auto" as const, rules: 0 },
    }),
    trace: async () => [],
    messages: () => agent.messages,
    replies: () => [],
    subagents: () => [],
    subagentMessages: () => undefined,
    stopSubagent: () => false,
    messageSubagent: () => false,
    pauseSubagent: () => false,
    resumeSubagent: () => false,
    models: () => ["mock/test"],
    setModel: () => {},
    setThinking: () => {},
    setFastMode: () => {},
    newSession: async () => {},
    sessions: () => [],
    send: async (text: string) => {
      await agent.prompt(text)
    },
    usage: () => {
      const cost = opts.spentUsd?.() ?? 0
      const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      return {
        sessionId: agent.sessionId,
        revision: 1,
        own: { usage: empty, knownCostUsd: cost, complete: true },
        total: { usage: empty, knownCostUsd: cost, complete: true },
        descendants: [],
      }
    },
    data: {
      append: (key: string, val: unknown) => {
        const list = sessionData.get(key) ?? []
        list.push(val)
        sessionData.set(key, list)
      },
      read: (key: string) => sessionData.get(key) ?? [],
    },
    createGroup: (groupOpts: Parameters<typeof tree.createGroup>[1]) => tree.createGroup(agent, groupOpts),
  }
  host.setSessionControl(sessionControl as never, () => agent)

  if (opts.pairPeers) {
    await host.load((api) => {
      api.provideService("pair.peers" as never, (() => opts.pairPeers) as never)
    }, "mock-pair")
  }

  const onCommand = opts.onCommand ?? (async () => ({ exitCode: 1, output: "not a git repository" }))
  await host.load((api) => {
    const wrapped = {
      ...api,
      runCommand: async (argv: string[]) => {
        const r = await onCommand(argv)
        return {
          exitCode: r.exitCode,
          output: r.output,
          timedOut: false,
          aborted: false,
          truncated: false,
          signalCode: null,
          settled: true,
          contained: true,
        }
      },
    }
    return goalExtension(wrapped)
  }, "goal")

  cleanups.push(async () => {
    await host.unload("goal")
    await agent.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  return { host, agent, mock, cwd, sessionControl }
}

test("parseGoalArgs parses flags, quoted prompts, subcommands, and rejects invalid values", () => {
  expect(parseGoalArgs("")).toEqual({ kind: "dock" })
  expect(parseGoalArgs("status")).toEqual({ kind: "status" })
  expect(parseGoalArgs("pause")).toEqual({ kind: "pause" })
  expect(parseGoalArgs("resume")).toEqual({ kind: "resume" })
  expect(parseGoalArgs("stop done enough")).toEqual({ kind: "stop", reason: "done enough" })
  expect(parseGoalArgs("edit add All tests pass")).toEqual({
    kind: "edit",
    action: "add",
    value: "All tests pass",
  })

  const start = parseGoalArgs(
    '"Refactor auth layer" --verify "bun test" --verify "bun run typecheck" --mode fresh --judge llm --max 8 --budget $1.5 --now',
  )
  expect(start).toEqual({
    kind: "start",
    prompt: "Refactor auth layer",
    mode: "fresh",
    verifyCommands: ["bun test", "bun run typecheck"],
    judge: "llm",
    maxIterations: 8,
    budgetUsd: 1.5,
    requireCompleteTool: true,
    noChecklist: true,
  })

  expect(() => parseGoalArgs("fix --max 0")).toThrow(/Invalid --max/)
  expect(() => parseGoalArgs("fix --mode bad")).toThrow(/Invalid --mode/)
  expect(() => parseGoalArgs("fix --budget -2")).toThrow(/Invalid --budget/)
})

test("session mode blocks premature stops until goal_complete and --verify command pass", async () => {
  let verifyCalls = 0
  const { host, mock } = await setupHost(
    [
      // Attempt 1: stops without calling goal_complete -> blocked
      { text: "I made some progress, let me pause here." },
      // Attempt 2: calls goal_complete, but verify fails -> blocked
      { toolCalls: [{ id: "tc1", name: "goal_complete", args: { summary: "Fixed auth" } }] },
      { text: "Done!" },
      // Attempt 3: fixes issue, calls goal_complete, verify passes -> completed!
      { toolCalls: [{ id: "tc2", name: "goal_complete", args: { summary: "Fixed auth and tests" } }] },
      { text: "All green!" },
    ],
    {
      onCommand: async (argv) => {
        if (argv[0] === "git") return { exitCode: 1, output: "" }
        verifyCalls++
        if (verifyCalls === 1) return { exitCode: 1, output: "FAIL auth.test.ts: expected 200 got 401" }
        return { exitCode: 0, output: "2 pass, 0 fail" }
      },
    },
  )

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const result = await runGoal({
    prompt: "Fix auth tests",
    verifyCommands: ["bun test"],
    maxIterations: 10,
  })

  expect(result.status).toBe("completed")
  expect(result.iterations).toBe(3)
  expect(verifyCalls).toBe(2)
  // Verify system prompt received the injected goal section.
  expect(mock.requests[0]?.systemPrompt).toContain("Active Goal")
  expect(mock.requests[0]?.systemPrompt).toContain("bun test")
})

test("stuck detection triggers 1 reflection retry after 3 identical failures then pauses", async () => {
  const { host } = await setupHost(
    [
      { text: "still broken 1" },
      { text: "still broken 2" },
      { text: "still broken 3" },
      { text: "tried new approach 4" },
      { text: "still broken 5" },
      { text: "still broken 6" },
      { text: "still broken 7" },
    ],
    {
      onCommand: async (argv) => {
        if (argv[0] === "git") return { exitCode: 0, output: "M file.ts" }
        return { exitCode: 1, output: "same error every time" }
      },
    },
  )

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const statusFn = host.services.get("goal.status") as () => GoalStatusSnapshot | undefined
  const result = await runGoal({
    prompt: "Fix flaky test",
    verifyCommands: ["bun test"],
    requireCompleteTool: false,
    maxIterations: 12,
  })

  // 3 failures -> reflection prompt (iter 3), then 3 more failures -> pause (iter 6).
  expect(result.status).toBe("paused")
  expect(result.iterations).toBe(6)
  expect(result.summary).toContain("stuck after strategy shift")
  expect(statusFn()?.phase).toBe("paused")
})

test("budget cap pauses goal before exceeding spend limit", async () => {
  let spend = 0
  const { host } = await setupHost([{ text: "step 1" }, { text: "step 2" }], {
    spentUsd: () => {
      spend += 0.6
      return spend
    },
  })

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const result = await runGoal({
    prompt: "Expensive refactor",
    budgetUsd: 0.5,
    maxIterations: 10,
  })

  expect(result.status).toBe("paused")
  expect(result.summary).toContain("Budget cap reached")
})

test("LLM judge verifies semantic completion via api.complete", async () => {
  const { host } = await setupHost([
    // Iteration 1 main reply
    { text: "Drafted half of it." },
    // Iteration 1 LLM judge reply
    { text: '{"ok": false, "reason": "Missing edge case handling", "nextStep": "Add null check"}' },
    // Iteration 2 main reply
    { text: "Added null check and verified." },
    // Iteration 2 LLM judge reply
    { text: '{"ok": true, "reason": "All edge cases handled."}' },
  ])

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const result = await runGoal({
    prompt: "Handle null inputs cleanly",
    judge: "llm",
    requireCompleteTool: false,
    maxIterations: 5,
  })

  expect(result.status).toBe("completed")
  expect(result.iterations).toBe(2)
})

test("fresh Ralph mode executes clean ephemeral OwnedConversation iterations", async () => {
  let checks = 0
  const { host } = await setupHost([{ text: "iter 1 work" }, { text: "iter 2 work done" }], {
    onCommand: async (argv) => {
      if (argv[0] === "git") return { exitCode: 1, output: "" }
      checks++
      return checks === 1 ? { exitCode: 1, output: "fail once" } : { exitCode: 0, output: "ok" }
    },
  })

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const result = await runGoal({
    prompt: "Long autonomous migration",
    mode: "fresh",
    verifyCommands: ["bun test"],
    requireCompleteTool: false,
    maxIterations: 5,
  })

  expect(result.status).toBe("completed")
  expect(result.iterations).toBe(2)
  expect(checks).toBe(2)
})

test("Goal injects connected pair teammates into system prompt for autonomous clarification", async () => {
  const { host, mock } = await setupHost([{ text: "Done!" }], {
    pairPeers: [{ name: "alice", role: "pm" }],
  })

  const runGoal = host.services.get("goal.run") as (req: unknown) => Promise<GoalRunResult>
  const result = await runGoal({
    prompt: "Implement checkout timeout",
    requireCompleteTool: false,
    maxIterations: 3,
  })

  expect(result.status).toBe("completed")
  expect(mock.requests[0]?.systemPrompt).toContain("alice (pm)")
  expect(mock.requests[0]?.systemPrompt).toContain("pair_ask")
})
