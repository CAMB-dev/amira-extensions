import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  AnyEvent,
  CompleteResult,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
  OwnedConversationSnapshot,
} from "@amira/api"
import {
  configureAccounting,
  disposeAccounting,
  openAccounted,
  projectAccounting,
  retainAccountedRun,
} from "../src/accounting.ts"
import { type CostLedger, costRollups } from "../src/cost.ts"
import { type BoundRunner, type RunnerSnapshot, runBound } from "../src/execution-modes.ts"
import { createProject, LifecycleStore, type Project } from "../src/store.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const runtime = { askUser: async () => undefined }
function events() {
  const queue: AnyEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    send(event?: AnyEvent) {
      queue.push(
        event ??
          ({
            type: "budget.update",
            seq: 1,
            ts: 1,
            sessionId: "main",
            data: {
              usage: { input: 999999, output: 999999, cacheRead: 0, cacheWrite: 0, cost: 999999 },
              tokens: 999999,
            },
          } as AnyEvent),
      )
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (queue.length) yield queue.shift()!
          else
            await new Promise<void>((resolve) => {
              wake = resolve
            })
        }
      },
    },
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-accounting-"))
  const project = await createProject(root, "Costs")
  const records = new Map<
    string,
    {
      snapshot: OwnedConversationSnapshot
      handle?: OwnedConversation
      stream: ReturnType<typeof events>
      stops: number
      releases: number
    }
  >()
  const notices: string[] = []
  let opens = 0
  let sends = 0
  let crash = false
  let generate: ((key: string, signal: AbortSignal) => Promise<CompleteResult>) | undefined
  const api = {
    dataDir: path.join(root, "extension-data"),
    notify: (text: string) => notices.push(text),
    requestRender() {},
    conversations: {
      async openOrCreate(spec: ConversationSpec) {
        opens++
        const ledger = JSON.parse(
          await readFile(path.join(spec.cwd, ".amira/project/costs.json"), "utf8"),
        ) as CostLedger
        expect(ledger.owners.some((owner) => owner.key === spec.key)).toBe(true)
        const id = `owned-${spec.key}`
        const stream = events()
        const record = records.get(spec.key) ?? {
          snapshot: {
            id,
            key: spec.key,
            name: spec.name,
            cwd: spec.cwd,
            archived: false,
            history: [],
            usage: zeroUsage(id),
          },
          stream,
          stops: 0,
          releases: 0,
        }
        record.stream = stream
        const handle: OwnedConversation = { ...ownedFixture(spec, id), events: stream.iterable }
        handle.usage = () => structuredClone(record.snapshot.usage)
        handle.send = async () => {
          sends++
        }
        let released = false
        let busy = false
        let operation: AbortController | undefined
        handle.status = () => ({ state: busy ? "working" : "idle", busy })
        handle.complete = async (request) => {
          if (!generate) throw new Error("Unexpected completion")
          operation = new AbortController()
          busy = true
          try {
            return await generate(
              spec.key,
              AbortSignal.any([operation.signal, ...(request.signal ? [request.signal] : [])]),
            )
          } finally {
            busy = false
          }
        }
        handle.stop = () => {
          if (released) throw new Error("Owner already released")
          record.stops++
          operation?.abort(new Error("Stopped"))
          return Promise.resolve()
        }
        handle.release = async () => {
          released = true
          operation?.abort(new Error("Released"))
          record.releases++
          stream.end()
        }
        record.handle = handle
        records.set(spec.key, record)
        if (crash) throw new Error("crash after host creation")
        return handle
      },
      async read(ref: { key: string }) {
        return structuredClone(records.get(ref.key)?.snapshot)
      },
    },
  } as unknown as ExtensionAPI
  cleanups.push(async () => {
    await disposeAccounting(api)
    await rm(root, { recursive: true, force: true })
  })
  const open = (key: string, selected: Project = project) =>
    openAccounted(
      api,
      selected,
      { stage: "implement", role: "worker", attempt: key },
      { key, name: key, cwd: selected.root, systemPrompt: "mock", callableTools: [] },
      runtime,
    )
  const receipt = (key: string, cost: number, revision: number, complete = true) => {
    const record = records.get(key)!
    const value = {
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, ...(complete ? { cost } : {}) },
      knownCostUsd: cost,
      complete,
    }
    record.snapshot.usage = {
      sessionId: record.snapshot.id,
      revision,
      own: value,
      total: value,
      descendants: [],
    }
  }
  return {
    api,
    project,
    records,
    notices,
    open,
    receipt,
    opens: () => opens,
    sends: () => sends,
    crash: (value: boolean) => {
      crash = value
    },
    generate: (callback: NonNullable<typeof generate>) => {
      generate = callback
    },
  }
}

