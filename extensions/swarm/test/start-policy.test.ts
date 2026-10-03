import { afterEach, expect, test } from "bun:test"
import type {
  AnyEvent,
  ChildSession,
  ExtensionAPI,
  PermissionMode,
  SpawnGroup,
  SpawnOptions,
  SubagentResult,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UserMessage,
} from "@amira/api"
import { createSwarmExtension } from "../src/index.ts"
import { readSettings } from "../src/limits.ts"
import type { SwarmRecord } from "../src/swarm.ts"
import type { WorkflowRunner } from "../src/workflows.ts"
import { workflowRunner } from "./workflow-fake.ts"

const members = [
  { name: "writer", role: "writer", brief: "Write the proposal" },
  { name: "reviewer", role: "reviewer", brief: "Review the proposal" },
]
const textOf = (result: ToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Public API fake: members keep working until stopped; no model or core host is needed. */
async function harness(
  opts: {
    mode?: PermissionMode
    enabled?: string
    answer?: boolean
    session?: "missing" | "unavailable"
    runner?: WorkflowRunner
    memberWorkflows?: { enabled?: boolean; maxRunning?: number; maxPerMember?: number }
    idle?: boolean
  } = {},
) {
  let mode = opts.mode
  let tool!: ToolDefinition
  const confirmations: string[] = []
  const notices: string[] = []
  const inboxes = new Map<string, UserMessage[]>()
  const spawnOptions = new Map<string, SpawnOptions>()
  const records: SwarmRecord[] = []
  const handlers = new Map<string, (event: AnyEvent) => void>()
  const groups: Promise<void>[] = []
  let spawned = 0
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const createGroup = (): SpawnGroup => {
    let end!: () => void
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    groups.push(ended)
    return {
      spawn: (options: SpawnOptions) => {
        const inbox: UserMessage[] = []
        inboxes.set(options.title!, inbox)
        spawnOptions.set(options.title!, options)
        let idle = opts.idle ?? false
        const id = `child-${++spawned}`
        let finish!: (result: SubagentResult) => void
        let stopped = false
        const result = new Promise<SubagentResult>((resolve) => {
          finish = resolve
        })
        const stop = () => {
          stopped = true
          finish({ sessionId: id, status: "done", text: "Done", usage, steps: 1, durationMs: 0 })
        }
        return {
          id,
          get state() {
            return stopped ? "ended" : idle ? "idle" : "working"
          },
          turns: 1,
          pendingNotices: 0,
          events: {
            [Symbol.asyncIterator]: () => ({
              next: async (): Promise<IteratorResult<AnyEvent>> => {
                await result
                return { done: true, value: undefined }
              },
            }),
          },
          result: () => result,
          send: (message: UserMessage) => {
            if (stopped) return false
            inbox.push(message)
            idle = false
            return true
          },
          stop,
          abort: stop,
        } as ChildSession
      },
      info: () => ({ tokens: 0 }),
      end: () => end(),
      ended: async () => {
        await ended
        return { tokens: 0 }
      },
    } as unknown as SpawnGroup
  }
  const api = {
    cwd: process.cwd(),
    settings: {
      extensions: {
        swarm: {
          ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
          ...(opts.memberWorkflows ? { memberWorkflows: opts.memberWorkflows } : {}),
        },
      },
    },
    useService: (name: string) => (name === "workflow.runner" ? opts.runner : undefined),
    ...(opts.session === "missing"
      ? {}
      : {
          session: () =>
            opts.session === "unavailable"
              ? undefined
              : { info: () => ({ id: "root", ...(mode ? { permissions: { mode, rules: 0 } } : {}) }) },
        }),
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmations.push(message)
        return opts.answer
      },
    },
    notify: (text: string) => {
      notices.push(text)
    },
    reportError: (problem: string) => {
      throw new Error(problem)
    },
    requestRender: () => {},
    registerCommand: () => {},
    registerInputHandler: () => {},
    registerView: () => {},
    registerStatusItem: () => {},
    registerTool: (registered: ToolDefinition) => {
      tool = registered
    },
    on: (name: string, handler: (event: AnyEvent) => void) => {
      handlers.set(name, handler)
    },
  } as unknown as ExtensionAPI
  await createSwarmExtension()(api)
  const ctx = {
    cwd: process.cwd(),
    toolCallId: "start",
    signal: new AbortController().signal,
    update: () => {},
    session: {
      sessionId: "root",
      depth: 0,
      createGroup,
      data: {
        append: (_key: string, record: SwarmRecord) => records.push(record),
        read: () => records,
      },
    },
  } as unknown as ToolContext
  const stop = async () => {
    await tool.execute({ action: "stop" }, ctx)
    await Promise.all(groups)
  }
  cleanups.push(stop)
  return {
    confirmations,
    notices,
    inboxes,
    records,
    spawnOptions,
    memberTool: (owner: string, name: string, params = {}) => {
      const memberTool = spawnOptions.get(owner)!.extraTools!.find((tool) => tool.name === name)!
      return memberTool.execute(params, {
        ...ctx,
        session: { ...ctx.session!, sessionId: `session-${owner}`, depth: 1 },
      })
    },
    tool,
    execute: (params: { action: string; to?: string; text?: string }) => tool.execute(params, ctx),
    get spawned() {
      return spawned
    },
    setMode: (value: PermissionMode) => {
      mode = value
    },
    start: (goal = "Compare options", limits?: Record<string, number>) =>
      tool.execute({ action: "start", goal, members, ...(limits ? { limits } : {}) }, ctx),
    stop,
    prompt: (text: string) =>
      handlers.get("turn.start")?.({
        type: "turn.start",
        sessionId: "root",
        seq: 1,
        ts: 0,
        data: { prompt: { role: "user", content: [{ type: "text", text }] } },
      }),
  }
}

