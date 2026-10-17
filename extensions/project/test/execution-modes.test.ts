import { expect, test } from "bun:test"
import path from "node:path"
import type { ExtensionAPI, OwnedConversation, SpawnGroup } from "@amira/api"
import {
  type BoundProgress,
  BoundRunError,
  type BoundRunner,
  type BoundRunOptions,
  boundRunner,
  discoverModes,
  type RunnerOwner,
  type RunnerSnapshot,
  recommendMode,
  runBound,
} from "../src/execution-modes.ts"

type Mode = "workflow" | "swarm"
const cwd = path.resolve("iteration")
const capabilities = () =>
  ({ cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true }) as const

function fake(mode: Mode = "workflow", replay: "none" | "sync" | "microtask" = "none") {
  const progress = new Set<(snapshot: RunnerSnapshot) => void>()
  const results = new Set<(snapshot: RunnerSnapshot) => void>()
  const requests: Parameters<BoundRunner["startBound"]>[0][] = []
  const owners: RunnerOwner[] = []
  const stops: string[] = []
  const groupOptions: unknown[] = []
  const group = { id: "actual-group" } as SpawnGroup
  let ownerStopped = false
  const handle = {
    id: "owned-session",
    status() {
      return { state: ownerStopped ? "stopped" : "idle" }
    },
    createGroup(options: unknown) {
      expect(this).toBe(handle)
      groupOptions.push(options)
      return group
    },
  } as unknown as OwnedConversation
  let statusCalls = 0
  let unsubscriptions = 0
  let startError: string | undefined
  let startGate: Promise<void> | undefined
  let snapshot: RunnerSnapshot =
    mode === "workflow"
      ? { runId: "run-1", cwd, status: "running", phase: "Implement", models: [], children: [] }
      : { runId: "run-1", cwd, state: "running", members: [] }
  const final: RunnerSnapshot =
    mode === "workflow"
      ? {
          runId: "run-1",
          cwd,
          status: "done",
          result: "implemented",
          models: ["actual/model"],
          sessionIds: ["actual-child"],
        }
      : {
          runId: "run-1",
          cwd,
          reason: "every member is idle and no message is on its way",
          members: [
            {
              name: "item-1",
              sessionId: "actual-child",
              model: "actual/model",
              status: "done",
              note: "every member is idle and no message is on its way",
              text: "implemented",
            },
          ],
        }
  const runner: BoundRunner = {
    available: () => true,
    capabilities: capabilities(),
    async startBound(request, owner) {
      requests.push(request)
      owners.push(owner)
      if (startGate) await startGate
      if (startError) return { error: startError }
      // A late provider response can still return an ID without creating work.
      if (!owner.signal.aborted)
        owner.createGroup({ name: "Provider-owned group", maxAgents: 2, maxConcurrent: 2 })
      if (replay !== "none") snapshot = final
      return { runId: "run-1" }
    },
    status() {
      statusCalls++
      return snapshot
    },
    stop(runId) {
      stops.push(runId)
      return true
    },
    onProgress(_id, listener) {
      progress.add(listener)
      if (replay === "sync") listener(snapshot)
      if (replay === "microtask")
        queueMicrotask(() => {
          if (progress.has(listener)) listener(snapshot)
        })
      return () => {
        unsubscriptions++
        progress.delete(listener)
      }
    },
    onResult(_id, listener) {
      results.add(listener)
      if (replay === "sync") listener(final)
      if (replay === "microtask")
        queueMicrotask(() => {
          if (results.has(listener)) listener(final)
        })
      return () => {
        unsubscriptions++
        results.delete(listener)
      }
    },
  }
  const services: Record<string, unknown> = { [`${mode}.runner`]: runner }
  const lookups: string[] = []
  const api = {
    useService(name: string) {
      lookups.push(name)
      return services[name]
    },
  } as Pick<ExtensionAPI, "useService">
  const controller = new AbortController()
  const updates: BoundProgress[] = []
  const options: BoundRunOptions = {
    api,
    mode,
    handle,
    signal: controller.signal,
    cwd,
    model: "selected/model",
    batchId: "B1",
    seed: "Approved batch only",
    items: [{ id: "S1", description: "First requirement" }],
    onProgress: (value) => {
      updates.push(value)
    },
  }
  return {
    api,
    runner,
    services,
    options,
    requests,
    owners,
    stops,
    groupOptions,
    controller,
    updates,
    progress,
    results,
    final,
    lookups,
    get statusCalls() {
      return statusCalls
    },
    get unsubscriptions() {
      return unsubscriptions
    },
    stopOwner() {
      ownerStopped = true
    },
    setStartError(value: string) {
      startError = value
    },
    setStartGate(value: Promise<void>) {
      startGate = value
    },
    setSnapshot(value: RunnerSnapshot) {
      snapshot = value
    },
    emit(value: RunnerSnapshot) {
      snapshot = value
      for (const listener of [...progress]) listener(value)
    },
    finish(value = final) {
      snapshot = value
      for (const listener of [...results]) listener(value)
    },
  }
}

