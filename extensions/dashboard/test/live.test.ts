import { expect, test } from "bun:test"
import type {
  AssistantMessage,
  EventEnvelope,
  EventMap,
  ExtensionAPI,
  Message,
  SessionControl,
  SessionInfo,
  SpawnGroupInfo,
  SubagentInfo,
  ViewLine,
} from "@amira/api"
import { createLiveSource } from "../src/live.ts"
import { agentsOf } from "../src/source.ts"
import { performAction } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

const model = { provider: "test", model: "test" }
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  model,
  usage,
  stopReason: "end",
  content: [{ type: "text", text }],
})
const agent = (id: string, overrides: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id,
  parentSessionId: "root",
  depth: 1,
  role: "coder",
  title: id,
  task: `Task for ${id}`,
  status: "running",
  usage,
  ...overrides,
})
const group = (id: string, parentSessionId = "root"): SpawnGroupInfo => ({
  id,
  parentSessionId,
  name: `${parentSessionId} group`,
  state: "active",
  limits: {},
  usage,
  tokens: 0,
  agents: { total: 0, queued: 0, working: 0, idle: 0, ended: 0 },
})
const textOf = (lines: ViewLine[]): string =>
  lines.map((line) => ("text" in line ? line.text : "")).join("\n")

function setup(initial: SubagentInfo[] = [agent("child")], observe = true) {
  let info: SessionInfo = {
    id: "root",
    cwd: "/workspace",
    model,
    contextWindow: 1000,
    busy: false,
    shell: "bash",
  }
  let listed = initial
  let groups: SpawnGroupInfo[] = []
  let renders = 0
  let reads = 0
  let stopResult = true
  const stopped: string[] = []
  const paused: string[] = []
  const resumed: string[] = []
  const sent: { id: string; text: string }[] = []
  let controlResult = true
  const messages = new Map<string, readonly Message[]>()
  const handlers = new Map<keyof EventMap, Set<(event: EventEnvelope) => void>>()
  const bus: Pick<ExtensionAPI, "on"> = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set()
      // The registration key and emit's generic payload guarantee this correspondence.
      const receive = (event: EventEnvelope) => handler(event as EventEnvelope<typeof type>)
      set.add(receive)
      handlers.set(type, set)
      return () => {
        set.delete(receive)
      }
    },
  }
  const session = {
    info: () => info,
    subagents: () => {
      reads++
      return listed
    },
    groups: () => groups,
    subagentMessages: (id: string) => {
      reads++
      return messages.get(id)
    },
    stopSubagent: (id: string) => {
      stopped.push(id)
      return stopResult
    },
    pauseSubagent: (id: string) => {
      paused.push(id)
      return controlResult
    },
    resumeSubagent: (id: string) => {
      resumed.push(id)
      return controlResult
    },
    messageSubagent: (id: string, text: string) => {
      sent.push({ id, text })
      return controlResult
    },
  } satisfies Pick<
    SessionControl,
    | "info"
    | "subagents"
    | "groups"
    | "subagentMessages"
    | "stopSubagent"
    | "pauseSubagent"
    | "resumeSubagent"
    | "messageSubagent"
  >
  // All other SessionControl capabilities are deliberately absent from this adapter fake.
  const source = createLiveSource(session as SessionControl, bus)
  const subscribe = (changed = () => {}) =>
    source.subscribe!(() => {
      renders++
      changed()
    })
  if (observe) subscribe()
  let seq = 0
  function emit<K extends keyof EventMap>(type: K, sessionId: string, data: EventMap[K]) {
    const event: EventEnvelope<K> = { type, sessionId, data, seq: ++seq, ts: seq }
    for (const handler of handlers.get(type) ?? []) handler(event)
  }
  return {
    source,
    emit,
    messages,
    stopped,
    paused,
    resumed,
    sent,
    subscribe,
    controlResult: (result: boolean) => {
      controlResult = result
    },
    setAgents: (next: SubagentInfo[]) => {
      listed = next
    },
    setGroups: (next: SpawnGroupInfo[]) => {
      groups = next
    },
    switchTo: (id: string) => {
      info = { ...info, id, cwd: "/another-workspace" }
    },
    stopResult: (result: boolean) => {
      stopResult = result
    },
    renders: () => renders,
    reads: () => reads,
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

function writeEvent(s: ReturnType<typeof setup>, sessionId: string, paths: string[] = ["src/result.ts"]) {
  s.emit("tool.execute.end", sessionId, {
    toolCallId: "write",
    name: "write",
    durationMs: 1,
    writtenPaths: paths,
    result: { content: [{ type: "text", text: "Saved the change" }] },
  })
}

const start = (childSessionId: string): EventMap["subagent.start"] => ({
  childSessionId,
  prompt: "Work",
  model,
  cwd: "/workspace",
  context: "fresh",
  queued: false,
  depth: 1,
})

test("one Agents phase groups by parent-qualified spawn group or tool call, including inherited groups", () => {
  const s = setup([
    agent("nested", { parentSessionId: "a", depth: 2, groupId: "shared" }),
    agent("a", { groupId: "shared" }),
    agent("b", { groupId: "shared" }),
    agent("parent"),
    agent("other-group", { parentSessionId: "parent", depth: 2, groupId: "shared" }),
    agent("root-call", { toolCallId: "same-call" }),
    agent("child-call", { parentSessionId: "parent", depth: 2, toolCallId: "same-call" }),
  ])
  s.setGroups([group("shared"), group("shared", "parent"), group("empty")])
  const snapshot = s.source.snapshot()
  expect(snapshot.workspace).toBe("/workspace")
  expect(snapshot.phases.map((phase) => phase.name)).toEqual(["Agents"])
  const groups = snapshot.phases[0]!.groups
  expect(groups.find((g) => g.name === "root group" && g.ref === "shared")?.agents.map((a) => a.id)).toEqual([
    "nested",
    "a",
    "b",
  ])
  expect(groups.find((g) => g.name === "parent group")?.agents.map((a) => a.id)).toEqual(["other-group"])
  expect(groups.filter((g) => g.ref === "same-call")).toHaveLength(2)
  expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length)
  expect(groups.find((g) => g.ref === "empty")?.agents).toEqual([])
  s.source.dispose()
})

