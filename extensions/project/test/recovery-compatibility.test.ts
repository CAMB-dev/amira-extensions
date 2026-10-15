import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { projectError } from "../src/diagnostics.ts"
import { createProject, IterationStore } from "../src/store.ts"

setDefaultTimeout(30_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

async function fixture(language = "en") {
  const root = await mkdtemp(path.join(tmpdir(), "project-recovery-compat-"))
  roots.push(root)
  const project = await createProject(root, "Recovery compatibility", { language })
  const store = new IterationStore(project)
  await store.read()
  const directory = path.join(root, ".amira/project/iterations/1")
  const projection = path.join(directory, "state.json")
  return { root, project, store, directory, projection }
}

async function incompleteArtifact(language: string, schemaVersion: number) {
  const f = await fixture(language)
  const before = await readFile(f.projection, "utf8")
  const saved = await f.store.saveArtifact(0, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "A complete immutable artifact",
    outputs: [],
    suggestion: "Review, never auto-start",
  })
  const artifactFile = path.join(f.root, saved.artifact.path)
  const artifact = json({ ...JSON.parse(await readFile(artifactFile, "utf8")), schemaVersion })
  const state = {
    ...saved.state,
    artifacts: saved.state.artifacts.map((ref) =>
      ref.id === saved.artifact.id ? { ...ref, hash: hash(artifact) } : ref,
    ),
  }
  const journalFile = path.join(f.directory, ".state/0000000000000001.json")
  const journal = json({ ...JSON.parse(await readFile(journalFile, "utf8")), state })
  const receipt = path.join(f.directory, ".state/0000000000000001.projected")
  await writeFile(artifactFile, artifact)
  await writeFile(journalFile, journal)
  // Intact newer-writer journal, crash after durable publication but before projection/ack.
  await writeFile(f.projection, before)
  await unlink(receipt)
  return {
    ...f,
    before,
    receipt,
    state,
    artifactFile,
    journalFile,
    files: new Map([
      [f.projection, before],
      [artifactFile, artifact],
      [journalFile, journal],
    ]),
  }
}
async function assertNoRecoveryWrites(
  f: Awaited<ReturnType<typeof incompleteArtifact>>,
  action: () => Promise<unknown>,
) {
  const identity = await stat(f.projection)
  const retained = (await readdir(f.directory)).filter((name) => name.endsWith(".preserved")).sort()
  const result = await action().catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
  for (const [file, bytes] of f.files) expect(await readFile(file, "utf8")).toBe(bytes)
  await expect(readFile(f.receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  expect((await stat(f.projection)).ino).toBe(identity.ino)
  expect((await readdir(f.directory)).filter((name) => name.endsWith(".preserved")).sort()).toEqual(retained)
  return result
}

for (const [language, compatible] of [
  ["en", "compatible"],
  ["zh-CN", "兼容"],
  ["ja", "互換"],
]) {
  test(`${language}: future artifact after journal commit is rejected BEFORE repairing or acknowledging projection`, async () => {
    const f = await incompleteArtifact(language!, 99)
    const error = await assertNoRecoveryWrites(f, () => f.store.read())
    expect(error).toMatchObject({
      details: {
        reason: "unsupported-schema",
        document: "iteration artifact",
        encountered: 99,
        supported: 1,
      },
    })
    expect(projectError(error, language!)).toContain(compatible!)
    // A reopened process/store must fail identically without turning the first failure into a repair.
    await assertNoRecoveryWrites(f, () => new IterationStore(f.project).read())
  })
}

test("artifact integrity errors also cannot mutate a post-journal/pre-projection snapshot", async () => {
  const f = await incompleteArtifact("en", 1)
  const edited = `${f.files.get(f.artifactFile)!}\n`
  await writeFile(f.artifactFile, edited)
  f.files.set(f.artifactFile, edited)
  const error = await assertNoRecoveryWrites(f, () => f.store.read())
  expect((error as Error).message).toContain("edited")
})

test("invalid immutable-plan metadata is rejected before recovery publication", async () => {
  const f = await fixture()
  const spec = await f.store.saveArtifact(0, {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "One item",
    body: "Implement S1.",
    decisionIds: [],
    checks: [],
    items: [
      {
        id: "S1",
        description: "One item",
        constraints: [],
        verification: ["Inspect"],
        acceptanceCriteria: ["Expected result"],
        decisionIds: [],
        checkIds: [],
        ui: false,
      },
    ],
  })
  const before = await readFile(f.projection, "utf8")
  const plan = await f.store.saveArtifact(spec.state.revision, {
    kind: "batch-plan",
    specHash: spec.artifact.hash,
    specRevision: 1,
    mode: "single",
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: [] }],
  })
  const state = {
    ...plan.state,
    batchManifests: plan.state.batchManifests!.map((manifest) => ({
      ...manifest,
      batchIds: ["B1", "B-phantom"],
    })),
  }
  const journalFile = path.join(f.directory, ".state/0000000000000002.json")
  const journal = json({ ...JSON.parse(await readFile(journalFile, "utf8")), state })
  const receipt = path.join(f.directory, ".state/0000000000000002.projected")
  await writeFile(journalFile, journal)
  await writeFile(f.projection, before)
  await unlink(receipt)
  const artifactFile = path.join(f.root, plan.artifact.path)
  const files = new Map([
    [f.projection, before],
    [journalFile, journal],
    [artifactFile, await readFile(artifactFile, "utf8")],
  ])
  const error = await assertNoRecoveryWrites(
    { ...f, before, receipt, state, artifactFile, journalFile, files },
    () => f.store.read(),
  )
  expect((error as Error).message).toContain("manifest")
})

test("supported artifacts are fully validated and then the incomplete projection is safely recovered", async () => {
  const f = await incompleteArtifact("en", 1)
  const recovered = await f.store.read()
  expect(recovered).toEqual(f.state)
  expect(await readFile(f.projection, "utf8")).toBe(json(f.state))
  expect(await readFile(f.receipt, "utf8")).toBe(`${hash(f.files.get(f.journalFile)!)}\n`)
  expect(recovered.attempts).toEqual([])
  expect(recovered.receipts).toEqual([])
  expect(recovered.stage).toBe("design")
  for (const file of [f.artifactFile, f.journalFile])
    expect(await readFile(file, "utf8")).toBe(f.files.get(file)!)
})
