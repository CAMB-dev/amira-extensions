import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  PanelDefinition,
  SessionControl,
  SessionData,
} from "@amira/api"
import { createProjectExtension, restoreAttachment } from "../src/index.ts"
import { createProject, IterationStore, readProject, writeDocument } from "../src/store.ts"

// These are durable filesystem/command tests, not latency benchmarks. Full Windows
// repeated-revisit cases can outlive 60s while flushing journals; keep the stale-approval assertions intact.
setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(language = "en") {
  const root = await mkdtemp(path.join(tmpdir(), "project-stage-commands-"))
  roots.push(root)
  const cwd = path.join(root, "work")
  await mkdir(cwd)
  const values = new Map<string, unknown[]>()
  const data: SessionData = {
    append: (key, value) => {
      values.set(key, [...(values.get(key) ?? []), structuredClone(value)])
    },
    read: (key) => structuredClone(values.get(key) ?? []),
  }
  let id = "main"
  const session = {
    info: () => ({ id, cwd, file: path.join(root, "session.jsonl"), busy: false }),
    data,
    messages: () => [],
  } as unknown as SessionControl
  let command!: CommandDefinition
  let panel!: PanelDefinition
  const output: string[] = []
  const errors: string[] = []
  const dialogs: string[] = []
  let pick: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined
  let confirm: (title: string, body?: string) => Promise<boolean | undefined> = async () => undefined
  const api = {
    cwd,
    dataDir: path.join(root, "extension-data"),
    session: () => session,
    settings: { declare: () => ({ get: () => ({ language }), onChange: () => () => {} }) },
    registerCommand: (c: CommandDefinition) => {
      command = c
    },
    registerPanel: (p: PanelDefinition) => {
      panel = p
    },
    on: () => () => {},
    requestRender() {},
    notify() {},
  } as unknown as ExtensionAPI
  const ctx = {
    cwd,
    signal: new AbortController().signal,
    frontend: "tui",
    session,
    ui: {
      input: async () => undefined,
      select: async (title: string, options: string[]) => {
        dialogs.push(title)
        return pick(title, options)
      },
      confirm: async (title: string, body?: string) => {
        dialogs.push(title)
        return confirm(title, body)
      },
    },
    print: (text: string, level?: string) => {
      output.push(text)
      if (level === "error") errors.push(text)
    },
  } as unknown as CommandContext
  await createProjectExtension()(api)
  await command.run(`new Demo --language ${language}`, ctx)
  const project = await readProject(cwd)
  const store = new IterationStore(project)
  return {
    ctx,
    project,
    store,
    command,
    panel,
    data,
    output,
    errors,
    dialogs,
    pick: (fn: typeof pick) => {
      pick = fn
    },
    confirm: (fn: typeof confirm) => {
      confirm = fn
    },
    switchMain: () => {
      id = "replacement"
    },
    panelText: () =>
      panel
        .render({ sessionId: id, data, width: 80, now: 0, collapsed: false })
        .map((l) => l.text)
        .join("\n"),
  }
}