test("uses authoritative statuses and costs without estimated progress or duration", () => {
  const states: SubagentInfo["status"][] = ["queued", "running", "idle", "paused", "done", "error", "aborted"]
  const s = setup(
    states.map((status) =>
      agent(status, {
        status,
        usage: status === "done" ? { ...usage, cost: 0 } : usage,
        ...(status === "done" ? { durationMs: 10, startedAt: 5 } : {}),
      }),
    ),
  )
  const listed = agentsOf(s.source.snapshot())
  expect(listed.map((a) => a.status)).toEqual([
    "queued",
    "running",
    "idle",
    "paused",
    "done",
    "failed",
    "stopped",
  ])
  expect(listed.map((a) => a.progress)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
  ])
  expect(listed.map((a) => a.cost)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
  ])
  expect(listed[0]?.durationMs).toBeUndefined()
  expect(listed[4]?.durationMs).toBe(10)
  expect(listed[4]?.startedAt).toBe(5)
  expect(listed.map((a) => a.actions)).toEqual([
    ["stop", "request-changes"],
    ["pause", "stop", "request-changes"],
    ["stop", "request-changes"],
    ["resume", "stop", "request-changes"],
    [],
    [],
    [],
  ])
  s.source.dispose()
})

test("notifies for starts, state changes, ends and groups; reads current listings", () => {
  const s = setup([], false)
  let changes = 0
  const unsubscribe = s.subscribe(() => {
    changes++
  })
  s.setAgents([agent("child", { status: "queued" })])
  s.emit("subagent.start", "root", start("child"))
  expect(agentsOf(s.source.snapshot())[0]?.status).toBe("queued")
  s.setAgents([agent("child", { status: "idle" })])
  s.emit("subagent.state", "root", { childSessionId: "child", state: "idle", turns: 1 })
  expect(agentsOf(s.source.snapshot())[0]?.status).toBe("idle")
  s.setAgents([agent("child", { status: "done", durationMs: 40, usage: { ...usage, cost: 0.3 } })])
  s.emit("subagent.end", "root", {
    childSessionId: "child",
    status: "done",
    durationMs: 40,
    usage: { ...usage, cost: 0.3 },
  })
  expect(agentsOf(s.source.snapshot())[0]).toMatchObject({ status: "done", progress: 1, cost: 0.3 })
  s.emit("group.update", "root", { group: group("g") })
  expect(changes).toBe(4)
  expect(s.renders()).toBe(4)
  unsubscribe()
  s.emit("group.end", "root", { group: group("g") })
  expect(changes).toBe(4)
  expect(s.renders()).toBe(4)
  expect(s.listeners()).toBe(0)
  s.source.dispose()
})

