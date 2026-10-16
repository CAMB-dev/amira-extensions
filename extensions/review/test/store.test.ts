import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Report, ReportStore, repoKey } from "../src/store.ts"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-store-"))
  temps.push(dir)
  const root = path.join(dir, "repository")
  const key = repoKey(root)
  const store = new ReportStore(dir)
  const report: Report = {
    schemaVersion: 1,
    id: randomUUID(),
    repoKey: key,
    root,
    originSessionId: "main",
    ownerId: "owner",
    startedAt: "2026-10-16T10:00:00.000Z",
    endedAt: "2026-10-16T10:01:00.000Z",
    state: "completed",
    stale: false,
    scope: { kind: "worktree", paths: [], includeUntracked: false },
    base: "a".repeat(40),
    head: "b".repeat(40),
    fingerprint: "c".repeat(64),
    snapshotHashes: {},
    included: ["src/a.ts"],
    untracked: [],
    excluded: [],
    redacted: [],
    guidance: [],
    settings: {
      reviewerModel: "provider/model",
      verifierModel: "provider/model",
      verify: true,
      maxParallel: 2,
      maxTokens: 120000,
      maxCostUsd: 2,
    },
    promptHashes: { correctness: "d".repeat(64) },
    findings: [],
    limitations: [],
    usage: null,
    childStates: {},
  }
  return {
    dir,
    key,
    store,
    report,
    runs: path.join(dir, "repos", key, "runs"),
    pointer: path.join(dir, "repos", key, "last.json"),
  }
}

