import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ConversationSpec, ExtensionAPI, OwnedConversationSnapshot, SpawnGroup } from "@amira/api"
import {
  cachedProjectAccounting,
  disposeAccounting,
  openAccounted,
  projectAccounting,
  retainAccountedRun,
} from "../src/accounting.ts"
import type { CostAttribution } from "../src/cost.ts"
import { type BoundRunner, type RunnerSnapshot, runBound } from "../src/execution-modes.ts"
import { ProjectLifecycleController } from "../src/project-lifecycle.ts"
import {
  assertProjectWritable,
  assertProjectWritableNow,
  createProject,
  HistoricalIterationReader,
  IterationStore,
  LifecycleStore,
  type Project,
  ProjectDocumentStore,
  projectLifecycle,
  readProject,
  writeDocument,
} from "../src/store.ts"
import { commandHarness, consume, startReview, summarize } from "./batch-test-helper.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const receipt = (id = "approval") => ({ id, sessionId: "main", date: "2026-10-21T00:00:00Z" })
const revision = (project: Project) => projectLifecycle(project).revision
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const row of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, row.name)
    if (row.isDirectory()) {
      for (const [key, value] of Object.entries(await tree(file))) result[`${row.name}/${key}`] = value
    } else result[row.name] = (await readFile(file)).toString("base64")
  }
  return result
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-lifecycle-"))
  const project = await createProject(root, "Lifecycle")
  const records = new Map<string, OwnedConversationSnapshot>()
  const calls: string[] = []
  let beforeArchive: ((key: string) => Promise<void>) | undefined
  let beforeOpen: (() => Promise<void>) | undefined
  let createGroup: (() => SpawnGroup) | undefined
  let unarchiveFailure = false
  const find = (ref: { id: string } | { key: string }) =>
    "key" in ref ? records.get(ref.key) : [...records.values()].find((row) => row.id === ref.id)
  const add = (key: string, archived = false) => {
    const id = `owner-${records.size}`
    const snapshot: OwnedConversationSnapshot = {
      key,
      id,
      name: key,
      cwd: root,
      archived,
      history: [],
      usage: zeroUsage(id),
    }
    records.set(key, snapshot)
    return snapshot
  }
  const api = {
    dataDir: path.join(root, "extension-data"),
    requestRender() {},
    notify() {},
    conversations: {
      async read(ref: { id: string } | { key: string }) {
        return structuredClone(find(ref))
      },
      async openOrCreate(spec: ConversationSpec) {
        calls.push(`open:${spec.key}`)
        await beforeOpen?.()
        const snapshot = records.get(spec.key) ?? add(spec.key)
        if (snapshot.archived) throw new Error("Owner is archived")
        const handle = ownedFixture(spec, snapshot.id)
        handle.send = async () => {
          calls.push(`send:${spec.key}`)
        }
        handle.stop = async () => {
          calls.push(`stop:${spec.key}`)
        }
        handle.release = async () => {
          calls.push(`release:${spec.key}`)
        }
        if (createGroup) handle.createGroup = createGroup
        return handle
      },
      async open() {
        throw new Error("Unexpected runtime reopen")
      },
      async archive(ref: { id: string } | { key: string }) {
        const snapshot = find(ref)
        if (!snapshot) throw new Error("Missing owner")
        calls.push(`archive:${snapshot.key}`)
        await beforeArchive?.(snapshot.key)
        snapshot.archived = true
      },
      async unarchive(ref: { id: string } | { key: string }) {
        const snapshot = find(ref)
        if (!snapshot) throw new Error("Missing owner")
        calls.push(`unarchive:${snapshot.key}`)
        if (unarchiveFailure) throw new Error("Unarchive unavailable")
        snapshot.archived = false
      },
    },
  } as unknown as ExtensionAPI
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true })
  })
  cleanups.push(() => disposeAccounting(api))
  const controller = (selected = project) => new ProjectLifecycleController(api, selected)
  const open = (key = `${project.marker.id}/design/1`) =>
    openAccounted(
      api,
      project,
      { stage: "design", role: "conversation" },
      { key, name: "Design", cwd: root, model: "mock/model", systemPrompt: "Mock design", callableTools: [] },
      { askUser: async () => undefined },
    )
  const ship = async (status: "shipped" | "skipped" = "skipped") =>
    new LifecycleStore(await readProject(root)).transition(revision(await readProject(root)), {
      type: "ship",
      status,
      receipt: receipt("ship"),
    })
  const inventory = async (selected: Project, key: string, attribution: CostAttribution, bind = true) => {
    const accounting = await projectAccounting(api, selected)
    await accounting.costs.intent(key, attribution)
    const snapshot = records.get(key) ?? add(key)
    if (bind) await accounting.costs.bind(key, snapshot.id)
    return snapshot
  }
  return {
    root,
    project,
    records,
    calls,
    api,
    add,
    controller,
    open,
    ship,
    inventory,
    setArchive(value: typeof beforeArchive) {
      beforeArchive = value
    },
    setOpen(value: typeof beforeOpen) {
      beforeOpen = value
    },
    setGroup(value: () => SpawnGroup) {
      createGroup = value
    },
    failUnarchive(value: boolean) {
      unarchiveFailure = value
    },
  }
}

