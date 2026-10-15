import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  appendSuggestion,
  createProject,
  DecisionStore,
  Registry,
  readDocument,
  saveResearchNote,
  writeDocument,
} from "../src/store.ts"

const roots: string[] = []
const restores: (() => void)[] = []
afterEach(async () => {
  for (const restore of restores.splice(0)) restore()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "amira-storage-regression-"))
  roots.push(root)
  return root
}
const questions = [{ question: "Choose storage", options: [{ label: "Local" }, { label: "Remote" }] }]
const answers = [{ selected: ["Local"] }]
const meta = { sessionId: "human", askId: "one", language: "en" }
const location = (root: string, name: string) => path.join(root, ".amira", "project", name)
const junction = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")

// Observe the real staged-file close after fsync, not a stale-read unit seam. The filesystem remains real.
function afterStage(name: string, action: () => Promise<void>) {
  const original = fs.open
  let fired = false
  const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (!fired && String(args[0]).includes(`.${name}.`) && String(args[0]).endsWith(".tmp")) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        if (!fired) {
          fired = true
          await action()
        }
      }
    }
    return handle
  })
  restores.push(() => mock.mockRestore())
  return () => fired
}

test("abort while queued publishes no second authoritative evidence", async () => {
  const project = await createProject(await temp(), "Abort")
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = new DecisionStore(project, {
    afterEvidenceSync: async () => {
      entered()
      await gate
    },
  }).record(questions, answers, meta)
  await ready
  const controller = new AbortController()
  const second = new DecisionStore(project).record(
    questions,
    answers,
    { ...meta, askId: "two" },
    { signal: controller.signal },
  )
  const verdict = second.then(
    () => false,
    () => true,
  )
  controller.abort()
  release()
  await first
  expect(await verdict).toBe(true)
  expect((await new DecisionStore(project).records()).map((record) => record.askId)).toEqual(["one"])
})

test("abort at staged evidence fsync rejects without publishing evidence", async () => {
  const project = await createProject(await temp(), "Abort publication")
  const controller = new AbortController()
  const fired = afterStage("decisions.evidence.jsonl", async () => controller.abort())
  await expect(
    new DecisionStore(project).record(questions, answers, meta, { signal: controller.signal }),
  ).rejects.toThrow()
  expect(fired()).toBe(true)
  expect(await new DecisionStore(project).records()).toEqual([])
})

for (const boundary of ["root", "ancestor"] as const) {
  test(`captured ${boundary} junction replacement with identical marker is rejected`, async () => {
    const parent = await temp()
    const ancestor = path.join(parent, "ancestor")
    const root = path.join(ancestor, "project")
    await fs.mkdir(root, { recursive: true })
    const project = await createProject(root, "Pinned")
    const external = await temp()
    const replaced = boundary === "root" ? root : ancestor
    const copied = boundary === "root" ? external : path.join(external, "project")
    await fs.cp(root, copied, { recursive: true })
    await fs.rename(replaced, `${replaced}-old`)
    await junction(external, replaced)
    await expect(saveResearchNote(project, "Escape", "escaped")).rejects.toThrow()
    expect(await fs.readdir(location(copied, "research"))).toEqual([])
  })
}

for (const boundary of ["root", "ancestor", "output"] as const) {
  test(`publication rechecks ${boundary} junction after real staged file write`, async () => {
    const parent = await temp()
    const ancestor = path.join(parent, "ancestor")
    const root = path.join(ancestor, "project")
    await fs.mkdir(root, { recursive: true })
    const project = await createProject(root, "Publication")
    const external = await temp()
    const replaced = boundary === "ancestor" ? ancestor : boundary === "root" ? root : location(root, "")
    const fired = afterStage("design.md", async () => {
      await fs.cp(replaced, external, { recursive: true })
      await fs.rename(replaced, `${replaced}-old`)
      await junction(external, replaced)
    })
    await expect(writeDocument(project, "design.md", "escaped at publication")).rejects.toThrow()
    expect(fired()).toBe(true)
    const copiedRoot = boundary === "ancestor" ? path.join(external, "project") : external
    const copiedFile =
      boundary === "output" ? path.join(external, "design.md") : location(copiedRoot, "design.md")
    expect(await fs.readFile(copiedFile, "utf8")).toBe("")
  })
}

