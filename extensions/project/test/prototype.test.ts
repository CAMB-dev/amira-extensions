import { afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  ConversationRuntime,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
} from "@amira/api"
import { disposeAccounting, projectAccounting } from "../src/accounting.ts"
import { latestPrototypeManifest, Prototypes, validateVariantProposals } from "../src/prototype.ts"
import { reportText, validatePrototypeReport } from "../src/prototype-sessions.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { createProject, DecisionStore, IterationStore } from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

setDefaultTimeout(60_000)
const roots: string[] = []
const apis: ExtensionAPI[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map(disposeAccounting))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const proposals = [
  { id: "alpha", idea: "One compact control", question: "Is the interaction clear without guidance?" },
  { id: "beta", idea: "Guided controls", question: "Does guidance improve clarity?" },
]

type Dialog = {
  kind: "select" | "input" | "confirm"
  title: string
  answer: string | boolean | undefined
  beforeAnswer?: () => Promise<void>
}

async function fixture(apiVersion: string | undefined = "0.1.53") {
  const home = await mkdtemp(path.join(tmpdir(), "project-prototype-controller-"))
  roots.push(home)
  const root = path.join(home, "project")
  await mkdir(root)
  const project = await createProject(root, "Prototype controller")
  const store = new IterationStore(project)
  // A real approved design skip, not a hand-written iteration state.
  const summary = await store.saveArtifact(0, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Explore the interaction",
    outputs: [],
    suggestion: "Try prototypes",
  })
  let state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "skip-design",
      from: "design",
      to: "prototype",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Try prototypes",
      skippedStages: ["design"],
    },
  })
  await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "skip-design", "prototype"),
  })

  const dialogs: Dialog[] = []
  const seen: { kind: Dialog["kind"]; title: string; options: unknown }[] = []
  async function answer(kind: Dialog["kind"], title: string, options: unknown) {
    seen.push({ kind, title, options })
    const next = dialogs.shift()
    expect(next, `Unexpected ${kind}: ${title}`).toBeDefined()
    expect(next!.kind).toBe(kind)
    expect(next!.title).toBe(title)
    await next!.beforeAnswer?.()
    return next!.answer
  }
  const print = mock((_text: string) => {})
  const focusConversation = mock((_handle: OwnedConversation) => true)
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "human-main" }) },
    ui: {
      select: (title: string, options: string[]) => answer("select", title, options),
      input: (title: string, options: unknown) => answer("input", title, options),
      confirm: (title: string, body: string) => answer("confirm", title, body),
      ask: mock(async () => {
        throw new Error("Controller choices must use native selection plus a separate reason")
      }),
    },
    print,
    focusConversation,
  } as unknown as CommandContext
  const specs: ConversationSpec[] = []
  const runtimes: ConversationRuntime[] = []
  const handles = new Map<string, OwnedConversation>()
  const released = new WeakSet<OwnedConversation>()
  const usage = new Map<string, ReturnType<typeof zeroUsage>>()
  let history: ReturnType<OwnedConversation["history"]> = []
  let busy = false
  const send = mock(async (): Promise<void> => {
    throw new Error("Creation must not send a model turn")
  })
  const createGroup = mock(() => {
    throw new Error("No agents or worktrees")
  })
  const runTool = mock(async () => {
    throw new Error("Commands must not execute tools")
  })
  const stop = mock(async () => {})
  let modelText = JSON.stringify(proposals)
  const complete = mock(async (_request: unknown) => ({
    text: modelText,
    message: {
      role: "assistant" as const,
      model: { provider: "mock", model: "fixture" },
      content: [{ type: "text" as const, text: modelText }],
    },
  }))
  const openOrCreate = mock(async (spec: ConversationSpec, runtime: ConversationRuntime) => {
    specs.push(spec)
    runtimes.push(runtime)
    const handle: OwnedConversation = {
      id: `prototype-${specs.length}`,
      key: spec.key,
      name: spec.name,
      cwd: spec.cwd,
      data: { read: () => [], append: () => {} },
      history: () => history,
      usage: () => structuredClone(usage.get(handle.id) ?? zeroUsage(handle.id)),
      complete,
      status: () => ({ state: busy ? "working" : "idle", busy }),
      events: { async *[Symbol.asyncIterator]() {} },
      send,
      createGroup,
      stop,
      release: async () => {
        released.add(handle)
      },
      ...{ runTool },
    }
    handles.set(handle.id, handle)
    return handle
  })
  const open = mock(async (id: string, runtime: ConversationRuntime) => {
    runtimes.push(runtime)
    const handle = handles.get(id)
    if (!handle) throw new Error(`Unknown fake conversation: ${id}`)
    if (!released.has(handle)) return handle
    const reopened: OwnedConversation = {
      ...handle,
      complete,
      send,
      createGroup,
      stop,
      runTool,
      release: async () => {
        released.add(reopened)
      },
    }
    handles.set(id, reopened)
    return reopened
  })
  const api = {
    apiVersion,
    dataDir: path.join(home, "extension-data"),
    conversations: {
      openOrCreate: async (spec: ConversationSpec, runtime: ConversationRuntime) => {
        if (!spec.key.includes("/generation/")) return openOrCreate(spec, runtime)
        const handle = { ...ownedFixture(spec, spec.key), complete }
        handles.set(handle.id, handle)
        return handle
      },
      open,
      read: async (ref: { id: string } | { key: string }) => {
        const saved = [...handles.values()].find((handle) =>
          "id" in ref ? handle.id === ref.id : handle.key === ref.key,
        )
        if (!saved) return undefined
        return {
          id: saved.id,
          key: saved.key,
          cwd: saved.cwd,
          name: saved.name,
          archived: false,
          history: saved.history(),
          usage: saved.usage(),
        }
      },
    },
    complete,
  } as unknown as ExtensionAPI
  apis.push(api)
  const controller = new Prototypes(api)
  const changed = mock(() => {})
  const checkOrigin = mock(() => {})
  const quiesceDesign = mock(async () => {})
  const run = (args: string[] = [], owner = controller) =>
    owner.run(args, project, ctx, "en", checkOrigin, changed, quiesceDesign)
  const queue = (
    kind: Dialog["kind"],
    title: string,
    value: Dialog["answer"],
    beforeAnswer?: Dialog["beforeAnswer"],
  ) => dialogs.push({ kind, title, answer: value, beforeAnswer })
  const bumpRevision = async () => {
    const current = await store.read()
    await store.saveArtifact(current.revision, {
      kind: "stage-summary",
      stage: "prototype",
      language: "en",
      summary: "Concurrent review",
      outputs: [],
      suggestion: "Review again",
    })
  }
  const setHistory = (role: "assistant" | "user", text: string) => {
    history = [{ role, content: [{ type: "text", text }] }] as ReturnType<OwnedConversation["history"]>
  }
  const report = (value: unknown) =>
    setHistory("assistant", `Run the local demo.\n\n\`\`\`prototype-report\n${JSON.stringify(value)}\n\`\`\``)
  const manifest = async () => (await latestPrototypeManifest(store))!.manifest
  async function plan(openVariant = false) {
    queue("select", "Confirm prototype variants", "Confirm variants")
    queue("select", "Open a prototype variant", openVariant ? "alpha" : "Keep list open")
    await run()
  }
  return {
    home,
    project,
    store,
    api,
    controller,
    ctx,
    dialogs,
    seen,
    queue,
    run,
    plan,
    manifest,
    bumpRevision,
    setHistory,
    report,
    print,
    focusConversation,
    specs,
    runtimes,
    handles,
    send,
    createGroup,
    runTool,
    stop,
    openOrCreate,
    open,
    complete,
    changed,
    quiesceDesign,
    setCost: (id: string, cost: number) => {
      const snapshot = zeroUsage(id)
      snapshot.revision = (usage.get(id)?.revision ?? 0) + 1
      snapshot.own.knownCostUsd = snapshot.total.knownCostUsd = cost
      snapshot.own.usage.cost = snapshot.total.usage.cost = cost
      usage.set(id, snapshot)
    },
    setModelText: (text: string) => {
      modelText = text
    },
    setBusy: (value: boolean) => {
      busy = value
    },
  }
}