test("closure requires explicit shipped/skipped evidence before fencing or host work", async () => {
  const f = await fixture()
  await new IterationStore(f.project).read()
  await expect(f.controller().close(0, receipt())).rejects.toThrow(/shipped|skipped/i)
  expect(projectLifecycle(await readProject(f.root)).iterations[1]?.status).toBe("open")
  expect(f.calls).toEqual([])
  expect(await f.controller().read()).toEqual([])
  await expect(f.controller().nextIteration(0, receipt())).rejects.toThrow(/close/i)
})

for (const status of ["shipped", "skipped"] as const) {
  test(`close ${status} fences retained writers/groups, drains services, then archives and publishes closed`, async () => {
    const f = await fixture()
    const group = {
      id: "group",
      spawn() {
        throw new Error("Unexpected spawn")
      },
      async ended() {},
      end() {
        f.calls.push("group:end")
      },
      children: () => [],
    } as unknown as SpawnGroup
    f.setGroup(() => group)
    const owner = await f.open()
    const retained = owner.createGroup({ name: "Retained group" })
    retainAccountedRun(owner, {
      stop() {
        f.calls.push("provider:stop")
      },
      async drain() {
        f.calls.push("provider:drain")
        const current = await readProject(f.root)
        expect(projectLifecycle(current).iterations[1]?.status).toBe("close-pending")
        await expect(assertProjectWritable(f.project)).rejects.toThrow(/read-only/i)
        expect(() => assertProjectWritableNow(f.project)).toThrow(/read-only/i)
        expect(() => retained.spawn({ prompt: "late" })).toThrow()
        await expect(owner.send("late")).rejects.toThrow()
        await expect(writeDocument(f.project, "design.md", "late")).rejects.toThrow(/read-only/i)
      },
    })
    const shipped = await f.ship(status)
    f.setArchive(async () => {
      expect(f.calls).toContain("provider:drain")
      expect(f.calls).toContain(`release:${owner.key}`)
      expect(projectLifecycle(await readProject(f.root)).iterations[1]?.status).toBe("close-pending")
    })
    const result = await f.controller(shipped).close(1, receipt("close"))
    expect(result.operation.status).toBe("completed")
    expect(projectLifecycle(result.project).iterations[1]).toMatchObject({ status: "closed", ship: status })
    expect(f.records.get(owner.key)?.archived).toBe(true)
    expect(await cachedProjectAccounting(f.api, result.project)).toBeUndefined()
    const before = await tree(f.root)
    expect(await f.controller(result.project).read()).toEqual([result.operation])
    expect(await tree(f.root)).toEqual(before)
    const next = await f.controller(result.project).nextIteration(revision(result.project), receipt("next"))
    expect(next.marker.currentIteration).toBe(2)
    expect(await new HistoricalIterationReader(next, 2).read()).toMatchObject({
      iteration: 2,
      revision: 0,
      stage: "design",
      attempts: [],
    })
    expect(f.calls.filter((call) => call.startsWith("open:"))).toHaveLength(1)
    // The next explicit launch receives fresh accounting rather than a stopped cache.
    expect(await projectAccounting(f.api, next)).toBeDefined()
  }, 60000)
}

test("archive includes all ledger roles across iterations, key-only crashes and recovered predecessors", async () => {
  const f = await fixture()
  const design1 = f.add(`${f.project.marker.id}/design/1`)
  const closed = await f.controller(await f.ship()).close(1, receipt("close"))
  const next = await f.controller(closed.project).nextIteration(revision(closed.project), receipt("next"))
  const roles = [
    ["design", "conversation"],
    ["design", "research"],
    ["prototype", "proposal-generation"],
    ["prototype", "variant"],
    ["implement", "setup"],
    ["implement", "coordinator"],
    ["implement", "spec-generation"],
    ["implement", "correction-checkout"],
    ["implement", "worker"],
    ["accept", "reviewer"],
    ["accept", "freshness"],
    ["ship", "deterministic-tools"],
    ["ship", "summary"],
  ] as const
  for (const [stage, role] of roles) {
    const variant = role === "variant" ? "example" : undefined
    const key =
      role === "variant"
        ? `${next.marker.id}/iteration/2/prototype/example/policy/new`
        : role === "conversation"
          ? `${next.marker.id}/design/2`
          : `${next.marker.id}/iteration/2/${role}`
    await f.inventory(
      next,
      key,
      { iteration: 2, stage, role, ...(variant ? { variant } : {}) },
      role !== "summary",
    )
  }
  const oldKey = `${next.marker.id}/iteration/2/prototype/example`
  const old = f.add(oldKey)
  const latest = f.records.get(`${oldKey}/policy/new`)!
  const storage = path.join(f.api.dataDir, "prototype-conversations")
  await mkdir(storage, { recursive: true })
  await writeFile(
    path.join(storage, `${createHash("sha256").update(oldKey).digest("hex")}.json`),
    JSON.stringify({
      root: f.root,
      key: oldKey,
      id: latest.id,
      sessionKey: latest.key,
      previous: { key: oldKey, id: old.id },
    }),
  )
  const accounting = await projectAccounting(f.api, next)
  await accounting.costs.intent(`${next.marker.id}/never-opened`, {
    iteration: 2,
    stage: "ship",
    role: "unopened",
  })
  const result = await f.controller(next).archive(revision(next), receipt("archive"))
  expect(result.operation.status).toBe("completed")
  expect(projectLifecycle(result.project).status).toBe("archived")
  expect(result.operation.owners.find((owner) => owner.key === design1.key)?.status).toBe("archived")
  expect(result.operation.owners.find((owner) => owner.key === old.key)?.status).toBe("archived")
  expect(result.operation.owners.find((owner) => owner.role === "summary")?.id).toBeDefined()
  expect(result.operation.owners.find((owner) => owner.role === "unopened")?.status).toBe("absent")
  for (const row of f.records.values()) expect(row.archived).toBe(true)
  expect(new Set(result.operation.owners.map((owner) => owner.key)).size).toBe(result.operation.owners.length)
}, 60000)