test("a normally pending priced completion is not cancelled by accounting refresh", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 100 })
  const handle = await f.open("priced-pending")
  const account = await projectAccounting(f.api, f.project)
  const began = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  f.generate(async (key, signal) => {
    began.resolve()
    await Promise.race([
      gate.promise,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ])
    f.receipt(key, 4, 2)
    return {
      text: "priced",
      message: {
        role: "assistant",
        model: { provider: "mock", model: "priced" },
        content: [{ type: "text", text: "priced" }],
      },
    }
  })
  const result = handle.complete({ messages: [] }).then(
    (value) => ({ text: value.text }),
    (error: unknown) => ({ error }),
  )
  await began.promise
  const record = f.records.get(handle.key)!
  record.snapshot.usage = zeroUsage(handle.id)
  record.snapshot.usage.revision = 1
  record.snapshot.usage.own.complete = record.snapshot.usage.total.complete = false
  try {
    await account.refresh(handle.key, handle)
    expect(account.costs.snapshot().policy.latch).toBeUndefined()
    expect(record.stops).toBe(0)
  } finally {
    gate.resolve()
  }
  expect(await result).toEqual({ text: "priced" })
  expect(costRollups(account.costs.snapshot()).project.knownCostUsd).toBe(4)
}, 60000)

test("a pending sibling does not mask settled descendant accounting gaps at admission", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 100 })
  const handle = await f.open("sibling-gap")
  const account = await projectAccounting(f.api, f.project)
  const record = f.records.get(handle.key)!
  record.stream.send({
    type: "subagent.start",
    seq: 1,
    ts: 1,
    sessionId: handle.id,
    data: { childSessionId: "busy" },
  } as AnyEvent)
  record.stream.send()
  for (let i = 0; i < 500 && !account.costs.snapshot().owners[0]?.coverage?.pending; i++) await Bun.sleep(10)
  expect(account.costs.snapshot().owners[0]?.coverage?.pending).toBe(true)
  const snapshot = zeroUsage(handle.id)
  snapshot.revision = 1
  const settled = {
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2 },
    knownCostUsd: 2,
    complete: false,
  }
  const busy = {
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 3 },
    knownCostUsd: 3,
    complete: false,
  }
  snapshot.descendants = [
    { sessionId: "settled", parentSessionId: handle.id, usage: settled },
    { sessionId: "busy", parentSessionId: handle.id, usage: busy },
  ]
  snapshot.total = {
    usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5 },
    knownCostUsd: 5,
    complete: false,
  }
  record.snapshot.usage = snapshot
  await account.refresh(handle.key, handle)
  expect(() => account.assertAdmission()).toThrow("unpriced")
  await account.settled()
  expect(record.releases).toBe(1)
  expect(costRollups(account.costs.snapshot()).project.knownCostUsd).toBe(5)
}, 60000)

test("stop and release cleanup are idempotent after budget enforcement released the owner", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 10 })
  const handle = await f.open("released-cleanup")
  const account = await projectAccounting(f.api, f.project)
  f.receipt(handle.key, 10, 1)
  await account.refresh(handle.key, handle)
  await account.settled()
  await account.costs.configure("remove")
  await expect(handle.stop("quiesce interrupted binding")).resolves.toBeUndefined()
  await handle.release()
  expect(f.records.get(handle.key)!.stops).toBe(1)
  expect(f.records.get(handle.key)!.releases).toBe(1)
}, 60000)

