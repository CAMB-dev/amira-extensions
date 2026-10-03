import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI, ViewLine } from "@amira/api"
import {
  bindWorkflowSource,
  createWorkflowSource,
  type DashboardSource,
  type DashboardSources,
} from "../src/dashboard.ts"
import { Journal, type RunRecord, writeRun } from "../src/journal.ts"
import { WorkflowRun } from "../src/run.ts"
import { fakeGroup } from "./fakes.ts"

const lineText = (line: ViewLine) =>
  line.kind === "segments" ? line.parts.map((part) => part.text).join("") : line.text

const dirs: string[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-dashboard-"))
  dirs.push(dir)
  return dir
}

function registry() {
  const sources = new Map<string, DashboardSource>()
  let changes = 0
  let removals = 0
  const service: DashboardSources = {
    register(source) {
      if (sources.has(source.id)) throw new Error("duplicate source")
      sources.set(source.id, source)
      const unsubscribe = source.subscribe?.(() => {
        changes++
      })
      return () => {
        if (sources.get(source.id) !== source) return
        sources.delete(source.id)
        unsubscribe?.()
        removals++
      }
    },
  }
  return {
    service,
    sources,
    get changes() {
      return changes
    },
    get removals() {
      return removals
    },
  }
}

function host() {
  const services = new Map<string, unknown>()
  const api = {
    useService: (name: string) => services.get(name),
    provideService(name: string, value: unknown) {
      services.set(name, value)
      return () => {
        if (services.get(name) === value) services.delete(name)
      }
    },
  } as unknown as ExtensionAPI
  return { api, services }
}

test("optional service handles late installation, dashboard reload, session pause, and owner disposal", () => {
  const { api, services } = host()
  const adapter = createWorkflowSource("/project")
  let disposed = 0
  const binding = bindWorkflowSource(api, adapter.source, () => {
    disposed++
    adapter.dispose()
  })
  cleanup.push(binding.dispose)
  expect(services.has("dashboard.sources")).toBe(false)
  const first = registry()
  services.set("dashboard.sources", first.service)
  binding.refresh()
  binding.refresh()
  expect(first.sources.get("workflow")).toBe(adapter.source)
  adapter.load([])
  expect(first.changes).toBe(1)

  const replacement = registry()
  services.set("dashboard.sources", replacement.service)
  binding.refresh()
  expect(first.sources.size).toBe(0)
  expect(first.removals).toBe(1)
  adapter.load([])
  expect(first.changes).toBe(1)
  expect(replacement.changes).toBe(1)
  binding.pause()
  binding.refresh()
  expect(replacement.sources.size).toBe(0)
  binding.resume()
  expect(replacement.sources.size).toBe(1)

  services.delete("dashboard.sources")
  binding.refresh()
  expect(replacement.sources.size).toBe(0)
  services.set("dashboard.sources", replacement.service)
  binding.refresh()
  // The host removes provided services on unload; no invented extension unload event.
  services.delete("workflow.dashboard-owner")
  binding.refresh()
  binding.dispose()
  expect(disposed).toBe(1)
  expect(replacement.sources.size).toBe(0)
  binding.refresh()
  expect(replacement.sources.size).toBe(0)
})

test("a replacement workflow instance retries registration after the old owner releases it", () => {
  const { api, services } = host()
  const dashboard = registry()
  services.set("dashboard.sources", dashboard.service)
  const old = bindWorkflowSource(api, createWorkflowSource("/old").source)
  cleanup.push(old.dispose)
  services.delete("workflow.dashboard-owner")
  const source = createWorkflowSource("/new").source
  const next = bindWorkflowSource(api, source)
  cleanup.push(next.dispose)
  old.refresh()
  next.refresh()
  expect(dashboard.sources.get("workflow")).toBe(source)
  old.dispose()
  expect(dashboard.sources.get("workflow")).toBe(source)
})

test("finished run loading exposes script phases and call details without fabricated navigation", () => {
  const root = tmp()
  const dir = path.join(root, "wf_saved")
  const record: RunRecord = {
    id: "wf_saved",
    meta: { name: "review", description: "Review changes", phases: ["Read", "Verify"] },
    args: null,
    source: "inline",
    status: "error",
    startedAt: 10,
    endedAt: 40,
    resumes: 1,
  }
  writeRun(dir, record)
  const journal = new Journal(dir)
  journal.record({
    key: "old#0",
    call: 1,
    attempt: 0,
    label: "Old attempt",
    text: "old",
    status: "done",
    durationMs: 5,
  })
  // Completion order is different from call order; phase and call IDs must remain stable.
  journal.record({
    key: "b#0",
    call: 2,
    attempt: 1,
    label: "Check",
    prompt: "Check the findings",
    phase: "Verify",
    status: "error",
    error: "provider down",
    text: "",
    tokens: 12,
    startedAt: 20,
    durationMs: 20,
    model: "p/m",
    sessionId: "child-2",
  })
  journal.record({
    key: "a#0",
    call: 1,
    attempt: 1,
    label: "Read",
    prompt: "Read files",
    phase: "Read",
    status: "cached",
    text: "Found two issues",
    tokens: 0,
    cost: 0,
    startedAt: 10,
    durationMs: 0,
    sessionId: "original-child",
  })
  const adapter = createWorkflowSource("/project")
  adapter.load([root])
  const snapshot = adapter.source.snapshot()
  expect(snapshot.workspace).toBe("/project")
  expect(snapshot.phases.map((phase) => phase.name)).toEqual(["review · Read", "review · Verify"])
  const agents = snapshot.phases.flatMap((phase) => phase.groups.flatMap((group) => group.agents))
  expect(agents.map((agent) => agent.status)).toEqual(["done", "failed"])
  expect(agents[1]).toMatchObject({
    task: "Check the findings",
    files: [],
    actions: [],
    startedAt: 20,
    durationMs: 20,
  })
  expect(agents[1]!.cost).toBeUndefined()
  expect(agents[1]!.progress).toBeUndefined()
  expect(agents[1]).not.toHaveProperty("sessionId")
  expect(agents[1]).not.toHaveProperty("tokens")
  const details = adapter.source.details(agents[1]!.id)!
  expect(details.summary.map(lineText).join("\n")).toContain("Child session: child-2")
  expect(details.summary.map(lineText).join("\n")).toContain("Tokens: 12 · cost: unknown")
  expect(details.logs.map(lineText)).toContain("provider down")
  expect(adapter.source.details(agents[0]!.id)!.summary.map(lineText)).toContain(
    "Child session: original-child",
  )
  expect(adapter.source.act).toBeUndefined()
  expect(adapter.source.details("missing")).toBeUndefined()
  expect(adapter.source.snapshot()).toEqual(snapshot)
})