test("project cap invalidates cached prototype owners and continuation reopens the same variant", async () => {
  const f = await fixture()
  await f.plan(true)
  const original = f.focusConversation.mock.calls[0]![0]
  const accounting = await projectAccounting(f.api, f.project)
  await accounting.costs.configure("cap", 1)
  f.setCost(original.id, 1)
  await accounting.refresh(original.key, original)
  await accounting.settled()
  expect(f.controller.sessions.isPrototypeSession(original.id)).toBe(false)
  await expect(f.run(["alpha"])).rejects.toThrow("stopped")
  await accounting.costs.configure("raise", 2)
  await expect(original.send("Stale composer must stay fenced")).rejects.toThrow("released")
  await f.run(["alpha"])
  const reopened = f.focusConversation.mock.calls.at(-1)![0]
  expect(reopened.id).toBe(original.id)
  expect(reopened).not.toBe(original)
  expect(f.specs).toHaveLength(1)
  expect(f.controller.sessions.isPrototypeSession(reopened.id)).toBe(true)
  expect(f.send).not.toHaveBeenCalled()
  f.send.mockImplementationOnce(async () => {})
  await reopened.send("Explicitly resume the prototype")
  expect(f.send).toHaveBeenCalledWith("Explicitly resume the prototype")
})

type Fixture = Awaited<ReturnType<typeof fixture>>
async function readyVariant(f: Fixture) {
  await f.plan(true)
  const variant = (await f.manifest()).variants[0]!
  f.report({
    runCommand: "bun demo.ts",
    cwd: variant.directory,
    prerequisites: [],
    notes: "The compact control answers the interaction question",
  })
  await f.controller.refresh(f.project, f.ctx, "en")
  return (await latestPrototypeManifest(f.store))!
}

async function commitChoice(f: Fixture, store = f.store) {
  const saved = (await latestPrototypeManifest(f.store))!
  const state = await f.store.read()
  return store.recordPrototypeChoice(
    state.revision,
    saved.ref,
    {
      question: "Choose a prototype variant",
      options: [
        ...saved.manifest.variants.map(({ id, idea }) => ({ label: id, description: idea })),
        { label: "none", description: "Keep findings only" },
      ],
    },
    [{ selected: ["alpha"] }],
    {
      sessionId: "human-main",
      askId: "prototype:recovery-choice",
      language: "en",
      reason: "The compact control answered the interaction question",
    },
  )
}

async function stageCommand(f: Fixture, verb: "next" | "skip" | "revisit", args: string[] = []) {
  return runStageCommand(
    verb,
    args,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {
      await f.controller.sessions.quiesce(f.project)
    },
  )
}

async function expectNoChoice(f: Fixture) {
  expect((await f.store.read()).prototypeChoice).toBeUndefined()
  expect((await f.manifest()).chosen).toBeUndefined()
  expect(await new DecisionStore(f.project).records()).toEqual([])
  expect(f.dialogs).toEqual([])
}

