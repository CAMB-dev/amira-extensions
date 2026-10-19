import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AskAnswer, AskQuestion } from "@amira/api"
import {
  appendSuggestion,
  createProject,
  DecisionStore,
  discoverProject,
  type Project,
  Registry,
  readDocument,
  readProject,
  saveResearchNote,
  writeDocument,
} from "../src/store.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amira-project-store-"))
  temporary.push(root)
  return root
}

async function fixture(): Promise<Project> {
  return createProject(await directory(), "Fixture")
}

const location = (project: Project, name: string) => path.join(project.root, ".amira", "project", name)
const questions: AskQuestion[] = [
  {
    question: "Which store?",
    header: "Storage",
    options: [
      { label: "Local", description: "Recommended: no remote dependency." },
      { label: "Remote", description: "Shared access; requires a server." },
    ],
  },
]
const answers: AskAnswer[] = [{ selected: ["Local"] }]
const meta = { sessionId: "design-session", askId: "ask-1", language: "en" }

test("creation initializes cost coverage and preserves gitignore bytes and marker identity", async () => {
  const root = await directory()
  await writeFile(path.join(root, ".gitignore"), "# existing\r\nnode_modules/", "utf8")
  const project = await createProject(root, "New project")
  expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
    "# existing\r\nnode_modules/\r\n.amira/project/\r\n",
  )
  expect((await readdir(location(project, ""))).sort()).toEqual([
    "costs.json",
    "decisions.md",
    "design.md",
    "iterations",
    "research",
    "suggestions.md",
  ])
  expect(JSON.parse(await readFile(location(project, "costs.json"), "utf8"))).toMatchObject({
    projectId: project.marker.id,
    coverage: { legacyIncomplete: false, policyInitialized: false },
    owners: [],
  })
  expect(await readdir(location(project, "iterations"))).toEqual(["1"])
  expect(await readdir(location(project, "iterations/1"))).toEqual([])
  expect(await readProject(root)).toEqual(project)
  await expect(createProject(root, "Replacement")).rejects.toThrow()
  expect((await readProject(root)).marker.id).toBe(project.marker.id)
})

test("commitDocuments opt-in leaves gitignore untouched; existing ignore entries are not duplicated", async () => {
  const root = await directory()
  await writeFile(path.join(root, ".gitignore"), "keep\n")
  await createProject(root, "Committed", { commitDocuments: true, language: "zh-CN" })
  expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("keep\n")
  const other = await directory()
  await writeFile(path.join(other, ".gitignore"), "# keep\n/.amira/project/\n")
  await createProject(other, "Ignored")
  expect(await readFile(path.join(other, ".gitignore"), "utf8")).toBe("# keep\n/.amira/project/\n")
})

test("nearest discovery respects nested projects and malformed/inaccessible marker boundaries", async () => {
  const outer = await fixture()
  const nested = path.join(outer.root, "nested")
  const deep = path.join(nested, "deep")
  await mkdir(deep, { recursive: true })
  expect(await discoverProject(deep)).toEqual(outer)
  const inner = await createProject(nested, "Nested")
  expect(await discoverProject(deep)).toEqual(inner)
  await writeFile(path.join(nested, ".amira", "project.json"), "{broken")
  await expect(discoverProject(deep)).rejects.toThrow("Malformed")
  await rm(path.join(nested, ".amira", "project.json"))
  await mkdir(path.join(nested, ".amira", "project.json"))
  await expect(discoverProject(deep)).rejects.toThrow()
  expect(await discoverProject(await directory())).toBeUndefined()
})