test("historical-only archive recovers design by key and reconciles costs without initializing a runtime account", async () => {
  const f = await fixture()
  const design = f.add(`${f.project.marker.id}/design/1`)
  const result = await f.controller().archive(0, receipt())
  expect(result.operation.status).toBe("completed")
  expect(f.records.get(design.key)?.archived).toBe(true)
  expect(await cachedProjectAccounting(f.api, result.project)).toBeUndefined()
  expect(await new ProjectDocumentStore(result.project).read("costs.json")).toMatchObject({
    owners: [{ key: design.key, id: design.id, snapshot: design.usage }],
  })
  const before = await tree(f.root)
  await f.controller(result.project).read()
  expect(await tree(f.root)).toEqual(before)
})

test("archive after restart reconciles newer and H3-drain usage without opening a runtime", async () => {
  const f = await fixture()
  const owner = await f.open()
  await disposeAccounting(f.api)
  const snapshot = f.records.get(owner.key)!
  snapshot.usage = { ...zeroUsage(snapshot.id), revision: 7 }
  snapshot.usage.own.knownCostUsd = 2
  snapshot.usage.total.knownCostUsd = 2
  f.setArchive(async () => {
    snapshot.usage.revision = 8
    snapshot.usage.own.knownCostUsd = 3
    snapshot.usage.total.knownCostUsd = 3
  })
  const calls = f.calls.length
  const result = await f.controller().archive(0, receipt())
  expect(result.operation.status).toBe("completed")
  const ledger = (await new ProjectDocumentStore(result.project).read("costs.json")) as {
    owners: { key: string; snapshot: { revision: number; own: { knownCostUsd: number } } }[]
  }
  expect(ledger.owners.find((entry) => entry.key === owner.key)?.snapshot.revision).toBe(8)
  expect(ledger.owners.find((entry) => entry.key === owner.key)?.snapshot.own.knownCostUsd).toBe(3)
  expect(f.calls.slice(calls).some((call) => call.startsWith("open:") || call.startsWith("send:"))).toBe(
    false,
  )
})

