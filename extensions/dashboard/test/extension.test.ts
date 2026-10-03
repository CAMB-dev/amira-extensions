import { expect, test } from "bun:test"
import type {
  CommandContext,
  CommandDefinition,
  EventEnvelope,
  EventMap,
  ExtensionAPI,
  FrontendView,
  SessionControl,
  SubagentInfo,
  UiControl,
  ViewDefinition,
} from "@amira/api"
import extension, { sourceRegistry } from "../src/index.ts"
import { agentsOf, type DashboardSource, type DashboardSources } from "../src/source.ts"
import type { DashboardViewData } from "../src/view.ts"

const source = (id = "workflow"): DashboardSource => ({
  id,
  label: "Workflow",
  snapshot: () => ({ workspace: "repo", phases: [] }),
  details: () => undefined,
})

test("service reserves built-in IDs, rejects duplicates and releases subscriptions once", () => {
  let changed = 0
  let releases = 0
  let notify: (() => void) | undefined
  const registry = sourceRegistry(() => changed++)
  const adapter = {
    ...source(),
    subscribe: (fn: () => void) => {
      notify = fn
      return () => releases++
    },
  }
  expect(() => registry.service.register(source("agents"))).toThrow("reserved")
  expect(() => registry.service.register(source("trace"))).toThrow("reserved")
  expect(() => registry.service.register(source("bad id"))).toThrow("Invalid")
  const remove = registry.service.register(adapter)
  expect(() => registry.service.register(source())).toThrow("already registered")
  expect(registry.sources.get("workflow")).toBe(adapter)
  expect(notify).toBeUndefined()
  const release = registry.subscribe("workflow", () => changed++)
  notify?.()
  expect(changed).toBe(2)
  remove()
  remove()
  release()
  expect(releases).toBe(1)
  const changes = changed
  notify?.()
  expect(changed).toBe(changes)
  const next = adapter
  registry.service.register(next)
  registry.subscribe("workflow", () => changed++)
  remove()
  expect(registry.sources.get("workflow")).toBe(next)
  registry.dispose()
  expect(releases).toBe(2)
  expect(registry.sources.size).toBe(0)
})

function setup(agents: SubagentInfo[] = []) {
  const commands: CommandDefinition[] = []
  const views: ViewDefinition[] = []
  let service: DashboardSources | undefined
  const exits: (() => void)[] = []
  let renders = 0
  let listeners = 0
  let subscriptions = 0
  let sessionId = "root"
  let opens = 0
  let mounted: FrontendView | undefined
  const handlers = new Map<keyof EventMap, Set<(event: EventEnvelope) => void>>()
  const bus: Pick<ExtensionAPI, "on"> = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set()
      const receive = (event: EventEnvelope) => handler(event as EventEnvelope<typeof type>)
      set.add(receive)
      handlers.set(type, set)
      listeners++
      subscriptions++
      return () => {
        if (set.delete(receive)) listeners--
      }
    },
  }
  const api = {
    session: () => undefined,
    requestRender: () => renders++,
    on: bus.on,
    onExit: (fn: () => void) => {
      exits.push(fn)
      return () => {}
    },
    provideService: (name: string, value: DashboardSources) => {
      expect(name).toBe("dashboard.sources")
      service = value
      return () => {}
    },
    registerView: (view: ViewDefinition) => {
      views.push(view)
      return () => {}
    },
    registerCommand: (command: CommandDefinition) => {
      commands.push(command)
      return () => {}
    },
  } as unknown as ExtensionAPI
  extension(api)
  const opened: FrontendView[] = []
  const printed: string[] = []
  const session = {
    info: () => ({ id: sessionId, cwd: "repo" }),
    subagents: () => agents,
    subagentMessages: () => [],
    trace: async () => [],
    stopSubagent: () => false,
    pauseSubagent: () => false,
    resumeSubagent: () => false,
    messageSubagent: () => false,
  } as unknown as SessionControl
  const ctx = {
    session,
    cwd: "repo",
    frontend: "tui",
    signal: new AbortController().signal,
    print: (message: string) => printed.push(message),
    openView: (view: FrontendView) => {
      const alreadyOpen = mounted !== undefined
      mounted = view
      opened.push(view)
      if (!alreadyOpen && "data" in view) {
        opens++
        views[0]?.onOpen?.(view.data, {} as UiControl)
      }
      return true
    },
  } as unknown as CommandContext
  let seq = 0
  function emit<K extends keyof EventMap>(type: K, sessionId: string, data: EventMap[K]) {
    const event: EventEnvelope<K> = { type, sessionId, data, seq: ++seq, ts: seq }
    for (const handler of handlers.get(type) ?? []) handler(event)
  }
  return {
    command: commands[0]!,
    views,
    service: service!,
    ctx,
    opened,
    printed,
    exits,
    renders: () => renders,
    listeners: () => listeners,
    subscriptions: () => subscriptions,
    emit,
    switchTo: (id: string) => {
      sessionId = id
    },
    opens: () => opens,
    close: () => {
      const previous = mounted
      mounted = undefined
      if (previous && "data" in previous) views[0]?.onClose?.(previous.data)
    },
  }
}

