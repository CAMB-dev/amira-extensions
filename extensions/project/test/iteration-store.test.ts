import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ArtifactRef } from "../src/stage.ts"
import {
  type AcceptanceArtifact,
  createProject,
  DecisionStore,
  IterationStore,
  ProjectStorageError,
  readProject,
  type SpecArtifact,
  type StageSummaryArtifact,
} from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "amira-iteration-store-"))
  roots.push(root)
  return root
}
async function fixture(iteration = 1) {
  const project = await createProject(await temp(), "Iteration")
  if (iteration !== 1) {
    project.marker.currentIteration = iteration
    await fs.writeFile(path.join(project.root, ".amira", "project.json"), JSON.stringify(project.marker))
  }
  await new DecisionStore(project).record(
    [
      {
        question: "Which feature?",
        header: "Feature",
        options: [
          { label: "Approved", description: "Fixture requirement" },
          { label: "Other", description: "Alternative" },
        ],
      },
    ],
    [{ selected: ["Approved"] }],
    { sessionId: "fixture", askId: "D1-fixture", language: "en" },
  )
  const store = new IterationStore(project)
  return {
    project,
    store,
    directory: path.join(project.root, ".amira", "project", "iterations", String(iteration)),
  }
}
const summary: StageSummaryArtifact = {
  kind: "stage-summary",
  stage: "design",
  language: "en",
  summary: "Design ready",
  outputs: [],
  suggestion: "Consider a prototype",
}
const spec: SpecArtifact = {
  kind: "spec",
  revision: 1,
  language: "en",
  summary: "One feature",
  body: "Implement the approved feature.",
  decisionIds: ["D1"],
  items: [
    {
      id: "S1",
      description: "Feature works",
      constraints: [],
      verification: ["Run checks"],
      acceptanceCriteria: ["Check succeeds"],
      decisionIds: ["D1"],
      checkIds: ["C1"],
      ui: true,
    },
  ],
  checks: [{ id: "C1", command: "bun test" }],
}
async function boundFixture() {
  const f = await fixture()
  const savedSpec = await f.store.saveArtifact(0, spec)
  const plan = await f.store.saveArtifact(1, {
    kind: "batch-plan",
    specHash: savedSpec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: ["D1"], files: ["src/feature.ts"] }],
  })
  const context = {
    spec: { artifactId: savedSpec.artifact.id, revision: 1, hash: savedSpec.artifact.hash },
    batchPlan: { artifactId: plan.artifact.id, hash: plan.artifact.hash },
    batchId: "B1",
    mode: "single" as const,
    model: "coder",
    changes: ["diff:existing"],
  }
  const savedSummary = await f.store.saveArtifact(plan.state.revision, summary)
  let state = await f.store.dispatch(savedSummary.state.revision, {
    type: "prepare-summary",
    expectedRevision: savedSummary.state.revision,
    artifact: savedSummary.artifact,
  })
  state = await f.store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "accept-existing",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review existing code",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "accept-existing", "accept"),
  })
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "review-1",
    review: { attempt: 1, codeHash: "a".repeat(64) },
  })
  return { ...f, specRef: savedSpec.artifact, planRef: plan.artifact, revision: state.revision }
}
function acceptance(ref: ArtifactRef, plan: ArtifactRef, cwd: string): AcceptanceArtifact {
  return {
    kind: "acceptance",
    specHash: ref.hash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: { artifactId: plan.id, hash: plan.hash },
    attemptId: "review-1",
    attempt: 1,
    codeHash: "a".repeat(64),
    reviewerModel: "reviewer",
    implementerModels: ["coder"],
    sameModelFallback: false,
    outcome: "pass",
    items: [{ itemId: "S1", status: "pass", evidence: ["check C1"], reason: "Observed expected output" }],
    checks: [
      {
        checkId: "C1",
        cwd,
        command: "bun test",
        startedAt: "2026-10-15T00:00:00Z",
        finishedAt: "2026-10-15T00:00:01Z",
        status: "passed",
        exitCode: 0,
        output: "1 pass",
      },
    ],
  }
}