for (const fault of ["throwing stop", "lost run refusal"] as const) {
  test(`archive publishes recoverable failed drainage for ${fault}, then explicitly retries the original provider`, async () => {
    const f = await fixture()
    const handle = await f.open()
    const subscribed = deferred()
    const stopEntered = deferred()
    let listener: ((snapshot: RunnerSnapshot) => void) | undefined
    let broken = true
    let lost = false
    let stops = 0
    const snapshot = (): RunnerSnapshot => ({ runId: "original-run", cwd: f.root, status: "running" })
    const runner: BoundRunner = {
      available: () => true,
      capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
      startBound: async () => ({ runId: "original-run" }),
      status: () => (lost ? undefined : snapshot()),
      stop: () => {
        stops++
        stopEntered.resolve()
        if (broken && fault === "throwing stop") throw new Error("provider stop archive sentinel")
        return !broken
      },
      onProgress: () => () => {},
      onResult: (_id, callback) => {
        listener = callback
        subscribed.resolve()
        return () => {
          listener = undefined
        }
      },
    }
    f.api.useService = () => runner as never
    const command = runBound({
      api: f.api,
      mode: "workflow",
      handle,
      cwd: f.root,
      signal: new AbortController().signal,
      batchId: "B1",
      seed: "No execution",
      items: [{ id: "S1", description: "No execution" }],
    }).catch((error: unknown) => error)
    await subscribed.promise
    await (await projectAccounting(f.api, f.project)).costs.flush()
    if (fault === "lost run refusal") {
      lost = true
      expect(String(await command)).toContain("lost run")
    }
    const archiving = f.controller().archive(0, receipt("known-failure"))
    let retry: ReturnType<ProjectLifecycleController["archive"]> | undefined
    try {
      await stopEntered.promise
      const outcome = await Promise.race([archiving, Bun.sleep(5000).then(() => undefined)])
      expect(outcome).toBeDefined()
      if (!outcome) throw new Error("Known provider failure left archive waiting")
      expect(outcome.operation.status).toBe("failed")
      expect(outcome.operation.errors.join(" ")).toMatch(
        fault === "throwing stop" ? /provider stop archive sentinel/ : /settlement unavailable/,
      )
      expect((await f.controller(outcome.project).read()).at(-1)?.status).toBe("failed")
      expect(projectLifecycle(outcome.project).status).toBe("archive-pending")
      await expect(f.controller(outcome.project).restore(1, receipt("restore"))).rejects.toThrow(/pending/)
      expect(listener).toBeDefined()
      const attempts = stops
      broken = false
      lost = false
      f.api.useService = () => undefined as never
      retry = f.controller(outcome.project).archive(1, receipt("explicit-retry"), { retry: true })
      for (let i = 0; i < 200 && stops === attempts; i++) await Bun.sleep(5)
      expect(stops).toBeGreaterThan(attempts)
      let completed = false
      void retry.then(() => {
        completed = true
      })
      await Bun.sleep(30)
      expect(completed).toBe(false)
      const usage = f.records.get(handle.key)!.usage
      usage.revision = 22
      usage.own.knownCostUsd = usage.total.knownCostUsd = 2
      usage.own.usage.cost = usage.total.usage.cost = 2
      listener!({ ...snapshot(), status: "aborted" })
      expect((await retry).operation.status).toBe("completed")
      expect(
        (await f.controller(await readProject(f.root)).read()).map((operation) => operation.status),
      ).toEqual(["failed", "completed"])
      const ledger = (await new ProjectDocumentStore(await readProject(f.root)).read("costs.json")) as {
        owners: { snapshot?: { revision: number } }[]
      }
      expect(ledger.owners[0]?.snapshot?.revision).toBe(22)
    } finally {
      broken = false
      lost = false
      listener?.({ ...snapshot(), status: "aborted" })
      await command
      await archiving
      await retry
    }
  }, 60000)
}

test("provider drain failure remains durable and fenced; explicit retry is needed before restore", async () => {
  const f = await fixture()
  const owner = await f.open()
  let fail = true
  let stops = 0
  retainAccountedRun(owner, {
    stop() {
      stops++
    },
    async drain() {
      if (fail) throw new Error("Provider drainage uncertain")
    },
  })
  const failed = await f.controller().archive(0, receipt("archive"))
  expect(failed.operation.status).toBe("failed")
  expect(failed.operation.errors.join(" ")).toContain("Provider drainage uncertain")
  expect(projectLifecycle(failed.project).status).toBe("archive-pending")
  expect(f.records.get(owner.key)?.archived).toBe(true)
  await expect(f.controller(failed.project).restore(1, receipt("restore"))).rejects.toThrow(/pending/i)
  await expect(
    new LifecycleStore(failed.project).transition(1, { type: "restore", receipt: receipt() }),
  ).rejects.toThrow(/settled/i)
  await expect(f.controller(failed.project).archive(1, receipt())).rejects.toThrow(/retry/i)
  fail = false
  const retried = await f.controller(failed.project).archive(1, receipt("retry"), { retry: true })
  expect(retried.operation.status).toBe("completed")
  expect(stops).toBe(2)
  expect((await f.controller(retried.project).read()).map((row) => row.status)).toEqual([
    "failed",
    "completed",
  ])
}, 60000)

test("host archive failure archives other owners, retains the fence and records each outcome for explicit retry", async () => {
  const f = await fixture()
  const design = await f.open()
  const other = await f.inventory(f.project, `${f.project.marker.id}/iteration/1/setup`, {
    iteration: 1,
    stage: "implement",
    role: "setup",
  })
  f.setArchive(async (key) => {
    if (key === design.key) throw new Error("Host lease conflict")
  })
  const failed = await f.controller().archive(0, receipt())
  expect(failed.operation.status).toBe("failed")
  expect(failed.operation.owners.find((owner) => owner.key === design.key)?.status).toBe("failed")
  expect(failed.operation.owners.find((owner) => owner.key === other.key)?.status).toBe("archived")
  expect(projectLifecycle(await readProject(f.root)).status).toBe("archive-pending")
  expect(await cachedProjectAccounting(f.api, failed.project)).toBeUndefined()
  f.setArchive(undefined)
  const done = await f.controller(failed.project).archive(1, receipt("retry"), { retry: true })
  expect(done.operation.status).toBe("completed")
  expect(f.records.get(design.key)?.archived).toBe(true)
})