test("marker validation rejects output configuration and invalid schema; identity detects replacement and moves", async () => {
  const project = await fixture()
  const file = path.join(project.root, ".amira", "project.json")
  for (const bad of [
    { ...project.marker, schemaVersion: 2 },
    { ...project.marker, currentIteration: 0 },
    { ...project.marker, settings: { outputDir: "../../source" } },
    { ...project.marker, created: "not a date" },
  ]) {
    await writeFile(file, JSON.stringify(bad))
    await expect(readProject(project.root)).rejects.toThrow()
  }
  await writeFile(file, JSON.stringify({ ...project.marker, id: "new-identity" }))
  await expect(readProject(project.root, project.marker.id)).rejects.toThrow("replaced")
  await writeFile(file, JSON.stringify(project.marker))
  const moved = `${project.root}-moved`
  temporary.push(moved)
  await rename(project.root, moved)
  await expect(readProject(project.root, project.marker.id)).rejects.toThrow("missing or moved")
  expect((await readProject(moved, project.marker.id)).marker.id).toBe(project.marker.id)
})

test("registry revalidates, deduplicates canonical Windows paths, and updates a moved ID", async () => {
  const project = await fixture()
  const dataDir = path.join(await directory(), "data")
  const registry = new Registry(dataDir)
  await registry.remember(project)
  await registry.remember({ ...project, root: path.join(project.root, ".") })
  if (process.platform === "win32") await registry.remember({ ...project, root: project.root.toUpperCase() })
  expect(await registry.list()).toEqual([
    expect.objectContaining({ id: project.marker.id, root: project.root, name: "Fixture" }),
  ])
  const moved = `${project.root}-moved`
  temporary.push(moved)
  await rename(project.root, moved)
  expect(await registry.list()).toEqual([expect.objectContaining({ id: project.marker.id })])
  await registry.remember(await readProject(moved, project.marker.id))
  expect((await registry.list()).length).toBe(1)
  const actual = await readProject(moved)
  await writeFile(
    path.join(moved, ".amira", "project.json"),
    JSON.stringify({ ...actual.marker, id: "replacement" }),
  )
  expect(await registry.list()).toEqual([expect.objectContaining({ id: project.marker.id })])
})

test("registry writes are serialized across instances and corrupted registry data fails visibly", async () => {
  const dataDir = await directory()
  const projects = await Promise.all([fixture(), fixture()])
  await Promise.all(projects.map((project) => new Registry(dataDir).remember(project)))
  expect((await new Registry(dataDir).list()).length).toBe(2)
  await writeFile(path.join(dataDir, "registry.json"), "[]garbage")
  await expect(new Registry(dataDir).list()).rejects.toThrow("Malformed")
})

test("fixed documents, suggestions and generated research names never accept arbitrary paths", async () => {
  const project = await fixture()
  await writeDocument(project, "design.md", "设计\n")
  expect(await readDocument(project, "design.md")).toBe("设计\n")
  await appendSuggestion(project, "模型建议，尚未确认。", "zh-CN")
  expect(await readDocument(project, "suggestions.md")).toContain("待定建议")
  expect(await readDocument(project, "decisions.md")).toBe("")
  const research = await saveResearchNote(project, "../../source.ts", "Untrusted content")
  expect(path.dirname(research)).toBe(location(project, "research"))
  expect(path.basename(research)).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.md$/)
  expect(await readFile(research, "utf8")).toContain("# ../../source.ts")
  // Exercise runtime guards rather than relying solely on TypeScript literal unions.
  await expect(writeDocument(project, "source.ts" as "design.md", "no")).rejects.toThrow()
  await expect(writeDocument(project, "decisions.md" as "design.md", "forged")).rejects.toThrow()
  await expect(readDocument(project, "../../source.ts" as "design.md")).rejects.toThrow()
})

async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
}

test("setup refuses output and marker parent symlinks/junctions without writing outside", async () => {
  const root = await directory()
  const external = await directory()
  await linkDirectory(external, path.join(root, ".amira"))
  await expect(createProject(root, "Unsafe")).rejects.toThrow("Unsafe")
  expect(await readdir(external)).toEqual([])
  await expect(discoverProject(root)).rejects.toThrow("Unsafe")
  await rm(path.join(root, ".amira"))
  await mkdir(path.join(root, ".amira"))
  await linkDirectory(external, path.join(root, ".amira", "project"))
  await expect(createProject(root, "Unsafe output")).rejects.toThrow("Unsafe")
  expect(await readdir(external)).toEqual([])
})

