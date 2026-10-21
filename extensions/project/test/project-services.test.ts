import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BoundRunner, RunnerSnapshot } from "../src/execution-modes.ts"
import { Implementations } from "../src/implement.ts"
import { runModeChange } from "../src/mode-change.ts"
import { runSpec } from "../src/spec.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { fixture } from "./implement-fixture.ts"

setDefaultTimeout(240_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.implementations.quiesce(f.project)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function setup(initialized = false) {
  const f = await fixture({ initialized })
  fixtures.push(f)
  return f
}
function provider() {
  const progress = new Set<(value: RunnerSnapshot) => void>()
  const results = new Set<(value: RunnerSnapshot) => void>()
  let snapshot: RunnerSnapshot = { runId: "offline-run", status: "running" }
  const runner: BoundRunner = {
    available: () => true,
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    startBound: mock(async (request, owner) => {
      const group = owner.createGroup({ name: "Offline provider", maxAgents: 1, maxConcurrent: 1 })
      snapshot = {
        ...snapshot,
        cwd: request.cwd,
        models: ["mock/actual-provider"],
        sessionIds: ["provider-child"],
        groupId: group.id,
        phase: "Implement",
        children: [
          { label: "Writer", state: "working", model: "mock/actual-provider", sessionId: "provider-child" },
        ],
      }
      return { runId: snapshot.runId }
    }),
    status: () => snapshot,
    stop: mock(() => {
      snapshot = { ...snapshot, status: "stopped" }
      for (const listener of results) listener(snapshot)
      return true
    }),
    onProgress: (_id, listener) => {
      progress.add(listener)
      queueMicrotask(() => {
        if (progress.has(listener)) listener(snapshot)
      })
      return () => {
        progress.delete(listener)
      }
    },
    onResult: (_id, listener) => {
      results.add(listener)
      if (snapshot.status !== "running") listener(snapshot)
      return () => {
        results.delete(listener)
      }
    },
  }
  return {
    runner,
    complete: () => {
      snapshot = { ...snapshot, status: "done", result: "Implemented through offline provider" }
      for (const listener of results) listener(snapshot)
    },
  }
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, mode: string | undefined) {
  f.answers.push(mode, "Approve spec and batch plan")
  return runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
}

test("mode selection is not approval; Escape at mode choice and spec approval never starts work", async () => {
  for (const dismissAt of ["mode", "approval"]) {
    const f = await setup()
    const p = provider()
    f.api.useService = () => p.runner as never
    f.answers.push(dismissAt === "mode" ? undefined : "Workflow")
    if (dismissAt === "approval") f.answers.push(undefined)
    const state = await runSpec(
      f.api,
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
    )
    expect(state.receipts).toHaveLength(0)
    expect(state.approvedContext).toBeUndefined()
    await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("approve")
    expect(p.runner.startBound).not.toHaveBeenCalled()
    expect(f.commands).toHaveLength(0)
  }
})

test("the exact approved mode and immutable plan are pinned before launch, then service is rediscovered", async () => {
  const f = await setup()
  const p = provider()
  let service: unknown = p.runner
  f.api.useService = () => service as never
  const state = await approve(f, "Workflow")
  expect(state.approvedContext?.mode).toBe("workflow")
  const plan = await f.store.readArtifact(
    state.artifacts.find((ref) => ref.id === state.approvedContext!.batchPlan!.artifactId)!,
  )
  expect(plan.kind === "batch-plan" && plan.mode).toBe("workflow")
  expect(p.runner.startBound).not.toHaveBeenCalled()
  service = undefined
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
    "Single-agent fallback",
  )
  expect(f.commands).toHaveLength(0)
  const blocked = await f.store.read()
  const summary = await f.store.readArtifact(
    blocked.artifacts.findLast((ref) => ref.kind === "stage-summary")!,
  )
  expect(JSON.stringify(summary)).toContain("No mode or cwd was changed")
  expect(blocked.approvedContext?.mode).toBe("workflow")
  expect(p.runner.startBound).not.toHaveBeenCalled()
})

test("a disabled compatible service records its start error without single-agent substitution", async () => {
  const f = await setup(true)
  const p = provider()
  p.runner.startBound = mock(async () => ({ error: "Workflow is disabled by settings" }))
  f.api.useService = () => p.runner as never
  await approve(f, "Workflow")
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const state = await f.store.read()
  expect(state.status).toBe("interrupted")
  expect(f.spawned()).toBeUndefined()
  const result = await f.store.readArtifact(state.artifacts.findLast((ref) => ref.kind === "batch-result")!)
  expect(result.kind === "batch-result" && result.error).toContain("disabled by settings")
  expect(result.kind === "batch-result" && result.error).toContain(
    "Single-agent fallback requires fresh approval",
  )
})