for (const version of ["0.1.52", "unknown", undefined]) {
  test(`host ${String(version)} refuses with upgrade and confinement explanation before creating a conversation`, async () => {
    const f = await fixture()
    const controller = new Prototypes({ ...f.api, apiVersion: version } as ExtensionAPI)
    await expect(f.run([], controller)).rejects.toThrow(
      /requires Amira API 0\.1\.53.*writeRoots.*focus.*Upgrade Amira; no unconfined session was started/,
    )
    expect(f.openOrCreate).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.complete).not.toHaveBeenCalled()
    expect(await latestPrototypeManifest(f.store)).toBeUndefined()
  })
}

test("proposal validation accepts one to three distinct proposals and returns a detached value", () => {
  const input = structuredClone(proposals)
  const result = validateVariantProposals(input)
  expect(result).toEqual(proposals)
  input[0]!.idea = "Changed by caller"
  expect(result[0]!.idea).toBe("One compact control")
  expect(validateVariantProposals([proposals[0]])).toHaveLength(1)
  expect(validateVariantProposals([...proposals, { ...proposals[0], id: "gamma" }])).toHaveLength(3)
})

for (const [label, value] of Object.entries({
  "non-array": {},
  "empty list": [],
  "too many": [...proposals, ...proposals],
  duplicate: [proposals[0], proposals[0]],
  "reserved none": [{ ...proposals[0], id: "none" }],
  "uppercase id": [{ ...proposals[0], id: "Alpha" }],
  "path id": [{ ...proposals[0], id: "../alpha" }],
  "long id": [{ ...proposals[0], id: "a".repeat(41) }],
  "extra field": [{ ...proposals[0], directory: "/outside" }],
  "blank idea": [{ ...proposals[0], idea: "  " }],
  "multiline idea": [{ ...proposals[0], idea: "one\ntwo" }],
  "NUL idea": [{ ...proposals[0], idea: "one\0two" }],
  "blank question": [{ ...proposals[0], question: " " }],
})) {
  test(`proposal validation rejects ${label}`, () => {
    expect(() => validateVariantProposals(value)).toThrow()
  })
}

test("invalid model proposals cannot be confirmed, persisted or opened", async () => {
  const f = await fixture()
  f.setModelText(JSON.stringify([{ ...proposals[0], writeRoots: [f.project.root] }]))
  await expect(f.run()).rejects.toThrow("Each variant")
  expect(f.seen).toEqual([])
  expect(await latestPrototypeManifest(f.store)).toBeUndefined()
  expect(f.openOrCreate).not.toHaveBeenCalled()
})

test("human edits and removes proposed variants before confirming the exact list, without starting a session", async () => {
  const f = await fixture()
  const edited = [{ ...proposals[1], idea: "Human-edited guided controls" }]
  f.setModelText(`\`\`\`json\n${JSON.stringify(proposals)}\n\`\`\``)
  f.queue("select", "Confirm prototype variants", "Edit variants")
  f.queue("input", "Edit or remove variants (JSON array)", JSON.stringify(edited))
  f.queue("select", "Confirm prototype variants", "Confirm variants")
  f.queue("select", "Open a prototype variant", "Keep list open")
  await f.run()
  const saved = await f.manifest()
  expect(saved.variants).toHaveLength(1)
  expect(saved.variants[0]).toMatchObject({
    ...edited[0],
    status: "planned",
    runCommand: null,
    prerequisites: [],
    notes: "",
  })
  expect(saved.variants[0]!.directory).toBe(
    path.join(f.project.root, ".amira", "project", "prototypes", "1", "beta"),
  )
  expect(f.seen[1]!.options).toMatchObject({ initial: JSON.stringify(proposals) })
  expect(f.seen.at(-1)!.options).toEqual(["beta", "Keep list open"])
  expect(f.openOrCreate).not.toHaveBeenCalled()
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.complete.mock.calls[0]![0]).toMatchObject({
    system: expect.stringContaining("No tools or code execution"),
  })
  expect(await new DecisionStore(f.project).records()).toEqual([])
  expect(f.dialogs).toEqual([])
})

for (const cancellation of ["Cancel", "dismiss", "edit input"] as const) {
  test(`list ${cancellation} leaves no manifest or owned conversation`, async () => {
    const f = await fixture()
    f.queue(
      "select",
      "Confirm prototype variants",
      cancellation === "edit input" ? "Edit variants" : cancellation === "dismiss" ? undefined : "Cancel",
    )
    if (cancellation === "edit input") f.queue("input", "Edit or remove variants (JSON array)", undefined)
    await f.run()
    expect(await latestPrototypeManifest(f.store)).toBeUndefined()
    expect(f.openOrCreate).not.toHaveBeenCalled()
    expect(await new DecisionStore(f.project).records()).toEqual([])
    expect(f.dialogs).toEqual([])
  })
}

test("stale revision before list confirmation cannot publish a manifest or start a conversation", async () => {
  const f = await fixture()
  f.queue("select", "Confirm prototype variants", "Confirm variants", f.bumpRevision)
  await expect(f.run()).rejects.toThrow("Stale")
  expect(await latestPrototypeManifest(f.store)).toBeUndefined()
  expect(f.openOrCreate).not.toHaveBeenCalled()
  expect(await new DecisionStore(f.project).records()).toEqual([])
})

