import { expect, test } from "bun:test"
import {
  emptyUsage,
  type SessionControl,
  type SessionInfo,
  type SubagentInfo,
  summarizeTrace,
  type TraceRecord,
} from "@amira/api"
import { agentsOf } from "../src/source.ts"
import { createTraceSource } from "../src/trace.ts"

function usage(cost?: number) {
  const value = { ...emptyUsage(), input: 10, output: 5 }
  if (cost === undefined) delete value.cost
  else value.cost = cost
  return value
}

function header(sessionId = "root", startedAt = 0): TraceRecord {
  return { type: "trace", v: 1, sessionId, startedAt }
}

function tool(overrides: Partial<Extract<TraceRecord, { type: "tool" }>> = {}): TraceRecord {
  return {
    type: "tool",
    turnId: "first",
    toolCallId: "call",
    name: "write",
    start: 200,
    end: 400,
    durationMs: 180,
    approvalWaitMs: 50,
    outcome: "ok",
    argsChars: 2,
    resultChars: 5,
    argsPreview: "{}",
    resultPreview: "saved",
    writtenPaths: ["src/main.ts"],
    ...overrides,
  }
}

function child(id: string, overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    id,
    parentSessionId: "root",
    depth: 1,
    role: "coder",
    title: id,
    task: `Task for ${id}`,
    status: "done",
    usage: usage(),
    ...overrides,
  }
}

function completedChild(id: string, cost?: number): TraceRecord {
  return {
    type: "subagent",
    childSessionId: id,
    title: `Recovered ${id}`,
    role: "reviewer",
    start: 300,
    end: 900,
    durationMs: 600,
    status: "done",
    usage: usage(cost),
  }
}

function host(records: Record<string, TraceRecord[]>, descendants: SubagentInfo[] = []) {
  const info: SessionInfo = {
    id: "root",
    title: "Root task",
    cwd: "/project",
    model: { provider: "test", model: "model" },
    contextWindow: 1000,
    busy: false,
    shell: "bash",
  }
  const requested: (string | undefined)[] = []
  const reads = {
    info: () => info,
    subagents: () => descendants,
    trace: async (id?: string) => {
      requested.push(id)
      return records[id ?? info.id] ?? []
    },
  }
  // The adapter needs only the read surface. Missing command methods fail if called.
  const session = reads as unknown as SessionControl
  return { session, reads, info, requested }
}

function fixture(): TraceRecord[] {
  return [
    header(),
    {
      type: "model",
      model: "test/model",
      start: 10,
      firstToken: 40,
      end: 110,
      usage: usage(1),
      retries: [{ at: 20, delayMs: 10, kind: "rate-limit" }],
    },
    { type: "model", model: "test/model", start: 120, end: 200, usage: usage(2) },
    tool(),
    tool({
      toolCallId: "error",
      start: 300,
      end: 500,
      durationMs: 150,
      approvalWaitMs: 20,
      outcome: "error",
      resultPreview: "disk full",
      writtenPaths: ["src/main.ts", "src/other.ts"],
    }),
    tool({
      toolCallId: "denied",
      start: 600,
      end: 620,
      durationMs: 0,
      approvalWaitMs: 20,
      outcome: "denied",
      writtenPaths: [],
    }),
    { type: "turn", turnId: "first", start: 0, end: 1000, reason: "done", steps: 2 },
    completedChild("child", 7),
    { type: "compact", start: 1250, end: 1280, reason: "threshold", usage: usage(0.25) },
    { type: "side", at: 1300, model: "test/model", label: "Title", usage: usage(0.5) },
    {
      type: "turn",
      turnId: "second",
      start: 1200,
      end: 1400,
      reason: "error",
      steps: 1,
      failure: { kind: "provider", message: "unavailable" },
    },
    header("root", 5000),
    { type: "turn", turnId: "resumed", start: 5000, end: 5100, reason: "aborted", steps: 0 },
  ]
}