test("tool pause/resume holds a member's messages without confirmation", async () => {
  const h = await harness({ mode: "edits", answer: true })
  await h.start()
  expect(h.tool.mainOnly).toBe(true)
  expect(textOf(await h.execute({ action: "pause", to: "writer" }))).toBe("Paused writer.")
  expect(textOf(await h.execute({ action: "status" }))).toContain("paused")
  await h.execute({ action: "message", to: "writer", text: "Wait for review" })
  await h.execute({ action: "message", to: "reviewer", text: "Review now" })
  expect(h.inboxes.get("writer")).toHaveLength(0)
  expect(h.inboxes.get("reviewer")).toHaveLength(1)
  expect(textOf(await h.execute({ action: "resume", to: "writer" }))).toBe("Resumed writer.")
  expect(h.inboxes.get("writer")).toHaveLength(1)
  expect(h.confirmations).toHaveLength(1)
})

for (const to of [undefined, "all", "ALL"]) {
  test(`tool pause/resume ${to ?? "without a target"} controls the whole swarm`, async () => {
    const h = await harness({ mode: "edits", answer: true })
    await h.start()
    const target = to === undefined ? {} : { to }
    expect(textOf(await h.execute({ action: "pause", ...target }))).toContain("Paused swarm")
    expect(textOf(await h.execute({ action: "status" }))).toContain("· paused ·")
    expect(textOf(await h.execute({ action: "message", to: "all", text: "Hold this" }))).toBe(
      "Sent to all (2 members).",
    )
    for (const inbox of h.inboxes.values()) expect(inbox).toHaveLength(0)
    expect(textOf(await h.execute({ action: "resume", ...target }))).toContain("Resumed swarm")
    expect(textOf(await h.execute({ action: "status" }))).toContain("· running ·")
    for (const inbox of h.inboxes.values()) expect(inbox).toHaveLength(1)
    expect(h.confirmations).toHaveLength(1)
  })
}

test("tool broadcast attributes one recorded message to the commander and charges each recipient", async () => {
  const h = await harness({ mode: "auto" })
  await h.start()
  expect(textOf(await h.execute({ action: "message", to: "ALL", text: "Share findings" }))).toBe(
    "Sent to all (2 members).",
  )
  for (const inbox of h.inboxes.values()) {
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.content).toEqual([
      { type: "text", text: "[message from the commander, to every member] Share findings" },
    ])
  }
  expect(h.records.filter((record) => record.type === "message")).toEqual([
    expect.objectContaining({ from: "commander", to: "all", text: "Share findings" }),
  ])
  expect(textOf(await h.execute({ action: "status" }))).toContain("· 2 messages ·")
  const empty = await h.execute({ action: "message", to: "all", text: " " })
  expect(empty.isError).toBe(true)
  expect(textOf(empty)).toContain("empty")
  for (const inbox of h.inboxes.values()) expect(inbox).toHaveLength(1)
})

