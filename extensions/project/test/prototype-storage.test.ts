import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AskQuestion } from "@amira/api"
import { type PrototypeManifestArtifact, validateArtifact } from "../src/artifacts.ts"
import { createProject, DecisionStore, IterationStore, readDocument } from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(60000)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function fixture(iteration = 1) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "project-prototype-storage-"))
  roots.push(root)
  const project = await createProject(root, "Prototype")
  if (iteration !== 1) {
    project.marker.currentIteration = iteration
    await fs.writeFile(path.join(project.root, ".amira", "project.json"), JSON.stringify(project.marker))
  }
  const store = new IterationStore(project)
  const directory = await store.preparePrototypeDirectory("alpha")
  const manifest: PrototypeManifestArtifact = {
    kind: "prototype-manifest",
    variants: [
      {
        id: "alpha",
        idea: "Compact view",
        question: "Is this easier to scan?",
        directory,
        runCommand: "bun run demo.ts",
        cwd: directory,
        prerequisites: [],
        notes: "Local fixture",
        status: "ready",
      },
    ],
  }
  return { project, store, directory, manifest }
}
const question: AskQuestion = {
  question: "Which prototype?",
  options: [
    { label: "alpha", description: "Compact; less detail" },
    { label: "none", description: "Keep findings only" },
  ],
}
const meta = { sessionId: "human", askId: "choose-alpha", language: "en", reason: "Easier to scan" }
async function prototypeFixture() {
  const f = await fixture()
  const summary = await f.store.saveArtifact(0, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Design ready",
    outputs: [],
    suggestion: "Try prototypes",
  })
  let state = await f.store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await f.store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "prototype-next",
      from: "design",
      to: "prototype",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Try prototypes",
      skippedStages: ["design"],
    },
  })
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "prototype-next", "prototype"),
  })
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "prototype-work",
  })
  const saved = await f.store.saveArtifact(state.revision, f.manifest)
  return { ...f, saved }
}

test("prototype manifests round-trip with iteration-bound canonical paths and pending commands", async () => {
  const { store, project, directory, manifest } = await fixture(7)
  expect(directory).toBe(path.join(project.root, ".amira", "project", "prototypes", "7", "alpha"))
  expect(await store.preparePrototypeDirectory("alpha")).toBe(directory)
  manifest.variants[0]!.runCommand = null
  manifest.variants[0]!.status = "planned"
  const saved = await store.saveArtifact(0, manifest)
  expect(saved.artifact.kind).toBe("prototype-manifest")
  expect(await new IterationStore(project).readArtifact(saved.artifact)).toEqual(manifest)
  expect(saved.state.revision).toBe(1)
})

test("prototype schema rejects malformed, ambiguous and escaping manifests", async () => {
  const { manifest, project } = await fixture()
  const variant = manifest.variants[0]!
  for (const invalid of [
    { ...manifest, variants: [] },
    { ...manifest, variants: Array.from({ length: 4 }, (_, index) => ({ ...variant, id: `v${index}` })) },
    { ...manifest, variants: [variant, { ...variant, id: "ALPHA" }] },
    { ...manifest, variants: [{ ...variant, runCommand: null }] },
    { ...manifest, variants: [{ ...variant, cwd: project.root }] },
    { ...manifest, variants: [{ ...variant, cwd: `${variant.directory}-sibling` }] },
    { ...manifest, variants: [{ ...variant, cwd: path.join(variant.directory, "nested", "..") + path.sep }] },
    { ...manifest, variants: [{ ...variant, unexpected: true }] },
    { ...manifest, chosen: { variantId: "missing", decisionId: "D1" } },
    { ...manifest, chosen: { variantId: null, decisionId: "" } },
    { ...manifest, arbitrary: true },
  ])
    expect(() => validateArtifact(invalid)).toThrow()
})

test("store rejects other iterations, sibling variants, unsafe IDs and forged choice evidence", async () => {
  const { store, directory, manifest } = await fixture()
  for (const id of ["../escape", "alpha/beta", "alpha\\beta", "alpha.", "CON", "nul.txt", "none", "C:evil"])
    await expect(store.preparePrototypeDirectory(id)).rejects.toThrow()
  await expect(
    store.saveArtifact(0, {
      ...manifest,
      variants: [
        {
          ...manifest.variants[0]!,
          directory: path.join(directory, "..", "beta"),
          cwd: path.join(directory, "..", "beta"),
        },
      ],
    }),
  ).rejects.toThrow("must match")
  await expect(
    store.saveArtifact(0, {
      ...manifest,
      variants: [
        {
          ...manifest.variants[0]!,
          directory: directory.replace(`${path.sep}1${path.sep}`, `${path.sep}2${path.sep}`),
          cwd: directory.replace(`${path.sep}1${path.sep}`, `${path.sep}2${path.sep}`),
        },
      ],
    }),
  ).rejects.toThrow("must match")
  await expect(
    store.saveArtifact(0, { ...manifest, chosen: { variantId: "alpha", decisionId: "D1" } }),
  ).rejects.toThrow("recorded human")
})

