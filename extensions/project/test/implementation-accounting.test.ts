import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ConversationUsageSnapshot, ExtensionAPI, OwnedConversationSnapshot } from "@amira/api"
import { disposeAccounting, projectAccounting } from "../src/accounting.ts"
import type { BoundRunner, RunnerSnapshot } from "../src/execution-modes.ts"
import { Implementations } from "../src/implement.ts"
import { ImplementationLifecycle } from "../src/implementation-lifecycle.ts"
import { runSpec } from "../src/spec.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { IterationStore, readProject } from "../src/store.ts"
import { fixture } from "./implement-fixture.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

setDefaultTimeout(120_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await disposeAccounting(f.api)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Implementation accounting condition did not settle")
}

for (const mode of ["single", "workflow", "swarm"] as const) {
  test(`${mode}: cap settlement includes interruption publication and same-identity explicit continuation`, async () => {
    const f = await fixture()
    fixtures.push(f)
    const snapshots = new Map<string, OwnedConversationSnapshot>()
    const released = new Set<string>()
    const illegal: string[] = []
    const open = f.api.conversations!.openOrCreate.bind(f.api.conversations)
    let pendingSend: (() => void) | undefined
    let implementing = false
    let resumed = false
    let focuses = 0
    f.ctx.focusConversation = () => {
      focuses++
      return true
    }
    f.api.conversations!.openOrCreate = async (spec, runtime) => {
      const handle = await open(spec, runtime)
      const usage = zeroUsage(handle.id)
      snapshots.set(spec.key, {
        id: handle.id,
        key: spec.key,
        name: spec.name,
        cwd: spec.cwd,
        archived: false,
        history: [],
        usage,
      })
      const guard = (method: string) => {
        if (released.has(handle.id)) {
          illegal.push(method)
          throw new Error(`owned conversation has been released (${method})`)
        }
      }
      handle.usage = () => structuredClone(snapshots.get(spec.key)!.usage)
      handle.status = () => {
        guard("status")
        return { state: "idle", busy: false }
      }
      const runTool = handle.runTool.bind(handle)
      handle.runTool = (...args) => {
        guard("runTool")
        return runTool(...args)
      }
      handle.stop = async () => {
        guard("stop")
        pendingSend?.()
      }
      handle.release = async () => {
        released.add(handle.id)
      }
      if (spec.descendants === "inherit") {
        handle.send = async (_text, options) => {
          guard("send")
          implementing = true
          if (resumed) return
          await new Promise<void>((_resolve, reject) => {
            pendingSend = () => reject(new Error("Host implementation stopped"))
            options?.signal?.addEventListener("abort", pendingSend, { once: true })
          })
        }
      }
      return handle
    }
    f.api.conversations!.read = async (ref) => {
      const saved =
        "key" in ref ? snapshots.get(ref.key) : [...snapshots.values()].find((s) => s.id === ref.id)
      return saved ? structuredClone(saved) : undefined
    }
    let providerSnapshot: RunnerSnapshot | undefined
    const results = new Set<(snapshot: RunnerSnapshot) => void>()
    const stops: string[] = []
    const runner: BoundRunner = {
      available: () => true,
      capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
      async startBound(request, owner) {
        const group = owner.createGroup({ name: "Offline implementation", maxAgents: 1, maxConcurrent: 1 })
        providerSnapshot = {
          runId: `run-${snapshots.size}`,
          cwd: request.cwd,
          groupId: group.id,
          status: "running",
          state: "running",
          models: ["mock/actual"],
          sessionIds: ["provider-child"],
          children: [
            { label: "Writer", state: "working", sessionId: "provider-child", model: "mock/actual" },
          ],
        }
        implementing = true
        return { runId: providerSnapshot.runId }
      },
      status: () => providerSnapshot,
      stop(id) {
        stops.push(id)
        if (providerSnapshot) {
          providerSnapshot = { ...providerSnapshot, status: "stopped", state: "stopped" }
          for (const listener of results) listener(providerSnapshot)
        }
        return true
      },
      onProgress: () => () => {},
      onResult(_id, listener) {
        results.add(listener)
        if (providerSnapshot?.status === "stopped") listener(providerSnapshot)
        return () => {
          results.delete(listener)
        }
      },
    }
    f.api.useService = (name) =>
      (name === `${mode}.runner` && mode !== "single" ? runner : undefined) as never
    if (mode !== "single") f.answers.push(mode === "workflow" ? "Workflow" : "Swarm")
    f.answers.push("Approve spec and batch plan")
    await runSpec(
      f.api,
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
    )
    const account = await projectAccounting(f.api, f.project)
    await account.costs.configure("cap", 1, "main-fixture")
    f.answers.push(true)
    await f.implementations.run(f.project, f.ctx, "en", () => {})
    await waitFor(() => implementing)
    if (mode !== "single") await waitFor(() => results.size > 0)
    const coordinator = f.handles.at(-1)!
    const before = await f.store.read()
    await writeFile(path.join(coordinator.cwd, "retained.txt"), "retain budget-stopped changes\n")
    const receipt: ConversationUsageSnapshot = zeroUsage(coordinator.id)
    receipt.revision = 1
    receipt.own.knownCostUsd = receipt.total.knownCostUsd = 1
    receipt.own.usage.cost = receipt.total.usage.cost = 1
    snapshots.get(coordinator.key)!.usage = receipt

    let publish!: () => void
    const publication = new Promise<void>((resolve) => {
      publish = resolve
    })
    let publishing = false
    const save = IterationStore.prototype.saveArtifact
    const spy = spyOn(IterationStore.prototype, "saveArtifact").mockImplementation(async function (
      this: IterationStore,
      revision,
      artifact,
    ) {
      if (artifact.kind === "batch-result") {
        publishing = true
        await publication
      }
      return save.call(this, revision, artifact)
    })
    let settled = false
    let settlement: Promise<void> | undefined
    let quiesced = false
    let quiescence: Promise<void> | undefined
    try {
      await account.refresh(coordinator.key, coordinator)
      settlement = account.settled().then(() => {
        settled = true
      })
      await waitFor(() => publishing || settled)
      expect(publishing).toBe(true)
      expect(released.has(coordinator.id)).toBe(true)
      quiescence = f.implementations.quiesce(f.project).then(() => {
        quiesced = true
      })
      await Bun.sleep(50)
      expect(settled).toBe(false)
      expect(quiesced).toBe(false)
      const focused = focuses
      await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
        "Review /project spec",
      )
      expect(focuses).toBe(focused)
      expect(f.implementations.progress(f.project)).toBeUndefined()
    } finally {
      publish()
      spy.mockRestore()
      await settlement
      await quiescence
    }
    const interrupted = await f.store.read()
    expect(interrupted.status).toBe("interrupted")
    expect(interrupted.pending).toBeUndefined()
    const ref = interrupted.artifacts.findLast((entry) => entry.kind === "batch-result")!
    expect(ref).toBeDefined()
    const evidence = await f.store.readArtifact(ref)
    expect(evidence.kind).toBe("batch-result")
    if (evidence.kind !== "batch-result") throw new Error("Missing interruption evidence")
    expect(evidence.attemptId).toBe(before.activeAttemptId!)
    expect(evidence.error).toContain("Project cap reached")
    expect(evidence.checks.map((check) => check.status)).toEqual(["blocked"])
    if (mode !== "single") {
      expect(evidence.execution?.runId).toBe(providerSnapshot!.runId)
      expect(stops).toEqual([providerSnapshot!.runId])
    }
    expect(illegal).toEqual([])
    expect(f.commands.some((entry) => entry.command.endsWith("git --version"))).toBe(false)

    const action = mode === "single" ? "continue" : mode === "workflow" ? "remove" : "raise"
    await account.costs.configure(action, action === "raise" ? 2 : undefined, "main-fixture")
    const restored = await readProject(f.root, f.project.marker.id)
    expect(restored.marker.id).toBe(f.project.marker.id)
    expect(restored.marker.currentIteration).toBe(f.project.marker.currentIteration)
    await f.implementations.quiesce(restored)
    expect(illegal).toEqual([])
    f.answers.push(true)
    const continuation = await runStageCommand(
      "next",
      [],
      restored,
      f.ctx,
      "en",
      () => {},
      () => f.implementations.quiesce(restored),
    )
    expect(continuation.phase).toBe("confirmed")
    expect(continuation.approvedContext).toEqual(before.approvedContext)
    expect(continuation.attempts.find((attempt) => attempt.id === before.activeAttemptId)?.status).toBe(
      "interrupted",
    )
    resumed = true
    implementing = false
    await f.implementations.run(restored, f.ctx, "en", () => {})
    await waitFor(() => implementing)
    expect(f.handles.at(-1)!.id).not.toBe(coordinator.id)
    expect(f.handles.at(-1)!.cwd).toBe(coordinator.cwd)
    expect(await readFile(path.join(coordinator.cwd, "retained.txt"), "utf8")).toBe(
      "retain budget-stopped changes\n",
    )
    expect(f.generationSpecs).toHaveLength(1)
    await f.implementations.quiesce(restored)
    expect(illegal).toEqual([])
  })
}

test("implementation admission retains awaited bounded full-history validation", () => {
  const registrations: { event: string; options: unknown }[] = []
  new Implementations({
    intercept(event: string, _listener: unknown, options: unknown) {
      registrations.push({ event, options })
      return () => {}
    },
  } as unknown as ExtensionAPI)
  expect(registrations).toEqual([
    { event: "context.build", options: { timeoutMs: 30_000 } },
    { event: "tool.call.before", options: { timeoutMs: 30_000 } },
  ])
})

test("accounting-cancelled lifecycle rejects before probing a released owner's status", async () => {
  const handle = ownedFixture({ key: "released-implementation", cwd: process.cwd() })
  let probes = 0
  handle.status = () => {
    probes++
    throw new Error("owned conversation has been released (status)")
  }
  const lifecycle = new ImplementationLifecycle(handle)
  lifecycle.cancel("Project cap reached")
  try {
    expect(() => lifecycle.check()).toThrow("Project cap reached")
    expect(probes).toBe(0)
  } finally {
    await lifecycle.close()
  }
})