test("combines stored child messages, live streaming and tool logs; only end writtenPaths count as files", () => {
  const s = setup()
  s.messages.set("child", [
    { role: "user", content: [{ type: "text", text: "Please fix it" }] },
    assistant("Stored reply"),
  ])
  expect(textOf(s.source.details("child")!.summary)).toBe("Stored reply")
  expect(textOf(s.source.details("child")!.logs)).toContain("Please fix it")
  s.emit("message.start", "child", { model })
  s.emit("message.delta", "child", { kind: "text", text: "Working " })
  s.emit("message.delta", "child", { kind: "text", text: "on it" })
  s.emit("message.delta", "child", { kind: "thinking", text: "Considering the options" })
  expect(textOf(s.source.details("child")!.summary)).toBe("Working on it")
  expect(textOf(s.source.details("child")!.logs)).toContain("Considering the options")
  s.emit("message.end", "child", { message: assistant("Finished reply") })
  expect(textOf(s.source.details("child")!.summary)).toBe("Finished reply")
  s.emit("tool.execute.start", "child", {
    toolCallId: "read",
    name: "read",
    args: { path: "guessed.py" },
    writtenPaths: ["not-finished.py"],
  })
  s.emit("tool.execute.update", "child", {
    toolCallId: "read",
    name: "read",
    partial: { content: [{ type: "text", text: "Read guessed.py" }] },
  })
  s.emit("tool.execute.end", "child", {
    toolCallId: "read",
    name: "read",
    durationMs: 1,
    result: { content: [{ type: "text", text: "Wrote imagined.py" }] },
  })
  expect(agentsOf(s.source.snapshot())[0]?.files).toEqual([])
  writeEvent(s, "child", ["src/result.ts", "src/result.ts", "src/view.tsx"])
  const child = agentsOf(s.source.snapshot())[0]!
  expect(child.files).toEqual([{ path: "src/result.ts" }, { path: "src/view.tsx" }])
  expect(child.files.every((file) => file.diff === undefined)).toBe(true)
  expect(child.language).toBe("TypeScript")
  expect(textOf(s.source.details("child")!.logs)).toContain("read: started")
  expect(textOf(s.source.details("child")!.logs)).toContain("Read guessed.py")
  expect(textOf(s.source.details("child")!.logs)).toContain("write: finished")
  writeEvent(s, "child", ["script.py"])
  expect(agentsOf(s.source.snapshot())[0]?.language).toBeUndefined()
  expect(s.source.details("missing")).toBeUndefined()
  s.source.dispose()
})

test("retains nested descendants but ignores root messages, other roots, orphans and cycles", () => {
  const s = setup([
    agent("grandchild", { parentSessionId: "child", depth: 2 }),
    agent("child"),
    agent("foreign", { parentSessionId: "other-root" }),
    agent("orphan", { parentSessionId: "missing" }),
    agent("cycle-a", { parentSessionId: "cycle-b" }),
    agent("cycle-b", { parentSessionId: "cycle-a" }),
  ])
  s.setGroups([group("foreign", "other-root")])
  expect(agentsOf(s.source.snapshot()).map((a) => a.id)).toEqual(["grandchild", "child"])
  for (const id of ["root", "foreign", "other-root", "orphan", "cycle-a"]) {
    s.emit("message.delta", id, { kind: "text", text: "Private unrelated content" })
    writeEvent(s, id)
    expect(s.source.details(id)).toBeUndefined()
  }
  s.emit("subagent.start", "other-root", start("foreign"))
  expect(s.renders()).toBe(0)
  writeEvent(s, "grandchild", ["nested.rs"])
  s.emit("message.delta", "grandchild", { kind: "text", text: "Nested reply" })
  expect(agentsOf(s.source.snapshot())[0]?.files).toEqual([{ path: "nested.rs" }])
  expect(textOf(s.source.details("grandchild")!.summary)).toBe("Nested reply")
  expect(s.renders()).toBe(2)
  s.source.dispose()
})

