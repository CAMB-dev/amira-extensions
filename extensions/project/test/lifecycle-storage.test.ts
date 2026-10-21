import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as syncFs from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LifecycleStoreOptions, Project } from "../src/store.ts"
import {
  appendSuggestion,
  assertProjectWritable,
  assertProjectWritableNow,
  createProject,
  DecisionStore,
  HistoricalIterationReader,
  IterationStore,
  LifecycleStore,
  ProjectDocumentStore,
  projectLifecycle,
  readDocument,
  readProject,
  saveResearchNote,
  withProjectClaim,
  writeDocument,
} from "../src/store.ts"
import { commandHarness, consume, startReview, summarize } from "./batch-test-helper.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"
import { legacyJournal } from "./legacy-batch-helper.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "amira-lifecycle-"))
  roots.push(root)
  return createProject(root, "Lifecycle")
}
const receipt = { id: "human-1", sessionId: "main", date: "2026-10-19T00:00:00Z" }
const summary = {
  kind: "stage-summary" as const,
  stage: "design" as const,
  language: "en",
  summary: "Design ready",
  outputs: [],
  suggestion: "Review",
}
const question = {
  question: "Which?",
  header: "Choice",
  options: [
    { label: "A", description: "First" },
    { label: "B", description: "Second" },
  ],
}
const machine = (project: Project, ...parts: string[]) =>
  path.join(project.root, ".amira", "project", ...parts)
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(file)))
        result[`${entry.name}/${name}`] = content
    } else result[entry.name] = (await fs.readFile(file)).toString("base64")
  }
  return result
}
async function closedProject(project: Project) {
  const store = new LifecycleStore(project)
  await store.transition(0, { type: "ship", status: "skipped", receipt })
  return store.transition(1, { type: "close", receipt })
}

test("lifecycle defaults to open/unshipped and upgrades only the marker, never old evidence", async () => {
  const project = await fixture()
  const state = await new IterationStore(project).read()
  const before = await snapshot(machine(project, "iterations"))
  expect(projectLifecycle(project).iterations["1"]).toEqual({ status: "open", ship: "not-started" })
  expect((await readProject(project.root)).marker.schemaVersion).toBe(1)
  const changed = await new LifecycleStore(project).transition(0, {
    type: "ship",
    status: "pending",
    receipt,
  })
  expect(changed.marker.schemaVersion).toBe(2)
  expect(await new HistoricalIterationReader(changed, 1).read()).toEqual(state)
  expect(await snapshot(machine(project, "iterations"))).toEqual(before)
  await expect(new LifecycleStore(changed).transition(1, { type: "close", receipt })).rejects.toThrow(
    /shipped/i,
  )
})

test("legacy acceptance complete never implies shipped or closed", async () => {
  const f = await bindingFixture(roots)
  const review = await startReview(f.store, f.state, f.verdict)
  review.verdict.items = f.verdict.items
  await summarize(f.store, await consume(f.store, review.state, review.verdict))
  const complete = await commandHarness(f.project).run()
  expect(complete).toMatchObject({ stage: "accept", phase: "complete", completion: "accepted" })
  await legacyJournal(f.project)
  const before = await snapshot(machine(f.project, "iterations"))
  const store = new LifecycleStore(f.project)
  expect((await store.read()).iterations["1"]).toEqual({ status: "open", ship: "not-started" })
  await expect(store.transition(0, { type: "close", receipt })).rejects.toThrow(/shipped/i)
  expect((await new HistoricalIterationReader(f.project, 1).read()).phase).toBe("complete")
  expect(await snapshot(machine(f.project, "iterations"))).toEqual(before)
}, 60000)