test("preserves raw per-session timing, first token, overlap, approval, idle, tools, and failures", async () => {
  const records = fixture()
  const source = await createTraceSource(host({ root: records }).session)
  const stats = source.details("root")!.stats!
  expect(stats).toEqual(summarizeTrace(records))
  expect(stats).toMatchObject({
    start: 0,
    end: 5100,
    wallTimeMs: 5100,
    modelTimeMs: 180,
    modelWaitMs: 30,
    modelStreamMs: 70,
    modelUnknownMs: 80,
    toolTimeMs: 320,
    toolDurationMs: 330,
    approvalWaitMs: 90,
    idleMs: 200,
    retries: 1,
  })
  expect(stats.tools.write).toEqual({
    count: 3,
    totalMs: 330,
    avgMs: 110,
    maxMs: 180,
    outcomes: { ok: 1, error: 1, denied: 1, aborted: 0, invalid: 0, "unknown-tool": 0 },
  })
  expect(stats.failures.map((failure) => [failure.type, failure.at])).toEqual([
    ["tool", 500],
    ["tool", 620],
    ["turn", 1400],
    ["turn", 5100],
  ])
  expect(stats.failures[0]).toMatchObject({ outcome: "error", message: "disk full" })
  expect(stats.failures[2]).toMatchObject({ kind: "provider", message: "unavailable" })
  expect(stats.usage.cost).toBe(3.75)
  expect(stats.subagentUsage.cost).toBe(7)
  expect(stats.totalUsage.cost).toBe(10.75)
})

test("keeps every tool disposition and reports chronological failures", async () => {
  const outcomes = ["ok", "error", "denied", "aborted", "invalid", "unknown-tool"] as const
  const records = outcomes
    .map((outcome, index) =>
      tool({
        outcome,
        toolCallId: outcome,
        start: index * 10,
        end: index * 10 + 5,
        durationMs: index,
        approvalWaitMs: undefined,
      }),
    )
    .reverse()
  const source = await createTraceSource(host({ root: records }).session)
  const stats = source.details("root")!.stats!
  expect(stats.tools.write).toEqual({
    count: 6,
    totalMs: 15,
    avgMs: 2.5,
    maxMs: 5,
    outcomes: { ok: 1, error: 1, denied: 1, aborted: 1, invalid: 1, "unknown-tool": 1 },
  })
  expect(stats.failures.map((failure) => failure.at)).toEqual([15, 25, 35, 45, 55])
  expect(stats.toolTimeMs).toBe(30)
  expect(stats.approvalWaitMs).toBe(0)
})

test("traverses listed and recovered descendants once without combining trace costs", async () => {
  const setup = host(
    {
      root: fixture(),
      child: [
        header("child"),
        { type: "model", model: "test/model", start: 0, end: 100, usage: usage(7) },
        completedChild("grandchild", 3),
        completedChild("root", 999),
      ],
      listed: [header("listed"), completedChild("child", 7)],
    },
    [child("child"), child("listed", { depth: 2, parentSessionId: "child" })],
  )
  const source = await createTraceSource(setup.session)
  const snapshot = source.snapshot()
  expect(snapshot.phases).toHaveLength(1)
  expect(snapshot.phases[0]!.groups).toHaveLength(1)
  const agents = agentsOf(snapshot)
  expect(agents.map((agent) => agent.id)).toEqual(["root", "child", "listed", "grandchild"])
  expect(setup.requested).toEqual(["root", "child", "listed", "grandchild"])
  expect(agents.map((agent) => agent.cost)).toEqual([3.75, 7, undefined, 3])
  expect(agents[3]).toMatchObject({ name: "reviewer", task: "Recovered grandchild", durationMs: 600 })
  expect(source.details("root")!.stats!.usage.cost).toBe(3.75)
  expect(source.details("child")!.stats!.usage.cost).toBe(7)
  expect(source.details("child")!.stats!.tools).toEqual({})
  expect(source.details("grandchild")!.stats).toBeUndefined()
})

