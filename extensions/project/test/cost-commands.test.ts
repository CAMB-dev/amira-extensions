import { afterEach, expect, spyOn, test } from "bun:test"
import * as syncFs from "node:fs"
import * as fs from "node:fs/promises"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  PanelDefinition,
  SessionData,
} from "@amira/api"
import { disposeAccounting, projectAccounting } from "../src/accounting.ts"
import { type CostLedger, initialCostLedger } from "../src/cost.ts"
import { FileCostPersistence } from "../src/cost-storage.ts"
import { ATTACHMENT_KEY, createProjectExtension } from "../src/index.ts"
import { createProject, IterationStore, type Project, readProject } from "../src/store.ts"
import { zeroUsage } from "./owned-fixture.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-cost-command-"))
  const records = new Map<string, unknown[]>()
  const data: SessionData = {
    read: (key) => records.get(key) ?? [],
    append(key, value) {
      records.set(key, [...(records.get(key) ?? []), structuredClone(value)])
    },
  }
  const session = {
    info: () => ({ id: "main", cwd: root, file: path.join(root, "session.jsonl") }),
    data,
    messages: () => [],
  }
  let command!: CommandDefinition
  let panel!: PanelDefinition
  let cap = "10"
  const output: string[] = []
  const fields: { key: string }[] = []
  const api = {
    dataDir: path.join(root, "extension-data"),
    cwd: root,
    session: () => session,
    settings: {
      declare(options: { fields: { key: string }[] }) {
        fields.push(...options.fields)
        return {
          get: () => ({ language: "en", reviewerModel: "", defaultProjectCapUsd: cap }),
          onChange() {},
        }
      },
    },
    registerCommand(value: CommandDefinition) {
      command = value
    },
    registerPanel(value: PanelDefinition) {
      panel = value
    },
    on() {},
    onUnload() {},
    requestRender() {},
    notify() {},
  } as unknown as ExtensionAPI
  cleanups.push(async () => {
    await disposeAccounting(api)
    await rm(root, { recursive: true, force: true })
  })
  await createProjectExtension()(api)
  const ctx = {
    cwd: root,
    session,
    frontend: "print",
    signal: new AbortController().signal,
    ui: { input: async () => undefined },
    print: (text: string) => output.push(text),
  } as unknown as CommandContext
  await command.run("new Budget --language en", ctx)
  const ledger = async () =>
    JSON.parse(await readFile(path.join(root, ".amira/project/costs.json"), "utf8")) as CostLedger
  return {
    api,
    root,
    command,
    ctx,
    panel,
    data,
    output,
    fields,
    ledger,
    setDefault: (value: string) => {
      cap = value
    },
  }
}

test("cost commands and cached panel expose the project-only cap and durable main-session receipts", async () => {
  const f = await fixture()
  expect(f.fields.some((field) => field.key === "defaultProjectCapUsd")).toBe(true)
  expect(f.fields.some((field) => /stage.*cap/i.test(field.key))).toBe(false)
  expect((await f.ledger()).policy.capUsd).toBe(10)
  await f.command.run("cost", f.ctx)
  expect(f.output.at(-1)).toContain("Project cost: $0.0000 reported")
  expect(f.output.at(-1)).toContain("Cap: $10.00")
  expect(
    f.panel
      .render({ sessionId: "main", data: f.data, width: 120, now: 0, collapsed: false })
      .map((line) => line.text)
      .join("\n"),
  ).toContain("Cap: $10.00")
  await f.command.run("cost cap 5", f.ctx)
  expect((await f.ledger()).receipts.at(-1)).toMatchObject({ action: "cap", sessionId: "main", cap: 5 })
  f.setDefault("50")
  await f.command.run("cost", f.ctx)
  expect((await f.ledger()).policy.capUsd).toBe(5)
  await f.command.run("cost raise 4", f.ctx)
  expect(f.output.at(-1)).toContain("raise must exceed")
  expect((await f.ledger()).policy.capUsd).toBe(5)
  await f.command.run("cost remove", f.ctx)
  expect((await f.ledger()).policy.capUsd).toBeUndefined()
  expect((await f.ledger()).receipts.at(-1)?.action).toBe("remove")
}, 60000)