test("next iteration requires explicit closure and leaves historical state/artifacts readable", async () => {
  const project = await fixture()
  const saved = await new IterationStore(project).saveArtifact(0, summary)
  const before = await snapshot(machine(project, "iterations", "1"))
  await expect(
    new LifecycleStore(project).transition(0, { type: "next-iteration", receipt }),
  ).rejects.toThrow(/close/i)
  const closed = await closedProject(project)
  await expect(new IterationStore(closed).read()).rejects.toThrow(/read-only/i)
  const next = await new LifecycleStore(closed).transition(2, { type: "next-iteration", receipt })
  expect(next.marker.currentIteration).toBe(2)
  const fresh = await new HistoricalIterationReader(next, 2).read()
  expect(fresh).toMatchObject({
    iteration: 2,
    stage: "design",
    phase: "ready",
    revision: 0,
    attempts: [],
    artifacts: [],
  })
  const reader = new HistoricalIterationReader(next, 1)
  expect(await reader.read()).toEqual(saved.state)
  expect(await reader.readArtifact(saved.artifact)).toEqual(summary)
  expect(await snapshot(machine(project, "iterations", "1"))).toEqual(before)
  await expect(
    new IterationStore(project).dispatch(1, { type: "start-work", expectedRevision: 1, attemptId: "late" }),
  ).rejects.toThrow()
})

for (const boundary of ["afterIntent", "afterIterationPublish", "afterMarkerPublish"] as const) {
  test(`next iteration recovers local publication after crash at ${boundary}`, async () => {
    const project = await fixture()
    await new IterationStore(project).read()
    const closed = await closedProject(project)
    const old = await snapshot(machine(project, "iterations", "1"))
    const hooks: LifecycleStoreOptions = {
      [boundary]: () => {
        throw new Error("crash")
      },
    }
    await expect(
      new LifecycleStore(closed, hooks).transition(2, { type: "next-iteration", receipt }),
    ).rejects.toThrow("crash")
    const interrupted = await readProject(project.root)
    expect(interrupted.marker.currentIteration).toBe(boundary === "afterMarkerPublish" ? 2 : 1)
    const beforeRead = await snapshot(project.root)
    expect((await new HistoricalIterationReader(interrupted, 1).read()).iteration).toBe(1)
    await new LifecycleStore(interrupted).read()
    expect(await snapshot(project.root)).toEqual(beforeRead)
    const recovered = await new LifecycleStore(interrupted).recover()
    expect(recovered.marker.currentIteration).toBe(2)
    expect(await new LifecycleStore(recovered).recover()).toEqual(recovered)
    expect(await snapshot(machine(project, "iterations", "1"))).toEqual(old)
    const fresh = await new IterationStore(recovered).read()
    expect(fresh).toMatchObject({ iteration: 2, revision: 0, attempts: [], artifacts: [] })
    expect((await fs.readdir(machine(project))).filter((name) => name.endsWith(".lock"))).toEqual([])
  }, 15000)
}