test("opening and reopening use one inert native session with exact tools, cwd, writeRoots and boundary prompt", async () => {
  const f = await fixture()
  await f.plan(true)
  const variant = (await f.manifest()).variants[0]!
  expect(f.specs).toHaveLength(1)
  expect(f.specs[0]).toMatchObject({
    key: `${f.project.marker.id}/iteration/1/prototype/alpha`,
    cwd: variant.directory,
    writeRoots: [variant.directory],
  })
  expect([...f.specs[0]!.callableTools].sort()).toEqual([
    "apply_patch",
    "ask_user",
    "bash",
    "edit",
    "glob",
    "grep",
    "powershell",
    "read",
    "write",
  ])
  const prompt = f.specs[0]!.systemPrompt
  for (const text of [
    "THROWAWAY",
    proposals[0]!.idea,
    proposals[0]!.question,
    JSON.stringify(f.project.root),
    JSON.stringify(variant.directory),
    "No agents, worktrees",
    "not a sandbox",
    "prototype-report",
    "cannot write it yourself",
  ])
    expect(prompt).toContain(text)
  expect(f.runtimes[0]!.extraTools).toBeUndefined()
  expect(f.focusConversation.mock.calls[0]![0].cwd).toBe(variant.directory)
  expect(variant.status).toBe("building")
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.createGroup).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(await readdir(variant.directory)).toEqual([])
  await f.run(["alpha"], new Prototypes(f.api))
  expect(f.openOrCreate).toHaveBeenCalledTimes(1)
  expect(f.open).toHaveBeenCalledWith("prototype-1", expect.anything())
  expect(f.focusConversation).toHaveBeenCalledTimes(2)
  expect(f.send).not.toHaveBeenCalled()
})

for (const cancellation of ["selection", "reason mode", "reason input", "blank reason"] as const) {
  test(`${cancellation} never records a prototype decision`, async () => {
    const f = await fixture()
    await readyVariant(f)
    f.queue("select", "Choose a prototype variant", cancellation === "selection" ? undefined : "alpha")
    if (cancellation !== "selection")
      f.queue(
        "select",
        "Prototype selection reason",
        cancellation === "reason mode" ? undefined : "Enter reason",
      )
    if (cancellation === "reason input" || cancellation === "blank reason")
      f.queue("input", "Why choose this prototype?", cancellation === "blank reason" ? " \t " : undefined)
    if (cancellation === "blank reason")
      await expect(f.run(["choose"])).rejects.toThrow(
        "Enter a reason, or explicitly choose Skip reason. No decision was recorded.",
      )
    else await f.run(["choose"])
    await expectNoChoice(f)
    expect(f.openOrCreate).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })
}

for (const staleAt of ["selection", "reason mode", "reason input"] as const) {
  test(`stale revision during ${staleAt} never appends human choice evidence`, async () => {
    const f = await fixture()
    await readyVariant(f)
    f.queue(
      "select",
      "Choose a prototype variant",
      "alpha",
      staleAt === "selection" ? f.bumpRevision : undefined,
    )
    f.queue(
      "select",
      "Prototype selection reason",
      "Enter reason",
      staleAt === "reason mode" ? f.bumpRevision : undefined,
    )
    f.queue(
      "input",
      "Why choose this prototype?",
      "The compact control answered the question",
      staleAt === "reason input" ? f.bumpRevision : undefined,
    )
    await expect(f.run(["choose"])).rejects.toThrow("Stale")
    await expectNoChoice(f)
  })
}

test("choice records a separate required reason and asks for the next stage without silently approving it", async () => {
  const f = await fixture()
  await f.plan(true)
  const variant = (await f.manifest()).variants[0]!
  f.report({
    runCommand: "bun demo.ts",
    cwd: variant.directory,
    prerequisites: [],
    notes: "The interaction is clear",
  })
  f.queue("select", "Choose a prototype variant", "alpha")
  f.queue("select", "Prototype selection reason", "Enter reason")
  f.queue("input", "Why choose this prototype?", "One control makes the interaction understandable")
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", false)
  await f.run(["choose"])
  const state = await f.store.read()
  expect(state.stage).toBe("prototype")
  expect(state.pending).toMatchObject({ to: "implement", preparationOnly: true })
  expect(state.prototypeChoice).toMatchObject({ variantId: "alpha", decisionId: "D1" })
  const records = await new DecisionStore(f.project).records()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    sessionId: "human-main",
    reason: "One control makes the interaction understandable",
    prototypeChoice: { variantId: "alpha" },
  })
  expect(records[0]!.reasonSkipped).toBeUndefined()
  expect((await f.manifest()).chosen).toEqual({ variantId: "alpha", decisionId: "D1" })
  expect(f.stop).toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.dialogs).toEqual([])
})

test("None plus explicit Skip reason records a human conclusion and permits separately confirmed implementation preparation", async () => {
  const f = await fixture()
  await f.plan()
  f.queue("select", "Choose a prototype variant", "None")
  f.queue("select", "Prototype selection reason", "Skip reason")
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", true)
  await f.run(["choose"])
  const records = await new DecisionStore(f.project).records()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ reasonSkipped: true, prototypeChoice: { variantId: null } })
  expect(records[0]!.reason).toBeUndefined()
  expect(records[0]!.rationale).toBeUndefined()
  expect((await f.manifest()).chosen).toEqual({ variantId: null, decisionId: "D1" })
  const state = await f.store.read()
  expect(state.stage).toBe("implement")
  expect(state.phase).toBe("confirmed")
  expect(state.transitions.at(-1)).toMatchObject({
    from: "prototype",
    to: "implement",
    preparationOnly: true,
  })
  expect(state.approvedContext).toBeUndefined()
  await expect(
    f.store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "unapproved-implementation",
    }),
  ).rejects.toThrow("Approval must bind an exact saved spec, batch plan, batch and mode")
  expect(await f.store.read()).toEqual(state)
  expect(f.quiesceDesign).toHaveBeenCalledTimes(1)
  expect(f.seen.filter((dialog) => dialog.kind === "input")).toEqual([])
  expect(f.openOrCreate).not.toHaveBeenCalled()
  expect(f.dialogs).toEqual([])
})