test("registers /dashboard and its declarative view; agents is the default", async () => {
  const s = setup()
  expect(s.command.name).toBe("dashboard")
  expect(s.views[0]?.ui).toBeFunction()
  await s.command.run("", s.ctx)
  const opened = s.opened[0]!
  expect(opened.kind).toBe("dashboard")
  expect("data" in opened && (opened.data as DashboardViewData).source.id).toBe("agents")
  for (const exit of s.exits) exit()
})

test("opens replay, offers registered sources and invalidates removed providers", async () => {
  const s = setup()
  const adapter = source()
  const remove = s.service.register(adapter)
  const completions = await s.command.args?.complete?.("", s.ctx)
  expect(completions?.map((item) => item.value)).toEqual(["agents", "trace", "workflow"])
  await s.command.run("workflow", s.ctx)
  const opened = s.opened[0]!
  if (!("data" in opened)) throw new Error("Expected extension view data")
  const data = opened.data as DashboardViewData
  expect(data.source.snapshot().workspace).toBe("repo")
  remove()
  expect(data.source.snapshot().note).toContain("unregistered")
  s.service.register(adapter)
  expect(data.source.snapshot().note).toContain("unregistered")
  expect(data.source.act?.("agent", "stop")).toContain("no longer available")
  await s.command.run("trace", s.ctx)
  const replay = s.opened[1]!
  expect("data" in replay && (replay.data as DashboardViewData).source.id).toBe("trace")
})

test("cancelled or superseded trace loads cannot open late", async () => {
  for (const cancelled of [true, false]) {
    const s = setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const ctx = {
      ...s.ctx,
      signal: controller.signal,
      session: {
        ...s.ctx.session,
        trace: async () => {
          await pending
          return []
        },
      },
    }
    const loading = s.command.run("trace", ctx)
    if (cancelled) controller.abort()
    else await s.command.run("agents", s.ctx)
    release()
    if (cancelled) await expect(loading).rejects.toThrow()
    else await loading
    expect(s.opened).toHaveLength(cancelled ? 0 : 1)
    if (!cancelled) {
      const opened = s.opened[0]!
      expect("data" in opened && (opened.data as DashboardViewData).source.id).toBe("agents")
    }
  }
})

test("live listeners start at onOpen, survive same-kind replacement and release on close or exit", async () => {
  const s = setup()
  expect(s.listeners()).toBe(0)
  expect(s.renders()).toBe(0)
  await s.command.run("agents", {
    ...s.ctx,
    openView: () => {
      expect(s.listeners()).toBe(0)
      return false
    },
  })
  expect(s.listeners()).toBe(0)
  await s.command.run("agents", {
    ...s.ctx,
    openView: (view) => {
      expect(s.listeners()).toBe(0)
      return s.ctx.openView!(view)
    },
  })
  const listeners = s.listeners()
  expect(listeners).toBeGreaterThan(0)
  const first = s.opened[0]!
  if (!("data" in first)) throw new Error("Expected extension view data")
  const live = (first.data as DashboardViewData).source
  await s.command.run("agents", s.ctx)
  expect(s.opens()).toBe(1)
  expect(s.listeners()).toBe(listeners)
  const reopened = s.opened[1]!
  expect("data" in reopened && (reopened.data as DashboardViewData).source).toBe(live)
  await s.command.run("trace", { ...s.ctx, openView: () => false })
  expect(s.listeners()).toBe(listeners)
  await s.command.run("trace", s.ctx)
  expect(s.opens()).toBe(1)
  expect(s.listeners()).toBe(0)
  expect(live.snapshot().note).toBe("Live source closed.")
  await s.command.run("agents", s.ctx)
  expect(s.listeners()).toBe(listeners)
  s.close()
  s.close()
  expect(s.listeners()).toBe(0)
  await s.command.run("agents", s.ctx)
  expect(s.opens()).toBe(2)
  expect(s.listeners()).toBe(listeners)
  for (const exit of s.exits) exit()
  expect(s.listeners()).toBe(0)
  s.close()
  expect(s.listeners()).toBe(0)
})