test("bound workflow passes owner/cwd, shows progress, saves actual execution evidence and restart stays inert", async () => {
  const f = await setup(true)
  const p = provider()
  f.api.useService = () => p.runner as never
  await approve(f, "Workflow")
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  for (let i = 0; i < 100 && !f.implementations.progress(f.project); i++) await Bun.sleep(10)
  expect(f.implementations.progress(f.project)).toContain("Implement")
  expect(f.implementations.progress(f.project)).toContain("Writer: working")
  expect(f.implementations.progress(f.project)).toContain("mock/actual-provider")
  const [request, owner] = (p.runner.startBound as ReturnType<typeof mock>).mock.calls[0]!
  expect(request.cwd).not.toBe(f.root)
  expect(owner.sessionId).toBe(f.handles.at(-1)!.id)
  expect(owner.signal).toBeInstanceOf(AbortSignal)
  expect(owner.label).toBe("Implement B1")
  expect(f.groupFactories.get(f.handles.at(-1)!.id)).toHaveBeenCalledWith({
    name: "Offline provider",
    maxAgents: 1,
    maxConcurrent: 1,
  })
  await writeFile(path.join(request.cwd, "result.txt"), "ready\n")
  p.complete()
  await f.settled()
  const state = await f.store.read()
  expect(state.pending?.to).toBe("accept")
  const result = await f.store.readArtifact(state.artifacts.findLast((ref) => ref.kind === "batch-result")!)
  if (result.kind !== "batch-result") throw new Error("No batch result")
  expect(result.implementerModels).toEqual(["mock/actual-provider"])
  expect(result.execution).toEqual({
    mode: "workflow",
    cwd: request.cwd,
    runId: "offline-run",
    sessionIds: ["provider-child"],
    groupId: p.runner.status("offline-run")!.groupId,
  })
  f.api.useService = () => undefined
  const restarted = new Implementations(f.api)
  expect(restarted.progress(f.project)).toBeUndefined()
  expect((await f.store.read()).phase).toBe("proposed")
  expect(p.runner.startBound).toHaveBeenCalledTimes(1)
})

test("capability loss mid-run stops the original runner and records fallback instructions without acceptance", async () => {
  const f = await setup(true)
  const p = provider()
  f.api.useService = () => p.runner as never
  await approve(f, "Workflow")
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  for (let i = 0; i < 100 && !f.implementations.progress(f.project); i++) await Bun.sleep(10)
  Object.assign(p.runner.capabilities, { progress: false })
  await f.settled()
  expect(p.runner.stop).toHaveBeenCalledWith("offline-run")
  const state = await f.store.read()
  expect(state.status).toBe("interrupted")
  expect(state.pending).toBeUndefined()
  expect(state.approvedContext?.mode).toBe("workflow")
  const result = await f.store.readArtifact(state.artifacts.findLast((ref) => ref.kind === "batch-result")!)
  expect(result.kind === "batch-result" && result.error).toContain("capabilities.progress")
  expect(f.notifications.join("\n")).toContain("Single-agent fallback")
  expect(f.spawned()).toBeUndefined()
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("approve")
  expect(p.runner.startBound).toHaveBeenCalledTimes(1)
})

test("single-agent fallback still needs a new exact spec/plan approval", async () => {
  const f = await setup()
  const p = provider()
  f.api.useService = () => p.runner as never
  await approve(f, "Swarm")
  f.api.useService = () => undefined
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("fallback")
  f.answers.push("Single agent", false)
  const cancelled = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(cancelled.approvedContext).toBeUndefined()
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("approve")
  f.answers.push("Confirm proposed next step", true)
  const approved = await runStageCommand(
    "next",
    [],
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(approved.approvedContext?.mode).toBe("single")
  expect(approved.approvedContext?.spec?.revision).toBe(1)
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(approved.receipts).toHaveLength(2)
  expect(p.runner.startBound).not.toHaveBeenCalled()
})

for (const mode of ["workflow", "swarm"] as const) {
  test(`${mode} settings disable stops and persists its reason without authorising fallback`, async () => {
    const f = await setup(true)
    const p = provider()
    let enabled = true
    p.runner.available = () => (enabled ? true : { reason: `extensions.${mode}.enabled: never` })
    f.api.useService = (name) => (name === `${mode}.runner` ? p.runner : undefined) as never
    await approve(f, mode === "workflow" ? "Workflow" : "Swarm")
    f.answers.push(true)
    await f.implementations.run(f.project, f.ctx, "en", () => {})
    for (let i = 0; i < 100 && !f.implementations.progress(f.project); i++) await Bun.sleep(10)
    enabled = false
    await f.settled()
    expect(p.runner.stop).toHaveBeenCalledWith("offline-run")
    const state = await f.store.read()
    expect(state.status).toBe("interrupted")
    expect(state.approvedContext?.mode).toBe(mode)
    expect(state.pending).toBeUndefined()
    const result = await f.store.readArtifact(state.artifacts.findLast((ref) => ref.kind === "batch-result")!)
    expect(result.kind === "batch-result" && result.error).toContain(`extensions.${mode}.enabled: never`)
    expect(result.kind === "batch-result" && result.error).toContain("/project mode")
    expect(result.kind === "batch-result" && result.checks.every((check) => check.status === "blocked")).toBe(
      true,
    )
    expect(f.spawned()).toBeUndefined()
    await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("approve")
  })
}
