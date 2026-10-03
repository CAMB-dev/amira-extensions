import { expect, test } from "bun:test"
import type { ToolContext, ToolResult } from "@amira/api"
import { readSettings } from "../src/limits.ts"
import { type MemberWorkflowSettings, MemberWorkflows } from "../src/workflows.ts"
import { workflowRunner } from "./workflow-fake.ts"

const textOf = (result: ToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("")

function harness(limits: Partial<MemberWorkflowSettings> = {}) {
  const service = workflowRunner()
  const boards: string[] = []
  const messages: { owner: string; text: string }[] = []
  let live = true
  const workflows = new MemberWorkflows(
    service.runner,
    { enabled: true, maxRunning: 3, maxPerMember: 1, ...limits },
    {
      board: (value) => boards.push(value),
      result: (owner, text) => messages.push({ owner, text }),
      changed: () => {},
      canStart: () => live,
    },
  )
  const ctx = (owner: string, signal = new AbortController().signal) =>
    ({ signal, session: { sessionId: `session-${owner}` } }) as ToolContext
  const call = (owner: string, tool: string, params = {}, context = ctx(owner)) =>
    workflows
      .tools(owner)
      .find((t) => t.name === tool)!
      .execute(params, context)
  return {
    ...service,
    workflows,
    boards,
    messages,
    ctx,
    call,
    start: (owner = "writer") => call(owner, "start_workflow", { name: "check" }),
    ending: () => {
      live = false
    },
  }
}

test("member workflow settings default on and validate independent limits", () => {
  expect(readSettings(undefined).memberWorkflows).toEqual({ enabled: true, maxRunning: 3, maxPerMember: 1 })
  expect(
    readSettings({ memberWorkflows: { enabled: false, maxRunning: 5, maxPerMember: 2 } }).memberWorkflows,
  ).toEqual({ enabled: false, maxRunning: 5, maxPerMember: 2 })
  for (const memberWorkflows of [null, [], "yes", false]) {
    const errors: string[] = []
    expect(readSettings({ memberWorkflows }, (error) => errors.push(error)).memberWorkflows).toEqual({
      enabled: true,
      maxRunning: 3,
      maxPerMember: 1,
    })
    expect(errors).toHaveLength(1)
  }
  const errors: string[] = []
  const settings = readSettings(
    { memberWorkflows: { enabled: "yes", maxRunning: 0, maxPerMember: Infinity } },
    (error) => errors.push(error),
  )
  expect(settings.memberWorkflows).toEqual({ enabled: true, maxRunning: 3, maxPerMember: 1 })
  expect(errors).toHaveLength(3)
})

test("members get their own non-mainOnly tools only while enabled", () => {
  expect(harness({ enabled: false }).workflows.tools("writer")).toEqual([])
  const tools = harness().workflows.tools("writer")
  expect(tools.map((tool) => tool.name)).toEqual(["start_workflow", "workflow_status", "stop_workflow"])
  expect(tools.every((tool) => !tool.mainOnly)).toBe(true)
})

test("pending confirmations atomically reserve the per-member slot and appear on the board", async () => {
  const h = harness()
  const pending = h.pending()
  const start = h.start()
  expect(h.workflows.runningFor("writer")).toBe(true)
  expect(h.boards.at(-1)).toBe("writer: awaiting start (check)")
  const blocked = await h.start()
  expect(blocked.isError).toBe(true)
  expect(textOf(blocked)).toContain("writer: awaiting start")
  expect(textOf(blocked)).toContain("send_message")
  expect(textOf(blocked)).toContain('"workflows" board')
  expect(h.starts).toHaveLength(1)
  expect(textOf(await h.call("writer", "workflow_status"))).toContain("awaiting start")
  pending.resolve({ runId: "wf1" })
  expect((await start).isError).not.toBe(true)
  expect(h.boards.at(-1)).toBe("writer: wf1 (check)")
  await h.workflows.stop()
})

test("concurrent members cannot exceed the swarm limit, including pending starts", async () => {
  const h = harness()
  const pending = h.pending()
  const calls = [h.start("a"), h.start("b"), h.start("c"), h.start("d")]
  const blocked = await calls[3]!
  expect(blocked.isError).toBe(true)
  expect(textOf(blocked)).toContain("a: awaiting start")
  expect(textOf(blocked)).toContain("3 per swarm, 1 per member")
  expect(h.starts).toHaveLength(3)
  pending.resolve({ runId: "wf1" })
  await Promise.all(calls)
  const active = await h.start("d")
  expect(textOf(active)).toContain("a: wf1")
  expect(textOf(active)).toContain("b: wf2")
  h.finish("wf2")
  expect((await h.start("d")).isError).not.toBe(true)
  expect(h.starts).toHaveLength(4)
  await h.workflows.stop()
})

test("custom per-member and swarm caps both apply", async () => {
  const h = harness({ maxRunning: 3, maxPerMember: 2 })
  await Promise.all([h.start("writer"), h.start("writer"), h.start("reviewer")])
  expect((await h.start("writer")).isError).toBe(true)
  h.finish("wf3")
  expect((await h.start("writer")).isError).toBe(true)
  expect((await h.start("reviewer")).isError).not.toBe(true)
  await h.workflows.stop()
})

for (const failure of ["decline", "throw"] as const) {
  test(`a ${failure} releases its reservation and allows a retry`, async () => {
    const h = harness()
    const pending = h.pending()
    const start = h.start()
    if (failure === "decline") pending.resolve({ error: "Not confirmed" })
    else pending.reject(new Error("Service unavailable"))
    expect((await start).isError).toBe(true)
    expect(h.workflows.runningFor("writer")).toBe(false)
    expect(h.boards.at(-1)).toBe("No member workflows running.")
    expect((await h.start()).isError).not.toBe(true)
    await h.workflows.stop()
  })
}

test("requests carry the member context, args and attribution; status and stop are owner-only", async () => {
  const h = harness()
  const ctx = h.ctx("writer")
  await h.call(
    "writer",
    "start_workflow",
    { script: "export default async () => 42", args: { count: 2 } },
    ctx,
  )
  expect(h.starts[0]!.request).toEqual({
    script: "export default async () => 42",
    args: { count: 2 },
    startedBy: { sessionId: "session-writer", label: "writer" },
  })
  expect(h.starts[0]!.ctx.session).toBe(ctx.session)
  expect(textOf(await h.call("writer", "workflow_status", { runId: "wf1" }))).toContain('"status":"running"')
  expect(textOf(await h.call("reviewer", "workflow_status"))).toBe("You have not started a workflow.")
  for (const tool of ["workflow_status", "stop_workflow"]) {
    expect((await h.call("reviewer", tool, { runId: "wf1" })).isError).toBe(true)
  }
  expect(h.stops).toHaveLength(0)
  expect(textOf(await h.call("writer", "stop_workflow", { runId: "wf1" }))).toContain("Stopping workflow wf1")
  expect(h.stops).toEqual(["wf1"])
  expect(h.workflows.runningFor("writer")).toBe(false)
  expect(h.messages[0]!.owner).toBe("writer")
  expect(h.messages[0]!.text).toContain("aborted")
  expect(textOf(await h.call("writer", "workflow_status"))).toContain('"status":"aborted"')
})

for (const status of ["done", "error"]) {
  test(`${status} updates the board and notifies only its owner once`, async () => {
    const h = harness()
    await h.start("writer")
    await h.start("reviewer")
    h.finish("wf1", status, status === "error" ? "Check failed" : { answer: 42 })
    h.finish("wf1", status)
    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]!.owner).toBe("writer")
    expect(h.messages[0]!.text).toContain(
      status === "error" ? "Error: Check failed" : 'Result: {"answer":42}',
    )
    expect(h.boards.at(-1)).toBe("reviewer: wf2 (check)")
    expect(h.workflows.runningFor("writer")).toBe(false)
    expect(h.workflows.runningFor("reviewer")).toBe(true)
    expect(h.listeners.get("wf1")!.size).toBe(0)
    await h.workflows.stop()
  })
}

