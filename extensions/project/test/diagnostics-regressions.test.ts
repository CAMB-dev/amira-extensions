import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  Message,
  SessionControl,
  SessionData,
} from "@amira/api"
import { createProjectExtension } from "../src/index.ts"
import { createProject, IterationStore } from "../src/store.ts"

setDefaultTimeout(30_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), "project-diagnostics-"))
  roots.push(root)
  return root
}
async function fixture(language: string, conversation: Message[] = []) {
  const root = await temp()
  const cwd = path.join(root, "work")
  await mkdir(cwd)
  const project = await createProject(cwd, "Diagnostics", { language })
  const store = new IterationStore(project)
  const values = new Map<string, unknown[]>()
  const data: SessionData = {
    append: (key, value) => {
      values.set(key, [...(values.get(key) ?? []), structuredClone(value)])
    },
    read: (key) => structuredClone(values.get(key) ?? []),
  }
  const session = {
    info: () => ({ id: "main", cwd, file: path.join(root, "session.jsonl"), busy: false }),
    data,
    messages: () => conversation,
  } as unknown as SessionControl
  let command!: CommandDefinition
  const output: { text: string; level?: string }[] = []
  let confirm: () => Promise<boolean | undefined> = async () => undefined
  const api = {
    cwd,
    dataDir: path.join(root, "extension-data"),
    session: () => session,
    settings: { declare: () => ({ get: () => ({ language: "en" }), onChange: () => () => {} }) },
    registerCommand: (value: CommandDefinition) => {
      command = value
    },
    registerPanel() {},
    on: () => () => {},
    requestRender() {},
    notify() {},
  } as unknown as ExtensionAPI
  const ctx = {
    cwd,
    session,
    frontend: "tui",
    signal: new AbortController().signal,
    ui: { select: async () => undefined, input: async () => undefined, confirm: async () => confirm() },
    print: (text: string, level?: string) => output.push({ text, level }),
  } as unknown as CommandContext
  await createProjectExtension()(api)
  await command.run(`switch "${cwd}"`, ctx)
  return {
    project,
    store,
    command,
    ctx,
    output,
    restart: async () => {
      // Resume the same attachment without invoking panel rendering or any project read.
      await createProjectExtension()(api)
      return command
    },
    setConfirm: (callback: typeof confirm) => {
      confirm = callback
    },
  }
}