test("archive inspection writes nothing; storage rejects every retained ordinary writer/dialog", async () => {
  const project = await fixture()
  const store = new IterationStore(project)
  const saved = await store.saveArtifact(0, summary)
  const decisions = new DecisionStore(project)
  const lifecycle = new LifecycleStore(project)
  const pending = await lifecycle.transition(0, { type: "archive-pending", receipt })
  const archived = await lifecycle.transition(1, { type: "archived", receipt })
  const before = await snapshot(project.root)
  const reader = new HistoricalIterationReader(archived, 1)
  expect(await reader.read()).toEqual(saved.state)
  expect(await reader.readArtifact(saved.artifact)).toEqual(summary)
  expect(await readDocument(archived, "design.md")).toBe("")
  expect(await new DecisionStore(archived).records()).toEqual([])
  expect(await new ProjectDocumentStore(archived).read("fixture-accounting.json")).toBeUndefined()
  await expect(assertProjectWritable(project)).rejects.toThrow(/read-only/i)
  expect(() => assertProjectWritableNow(project)).toThrow(/read-only/i)
  await expect(assertProjectWritable(pending)).rejects.toThrow(/read-only/i)
  await expect(store.read()).rejects.toThrow(/read-only/i)
  await expect(store.saveArtifact(1, summary)).rejects.toThrow(/read-only/i)
  await expect(store.preparePrototypeDirectory("A")).rejects.toThrow(/read-only/i)
  await expect(
    store.dispatch(1, { type: "start-work", expectedRevision: 1, attemptId: "late" }),
  ).rejects.toThrow(/read-only/i)
  await expect(writeDocument(project, "design.md", "late")).rejects.toThrow(/read-only/i)
  await expect(appendSuggestion(project, "late", "en")).rejects.toThrow(/read-only/i)
  await expect(saveResearchNote(project, "late", "late")).rejects.toThrow(/read-only/i)
  await expect(
    decisions.record([question], [{ selected: ["A"] }], { sessionId: "main", askId: "late", language: "en" }),
  ).rejects.toThrow(/read-only/i)
  await expect(decisions.recover()).rejects.toThrow(/read-only/i)
  expect(await snapshot(project.root)).toEqual(before)
  const restored = await lifecycle.transition(2, { type: "restore", receipt })
  await expect(writeDocument(project, "design.md", "stale after restore")).rejects.toThrow(/stale/i)
  expect(() => assertProjectWritableNow(project)).toThrow(/stale/i)
  await expect(lifecycle.transition(1, { type: "archive-pending", receipt })).rejects.toThrow(/stale/i)
  await expect(new IterationStore(restored).read()).rejects.toThrow(/continuation/i)
  const continued = await new LifecycleStore(restored).transition(3, { type: "continue", receipt })
  expect((await new IterationStore(continued).read()).attempts).toEqual([])
  expect((await writeDocument(continued, "design.md", "explicit fresh publication")).conflict).toBe(false)
}, 20000)

test("an interrupted lifecycle intent fences ordinary mutation until explicit recovery", async () => {
  const project = await fixture()
  await new IterationStore(project).read()
  await expect(
    new LifecycleStore(project, {
      afterIntent: () => {
        throw new Error("crash")
      },
    }).transition(0, { type: "archive-pending", receipt }),
  ).rejects.toThrow("crash")
  await expect(writeDocument(project, "design.md", "late")).rejects.toThrow(/recovery/i)
  expect((await new LifecycleStore(project).read()).status).toBe("active")
  const recovered = await new LifecycleStore(project).recover()
  expect(projectLifecycle(recovered).status).toBe("archive-pending")
  await expect(writeDocument(recovered, "design.md", "late")).rejects.toThrow(/read-only/i)
})

test("historical reads leave interrupted projections and absent iterations untouched", async () => {
  const project = await fixture()
  await new IterationStore(project).read()
  await expect(
    new IterationStore(project, {
      afterPublish: () => {
        throw new Error("crash")
      },
    }).dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "stopped-at-publication" }),
  ).rejects.toThrow("crash")
  const before = await snapshot(project.root)
  expect((await new HistoricalIterationReader(project, 1).read()).revision).toBe(1)
  await expect(new HistoricalIterationReader(project, 9).read()).rejects.toThrow(/no committed journal/i)
  expect(await snapshot(project.root)).toEqual(before)
  expect(
    JSON.parse(await fs.readFile(machine(project, "iterations", "1", "state.json"), "utf8")).revision,
  ).toBe(0)
})

test("unsupported marker/journal schemas are preserved, including typed schema diagnostics", async () => {
  const project = await fixture()
  await new IterationStore(project).read()
  const journal = machine(project, "iterations", "1", ".state", "0000000000000000.json")
  const record = JSON.parse(await fs.readFile(journal, "utf8"))
  record.schemaVersion = 72
  await fs.writeFile(journal, JSON.stringify(record))
  const before = await snapshot(project.root)
  await expect(new HistoricalIterationReader(project, 1).read()).rejects.toMatchObject({
    details: { reason: "unsupported-schema", document: "iteration journal", encountered: 72, supported: 1 },
  })
  expect(await snapshot(project.root)).toEqual(before)
  const marker = path.join(project.root, ".amira", "project.json")
  const bytes = JSON.stringify({ ...project.marker, schemaVersion: 72 })
  await fs.writeFile(marker, bytes)
  await expect(readProject(project.root)).rejects.toMatchObject({
    details: { reason: "unsupported-schema", document: "project marker", encountered: 72, supported: 2 },
  })
  expect(await fs.readFile(marker, "utf8")).toBe(bytes)
})