test("legacy resumed runs retain calls without attempt metadata", () => {
  const root = tmp()
  const dir = path.join(root, "wf_legacy")
  writeRun(dir, {
    id: "wf_legacy",
    meta: { name: "legacy", description: "Old resumed run", phases: ["Read"] },
    args: null,
    source: "inline",
    status: "done",
    startedAt: 10,
    endedAt: 40,
    resumes: 2,
  })
  new Journal(dir).record({
    key: "old#0",
    label: "Read",
    phase: "Read",
    text: "Found it",
    tokens: 10,
    durationMs: 5,
    sessionId: "old-child",
  })
  const adapter = createWorkflowSource(root)
  adapter.load([root])
  const agent = adapter.source.snapshot().phases[0]!.groups[0]!.agents[0]!
  expect(agent.status).toBe("done")
  expect(adapter.source.details(agent.id)!.summary.map(lineText)).toContain("Child session: old-child")
})

test("nested invocations keep separate groups and stable identities after reload", async () => {
  const root = tmp()
  const adapter = createWorkflowSource(root)
  const group = fakeGroup({ name: "nested" }, () => ({ text: "done", cost: 0 }))
  const run = new WorkflowRun({
    id: "wf_nested",
    dir: path.join(root, "wf_nested"),
    source: `export const meta = { name: "outer", description: "Nested calls", phases: ["Outer"] }
      phase("Outer")
      await workflow("child", {})
      return await workflow("child", {})`,
    origin: "inline",
    args: null,
    group,
    cwd: root,
    home: root,
    roles: () => new Map(),
    git: async () => ({ ok: false, output: "" }),
    loadWorkflow: () => `export const meta = { name: "child", description: "Child", phases: ["Inner"] }
      phase("Inner")
      return await agent("nested task")`,
    onChange: () => adapter.update(run),
  })
  run.start()
  await run.done
  const inner = adapter.source.snapshot().phases.find((phase) => phase.name.endsWith(" · Inner"))!
  expect(inner.groups.map((group) => group.name)).toEqual(["child#1", "child#2"])
  const saved = createWorkflowSource(root)
  saved.load([root])
  expect(saved.source.snapshot().phases).toEqual(adapter.source.snapshot().phases)
})

test("live call and completion changes notify the registry with coherent details", async () => {
  const root = tmp()
  const adapter = createWorkflowSource(root)
  const dashboard = registry()
  const unregister = dashboard.service.register(adapter.source)
  cleanup.push(unregister)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const group = fakeGroup({ name: "review" }, async () => {
    await gate
    return { text: "Checked", tokens: 25, cost: 0.03 }
  })
  const run = new WorkflowRun({
    id: "wf_live",
    dir: path.join(root, "wf_live"),
    source: `export const meta = { name: "review", description: "Review changes", phases: ["Verify"] }
      phase("Verify")
      return await agent("Check files", { label: "Check" })`,
    origin: "inline",
    args: null,
    group,
    cwd: root,
    home: root,
    roles: () => new Map(),
    git: async () => ({ ok: false, output: "" }),
    loadWorkflow: () => undefined,
    onChange: () => adapter.update(run),
  })
  run.start()
  while (!group.spawned.length) await Bun.sleep(2)
  const before = adapter.source
    .snapshot()
    .phases.flatMap((phase) => phase.groups.flatMap((item) => item.agents))[0]!
  expect(["queued", "running"]).toContain(before.status)
  expect(before.cost).toBeUndefined()
  expect(adapter.source.details(before.id)!.summary.map(lineText)).toContain("Child session: s_child1")
  const changes = dashboard.changes
  release()
  await run.done
  const after = adapter.source
    .snapshot()
    .phases.flatMap((phase) => phase.groups.flatMap((item) => item.agents))[0]!
  expect(after).toMatchObject({ id: before.id, status: "done", cost: 0.03, progress: 1 })
  expect(dashboard.changes).toBeGreaterThan(changes)
  expect(adapter.source.details(after.id)!.logs.map(lineText)).toContain("Checked")
  expect(adapter.source.details(after.id)!.summary.map(lineText).join("\n")).toContain("Tokens: 25")
  const finished = createWorkflowSource(root)
  finished.load([root])
  expect(finished.source.snapshot().phases).toEqual(adapter.source.snapshot().phases)
})