test("human edit during actual Markdown staging survives and generated output goes to a sibling", async () => {
  const project = await createProject(await temp(), "Concurrent human")
  await new DecisionStore(project).record(questions, answers, meta)
  const original = await fs.readFile(location(project.root, "decisions.md"), "utf8")
  const human = `${original}\nHuman annotation written while generation is staged.\n`
  const fired = afterStage("decisions.md", async () => {
    await fs.writeFile(location(project.root, "decisions.md"), human)
  })
  await new DecisionStore(project).record(questions, answers, { ...meta, askId: "two" })
  expect(fired()).toBe(true)
  expect(await fs.readFile(location(project.root, "decisions.md"), "utf8")).toBe(human)
  expect(await fs.readFile(location(project.root, "decisions.generated.md"), "utf8")).toContain("## D2:")
})

test("an editor's pathname save immediately before link publication wins without clobber", async () => {
  const project = await createProject(await temp(), "No clobber")
  await new DecisionStore(project).record(questions, answers, meta)
  const file = location(project.root, "decisions.md")
  const originalLink = fs.link
  let fired = false
  const mock = spyOn(fs, "link").mockImplementation(async (...args: Parameters<typeof fs.link>) => {
    if (!fired && String(args[1]) === file && String(args[0]).endsWith(".tmp")) {
      fired = true
      // The old inode has already been retained and compared. A new save must NOT be renamed over.
      await fs.writeFile(file, "Human's last-moment editor save.\n", { flag: "wx" })
    }
    return originalLink(...args)
  })
  restores.push(() => mock.mockRestore())
  await new DecisionStore(project).record(questions, answers, { ...meta, askId: "two" })
  expect(fired).toBe(true)
  expect(await fs.readFile(file, "utf8")).toBe("Human's last-moment editor save.\n")
  expect(await fs.readFile(location(project.root, "decisions.generated.md"), "utf8")).toContain("## D2:")
})