test("explicit retry reaches H3 when an incomplete host archive intentionally refuses inert reads", async () => {
  const f = await fixture()
  const owner = await f.open()
  const read = f.api.conversations!.read.bind(f.api.conversations!)
  let incomplete = false
  let fail = true
  f.api.conversations!.read = async (ref) => {
    if (incomplete) throw new Error("owned conversation archive is incomplete; retry archive")
    return read(ref)
  }
  f.setArchive(async () => {
    if (fail) {
      incomplete = true
      throw new Error("Host archive persistence failed")
    }
    incomplete = false
  })
  const failed = await f.controller().archive(0, receipt())
  expect(failed.operation.status).toBe("failed")
  fail = false
  const settled = await f.controller(failed.project).archive(1, receipt("retry"), { retry: true })
  expect(settled.operation.status).toBe("completed")
  expect(f.records.get(owner.key)?.archived).toBe(true)
}, 60000)

test("close host failure never publishes a closed receipt and rejects next iteration", async () => {
  const f = await fixture()
  await f.open()
  const shipped = await f.ship()
  f.setArchive(async () => {
    throw new Error("Disk full")
  })
  const failed = await f.controller(shipped).close(1, receipt())
  expect(projectLifecycle(failed.project).iterations[1]?.status).toBe("close-pending")
  expect(failed.operation.status).toBe("failed")
  await expect(
    f.controller(failed.project).nextIteration(revision(failed.project), receipt()),
  ).rejects.toThrow()
  f.setArchive(undefined)
  expect(
    (await f.controller(failed.project).close(2, receipt("retry"), { retry: true })).operation.status,
  ).toBe("completed")
})

test("ID/key disagreement fails closed rather than archiving a replacement or certifying missing history", async () => {
  const f = await fixture()
  const owner = await f.open()
  f.records.get(owner.key)!.id = "replacement-id"
  const result = await f.controller().archive(0, receipt())
  expect(result.operation.status).toBe("failed")
  expect(result.operation.errors.join(" ")).toMatch(/ID\/key|identit/i)
  expect(f.calls.some((call) => call.startsWith("archive:"))).toBe(false)
  expect(projectLifecycle(result.project).status).toBe("archive-pending")
})

test("restore is inert; explicit continuation unarchives only current open design, never workers or old iterations", async () => {
  const f = await fixture()
  const owner = await f.open()
  const worker = await f.inventory(f.project, `${f.project.marker.id}/iteration/1/worker`, {
    iteration: 1,
    stage: "implement",
    role: "worker",
  })
  const archived = await f.controller().archive(0, receipt("archive"))
  const calls = [...f.calls]
  const restored = await f.controller(archived.project).restore(2, receipt("restore"))
  expect(f.calls).toEqual(calls)
  expect(projectLifecycle(restored).iterations[1]?.status).toBe("open")
  expect(f.records.get(owner.key)?.archived).toBe(true)
  expect(f.records.get(worker.key)?.archived).toBe(true)
  await f.controller(restored).continueConversation(3, receipt("continue"))
  expect(f.calls.slice(calls.length)).toEqual([`unarchive:${owner.key}`])
  expect(f.records.get(owner.key)?.archived).toBe(false)
  expect(f.records.get(worker.key)?.archived).toBe(true)
  expect(f.calls.some((call) => call.startsWith("send:"))).toBe(false)
  await expect(f.controller(restored).continueConversation(2, receipt("stale"))).rejects.toThrow(/stale/i)
  // A closed historical iteration cannot be made executable by restoration.
  const shipped = await f.ship()
  const closed = await f.controller(shipped).close(revision(shipped), receipt("close"))
  const rearchived = await f
    .controller(closed.project)
    .archive(revision(closed.project), receipt("archive-again"))
  const reopened = await f
    .controller(rearchived.project)
    .restore(revision(rearchived.project), receipt("restore-again"))
  await expect(f.controller(reopened).continueConversation(revision(reopened), receipt())).rejects.toThrow(
    /read-only|restored open iteration/i,
  )
  expect(f.records.get(owner.key)?.archived).toBe(true)
}, 60000)

for (const stage of ["accept", "implement"] as const) {
  test(`restore continuation retires archived running ${stage} into normal fresh-approval bookkeeping`, async () => {
    const f = await fixture()
    const roots: string[] = []
    const b = await bindingFixture(roots)
    cleanups.push(async () => {
      for (const root of roots) await rm(root, { recursive: true, force: true })
    })
    const review = await startReview(b.store, b.state, b.verdict)
    let running = review.state
    if (stage === "implement") {
      review.verdict.outcome = "fail"
      review.verdict.items = b.verdict.items.map((item) => ({
        ...item,
        status: "fail",
        reason: "Needs repair",
      }))
      await summarize(b.store, await consume(b.store, review.state, review.verdict))
      const approved = await commandHarness(b.project).run()
      expect(approved.stage).toBe("implement")
      running = await b.store.dispatch(approved.revision, {
        type: "start-work",
        expectedRevision: approved.revision,
        attemptId: "archived-implementation",
      })
    }
    const archived = await f.controller(b.project).archive(0, receipt("archive-running"))
    const restored = await f.controller(archived.project).restore(2, receipt("restore-running"))
    const continued = await f
      .controller(restored)
      .continueConversation(3, receipt("continue-running"), { stageRevision: running.revision })
    const state = await new HistoricalIterationReader(continued, 1).read()
    expect(state.status).toBe("interrupted")
    expect(state.attempts.find((attempt) => attempt.id === running.activeAttemptId)?.status).toBe(
      "interrupted",
    )
    expect((await commandHarness(continued).run()).phase).toBe("confirmed")
    expect(
      f.calls.some(
        (call) => call.startsWith("open:") || call.startsWith("send:") || call.startsWith("unarchive:"),
      ),
    ).toBe(false)
  }, 60000)
}