const worker = fileURLToPath(new URL("./iteration-store-worker.ts", import.meta.url))
async function runWorker(root: string, mode: string) {
  const child = Bun.spawn([process.execPath, worker, root, mode, ""], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("legacy project migrates to durable design idle without touching old evidence/documents", async () => {
  const { project, store, directory } = await fixture()
  const evidence = path.join(project.root, ".amira", "project", "decisions.evidence.jsonl")
  await fs.writeFile(evidence, "legacy evidence bytes\n")
  const state = await store.read()
  expect(state).toMatchObject({ revision: 0, stage: "design", status: "idle", artifacts: [] })
  expect(JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"))).toEqual(state)
  expect(await fs.readFile(evidence, "utf8")).toBe("legacy evidence bytes\n")
  expect(await new IterationStore(project).read()).toEqual(state)
  const child = await runWorker(project.root, "read")
  expect(child.code).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual(state)
})

test("generated immutable artifacts round-trip and independently advance OCC revision", async () => {
  const { project, store } = await fixture()
  const saved = await store.saveArtifact(0, summary)
  expect(saved.state.revision).toBe(1)
  expect(saved.artifact.path).toMatch(
    /^\.amira\/project\/iterations\/1\/artifacts\/stage-summary-[a-f0-9-]+\.json$/,
  )
  expect(await store.readArtifact(saved.artifact)).toEqual(summary)
  await expect(new IterationStore(project).saveArtifact(0, summary)).rejects.toThrow("Stale iteration writer")
  await expect(store.readArtifact({ ...saved.artifact, path: "../outside" })).rejects.toThrow(
    ProjectStorageError,
  )
  await expect(
    store.saveArtifact(1, { ...summary, path: "../outside" } as StageSummaryArtifact),
  ).rejects.toThrow("unexpected field")
  expect((await store.read()).artifacts).toEqual([saved.artifact])
})

test("design work can publish its initial plan without replacing an authorized plan", async () => {
  const { store } = await fixture()
  const savedSpec = await store.saveArtifact(0, spec)
  const state = await store.dispatch(savedSpec.state.revision, {
    type: "start-work",
    expectedRevision: savedSpec.state.revision,
    attemptId: "design-plan",
  })
  const saved = await store.saveArtifact(state.revision, {
    kind: "batch-plan",
    specHash: savedSpec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: ["D1"], files: [] }],
  })
  expect(saved.state.status).toBe("working")
  expect(saved.state.activeAttemptId).toBe("design-plan")
}, 60000)

test("persisted artifacts can be consumed by stage events without duplicate registration", async () => {
  const { store } = await fixture()
  const saved = await store.saveArtifact(0, summary)
  const state = await store.dispatch(1, {
    type: "prepare-summary",
    expectedRevision: 1,
    artifact: saved.artifact,
  })
  expect(state.revision).toBe(2)
  expect(state.summaryId).toBe(saved.artifact.id)
  expect(state.artifacts).toEqual([saved.artifact])
})

test("two captured stores reject stale writes and persisted stage work is inert on restart", async () => {
  const { project, store } = await fixture()
  await store.read()
  const second = new IterationStore(project)
  const results = await Promise.allSettled([
    store.dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "first" }),
    second.dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "second" }),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  const state = await new IterationStore(project).read()
  expect(state.revision).toBe(1)
  expect(state.attempts).toHaveLength(1)
  expect(await new IterationStore(project).read()).toEqual(state)
})