test("writes refuse research and output junctions, and revalidate captured project identity", async () => {
  const project = await fixture()
  const external = await directory()
  await rm(location(project, "research"), { recursive: true })
  await linkDirectory(external, location(project, "research"))
  await expect(saveResearchNote(project, "Research", "no")).rejects.toThrow("Unsafe")
  await rm(location(project, "research"))
  await rm(location(project, ""), { recursive: true })
  await linkDirectory(external, location(project, ""))
  await expect(writeDocument(project, "design.md", "no")).rejects.toThrow("Unsafe")
  await expect(new DecisionStore(project).record(questions, answers, meta)).rejects.toThrow("Unsafe")
  expect(await readdir(external)).toEqual([])
  await rm(location(project, ""))
  await writeFile(
    path.join(project.root, ".amira", "project.json"),
    JSON.stringify({ ...project.marker, id: "replacement" }),
  )
  await expect(appendSuggestion(project, "late result", "en")).rejects.toThrow("replaced")
})

test("human decisions retain exact options, choices, Other text, dates and ask provenance across restart", async () => {
  const project = await fixture()
  const store = new DecisionStore(project)
  const humanQuestions = [{ ...questions[0]!, multiSelect: true }]
  const humanAnswers = [{ selected: ["Local"], other: "I need offline access." }]
  const recorded = await store.record(humanQuestions, humanAnswers, meta)
  expect(recorded).toEqual([
    expect.objectContaining({
      id: "D1",
      question: humanQuestions[0],
      answer: humanAnswers[0],
      provenance: "human",
      sessionId: meta.sessionId,
      askId: meta.askId,
      language: "en",
      supersedes: [],
      supersededBy: [],
    }),
  ])
  expect(recorded[0]!.rationale).toBeUndefined()
  expect(Number.isFinite(Date.parse(recorded[0]!.date))).toBe(true)
  const markdown = await readDocument(project, "decisions.md")
  expect(markdown).toContain("[x] Local — Recommended: no remote dependency.")
  expect(markdown).toContain("[ ] Remote — Shared access; requires a server.")
  expect(markdown).toContain("I need offline access.")
  expect(markdown).toContain("Evidence (human response): session=design-session; ask=ask-1")
  expect(await new DecisionStore(project).records()).toEqual(recorded)
  expect((await store.recover()).conflict).toBe(false)
  expect(await readDocument(project, "decisions.md")).toBe(markdown)
})

test("supersession preserves old evidence and wording/language, and duplicate asks are idempotent", async () => {
  const project = await fixture()
  const store = new DecisionStore(project)
  await store.record(questions, answers, meta)
  const before = await readFile(location(project, "decisions.evidence.jsonl"), "utf8")
  expect(await store.record(questions, answers, meta)).toEqual(await store.records())
  expect(
    await store.record(questions, answers, { language: "en", askId: "ask-1", sessionId: "design-session" }),
  ).toEqual(await store.records())
  expect(await readFile(location(project, "decisions.evidence.jsonl"), "utf8")).toBe(before)
  await expect(store.record(questions, [{ selected: ["Remote"] }], meta)).rejects.toThrow(
    "different evidence",
  )
  await expect(
    store.record(questions, answers, { ...meta, askId: "bad", supersedes: ["D999"] }),
  ).rejects.toThrow("unknown decision")
  await store.record(questions, [{ selected: ["Remote"] }], {
    ...meta,
    askId: "ask-2",
    language: "zh-CN",
    supersedes: ["D1"],
  })
  const records = await store.records()
  expect(records[0]).toEqual(
    expect.objectContaining({ id: "D1", question: questions[0], language: "en", supersededBy: ["D2"] }),
  )
  expect(records[1]).toEqual(expect.objectContaining({ id: "D2", language: "zh-CN", supersedes: ["D1"] }))
  expect((await readFile(location(project, "decisions.evidence.jsonl"), "utf8")).startsWith(before)).toBe(
    true,
  )
  expect(await readDocument(project, "decisions.md")).toContain("Superseded by: D2")
})