async function futureArtifact(f: Awaited<ReturnType<typeof fixture>>) {
  const current = await f.store.read()
  const saved = await f.store.saveArtifact(current.revision, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "An intact future-format artifact",
    outputs: [],
    suggestion: "Review",
  })
  const artifactFile = path.join(f.project.root, saved.artifact.path)
  const envelope = `${JSON.stringify({ ...JSON.parse(await readFile(artifactFile, "utf8")), schemaVersion: 99 }, null, 2)}\n`
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const state = {
    ...saved.state,
    artifacts: saved.state.artifacts.map((ref) =>
      ref.id === saved.artifact.id ? { ...ref, hash: digest(envelope) } : ref,
    ),
  }
  const revision = String(state.revision).padStart(16, "0")
  const journalFile = path.join(f.project.root, `.amira/project/iterations/1/.state/${revision}.json`)
  const journal = `${JSON.stringify({ ...JSON.parse(await readFile(journalFile, "utf8")), state }, null, 2)}\n`
  // Simulate an intact newer writer, not a hand edit: every artifact/journal/projection hash agrees.
  const files = new Map([
    [artifactFile, envelope],
    [journalFile, journal],
    [
      path.join(f.project.root, ".amira/project/iterations/1/state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    ],
    [
      path.join(f.project.root, `.amira/project/iterations/1/.state/${revision}.projected`),
      `${digest(journal)}\n`,
    ],
  ])
  for (const [file, content] of files) await writeFile(file, content)
  return files
}

for (const language of ["en", "zh-CN", "ja"]) {
  test(`${language}: intact-hash future artifact envelopes get compatibility diagnostics and preserve bytes`, async () => {
    const f = await fixture(language)
    const files = await futureArtifact(f)
    const error = await f.store.read().catch((error: unknown) => error)
    expect(error).toMatchObject({
      name: "ProjectStorageError",
      details: {
        reason: "unsupported-schema",
        document: "iteration artifact",
        encountered: 99,
        supported: 1,
      },
    })
    await f.command.run("status", f.ctx)
    const diagnostic = f.output.findLast((line) => line.level === "error")!.text
    expect(diagnostic).toContain(language === "en" ? "compatible" : language === "zh-CN" ? "兼容" : "互換")
    expect(diagnostic).toContain("99")
    expect(diagnostic).toContain("1")
    expect(diagnostic).not.toContain("Invalid iteration artifact envelope")
    for (const [file, content] of files) expect(await readFile(file, "utf8")).toBe(content)
  })
}

for (const [language, native, instruction] of [
  ["en", "Stale iteration writer", "reload"],
  ["zh-CN", "版本", "重新"],
  ["ja", "リビジョン", "再確認"],
]) {
  test(`${language}: stale approval errors use the project language and exact revisions`, async () => {
    const f = await fixture(language!)
    let revisions: number[] = []
    f.setConfirm(async () => {
      const current = await f.store.read()
      const saved = await f.store.saveArtifact(current.revision, {
        kind: "stage-summary",
        stage: "design",
        language: "en",
        summary: "Concurrent draft",
        outputs: [],
        suggestion: "Review again",
      })
      revisions = [current.revision, saved.state.revision]
      return true
    })
    await f.command.run("skip design", f.ctx)
    const error = f.output.findLast((line) => line.level === "error")!.text
    expect(error).toContain(native!)
    expect(error).toContain(instruction!)
    for (const revision of revisions) expect(error).toContain(String(revision))
    if (language !== "en") expect(error).not.toContain("Stale iteration writer")
    expect((await f.store.read()).receipts).toEqual([])
  })
}

for (const resumed of [false, true]) {
  for (const [language, native] of [
    ["zh-CN", "兼容"],
    ["ja", "互換"],
  ]) {
    test(`${language}: storage failure uses a fresh marker after ${resumed ? "resume" : "external settings change"} without panel refresh`, async () => {
      const f = await fixture("en")
      await writeFile(
        path.join(f.project.root, ".amira/project.json"),
        JSON.stringify({ ...f.project.marker, settings: { ...f.project.marker.settings, language } }),
      )
      const file = path.join(f.project.root, ".amira/project/iterations/1/.state/0000000000000000.json")
      const future = JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), schemaVersion: 99 })
      await writeFile(file, future)
      const command = resumed ? await f.restart() : f.command
      await command.run("status", f.ctx)
      const error = f.output.findLast((line) => line.level === "error")!.text
      expect(error).toContain(native!)
      expect(error).toContain("99")
      expect(error).not.toContain("Unsupported iteration journal")
      expect(await readFile(file, "utf8")).toBe(future)
    })
  }
}

test("a fresh project conversation sentinel wins for storage errors before any panel refresh", async () => {
  const f = await fixture("en", [{ role: "user", content: [{ type: "text", text: "请帮我设计项目" }] }])
  await writeFile(
    path.join(f.project.root, ".amira/project.json"),
    JSON.stringify({
      ...f.project.marker,
      settings: { ...f.project.marker.settings, language: "conversation" },
    }),
  )
  const file = path.join(f.project.root, ".amira/project/iterations/1/.state/0000000000000000.json")
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), schemaVersion: 99 }))
  await f.command.run("status", f.ctx)
  expect(f.output.findLast((line) => line.level === "error")!.text).toContain("兼容")
})

for (const [language, usage, required] of [
  ["en", "Use /project", "requires Amira API"],
  ["zh-CN", "用法", "需要 Amira API"],
  ["ja", "使用方法", "必要"],
]) {
  test(`${language}: command argument and unavailable-host errors use the resolved language`, async () => {
    const f = await fixture(language!)
    for (const command of ["skip invalid", "revisit implement", "next extra"]) {
      await f.command.run(command, f.ctx)
      expect(f.output.findLast((line) => line.level === "error")!.text).toContain(usage!)
    }
    await f.command.run("design", f.ctx)
    expect(f.output.findLast((line) => line.level === "error")!.text).toContain(required!)
  })
}