test("refresh parses only the idle assistant final fenced report, persists it, and displays its run command without executing", async () => {
  const f = await fixture()
  await f.plan(true)
  const variant = (await f.manifest()).variants[0]!
  const cwd = path.join(variant.directory, "demo")
  await mkdir(cwd)
  await writeFile(path.join(cwd, "demo.ts"), 'throw new Error("Must not execute")\n')
  const report = {
    runCommand: "bun demo.ts",
    cwd,
    prerequisites: ["Install Bun"],
    notes: "A single control answers the question",
  }
  f.report(report)
  f.setBusy(true)
  expect((await f.controller.refresh(f.project, f.ctx, "en"))!.variants[0]!.status).toBe("building")
  f.setBusy(false)
  f.setHistory("user", `\`\`\`prototype-report\n${JSON.stringify(report)}\n\`\`\``)
  expect(reportText(f.handles.get("prototype-1")!)).toBeUndefined()
  expect((await f.controller.refresh(f.project, f.ctx, "en"))!.variants[0]!.runCommand).toBeNull()
  f.setHistory("assistant", JSON.stringify(report))
  expect((await f.controller.refresh(f.project, f.ctx, "en"))!.variants[0]!.runCommand).toBeNull()
  f.report(report)
  await f.controller.refresh(f.project, f.ctx, "en")
  expect((await f.manifest()).variants[0]).toMatchObject({ ...report, status: "ready" })
  await f.run(["run", "alpha"])
  const output = f.print.mock.calls.map(([text]) => text).join("\n")
  expect(output).toContain(`Run this command yourself (not started)\nbun demo.ts\ncwd: ${cwd}`)
  expect(output).toContain("Install Bun")
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(await readdir(cwd)).toEqual(["demo.ts"])
})

for (const invalid of ["malformed JSON", "outside cwd", "unknown field", "multiline command"] as const) {
  test(`refresh rejects ${invalid} as a failed report without trusting model storage or evidence`, async () => {
    const f = await fixture()
    await f.plan(true)
    const variant = (await f.manifest()).variants[0]!
    const report = {
      runCommand: invalid === "multiline command" ? "bun demo.ts\necho escaped" : "bun demo.ts",
      cwd: invalid === "outside cwd" ? f.project.root : variant.directory,
      prerequisites: [],
      notes: "Reference data only",
    }
    if (invalid === "malformed JSON") f.setHistory("assistant", "```prototype-report\n{broken}\n```")
    else f.report(invalid === "unknown field" ? { ...report, decisionId: "D-forged" } : report)
    await f.controller.refresh(f.project, f.ctx, "en")
    expect((await f.manifest()).variants[0]).toMatchObject({
      status: "failed",
      runCommand: null,
      notes: expect.stringContaining("Invalid prototype report:"),
    })
    await expect(f.run(["run", "alpha"])).rejects.toThrow("has not reported a valid run command")
    await expectNoChoice(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.runTool).not.toHaveBeenCalled()
  })
}

test("report cwd validation rejects relative, sibling-prefix and canonical junction escapes", async () => {
  const f = await fixture()
  await f.plan()
  const directory = (await f.manifest()).variants[0]!.directory
  const report = { runCommand: "bun demo.ts", cwd: directory, prerequisites: [], notes: "Local comparison" }
  expect(await validatePrototypeReport(report, directory)).toEqual(report)
  for (const cwd of [".", f.project.root, `${directory}-sibling`])
    await expect(validatePrototypeReport({ ...report, cwd }, directory)).rejects.toThrow()
  const link = path.join(directory, "escape")
  await symlink(f.project.root, link, process.platform === "win32" ? "junction" : "dir")
  await expect(validatePrototypeReport({ ...report, cwd: link }, directory)).rejects.toThrow(
    "cwd must be inside its own variant directory",
  )
})

for (const boundary of ["running", "finished"] as const) {
  test(`recoverChoice completes missing ${boundary === "running" ? "finish-work and " : ""}summary after a committed selection`, async () => {
    const f = await fixture()
    await readyVariant(f)
    let chosen = (await commitChoice(f)).state
    const attemptId = chosen.activeAttemptId!
    if (boundary === "finished")
      chosen = await f.store.dispatch(chosen.revision, {
        type: "finish-work",
        expectedRevision: chosen.revision,
        attemptId,
        changes: ["existing-prototype-change"],
      })
    expect(chosen.phase).toBe(boundary)
    const controller = new Prototypes(f.api)
    expect(await controller.recoverChoice(f.project, "en")).toBe(true)
    const recovered = await f.store.read()
    expect(recovered).toMatchObject({ stage: "prototype", phase: "summarized", status: "idle" })
    expect(recovered.prototypeChoice).toEqual(chosen.prototypeChoice)
    expect(recovered.attempts).toHaveLength(1)
    expect(recovered.attempts[0]).toMatchObject({
      id: attemptId,
      status: "finished",
      changes:
        boundary === "finished"
          ? ["existing-prototype-change"]
          : (await f.manifest()).variants.map(({ directory }) => directory),
    })
    const summary = await f.store.readArtifact(
      recovered.artifacts.find(({ id }) => id === recovered.summaryId)!,
    )
    expect(summary).toMatchObject({
      kind: "stage-summary",
      stage: "prototype",
      summary: expect.stringContaining("The compact control answered the interaction question"),
      outputs: [(await latestPrototypeManifest(f.store))!.ref.id, "D1"],
    })
    expect(await controller.recoverChoice(f.project, "en")).toBe(true)
    expect(await f.store.read()).toEqual(recovered)
    expect(await new DecisionStore(f.project).records()).toHaveLength(1)
    expect(f.complete).toHaveBeenCalledTimes(1)
    expect(f.openOrCreate).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.runTool).not.toHaveBeenCalled()
    expect(f.dialogs).toEqual([])
  })
}