test("a ledger revision conflict explains reload without retrying the stale cached revision", async () => {
  const f = await fixture()
  const account = await projectAccounting(f.api, await readProject(f.root))
  const external = await f.ledger()
  external.revision++
  external.policy.capUsd = 25
  const file = path.join(f.root, ".amira/project/costs.json")
  await writeFile(file, JSON.stringify(external))
  await expect(account.costs.configure("raise", 20)).rejects.toThrow("changed in another writer")
  await account.settled().catch(() => {})
  const before = await readFile(file, "utf8")
  const save = spyOn(FileCostPersistence.prototype, "save")
  try {
    await f.command.run("cost", f.ctx)
    expect(f.output.at(-1)).toContain("Reload the project extension")
    expect(save).not.toHaveBeenCalled()
    expect(await readFile(file, "utf8")).toBe(before)
    expect(() => account.costs.assertAdmission()).toThrow("Reload the project extension")
  } finally {
    save.mockRestore()
  }
}, 60000)

test("cost command recovers an unchanged snapshot after a failed save without waiving the stop", async () => {
  const f = await fixture()
  const account = await projectAccounting(f.api, await readProject(f.root))
  await account.costs.intent("saved", { iteration: 1, stage: "implement", role: "worker" })
  await account.costs.bind("saved", "saved")
  await account.costs.observe("saved", zeroUsage("saved"))
  const claim = path.join(f.root, ".amira/project/.project-writer.lock")
  await writeFile(claim, JSON.stringify({ pid: process.pid, token: "00000000-0000-0000-0000-000000000000" }))
  const usage = zeroUsage("saved")
  usage.revision = 1
  usage.own.knownCostUsd = usage.total.knownCostUsd = 3
  Object.assign(f.api, {
    conversations: {
      read: async () => ({
        id: "saved",
        key: "saved",
        name: "Recovered",
        cwd: f.root,
        archived: false,
        history: [],
        usage,
      }),
    },
  })
  await expect(account.costs.observe("saved", usage)).rejects.toThrow("live writer")
  await expect(account.settled()).rejects.toThrow("live writer")
  await unlink(claim)
  await f.command.run("cost", f.ctx)
  expect(f.output.at(-1)).toContain("$3.0000 reported")
  expect((await f.ledger()).policy.latch?.reason).toBe("accounting")
  expect(() => account.costs.assertAdmission()).toThrow("stopped")
  await f.command.run("cost raise 20", f.ctx)
  expect((await f.ledger()).policy.capUsd).toBe(20)
  expect(() => account.costs.assertAdmission()).not.toThrow()
}, 60000)

async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await files(file)))
        result[`${entry.name}/${name}`] = content
    } else
      result[entry.name] = `${(await fs.stat(file)).mtimeMs}:${(await fs.readFile(file)).toString("base64")}`
  }
  return result
}