async function launched(f: ReturnType<typeof fake>) {
  for (let i = 0; i < 50 && !f.results.size; i++) await Bun.sleep(1)
  expect(f.results.size).toBe(1)
}

function released(f: ReturnType<typeof fake>) {
  expect(f.progress.size).toBe(0)
  expect(f.results.size).toBe(0)
}

test("discovery always offers single, ignores missing and legacy services, and needs no dashboard", () => {
  const f = fake()
  delete f.services["workflow.runner"]
  expect(discoverModes(f.api)).toEqual(["single"])
  f.services["workflow.runner"] = { start() {}, status() {}, stop() {}, onResult() {} }
  f.services["swarm.dashboardSource"] = {}
  expect(discoverModes(f.api)).toEqual(["single"])
  f.services["workflow.runner"] = f.runner
  f.services["swarm.runner"] = fake("swarm").runner
  expect(discoverModes(f.api)).toEqual(["single", "workflow", "swarm"])
  expect(f.lookups).not.toContain("swarm.dashboardSource")
})

for (const mode of ["workflow", "swarm"] as const) {
  for (const flag of ["cwd", "freshRun", "models", "ownedLifetime", "progress"] as const) {
    test(`${mode} requires capability ${flag} to be exactly true`, () => {
      const f = fake(mode)
      for (const value of [false, undefined, "true", 1]) {
        f.services[`${mode}.runner`] = { ...f.runner, capabilities: { ...capabilities(), [flag]: value } }
        expect(discoverModes(f.api)).toEqual(["single"])
        expect(() => boundRunner(f.api, mode)).toThrow(`capabilities.${flag}=true`)
      }
    })
  }
  for (const method of ["available", "startBound", "status", "stop", "onProgress", "onResult"] as const) {
    test(`${mode} requires ${method}`, () => {
      const f = fake(mode)
      f.services[`${mode}.runner`] = { ...f.runner, [method]: undefined }
      expect(() => boundRunner(f.api, mode)).toThrow(method)
    })
  }

  test(`${mode} re-detects the service at launch without fallback`, async () => {
    const f = fake(mode)
    expect(discoverModes(f.api)).toContain(mode)
    delete f.services[`${mode}.runner`]
    await expect(runBound(f.options)).rejects.toThrow(/unavailable|disabled/)
    expect(f.requests).toHaveLength(0)
  })

  test(`${mode} preserves disabled/start errors without launching a fallback`, async () => {
    const f = fake(mode)
    f.setStartError("disabled by provider settings: never")
    await expect(runBound(f.options)).rejects.toThrow("disabled by provider settings: never")
    expect(f.requests).toHaveLength(1)
    expect(f.groupOptions).toHaveLength(0)
    expect(f.stops).toEqual([])
    released(f)
  })

  test(`${mode} binds the actual owner, signal, cwd and selected models`, async () => {
    const f = fake(mode)
    const promise = runBound(f.options)
    await launched(f)
    expect(f.owners[0]?.sessionId).toBe("owned-session")
    expect(f.owners[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(f.owners[0]?.signal.aborted).toBe(false)
    expect(f.requests[0]?.cwd).toBe(cwd)
    expect(f.requests[0]?.startedBy).toEqual({ sessionId: "owned-session", label: "Implement B1" })
    expect(f.groupOptions).toHaveLength(1)
    f.finish()
    const result = await promise
    expect(result).toMatchObject({
      models: ["actual/model"],
      sessionIds: ["actual-child"],
      groupId: "actual-group",
      runId: "run-1",
      cwd,
    })
    expect(result.text).toContain("implemented")
    expect(result.models).not.toContain("selected/model")
    expect(f.stops).toEqual([])
    released(f)
  })

  for (const replay of ["sync", "microtask"] as const) {
    test(`${mode} instant ${replay} replay cleans subscriptions and polling`, async () => {
      const f = fake(mode, replay)
      expect((await runBound(f.options)).text).toContain("implemented")
      released(f)
      expect(f.unsubscriptions).toBe(2)
      const polls = f.statusCalls
      await Bun.sleep(120)
      expect(f.statusCalls).toBe(polls)
      expect(f.stops).toEqual([])
    })
  }

  test(`${mode} abort stops exactly the runner once and preserves evidence`, async () => {
    const f = fake(mode)
    const promise = runBound(f.options)
    await launched(f)
    f.controller.abort("human paused the batch")
    const error = await promise.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BoundRunError)
    expect(error).toMatchObject({ runId: "run-1", groupId: "actual-group" })
    expect((error as Error).message).toContain("human paused the batch")
    expect(f.stops).toEqual(["run-1"])
    released(f)
    f.finish()
    expect(f.stops).toHaveLength(1)
  })

  test(`${mode} mismatched effective cwd is stopped with metadata`, async () => {
    const f = fake(mode)
    const promise = runBound(f.options)
    await launched(f)
    f.emit({ ...f.final, cwd: path.resolve("wrong-checkout") })
    const error = await promise.catch((error: unknown) => error)
    expect(error).toMatchObject({
      cwd: path.resolve("wrong-checkout"),
      models: ["actual/model"],
      runId: "run-1",
    })
    expect((error as Error).message).toContain("does not match approved cwd")
    expect(f.stops).toEqual(["run-1"])
    released(f)
  })
}

test("recommendations reflect available ordered batches and parallel items", () => {
  const all = ["single", "workflow", "swarm"] as const
  expect(recommendMode(all, [{ itemIds: ["S1"] }])).toBe("single")
  expect(recommendMode(all, [{ itemIds: ["S1", "S2"] }])).toBe("swarm")
  expect(recommendMode(all, [{ itemIds: ["S1"] }, { itemIds: ["S2"] }])).toBe("workflow")
  expect(recommendMode(["single", "workflow"], [{ itemIds: ["S1", "S2"] }])).toBe("workflow")
  expect(recommendMode(["single"], [{ itemIds: ["S1", "S2"] }])).toBe("single")
})

test("workflow builds a fresh agent script with explicit model and no per-agent worktrees", async () => {
  const f = fake("workflow", "sync")
  f.options.items = [
    { id: "S1", description: "First" },
    { id: "S2", description: "Second" },
  ]
  await runBound(f.options)
  const request = f.requests[0]!
  expect(request.script).toStartWith("export const meta = {")
  expect(request.script).toContain("await agent(")
  expect(request.script).toContain("model: args.model")
  expect(request.script).toContain('isolation: "none"')
  expect(request.script).not.toContain('isolation: "worktree"')
  expect(request.args).toEqual({ seed: f.options.seed, items: f.options.items, model: "selected/model" })
})

test("swarm splits item assignments and uses a research-only collaborator for one item", async () => {
  for (const count of [1, 2]) {
    const f = fake("swarm", "sync")
    f.options.items = Array.from({ length: count }, (_, index) => ({
      id: `S${index + 1}`,
      description: `Requirement ${index + 1}`,
    }))
    await runBound(f.options)
    const members = f.requests[0]!.members!
    expect(members).toHaveLength(2)
    expect(members.every((member) => member.model === "selected/model")).toBe(true)
    expect(members[0]!.brief).toContain("exclusive implementation assignment is S1")
    if (count === 1) {
      expect(members[1]!.role).toBe("explorer")
      expect(members[1]!.brief).toContain("Do not edit any files")
    } else {
      expect(members[1]!.brief).toContain("exclusive implementation assignment is S2")
      expect(members[1]!.brief).not.toContain("exclusive implementation assignment is S1")
    }
  }
})

test("normalizes actual swarm fields and waits for onResult, not terminal status", async () => {
  const f = fake("swarm")
  const promise = runBound(f.options)
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await launched(f)
  f.emit({
    ...f.final,
    state: "ended",
    members: [
      { name: "implementer", status: "idle", sessionId: "child-a", model: "provider/a" },
      { name: "researcher", status: "working", sessionId: "child-b", model: "provider/b" },
    ],
  })
  expect(f.updates.at(-1)).toMatchObject({
    phase: "ended",
    groupId: "actual-group",
    cwd,
    runId: "run-1",
    models: ["provider/a", "provider/b"],
    children: [
      { label: "implementer", state: "idle", sessionId: "child-a", model: "provider/a" },
      { label: "researcher", state: "working", sessionId: "child-b", model: "provider/b" },
    ],
  })
  await Bun.sleep(120)
  expect(settled).toBe(false)
  f.finish()
  expect((await promise).sessionIds).toEqual(["child-a", "child-b", "actual-child"])
})

test("workflow progress collects children and terminal status waits for result settlement", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  const child = {
    label: "S1",
    state: "done",
    sessionId: "child-1",
    model: "provider/model",
    call: 1,
    status: "done",
    phase: "Verify",
  }
  f.emit({
    runId: "run-1",
    cwd,
    status: "done",
    phase: "Verify",
    children: [child],
  })
  expect(f.updates.at(-1)?.children).toEqual([
    { label: "S1", state: "done", sessionId: "child-1", model: "provider/model" },
  ])
  expect(f.updates.at(-1)).toMatchObject({
    phase: "Verify",
    children: [{ label: "S1", state: "done" }],
    models: ["provider/model"],
  })
  expect(f.results.size).toBe(1)
  f.finish()
  expect((await promise).models).toEqual(["provider/model", "actual/model"])
})