test("recoverChoice reuses partial v3 evidence and its askId after decision commit without duplicating the decision", async () => {
  const f = await fixture()
  const saved = await readyVariant(f)
  const before = await f.store.read()
  const failing = new IterationStore(f.project, {
    afterArtifactPublish: () => {
      throw new Error("interrupted after decision commit")
    },
  })
  await expect(commitChoice(f, failing)).rejects.toThrow("interrupted after decision commit")
  const records = await new DecisionStore(f.project).records()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    id: "D1",
    formatVersion: 3,
    askId: "prototype:recovery-choice",
    prototypeChoice: { revision: before.revision, manifest: saved.ref, variantId: "alpha" },
  })
  expect(await f.store.read()).toEqual(before)
  expect((await f.manifest()).chosen).toBeUndefined()
  const controller = new Prototypes(f.api)
  expect(await controller.recoverChoice(f.project, "en")).toBe(true)
  const recovered = await f.store.read()
  expect(recovered.phase).toBe("summarized")
  expect(recovered.prototypeChoice).toMatchObject({ variantId: "alpha", decisionId: "D1" })
  expect((await f.manifest()).chosen).toEqual({ variantId: "alpha", decisionId: "D1" })
  expect(await new DecisionStore(f.project).records()).toEqual(records)
  expect(await controller.recoverChoice(f.project, "en")).toBe(true)
  expect(await f.store.read()).toEqual(recovered)
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.openOrCreate).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(f.seen.map(({ title }) => title)).toEqual(["Confirm prototype variants", "Open a prototype variant"])
})

test("human-confirmed prototype revisit clears the current choice and reopens historical files and native history without replay", async () => {
  const f = await fixture()
  await readyVariant(f)
  const variant = (await f.manifest()).variants[0]!
  const file = path.join(variant.directory, "demo.ts")
  await writeFile(file, "// Historical prototype, never replay or copy\n")
  const history = structuredClone(f.handles.get("prototype-1")!.history())
  await commitChoice(f)
  await f.controller.recoverChoice(f.project, "en")
  const historical = (await latestPrototypeManifest(f.store))!
  const records = await new DecisionStore(f.project).records()
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", true)
  expect((await stageCommand(f, "next")).stage).toBe("implement")
  f.queue("select", "Revisit prototype?", "Revisit and preserve history")
  f.queue("confirm", "Confirm stage change", true)
  const revisited = await stageCommand(f, "revisit", ["prototype"])
  expect(revisited).toMatchObject({ stage: "prototype", phase: "confirmed" })
  expect(revisited.prototypeChoice).toBeUndefined()
  expect((await f.manifest()).chosen).toEqual({ variantId: "alpha", decisionId: "D1" })
  await f.run(["alpha"], new Prototypes(f.api))
  expect((await f.manifest()).chosen).toBeUndefined()
  expect((await f.manifest()).variants).toEqual(historical.manifest.variants)
  expect(await f.store.readArtifact(historical.ref)).toEqual(historical.manifest)
  const reopened = await f.store.read()
  expect(reopened.prototypeChoice).toBeUndefined()
  expect(reopened.attempts.map(({ status }) => status)).toEqual(["finished", "working"])
  expect(await new DecisionStore(f.project).records()).toEqual(records)
  expect(await readFile(file, "utf8")).toBe("// Historical prototype, never replay or copy\n")
  expect(f.handles.get("prototype-1")!.history()).toEqual(history)
  expect(f.focusConversation.mock.calls.at(-1)![0]).toBe(f.handles.get("prototype-1")!)
  expect(f.open).toHaveBeenCalledWith("prototype-1", expect.anything())
  expect(f.openOrCreate).toHaveBeenCalledTimes(1)
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(f.createGroup).not.toHaveBeenCalled()
  expect(f.dialogs).toEqual([])
}, 180_000)

test("stale Open a prototype variant dialog rejects without overwriting the latest manifest", async () => {
  const f = await fixture()
  await f.plan()
  let latest: Awaited<ReturnType<IterationStore["saveArtifact"]>> | undefined
  f.queue("select", "Open a prototype variant", "alpha", async () => {
    const state = await f.store.read()
    const manifest = await f.manifest()
    manifest.variants[0]!.notes = "Newer human-reviewed comparison must survive"
    latest = await f.store.saveArtifact(state.revision, manifest)
  })
  await expect(f.run()).rejects.toThrow("Prototype state changed while the variant list was open")
  expect(await f.store.read()).toEqual(latest!.state)
  expect((await latestPrototypeManifest(f.store))!.ref).toEqual(latest!.artifact)
  expect((await f.manifest()).variants[0]!.notes).toBe("Newer human-reviewed comparison must survive")
  expect((await f.store.read()).attempts).toEqual([])
  expect(f.openOrCreate).not.toHaveBeenCalled()
  expect(f.focusConversation).not.toHaveBeenCalled()
  expect(await new DecisionStore(f.project).records()).toEqual([])
  expect(f.dialogs).toEqual([])
})