test("unsupported journal schemas report encountered/supported versions, not corruption, and preserve bytes", async () => {
  const project = await createProject(await temp(), "Future schema")
  const store = new IterationStore(project)
  await store.read()
  const file = path.join(project.root, ".amira/project/iterations/1/.state/0000000000000000.json")
  const original = JSON.parse(await readFile(file, "utf8"))
  const future = `${JSON.stringify({ ...original, schemaVersion: 99 }, null, 2)}\n`
  await writeFile(file, future)
  let error: unknown
  try {
    await store.read()
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({
    name: "ProjectStorageError",
    details: { reason: "unsupported-schema", document: "iteration journal", encountered: 99, supported: 1 },
  })
  expect((error as Error).message).toContain("99")
  expect((error as Error).message).toContain("compatible")
  expect((error as Error).message).not.toContain("corrupt")
  expect(await readFile(file, "utf8")).toBe(future)
})

for (const [language, native] of [
  ["zh-CN", "项目操作无法完成"],
  ["ja", "操作を完了できません"],
]) {
  test(`${language}: unexpected dialog/host failures never leak English-only diagnostics`, async () => {
    const f = await fixture(language!)
    f.setConfirm(async () => {
      throw new Error("Injected native callback failure")
    })
    await f.command.run("skip design", f.ctx)
    const error = f.output.findLast((line) => line.level === "error")!.text
    expect(error).toContain(native!)
    expect(error).not.toContain("Injected native callback failure")
    expect((await f.store.read()).receipts).toEqual([])
  })
}

for (const [label, edit, reason] of [
  [
    "non-numeric version",
    (value: Record<string, unknown>) => ({ ...value, schemaVersion: "future" }),
    "malformed-storage",
  ],
  [
    "broken previous hash",
    (value: Record<string, unknown>) => ({ ...value, previousHash: "a".repeat(64) }),
    "hash-mismatch",
  ],
] as const) {
  test(`${label} is diagnosed separately from an unsupported numeric schema`, async () => {
    const project = await createProject(await temp(), "Diagnostic types")
    const store = new IterationStore(project)
    await store.read()
    const file = path.join(project.root, ".amira/project/iterations/1/.state/0000000000000000.json")
    const changed = JSON.stringify(edit(JSON.parse(await readFile(file, "utf8"))))
    await writeFile(file, changed)
    let error: unknown
    try {
      await store.read()
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ details: { reason, document: "iteration journal" } })
    expect(await readFile(file, "utf8")).toBe(changed)
  })
}

for (const [human, native] of [
  ["请帮我设计项目", "版本"],
  ["このプロジェクトを設計してください", "リビジョン"],
]) {
  test(`project conversation sentinel localizes errors from the human turn: ${native}`, async () => {
    const f = await fixture("conversation", [{ role: "user", content: [{ type: "text", text: human! }] }])
    f.setConfirm(async () => {
      const current = await f.store.read()
      await f.store.saveArtifact(current.revision, {
        kind: "stage-summary",
        stage: "design",
        language: "en",
        summary: "Changed",
        outputs: [],
        suggestion: "Review",
      })
      return true
    })
    await f.command.run("skip design", f.ctx)
    expect(f.output.findLast((line) => line.level === "error")!.text).toContain(native!)
  })
}

for (const [language, native] of [
  ["zh-CN", "兼容"],
  ["ja", "互換"],
]) {
  test(`${language}: unsupported schema command diagnostics survive attachment error handling`, async () => {
    const f = await fixture(language!)
    const file = path.join(f.project.root, ".amira/project/iterations/1/.state/0000000000000000.json")
    const original = JSON.parse(await readFile(file, "utf8"))
    const future = JSON.stringify({ ...original, schemaVersion: 99 })
    await writeFile(file, future)
    await f.command.run("status", f.ctx)
    const error = f.output.findLast((line) => line.level === "error")!.text
    expect(error).toContain(native!)
    expect(error).toContain("99")
    expect(error).toContain("1")
    expect(error).not.toContain("hash chain is corrupt")
    expect(await readFile(file, "utf8")).toBe(future)
  })
}