test("cap stops and releases all project owners, not another project or main; shared event payload is ignored", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 10 })
  const otherRoot = await mkdtemp(path.join(tmpdir(), "project-other-costs-"))
  cleanups.unshift(async () => {
    await rm(otherRoot, { recursive: true, force: true })
  })
  const other = await createProject(otherRoot, "Other")
  const a = await f.open("a")
  const b = await f.open("b")
  const c = await f.open("c", other)
  const account = await projectAccounting(f.api, f.project)
  f.receipt("a", 8, 1)
  f.records.get("a")!.stream.send()
  await account.refresh("a", a)
  expect(costRollups(account.costs.snapshot()).project.knownCostUsd).toBe(8)
  f.receipt("b", 2, 1)
  const update = account.refresh("b", b)
  expect(f.records.get("a")!.stops).toBeGreaterThan(0)
  expect(f.records.get("b")!.releases).toBeGreaterThan(0)
  await update
  await account.settled()
  expect(f.records.get("c")!.stops).toBe(0)
  expect(f.records.get("c")!.releases).toBe(0)
  await c.send("unrelated work")
  expect(f.sends()).toBe(1)
  await expect(a.send("stale native composer")).rejects.toThrow("stopped")
  await expect(f.open("new")).rejects.toThrow("stopped")
  expect(f.opens()).toBe(3)
  await account.costs.configure("raise", 20)
  await expect(a.send("old handle")).rejects.toThrow("released")
  const continued = await f.open("a")
  await continued.send("fresh approved attempt")
  expect(f.sends()).toBe(2)
}, 60000)

test("cap aborts a retained original provider before waiting for a pending start/drain", async () => {
  const f = await fixture()
  const handle = await f.open("pending")
  const account = await projectAccounting(f.api, f.project)
  await account.costs.configure("cap", 10)
  let stopped = false
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const unregister = retainAccountedRun(handle, {
    stop() {
      stopped = true
    },
    drain: () => pending,
  })
  f.receipt("pending", 10, 1)
  const update = account.refresh("pending", handle)
  expect(stopped).toBe(true)
  await update
  let drained = false
  const settled = account.settled().then(() => {
    drained = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(drained).toBe(false)
  finish()
  await settled
  unregister()
}, 60000)

test("creation crash recovers intended key through inert read without opening another runtime", async () => {
  const f = await fixture()
  f.crash(true)
  await expect(f.open("crash")).rejects.toThrow("crash after host creation")
  const file = path.join(f.project.root, ".amira/project/costs.json")
  const intended = JSON.parse(await readFile(file, "utf8")) as CostLedger
  expect(intended.owners[0]!.key).toBe("crash")
  expect(intended.owners[0]!.id).toBeUndefined()
  f.receipt("crash", 3, 1)
  const account = await projectAccounting(f.api, f.project)
  await account.reconcile()
  expect(f.opens()).toBe(1)
  expect(account.costs.snapshot().owners[0]!.id).toBe("owned-crash")
  expect(costRollups(account.costs.snapshot()).project.knownCostUsd).toBe(3)
}, 60000)

test("late receipts after release update historical costs by revision without reopening", async () => {
  const f = await fixture()
  const handle = await f.open("late")
  await handle.release()
  const account = await projectAccounting(f.api, f.project)
  f.receipt("late", 5, 2)
  await account.reconcile()
  f.receipt("late", 2, 3)
  await account.reconcile()
  expect(costRollups(account.costs.snapshot()).project.knownCostUsd).toBe(2)
  expect(f.opens()).toBe(1)
}, 60000)

test("released owners cannot prevent cap-stop fanout when raw stop throws synchronously", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 10 })
  const old = await f.open("old")
  await old.release()
  const live = await f.open("live")
  const account = await projectAccounting(f.api, f.project)
  f.receipt("live", 10, 1)
  await account.refresh("live", live)
  await account.settled()
  expect(f.records.get("old")!.stops).toBe(0)
  expect(f.records.get("live")!.stops).toBe(1)
  expect(f.records.get("live")!.releases).toBe(1)
}, 60000)

test("release drains the host even when final ledger persistence fails", async () => {
  const f = await fixture()
  const handle = await f.open("failure")
  f.receipt("failure", 2, 1)
  await writeFile(path.join(f.project.root, ".amira/project/costs.json"), '{"schemaVersion":99}')
  await expect(handle.release()).rejects.toThrow("Unsupported")
  expect(f.records.get("failure")!.releases).toBe(1)
}, 60000)