test("historical ready artifact survives deleted nested cwd while live report and run validation reject it", async () => {
  const f = await fixture()
  await readyVariant(f)
  const variant = (await f.manifest()).variants[0]!
  const cwd = path.join(variant.directory, "demo", "nested")
  await mkdir(cwd, { recursive: true })
  const report = { runCommand: "bun demo.ts", cwd, prerequisites: [], notes: "Historical nested demo" }
  f.report(report)
  await f.controller.refresh(f.project, f.ctx, "en")
  const historical = (await latestPrototypeManifest(f.store))!
  await commitChoice(f)
  await f.controller.recoverChoice(f.project, "en")
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", true)
  const state = await stageCommand(f, "next")
  expect(state.stage).toBe("implement")
  await rm(path.join(variant.directory, "demo"), { recursive: true })
  const restarted = new IterationStore(f.project)
  expect(await restarted.read()).toEqual(state)
  expect(await restarted.readArtifact(historical.ref)).toEqual(historical.manifest)
  expect((await f.manifest()).variants[0]).toMatchObject({ ...report, status: "ready" })
  await expect(validatePrototypeReport(report, variant.directory)).rejects.toThrow()
  await expect(f.run(["run", "alpha"], new Prototypes(f.api))).rejects.toThrow()
  expect(await restarted.read()).toEqual(state)
  expect(f.print.mock.calls.some(([text]) => text.includes("Run this command yourself (not started)"))).toBe(
    false,
  )
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(f.dialogs).toEqual([])
})

test("prototype skip after active work preserves the interrupted attempt and files", async () => {
  const f = await fixture()
  await f.plan(true)
  const variant = (await f.manifest()).variants[0]!
  const file = path.join(variant.directory, "unfinished.ts")
  await writeFile(file, "// Keep unfinished prototype work\n")
  const before = await f.store.read()
  const manifest = await f.manifest()
  expect(before.phase).toBe("running")
  f.queue("confirm", "Confirm stage change", true)
  const state = await stageCommand(f, "skip", ["prototype"])
  expect(state).toMatchObject({ stage: "implement", phase: "confirmed", status: "idle" })
  expect(state.attempts).toEqual(before.attempts.map((attempt) => ({ ...attempt, status: "interrupted" })))
  expect(state.activeAttemptId).toBeUndefined()
  expect(state.transitions.at(-1)).toMatchObject({
    kind: "skip",
    preparationOnly: true,
    skippedStages: ["prototype"],
  })
  expect(state.skips.map(({ stage }) => stage)).toEqual(["design", "prototype"])
  expect(state.prototypeChoice).toBeUndefined()
  expect(await f.manifest()).toEqual(manifest)
  expect(await readFile(file, "utf8")).toBe("// Keep unfinished prototype work\n")
  expect(await new DecisionStore(f.project).records()).toEqual([])
  expect(f.stop).toHaveBeenCalled()
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.openOrCreate).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
  expect(f.dialogs).toEqual([])
})

async function replacementChoiceFixture() {
  const f = await fixture()
  await readyVariant(f)
  await commitChoice(f)
  await f.controller.recoverChoice(f.project, "en")
  const evidencePath = path.join(f.project.root, ".amira", "project", "decisions.evidence.jsonl")
  const priorBytes = await readFile(evidencePath, "utf8")
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", true)
  await stageCommand(f, "next")
  f.queue("select", "Revisit prototype?", "Revisit and preserve history")
  f.queue("confirm", "Confirm stage change", true)
  await stageCommand(f, "revisit", ["prototype"])
  await f.run(["alpha"])
  const state = await f.store.read()
  const manifest = await f.manifest()
  Object.assign(manifest.variants[1]!, {
    status: "ready",
    runCommand: "bun beta.ts",
    notes: "The guided alternative answers the question",
  })
  await f.store.saveArtifact(state.revision, manifest)
  return { f, evidencePath, priorBytes }
}

for (const choice of ["beta", "None"] as const) {
  test(`a persisted replacement choice of ${choice} supersedes the previous prototype decision`, async () => {
    const { f, evidencePath, priorBytes } = await replacementChoiceFixture()
    f.queue("select", "Choose a prototype variant", choice)
    f.queue("select", "Prototype selection reason", "Enter reason")
    f.queue("input", "Why choose this prototype?", "The revised design needs a different conclusion")
    f.queue("select", "Choose the next step", undefined)
    await f.run(["choose"])
    const records = await new DecisionStore(f.project).records()
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      supersedes: ["D1"],
      supersededBy: [],
      reason: "The revised design needs a different conclusion",
      prototypeChoice: { variantId: choice === "None" ? null : "beta" },
    })
    expect(records[0]).toMatchObject({ supersededBy: ["D2"] })
    expect(records.filter((record) => record.prototypeChoice && !record.supersededBy.length)).toHaveLength(1)
    const reopened = new IterationStore(f.project)
    expect((await reopened.read()).prototypeChoice).toMatchObject({
      decisionId: "D2",
      variantId: choice === "None" ? null : "beta",
    })
    expect((await latestPrototypeManifest(reopened))?.manifest.chosen?.decisionId).toBe("D2")
    expect((await readFile(evidencePath, "utf8")).startsWith(priorBytes)).toBe(true)
  }, 180_000)
}

