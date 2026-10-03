import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@amira/api"
import {
  connectDashboardSource,
  createSwarmSource,
  type DashboardSource,
  type DashboardSources,
} from "../src/dashboard.ts"
import { createSwarmExtension } from "../src/index.ts"
import { type MemberView, type SwarmRecord, type SwarmSnapshot, swarmsFromRecords } from "../src/swarm.ts"

const member = (name: string, extra: Partial<MemberView> = {}): MemberView => ({
  name,
  role: "researcher",
  status: "working",
  turns: 1,
  messagesSent: 0,
  ...extra,
})

const snapshot = (members: MemberView[]): SwarmSnapshot => ({
  id: "sw1",
  goal: "Compare options",
  state: "running",
  startedAt: 10,
  members,
  board: [{ key: "findings", value: "Option A", by: "a", at: 15, writes: 1 }],
  timeline: [{ seq: 1, at: 20, kind: "message", from: "a", to: "b", text: "Please review" }],
  messages: 1,
})

const textOf = (details: ReturnType<DashboardSource["details"]>, key: "summary" | "logs") =>
  details?.[key]
    .map((line) => (line.kind === "segments" ? line.parts.map((part) => part.text).join("") : line.text))
    .join("\n") ?? ""

test("swarm source uses only supported fields and shows roles, paused states and own metrics", () => {
  const swarm = snapshot([
    member("a", {
      status: "paused",
      brief: "Read the specification",
      sessionId: "child-a",
      lastMessage: "Waiting for review",
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0 },
      tokens: 13,
      cost: 0,
      durationMs: 0,
      startedAt: 10,
    }),
    member("b", { status: "ended", outcome: "error", error: "Model unavailable", cost: undefined }),
    member("c", { status: "ended", outcome: "aborted", error: "Stopped by user" }),
    member("d", { status: "ended", outcome: "done" }),
    member("e", { status: "queued", cost: Number.NaN, durationMs: -1 }),
    member("f", { status: "idle" }),
    member("g", { status: "ended" }),
    member("h"),
  ])
  const { source } = createSwarmSource("workspace", () => [swarm, { ...swarm, id: "sw2" }])
  const output = source.snapshot()
  expect(output.phases.map((phase) => phase.id)).toEqual(["sw1", "sw2"])
  const agents = output.phases[0]!.groups[0]!.agents
  expect(agents[0]).toEqual({
    id: "sw1:a",
    name: "a (researcher)",
    task: "Read the specification",
    status: "paused",
    startedAt: 10,
    durationMs: 0,
    cost: 0,
    files: [],
    actions: [],
  })
  expect(agents.map((agent) => agent.status)).toEqual([
    "paused",
    "failed",
    "stopped",
    "done",
    "queued",
    "idle",
    "stopped",
    "running",
  ])
  expect(agents[1]).not.toHaveProperty("cost")
  expect(agents[4]).not.toHaveProperty("cost")
  expect(agents[4]).not.toHaveProperty("durationMs")
  expect(source).not.toHaveProperty("act")
  expect(
    new Set(output.phases.flatMap((phase) => phase.groups[0]!.agents.map((agent) => agent.id))).size,
  ).toBe(16)
  const details = source.details("sw1:a")!
  expect(Object.keys(details).sort()).toEqual(["logs", "summary"])
  expect(textOf(details, "summary")).toContain("Session ID: child-a")
  expect(textOf(details, "summary")).toContain("13 tokens · $0.000000 · 0 ms")
  expect(textOf(details, "summary")).toContain("Waiting for review")
  expect(textOf(details, "logs")).toContain("Blackboard\nfindings")
  expect(textOf(details, "logs")).toContain("Option A")
  expect(textOf(details, "logs")).toContain("a → b: Please review")
  expect(textOf(source.details("sw1:b"), "summary")).toContain("Error: Model unavailable")
  expect(textOf(source.details("sw1:b"), "summary")).toContain("Cost unknown")
  expect(textOf(source.details("sw1:b"), "summary")).toContain("Session ID: unknown")
  expect(source.details("missing")).toBeUndefined()
})