for (const mode of ["before", "after"] as const) {
  test(`dead-process claim recovers after crash ${mode} state publication`, async () => {
    const { project, store, directory } = await fixture()
    await store.read()
    const child = await runWorker(project.root, mode)
    expect(child.code).toBe(71)
    expect(await fs.readFile(path.join(directory, ".writer.lock"), "utf8")).toContain("pid")
    const restarted = await runWorker(project.root, "read")
    expect(restarted.code).toBe(0)
    expect(restarted.stderr).toBe("")
    const state = JSON.parse(restarted.stdout)
    expect(state.revision).toBe(mode === "before" ? 0 : 1)
    expect(state.attempts).toHaveLength(mode === "before" ? 0 : 1)
    expect(await store.read()).toEqual(state)
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".lock"))).toEqual([])
  })
}

test("a live cross-process writer claim is never stolen", async () => {
  const { project, store, directory } = await fixture()
  await store.read()
  const ready = path.join(project.root, "writer-ready")
  const child = Bun.spawn([process.execPath, worker, project.root, "hold", ready], {
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const deadline = Date.now() + 10000
    while (
      await fs.access(ready).then(
        () => false,
        () => true,
      )
    ) {
      if (Date.now() > deadline) throw new Error("Writer did not reach the barrier")
      await Bun.sleep(10)
    }
    const claimed = await fs.readFile(path.join(directory, ".writer.lock"), "utf8")
    await expect(store.read()).rejects.toThrow("live writer")
    expect(await fs.readFile(path.join(directory, ".writer.lock"), "utf8")).toBe(claimed)
  } finally {
    child.kill()
    await child.exited
  }
  expect((await store.read()).revision).toBe(0)
})

test("a crash after artifact publication leaves only an unreferenced immutable orphan", async () => {
  const { project, store, directory } = await fixture()
  await store.read()
  const crashing = new IterationStore(project, {
    afterArtifactPublish: () => {
      throw new Error("crash")
    },
  })
  await expect(crashing.saveArtifact(0, summary)).rejects.toThrow("crash")
  expect((await store.read()).artifacts).toEqual([])
  expect(await fs.readdir(path.join(directory, "artifacts"))).toHaveLength(1)
  expect((await store.saveArtifact(0, summary)).state.revision).toBe(1)
})

for (const change of ["edit", "delete"] as const) {
  test(`a new artifact ${change} before state publication prevents a committed broken reference`, async () => {
    const { project, store, directory } = await fixture()
    await store.read()
    const artifactDirectory = path.join(directory, "artifacts")
    const racing = new IterationStore(project, {
      afterArtifactPublish: async () => {
        const name = (await fs.readdir(artifactDirectory)).find((name) => name.endsWith(".json"))!
        const file = path.join(artifactDirectory, name)
        if (change === "edit") await fs.writeFile(file, "manual artifact edit\n")
        else await fs.unlink(file)
      },
    })
    await expect(racing.saveArtifact(0, summary)).rejects.toThrow(ProjectStorageError)
    expect((await store.read()).revision).toBe(0)
    expect((await store.read()).artifacts).toEqual([])
    if (change === "edit") {
      const name = (await fs.readdir(artifactDirectory)).find((name) => name.endsWith(".json"))!
      expect(await fs.readFile(path.join(artifactDirectory, name), "utf8")).toBe("manual artifact edit\n")
    }
  })
}

for (const edited of ["state", "artifact", "retained"] as const) {
  test(`manual ${edited} edits are preserved and block writes after restart`, async () => {
    const { project, store, directory } = await fixture()
    const saved = await store.saveArtifact(0, summary)
    const target =
      edited === "artifact"
        ? path.join(project.root, saved.artifact.path)
        : edited === "state"
          ? path.join(directory, "state.json")
          : path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith(".preserved"))!)
    const original = await fs.readFile(target, "utf8")
    const changed = `${original}\nmanual annotation\n`
    await fs.writeFile(target, changed)
    await expect(new IterationStore(project).read()).rejects.toThrow(ProjectStorageError)
    await expect(new IterationStore(project).saveArtifact(1, summary)).rejects.toThrow(ProjectStorageError)
    expect(await fs.readFile(target, "utf8")).toBe(changed)
  })
}