test("partial replacement-choice recovery preserves supersession metadata without duplicating evidence", async () => {
  const { f, evidencePath, priorBytes } = await replacementChoiceFixture()
  const failing = new IterationStore(f.project, {
    afterArtifactPublish: () => {
      throw new Error("partial replacement choice")
    },
  })
  const record = IterationStore.prototype.recordPrototypeChoice
  const interrupted = spyOn(IterationStore.prototype, "recordPrototypeChoice").mockImplementationOnce(
    (...args) => record.apply(failing, args),
  )
  f.queue("select", "Choose a prototype variant", "None")
  f.queue("select", "Prototype selection reason", "Skip reason")
  try {
    await expect(f.run(["choose"])).rejects.toThrow("partial replacement choice")
  } finally {
    interrupted.mockRestore()
  }
  const records = await new DecisionStore(f.project).records()
  expect(records[1]?.supersedes).toEqual(["D1"])
  expect(records[0]?.supersededBy).toEqual(["D2"])
  const evidence = await readFile(evidencePath, "utf8")
  expect(evidence.startsWith(priorBytes)).toBe(true)
  const recovery = spyOn(IterationStore.prototype, "recordPrototypeChoice")
  try {
    expect(await new Prototypes(f.api).recoverChoice(f.project, "en")).toBe(true)
    expect(recovery.mock.calls[0]?.[4].supersedes).toEqual(["D1"])
  } finally {
    recovery.mockRestore()
  }
  expect(await new DecisionStore(f.project).records()).toEqual(records)
  expect(await readFile(evidencePath, "utf8")).toBe(evidence)
  expect((await f.store.read()).prototypeChoice).toMatchObject({ decisionId: "D2", variantId: null })
}, 180_000)

for (const boundary of ["unstarted", "started", "chosen"] as const) {
  test(`continuing a declined ${boundary} prototype skip restores usable editing and selection`, async () => {
    const f = await fixture()
    if (boundary === "chosen") {
      await readyVariant(f)
      await commitChoice(f)
      await f.controller.recoverChoice(f.project, "en")
    } else await f.plan(boundary === "started")
    const variant = (await f.manifest()).variants[0]!
    const file = path.join(variant.directory, "preserved.ts")
    await writeFile(file, "// keep existing prototype files\n")
    f.queue("confirm", "Confirm stage change", false)
    const pending = await stageCommand(f, "skip", ["prototype"])
    expect(pending.pending?.kind).toBe("skip")
    const summary = pending.summaryId!
    const attempts = structuredClone(pending.attempts)
    f.queue("select", "Choose the next step", "Continue current stage")
    const resumed = await stageCommand(f, "next")
    expect(resumed).toMatchObject({ stage: "prototype", phase: "confirmed", status: "idle" })
    expect(resumed.summaryId).toBeUndefined()
    expect(resumed.pending).toBeUndefined()
    expect(resumed.activeAttemptId).toBeUndefined()
    expect(resumed.prototypeChoice).toBeUndefined()
    expect(resumed.attempts).toEqual(attempts)
    expect(resumed.artifacts.some((entry) => entry.id === summary)).toBe(true)
    await f.run(["alpha"], new Prototypes(f.api))
    expect((await f.store.read()).phase).toBe("running")
    f.queue("select", "Choose a prototype variant", "None")
    f.queue("select", "Prototype selection reason", "Skip reason")
    f.queue("select", "Choose the next step", undefined)
    await f.run(["choose"])
    const records = await new DecisionStore(f.project).records()
    expect(records.at(-1)?.prototypeChoice?.variantId).toBeNull()
    expect(records.at(-1)?.supersedes).toEqual(boundary === "chosen" ? ["D1"] : [])
    expect(await readFile(file, "utf8")).toBe("// keep existing prototype files\n")
    expect(f.send).not.toHaveBeenCalled()
    expect(f.runTool).not.toHaveBeenCalled()
    expect(f.dialogs).toEqual([])
  }, 180_000)
}

test("run rejects a chosen variant root redirected into production while preserving historical evidence", async () => {
  const f = await fixture()
  await readyVariant(f)
  await commitChoice(f)
  await f.controller.recoverChoice(f.project, "en")
  f.queue("select", "Choose the next step", "Confirm proposed next step")
  f.queue("confirm", "Confirm stage change", true)
  const state = await stageCommand(f, "next")
  const saved = (await latestPrototypeManifest(f.store))!
  const evidencePath = path.join(f.project.root, ".amira", "project", "decisions.evidence.jsonl")
  const evidence = await readFile(evidencePath, "utf8")
  const directory = saved.manifest.variants[0]!.directory
  const production = path.join(f.project.root, "production")
  await mkdir(production)
  const sentinel = path.join(production, "main.ts")
  await writeFile(sentinel, "// production stays untouched\n")
  await rename(directory, `${directory}-original`)
  await symlink(production, directory, process.platform === "win32" ? "junction" : "dir")
  const before = f.print.mock.calls.length
  await expect(f.run(["run", "alpha"])).rejects.toThrow(/canonical|redirect/i)
  expect(f.print.mock.calls.slice(before).some(([text]) => text.includes("Run this command yourself"))).toBe(
    false,
  )
  expect(await new IterationStore(f.project).read()).toEqual(state)
  expect(await f.store.readArtifact(saved.ref)).toEqual(saved.manifest)
  expect(await readFile(evidencePath, "utf8")).toBe(evidence)
  expect(await readFile(sentinel, "utf8")).toBe("// production stays untouched\n")
  expect(f.send).not.toHaveBeenCalled()
  expect(f.runTool).not.toHaveBeenCalled()
}, 180_000)