test("recovers children solely from traces, including when live metadata has gone", async () => {
  const setup = host({
    root: [header(), completedChild("old-child", 2)],
    "old-child": [header("old-child"), completedChild("old-grandchild", 4)],
  })
  const source = await createTraceSource(setup.session)
  expect(setup.requested).toEqual(["root", "old-child", "old-grandchild"])
  expect(agentsOf(source.snapshot()).map((agent) => agent.id)).toEqual([
    "root",
    "old-child",
    "old-grandchild",
  ])
  expect(agentsOf(source.snapshot())[2]!.cost).toBe(4)
})

test("uses reported written paths, never fabricates diffs, and includes recorded log previews", async () => {
  const source = await createTraceSource(host({ root: fixture() }).session)
  const root = agentsOf(source.snapshot())[0]!
  expect(root.files).toEqual([{ path: "src/main.ts" }, { path: "src/other.ts" }])
  expect(root.language).toBe("TypeScript")
  expect(root.progress).toBeUndefined()
  expect(source.details("root")!.logs).toContainEqual({ kind: "text", text: "disk full" })
  expect(source.details("root")!.summary).toContainEqual({ kind: "text", text: "Root task" })
})

test("unknown cost remains unknown even beside known usage or with no usage event", async () => {
  for (const unknown of [usage(), undefined]) {
    const records: TraceRecord[] = [
      header(),
      { type: "model", model: "test/model", start: 0, end: 10, usage: usage(1) },
      { type: "model", model: "test/model", start: 10, end: 20, usage: unknown },
    ]
    const source = await createTraceSource(host({ root: records }).session)
    expect(agentsOf(source.snapshot())[0]!.cost).toBeUndefined()
    expect(source.details("root")!.stats).toEqual(summarizeTrace(records))
    expect(source.details("root")!.summary).toContainEqual({ kind: "text", text: "Own cost: unknown" })
  }
  const zero = await createTraceSource(
    host({ root: [header(), { type: "side", at: 1, model: "test/model", usage: usage(0) }] }).session,
  )
  expect(agentsOf(zero.snapshot())[0]!.cost).toBe(0)
})

test("unknown child cost does not become zero or contaminate the root's own known cost", async () => {
  const records: TraceRecord[] = [
    header(),
    { type: "model", model: "test/model", start: 0, end: 100, usage: usage(1) },
    completedChild("unknown"),
  ]
  const source = await createTraceSource(host({ root: records }).session)
  expect(agentsOf(source.snapshot()).map((agent) => agent.cost)).toEqual([1, undefined])
  expect(source.details("root")!.stats!.usage.cost).toBe(1)
  expect(source.details("root")!.stats!.subagentUsage.cost).toBeUndefined()
  expect(source.details("root")!.stats!.totalUsage.cost).toBeUndefined()
})

test("empty and missing traces retain unknown data and only use a child's own fallback usage", async () => {
  const source = await createTraceSource(
    host({}, [child("known", { usage: usage(2) }), child("unknown")]).session,
  )
  expect(agentsOf(source.snapshot()).map((agent) => agent.cost)).toEqual([undefined, 2, undefined])
  for (const id of ["root", "known", "unknown"]) {
    expect(source.details(id)!.stats).toBeUndefined()
    expect(source.details(id)!.logs).toEqual([])
  }
  expect(source.snapshot().note).toContain("completed intervals only")
  expect(source.snapshot().note).toContain("No trace records for 3 session(s)")
  expect(source.details("missing")).toBeUndefined()
  const headerOnly = await createTraceSource(host({ root: [header()] }).session)
  expect(agentsOf(headerOnly.snapshot())[0]!.cost).toBeUndefined()
  expect(headerOnly.details("root")!.stats!.wallTimeMs).toBe(0)
})