test("explicit prototype continuation unarchives current variant only, not its predecessor or workers", async () => {
  const f = await fixture()
  const store = new IterationStore(f.project)
  const summary = await store.saveArtifact(0, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Try prototypes",
    outputs: [],
    suggestion: "Prototype",
  })
  let state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "try-prototype",
      from: "design",
      to: "prototype",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Try",
      skippedStages: ["design"],
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "try-prototype", "prototype"),
  })
  const directory = await store.preparePrototypeDirectory("alpha")
  const saved = await store.saveArtifact(state.revision, {
    kind: "prototype-manifest",
    variants: [
      {
        id: "alpha",
        idea: "Try",
        question: "Does it work?",
        directory,
        cwd: directory,
        runCommand: null,
        prerequisites: [],
        notes: "",
        status: "building",
      },
    ],
  })
  const base = `${f.project.marker.id}/iteration/1/prototype/alpha`
  const previous = await f.inventory(f.project, base, {
    iteration: 1,
    stage: "prototype",
    role: "variant",
    variant: "alpha",
  })
  const latest = await f.inventory(f.project, `${base}/policy/current`, {
    iteration: 1,
    stage: "prototype",
    role: "variant",
    variant: "alpha",
  })
  const worker = await f.inventory(f.project, `${f.project.marker.id}/iteration/1/setup/old`, {
    iteration: 1,
    stage: "implement",
    role: "setup",
  })
  const directoryStorage = path.join(f.api.dataDir, "prototype-conversations")
  await mkdir(directoryStorage, { recursive: true })
  await writeFile(
    path.join(directoryStorage, `${createHash("sha256").update(base).digest("hex")}.json`),
    JSON.stringify({
      root: f.root,
      key: base,
      sessionKey: latest.key,
      id: latest.id,
      previous: { id: previous.id, key: base },
    }),
  )
  const archived = await f.controller().archive(0, receipt("archive"))
  const restored = await f.controller(archived.project).restore(2, receipt("restore"))
  await expect(
    openAccounted(
      f.api,
      restored,
      { stage: "implement", role: "setup" },
      {
        key: "must-not-open",
        name: "Blocked",
        cwd: f.root,
        systemPrompt: "Never execute",
        callableTools: [],
      },
      { askUser: async () => undefined },
    ),
  ).rejects.toThrow(/continuation/i)
  const continued = await f
    .controller(restored)
    .continueConversation(3, receipt("new-stage-approval"), { stageRevision: saved.state.revision })
  expect(projectLifecycle(continued).iterations[1]?.continuationRequired).toBeUndefined()
  expect(f.records.get(latest.key)?.archived).toBe(false)
  expect(f.records.get(previous.key)?.archived).toBe(true)
  expect(f.records.get(worker.key)?.archived).toBe(true)
  expect((await f.controller(continued).read()).at(-1)?.stageRevision).toBe(saved.state.revision)
  expect(f.calls.some((call) => call.startsWith("send:"))).toBe(false)
}, 60000)

for (const stage of ["design", "accept"] as const) {
  test(`continuation result publication recovers locally after its ${stage} marker already committed`, async () => {
    const f = await fixture()
    let selected = f.project
    if (stage === "design") await f.open()
    else {
      const roots: string[] = []
      const b = await bindingFixture(roots)
      selected = b.project
      cleanups.push(async () => {
        for (const root of roots) await rm(root, { recursive: true, force: true })
      })
    }
    const archived = await f.controller(selected).archive(0, receipt("archive"))
    const restored = await f.controller(archived.project).restore(2, receipt("restore"))
    const update = ProjectDocumentStore.prototype.update
    const spy = spyOn(ProjectDocumentStore.prototype, "update").mockImplementation(function <T>(
      this: ProjectDocumentStore,
      name: string,
      updater: (value: unknown) => T | Promise<T>,
      options?: { administrative?: boolean },
    ) {
      return update.call(
        this,
        name,
        async (value) => {
          const next = await updater(value)
          if (name === "lifecycle-operations.json") {
            const operation = (next as { operations: { action: string; status: string }[] }).operations.at(-1)
            if (operation?.action === "continue-conversation" && operation.status === "completed")
              throw new Error("Crash after continuation marker")
          }
          return next
        },
        options,
      ) as Promise<T>
    })
    try {
      await expect(
        f.controller(restored).continueConversation(3, receipt("continue-original")),
      ).rejects.toThrow("Crash after continuation marker")
    } finally {
      spy.mockRestore()
    }
    const current = await readProject(selected.root)
    expect(projectLifecycle(current).iterations[1]?.continuationRequired).toBeUndefined()
    expect((await f.controller(current).read()).at(-1)?.status).toBe("pending")
    const calls = [...f.calls]
    const before = await tree(selected.root)
    const recovered = await f
      .controller(current)
      .continueConversation(4, receipt("recover-result"), { retry: true })
    const operation = (await f.controller(recovered).read()).at(-1)!
    expect(operation.status).toBe("completed")
    expect(operation.receipt.id).toBe("continue-original")
    expect(operation.owners.every((owner) => owner.status === "continued")).toBe(true)
    expect(f.calls).toEqual(calls)
    const after = await tree(selected.root)
    delete before[".amira/project/lifecycle-operations.json"]
    delete after[".amira/project/lifecycle-operations.json"]
    expect(after).toEqual(before)
  }, 60000)
}