test("live notifications unsubscribe and detail logs are bounded", () => {
  let current = snapshot([member("a")])
  current.timeline = Array.from({ length: 250 }, (_, index) => ({
    seq: index + 1,
    at: index,
    kind: "note",
    text: `entry ${index}`,
  }))
  const { source, changed } = createSwarmSource("workspace", () => [current])
  let notifications = 0
  const unsubscribe = source.subscribe!(() => {
    notifications++
  })
  expect(source.snapshot().phases[0]!.groups[0]!.agents[0]!.status).toBe("running")
  current = { ...current, members: [member("a", { status: "paused" })] }
  changed()
  expect(notifications).toBe(1)
  expect(source.snapshot().phases[0]!.groups[0]!.agents[0]!.status).toBe("paused")
  expect(textOf(source.details("sw1:a"), "logs")).toContain("Timeline (last 200 of 250)")
  expect(textOf(source.details("sw1:a"), "logs")).not.toContain("entry 49\n")
  unsubscribe()
  unsubscribe()
  changed()
  expect(notifications).toBe(1)
})

test("historical source reconstructs new totals and keeps old or interrupted records unknown", () => {
  const start: SwarmRecord = {
    type: "start",
    swarm: "sw1",
    goal: "Goal",
    at: 10,
    members: [{ name: "a", role: "writer", brief: "Write", sessionId: "child-a" }],
  }
  const end: SwarmRecord = {
    type: "end",
    swarm: "sw1",
    reason: "Finished",
    at: 40,
    report: "Legacy text",
    tokens: 14,
    messages: 2,
    members: [
      {
        name: "a",
        role: "writer",
        sessionId: "child-a",
        status: "error",
        text: "Last reply",
        turns: 3,
        messagesSent: 2,
        error: "Timeout",
        tokens: 14,
        durationMs: 30,
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }
  const records = JSON.parse(JSON.stringify([start, end]))
  const restored = swarmsFromRecords(records)
  const source = createSwarmSource("workspace", () => restored).source
  expect(restored[0]!.members[0]).toMatchObject({
    status: "ended",
    outcome: "error",
    sessionId: "child-a",
    error: "Timeout",
    turns: 3,
  })
  expect(restored[0]!.tokens).toBe(14)
  expect(source.snapshot().phases[0]!.groups[0]!.agents[0]).toMatchObject({
    status: "failed",
    durationMs: 30,
  })
  expect(textOf(source.details("sw1:a"), "summary")).toContain("14 tokens · Cost unknown · 30 ms")
  const oldStart: SwarmRecord = { ...start, members: [{ name: "a", role: "writer", brief: "Write" }] }
  const oldEnd: SwarmRecord = { type: "end", swarm: "sw1", reason: "Ended", at: 40, report: "Old report" }
  for (const old of [[oldStart, oldEnd], [oldStart]]) {
    const past = swarmsFromRecords(old)
    const oldSource = createSwarmSource("workspace", () => past).source
    expect(oldSource.snapshot().phases[0]!.groups[0]!.agents[0]).not.toHaveProperty("cost")
    expect(past[0]!.members[0]!.sessionId).toBeUndefined()
    expect(past[0]!.members[0]!.usage).toBeUndefined()
    expect(textOf(oldSource.details("sw1:a"), "summary")).toContain("Tokens unknown")
    expect(textOf(oldSource.details("sw1:a"), "summary")).toContain("Duration unknown")
  }
})

function fakeApi() {
  const services = new Map<string, unknown>()
  const loaded: (() => void)[] = []
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const emit = (type: string, event: unknown) => {
    for (const handler of handlers.get(type) ?? []) handler(event)
  }
  const exits: (() => void)[] = []
  const api = {
    cwd: "workspace",
    useService: (key: string) => services.get(key),
    provideService(key: string, value: unknown) {
      services.set(key, value)
      return () => {
        if (services.get(key) === value) services.delete(key)
      }
    },
    on(type: string, callback: (event: unknown) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), callback])
      if (type === "extension.loaded") loaded.push(() => callback(undefined))
    },
    onExit(callback: () => void) {
      exits.push(callback)
    },
  } as unknown as ExtensionAPI
  return { api, services, loaded, exits, emit }
}

function fakeRegistry() {
  let source: DashboardSource | undefined
  let registered = 0
  let removed = 0
  let changes = 0
  const service: DashboardSources = {
    register(next) {
      if (source) throw new Error("duplicate")
      registered++
      source = next
      const unsubscribe = next.subscribe?.(() => {
        changes++
      })
      return () => {
        if (source !== next) return
        source = undefined
        removed++
        unsubscribe?.()
      }
    },
  }
  return {
    service,
    get source() {
      return source
    },
    get registered() {
      return registered
    },
    get removed() {
      return removed
    },
    get changes() {
      return changes
    },
  }
}