for (const change of ["unload", "replace", "capability", "method", "unknown-run"] as const) {
  test(`polling detects mid-run ${change}, rejects and stops original runner once`, async () => {
    const f = fake()
    const promise = runBound(f.options)
    await launched(f)
    if (change === "unload") delete f.services["workflow.runner"]
    if (change === "replace") f.services["workflow.runner"] = fake().runner
    if (change === "capability") Reflect.set(f.runner.capabilities, "models", false)
    if (change === "method") Reflect.set(f.runner, "stop", undefined)
    if (change === "unknown-run") f.runner.status = () => undefined
    const error = await promise.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BoundRunError)
    expect((error as Error).message).toMatch(/unavailable|replaced|incompatible|lost run/)
    expect(f.stops).toEqual(["run-1"])
    released(f)
  })
}

test("callbacks recheck service identity before accepting even a successful result", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  delete f.services["workflow.runner"]
  f.finish()
  await expect(promise).rejects.toThrow("unavailable")
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("result failure retains actual execution metadata", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  f.finish({ ...f.final, status: "error", error: "child failed" })
  const error = await promise.catch((error: unknown) => error)
  expect(error).toMatchObject({
    runId: "run-1",
    models: ["actual/model"],
    sessionIds: ["actual-child"],
    groupId: "actual-group",
    cwd,
  })
  expect((error as Error).message).toBe("child failed")
  released(f)
})