test("multi-select and Other-only answers remain exact and oversized descriptions survive evidence retention", async () => {
  const project = await fixture()
  const store = new DecisionStore(project)
  const large = structuredClone(questions)
  large[0]!.options[0]!.description = "取舍".repeat(20_000)
  large[0]!.multiSelect = true
  const recorded = await store.record(
    [...large, ...questions],
    [{ selected: ["Local", "Remote"] }, { selected: [], other: "A third choice." }],
    meta,
  )
  expect(recorded.map((record) => record.id)).toEqual(["D1", "D2"])
  expect(recorded[0]!.rationale).toBeUndefined()
  expect(recorded[1]!.rationale).toBeUndefined()
  expect((await new DecisionStore(project).records())[0]!.question.options[0]!.description).toBe(
    large[0]!.options[0]!.description,
  )
  expect((await readFile(location(project, "decisions.evidence.jsonl"))).length).toBeGreaterThan(16_384)
})

test("real AskQuestion/AskAnswer validation rejects fabricated/commander/cancelled and mismatched shapes", async () => {
  const project = await fixture()
  const store = new DecisionStore(project)
  const badQuestions: unknown[] = [
    [],
    [{ ...questions[0], options: [{ label: "Only" }] }],
    [{ ...questions[0], options: [{ label: "Dup" }, { label: "Dup" }] }],
    [{ ...questions[0], multiSelect: "yes" }],
  ]
  for (const bad of badQuestions)
    await expect(store.record(bad as AskQuestion[], answers, meta)).rejects.toThrow()
  const badAnswers: unknown[] = [
    [],
    [{ selected: ["Unknown"] }],
    [{ selected: ["Local", "Remote"] }],
    [{ selected: ["Local", "Local"] }],
    [{ selected: [] }],
    [{ selected: [], other: "" }],
    [{ selected: ["Local"], by: "the commander" }],
    { declined: true },
    { answers, by: "the commander" },
  ]
  for (const bad of badAnswers)
    await expect(store.record(questions, bad as AskAnswer[], meta)).rejects.toThrow()
  await expect(
    store.record(questions, answers, { ...meta, provenance: "commander" } as typeof meta),
  ).rejects.toThrow()
  expect(await store.records()).toEqual([])
  expect(await readDocument(project, "decisions.md")).toBe("")
})

test("evidence is durably committed before Markdown, and recovery distinguishes crash-stale Markdown from hand edits", async () => {
  const project = await fixture()
  const initial = new DecisionStore(project)
  await initial.record(questions, answers, meta)
  const priorMarkdown = await readDocument(project, "decisions.md")
  const crashed = new DecisionStore(project, {
    afterEvidenceSync: async () => {
      expect((await new DecisionStore(project).records()).length).toBe(2)
      expect(await readDocument(project, "decisions.md")).toBe(priorMarkdown)
      throw new Error("simulated process crash after fsync")
    },
  })
  await expect(
    crashed.record(questions, [{ selected: ["Remote"] }], { ...meta, askId: "ask-2", supersedes: ["D1"] }),
  ).rejects.toThrow("simulated process crash")
  // Lose the manifest too: the evidence itself carries the old generated hash.
  await rm(location(project, "decisions.manifest.json"))
  const recovered = new DecisionStore(project)
  expect(await recovered.recover()).toEqual({ conflict: false, path: location(project, "decisions.md") })
  expect(await readDocument(project, "decisions.md")).toContain("## D2:")
  expect(await readDocument(project, "decisions.md")).toContain("Superseded by: D2")
  expect(
    (
      await recovered.record(questions, [{ selected: ["Remote"] }], {
        ...meta,
        askId: "ask-2",
        supersedes: ["D1"],
      })
    ).length,
  ).toBe(1)
  expect((await recovered.records()).length).toBe(2)
})