test("optional registration handles absence, late load, replacement, unload and exit", () => {
  const { api, services, loaded, exits } = fakeApi()
  const { source, changed } = createSwarmSource("workspace", () => [snapshot([member("a")])])
  const connection = connectDashboardSource(api, source)
  try {
    connection.sync() // Dashboard not installed: no failure.
    const first = fakeRegistry()
    services.set("dashboard.sources", first.service)
    loaded.forEach((notify) => {
      notify()
    })
    expect(first.registered).toBe(1)
    connection.sync()
    expect(first.registered).toBe(1)
    changed()
    expect(first.changes).toBe(1)
    services.delete("dashboard.sources")
    connection.sync()
    expect(first.removed).toBe(1)
    changed()
    expect(first.changes).toBe(1)
    const replacement = fakeRegistry()
    services.set("dashboard.sources", replacement.service)
    connection.sync()
    expect(replacement.source?.snapshot().phases).toHaveLength(1)
    const stale = replacement.source!
    // Host unload removes the lease before the timer gets a chance to clean up.
    services.delete("swarm.dashboardSource")
    expect(stale.snapshot().phases).toEqual([])
    expect(stale.details("sw1:a")).toBeUndefined()
    changed()
    expect(replacement.changes).toBe(0)
    connection.sync()
    expect(replacement.removed).toBe(1)
    exits.forEach((exit) => {
      exit()
    })
    connection.dispose()
    expect(replacement.removed).toBe(1)
  } finally {
    connection.dispose()
  }
})

test("reload retries a duplicate registration until the old lease releases it", () => {
  const { api, services } = fakeApi()
  const registry = fakeRegistry()
  services.set("dashboard.sources", registry.service)
  const { source } = createSwarmSource("workspace", () => [])
  const old = connectDashboardSource(api, source)
  const next = connectDashboardSource(api, source)
  try {
    expect(registry.registered).toBe(1)
    old.sync()
    next.sync()
    expect(registry.registered).toBe(2)
    expect(registry.removed).toBe(1)
    next.dispose()
    expect(registry.removed).toBe(2)
  } finally {
    old.dispose()
    next.dispose()
  }
})

test("exit releases a live registration and older hosts can omit service support", () => {
  const { api, services, exits } = fakeApi()
  const registry = fakeRegistry()
  services.set("dashboard.sources", registry.service)
  const { source } = createSwarmSource("workspace", () => [])
  const connection = connectDashboardSource(api, source)
  try {
    expect(registry.registered).toBe(1)
    exits.forEach((exit) => {
      exit()
    })
    expect(registry.removed).toBe(1)
    expect(services.has("swarm.dashboardSource")).toBe(false)
  } finally {
    connection.dispose()
  }
  const older = connectDashboardSource({ cwd: "workspace" } as ExtensionAPI, source)
  older.sync()
  older.dispose()
})

test("the extension caches history outside source reads and refreshes on session lifecycle events", async () => {
  const { api, services, exits, emit } = fakeApi()
  const registry = fakeRegistry()
  services.set("dashboard.sources", registry.service)
  let records: SwarmRecord[] = [
    {
      type: "start",
      swarm: "saved",
      goal: "Saved goal",
      at: 10,
      members: [{ name: "writer", role: "writer", brief: "Write", sessionId: "saved-child" }],
    },
    { type: "end", swarm: "saved", reason: "Done", at: 20, report: "Saved report" },
  ]
  let sessionId = "current"
  let reads = 0
  const noop = () => () => {}
  Object.assign(api, {
    settings: {},
    session: () => ({
      info: () => ({ id: sessionId }),
      data: {
        read: () => {
          reads++
          return records
        },
      },
    }),
    requestRender: () => {},
    registerCommand: noop,
    registerInputHandler: noop,
    registerView: noop,
    registerTool: noop,
    registerStatusItem: noop,
  })
  try {
    await createSwarmExtension()(api)
    expect(registry.source?.id).toBe("swarm")
    const initialReads = reads
    expect(initialReads).toBeGreaterThan(0)
    expect(registry.source?.snapshot().phases[0]?.name).toBe("saved · Saved goal")
    expect(textOf(registry.source?.details("saved:writer"), "summary")).toContain("saved-child")
    registry.source?.snapshot()
    expect(reads).toBe(initialReads)
    // Reloading the current session refreshes even when its ID stays the same.
    emit("session.start", { sessionId })
    expect(reads).toBe(initialReads + 1)
    // Switching to an empty current session must not retain the previous historical snapshot.
    records = []
    sessionId = "next"
    emit("session.start", { sessionId })
    expect(registry.source?.snapshot().phases).toEqual([])
    expect(registry.source?.details("saved:writer")).toBeUndefined()
    expect(reads).toBe(initialReads + 2)
  } finally {
    exits.forEach((exit) => {
      exit()
    })
  }
})
