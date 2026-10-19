import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI, OwnedConversationSnapshot } from "@amira/api"
import { disposeAccounting, projectAccounting } from "../src/accounting.ts"
import { costRollups, initialCostLedger } from "../src/cost.ts"
import { recoverOwnerInventory } from "../src/owner-inventory.ts"
import { createProject, IterationStore } from "../src/store.ts"
import { zeroUsage } from "./owned-fixture.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else result[path.relative(root, target)] = await readFile(target, "utf8")
    }
  }
  await walk(root)
  return result
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-owner-inventory-"))
  await mkdir(path.join(root, "project"))
  const project = await createProject(path.join(root, "project"), "Legacy")
  const dataDir = path.join(root, "extension-data")
  const records = new Map<string, OwnedConversationSnapshot>()
  let opens = 0
  const api = {
    dataDir,
    conversations: {
      read: async (ref: { key: string }) => structuredClone(records.get(ref.key)),
      openOrCreate: async () => {
        opens++
        throw new Error("Inventory must not acquire execution authority")
      },
    },
    notify() {},
    requestRender() {},
  } as unknown as ExtensionAPI
  cleanups.push(async () => {
    await disposeAccounting(api)
    await rm(root, { recursive: true, force: true })
  })
  async function identity(directory: string, value: { key: string; id: string; [name: string]: unknown }) {
    const parent = path.join(dataDir, directory)
    await mkdir(parent, { recursive: true })
    await writeFile(
      path.join(parent, `${createHash("sha256").update(value.key).digest("hex")}.json`),
      JSON.stringify({ root: project.root, ...value }),
    )
  }
  function host(key: string, id: string, cost: number) {
    const usage = zeroUsage(id)
    usage.revision = 1
    usage.own.knownCostUsd = usage.total.knownCostUsd = cost
    usage.own.usage.cost = usage.total.usage.cost = cost
    records.set(key, {
      key,
      id,
      name: "Removed model/runtime",
      cwd: path.join(root, "removed-worktree"),
      archived: true,
      history: [],
      usage,
    })
  }
  async function variants(ids = ["alpha"]) {
    const store = new IterationStore(project)
    const state = await store.read()
    const variants = []
    for (const id of ids) {
      const directory = await store.preparePrototypeDirectory(id)
      variants.push({
        id,
        idea: `Explore ${id}`,
        question: "Does the interaction work?",
        directory,
        cwd: directory,
        runCommand: null,
        prerequisites: [],
        notes: "",
        status: "planned" as const,
      })
    }
    return store.saveArtifact(state.revision, { kind: "prototype-manifest", variants })
  }
  return { root, project, dataDir, api, identity, variants, host, opens: () => opens }
}

test("startup inventories legacy design and both prototype policy identities without any runtime or writes during discovery", async () => {
  const f = await fixture()
  const design = `${f.project.marker.id}/design/1`
  const variant = `${f.project.marker.id}/iteration/1/prototype/alpha`
  const current = `${variant}/policy/scoped-v2`
  await f.variants()
  await f.identity("design-conversations", {
    key: design,
    id: "design",
    schemaVersion: 1,
    projectId: f.project.marker.id,
    iteration: 1,
  })
  await f.identity("prototype-conversations", {
    key: variant,
    sessionKey: current,
    id: "current",
    previous: { key: variant, id: "previous" },
  })
  f.host(design, "design", 2)
  f.host(current, "current", 3)
  f.host(variant, "previous", 4)
  const before = await snapshot(f.root)
  const recovered = await recoverOwnerInventory(f.api, f.project)
  expect(recovered.map((owner) => owner.id).sort()).toEqual(["current", "design", "previous"])
  expect(await snapshot(f.root)).toEqual(before)
  await unlink(path.join(f.project.root, ".amira/project/costs.json"))
  const account = await projectAccounting(f.api, f.project)
  expect(costRollups(account.costs.snapshot()).project).toMatchObject({ knownCostUsd: 9, complete: false })
  expect(account.costs.snapshot().coverage.legacyIncomplete).toBe(true)
  expect(f.opens()).toBe(0)
}, 60000)

test("a saved policy mapping cannot attribute another project's conversation", async () => {
  const f = await fixture()
  await f.variants()
  const key = `${f.project.marker.id}/iteration/1/prototype/alpha`
  await f.identity("prototype-conversations", {
    key,
    id: "foreign",
    sessionKey: "other-project/iteration/1/prototype/alpha",
  })
  const reads: unknown[] = []
  f.api.conversations!.read = async (ref) => {
    reads.push(ref)
    return undefined
  }
  await expect(recoverOwnerInventory(f.api, f.project)).rejects.toThrow("escapes")
  expect(reads).toEqual([])
  expect(f.opens()).toBe(0)
}, 60000)

test("unrelated malformed identities do not block selected-project recovery", async () => {
  const f = await fixture()
  await f.variants()
  const key = `${f.project.marker.id}/design/1`
  await f.identity("design-conversations", { key, id: "selected-design" })
  for (const directory of ["design-conversations", "prototype-conversations"]) {
    const parent = path.join(f.dataDir, directory)
    await mkdir(parent, { recursive: true })
    const unrelated = `another-project/${directory}/1`
    await writeFile(
      path.join(parent, `${createHash("sha256").update(unrelated).digest("hex")}.json`),
      "{malformed unrelated identity",
    )
  }
  const before = await snapshot(f.root)
  expect(await recoverOwnerInventory(f.api, f.project)).toEqual([
    { key, id: "selected-design", iteration: 1, stage: "design", role: "conversation" },
  ])
  expect(await snapshot(f.root)).toEqual(before)
  expect(f.opens()).toBe(0)
}, 60000)