test("a result completed before subscription is replayed and releases the slot", async () => {
  const h = harness()
  h.next(async () => {
    h.finish("wf1", "done", "fast result")
    return { runId: "wf1" }
  })
  await h.start()
  expect(h.messages).toEqual([{ owner: "writer", text: 'Workflow wf1 (check) done.\nResult: "fast result"' }])
  expect(h.listeners.get("wf1")!.size).toBe(0)
  expect(h.workflows.runningFor("writer")).toBe(false)
  expect(h.boards.at(-1)).toBe("No member workflows running.")
  expect((await h.start()).isError).not.toBe(true)
  await h.workflows.stop()
})

test("swarm stop cancels established runs and aborts pending confirmations", async () => {
  const h = harness()
  await h.start("writer")
  h.next(
    (_request, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ error: "Cancelled" }), { once: true })
      }),
  )
  const pending = h.start("reviewer")
  await h.workflows.stop()
  expect((await pending).isError).toBe(true)
  expect(h.starts[1]!.ctx.signal.aborted).toBe(true)
  expect(h.stops).toEqual(["wf1"])
  expect(h.workflows.runningFor("writer")).toBe(false)
  expect(h.workflows.runningFor("reviewer")).toBe(false)
  expect(h.messages).toHaveLength(0)
  expect(h.boards.at(-1)).toBe("No member workflows running.")
  const writes = h.boards.length
  h.finish("wf1", "error", "Late failure")
  expect(h.boards).toHaveLength(writes)
  expect((await h.start()).isError).toBe(true)
  expect(h.starts).toHaveLength(2)
  await h.workflows.stop()
  expect(h.stops).toEqual(["wf1"])
})