test("swarm limit termination is a failure, not successful implementation", async () => {
  const f = fake("swarm")
  const promise = runBound(f.options)
  await launched(f)
  f.finish({ ...f.final, reason: "token budget exceeded" })
  await expect(promise).rejects.toThrow("token budget exceeded")
  released(f)
})

test("provider start exceptions reject without leaked subscriptions", async () => {
  const f = fake()
  f.runner.startBound = async () => {
    throw new Error("confirmation failed")
  }
  await expect(runBound(f.options)).rejects.toThrow("confirmation failed")
  expect(f.stops).toEqual([])
  released(f)
})

test("mismatched callback run identity stops the actual launched run", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  f.emit({ ...f.final, runId: "another-run" })
  await expect(promise).rejects.toThrow("mismatched run ID")
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("launch rejects relative cwd and empty items before contacting a provider", async () => {
  const f = fake()
  await expect(runBound({ ...f.options, cwd: "relative" })).rejects.toThrow("absolute cwd")
  await expect(runBound({ ...f.options, items: [] })).rejects.toThrow("at least one item")
  expect(f.requests).toHaveLength(0)
})

test("already aborted runs do not call a provider", async () => {
  const f = fake()
  f.controller.abort("already paused")
  await expect(runBound(f.options)).rejects.toThrow("already paused")
  expect(f.requests).toHaveLength(0)
})

test("abort while start is pending rejects promptly and stops a late returned run", async () => {
  const f = fake()
  let release!: () => void
  f.setStartGate(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const promise = runBound(f.options)
  f.controller.abort("cancel confirmation")
  await expect(promise).rejects.toThrow("cancel confirmation")
  release()
  await Bun.sleep(1)
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("a throwing progress consumer stops work and releases listeners", async () => {
  const f = fake()
  f.options.onProgress = () => {
    throw new Error("render failed")
  }
  await expect(runBound(f.options)).rejects.toThrow("render failed")
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("idle owner Stop cancels a pending provider confirmation and stops any late run", async () => {
  const f = fake()
  let release!: () => void
  f.setStartGate(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const promise = runBound(f.options)
  f.stopOwner()
  const error = await promise.catch((error: unknown) => error)
  expect((error as Error).message).toContain("coordinator was stopped")
  expect(f.owners[0]?.signal.aborted).toBe(true)
  release()
  await Bun.sleep(1)
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("workflow summary polling preserves detailed onProgress phase and child state", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  f.emit({
    runId: "run-1",
    cwd,
    phase: "Implement item",
    status: "running",
    children: [{ label: "Writer", state: "working", sessionId: "actual-child", model: "actual/model" }],
  })
  f.setSnapshot({ runId: "run-1", cwd, status: "running", models: ["actual/model"] })
  await Bun.sleep(150)
  expect(f.updates.at(-1)?.phase).toBe("Implement item")
  expect(f.updates.at(-1)?.children[0]?.label).toBe("Writer")
  f.finish()
  await promise
  released(f)
})

for (const outcome of [
  { status: "done", note: "reached its limit of 20 turns" },
  { status: "aborted" },
  { status: "done", note: "" },
]) {
  test(`swarm premature member outcome ${JSON.stringify(outcome)} is interrupted`, async () => {
    const f = fake("swarm")
    const promise = runBound(f.options)
    await launched(f)
    f.finish({ ...f.final, reason: "every member ended", members: [{ ...f.final.members![0]!, ...outcome }] })
    await expect(promise).rejects.toThrow()
    released(f)
  })
}

for (const state of ["stopped", "failed"]) {
  test(`workflow aggregate done cannot hide a ${state} implementation child`, async () => {
    const f = fake()
    const promise = runBound(f.options)
    await launched(f)
    f.emit({
      runId: "run-1",
      cwd,
      status: "running",
      phase: "Implement",
      children: [{ label: "Writer", state, sessionId: "actual-child", model: "actual/model" }],
    })
    // Real status()/onResult carry an aggregate summary, not detailed children.
    f.finish(f.final)
    const error = await promise.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BoundRunError)
    expect((error as Error).message).toContain(`Writer ${state} before completion`)
    expect(f.stops).toEqual(["run-1"])
    released(f)
  })
}

test("owner group creation checks native Stop synchronously before the next poll", async () => {
  const f = fake()
  let release!: () => void
  f.setStartGate(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const promise = runBound(f.options)
  const owner = f.owners[0]!
  expect(owner.signal.aborted).toBe(false)
  f.stopOwner()
  expect(() => owner.createGroup({ name: "late group", maxAgents: 1, maxConcurrent: 1 })).toThrow(
    "no longer active",
  )
  const error = await promise.catch((error: unknown) => error)
  expect((error as Error).message).toContain("coordinator was stopped")
  expect(f.groupOptions).toHaveLength(0)
  expect(owner.signal.aborted).toBe(true)
  release()
  await Bun.sleep(1)
  expect(f.stops).toEqual(["run-1"])
  released(f)
})

test("unchanged liveness polls do not repeatedly invalidate the project panel", async () => {
  const f = fake()
  const promise = runBound(f.options)
  await launched(f)
  const initial = f.updates.length
  await Bun.sleep(250)
  const beforeChange = f.updates.length
  f.emit({
    runId: "run-1",
    cwd,
    status: "running",
    phase: "Write item",
    children: [{ label: "Writer", state: "working", sessionId: "actual-child", model: "actual/model" }],
  })
  const afterChange = f.updates.length
  f.finish()
  await promise
  expect(beforeChange).toBe(initial)
  expect(afterChange).toBe(initial + 1)
  released(f)
})

for (const mode of ["workflow", "swarm"] as const) {
  test(`${mode} availability hides a disabled provider and is rechecked before launch`, async () => {
    const f = fake(mode)
    let enabled = false
    Object.assign(f.runner, {
      available: () => (enabled ? true : { reason: `extensions.${mode}.enabled: never` }),
    })
    expect(discoverModes(f.api)).toEqual(["single"])
    enabled = true
    expect(discoverModes(f.api)).toContain(mode)
    enabled = false
    const error = await runBound(f.options).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`extensions.${mode}.enabled: never`)
    expect(f.requests).toHaveLength(0)
  })

  test(`${mode} disabling during a run stops the original runner and cannot succeed later`, async () => {
    const f = fake(mode)
    let enabled = true
    Object.assign(f.runner, {
      available: () => (enabled ? true : { reason: `extensions.${mode}.enabled: never` }),
    })
    const promise = runBound(f.options).catch((error: unknown) => error)
    await launched(f)
    enabled = false
    // Keep a deterministic failure signal even before availability polling exists.
    await Bun.sleep(250)
    const stopped = [...f.stops]
    f.finish()
    const error = await promise.catch((error: unknown) => error)
    expect(stopped).toEqual(["run-1"])
    expect(error).toBeInstanceOf(BoundRunError)
    expect((error as Error).message).toContain(`extensions.${mode}.enabled: never`)
    released(f)
  })
}