test("crash followed by a manual edit preserves the edit and writes a generated sibling", async () => {
  const project = await fixture()
  const store = new DecisionStore(project, {
    afterEvidenceSync: () => {
      throw new Error("crash")
    },
  })
  await expect(store.record(questions, answers, meta)).rejects.toThrow("crash")
  await writeFile(location(project, "decisions.md"), "My hand-edited decisions.\n")
  await rm(location(project, "decisions.manifest.json"))
  const reopened = new DecisionStore(project)
  expect(await reopened.recover()).toEqual({
    conflict: true,
    path: location(project, "decisions.generated.md"),
  })
  expect(await readDocument(project, "decisions.md")).toBe("My hand-edited decisions.\n")
  expect(await readFile(location(project, "decisions.generated.md"), "utf8")).toContain("## D1:")
  await reopened.record(questions, answers, { ...meta, askId: "ask-2" })
  expect(await readDocument(project, "decisions.md")).toBe("My hand-edited decisions.\n")
  expect((await reopened.recover()).conflict).toBe(true)
  expect(await readFile(location(project, "decisions.generated.md"), "utf8")).toContain("## D2:")
})

test("a stale manifest after Markdown replacement is recoverable, while ordinary hand edits remain protected", async () => {
  const project = await fixture()
  const store = new DecisionStore(project)
  await store.record(questions, answers, meta)
  const oldManifest = await readFile(location(project, "decisions.manifest.json"), "utf8")
  await store.record(questions, answers, { ...meta, askId: "ask-2" })
  const completedMarkdown = await readDocument(project, "decisions.md")
  // Equivalent to termination after the Markdown rename, before the manifest rename.
  await writeFile(location(project, "decisions.manifest.json"), oldManifest)
  expect((await new DecisionStore(project).recover()).conflict).toBe(false)
  expect(await readDocument(project, "decisions.md")).toBe(completedMarkdown)
  await writeFile(location(project, "decisions.md"), `${completedMarkdown}\nHand-written annotation.\n`)
  expect((await store.recover()).conflict).toBe(true)
  expect(await readDocument(project, "decisions.md")).toContain("Hand-written annotation.")
})

test("file destinations cannot themselves be replaced by junctions", async () => {
  const project = await fixture()
  const external = await directory()
  await rm(location(project, "design.md"))
  await linkDirectory(external, location(project, "design.md"))
  await expect(writeDocument(project, "design.md", "escaped")).rejects.toThrow("Unsafe")
  await expect(readDocument(project, "design.md")).rejects.toThrow("Unsafe")
  await linkDirectory(external, location(project, "decisions.evidence.jsonl"))
  await expect(new DecisionStore(project).record(questions, answers, meta)).rejects.toThrow("Unsafe")
  expect(await readdir(external)).toEqual([])
})

test("failed evidence write cannot promote a decision; corrupt evidence cannot be guessed from Markdown", async () => {
  const project = await fixture()
  const evidence = location(project, "decisions.evidence.jsonl")
  await mkdir(evidence)
  const store = new DecisionStore(project)
  await expect(store.record(questions, answers, meta)).rejects.toThrow()
  expect(await readDocument(project, "decisions.md")).toBe("")
  await rm(evidence, { recursive: true })
  await store.record(questions, answers, meta)
  const markdown = await readDocument(project, "decisions.md")
  await writeFile(evidence, "{truncated")
  await expect(new DecisionStore(project).recover()).rejects.toThrow("Malformed decision evidence")
  expect(await readDocument(project, "decisions.md")).toBe(markdown)
})

test("store instances serialize writes; callback mutations cannot change the captured evidence", async () => {
  const project = await fixture()
  const mutableQuestions = structuredClone(questions)
  const mutableAnswers = structuredClone(answers)
  const capturedProject = structuredClone(project)
  const one = new DecisionStore(capturedProject).record(mutableQuestions, mutableAnswers, meta)
  capturedProject.root = "not-a-project"
  capturedProject.marker.id = "changed-after-callback"
  mutableQuestions[0]!.question = "Changed after answering"
  mutableAnswers[0]!.selected = ["Remote"]
  await Promise.all([one, new DecisionStore(project).record(questions, answers, { ...meta, askId: "ask-2" })])
  const records = await new DecisionStore(project).records()
  expect(records.map((record) => record.id)).toEqual(["D1", "D2"])
  expect(records[0]!.question.question).toBe("Which store?")
  expect(records[0]!.answer.selected).toEqual(["Local"])
})