test.each(["design-conversations", "prototype-conversations"])(
  "selected-project malformed JSON fails closed in %s",
  async (directory) => {
    const f = await fixture()
    await f.variants()
    const key =
      directory === "design-conversations"
        ? `${f.project.marker.id}/design/1`
        : `${f.project.marker.id}/iteration/1/prototype/alpha`
    await f.identity(directory, { key, id: "selected-owner" })
    const target = path.join(f.dataDir, directory, `${createHash("sha256").update(key).digest("hex")}.json`)
    await writeFile(target, "{malformed selected identity")
    const before = await snapshot(f.root)
    await expect(recoverOwnerInventory(f.api, f.project)).rejects.toThrow(SyntaxError)
    expect(await snapshot(f.root)).toEqual(before)
    expect(f.opens()).toBe(0)
  },
  60000,
)

test.each(["root", "key", "id"])(
  "a selected filename with an invalid %s fails closed",
  async (field) => {
    const f = await fixture()
    const key = `${f.project.marker.id}/design/1`
    await f.identity("design-conversations", { key, id: "selected-owner" })
    const target = path.join(
      f.dataDir,
      "design-conversations",
      `${createHash("sha256").update(key).digest("hex")}.json`,
    )
    await writeFile(target, JSON.stringify({ root: f.project.root, key, id: "selected-owner", [field]: "" }))
    const before = await snapshot(f.root)
    await expect(recoverOwnerInventory(f.api, f.project)).rejects.toThrow("Malformed saved")
    expect(await snapshot(f.root)).toEqual(before)
    expect(f.opens()).toBe(0)
  },
  60000,
)

test("historical manifests retain earlier variant candidates after replacement and output removal", async () => {
  const f = await fixture()
  await f.variants(["alpha"])
  await f.variants(["beta"])
  for (const variant of ["alpha", "beta"]) {
    await f.identity("prototype-conversations", {
      key: `${f.project.marker.id}/iteration/1/prototype/${variant}`,
      id: variant,
    })
  }
  await rm(path.join(f.project.root, ".amira/project/prototypes"), { recursive: true, force: true })
  const before = await snapshot(f.root)
  const owners = await recoverOwnerInventory(f.api, f.project)
  expect(owners.map((owner) => owner.id).sort()).toEqual(["alpha", "beta"])
  expect(await snapshot(f.root)).toEqual(before)
  expect(f.opens()).toBe(0)
}, 60000)

test("trusted ledger bindings recover both policy identities without a manifest", async () => {
  const f = await fixture()
  const key = `${f.project.marker.id}/iteration/1/prototype/alpha`
  const current = `${key}/policy/scoped-v2`
  await f.identity("prototype-conversations", {
    key,
    sessionKey: current,
    id: "current",
    previous: { key, id: "previous" },
  })
  const ledger = initialCostLedger(f.project.marker.id, "2026-10-19T00:00:00Z")
  ledger.owners.push({
    key: current,
    id: "current",
    iteration: 1,
    stage: "prototype",
    role: "variant",
    variant: "alpha",
    provenance: "owned",
    groups: [],
    sessions: [],
    runs: [],
  })
  ledger.owners.push({
    key: `${f.project.marker.id}/iteration/1/generation/proposal-generation/old`,
    id: "generation",
    iteration: 1,
    stage: "prototype",
    role: "proposal-generation",
    provenance: "owned",
    groups: [],
    sessions: [],
    runs: [],
  })
  const before = await snapshot(f.root)
  expect(await recoverOwnerInventory(f.api, f.project, ledger)).toEqual([
    { key: current, id: "current", iteration: 1, stage: "prototype", role: "variant", variant: "alpha" },
    { key, id: "previous", iteration: 1, stage: "prototype", role: "variant", variant: "alpha" },
  ])
  expect(await snapshot(f.root)).toEqual(before)
  await f.identity("prototype-conversations", { key, id: "wrong", previous: { key: "foreign", id: "old" } })
  await expect(recoverOwnerInventory(f.api, f.project, ledger)).rejects.toThrow("predecessor")
  ledger.projectId = "foreign"
  await expect(recoverOwnerInventory(f.api, f.project, ledger)).rejects.toThrow("another project")
  expect(f.opens()).toBe(0)
}, 60000)

test("unavailable old owner retains attribution and missing coverage instead of a certified zero", async () => {
  const f = await fixture()
  const design = `${f.project.marker.id}/design/1`
  await f.identity("design-conversations", {
    key: design,
    id: "lost",
    schemaVersion: 1,
    projectId: f.project.marker.id,
    iteration: 1,
  })
  const account = await projectAccounting(f.api, f.project)
  expect(account.costs.snapshot().owners[0]).toMatchObject({
    key: design,
    id: "lost",
    stage: "design",
    provenance: "recovered",
    unavailable: true,
  })
  expect(costRollups(account.costs.snapshot()).project.complete).toBe(false)
  await account.costs.configure("cap", 10)
  expect(() => account.costs.assertAdmission()).toThrow("unpriced")
  expect(f.opens()).toBe(0)
}, 60000)