async function restoredFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-cost-restore-"))
  const project = await createProject(root, "Restored")
  await new IterationStore(project).read()
  const ledger = initialCostLedger(project.marker.id, "2026-10-19T00:00:00Z")
  const usage = zeroUsage("saved-owner")
  usage.own.knownCostUsd = usage.total.knownCostUsd = 12
  ledger.owners.push({
    key: "saved-owner",
    id: "saved-owner",
    provenance: "owned",
    iteration: 1,
    stage: "implement",
    role: "worker",
    groups: [],
    sessions: [],
    runs: [],
    snapshot: usage,
  })
  ledger.policy = {
    capUsd: 10,
    warned: true,
    latch: { reason: "cap", at: ledger.coverage.since, version: 1 },
  }
  const persistence = new FileCostPersistence(project)
  await persistence.save(ledger, (await persistence.read())?.revision)
  const records = new Map<string, unknown[]>()
  const data: SessionData = {
    read: (key) => records.get(key) ?? [],
    append(key, value) {
      records.set(key, [...(records.get(key) ?? []), structuredClone(value)])
    },
  }
  const attach = (selected: Project) =>
    data.append(ATTACHMENT_KEY, {
      projectId: selected.marker.id,
      root: selected.root,
      attachedAt: ledger.coverage.since,
    })
  attach(project)
  let id = "restored-main"
  const session = {
    info: () => ({ id, cwd: root, file: path.join(root, "session.jsonl") }),
    data,
    messages: () => [],
  }
  const handlers = new Map<string, (event: { sessionId: string }) => void | Promise<void>>()
  const unloads: (() => void)[] = []
  let panel!: PanelDefinition
  let renders = 0
  let hostCalls = 0
  const unexpectedHostCall = () => {
    hostCalls++
    throw new Error("Restoration must not start accounting, models or tools")
  }
  const api = {
    cwd: root,
    dataDir: path.join(root, "extension-data"),
    session: () => session,
    settings: {
      declare: () => ({
        get: () => ({ language: "en", reviewerModel: "", defaultProjectCapUsd: "999" }),
        onChange() {},
      }),
    },
    registerCommand() {},
    registerPanel(value: PanelDefinition) {
      panel = value
    },
    on(type: string, handler: (event: { sessionId: string }) => void | Promise<void>) {
      handlers.set(type, handler)
    },
    onUnload(handler: () => void) {
      unloads.push(handler)
    },
    requestRender() {
      renders++
    },
    notify() {},
    conversations: { create: unexpectedHostCall, read: unexpectedHostCall },
    complete: unexpectedHostCall,
    runTool: unexpectedHostCall,
    exec: unexpectedHostCall,
  } as unknown as ExtensionAPI
  cleanups.push(async () => {
    for (const unload of unloads) unload()
    await disposeAccounting(api)
    await rm(root, { recursive: true, force: true })
  })
  await createProjectExtension()(api)
  return {
    root,
    project,
    ledger,
    attach,
    start: (sessionId = id) => Promise.resolve(handlers.get("session.start")!({ sessionId })),
    unload: () => {
      for (const unload of unloads) unload()
    },
    changeSession: () => {
      id = "replacement-main"
    },
    renders: () => renders,
    hostCalls: () => hostCalls,
    render: () => panel.render({ sessionId: id, data, width: 120, now: 0, collapsed: false }),
  }
}

test("session restart restores saved panel cost, cap and stop without /cost or writes", async () => {
  const f = await restoredFixture()
  // A committed journal ahead of the projection must be displayed, not repaired by a panel read.
  await expect(
    new IterationStore(f.project, {
      afterPublish: () => {
        throw new Error("interrupted projection")
      },
    }).dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "restored-attempt" }),
  ).rejects.toThrow("interrupted projection")
  const before = await files(f.root)
  const save = spyOn(FileCostPersistence.prototype, "save")
  const read = spyOn(FileCostPersistence.prototype, "read")
  const writes = [
    spyOn(fs, "mkdir"),
    spyOn(fs, "open"),
    spyOn(fs, "rename"),
    spyOn(fs, "link"),
    spyOn(fs, "unlink"),
    spyOn(syncFs, "openSync"),
    spyOn(syncFs, "writeFileSync"),
    spyOn(syncFs, "renameSync"),
    spyOn(syncFs, "linkSync"),
    spyOn(syncFs, "unlinkSync"),
  ]
  try {
    await f.start()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    let lines = f.render()
    for (let attempt = 0; !lines[0] && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      lines = f.render()
    }
    expect(lines[0]?.text).toContain("Restored · iteration 1 · design")
    const cost = lines.find((line) => line.text.includes("Project cost:"))
    expect(cost?.text).toContain("$12.0000 reported")
    expect(cost?.text).toContain("Cap: $10.00 · STOPPED (cap)")
    expect(cost?.kind).toBe("warning")
    expect(lines[0]?.text).toContain("design · working")
    expect(f.hostCalls()).toBe(0)
    expect(save).not.toHaveBeenCalled()
    // Let the existing deferred stage refresh finish too; it must use a non-repairing reader.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await files(f.root)).toEqual(before)
    expect(read).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    save.mockRestore()
    for (const write of writes) write.mockRestore()
  }
})