test("tool broadcast cannot bypass message limits or partially deliver", async () => {
  const h = await harness({ mode: "auto" })
  await h.start("Compare options", { max_messages: 2 })
  await h.execute({ action: "message", to: "writer", text: "First" })
  const result = await h.execute({ action: "message", to: "all", text: "Too many" })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("too few messages")
  expect(h.inboxes.get("writer")).toHaveLength(1)
  expect(h.inboxes.get("reviewer")).toHaveLength(0)
  expect(textOf(await h.execute({ action: "status" }))).toContain("· 1 messages ·")
})

test("tool broadcasts are not progress and respect each recipient's exchange limit", async () => {
  const h = await harness({ mode: "auto" })
  await h.start()
  for (let i = 0; i < readSettings(undefined).limits.maxPairExchanges; i++) {
    expect((await h.execute({ action: "message", to: "reviewer", text: "More?" })).isError).not.toBe(true)
  }
  const result = await h.execute({ action: "message", to: "all", text: "More for everyone?" })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("You and reviewer have exchanged")
  expect(h.inboxes.get("writer")).toHaveLength(0)
  const other = await harness({ mode: "auto" })
  await other.start()
  for (let i = 0; i < readSettings(undefined).limits.maxPairExchanges; i++) {
    expect((await other.execute({ action: "message", to: "all", text: "More?" })).isError).not.toBe(true)
  }
  expect((await other.execute({ action: "message", to: "writer", text: "Again?" })).isError).toBe(true)
})

test("tool stop_member stops only its target; stopping controls never confirm", async () => {
  const h = await harness({ mode: "edits", answer: true })
  await h.start()
  expect(textOf(await h.execute({ action: "stop_member", to: "writer" }))).toBe("Stopping writer.")
  expect(h.records).toContainEqual(
    expect.objectContaining({ type: "stop-member", member: "writer", reason: "stopped by the commander" }),
  )
  expect((await h.execute({ action: "message", to: "writer", text: "Too late" })).isError).toBe(true)
  expect(textOf(await h.execute({ action: "message", to: "all", text: "Continue" }))).toBe(
    "Sent to all (1 member).",
  )
  expect(h.inboxes.get("writer")).toHaveLength(0)
  expect(h.inboxes.get("reviewer")).toHaveLength(1)
  expect(textOf(await h.execute({ action: "stop" }))).toContain("Stopping swarm")
  await h.stop()
  expect(h.records).toContainEqual(
    expect.objectContaining({ type: "end", reason: "stopped by the commander" }),
  )
  expect(h.confirmations).toHaveLength(1)
})