test("view actions prompt and dispatch through the live source to SessionControl, showing results", async () => {
  const s = setup()
  const fixture = viewFixture()
  fixture.data.source = s.source
  fixture.data.selected = "child"
  await performAction(fixture.data, fixture.control, "pause")
  expect(s.paused).toEqual(["child"])
  expect(fixture.data.flash).toContain("Pause accepted")
  s.setAgents([agent("child", { status: "paused" })])
  await performAction(fixture.data, fixture.control, "resume")
  expect(s.resumed).toEqual(["child"])
  expect(fixture.data.flash).toBe("Resume accepted.")
  await performAction(fixture.data, fixture.control, "request-changes")
  expect(fixture.control.prompt).toHaveBeenCalledWith("Request changes from child")
  expect(s.sent).toEqual([{ id: "child", text: "Please cover negative refunds." }])
  expect(fixture.data.flash).toContain("Message sent")
  s.controlResult(false)
  await performAction(fixture.data, fixture.control, "request-changes")
  expect(fixture.data.flash).toContain("Not sent")
  s.source.dispose()
})

test("live controls accept pause, resume, stop and messages with accurate state gates", () => {
  const s = setup([
    agent("child"),
    agent("paused", { status: "paused" }),
    agent("queued", { status: "queued" }),
    agent("idle", { status: "idle" }),
    agent("done", { status: "done" }),
  ])
  expect(s.source.act!("child", "pause")).toContain("Pause accepted")
  expect(s.paused).toEqual(["child"])
  expect(s.source.act!("paused", "resume")).toBe("Resume accepted.")
  expect(s.resumed).toEqual(["paused"])
  for (const id of ["child", "paused", "queued", "idle"]) {
    expect(s.source.act!(id, "stop")).toBe("Stop requested.")
    expect(s.source.act!(id, "request-changes", "Try another approach")).toContain("Message sent")
  }
  expect(s.stopped).toEqual(["child", "paused", "queued", "idle"])
  expect(s.sent).toEqual(
    ["child", "paused", "queued", "idle"].map((id) => ({ id, text: "Try another approach" })),
  )
  for (const id of ["paused", "queued", "idle"]) {
    expect(s.source.act!(id, "pause")).toContain("not running")
  }
  expect(s.source.act!("child", "resume")).toContain("not paused")
  expect(s.source.act!("child", "request-changes", "  ")).toContain("Enter a message")
  for (const action of ["pause", "resume", "stop", "request-changes"] as const) {
    expect(s.source.act!("done", action, "Try again")).toContain("already ended")
    expect(s.source.act!("foreign", action, "Try again")).toContain("not found")
  }
  expect(s.paused).toEqual(["child"])
  expect(s.resumed).toEqual(["paused"])
  expect(s.sent).toHaveLength(4)
  s.controlResult(false)
  expect(s.source.act!("child", "pause")).toContain("Pause not accepted")
  expect(s.source.act!("paused", "resume")).toContain("Resume not accepted")
  expect(s.source.act!("child", "request-changes", "Try again")).toContain("Not sent")
  s.stopResult(false)
  expect(s.source.act!("child", "stop")).toContain("could not be stopped")
  s.source.dispose()
})

