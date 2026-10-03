import { expect, test } from "bun:test"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  FrontendView,
  SessionControl,
  ViewDefinition,
} from "@amira/api"
import extension, { sourceRegistry } from "../src/index.ts"
import type { DashboardSource, DashboardSources } from "../src/source.ts"
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
  notify?.()
  expect(changed).toBe(2)
  remove()
  remove()
  expect(releases).toBe(1)
  const next = adapter
  registry.service.register(next)
  remove()
  expect(registry.sources.get("workflow")).toBe(next)
  registry.dispose()
  expect(releases).toBe(2)
  expect(registry.sources.size).toBe(0)
})

function setup() {
  const commands: CommandDefinition[] = []
  const views: ViewDefinition[] = []
  let service: DashboardSources | undefined
  const exits: (() => void)[] = []
  const api = {
    session: () => undefined,
    requestRender: () => {},
    on: () => () => {},
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
    info: () => ({ id: "root", cwd: "repo" }),
    subagents: () => [],
    subagentMessages: () => [],
    trace: async () => [],
    stopSubagent: () => false,
  } as unknown as SessionControl
  const ctx = {
    session,
    cwd: "repo",
    frontend: "tui",
    signal: new AbortController().signal,
    print: (message: string) => printed.push(message),
    openView: (view: FrontendView) => {
      opened.push(view)
      return true
    },
  } as unknown as CommandContext
  return { command: commands[0]!, views, service: service!, ctx, opened, printed, exits }
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