test("tool controls reject invalid targets without stopping the swarm", async () => {
  const h = await harness({ mode: "auto" })
  await h.start()
  for (const action of ["pause", "resume", "stop_member", "message"]) {
    const result = await h.execute({ action, to: "missing", text: "Hello" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No member "missing"')
  }
  for (const to of [undefined, "", "all", "ALL"]) {
    const result = await h.execute({ action: "stop_member", ...(to === undefined ? {} : { to }) })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('"to" must name one member')
  }
  for (const action of ["pause", "resume"]) {
    expect((await h.execute({ action, to: "" })).isError).toBe(true)
  }
  expect(textOf(await h.execute({ action: "status" }))).toContain("· running ·")
  expect(h.records.some((record) => record.type === "stop-member")).toBe(false)
  expect(h.confirmations).toHaveLength(0)
})

test("settings default to mode, accept explicit mode, and preserve legacy mappings", () => {
  expect(readSettings(undefined).enabled).toBe("mode")
  expect(readSettings({ enabled: "mode" }).enabled).toBe("mode")
  expect(readSettings({ enabled: "mode", confirm: false }).enabled).toBe("mode")
  expect(readSettings({ confirm: false }).enabled).toBe("always")
  expect(readSettings({ confirm: true }).enabled).toBe("ask")
  expect(readSettings({ enabled: "explicit" }).enabled).toBe("ask")
})

for (const enabled of [undefined, "mode"]) {
  for (const mode of ["auto", "edits", "plan"] as const) {
    test(`${enabled ?? "default"} in ${mode} follows the permission mode`, async () => {
      const h = await harness({ enabled, mode, answer: true })
      expect(textOf(await h.start())).toContain("Started swarm")
      expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
      expect(h.spawned).toBe(2)
      if (mode === "auto") {
        expect(h.notices).toHaveLength(1)
        expect(h.notices[0]).toContain("started without asking: permission mode is auto")
      } else expect(h.notices).toEqual([])
    })
  }
}

test("permission mode is read again for each start, not cached when the extension loads", async () => {
  const h = await harness({ mode: "edits", answer: true })
  h.setMode("auto")
  await h.start()
  expect(h.confirmations).toHaveLength(0)
  await h.stop()
  h.setMode("edits")
  await h.start()
  expect(h.confirmations).toHaveLength(1)
  await h.stop()
  h.setMode("auto")
  await h.start()
  expect(h.confirmations).toHaveLength(1)
  expect(h.notices).toHaveLength(2)
})

for (const session of [undefined, "missing", "unavailable"] as const) {
  test(`missing ${session ?? "permission info"} falls back to asking`, async () => {
    const h = await harness({ session, answer: false })
    expect(textOf(await h.start())).toContain("The user declined")
    expect(h.confirmations).toHaveLength(1)
    expect(h.spawned).toBe(0)
    expect(h.notices.join("\n")).not.toContain("permission mode is auto")
  })
}

for (const mode of ["auto", "edits", "plan"] as const) {
  for (const enabled of ["ask", "always", "never"] as const) {
    test(`explicit ${enabled} overrides permission mode ${mode}`, async () => {
      const h = await harness({ enabled, mode, answer: false })
      const result = await h.start()
      expect(h.confirmations).toHaveLength(enabled === "ask" ? 1 : 0)
      expect(h.spawned).toBe(enabled === "always" ? 2 : 0)
      expect(textOf(result)).toContain(
        enabled === "always" ? "Started swarm" : enabled === "never" ? "turned off" : "The user declined",
      )
      expect(h.notices.join("\n")).not.toContain("permission mode is auto")
    })
  }
}

for (const mode of ["auto", "edits", "plan"] as const) {
  test(`print mode with no dialog answer ${mode === "auto" ? "starts" : "refuses"} in ${mode}`, async () => {
    const h = await harness({ mode })
    const result = await h.start()
    expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
    expect(h.spawned).toBe(mode === "auto" ? 2 : 0)
    expect(textOf(result)).toContain(mode === "auto" ? "Started swarm" : "Nobody confirmed the swarm")
  })
}

for (const mode of ["auto", "edits", "plan"] as const) {
  test(`a user-requested swarm follows the same start policy in ${mode}`, async () => {
    const h = await harness({ mode, answer: false })
    h.prompt("Use a swarm to compare options")
    const result = await h.start()
    expect(h.spawned).toBe(mode === "auto" ? 2 : 0)
    expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
    if (mode !== "auto") {
      expect(h.confirmations[0]).toContain("You asked for this swarm.")
      expect(textOf(result)).toContain("The user declined")
    }
  })
}

test("switching to auto does not bypass a previous decline for the same goal", async () => {
  const h = await harness({ mode: "edits", answer: false })
  await h.start()
  h.setMode("auto")
  expect(textOf(await h.start())).toContain("already declined")
  expect(h.spawned).toBe(0)
  h.prompt("Use a swarm to compare options")
  expect(textOf(await h.start())).toContain("Started swarm")
  expect(h.spawned).toBe(2)
  expect(h.confirmations).toHaveLength(1)
})

for (const available of [false, true]) {
  for (const enabled of [false, true]) {
    test(`member workflow tools require service=${available} and enabled=${enabled}`, async () => {
      const service = workflowRunner()
      const h = await harness({
        mode: "auto",
        ...(available ? { runner: service.runner } : {}),
        memberWorkflows: { enabled },
      })
      await h.start()
      for (const options of h.spawnOptions.values()) {
        expect(options.excludeTools).toEqual(["swarm", "workflow"])
        const tools = options.extraTools!.filter((tool) => tool.name.includes("workflow"))
        expect(tools.map((tool) => tool.name)).toEqual(
          available && enabled ? ["start_workflow", "workflow_status", "stop_workflow"] : [],
        )
        expect(tools.every((tool) => !tool.mainOnly)).toBe(true)
      }
    })
  }
}

test("available service enables member workflows by default and settings reach the limit guard", async () => {
  const service = workflowRunner()
  const h = await harness({ mode: "auto", runner: service.runner, memberWorkflows: { maxRunning: 1 } })
  await h.start()
  await h.memberTool("writer", "start_workflow", { name: "check" })
  const blocked = await h.memberTool("reviewer", "start_workflow", { name: "check" })
  expect(blocked.isError).toBe(true)
  expect(textOf(blocked)).toContain("writer: wf1")
  expect(service.starts).toHaveLength(1)
})

for (const status of ["done", "error"]) {
  test(`member workflow ${status} is recorded on the board and delivered only to its owner`, async () => {
    const service = workflowRunner()
    const h = await harness({ mode: "auto", runner: service.runner })
    await h.start()
    await h.memberTool("writer", "start_workflow", { name: "check" })
    expect(textOf(await h.memberTool("reviewer", "blackboard_read", { key: "workflows" }))).toContain(
      "writer: wf1 (check)",
    )
    expect(
      (await h.memberTool("writer", "blackboard_write", { key: "workflows", value: "hide runs" })).isError,
    ).toBe(true)
    service.finish("wf1", status, "check output")
    expect(h.inboxes.get("writer")).toHaveLength(1)
    expect(h.inboxes.get("reviewer")).toHaveLength(0)
    expect(h.inboxes.get("writer")![0]!.content).toEqual([
      {
        type: "text",
        text: `[message from workflow] Workflow wf1 (check) ${status}.\n${status === "error" ? "Error: check output" : 'Result: "check output"'}`,
      },
    ])
    expect(h.records.filter((record) => record.type === "board").map((record) => record.write.value)).toEqual(
      ["writer: awaiting start (check)", "writer: wf1 (check)", "No member workflows running."],
    )
    expect(h.records.filter((record) => record.type === "message")).toEqual([
      expect.objectContaining({ from: "workflow", to: "writer" }),
    ])
  })
}

test("pending and running workflows prevent idle swarm shutdown; results wake their member", async () => {
  const service = workflowRunner()
  const h = await harness({ mode: "auto", runner: service.runner, idle: true })
  await h.start()
  const pending = service.pending()
  const start = h.memberTool("writer", "start_workflow", { name: "check" })
  // Resume asks the swarm to reconsider idle shutdown while confirmation is pending.
  await h.execute({ action: "pause" })
  await h.execute({ action: "resume" })
  await Bun.sleep(10)
  expect(h.records.some((record) => record.type === "end")).toBe(false)
  pending.resolve({ runId: "wf1" })
  await start
  await Bun.sleep(10)
  expect(h.records.some((record) => record.type === "end")).toBe(false)
  service.finish("wf1")
  await Bun.sleep(10)
  expect(h.inboxes.get("writer")).toHaveLength(1)
  expect(h.records.some((record) => record.type === "end")).toBe(false)
})

test("a failed pending workflow start releases idle shutdown", async () => {
  const service = workflowRunner()
  const h = await harness({ mode: "auto", runner: service.runner, idle: true })
  await h.start()
  service.next(async () => ({ error: "Not confirmed" }))
  expect((await h.memberTool("writer", "start_workflow", { name: "check" })).isError).toBe(true)
  // Let the swarm's idle recheck run before awaiting group cleanup.
  await Bun.sleep(10)
  expect(h.records.some((record) => record.type === "end")).toBe(true)
})

test("paused owners hold workflow results without ending the idle swarm", async () => {
  const service = workflowRunner()
  const h = await harness({ mode: "auto", runner: service.runner, idle: true })
  await h.start()
  await h.memberTool("writer", "start_workflow", { name: "check" })
  await h.execute({ action: "pause", to: "writer" })
  service.finish("wf1")
  await Bun.sleep(10)
  expect(h.inboxes.get("writer")).toHaveLength(0)
  expect(h.records.some((record) => record.type === "end")).toBe(false)
  await h.execute({ action: "resume", to: "writer" })
  expect(h.inboxes.get("writer")).toHaveLength(1)
})

test("swarm stop cancels member runs and confirmations before recording its final board", async () => {
  const service = workflowRunner()
  const h = await harness({ mode: "auto", runner: service.runner })
  await h.start()
  await h.memberTool("writer", "start_workflow", { name: "check" })
  service.next(
    (_request, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ error: "Cancelled" }), { once: true })
      }),
  )
  const pending = h.memberTool("reviewer", "start_workflow", { name: "check" })
  await h.stop()
  expect((await pending).isError).toBe(true)
  expect(service.stops).toEqual(["wf1"])
  expect(service.starts[1]!.ctx.signal.aborted).toBe(true)
  expect(h.records.at(-1)?.type).toBe("end")
  const lastBoard = h.records.filter((record) => record.type === "board").at(-1)!
  expect(lastBoard.write.value).toBe("No member workflows running.")
  const count = h.records.length
  service.finish("wf1", "error", "Late failure")
  expect(h.records).toHaveLength(count)
  expect(h.inboxes.get("writer")).toHaveLength(0)
})