describe("ReportStore", () => {
  test("unsupported excluded path labels are inert display data, not reader paths", async () => {
    const { store, report } = await fixture()
    report.excluded = [{ path: "odd[tracked].ts", reason: "unsupported repository path" }]
    await store.save(report)
    expect((await store.last(report.repoKey))?.excluded).toEqual(report.excluded)
  })
  test("saves terminal reports and ignored findings without patch or snapshot content", async () => {
    const { store, report } = await fixture()
    report.findings.push({
      id: "F1",
      path: "src/a.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      severity: "P2",
      category: "correctness",
      summary: "Fails on empty input",
      scenario: "Empty input throws",
      evidence: [{ path: "src/a.ts", side: "new", line: 1, reason: "No guard" }],
      suggestedFix: "Guard empty input",
      sources: ["correctness"],
      assessment: "supported",
      ignored: true,
      excerpt: "const token = 'ghp_abcdefghijklmnopqrstuvwxyz'",
    })
    await store.save(report)
    const saved = await store.last(report.repoKey)
    expect(saved?.findings[0]?.ignored).toBe(true)
    expect(saved?.findings[0]?.excerpt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
    expect(await store.load(report.repoKey, report.id)).toEqual(saved)
  })

  test("updating an older ignored report preserves the latest terminal publication", async () => {
    const { dir, store, report, pointer } = await fixture()
    report.findings.push({
      id: "F1",
      path: "src/a.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      severity: "P2",
      category: "correctness",
      summary: "Fails on empty input",
      scenario: "Empty input throws",
      evidence: [],
      suggestedFix: "Guard empty input",
      sources: ["correctness"],
      assessment: "supported",
      ignored: false,
    })
    await store.save(report)
    const latest = { ...report, id: randomUUID() }
    await store.save(latest)
    const published = await readFile(pointer, "utf8")
    report.findings[0]!.ignored = true
    await store.update(report)
    expect((await store.last(report.repoKey))?.id).toBe(latest.id)
    expect(await readFile(pointer, "utf8")).toBe(published)
    const reopened = new ReportStore(dir)
    expect((await reopened.load(report.repoKey, report.id))?.findings[0]?.ignored).toBe(true)
    expect((await reopened.last(report.repoKey))?.findings[0]?.ignored).toBe(false)
    report.findings[0]!.ignored = false
    await store.update(report)
    expect((await reopened.load(report.repoKey, report.id))?.findings[0]?.ignored).toBe(false)
    expect(await readFile(pointer, "utf8")).toBe(published)
  })

  test("updates require an existing validated terminal report and cannot create storage", async () => {
    const { dir, store, report, runs, pointer } = await fixture()
    await expect(store.update(report)).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
    await store.save(report)
    const published = await readFile(pointer, "utf8")
    const names = await readdir(runs)
    await expect(store.update({ ...report, id: randomUUID() })).rejects.toThrow()
    await expect(store.update({ ...report, state: "running" })).rejects.toThrow()
    expect(await readdir(runs)).toEqual(names)
    const running = { ...report, id: randomUUID(), state: "running" as const }
    await store.save(running)
    const interrupted = await store.load(report.repoKey, running.id)
    expect(interrupted?.state).toBe("partial")
    await expect(store.update(interrupted!)).rejects.toThrow()
    expect(await store.interrupted(report.repoKey)).toHaveLength(1)
    expect(await readFile(pointer, "utf8")).toBe(published)
  })

  test("failed updates retain the latest pointer and saved report without poisoning the queue", async () => {
    const { store, report, runs, pointer } = await fixture()
    await store.save(report)
    const latest = { ...report, id: randomUUID() }
    await store.save(latest)
    const published = await readFile(pointer, "utf8")
    const file = path.join(runs, `${report.id}.json`)
    const original = await readFile(file, "utf8")
    const invalid = [
      { ...report, id: "../outside" },
      { ...report, repoKey: "../outside" },
      Object.assign({}, report, { schemaVersion: 2 }),
      Object.assign({}, report, { patch: "raw patch" }),
      { ...report, included: ["../secret"] },
      { ...report, limitations: ["x".repeat(1000000)] },
    ]
    for (const candidate of invalid) {
      await expect(store.update(candidate)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(original)
      expect(await readFile(pointer, "utf8")).toBe(published)
    }
    report.limitations = ["Token: ghp_abcdefghijklmnopqrstuvwxyz"]
    const updated = store.update(report)
    report.limitations.push("Changed after update was called")
    await updated
    const saved = await store.load(report.repoKey, report.id)
    expect(saved?.limitations).toHaveLength(1)
    expect(saved?.limitations[0]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
    expect((await store.last(report.repoKey))?.id).toBe(latest.id)
    expect(await readFile(pointer, "utf8")).toBe(published)
  })

  test("updates refuse corrupted, unowned and hard-linked existing report files", async () => {
    const { store, report, runs, pointer } = await fixture()
    await store.save(report)
    const latest = { ...report, id: randomUUID() }
    await store.save(latest)
    const published = await readFile(pointer, "utf8")
    const file = path.join(runs, `${report.id}.json`)
    const original = await readFile(file, "utf8")
    for (const content of [
      "{not json",
      JSON.stringify({ ...report, schemaVersion: 2 }),
      JSON.stringify({ ...report, repoKey: "0".repeat(64) }),
      JSON.stringify({ ...report, id: randomUUID() }),
      JSON.stringify({ ...report, included: ["../secret"] }),
      JSON.stringify({ ...report, patch: "raw patch" }),
    ]) {
      await writeFile(file, content)
      await expect(store.update(report)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(content)
      expect(await readFile(pointer, "utf8")).toBe(published)
    }
    await writeFile(file, original)
    const foreign = path.join(runs, "foreign-copy.txt")
    await link(file, foreign)
    await expect(store.update(report)).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(original)
    expect(await readFile(foreign, "utf8")).toBe(original)
    expect((await store.last(report.repoKey))?.id).toBe(latest.id)
    expect(await readFile(pointer, "utf8")).toBe(published)
  })

  test("updates neither prune retained reports nor recreate a missing latest pointer", async () => {
    const { store, report, runs, pointer } = await fixture()
    await store.save(report)
    // Simulate retained terminal files from another store without publishing or pruning them.
    for (let i = 0; i < 21; i++) {
      const retained = { ...report, id: randomUUID() }
      await writeFile(path.join(runs, `${retained.id}.json`), JSON.stringify(retained))
    }
    const names = (await readdir(runs)).sort()
    await rm(pointer)
    report.limitations.push("Updated retained report")
    await store.update(report)
    expect((await readdir(runs)).sort()).toEqual(names)
    expect((await store.load(report.repoKey, report.id))?.limitations).toEqual(["Updated retained report"])
    expect(await store.last(report.repoKey)).toBeUndefined()
    await expect(readFile(pointer, "utf8")).rejects.toThrow()
  })

  test("preserves partial reported usage without treating unavailable prices as zero", async () => {
    const { store, report } = await fixture()
    report.usage = { tokens: 10, reported: { input: 8, output: 2, costUsd: undefined } }
    await store.save(report)
    expect((await store.last(report.repoKey))?.usage).toEqual({
      tokens: 10,
      reported: { input: 8, output: 2 },
    })
  })

  test("running checkpoint preserves last and reopens as interrupted partial without replay", async () => {
    const { store, report } = await fixture()
    await store.save(report)
    const running = { ...report, id: randomUUID(), state: "running" as const, endedAt: undefined }
    await store.save(running)
    expect((await store.last(report.repoKey))?.id).toBe(report.id)
    expect((await store.load(report.repoKey, running.id))?.state).toBe("partial")
    const interrupted = await store.interrupted(report.repoKey)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.limitations.join(" ")).toContain("interrupted")
    expect(interrupted[0]?.limitations.join(" ")).toContain("not be replayed")
    expect(await store.interrupted(report.repoKey)).toEqual(interrupted)
  })

  test("report rename failure retains previous last and removes temporary files", async () => {
    const { store, report, runs } = await fixture()
    await store.save(report)
    const next = { ...report, id: randomUUID() }
    await mkdir(path.join(runs, `${next.id}.json`))
    await expect(store.save(next)).rejects.toThrow()
    expect((await store.last(report.repoKey))?.id).toBe(report.id)
    expect((await readdir(runs)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("pointer rename failure leaves the previous pointer contents recoverable", async () => {
    const { store, report, pointer } = await fixture()
    await store.save(report)
    const previous = `${pointer}.previous`
    await rename(pointer, previous)
    await mkdir(pointer)
    const next = { ...report, id: randomUUID() }
    await expect(store.save(next)).rejects.toThrow()
    expect(JSON.parse(await readFile(previous, "utf8")).id).toBe(report.id)
    await rm(pointer, { recursive: true })
    await rename(previous, pointer)
    expect((await store.last(report.repoKey))?.id).toBe(report.id)
    // A failed write does not poison the store's serialization queue.
    await store.save(next)
    expect((await store.last(report.repoKey))?.id).toBe(next.id)
  })

  test("refuses injection, corrupted data, unknown schema and unowned pointer targets", async () => {
    const { store, report, runs, pointer } = await fixture()
    await store.save(report)
    expect(await store.load("../outside", report.id)).toBeUndefined()
    expect(await store.load(report.repoKey, "../../outside")).toBeUndefined()
    await expect(store.save({ ...report, id: "../outside" })).rejects.toThrow("Invalid")
    await expect(store.save({ ...report, repoKey: "../outside" })).rejects.toThrow("Invalid")
    const file = path.join(runs, `${report.id}.json`)
    await writeFile(file, "{not json")
    expect(await store.last(report.repoKey)).toBeUndefined()
    await writeFile(file, JSON.stringify({ ...report, schemaVersion: 2 }))
    expect(await store.load(report.repoKey, report.id)).toBeUndefined()
    await writeFile(file, JSON.stringify({ ...report, repoKey: "0".repeat(64) }))
    expect(await store.load(report.repoKey, report.id)).toBeUndefined()
    await writeFile(pointer, JSON.stringify({ schemaVersion: 1, id: "../elsewhere" }))
    expect(await store.last(report.repoKey)).toBeUndefined()
  })

  test("retention prunes only validated generated terminal report files", async () => {
    const { store, report, runs } = await fixture()
    await store.save(report)
    const unrelated = ["notes.json", `${randomUUID()}.json`, "foreign.txt"]
    for (const name of unrelated) await writeFile(path.join(runs, name), "foreign data")
    const running = { ...report, id: randomUUID(), state: "running" as const }
    await store.save(running)
    for (let i = 0; i < 23; i++)
      await store.save({
        ...report,
        id: randomUUID(),
        endedAt: new Date(Date.UTC(2026, 9, 16, 11, i)).toISOString(),
      })
    const names = await readdir(runs)
    for (const name of unrelated) expect(names).toContain(name)
    expect(names).toContain(`${running.id}.json`)
    expect(names).toHaveLength(24) // Twenty terminal, one running, three foreign files.
    expect(await store.load(report.repoKey, report.id)).toBeUndefined()
  })

  test("bounded schema refuses raw patch properties, oversized data and malformed findings", async () => {
    const { store, report } = await fixture()
    await expect(store.save(Object.assign({}, report, { patch: "raw patch" }))).rejects.toThrow("Invalid")
    await expect(store.save({ ...report, limitations: ["x".repeat(1000000)] })).rejects.toThrow()
    await expect(
      store.save({ ...report, settings: { ...report.settings, maxTokens: Infinity } }),
    ).rejects.toThrow()
    await expect(store.save({ ...report, included: ["../secret"] })).rejects.toThrow()
    expect(await store.last(report.repoKey)).toBeUndefined()
  })

  test("refuses hard-linked report files without altering their other link", async () => {
    const { store, report, runs } = await fixture()
    await store.save(report)
    const file = path.join(runs, `${report.id}.json`)
    const foreign = path.join(runs, "foreign-copy.txt")
    const original = await readFile(file, "utf8")
    await link(file, foreign)
    expect(await store.load(report.repoKey, report.id)).toBeUndefined()
    await store.save(report)
    expect(await readFile(foreign, "utf8")).toBe(original)
  })

  test("does not create repository directories through a storage junction", async () => {
    const { dir, store, report } = await fixture()
    const target = path.join(dir, "foreign-directory")
    await mkdir(target)
    await symlink(target, path.join(dir, "repos"), "junction")
    await expect(store.save(report)).rejects.toThrow("Unsafe review storage")
    expect(await readdir(target)).toEqual([])
  })

  test("captures checkpoint values when save is called, not when its queue executes", async () => {
    const { store, report } = await fixture()
    const first = store.save(report)
    report.limitations.push("Changed after save was called")
    await first
    expect((await store.last(report.repoKey))?.limitations).toEqual([])
  })

  test("normalizes Windows case, slash spelling and trailing separator but preserves worktrees", () => {
    expect(repoKey("D:\\DEV\\Project\\")).toBe(repoKey("d:/dev/project"))
    expect(repoKey("D:/dev/project")).not.toBe(repoKey("D:/dev/other-worktree"))
  })
})