test("a held writable editor fd keeps its inode in a retained version after publication", async () => {
  const project = await createProject(await temp(), "Retained editor inode")
  await new DecisionStore(project).record(questions, answers, meta)
  const handle = await fs.open(location(project.root, "decisions.md"), "a")
  try {
    await new DecisionStore(project).record(questions, answers, { ...meta, askId: "two" })
    await handle.writeFile("Late edit through the old writable descriptor.\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  const versions = (await fs.readdir(location(project.root, ""))).filter((name) =>
    name.endsWith(".preserved"),
  )
  const contents = await Promise.all(
    versions.map((name) => fs.readFile(location(project.root, name), "utf8")),
  )
  expect(contents.some((content) => content.includes("Late edit through the old writable descriptor."))).toBe(
    true,
  )
  expect(await readDocument(project, "decisions.md")).toContain("## D2:")
})

test("unsupported hardlinks reject before moving the original Markdown pathname", async () => {
  const project = await createProject(await temp(), "No hardlinks")
  await fs.writeFile(location(project.root, "design.md"), "Existing human document.\n")
  const mock = spyOn(fs, "link").mockImplementation(async () => {
    throw Object.assign(new Error("Filesystem does not support hardlinks"), { code: "EOPNOTSUPP" })
  })
  restores.push(() => mock.mockRestore())
  await expect(writeDocument(project, "design.md", "Generated replacement")).rejects.toThrow("hardlinks")
  expect(await readDocument(project, "design.md")).toBe("Existing human document.\n")
})

test("ordinary replacement of the freshly created research directory is rejected on first use", async () => {
  const project = await createProject(await temp(), "Pinned research")
  const research = location(project.root, "research")
  await fs.rename(research, `${research}-old`)
  await fs.mkdir(research)
  await expect(saveResearchNote(project, "Late result", "must not be written")).rejects.toThrow("replaced")
  expect(await fs.readdir(research)).toEqual([])
})

test("pre-aborted calls create no evidence; abort after evidence commit still returns the answer", async () => {
  const project = await createProject(await temp(), "Commit boundary")
  const before = new AbortController()
  before.abort()
  await expect(
    new DecisionStore(project).record(questions, answers, meta, { signal: before.signal }),
  ).rejects.toThrow()
  expect(await new DecisionStore(project).records()).toEqual([])
  const after = new AbortController()
  const store = new DecisionStore(project, { afterEvidenceSync: () => after.abort() })
  const committed = await store.record(questions, answers, meta, { signal: after.signal })
  expect(committed.map((record) => record.askId)).toEqual(["one"])
  expect(await store.records()).toEqual(committed)
})

test("owner receipt returns committed evidence without waiting for deferred Markdown and reports its result", async () => {
  const project = await createProject(await temp(), "Deferred projection")
  const staged = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const projected = Promise.withResolvers<{ conflict: boolean; path: string }>()
  const fired = afterStage("decisions.md", async () => {
    staged.resolve()
    await release.promise
  })
  const controller = new AbortController()
  const recorded = await new DecisionStore(project).record(questions, answers, meta, {
    signal: controller.signal,
    onProjection: projected.resolve,
    onProjectionError: projected.reject,
  })
  expect(recorded.map((record) => record.id)).toEqual(["D1"])
  expect(await new DecisionStore(project).records()).toEqual(recorded)
  try {
    await staged.promise
    expect(fired()).toBe(true)
    controller.abort()
  } finally {
    release.resolve()
  }
  expect(await projected.promise).toEqual({ conflict: false, path: location(project.root, "decisions.md") })
  expect(await readDocument(project, "decisions.md")).toContain("## D1:")
  expect(await fs.readFile(location(project.root, "decisions.evidence.jsonl"), "utf8")).not.toContain(
    "signal",
  )
})

test("direct recording follows host answer cardinality and never treats Other as rationale", async () => {
  const project = await createProject(await temp(), "Answer parity")
  const store = new DecisionStore(project)
  await expect(
    store.record(questions, [{ selected: ["Local"], other: "Different choice" }], meta),
  ).rejects.toThrow()
  const multi = [{ ...questions[0]!, multiSelect: true }]
  const empty = await store.record(multi, [{ selected: [] }], meta)
  expect(empty[0]!.rationale).toBeUndefined()
  expect(await readDocument(project, "decisions.md")).toContain("Human choice: None selected")
  const other = await store.record(questions, [{ selected: [], other: "Exact third choice" }], {
    ...meta,
    askId: "two",
  })
  expect(other[0]!.answer.other).toBe("Exact third choice")
  expect(other[0]!.rationale).toBeUndefined()
  await expect(
    store.record(questions, answers, { ...meta, askId: "three", model: "invented" } as typeof meta),
  ).rejects.toThrow()
})

test("ledger scaffolding and suggestions localize EN/ZH/JA while older records retain their language", async () => {
  const project = await createProject(await temp(), "Languages")
  const store = new DecisionStore(project)
  await store.record(questions, answers, meta)
  await store.record(questions, answers, { ...meta, askId: "two", language: "zh-CN", supersedes: ["D1"] })
  await store.record(questions, [{ selected: [], other: "ユーザーの自由入力" }], {
    ...meta,
    askId: "three",
    language: "ja-JP",
    supersedes: ["D2"],
  })
  const markdown = await readDocument(project, "decisions.md")
  expect(markdown).toContain("Human choice: Local")
  expect(markdown).toContain("Superseded by: D2")
  expect(markdown).toContain("用户选择: Local")
  expect(markdown).toContain("被取代: D3")
  expect(markdown).toContain("ユーザーの選択: その他")
  expect(markdown).toContain("その他（ユーザーの原文）: ユーザーの自由入力")
  expect(markdown).toContain("証拠（ユーザーの回答）")
  expect(markdown).toContain("置き換える決定: D2")
  expect((await store.records())[2]!.rationale).toBeUndefined()
  await appendSuggestion(project, "まだ決定していません。", "ja-JP")
  expect(await readDocument(project, "suggestions.md")).toContain("未確定の提案")
})

test("legacy records retain their original rendering and hash chain without widening new answer validation", async () => {
  const project = await createProject(await temp(), "Legacy evidence")
  const answer = { selected: ["Local"], other: "Historic Other text" }
  const legacyMeta = { ...meta, language: "ja", supersedes: [] }
  const record = {
    id: "D1",
    question: questions[0],
    answer,
    date: "2026-10-14T00:00:00.000Z",
    language: "ja",
    sessionId: meta.sessionId,
    askId: meta.askId,
    provenance: "human",
    rationale: answer.other,
    supersedes: [],
    supersededBy: [],
  }
  const evidence = `${JSON.stringify({
    schemaVersion: 1,
    meta: legacyMeta,
    questions,
    answers: [answer],
    records: [record],
    priorGeneratedHash: createHash("sha256").update("").digest("hex"),
  })}\n`
  await fs.writeFile(location(project.root, "decisions.evidence.jsonl"), evidence)
  const store = new DecisionStore(project)
  await store.recover()
  // The old writer used English scaffolding for Japanese and treated Other as rationale.
  // Keep that immutable historical rendering so a new locale implementation cannot break its chain.
  expect(await readDocument(project, "decisions.md")).toContain("Human choice: Local")
  await store.record(questions, answers, { ...meta, askId: "two", language: "ja" })
  const markdown = await readDocument(project, "decisions.md")
  expect(markdown).toContain("Human choice: Local")
  expect(markdown).toContain("ユーザーの選択: Local")
  expect(
    (await fs.readFile(location(project.root, "decisions.evidence.jsonl"), "utf8")).startsWith(evidence),
  ).toBe(true)
  expect((await new DecisionStore(project).records())[1]!.rationale).toBeUndefined()
  await expect(store.record(questions, [answer], { ...meta, askId: "three" })).rejects.toThrow()
})

test("gitignore preserves arbitrary existing bytes and CRLF while appending its canonical rule", async () => {
  const root = await temp()
  const original = Buffer.concat([
    Buffer.from("# existing "),
    Buffer.from([255]),
    Buffer.from("\r\n!.amira/project/"),
  ])
  await fs.writeFile(path.join(root, ".gitignore"), original)
  await createProject(root, "Ignore bytes")
  expect(await fs.readFile(path.join(root, ".gitignore"))).toEqual(
    Buffer.concat([original, Buffer.from("\r\n.amira/project/\r\n")]),
  )
})

test("eight separate registry processes behind a barrier retain all entries", async () => {
  const root = await temp()
  const data = path.join(root, "registry")
  const barrier = path.join(root, "barrier")
  await fs.mkdir(barrier)
  await fs.mkdir(data)
  await fs.writeFile(path.join(data, "registry.json"), "[]\n")
  const projects = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const directory = path.join(root, `project-${index}`)
      await fs.mkdir(directory)
      return createProject(directory, `Project ${index}`)
    }),
  )
  const worker = fileURLToPath(new URL("./storage-registry-worker.ts", import.meta.url))
  const children = projects.map((project, index) =>
    Bun.spawn([process.execPath, worker, data, project.root, barrier, String(index)], {
      cwd: root,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  try {
    for (let attempt = 0; (await fs.readdir(barrier)).length !== 8; attempt++) {
      if (attempt > 1000) throw new Error("registry worker barrier timeout")
      await Bun.sleep(10)
    }
    await fs.writeFile(path.join(barrier, "go"), "")
    const codes = await Promise.all(children.map((child) => child.exited))
    const entries = await new Registry(data).list()
    console.log(
      `registry barrier: ${codes.filter((code) => code === 0).length}/8 processes succeeded; ${entries.length}/8 entries retained`,
    )
    expect(entries.map((entry) => entry.id).sort()).toEqual(
      projects.map((project) => project.marker.id).sort(),
    )
    expect(codes).toEqual(Array(8).fill(0))
  } finally {
    for (const child of children) child.kill()
  }
}, 20000)

for (const prior of [
  ".amira/project/\n!.amira/project/\n",
  " .amira/project/\n",
  "/.amira/project/\n!.amira/project/\n",
]) {
  test(`gitignore effective final rule overrides ${JSON.stringify(prior)}`, async () => {
    const root = await temp()
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
      const text = await new Response(child.stdout).text()
      return { code: await child.exited, text }
    }
    expect((await git("init", "--quiet")).code).toBe(0)
    await fs.writeFile(path.join(root, ".gitignore"), prior)
    await createProject(root, "Ignored")
    const ignored = await git("check-ignore", "--no-index", ".amira/project/design.md")
    expect(ignored.code).toBe(0)
    expect(ignored.text.trim()).toBe(".amira/project/design.md")
    expect((await fs.readFile(path.join(root, ".gitignore"), "utf8")).startsWith(prior)).toBe(true)
  })
}