test("archive fence permits final costs but rejects policy changes and new work", async () => {
  const f = await fixture()
  const handle = await f.open("settled")
  await handle.release()
  await new LifecycleStore(f.project).transition(0, {
    type: "archive-pending",
    receipt: { id: "human", sessionId: "main", date: new Date().toISOString() },
  })
  const account = await projectAccounting(f.api, f.project)
  f.receipt("settled", 3, 1)
  await account.reconcile()
  const saved = JSON.parse(
    await readFile(path.join(f.project.root, ".amira/project/costs.json"), "utf8"),
  ) as CostLedger
  expect(costRollups(saved).project.knownCostUsd).toBe(3)
  await expect(account.costs.configure("cap", 10)).rejects.toThrow("read-only")
  await expect(f.open("never")).rejects.toThrow("read-only")
}, 60000)

test("a slow run-binding write cannot expose progress before result subscription or lose settlement", async () => {
  const f = await fixture()
  const handle = await f.open("bound")
  const account = await projectAccounting(f.api, f.project)
  const gate = Promise.withResolvers<void>()
  const discover = account.costs.discover.bind(account.costs)
  account.costs.discover = async (...args) => {
    await gate.promise
    await discover(...args)
  }
  let listener: ((value: RunnerSnapshot) => void) | undefined
  const snapshot: RunnerSnapshot = {
    runId: "run",
    cwd: f.project.root,
    status: "running",
    models: ["mock/worker"],
    sessionIds: ["child"],
  }
  const runner: BoundRunner = {
    available: () => true,
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    startBound: async () => ({ runId: "run" }),
    status: () => snapshot,
    stop: () => true,
    onProgress: () => () => {},
    onResult: (_id, callback) => {
      listener = callback
      return () => {}
    },
  }
  f.api.useService = () => runner as never
  const running = runBound({
    api: f.api,
    mode: "workflow",
    handle,
    cwd: f.project.root,
    signal: new AbortController().signal,
    batchId: "B1",
    seed: "mock",
    items: [{ id: "S1", description: "mock item" }],
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const subscribedBeforeBinding = listener !== undefined
  gate.resolve()
  for (let attempt = 0; attempt < 1000 && !listener; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  listener!({ ...snapshot, status: "done", result: "settled" })
  expect((await running).text).toBe("settled")
  account.costs.discover = discover
  expect(subscribedBeforeBinding).toBe(true)
}, 60000)

test("a cap-cancelled pending provider start retains its late run identity after stopping it", async () => {
  const f = await fixture()
  configureAccounting(f.api, { defaultCapUsd: () => 10 })
  const handle = await f.open("late-start")
  const account = await projectAccounting(f.api, f.project)
  const start = Promise.withResolvers<{ runId: string }>()
  const began = Promise.withResolvers<void>()
  const stopped: string[] = []
  const runner: BoundRunner = {
    available: () => true,
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    startBound: async () => {
      began.resolve()
      return start.promise
    },
    status: () => undefined,
    stop: (id) => {
      stopped.push(id)
      return true
    },
    onProgress: () => () => {},
    onResult: () => () => {},
  }
  f.api.useService = () => runner as never
  const running = runBound({
    api: f.api,
    mode: "workflow",
    handle,
    cwd: f.project.root,
    signal: new AbortController().signal,
    batchId: "B1",
    seed: "mock",
    items: [{ id: "S1", description: "mock item" }],
  })
  const rejected = running.then(
    () => false,
    () => true,
  )
  await began.promise
  f.receipt("late-start", 10, 1)
  await account.refresh("late-start", handle)
  start.resolve({ runId: "late-run" })
  expect(await rejected).toBe(true)
  await account.settled()
  expect(stopped).toEqual(["late-run"])
  expect(account.costs.snapshot().owners[0]!.runs).toEqual([{ kind: "workflow", id: "late-run" }])
}, 60000)

test("unsupported ledger rejects before acquiring an executable owner", async () => {
  const f = await fixture()
  await writeFile(path.join(f.project.root, ".amira/project/costs.json"), '{"schemaVersion":99}')
  await expect(f.open("never")).rejects.toThrow("Unsupported")
  expect(f.opens()).toBe(0)
  expect(await readFile(path.join(f.project.root, ".amira/project/costs.json"), "utf8")).toBe(
    '{"schemaVersion":99}',
  )
}, 60000)