test("same-session agents reopens preserve observed files, logs and subscriptions until the session changes", async () => {
  const s = setup([
    {
      id: "child",
      parentSessionId: "root",
      depth: 1,
      role: "coder",
      title: "Child",
      task: "Update the file",
      status: "running",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
  await s.command.run("agents", s.ctx)
  const first = s.opened[0]!
  if (!("data" in first)) throw new Error("Expected extension view data")
  const live = (first.data as DashboardViewData).source
  const listeners = s.listeners()
  const subscriptions = s.subscriptions()
  const written = {
    toolCallId: "write",
    name: "write",
    durationMs: 1,
    writtenPaths: ["src/result.ts"],
    result: { content: [{ type: "text" as const, text: "Saved the change" }] },
  }
  s.emit("tool.execute.end", "child", written)
  expect(agentsOf(live.snapshot())[0]?.files).toEqual([{ path: "src/result.ts" }])
  expect(live.details("child")?.logs).toEqual([
    { kind: "text", text: "write: finished" },
    { kind: "text", text: "Saved the change" },
  ])
  const details = live.details("child")

  await s.command.run("agents", { ...s.ctx, openView: () => false })
  expect(live.details("child")).toEqual(details)
  expect(s.listeners()).toBe(listeners)
  expect(s.subscriptions()).toBe(subscriptions)
  await s.command.run("agents", s.ctx)
  const reopened = s.opened[1]!
  if (!("data" in reopened)) throw new Error("Expected extension view data")
  const current = (reopened.data as DashboardViewData).source
  expect(current).toBe(live)
  expect(agentsOf(current.snapshot())[0]?.files).toEqual([{ path: "src/result.ts" }])
  expect(current.details("child")).toEqual(details)
  expect(s.opens()).toBe(1)
  expect(s.listeners()).toBe(listeners)
  expect(s.subscriptions()).toBe(subscriptions)
  const renders = s.renders()
  s.emit("tool.execute.end", "child", { ...written, writtenPaths: ["src/next.ts"] })
  expect(s.renders()).toBe(renders + 1)
  expect(agentsOf(current.snapshot())[0]?.files).toEqual([{ path: "src/result.ts" }, { path: "src/next.ts" }])

  s.switchTo("next")
  await s.command.run("agents", { ...s.ctx, openView: () => false })
  expect(s.listeners()).toBe(listeners)
  expect(s.subscriptions()).toBe(subscriptions)
  await s.command.run("agents", s.ctx)
  const next = s.opened[2]!
  if (!("data" in next)) throw new Error("Expected extension view data")
  const nextLive = (next.data as DashboardViewData).source
  expect(nextLive).not.toBe(live)
  expect(live.snapshot().note).toBe("Live source closed.")
  expect(live.details("child")).toBeUndefined()
  expect(s.listeners()).toBe(listeners)
  expect(s.subscriptions()).toBe(subscriptions + listeners)
  s.close()
  expect(nextLive.snapshot().note).toBe("Live source closed.")
  expect(s.listeners()).toBe(0)
})

test("only the displayed provider subscribes and stale callbacks cannot render after replacement or close", async () => {
  const s = setup()
  let releases = 0
  const callbacks: (() => void)[] = []
  const adapter = (id: string): DashboardSource => ({
    ...source(id),
    subscribe: (changed) => {
      callbacks.push(changed)
      return () => releases++
    },
  })
  const remove = s.service.register(adapter("workflow"))
  s.service.register(adapter("other"))
  expect(s.renders()).toBe(0)
  expect(callbacks).toHaveLength(0)
  await s.command.run("workflow", {
    ...s.ctx,
    openView: () => {
      expect(callbacks).toHaveLength(0)
      return false
    },
  })
  expect(callbacks).toHaveLength(0)
  await s.command.run("workflow", s.ctx)
  expect(callbacks).toHaveLength(1)
  callbacks[0]!()
  expect(s.renders()).toBe(1)
  await s.command.run("other", { ...s.ctx, openView: () => false })
  expect(callbacks).toHaveLength(1)
  expect(releases).toBe(0)
  await s.command.run("other", s.ctx)
  expect(s.opens()).toBe(1)
  expect(callbacks).toHaveLength(2)
  expect(releases).toBe(1)
  const renders = s.renders()
  callbacks[0]!()
  expect(s.renders()).toBe(renders)
  callbacks[1]!()
  expect(s.renders()).toBe(renders + 1)
  s.close()
  expect(releases).toBe(2)
  const closedRenders = s.renders()
  callbacks[1]!()
  remove()
  expect(s.renders()).toBe(closedRenders)
  for (const exit of s.exits) exit()
  expect(releases).toBe(2)
})

test("unregistering the visible provider releases it and does not attach a replacement implicitly", async () => {
  const s = setup()
  let releases = 0
  let notify: (() => void) | undefined
  const adapter = {
    ...source(),
    subscribe: (changed: () => void) => {
      notify = changed
      return () => releases++
    },
  }
  const remove = s.service.register(adapter)
  await s.command.run("workflow", s.ctx)
  remove()
  expect(releases).toBe(1)
  expect(s.renders()).toBe(1)
  notify?.()
  expect(s.renders()).toBe(1)
  const removeNext = s.service.register(adapter)
  remove()
  expect(releases).toBe(1)
  await s.command.run("workflow", s.ctx)
  notify?.()
  expect(s.renders()).toBe(3)
  removeNext()
  expect(releases).toBe(2)
  s.close()
  expect(releases).toBe(2)
})

test("unavailable frontends, unknown sources and rejected opens are explicit", async () => {
  const s = setup()
  await s.command.run("", { ...s.ctx, openView: undefined })
  await s.command.run("missing", s.ctx)
  await s.command.run("", { ...s.ctx, openView: () => false })
  expect(s.printed).toEqual([
    "The dashboard needs a frontend with full-screen views.",
    "Unknown dashboard source: missing. Use /dashboard agents or /dashboard trace.",
    "The dashboard could not open. Close the current dialog and try again.",
  ])
})