test("a manual rollback to a valid old state is preserved rather than treated as crash recovery", async () => {
  const { project, store, directory } = await fixture()
  const original = await store.read()
  await store.saveArtifact(0, summary)
  const target = path.join(directory, "state.json")
  const rollback = `${JSON.stringify(original, null, 2)}\n`
  await fs.writeFile(target, rollback)
  await expect(new IterationStore(project).read()).rejects.toThrow("manually edited")
  expect(await fs.readFile(target, "utf8")).toBe(rollback)
})

test("an edit racing state publication remains at its pathname and prevents the commit", async () => {
  const { project, store, directory } = await fixture()
  await store.read()
  const target = path.join(directory, "state.json")
  const edited = "human edit\n"
  const racing = new IterationStore(project, { beforePublish: () => fs.writeFile(target, edited) })
  await expect(
    racing.dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "race" }),
  ).rejects.toThrow("manually edited")
  expect(await fs.readFile(target, "utf8")).toBe(edited)
  expect(
    (await fs.readdir(path.join(directory, ".state"))).filter((name) => name.endsWith(".json")),
  ).toHaveLength(1)
})

test("artifact schemas require stable spec IDs, complete checks, and honest acceptance", async () => {
  const { project, store, specRef, planRef, revision } = await boundFixture()
  const review = acceptance(specRef, planRef, project.root)
  await expect(store.saveArtifact(revision, { ...review, items: [] })).rejects.toThrow("per-item")
  await expect(store.saveArtifact(revision, { ...review, checks: [] })).rejects.toThrow("every agreed check")
  await expect(store.saveArtifact(revision, { ...review, specHash: "b".repeat(64) })).rejects.toThrow(
    "exact saved spec",
  )
  await expect(
    store.saveArtifact(revision, {
      ...review,
      checks: [{ ...review.checks[0]!, status: "timed-out", exitCode: null }],
    }),
  ).rejects.toThrow("unsuccessful check")
  await expect(store.saveArtifact(revision, { ...review, reviewerModel: "coder" })).rejects.toThrow(
    "fallback",
  )
  const saved = await store.saveArtifact(revision, review)
  expect(await store.readArtifact(saved.artifact)).toEqual(review)
  await expect(store.saveArtifact(saved.state.revision, review)).rejects.toThrow("fresh review attempt")
  await expect(
    store.saveArtifact(saved.state.revision, {
      ...spec,
      revision: 2,
      items: [spec.items[0]!, spec.items[0]!],
    }),
  ).rejects.toThrow("duplicate ID")
}, 60000)

test("manual trials preserve distinct pending/tried/problem/deferred results and corrections map impacts", async () => {
  const { project, store, specRef, planRef, revision: initial } = await boundFixture()
  let revision = initial
  const verdict = await store.saveArtifact(revision, acceptance(specRef, planRef, project.root))
  revision = verdict.state.revision
  for (const status of ["pending", "tried", "problem", "deferred"] as const) {
    const trial = {
      kind: "manual-trial" as const,
      specHash: specRef.hash,
      specRevision: 1,
      batchId: "B1",
      batchPlan: { artifactId: planRef.id, hash: planRef.hash },
      attemptId: "review-1",
      codeHash: "a".repeat(64),
      attempt: 1,
      instructions: "Run local preview",
      observe: ["Feature visible"],
      status,
      ...(status === "pending" ? {} : { result: "Human reported this status" }),
    }
    const saved = await store.saveArtifact(revision, trial)
    expect(await store.readArtifact(saved.artifact)).toEqual(trial)
    revision = saved.state.revision
  }
  const correction = {
    kind: "correction" as const,
    specHash: specRef.hash,
    specRevision: 1,
    batchId: "B2",
    oldDecisionIds: ["D1"],
    newDecisionIds: ["D2"],
    summary: "Revise feature",
    mappings: [
      {
        oldDecisionId: "D1",
        newDecisionId: "D2",
        itemIds: ["S1"],
        changedFiles: ["src/feature.ts"],
        acceptedBatches: [],
      },
    ],
  }
  await expect(store.saveArtifact(revision, { ...correction, mappings: [] })).rejects.toThrow(
    "complete impact",
  )
  await expect(
    store.saveArtifact(revision, {
      ...correction,
      mappings: [{ ...correction.mappings[0]!, itemIds: ["S9"] }],
    }),
  ).rejects.toThrow("unknown stable spec")
  const saved = await store.saveArtifact(revision, correction)
  expect(await store.readArtifact(saved.artifact)).toEqual(correction)
  expect(saved.state.artifacts).toHaveLength(9)
  // This multi-transaction case now flushes both project and iteration claims.
  // Its deadline is a filesystem allowance, not a stage-performance contract.
}, 60000)