test("recovery refuses conflicting new iteration evidence and changed marker bytes", async () => {
  const project = await fixture()
  await new IterationStore(project).read()
  const closed = await closedProject(project)
  await expect(
    new LifecycleStore(closed, {
      afterIterationPublish: () => {
        throw new Error("crash")
      },
    }).transition(2, { type: "next-iteration", receipt }),
  ).rejects.toThrow("crash")
  const file = machine(project, "iterations", "2", "state.json")
  await fs.writeFile(file, "human evidence\n")
  await expect(new LifecycleStore(closed).recover()).rejects.toThrow(/different evidence/i)
  expect(await fs.readFile(file, "utf8")).toBe("human evidence\n")
  const markerFile = path.join(project.root, ".amira", "project.json")
  const changed = JSON.stringify({ ...closed.marker, name: "Externally changed" })
  await fs.writeFile(markerFile, changed)
  await expect(new LifecycleStore(closed).recover()).rejects.toThrow(/marker changed/i)
  expect(await fs.readFile(markerFile, "utf8")).toBe(changed)
  expect((await readProject(project.root)).marker.currentIteration).toBe(1)
})

test("project machine documents serialize updates, preserve malformed bytes and permit settled accounting", async () => {
  const project = await fixture()
  const documents = new ProjectDocumentStore(project)
  await Promise.all(
    Array.from({ length: 4 }, () =>
      documents.update("fixture-accounting.json", (previous) => ({
        count: (previous === undefined ? 0 : (previous as { count: number }).count) + 1,
      })),
    ),
  )
  expect(await documents.read("fixture-accounting.json")).toEqual({ count: 4 })
  const archived = await new LifecycleStore(project).transition(0, { type: "archive-pending", receipt })
  await expect(documents.update("fixture-accounting.json", () => ({ count: 5 }))).rejects.toThrow(
    /read-only/i,
  )
  await documents.update("fixture-accounting.json", () => ({ count: 5 }), { administrative: true })
  expect(projectLifecycle(await readProject(project.root)).status).toBe("archive-pending")
  expect(await new ProjectDocumentStore(archived).read("fixture-accounting.json")).toEqual({ count: 5 })
  await expect(documents.read("../project.json")).rejects.toThrow(/name/i)
  await fs.writeFile(machine(project, "fixture-accounting.json"), "{malformed")
  await expect(
    documents.update("fixture-accounting.json", () => ({}), { administrative: true }),
  ).rejects.toThrow(/malformed/i)
  expect(await fs.readFile(machine(project, "fixture-accounting.json"), "utf8")).toBe("{malformed")
})

test("live project claim is never stolen and release is independent of iteration advancement", async () => {
  const project = await fixture()
  const file = machine(project, ".project-writer.lock")
  await fs.writeFile(
    file,
    JSON.stringify({ pid: process.pid, token: "00000000-0000-0000-0000-000000000000" }),
  )
  await expect(withProjectClaim(project, async () => undefined)).rejects.toThrow(/live writer/i)
  expect(await fs.readFile(file, "utf8")).toContain(String(process.pid))
  await fs.unlink(file)
  const closed = await closedProject(project)
  await withProjectClaim(
    closed,
    async () => {
      const next = await new LifecycleStore(closed).transition(2, { type: "next-iteration", receipt })
      expect(next.marker.currentIteration).toBe(2)
    },
    { administrative: true },
  )
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" })
})

test("historical artifact hash validation remains strict and never repairs edited bytes", async () => {
  const project = await fixture()
  const saved = await new IterationStore(project).saveArtifact(0, summary)
  const file = path.join(project.root, saved.artifact.path)
  const bytes = await fs.readFile(file, "utf8")
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(saved.artifact.hash)
  await fs.writeFile(file, `${bytes} `)
  const before = await snapshot(project.root)
  await expect(new HistoricalIterationReader(project, 1).readArtifact(saved.artifact)).rejects.toThrow(
    /edited/i,
  )
  expect(await snapshot(project.root)).toEqual(before)
})