test("variant directory and cwd junctions/replacements fail closed", async () => {
  const { store, project, directory, manifest } = await fixture()
  const outside = path.join(project.root, "outside")
  await fs.mkdir(outside)
  const moved = `${directory}-original`
  await fs.rename(directory, moved)
  await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir")
  await expect(store.preparePrototypeDirectory("alpha")).rejects.toThrow()
  await expect(store.saveArtifact(0, manifest)).rejects.toThrow()
  await fs.unlink(directory)
  await fs.mkdir(directory)
  await expect(store.preparePrototypeDirectory("alpha")).rejects.toThrow("replaced")
})

test("choice commits explicit reason and exact immutable pointers, surviving restart", async () => {
  const { store, project, saved } = await prototypeFixture()
  const chosen = await store.recordPrototypeChoice(
    saved.state.revision,
    saved.artifact,
    question,
    [{ selected: ["alpha"] }],
    meta,
  )
  expect(chosen.state.revision).toBe(saved.state.revision + 1)
  expect(chosen.state.prototypeChoice).toMatchObject({ variantId: "alpha", decisionId: "D1" })
  expect(chosen.records[0]).toMatchObject({
    formatVersion: 3,
    reason: meta.reason,
    rationale: meta.reason,
    prototypeChoice: { manifest: saved.artifact, variantId: "alpha", revision: saved.state.revision },
  })
  expect(await store.readArtifact(chosen.artifact)).toMatchObject({
    chosen: { variantId: "alpha", decisionId: "D1" },
  })
  expect(await new IterationStore(project).read()).toEqual(chosen.state)
  await new DecisionStore(project).recover()
  expect(await readDocument(project, "decisions.md")).toContain("Rationale: Easier to scan")
})

test("localized none and explicit reason skip are recorded as a human conclusion, not Other", async () => {
  const { store, project, saved } = await prototypeFixture()
  const localized = {
    ...question,
    options: [question.options[0]!, { label: "都不选", description: "保留结论" }],
  }
  const chosen = await store.recordPrototypeChoice(
    saved.state.revision,
    saved.artifact,
    localized,
    { selected: ["都不选"] },
    { sessionId: "human", askId: "none", language: "zh", reasonSkipped: true },
    null,
  )
  expect(chosen.state.prototypeChoice?.variantId).toBeNull()
  expect(chosen.records[0]).toMatchObject({ formatVersion: 3, reasonSkipped: true })
  expect(chosen.records[0]?.rationale).toBeUndefined()
  expect(await store.readArtifact(chosen.artifact)).toMatchObject({
    chosen: { variantId: null, decisionId: "D1" },
  })
  await new DecisionStore(project).recover()
  expect(await readDocument(project, "decisions.md")).toContain("用户明确跳过")
})

test("stale choice and nonhuman/ambiguous answers never append evidence", async () => {
  const { store, project, saved, manifest } = await prototypeFixture()
  const decisions = new DecisionStore(project)
  const controller = new AbortController()
  controller.abort()
  await expect(
    store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      meta,
      "alpha",
      { signal: controller.signal },
    ),
  ).rejects.toThrow()
  await expect(
    store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: [], other: "alpha" },
      meta,
    ),
  ).rejects.toThrow("not Other")
  await expect(
    store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      { sessionId: "human", askId: "missing-reason", language: "en" },
    ),
  ).rejects.toThrow("reason")
  await expect(
    store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      meta,
      null,
    ),
  ).rejects.toThrow("does not match")
  const newer = await store.saveArtifact(saved.state.revision, manifest)
  await expect(
    store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      meta,
    ),
  ).rejects.toThrow("Stale")
  await expect(
    store.recordPrototypeChoice(
      newer.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      meta,
    ),
  ).rejects.toThrow("latest")
  expect(await decisions.records()).toEqual([])
  await expect(
    store.dispatch(newer.state.revision, {
      type: "select-prototype",
      expectedRevision: newer.state.revision,
      variantId: "alpha",
      decisionId: "D1",
      receipt: human(newer.state, "alpha", "alpha"),
    }),
  ).rejects.toThrow("recordPrototypeChoice")
})