test("non-1 iteration directory replacement and stale captured iteration are rejected", async () => {
  const { store, directory } = await fixture(7)
  await store.read()
  await fs.rename(directory, `${directory}-original`)
  await fs.mkdir(directory)
  await expect(store.saveArtifact(0, summary)).rejects.toThrow(ProjectStorageError)
  const other = await fixture()
  await other.store.read()
  other.project.marker.currentIteration = 2
  await fs.writeFile(
    path.join(other.project.root, ".amira", "project.json"),
    JSON.stringify(other.project.marker),
  )
  await expect(other.store.read()).rejects.toThrow("stale")
  expect((await new IterationStore(await readProject(other.project.root)).read()).iteration).toBe(2)
})

for (const boundary of ["root", "ancestor"] as const) {
  test(`iteration publication refuses replaced ${boundary} junctions with copied identities`, async () => {
    const parent = await temp()
    const ancestor = path.join(parent, "ancestor")
    const root = path.join(ancestor, "project")
    await fs.mkdir(root, { recursive: true })
    const project = await createProject(root, "Pinned")
    const store = new IterationStore(project)
    await store.read()
    const external = await temp()
    const copied = boundary === "root" ? external : path.join(external, "project")
    await fs.cp(root, copied, { recursive: true })
    const replaced = boundary === "root" ? root : ancestor
    await fs.rename(replaced, `${replaced}-original`)
    await fs.symlink(external, replaced, process.platform === "win32" ? "junction" : "dir")
    await expect(store.saveArtifact(0, summary)).rejects.toThrow(ProjectStorageError)
    expect(await fs.readdir(path.join(copied, ".amira", "project", "iterations", "1", "artifacts"))).toEqual(
      [],
    )
  })
}

test("bounded journal prefetch validates every window and preserves edited evidence", async () => {
  const f = await fixture()
  let state = await f.store.read()
  for (let revision = 0; revision < 18; revision++)
    state = (await f.store.saveArtifact(state.revision, { ...summary, summary: `Window entry ${revision}` }))
      .state
  expect((await f.store.read()).revision).toBe(18)
  const projection = await fs.readFile(path.join(f.directory, "state.json"), "utf8")
  const journal = path.join(f.directory, ".state", "0000000000000017.json")
  const original = await fs.readFile(journal, "utf8")
  await fs.writeFile(journal, `${original} `)
  await expect(f.store.read()).rejects.toThrow("hash chain")
  expect(await fs.readFile(path.join(f.directory, "state.json"), "utf8")).toBe(projection)
  expect(await fs.readFile(journal, "utf8")).toBe(`${original} `)
  await fs.writeFile(journal, original)
  const artifact = path.join(f.project.root, ...state.artifacts.at(-1)!.path.split("/"))
  const content = await fs.readFile(artifact, "utf8")
  await fs.writeFile(artifact, `${content} `)
  await expect(f.store.read()).rejects.toThrow("artifact was edited")
  expect(await fs.readFile(path.join(f.directory, "state.json"), "utf8")).toBe(projection)
  expect(await fs.readFile(artifact, "utf8")).toBe(`${content} `)
  await fs.writeFile(artifact, content)
  expect(await f.store.read()).toEqual(state)
}, 120_000)