test("continuation failure needs explicit retry and never opens or sends", async () => {
  const f = await fixture()
  const design = f.add(`${f.project.marker.id}/design/1`)
  const archived = await f.controller().archive(0, receipt())
  const restored = await f.controller(archived.project).restore(2, receipt("restore"))
  f.failUnarchive(true)
  await expect(f.controller(restored).continueConversation(3, receipt("continue"))).rejects.toThrow(
    /unavailable/i,
  )
  await expect(f.controller(restored).continueConversation(3, receipt("continue"))).rejects.toThrow(/retry/i)
  f.failUnarchive(false)
  await f.controller(restored).continueConversation(3, receipt("retry"), { retry: true })
  expect(f.records.get(design.key)?.archived).toBe(false)
  expect(f.calls.some((call) => /^(open|send):/.test(call))).toBe(false)
})

test("archive waits for an already-admitted open and archives its resolved key without admitting execution", async () => {
  const f = await fixture()
  const entered = deferred()
  const gate = deferred()
  f.setOpen(async () => {
    entered.resolve()
    await gate.promise
  })
  const opening = f.open().then(
    () => "opened",
    (error: unknown) => String(error),
  )
  await entered.promise
  const archive = f.controller().archive(0, receipt())
  // Observe the durable fence without relying on a timing delay.
  let reached!: () => void
  const fence = new Promise<void>((resolve) => {
    reached = resolve
  })
  const accounting = (await cachedProjectAccounting(f.api, f.project))!
  const original = accounting.stopAndDrain.bind(accounting)
  const spy = spyOn(accounting, "stopAndDrain").mockImplementation((reason) => {
    const task = original(reason)
    reached()
    return task
  })
  try {
    await fence
    expect(f.calls.some((call) => call.startsWith("archive:"))).toBe(false)
    gate.resolve()
    expect(await opening).toMatch(/stopped|read-only/i)
    const result = await archive
    expect(result.operation.status).toBe("completed")
    const design = [...f.records.values()][0]!
    expect(design.archived).toBe(true)
    expect(f.calls).toContain(`release:${design.key}`)
  } finally {
    spy.mockRestore()
    gate.resolve()
  }
}, 60000)

test("a foreign-instance pending first open cannot be certified absent before identity publication", async () => {
  const f = await fixture()
  const key = `${f.project.marker.id}/iteration/1/setup/foreign-opening`
  const accounting = await projectAccounting(f.api, f.project)
  await accounting.costs.intent(key, { iteration: 1, stage: "implement", role: "setup" })
  await new ProjectDocumentStore(f.project).update("owner-openings.json", () => ({
    schemaVersion: 1,
    projectId: f.project.marker.id,
    pending: [{ token: "foreign-instance", key, pid: process.pid }],
  }))
  const failed = await f.controller().archive(0, receipt())
  expect(failed.operation.status).toBe("failed")
  expect(failed.operation.errors.join(" ")).toContain("opening")
  const owner = f.add(key)
  await new ProjectDocumentStore(failed.project).update(
    "owner-openings.json",
    () => ({ schemaVersion: 1, projectId: f.project.marker.id, pending: [] }),
    { administrative: true },
  )
  const retried = await f.controller(failed.project).archive(1, receipt("retry-open"), { retry: true })
  expect(retried.operation.status).toBe("completed")
  expect(f.records.get(owner.key)?.archived).toBe(true)
}, 60000)

test("concurrent lifecycle attempts and stale/unbound receipts cannot pass the pending fence", async () => {
  const f = await fixture()
  f.add(`${f.project.marker.id}/design/1`)
  const entered = deferred()
  const gate = deferred()
  f.setArchive(async () => {
    entered.resolve()
    await gate.promise
  })
  const pending = f.controller().archive(0, receipt())
  await entered.promise
  const current = await readProject(f.root)
  await expect(f.controller(current).archive(1, receipt("other"), { retry: true })).rejects.toThrow(
    /running/i,
  )
  await expect(f.controller().archive(0, receipt("stale"))).rejects.toThrow(/stale/i)
  gate.resolve()
  await pending
  const fresh = await readProject(f.root)
  await expect(f.controller(fresh).restore(2, { ...receipt(), sessionId: "" })).rejects.toThrow(
    /identity-bound/i,
  )
})