test("a failed trace read or mismatched header is missing data, not a zero-cost session", async () => {
  const setup = host({ root: [header("another-session")] }, [child("broken", { usage: usage(8) })])
  const read = setup.reads.trace
  setup.reads.trace = async (id) => {
    if (id === "broken") throw new Error("cannot read trace")
    return read(id)
  }
  const source = await createTraceSource(setup.session)
  expect(source.details("root")!.stats).toBeUndefined()
  expect(source.details("broken")!.stats).toBeUndefined()
  expect(agentsOf(source.snapshot()).map((agent) => agent.cost)).toEqual([undefined, 8])
})

test("replay is deeply immutable, detached from input, and exposes no live actions", async () => {
  const records = fixture()
  const listed = child("child", { usage: usage(7) })
  const setup = host({ root: records }, [listed])
  const source = await createTraceSource(setup.session)
  const snapshot = source.snapshot()
  const stats = source.details("root")!.stats!
  expect(source.id).toBe("trace")
  expect(source.act).toBeUndefined()
  expect(source.subscribe).toBeUndefined()
  expect(agentsOf(snapshot).every((agent) => agent.actions.length === 0)).toBe(true)
  expect(Object.isFrozen(source)).toBe(true)
  expect(Object.isFrozen(snapshot.phases[0]!.groups[0]!.agents)).toBe(true)
  expect(Object.isFrozen(stats.tools.write!.outcomes)).toBe(true)
  expect(Object.isFrozen(source.details("root")!.logs)).toBe(true)
  expect(() => agentsOf(snapshot)[0]!.files.push({ path: "injected" })).toThrow()
  expect(() => {
    stats.tools.write!.count = 100
  }).toThrow()
  records.push(tool({ writtenPaths: ["later.ts"] }))
  listed.task = "Changed task"
  setup.info.cwd = "/another-project"
  setup.info.id = "other"
  expect(source.snapshot()).toBe(snapshot)
  expect(snapshot.workspace).toBe("/project")
  expect(agentsOf(snapshot)[1]!.task).toBe("Task for child")
  expect(stats.tools.write!.count).toBe(3)
  expect(Object.isFrozen(records)).toBe(false)
})

test("replay retains parent-qualified spawn and tool-call groups", async () => {
  const recovered: TraceRecord = {
    type: "subagent",
    childSessionId: "recovered",
    groupId: "spawn",
    start: 1,
    end: 2,
    durationMs: 1,
    status: "done",
  }
  const setup = host({ root: [header(), recovered] }, [
    child("first", { toolCallId: "call" }),
    child("second", { toolCallId: "call" }),
    child("nested", { parentSessionId: "first", toolCallId: "call", depth: 2 }),
  ])
  const replay = await createTraceSource(setup.session)
  const groups = replay.snapshot().phases[0]!.groups
  expect(groups.map((group) => group.agents.map((agent) => agent.id))).toEqual([
    ["root"],
    ["first", "second"],
    ["nested"],
    ["recovered"],
  ])
  expect(groups.map((group) => group.ref)).toEqual([undefined, "call", "call", "spawn"])
  expect(groups[1]!.id).not.toBe(groups[2]!.id)
  expect(groups[1]!.agents[0]!.progress).toBe(1)
})

test("a session switch during an awaited read rejects instead of mixing sessions", async () => {
  for (const switchAt of ["root", "child"]) {
    const setup = host({ root: [header()] }, [child("child")])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached!: () => void
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const read = setup.reads.trace
    setup.reads.trace = async (id) => {
      if (id === switchAt) {
        reached()
        await gate
      }
      return read(id)
    }
    const replay = createTraceSource(setup.session)
    await waiting
    setup.info.id = "another-session"
    release()
    await expect(replay).rejects.toThrow("Session changed while loading the trace")
    expect(setup.requested.every((id) => id === "root" || id === "child")).toBe(true)
  }
})