describe("main-session stage commands", () => {
  test("empty design offers an explicit skip but never fabricates finished work", async () => {
    const f = await fixture()
    await f.command.run("next", f.ctx)
    const state = await f.store.read()
    expect(state.stage).toBe("design")
    expect(state.attempts).toEqual([])
    expect(state.receipts).toEqual([])
    expect(f.output.join("\n")).toContain("No design summary is ready")
    expect(f.errors).toEqual([])
  })
  test("human skip is durable and prototype variants are offered without starting work", async () => {
    const f = await fixture()
    f.confirm(async () => true)
    await f.command.run("skip design", f.ctx)
    const state = await f.store.read()
    expect(f.errors).toEqual([])
    expect(state.stage).toBe("prototype")
    expect(state.status).toBe("idle")
    expect(state.skips.map((s) => s.stage)).toEqual(["design"])
    expect(state.attempts).toEqual([])
    expect(state.receipts[0]?.revision).toBe(state.revision - 1)
    expect(f.panelText()).toContain("prototype · idle")
    await f.command.run("next", f.ctx)
    expect(f.output.at(-1)).toContain("/project prototype")
    expect((await f.store.read()).revision).toBe(state.revision)
    await f.command.run("status", f.ctx)
    expect(f.output.at(-1)).toContain("Pending approval: none")
    expect(f.output.at(-1)).toContain("Manual trial: not requested")
  })
  for (const started of [false, true]) {
    test(`persisted declined prototype skip continues ${started ? "started" : "unstarted"} work at a usable boundary`, async () => {
      const f = await fixture()
      f.confirm(async () => true)
      await f.command.run("skip design", f.ctx)
      let state = await f.store.read()
      const directory = await f.store.preparePrototypeDirectory("alpha")
      const file = path.join(directory, "demo.ts")
      await writeFile(file, "// preserved prototype work\n")
      const saved = await f.store.saveArtifact(state.revision, {
        kind: "prototype-manifest",
        variants: [
          {
            id: "alpha",
            idea: "Compact view",
            question: "Is this easier to scan?",
            directory,
            cwd: directory,
            runCommand: "bun run demo.ts",
            prerequisites: [],
            notes: "Offline fixture; never executed",
            status: "ready",
          },
        ],
      })
      state = saved.state
      if (started)
        state = await f.store.dispatch(state.revision, {
          type: "start-work",
          expectedRevision: state.revision,
          attemptId: "abandoned-prototype-attempt",
        })
      f.confirm(async () => false)
      await f.command.run("skip prototype", f.ctx)
      const declined = await new IterationStore(f.project).read()
      expect(declined.pending?.kind).toBe("skip")
      expect(declined.receipts).toEqual(state.receipts)
      if (started)
        expect(declined.attempts.at(-1)).toMatchObject({
          id: "abandoned-prototype-attempt",
          status: "interrupted",
        })
      f.pick(async (_title, options) => options.find((option) => option === "Continue current stage"))
      await f.command.run("next", f.ctx)
      const reopened = new IterationStore(f.project)
      state = await reopened.read()
      expect(f.errors).toEqual([])
      expect(state).toMatchObject({ stage: "prototype", phase: "confirmed", status: "idle" })
      expect(state.pending).toBeUndefined()
      expect(state.summaryId).toBeUndefined()
      expect(state.activeAttemptId).toBeUndefined()
      expect(state.attempts).toEqual(declined.attempts)
      expect(state.artifacts).toEqual(declined.artifacts)
      expect(state.receipts).toEqual(declined.receipts)
      expect(state.skips.map((entry) => entry.stage)).toEqual(["design"])
      expect(await readFile(file, "utf8")).toBe("// preserved prototype work\n")
      // Both reopening and choosing use this separately started reducer/store boundary.
      state = await reopened.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId: "fresh-prototype-attempt",
      })
      const chosen = await reopened.recordPrototypeChoice(
        state.revision,
        saved.artifact,
        {
          question: "Which prototype?",
          options: [
            { label: "alpha", description: "Compact view" },
            { label: "none", description: "Keep findings only" },
          ],
        },
        { selected: ["alpha"] },
        { sessionId: "main", askId: "resumed-choice", language: "en", reason: "Easier to scan" },
        "alpha",
      )
      const usable = await new IterationStore(f.project).read()
      expect(usable.prototypeChoice?.decisionId).toBe(chosen.records[0]!.id)
      expect(usable.attempts.slice(0, -1)).toEqual(declined.attempts)
      expect(usable.attempts.at(-1)?.status).toBe("working")
      expect(await readFile(file, "utf8")).toBe("// preserved prototype work\n")
    }, 60_000)
  }
  test("saved design produces summary then proposal then human receipt, not an executor", async () => {
    const f = await fixture()
    await writeDocument(f.project, "design.md", "# Design\nUse local storage.\n")
    f.confirm(async () => true)
    f.pick(async (_title, options) => options[0])
    await f.command.run("next", f.ctx)
    expect(f.errors).toEqual([])
    const state = await f.store.read()
    expect(state.stage).toBe("prototype")
    expect(state.attempts.map((a) => a.stage)).toEqual(["design"])
    expect(state.attempts[0]?.status).toBe("finished")
    expect(state.artifacts.some((a) => a.kind === "stage-summary")).toBe(true)
    expect(state.receipts).toHaveLength(1)
    expect(f.output.join("\n")).toContain("Use local storage")
    expect(f.output.at(-1)).toContain("/project prototype")
    expect(f.dialogs).toEqual(["Prepare the design summary?", "Choose the next step", "Confirm stage change"])
  })
  test("dismissed approval leaves a pending proposal but no receipt", async () => {
    const f = await fixture()
    await f.command.run("skip design", f.ctx)
    expect(f.errors).toEqual([])
    const state = await f.store.read()
    expect(state.stage).toBe("design")
    expect(state.pending?.kind).toBe("skip")
    expect(state.receipts).toEqual([])
    expect(f.panelText()).toContain("awaiting confirmation")
    await f.command.run("status", f.ctx)
    expect(f.output.at(-1)).toContain(state.pending!.id)
  })
  test("a state revision change while human confirmation is open rejects the stale approval", async () => {
    const f = await fixture()
    f.confirm(async () => {
      const current = await f.store.read()
      await f.store.saveArtifact(current.revision, {
        kind: "stage-summary",
        stage: "design",
        language: "en",
        summary: "Changed while open",
        outputs: [],
        suggestion: "Review again",
      })
      return true
    })
    await f.command.run("skip design", f.ctx)
    expect(f.errors.join("\n")).toMatch(/stale.*revision/i)
    expect((await f.store.read()).stage).toBe("design")
    expect((await f.store.read()).receipts).toEqual([])
  })
  test("main replacement during a dialog cannot record confirmation", async () => {
    const f = await fixture()
    f.confirm(async () => {
      f.switchMain()
      return true
    })
    await f.command.run("skip design", f.ctx)
    expect(f.errors.join("\n")).toContain("Main session changed")
    expect((await f.store.read()).receipts).toEqual([])
    expect(restoreAttachment(f.data)?.projectId).toBe(f.project.marker.id)
  })
  test("attachment change during approval cannot approve or overwrite the replacement project's panel", async () => {
    const f = await fixture()
    const other = path.join(path.dirname(f.project.root), "other")
    await mkdir(other)
    const replacement = await createProject(other, "Replacement", { language: "en" })
    f.confirm(async () => {
      await f.command.run(`switch "${replacement.root}"`, f.ctx)
      return true
    })
    await f.command.run("skip design", f.ctx)
    expect(f.errors.at(-1)).toContain("Attached project changed")
    expect((await f.store.read()).receipts).toEqual([])
    expect(f.panelText()).toContain("Project Replacement")
    expect(restoreAttachment(f.data)?.projectId).toBe(replacement.marker.id)
  })
  test("focused conversation command contexts are guarded", async () => {
    const f = await fixture()
    const focused = {
      ...f.ctx,
      session: { info: () => ({ id: "owned-design" }) },
    } as unknown as CommandContext
    await f.command.run("skip design", focused)
    expect(f.errors.at(-1)).toContain("main conversation only")
    expect((await f.store.read()).revision).toBe(0)
  })
  test("declined proposal can be cancelled to continue design and rebuild its summary", async () => {
    const f = await fixture()
    await writeDocument(f.project, "design.md", "Original design")
    f.confirm(async (title) => title === "Prepare the design summary?")
    f.pick(async (_title, options) => options[0])
    await f.command.run("next", f.ctx)
    expect((await f.store.read()).pending).toBeDefined()
    f.pick(async (_title, options) => options.find((option) => option === "Continue current stage"))
    await f.command.run("next", f.ctx)
    const reopened = await f.store.read()
    expect(reopened.phase).toBe("ready")
    expect(reopened.summaryId).toBeUndefined()
    expect(reopened.pending).toBeUndefined()
    await writeDocument(f.project, "design.md", "Revised design")
    f.confirm(async () => true)
    f.pick(async (_title, options) => options[0])
    await f.command.run("next", f.ctx)
    expect(f.errors).toEqual([])
    expect(f.output.join("\n")).toContain("Revised design")
    expect((await f.store.read()).stage).toBe("prototype")
  })
  test("reopening running design is inert and explicit next recovers without replaying the old attempt", async () => {
    const f = await fixture()
    await writeDocument(f.project, "design.md", "Saved work before crash")
    await f.store.dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "before-crash" })
    expect((await new IterationStore(f.project).read()).status).toBe("working")
    f.confirm(async () => true)
    f.pick(async (_title, options) => options[0])
    await f.command.run("next", f.ctx)
    const state = await f.store.read()
    expect(f.errors).toEqual([])
    expect(state.attempts.find((attempt) => attempt.id === "before-crash")?.status).toBe("interrupted")
    expect(state.attempts).toHaveLength(2)
    expect(state.stage).toBe("prototype")
  })
  test("an idle prototype can revisit design without inventing a prototype choice", async () => {
    const f = await fixture()
    f.confirm(async () => true)
    await f.command.run("skip design", f.ctx)
    f.pick(async (_title, options) => options[0])
    await f.command.run("revisit design", f.ctx)
    const state = await f.store.read()
    expect(f.errors).toEqual([])
    expect(state.stage).toBe("design")
    expect(state.prototypeChoice).toBeUndefined()
    expect(state.transitions.at(-1)?.kind).toBe("revisit")
    await writeDocument(f.project, "design.md", "Revised design after revisit")
    await f.command.run("next", f.ctx)
    const advanced = await f.store.read()
    expect(f.errors).toEqual([])
    expect(advanced.stage).toBe("prototype")
    expect(advanced.transitions.at(-1)?.kind).toBe("advance")
    expect(advanced.transitions.filter((transition) => transition.kind === "revisit")).toHaveLength(1)
  })
  test("two successive prototype-design-prototype revisits preserve receipts and attempts", async () => {
    const f = await fixture()
    f.confirm(async () => true)
    f.pick(async (_title, options) => options[0])
    await f.command.run("skip design", f.ctx)
    for (let visit = 1; visit <= 2; visit++) {
      await f.command.run("revisit design", f.ctx)
      expect((await f.store.read()).stage).toBe("design")
      await writeDocument(f.project, "design.md", `Revision from revisit ${visit}`)
      await f.command.run("next", f.ctx)
      const returned = await new IterationStore(f.project).read()
      expect(returned.stage).toBe("prototype")
      expect(returned.revisit).toBeUndefined()
      expect(returned.revisitHistory).toHaveLength(visit)
      expect(returned.transitions.filter((transition) => transition.kind === "revisit")).toHaveLength(visit)
      expect(returned.attempts).toHaveLength(visit)
    }
    expect(f.errors).toEqual([])
  }, 60_000)
  test("declined revisit can be durably cancelled, continued, and requested again", async () => {
    const f = await fixture()
    f.confirm(async () => true)
    await f.command.run("skip design", f.ctx)
    f.pick(async (_title, options) => options[0])
    f.confirm(async () => false)
    await f.command.run("revisit design", f.ctx)
    const declined = await f.store.read()
    expect(declined.pending?.kind).toBe("revisit")
    f.pick(async (_title, options) => options.find((option) => option === "Continue current stage"))
    await f.command.run("next", f.ctx)
    const continued = await new IterationStore(f.project).read()
    expect(continued.revisit).toBeUndefined()
    expect(continued.receipts.at(-1)?.choice).toBe("cancel-revisit")
    await f.command.run("next", f.ctx)
    expect((await f.store.read()).pending).toBeUndefined()
    f.pick(async (_title, options) => options[0])
    f.confirm(async () => true)
    await f.command.run("revisit design", f.ctx)
    expect(f.errors).toEqual([])
    expect((await f.store.read()).stage).toBe("design")
  })
  test("crash after revisit summary reconstructs the proposal without duplicating summary", async () => {
    const f = await fixture()
    f.confirm(async () => true)
    await f.command.run("skip design", f.ctx)
    let state = await f.store.read()
    state = await f.store.dispatch(state.revision, {
      type: "request-revisit",
      expectedRevision: state.revision,
      target: "design",
      policy: "interrupt",
      changes: [],
      receipt: {
        id: "crash-request",
        provenance: "human",
        projectId: state.projectId,
        iteration: state.iteration,
        revision: state.revision,
        subjectId: "revisit:prototype",
        choice: "design",
        reason: "Explicit offline human fixture",
      },
    })
    const saved = await f.store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "prototype",
      language: "en",
      outputs: [],
      summary: "Preserved revisit request",
      suggestion: "Return to design",
    })
    state = await f.store.dispatch(saved.state.revision, {
      type: "prepare-summary",
      expectedRevision: saved.state.revision,
      artifact: saved.artifact,
    })
    const summaries = state.artifacts.filter((artifact) => artifact.kind === "stage-summary")
    await f.command.run("next", f.ctx)
    const recovered = await f.store.read()
    expect(f.errors).toEqual([])
    expect(recovered.stage).toBe("design")
    expect(recovered.transitions.at(-1)?.kind).toBe("revisit")
    expect(recovered.transitions.at(-1)?.summaryId).toBe(saved.artifact.id)
    expect(recovered.artifacts.filter((artifact) => artifact.kind === "stage-summary")).toEqual(summaries)
  })
  for (const [language, stage, variantHint] of [
    ["zh-CN", "原型", "原型变体"],
    ["ja", "プロトタイプ", "プロトタイプ案"],
  ]) {
    test(`${language} stage status, dialogs and panel follow the project language`, async () => {
      const f = await fixture(language)
      f.confirm(async () => true)
      await f.command.run("skip design", f.ctx)
      expect(f.errors).toEqual([])
      expect(f.panelText()).toContain(stage!)
      expect(f.panelText()).toContain(variantHint!)
      expect(f.dialogs.join("\n")).not.toContain("Confirm stage change")
      await f.command.run("status", f.ctx)
      expect(f.output.at(-1)).toContain(stage!)
    })
  }
})