test("explicit retry recovers a fence even if operation-document publication crashed", async () => {
  const f = await fixture()
  f.add(`${f.project.marker.id}/design/1`)
  const original = ProjectDocumentStore.prototype.update
  const spy = spyOn(ProjectDocumentStore.prototype, "update").mockImplementation(function <T>(
    this: ProjectDocumentStore,
    name: string,
    updater: (previous: unknown) => T | Promise<T>,
    options?: { administrative?: boolean },
  ): Promise<T> {
    if (name === "lifecycle-operations.json") throw new Error("Publication interrupted")
    return original.call(this, name, updater, options) as Promise<T>
  })
  try {
    await expect(f.controller().archive(0, receipt())).rejects.toThrow(/interrupted/i)
  } finally {
    spy.mockRestore()
  }
  const current = await readProject(f.root)
  expect(projectLifecycle(current).status).toBe("archive-pending")
  expect(f.calls.filter((call) => call.startsWith("archive:"))).toHaveLength(0)
  expect((await f.controller(current).archive(1, receipt("retry"), { retry: true })).operation.status).toBe(
    "completed",
  )
})

test("explicit retry recovers a published success receipt without replaying host archival", async () => {
  const f = await fixture()
  f.add(`${f.project.marker.id}/design/1`)
  const original = ProjectDocumentStore.prototype.update
  const spy = spyOn(ProjectDocumentStore.prototype, "update").mockImplementation(function <T>(
    this: ProjectDocumentStore,
    name: string,
    updater: (previous: unknown) => T | Promise<T>,
    options?: { administrative?: boolean },
  ): Promise<T> {
    return original.call(
      this,
      name,
      async (value) => {
        const next = await updater(value)
        if (
          name === "lifecycle-operations.json" &&
          (next as { operations?: { status: string }[] }).operations?.at(-1)?.status === "completed"
        )
          throw new Error("Result publication interrupted")
        return next
      },
      options,
    ) as Promise<T>
  })
  try {
    await expect(f.controller().archive(0, receipt())).rejects.toThrow(/interrupted/i)
  } finally {
    spy.mockRestore()
  }
  const current = await readProject(f.root)
  expect(projectLifecycle(current).status).toBe("archived")
  const count = f.calls.filter((call) => call.startsWith("archive:")).length
  const result = await f.controller(current).archive(2, receipt("recover"), { retry: true })
  expect(result.operation.status).toBe("completed")
  expect(f.calls.filter((call) => call.startsWith("archive:"))).toHaveLength(count)
})

test("explicit archive retry recovers an interrupted local fence publication without launching work", async () => {
  const f = await fixture()
  const design = f.add(`${f.project.marker.id}/design/1`)
  await expect(
    new LifecycleStore(f.project, {
      afterIntent() {
        throw new Error("Fence intent crash")
      },
    }).transition(0, { type: "archive-pending", receipt: receipt("first") }),
  ).rejects.toThrow(/crash/i)
  await expect(assertProjectWritable(f.project)).rejects.toThrow(/recovery/i)
  const result = await f.controller().archive(0, receipt("retry"), { retry: true })
  expect(result.operation.status).toBe("completed")
  expect(projectLifecycle(result.project).status).toBe("archived")
  expect(f.records.get(design.key)?.archived).toBe(true)
  expect(f.calls.some((call) => /^(open|send|unarchive):/.test(call))).toBe(false)
})

test("a synchronous provider stop failure cannot be mistaken for successful drainage", async () => {
  const f = await fixture()
  const owner = await f.open()
  let fail = true
  retainAccountedRun(owner, {
    stop() {
      if (fail) throw new Error("Provider refused cancellation")
    },
    async drain() {},
  })
  const result = await f.controller().archive(0, receipt())
  expect(result.operation.status).toBe("failed")
  expect(result.operation.errors.join(" ")).toMatch(/refused cancellation/i)
  expect(projectLifecycle(result.project).status).toBe("archive-pending")
  fail = false
  const settled = await f.controller(result.project).archive(1, receipt("retry"), { retry: true })
  expect(settled.operation.status).toBe("completed")
})

test("missing H3 capability is durably visible and leaves the project admission fence in place", async () => {
  const f = await fixture()
  const conversations = f.api.conversations as unknown as { unarchive?: unknown }
  delete conversations.unarchive
  const result = await f.controller().archive(0, receipt())
  expect(result.operation.status).toBe("failed")
  expect(result.operation.errors.join(" ")).toMatch(/read\/archive\/unarchive support/i)
  expect(projectLifecycle(result.project).status).toBe("archive-pending")
  expect((await f.controller(result.project).read()).at(-1)?.status).toBe("failed")
  await expect(assertProjectWritable(f.project)).rejects.toThrow(/read-only/i)
})