test("stop waits for a racing confirmation and cancels the newly returned run", async () => {
  const h = harness()
  const pending = h.pending()
  const start = h.start()
  let stopped = false
  const stop = h.workflows.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(h.starts[0]!.ctx.signal.aborted).toBe(true)
  pending.resolve({ runId: "wf1" })
  await stop
  expect((await start).isError).toBe(true)
  expect(h.stops).toEqual(["wf1"])
  expect(h.messages).toHaveLength(0)
  expect(h.boards.at(-1)).toBe("No member workflows running.")
})

test("cancelling a member tool aborts its pending confirmation and releases the slot", async () => {
  const h = harness()
  const abort = new AbortController()
  h.next(
    (_request, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ error: "Cancelled" }), { once: true })
      }),
  )
  const start = h.call("writer", "start_workflow", { name: "check" }, h.ctx("writer", abort.signal))
  abort.abort()
  expect((await start).isError).toBe(true)
  expect(h.starts[0]!.ctx.signal.aborted).toBe(true)
  expect(h.workflows.runningFor("writer")).toBe(false)
  expect((await h.start()).isError).not.toBe(true)
  await h.workflows.stop()
})

test("cancelled tool contexts and stopping members cannot leak runs", async () => {
  const h = harness()
  const abort = new AbortController()
  abort.abort()
  expect(
    (await h.call("writer", "start_workflow", { name: "check" }, h.ctx("writer", abort.signal))).isError,
  ).toBe(true)
  expect(h.starts).toHaveLength(0)
  const pending = h.pending()
  const start = h.start()
  h.ending()
  pending.resolve({ runId: "wf1" })
  expect((await start).isError).toBe(true)
  expect(h.stops).toEqual(["wf1"])
  expect((await h.start()).isError).toBe(true)
  expect(h.starts).toHaveLength(1)
})