test("post-evidence publication failure is retryable without duplicating the human decision", async () => {
  const { project, store, saved } = await prototypeFixture()
  let fail = true
  const failing = new IterationStore(project, {
    afterArtifactPublish: () => {
      if (fail) {
        fail = false
        throw new Error("injected projection failure")
      }
    },
  })
  await expect(
    failing.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      question,
      { selected: ["alpha"] },
      meta,
    ),
  ).rejects.toThrow("injected")
  const records = await new DecisionStore(project).records()
  expect(records).toHaveLength(1)
  expect(records[0]?.prototypeChoice?.manifest).toEqual(saved.artifact)
  expect((await store.read()).revision).toBe(saved.state.revision)
  const chosen = await failing.recordPrototypeChoice(
    saved.state.revision,
    saved.artifact,
    question,
    { selected: ["alpha"] },
    meta,
  )
  expect(chosen.state.prototypeChoice?.decisionId).toBe("D1")
  expect(await new DecisionStore(project).records()).toHaveLength(1)
})

test("version 1/2 raw evidence and semantic hashes remain byte-identical when version 3 is appended", async () => {
  const { project } = await fixture()
  const decisions = new DecisionStore(project)
  await decisions.record([question], [{ selected: [], other: "Another layout" }], {
    sessionId: "old",
    askId: "v1",
    language: "en",
  })
  const file = path.join(project.root, ".amira", "project", "decisions.evidence.jsonl")
  const legacy = JSON.parse(await fs.readFile(file, "utf8"))
  delete legacy.projectionVersion
  delete legacy.records[0].formatVersion
  legacy.records[0].rationale = legacy.answers[0].other
  const legacyRaw = `${JSON.stringify(legacy)}\n`
  await fs.writeFile(file, legacyRaw)
  await decisions.record([question], [{ selected: ["none"] }], {
    sessionId: "old",
    askId: "v2",
    language: "en",
  })
  const raw = await fs.readFile(file, "utf8")
  expect(raw.startsWith(legacyRaw)).toBe(true)
  const markdown = await readDocument(project, "decisions.md")
  expect(JSON.parse(raw.trimEnd().split("\n")[1]!).records[0].formatVersion).toBe(2)
  await decisions.record([question], [{ selected: ["alpha"] }], meta)
  const updated = await fs.readFile(file, "utf8")
  expect(updated.startsWith(raw)).toBe(true)
  const modern = JSON.parse(updated.trimEnd().split("\n")[2]!)
  expect(modern.projectionVersion).toBe(3)
  expect(modern.priorGeneratedHash).toBe(createHash("sha256").update(markdown).digest("hex"))
  expect((await decisions.records())[0]?.rationale).toBeUndefined()
  await decisions.recover()
  expect(await fs.readFile(file, "utf8")).toBe(updated)
})

test("explicit reasons cannot be inferred from Other, contradicted, empty, cancelled or changed on retry", async () => {
  const { project } = await fixture()
  const store = new DecisionStore(project)
  const controller = new AbortController()
  controller.abort()
  await expect(
    store.record([question], [{ selected: ["alpha"] }], meta, { signal: controller.signal }),
  ).rejects.toThrow()
  await expect(store.record([question], [{ selected: ["alpha"] }], { ...meta, reason: "" })).rejects.toThrow()
  await expect(
    store.record([question], [{ selected: ["alpha"] }], { ...meta, reasonSkipped: true }),
  ).rejects.toThrow()
  const recorded = await store.record([question], [{ selected: [], other: "Alternative" }], meta)
  expect(recorded[0]?.rationale).toBe(meta.reason)
  expect(recorded[0]?.answer.other).toBe("Alternative")
  await expect(
    store.record([question], [{ selected: [], other: "Alternative" }], { ...meta, reason: "Changed reason" }),
  ).rejects.toThrow("different evidence")
  expect(await store.records()).toHaveLength(1)
})

test("optional expectedRevision rejects stale direct design evidence before append", async () => {
  const { project, store } = await fixture()
  const decisions = new DecisionStore(project)
  await decisions.record([question], [{ selected: ["alpha"] }], { ...meta, expectedRevision: 0 })
  expect((await store.read()).revision).toBe(1)
  await expect(
    decisions.record([question], [{ selected: ["alpha"] }], { ...meta, askId: "late", expectedRevision: 0 }),
  ).rejects.toThrow("Stale")
  expect(await decisions.records()).toHaveLength(1)
})