test("historical state/artifact inspection invokes no filesystem mutation primitives", async () => {
  const project = await fixture()
  const saved = await new IterationStore(project).saveArtifact(0, summary)
  const archived = await new LifecycleStore(project).transition(0, { type: "archive-pending", receipt })
  const mutations = [
    spyOn(fs, "open"),
    spyOn(fs, "mkdir"),
    spyOn(fs, "link"),
    spyOn(fs, "rename"),
    spyOn(fs, "unlink"),
    spyOn(fs, "writeFile"),
    spyOn(syncFs, "openSync"),
    spyOn(syncFs, "linkSync"),
    spyOn(syncFs, "renameSync"),
    spyOn(syncFs, "unlinkSync"),
    spyOn(syncFs, "writeFileSync"),
  ]
  try {
    const reader = new HistoricalIterationReader(archived, 1)
    expect(await reader.read()).toEqual(saved.state)
    expect(await reader.readArtifact(saved.artifact)).toEqual(summary)
    await new LifecycleStore(archived).read()
    await readDocument(archived, "design.md")
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
  } finally {
    for (const mutation of mutations) mutation.mockRestore()
  }
})

for (const name of ["0000000000000000.json", "state.json", "0000000000000000.projected"]) {
  test(`next iteration recovers partial initialization after publishing ${name}`, async () => {
    const project = await fixture()
    await new IterationStore(project).read()
    const closed = await closedProject(project)
    const store = new LifecycleStore(closed, {
      afterIterationFilePublish: (published) => {
        if (published === name) throw new Error("partial initialization crash")
      },
    })
    await expect(store.transition(2, { type: "next-iteration", receipt })).rejects.toThrow(
      "partial initialization crash",
    )
    expect((await readProject(project.root)).marker.currentIteration).toBe(1)
    await expect(new HistoricalIterationReader(closed, 2).read()).rejects.toThrow(/published/i)
    const orphan = machine(
      project,
      "iterations",
      "2",
      ".state",
      ".lifecycle-init-00000000-0000-0000-0000-000000000000.tmp",
    )
    await fs.writeFile(orphan, "interrupted temporary bytes")
    const recovered = await new LifecycleStore(closed).recover()
    expect(recovered.marker.currentIteration).toBe(2)
    expect((await new IterationStore(recovered).read()).attempts).toEqual([])
    expect(await fs.readFile(orphan, "utf8")).toBe("interrupted temporary bytes")
  }, 15000)
}

test("marker-only legacy projects initialize only through a writable storage operation", async () => {
  const original = await fixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "amira-lifecycle-marker-only-"))
  roots.push(root)
  await fs.mkdir(path.join(root, ".amira"))
  await fs.writeFile(path.join(root, ".amira", "project.json"), JSON.stringify(original.marker))
  const project = await readProject(root)
  const before = await snapshot(root)
  await expect(new HistoricalIterationReader(project, 1).read()).rejects.toThrow(/no committed journal/i)
  expect(await snapshot(root)).toEqual(before)
  expect((await new IterationStore(project).read()).revision).toBe(0)
})

test("parallel document updates inside a held project claim do not lose updates", async () => {
  const project = await fixture()
  const documents = new ProjectDocumentStore(project)
  await documents.update("counter.json", () => ({ count: 0 }))
  await withProjectClaim(project, async () => {
    await Promise.all(
      Array.from({ length: 2 }, () =>
        documents.update("counter.json", async (previous) => {
          await Promise.resolve()
          return { count: (previous as { count: number }).count + 1 }
        }),
      ),
    )
  })
  expect(await documents.read("counter.json")).toEqual({ count: 2 })
  await expect(
    documents.update("counter.json", async () => documents.update("counter.json", () => ({ count: 9 }))),
  ).rejects.toThrow(/nested updates/i)
  expect(await documents.read("counter.json")).toEqual({ count: 2 })
})