test("live event listeners exist only while subscribed and last release clears transient details", () => {
  const s = setup(undefined, false)
  expect(s.listeners()).toBe(0)
  s.source.snapshot()
  s.source.details("child")
  writeEvent(s, "child", ["closed.ts"])
  expect(s.renders()).toBe(0)
  const first = s.subscribe()
  const listeners = s.listeners()
  expect(listeners).toBeGreaterThan(0)
  const second = s.subscribe()
  expect(s.listeners()).toBe(listeners)
  writeEvent(s, "child", ["open.ts"])
  expect(agentsOf(s.source.snapshot())[0]?.files).toEqual([{ path: "open.ts" }])
  first()
  first()
  expect(s.listeners()).toBe(listeners)
  second()
  expect(s.listeners()).toBe(0)
  const renders = s.renders()
  writeEvent(s, "child", ["closed-again.ts"])
  expect(s.renders()).toBe(renders)
  const reopened = s.subscribe()
  expect(s.listeners()).toBe(listeners)
  expect(agentsOf(s.source.snapshot())[0]?.files).toEqual([])
  s.source.dispose()
  reopened()
  expect(s.listeners()).toBe(0)
})

test("session switches cannot expose another session or apply stale actions, even with reused child IDs", () => {
  const s = setup()
  writeEvent(s, "child", ["old.ts"])
  s.switchTo("next-root")
  s.setAgents([agent("child", { parentSessionId: "next-root" })])
  s.messages.set("child", [assistant("Other session secret")])
  const reads = s.reads()
  expect(s.source.snapshot().phases).toEqual([])
  expect(s.source.snapshot().note).toContain("Session changed")
  expect(s.source.details("child")).toBeUndefined()
  expect(s.source.act!("child", "stop")).toContain("Session changed")
  expect(s.reads()).toBe(reads)
  expect(s.stopped).toEqual([])
  s.emit("session.start", "next-root", { reason: "resume", cwd: "/new", model })
  s.switchTo("root")
  s.setAgents([agent("child")])
  expect(s.source.snapshot().phases).toEqual([])
  s.source.dispose()
})

test("a switch event invalidates the source before the control changes and dispose removes every listener", () => {
  const s = setup()
  expect(s.listeners()).toBeGreaterThan(0)
  s.emit("session.end", "root", { reason: "switch" })
  // A switched session never returns, so its bus listeners go immediately rather than at close.
  expect(s.listeners()).toBe(0)
  expect(s.source.details("child")).toBeUndefined()
  expect(s.source.act!("child", "stop")).toContain("Session changed")
  const renders = s.renders()
  s.source.dispose()
  s.source.dispose()
  expect(s.listeners()).toBe(0)
  writeEvent(s, "child")
  expect(s.renders()).toBe(renders)
  expect(s.source.snapshot().note).toBe("Live source closed.")
  let changes = 0
  s.source.subscribe!(() => {
    changes++
  })()
  expect(changes).toBe(0)
})

test("streaming, logs, paths and active detail caches are bounded", () => {
  const s = setup()
  for (let i = 0; i < 300; i++) {
    s.emit("message.delta", "child", { kind: "text", text: "x".repeat(1000) })
    s.emit("tool.execute.update", "child", {
      toolCallId: "read",
      name: "read",
      partial: { content: [{ type: "text", text: `update ${i}` }] },
    })
  }
  const details = s.source.details("child")!
  expect(textOf(details.summary).length).toBeLessThanOrEqual(16_000)
  expect(details.logs.length).toBeLessThanOrEqual(200)
  expect(textOf(details.logs)).not.toContain("update 0\n")
  expect(textOf(details.logs)).toContain("update 299")
  writeEvent(
    s,
    "child",
    Array.from({ length: 600 }, (_, i) => `${i}.ts`),
  )
  expect(agentsOf(s.source.snapshot())[0]?.files).toHaveLength(512)
  s.setAgents(Array.from({ length: 129 }, (_, i) => agent(`child-${i}`)))
  for (let i = 0; i < 129; i++) writeEvent(s, `child-${i}`)
  const listed = agentsOf(s.source.snapshot())
  expect(listed[0]?.files).toEqual([])
  expect(listed.at(-1)?.files).toEqual([{ path: "src/result.ts" }])
  s.source.dispose()
})