for (const change of ["session", "attachment", "unload"] as const) {
  test(`delayed cost restoration does not publish after ${change} changes`, async () => {
    const f = await restoredFixture()
    await fs.mkdir(path.join(f.root, "other"))
    const other = await createProject(path.join(f.root, "other"), "Other")
    let entered = false
    let release!: (ledger: CostLedger) => void
    const saved = new Promise<CostLedger>((resolve) => {
      release = resolve
    })
    const read = spyOn(FileCostPersistence.prototype, "read").mockImplementationOnce(() => {
      entered = true
      return saved
    })
    try {
      const pending = f.start()
      for (let attempt = 0; !entered && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(entered).toBe(true)
      if (change === "session") f.changeSession()
      else if (change === "attachment") f.attach(other)
      else f.unload()
      const renders = f.renders()
      release(f.ledger)
      await pending
      expect(f.renders()).toBe(renders)
      expect(f.hostCalls()).toBe(0)
      if (change !== "unload") {
        expect(f.render().some((line) => line.text.includes("Project cost:"))).toBe(false)
        await f.start()
      }
    } finally {
      release(f.ledger)
      read.mockRestore()
    }
  })
}

test("a newer restore for the same session and attachment wins over a delayed ledger read", async () => {
  const f = await restoredFixture()
  let entered = false
  let release!: (ledger: CostLedger) => void
  const saved = new Promise<CostLedger>((resolve) => {
    release = resolve
  })
  const read = spyOn(FileCostPersistence.prototype, "read").mockImplementationOnce(() => {
    entered = true
    return saved
  })
  try {
    const pending = f.start()
    for (let attempt = 0; !entered && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entered).toBe(true)
    const newer = structuredClone(f.ledger)
    newer.revision++
    newer.policy.capUsd = 20
    delete newer.policy.latch
    await fs.writeFile(path.join(f.root, ".amira/project/costs.json"), JSON.stringify(newer))
    await f.start()
    const renders = f.renders()
    release(f.ledger)
    await pending
    expect(f.renders()).toBe(renders)
    const cost = f.render().find((line) => line.text.includes("Project cost:"))
    expect(cost?.text).toContain("Cap: $20.00")
    expect(cost?.text).not.toContain("STOPPED")
    expect(cost?.kind).toBe("muted")
    expect(f.hostCalls()).toBe(0)
  } finally {
    release(f.ledger)
    read.mockRestore()
  }
})

test("restoration with no saved ledger never initializes the configured default cap", async () => {
  const f = await restoredFixture()
  await unlink(path.join(f.root, ".amira/project/costs.json"))
  const before = await files(f.root)
  await f.start()
  expect(f.render()[0]?.text).toContain("Restored")
  expect(f.render().some((line) => line.text.includes("Project cost:"))).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await files(f.root)).toEqual(before)
  expect(f.hostCalls()).toBe(0)
})

test("owned-session start events do not clear the main restored cost panel", async () => {
  const f = await restoredFixture()
  await f.start()
  const renders = f.renders()
  await f.start("owned-session")
  expect(f.renders()).toBe(renders)
  expect(f.render().find((line) => line.text.includes("Project cost:"))?.text).toContain("STOPPED (cap)")
  expect(f.hostCalls()).toBe(0)
})
