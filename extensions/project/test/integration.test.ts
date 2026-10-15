import { afterEach, expect, setDefaultTimeout, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, type ModelRequest } from "@amira/ai"
import {
  type AskAnswer,
  type AskQuestion,
  type CommandContext,
  type CommandDefinition,
  defineTool,
  type ExtensionAPI,
  type OwnedConversation,
  type SessionControl,
  type SessionData,
  type ToolDefinition,
  type ToolPresenter,
  textResult,
} from "@amira/api"
import { Agent, AgentTree, InterceptorRegistry, OwnedConversationManager, ToolRegistry } from "@amira/core"
import { type RecordDecisionDetails, recordDecisionPresenter } from "../src/design.ts"
import { createProjectExtension, restoreAttachment } from "../src/index.ts"
import { DecisionStore, IterationStore, readDocument, readProject } from "../src/store.ts"
import { hostTest, loadHostModule } from "./amira-source.ts"

interface HostAskUserModule {
  askUserTool: ToolDefinition<{ questions: AskQuestion[] }>
  askUserPresenter: ToolPresenter<{ questions: AskQuestion[] }>
}
const hostBuiltins = await loadHostModule<HostAskUserModule>("extensions/builtin-tools/src/ask-user.ts", [
  "askUserTool",
  "askUserPresenter",
])

// Every integration fixture registers the real builtin, so source availability gates each case.
function test(
  name: string,
  callback: (builtins: HostAskUserModule) => void | Promise<void>,
  timeout?: number,
) {
  hostTest(name, hostBuiltins, () => callback(hostBuiltins.module!), timeout)
}

// Only command registration and frontend callbacks are simulated. Model turns, tool dispatch,
// child groups, policy enforcement, persistence and leases use the actual core implementation.
// Iteration claims and durable revisions add real filesystem work to multi-turn fixtures.
setDefaultTimeout(30_000)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const offered: AskQuestion[] = [
  {
    question: "Which deployment shape?",
    header: "Deployment",
    options: [
      { label: "Single service (recommended)", description: "Simpler operations, less independent scaling." },
      { label: "Separate services", description: "Independent scaling, more operational overhead." },
    ],
  },
]
const confirmed: AskAnswer[] = [{ selected: ["Single service (recommended)"] }]
const forbidden = ["write", "bash", "powershell", "agent"]

function sessionData(): SessionData {
  const records = new Map<string, unknown[]>()
  return {
    append(key, value) {
      records.set(key, [...(records.get(key) ?? []), structuredClone(value)])
    },
    read(key) {
      return structuredClone(records.get(key) ?? [])
    },
  }
}

async function fixture(builtins: HostAskUserModule, steps: MockStep[] = []) {
  const home = await mkdtemp(path.join(tmpdir(), "project-integration-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const cwd = path.join(home, "main-work")
  const root = path.join(home, "project-work")
  await mkdir(cwd)
  await mkdir(root)
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const executed: string[] = []
  const reads: string[] = []
  for (const name of forbidden) {
    tools.register(
      defineTool({
        name,
        description: `Forbidden executor: ${name}`,
        parameters: { type: "object" },
        execute: async () => {
          executed.push(name)
          return textResult("FORBIDDEN EXECUTOR RAN")
        },
      }),
      "integration-fixture",
    )
  }
  for (const name of ["read", "grep", "glob"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        traits: { readOnly: true },
        execute: async (_args, ctx) => {
          reads.push(ctx.cwd)
          return textResult("Read-only fixture reference")
        },
      }),
      "integration-fixture",
    )
  }
  // Execute the real builtin, including owner-answer validation and persisted outcomes.
  tools.register(builtins.askUserTool, "builtin-tools")
  const agents: Agent[] = []
  const interceptors = new InterceptorRegistry()
  const interceptDisposers: (() => void)[] = []
  const intercept: ExtensionAPI["intercept"] = (point, handler, options) => {
    const dispose = interceptors.add(point, handler, options, "project")
    interceptDisposers.push(dispose)
    return dispose
  }
  cleanups.push(async () => {
    for (const dispose of interceptDisposers.splice(0)) dispose()
  })
  function makeMain(workdir: string) {
    const tree = new AgentTree({ ai, sections: () => [] })
    const agent = new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: workdir,
      tools,
      tree,
      interceptors,
      sections: [],
      // Simulate the host human approving extension-owned document writes. This cannot
      // widen the owned callable ceiling, which the forbidden-executor tests verify.
      approve: async () => ({ approved: true }),
    })
    agents.push(agent)
    return agent
  }
  let main = makeMain(cwd)
  cleanups.push(async () => {
    for (const agent of agents) await agent.dispose()
  })
  function makeManager() {
    const manager = new OwnedConversationManager({ ai, tools, tree: main.tree!, home, agent: () => main })
    cleanups.push(() => manager.drain())
    return manager
  }
  let manager = makeManager()
  let data = sessionData()
  let sessionId = "main-1"
  const session = {
    info: () => ({
      id: sessionId,
      cwd: main.cwd,
      file: path.join(home, `${sessionId}.jsonl`),
      busy: main.busy,
    }),
    messages: () => main.messages,
    get data() {
      return data
    },
  } as unknown as SessionControl
  const output: { text: string; level?: string }[] = []
  const focused: OwnedConversation[] = []
  const asks: { questions: AskQuestion[]; options: { sessionId: string; signal: AbortSignal } }[] = []
  let answer: AskAnswer[] | undefined = confirmed
  let askHandler: (() => Promise<AskAnswer[] | undefined>) | undefined
  let extensionLanguage = "en"
  let settingsChanged: ((values: { language: string }) => void) | undefined
  let command!: CommandDefinition
  const api = {
    cwd,
    dataDir: path.join(home, "extension-data"),
    get conversations() {
      return manager.forOwner("project")
    },
    session: () => session,
    settings: {
      declare: () => ({
        get: () => ({ language: extensionLanguage }),
        onChange: (callback: (values: { language: string }) => void) => {
          settingsChanged = callback
          return () => {
            settingsChanged = undefined
          }
        },
      }),
    },
    intercept,
    registerCommand(value: CommandDefinition) {
      command = value
    },
    registerPanel() {},
    on: () => () => {},
    requestRender() {},
  } as unknown as ExtensionAPI
  const ctx = {
    cwd,
    frontend: "tui",
    signal: new AbortController().signal,
    session,
    ui: {
      input: async () => undefined,
      ask: async (questions: AskQuestion[], options: { sessionId: string; signal: AbortSignal }) => {
        asks.push({ questions: structuredClone(questions), options })
        return askHandler ? askHandler() : structuredClone(answer)
      },
    },
    print(text: string, level?: string) {
      output.push({ text, level })
    },
    focusConversation(handle: OwnedConversation) {
      focused.push(handle)
      return true
    },
    unfocusConversation: () => true,
  } as unknown as CommandContext
  await createProjectExtension()(api)
  async function run(args: string) {
    const before = output.length
    await command.run(args, ctx)
    const error = output.slice(before).find((line) => line.level === "error")
    if (error) throw new Error(error.text)
  }
  return {
    home,
    root,
    cwd,
    mock,
    executed,
    reads,
    asks,
    focused,
    output,
    ctx,
    run,
    main: () => main,
    data: () => data,
    handle: () => {
      const handle = focused.at(-1)
      if (!handle) throw new Error("The command did not focus a conversation")
      return handle
    },
    setAnswer(value: AskAnswer[] | undefined) {
      answer = value
    },
    setAskHandler(handler: (() => Promise<AskAnswer[] | undefined>) | undefined) {
      askHandler = handler
    },
    async setLanguage(language: string) {
      extensionLanguage = language
      if (!settingsChanged) throw new Error("No actual settings callback was registered")
      await settingsChanged({ language })
    },
    async create(options: { language?: string } = { language: "en" }) {
      await run(`new Demo --root "${root}"${options.language ? ` --language ${options.language}` : ""}`)
      return readProject(root)
    },
    async clearMain() {
      await main.dispose()
      main = makeMain(cwd)
      sessionId = "main-2"
      data = sessionData()
    },
    async reconstruct() {
      await manager.drain()
      for (const dispose of interceptDisposers.splice(0)) dispose()
      manager = makeManager()
      await createProjectExtension()(api)
    },
  }
}

function toolNames(request: ModelRequest) {
  return request.tools.map((tool) => tool.name)
}
function toolResults(handle: OwnedConversation) {
  return handle.history().filter((message) => message.role === "toolResult")
}

test("/project new attaches without changing main cwd; /project design focuses an inert native conversation", async (builtins) => {
  const f = await fixture(builtins, [{ text: "Design conversation answer" }])
  const project = await f.create()
  expect(restoreAttachment(f.data())).toMatchObject({ projectId: project.marker.id, root: project.root })
  expect(f.main().cwd).toBe(f.cwd)
  await f.run("design")
  const handle = f.handle()
  expect(handle.cwd).toBe(project.root)
  expect(handle.key).toBe(`${project.marker.id}/design/1`)
  expect(handle.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
  await handle.send("Help design this project")
  expect(f.mock.requests).toHaveLength(1)
  expect(JSON.stringify(handle.history())).toContain("Design conversation answer")
  expect(f.main().messages).toEqual([])
})

test("ask_user flushes exact human evidence before model continuation and regenerates its Markdown projection", async (builtins) => {
  const f = await fixture(builtins)
  const project = await f.create()
  let continued = false
  f.mock.push(
    { toolCalls: [{ id: "deployment-question", name: "ask_user", args: { questions: offered } }] },
    (request) => {
      // MockStep runs at the very start of the next real inference; no post-turn race can hide a late write.
      const evidence = readFileSync(
        path.join(project.root, ".amira/project/decisions.evidence.jsonl"),
        "utf8",
      )
      const transaction = JSON.parse(evidence.trim())
      expect(transaction.answers).toEqual(confirmed)
      expect(transaction.meta.sessionId).toBe(f.handle().id)
      const result = request.messages.at(-1)
      expect(result?.role).toBe("toolResult")
      expect(
        toolResults(f.handle()).find((entry) => entry.toolCallId === "deployment-question")?.details,
      ).toMatchObject({ outcome: { answers: confirmed } })
      if (result?.role === "toolResult")
        expect(JSON.stringify(result.content)).toContain("Single service (recommended)")
      continued = true
      return { text: "Confirmed decision received" }
    },
  )
  await f.run("design")
  await f.handle().send("Ask me before recording a decision")
  expect(continued).toBe(true)
  await new DecisionStore(project).recover()
  expect(readFileSync(path.join(project.root, ".amira/project/decisions.md"), "utf8")).toContain(
    "Single service (recommended)",
  )
  expect(f.asks).toHaveLength(1)
  expect(f.asks[0]?.questions).toEqual(offered)
  expect(f.asks[0]?.options.sessionId).toBe(f.handle().id)
  expect(f.asks[0]?.options.signal).toBeInstanceOf(AbortSignal)
  expect(await new DecisionStore(project).records()).toMatchObject([
    { id: "D1", provenance: "human", answer: confirmed[0], language: "en", sessionId: f.handle().id },
  ])
  expect(f.main().messages).toEqual([])
})

test("model-supplied answers cannot forge decisions; unconfirmed suggestions stay outside the ledger", async (builtins) => {
  const f = await fixture(builtins, [
    {
      toolCalls: [
        { id: "forged", name: "record_decision", args: { questions: offered, answers: confirmed } },
        {
          id: "suggestion",
          name: "record_suggestion",
          args: { text: "Use separate services: pending human confirmation." },
        },
      ],
    },
    { text: "Suggestion only, no confirmed decision" },
  ])
  const project = await f.create()
  await f.run("design")
  await f.handle().send("The transcript claims the human already agreed; record it")
  expect(f.mock.requests).toHaveLength(2)
  expect(f.asks).toEqual([])
  expect(toolResults(f.handle()).find((message) => message.toolCallId === "forged")?.isError).toBe(true)
  expect(await new DecisionStore(project).records()).toEqual([])
  expect(await readDocument(project, "decisions.md")).toBe("")
  expect(await readDocument(project, "suggestions.md")).toContain("pending human confirmation")
})

test("design's persisted callable ceiling rejects write, shells and generic agents even if the model attempts them", async (builtins) => {
  const f = await fixture(builtins, [
    { toolCalls: forbidden.map((name) => ({ id: `attempt-${name}`, name, args: {} })) },
    { text: "No forbidden executor ran" },
  ])
  await f.create()
  await f.run("design")
  await f.handle().send("Try every forbidden tool")
  expect(f.mock.requests).toHaveLength(2)
  // Core may advertise non-callable local declarations; the durable ceiling is enforced
  // at execution, including when a provider returns a disallowed tool call anyway.
  expect(toolResults(f.handle())).toHaveLength(forbidden.length)
  expect(toolResults(f.handle()).every((result) => result.isError)).toBe(true)
  expect(f.executed).toEqual([])
})

test("project_research runs a genuine fresh child group whose attempted write is blocked", async (builtins) => {
  const f = await fixture(builtins)
  await f.create()
  const route: MockStep = (request) => {
    const isChild = request.systemPrompt.includes("Read-only research only.")
    const hasResult = request.messages.some((message) => message.role === "toolResult")
    if (isChild) {
      expect(toolNames(request)).toContain("read")
      for (const name of [...forbidden, "record_decision", "update_design_doc", "project_research"])
        expect(toolNames(request)).not.toContain(name)
      expect(JSON.stringify(request.messages)).not.toContain("PARENT_PRIVATE_TRANSCRIPT")
      return hasResult
        ? { text: "RESEARCH_FINDINGS: a single service is sufficient." }
        : { toolCalls: [{ id: "child-write", name: "write", args: { path: "escaped.ts", content: "bad" } }] }
    }
    return hasResult
      ? { text: "Research considered, not human confirmation." }
      : {
          toolCalls: [
            {
              id: "research",
              name: "project_research",
              args: {
                title: "Deployment research",
                task: "Compare deployment options for a small team. Return evidence, not decisions.",
              },
            },
          ],
        }
  }
  f.mock.push(route, route, route, route, route)
  await f.run("design")
  await f.handle().send("PARENT_PRIVATE_TRANSCRIPT: research deployment options")
  const childRequests = f.mock.requests.filter((request) =>
    request.systemPrompt.includes("Read-only research only."),
  )
  expect(childRequests.length).toBeGreaterThan(0)
  expect(
    childRequests.some((request) =>
      request.messages.some(
        (message) => message.role === "toolResult" && message.toolCallId === "child-write" && message.isError,
      ),
    ),
  ).toBe(true)
  expect(JSON.stringify(toolResults(f.handle()))).toContain("RESEARCH_FINDINGS")
  expect(f.executed).toEqual([])
  expect(f.asks).toEqual([])
})

test("replacing the main agent like /clear neither destroys nor rebinds the live design conversation", async (builtins) => {
  const f = await fixture(builtins, [
    { text: "Before main clear" },
    { toolCalls: [{ id: "read-after-clear", name: "read", args: {} }] },
    { text: "After main clear" },
  ])
  const project = await f.create()
  await f.run("design")
  const handle = f.handle()
  await handle.send("Start design")
  const originalId = handle.id
  await f.clearMain()
  expect(restoreAttachment(f.data())).toBeUndefined()
  await handle.send("Continue after main was cleared")
  expect(handle.id).toBe(originalId)
  expect(handle.cwd).toBe(project.root)
  expect(handle.status().busy).toBe(false)
  expect(f.reads).toEqual([project.root])
  expect(JSON.stringify(handle.history())).toContain("Before main clear")
  expect(JSON.stringify(handle.history())).toContain("After main clear")
  expect(f.main().messages).toEqual([])
})

test("releasing and reconstructing the host manager reopens the same saved design inertly", async (builtins) => {
  const f = await fixture(builtins, [
    { text: "Durable design transcript" },
    { text: "Explicit continuation only" },
  ])
  await f.create()
  await f.run("design")
  const first = f.handle()
  await first.send("Remember this design discussion")
  const history = first.history()
  await f.reconstruct()
  await f.run("design")
  const reopened = f.handle()
  expect(reopened).not.toBe(first)
  expect(reopened.id).toBe(first.id)
  expect(reopened.history()).toEqual(history)
  expect(f.mock.requests).toHaveLength(1)
  await expect(first.send("Stale writer")).rejects.toThrow("released")
  await reopened.send("Continue explicitly")
  expect(f.mock.requests).toHaveLength(2)
  expect(JSON.stringify(reopened.history())).toContain("Explicit continuation only")
})

test("each iteration gets a fresh conversation seeded from project documents, never the prior transcript", async (builtins) => {
  const f = await fixture(builtins, [
    {
      toolCalls: [
        {
          id: "save-design",
          name: "update_design_doc",
          args: { text: "DOCUMENT_SEED: one service with a durable queue." },
        },
        { id: "confirm-design", name: "record_decision", args: { questions: offered } },
      ],
    },
    { text: "OLD_TRANSCRIPT_ONLY: discarded brainstorming detail" },
    { text: "Fresh iteration starts from durable documents" },
  ])
  const project = await f.create()
  await f.run("design")
  const first = f.handle()
  await first.send("Discuss the first iteration")
  expect(await new DecisionStore(project).records()).toHaveLength(1)
  // Later-phase iteration commands are intentionally out of scope. Emulate the persisted
  // iteration advance at the project boundary, then launch through the real /project command.
  project.marker.currentIteration = 2
  await writeFile(path.join(project.root, ".amira/project.json"), JSON.stringify(project.marker))
  await f.run("design")
  const next = f.handle()
  expect(next.id).not.toBe(first.id)
  expect(next.key).toBe(`${project.marker.id}/design/2`)
  expect(next.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(2)
  await next.send("Start the next iteration")
  const request = f.mock.requests.at(-1)!
  expect(request.systemPrompt).toContain("DOCUMENT_SEED: one service with a durable queue.")
  expect(request.systemPrompt).toContain("Single service (recommended)")
  expect(request.systemPrompt).toContain("D1")
  expect(JSON.stringify(request)).not.toContain("OLD_TRANSCRIPT_ONLY")
  expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1)
  expect(JSON.stringify(first.history())).toContain("OLD_TRANSCRIPT_ONLY")
})

const answerCases: { name: string; answer: AskAnswer[]; multiSelect?: boolean; valid: boolean }[] = [
  { name: "ordinary single", answer: confirmed, valid: true },
  { name: "Other-only", answer: [{ selected: [], other: "A third deployment shape." }], valid: true },
  { name: "empty multi", answer: [{ selected: [] }], multiSelect: true, valid: true },
  {
    name: "selected multi",
    answer: [{ selected: offered[0]!.options.map((option) => option.label) }],
    multiSelect: true,
    valid: true,
  },
  { name: "zero single", answer: [{ selected: [] }], valid: false },
  {
    name: "multiple single",
    answer: [{ selected: offered[0]!.options.map((option) => option.label) }],
    valid: false,
  },
  {
    name: "selected plus Other single",
    answer: [{ selected: confirmed[0]!.selected, other: "This is an alternative, not a rationale." }],
    valid: false,
  },
  {
    name: "duplicate labels",
    answer: [{ selected: [confirmed[0]!.selected[0]!, confirmed[0]!.selected[0]!] }],
    multiSelect: true,
    valid: false,
  },
  { name: "unknown labels", answer: [{ selected: ["Unknown choice"] }], valid: false },
]

for (const entry of answerCases) {
  test(`real builtin ask_user: ${entry.name} agrees with authoritative human evidence`, async (builtins) => {
    const questions = [{ ...offered[0]!, ...(entry.multiSelect ? { multiSelect: true } : {}) }]
    const f = await fixture(builtins, [
      { toolCalls: [{ id: "matrix", name: "ask_user", args: { questions } }] },
      { text: "Continue from actual human outcome" },
    ])
    const project = await f.create()
    f.setAnswer(entry.answer)
    await f.run("design")
    await f.handle().send("Ask a real human question")
    const result = toolResults(f.handle()).find((message) => message.toolCallId === "matrix")!
    const records = await new DecisionStore(project).records()
    if (entry.valid) {
      expect(result.isError).not.toBe(true)
      expect(result.details).toEqual({ questions, outcome: { answers: entry.answer } })
      expect(records.map((record) => record.answer)).toEqual(entry.answer)
      expect(records.every((record) => record.rationale === undefined)).toBe(true)
    } else {
      // Host approvals convert callback validation failures into an unavailable outcome,
      // which the builtin renders rather than marking its tool result as an error.
      expect(result.details).toMatchObject({
        questions,
        outcome: { unavailable: expect.stringContaining("asking failed") },
      })
      expect(records).toEqual([])
    }
  })
}

test("stopping real builtin ask_user during the evidence queue declines without a late decision", async (builtins) => {
  const f = await fixture(builtins, [
    { toolCalls: [{ id: "queued-ask", name: "ask_user", args: { questions: offered } }] },
    { text: "Must not continue after stop" },
  ])
  const project = await f.create()
  await f.run("design")
  const gate = Promise.withResolvers<void>()
  const blocking = Promise.withResolvers<void>()
  const queued = Promise.withResolvers<void>()
  cleanups.push(async () => gate.resolve())
  const seed = new DecisionStore(project, {
    afterEvidenceSync: async () => {
      blocking.resolve()
      await gate.promise
    },
  }).record(offered, confirmed, { sessionId: "seed", askId: "seed", language: "en" })
  await blocking.promise
  const original = DecisionStore.prototype.record
  let pending: Promise<unknown> | undefined
  const spy = spyOn(DecisionStore.prototype, "record").mockImplementation(function (
    this: DecisionStore,
    ...args
  ) {
    const result = original.apply(this, args)
    pending = result.catch(() => {})
    queued.resolve()
    return result
  })
  cleanups.push(async () => spy.mockRestore())
  const turn = f.handle().send("Ask while another confirmation is being persisted")
  await queued.promise
  await f.handle().stop("Cancel queued human confirmation")
  await turn
  const result = toolResults(f.handle()).find((message) => message.toolCallId === "queued-ask")!
  expect(result.details).toMatchObject({ questions: offered, outcome: { declined: true } })
  gate.resolve()
  await seed
  await pending
  // records() bypasses the write queue; no sleeps or scheduler timing can hide a late publication.
  expect((await new DecisionStore(project).records()).map((record) => record.id)).toEqual(["D1"])
  const evidence = readFileSync(path.join(project.root, ".amira/project/decisions.evidence.jsonl"), "utf8")
  expect(evidence.trim().split("\n")).toHaveLength(1)
})

test("record_decision returns exact choices and IDs and reopens expandable supersession evidence", async (builtins) => {
  const f = await fixture(builtins, [
    { toolCalls: [{ id: "first-choice", name: "record_decision", args: { questions: offered } }] },
    { text: "Initial choice recorded" },
    {
      toolCalls: [
        { id: "replacement", name: "record_decision", args: { questions: offered, supersedes: ["D1"] } },
      ],
    },
    { text: "Replacement recorded" },
  ])
  const project = await f.create()
  await f.run("design")
  await f.handle().send("Confirm the initial deployment choice")
  const alternative = [{ selected: [], other: "Use a hosted platform instead." }]
  f.setAnswer(alternative)
  await f.handle().send("Replace the old decision after showing its context")
  await f.reconstruct()
  await f.run("design")
  const saved = toolResults(f.handle()).find((message) => message.toolCallId === "replacement")!
  const details = saved.details as RecordDecisionDetails
  expect(details.ids).toEqual(["D2"])
  expect(details.outcome).toEqual({ answers: alternative })
  expect(details.questions).toEqual(f.asks.at(-1)!.questions)
  expect(details.questions[0]?.question).toContain("supersedes these decisions")
  expect(details.questions[0]?.question).toContain("D1")
  expect(JSON.stringify(saved.content)).toContain("Use a hosted platform instead.")
  expect(JSON.stringify(saved.content)).toContain("D2")
  const call = { args: { questions: offered }, result: { content: saved.content, details }, text: "" }
  expect(recordDecisionPresenter.body!(call, { detail: "full", width: 80 })).toEqual(
    builtins.askUserPresenter.body!(call, { detail: "full", width: 80 }),
  )
  expect((await new DecisionStore(project).records())[1]).toMatchObject({
    answer: alternative[0],
    supersedes: ["D1"],
  })
})

test("real builtin acknowledges a published answer before a later event-loop Stop", async (builtins) => {
  const f = await fixture(builtins, [
    { toolCalls: [{ id: "published-ask", name: "ask_user", args: { questions: offered } }] },
    { text: "The host received the actual human answer" },
  ])
  const project = await f.create()
  await f.run("design")
  const stopped = Promise.withResolvers<void>()
  let observed = false
  const original = DecisionStore.prototype.record
  let pending: Promise<unknown> | undefined
  const spy = spyOn(DecisionStore.prototype, "record").mockImplementation((...args) => {
    const store = new DecisionStore(project, {
      afterEvidenceSync: () => {
        observed = true
        // Observe the REAL flushed evidence through the store's publication seam. Do not block
        // the receipt or inject synchronous abort; schedule the normal later Stop event.
        setImmediate(() => {
          void f
            .handle()
            .stop("Stop became ready after evidence publication")
            .then(stopped.resolve, stopped.reject)
        })
      },
    })
    const result = original.apply(store, args)
    pending = result.catch(() => {})
    return result
  })
  cleanups.push(async () => spy.mockRestore())
  const turn = f.handle().send("Confirm with a Stop queued immediately after the evidence publication")
  try {
    await stopped.promise
    await turn
    expect(observed).toBe(true)
    const result = toolResults(f.handle()).find((message) => message.toolCallId === "published-ask")
    expect(result?.details).toMatchObject({ questions: offered, outcome: { answers: confirmed } })
    expect((await new DecisionStore(project).records()).map((record) => record.id)).toEqual(["D1"])
  } finally {
    await turn
    await pending
    await new DecisionStore(project).recover()
  }
  expect(readFileSync(path.join(project.root, ".amira/project/decisions.md"), "utf8")).toContain("D1")
})

test("oversized record_decision keeps exact choice text and authoritative sidecar when host drops details", async (builtins) => {
  const questions = structuredClone(offered)
  questions[0]!.options[0]!.description += "運用は簡単ですが、個別の拡張には制約があります。".repeat(400)
  const f = await fixture(builtins, [
    { toolCalls: [{ id: "oversized", name: "record_decision", args: { questions } }] },
    { text: "Oversized human evidence received" },
  ])
  const project = await f.create()
  // Large option evidence must not make the actual choice disappear from the receipt.
  const alternative = "独立したホスト型プラットフォームを選びます。"
  const answers = [{ selected: [], other: alternative }]
  f.setAnswer(answers)
  await f.run("design")
  await f.handle().send("Confirm a long alternative in your own words")
  await f.reconstruct()
  await f.run("design")
  const saved = toolResults(f.handle()).find((message) => message.toolCallId === "oversized")!
  expect(saved.details).toBeUndefined()
  expect(JSON.stringify(saved.content)).toContain(alternative)
  expect(JSON.stringify(saved.content)).toContain("D1")
  const records = await new DecisionStore(project).records()
  expect(records[0]?.answer).toEqual(answers[0]!)
  expect(records[0]?.rationale).toBeUndefined()
  const evidence = readFileSync(path.join(project.root, ".amira/project/decisions.evidence.jsonl"), "utf8")
  expect(Buffer.byteLength(evidence)).toBeGreaterThan(16_384)
  expect(JSON.parse(evidence.trim()).answers).toEqual(answers)
  expect(JSON.parse(evidence.trim()).questions).toEqual(questions)
})

for (const entry of [
  {
    name: "update_design_doc",
    leaf: "design.md",
    generated: "design.generated.md",
    proposed: "MODEL DESIGN",
  },
  {
    name: "record_suggestion",
    leaf: "suggestions.md",
    generated: "suggestions.generated.md",
    proposed: "MODEL SUGGESTION",
  },
]) {
  test(`${entry.name} reports the actual conflict sibling after a concurrent human save`, async (builtins) => {
    const f = await fixture(builtins, [
      { toolCalls: [{ id: "concurrent-document", name: entry.name, args: { text: entry.proposed } }] },
      { text: "The writer's actual receipt is available" },
    ])
    const project = await f.create()
    await f.run("design")
    const original = fs.open
    const document = path.join(project.root, ".amira", "project", entry.leaf)
    let edited = false
    const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (!edited && String(args[0]).includes(`.${entry.leaf}.`) && String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          if (!edited) {
            edited = true
            await fs.writeFile(document, "HUMAN concurrent save")
          }
        }
      }
      return handle
    })
    cleanups.push(async () => spy.mockRestore())
    await f.handle().send("Save this proposal without overwriting a concurrent human edit")
    expect(edited).toBe(true)
    const result = toolResults(f.handle()).find((message) => message.toolCallId === "concurrent-document")!
    const text = JSON.stringify(result.content)
    expect(text).toContain("not overwritten")
    expect(text).toContain(entry.generated)
    expect(await fs.readFile(document, "utf8")).toBe("HUMAN concurrent save")
    expect(
      await fs.readFile(path.join(project.root, ".amira", "project", entry.generated), "utf8"),
    ).toContain(entry.proposed)
  })
}

for (const name of ["ask_user", "record_decision"] as const) {
  for (const header of ["", "   ", "🧭".repeat(12)]) {
    test(`${name} preserves an answered ${JSON.stringify(header)} header in durable evidence`, async (builtins) => {
      const questions = structuredClone(offered)
      questions[0]!.header = header
      const f = await fixture(builtins, [
        { toolCalls: [{ id: "empty-header", name, args: { questions } }] },
        { text: "The actual human answer was received" },
      ])
      const project = await f.create()
      await f.run("design")
      await f.handle().send("Ask with the exact valid header, without normalizing it")
      expect(f.asks).toHaveLength(1)
      expect(f.asks[0]!.questions).toEqual(questions)
      const result = toolResults(f.handle()).find((entry) => entry.toolCallId === "empty-header")!
      expect(result.isError).toBe(false)
      expect(result.details).toMatchObject({ questions, outcome: { answers: confirmed } })
      expect(JSON.stringify(result.content)).toContain(confirmed[0]!.selected[0]!)
      const records = await new DecisionStore(project).records()
      expect(records).toMatchObject([{ id: "D1", question: questions[0], answer: confirmed[0] }])
      const raw = JSON.parse(
        readFileSync(path.join(project.root, ".amira/project/decisions.evidence.jsonl"), "utf8").trim(),
      )
      expect(raw.questions).toEqual(questions)
      expect(raw.answers).toEqual(confirmed)
      if (name === "record_decision") {
        expect((result.details as RecordDecisionDetails).ids).toEqual(["D1"])
        expect(JSON.stringify(result.content)).toContain("D1")
      }
      await new DecisionStore(project).recover()
    })
  }
}

for (const change of ["extension", "marker", "project override", "remove override"] as const) {
  test(`existing design refreshes new-content language after ${change} without reopening`, async (builtins) => {
    const f = await fixture(builtins, [
      {
        toolCalls: [
          { id: "before-suggestion", name: "record_suggestion", args: { text: "Existing English proposal" } },
        ],
      },
      { toolCalls: [{ id: "before-decision", name: "ask_user", args: { questions: offered } }] },
      { text: "Initial work complete" },
    ])
    const hasOverride = change === "project override" || change === "remove override"
    const project = await f.create(hasOverride ? { language: "en" } : {})
    if (change === "remove override") await f.setLanguage("ja")
    await f.run("design")
    const handle = f.handle()
    await handle.send("Start this project in English")
    const evidencePath = path.join(project.root, ".amira/project/decisions.evidence.jsonl")
    const before = readFileSync(evidencePath, "utf8")
    const oldSuggestion = await readDocument(project, "suggestions.md")
    expect(oldSuggestion).toContain("Pending suggestion")
    expect((await new DecisionStore(project).records())[0]?.language).toBe("en")
    const requestCount = f.mock.requests.length
    if (change === "extension" || change === "project override") await f.setLanguage("ja")
    else {
      const marker = structuredClone(project.marker)
      if (change === "marker") marker.settings.language = "ja"
      else delete marker.settings.language
      await writeFile(path.join(project.root, ".amira/project.json"), JSON.stringify(marker))
    }
    expect(f.mock.requests).toHaveLength(requestCount)
    const expected = change === "project override" ? "en" : "ja"
    const assertPolicy = (request: ModelRequest) => {
      expect(request.tools.find((tool) => tool.name === "record_suggestion")?.description).toContain(
        `Current human-facing output language: ${expected}`,
      )
      expect(request.systemPrompt).toContain(`Human-facing new content must use "${expected}"`)
      if (expected === "ja")
        expect(request.systemPrompt).toContain("これはプロジェクト専用の独立した設計会話です。")
    }
    f.mock.push(
      (request) => {
        assertPolicy(request)
        return {
          toolCalls: [{ id: "after-suggestion", name: "record_suggestion", args: { text: "新しい提案" } }],
        }
      },
      (request) => {
        assertPolicy(request)
        return { toolCalls: [{ id: "after-decision", name: "ask_user", args: { questions: offered } }] }
      },
      { text: "Continued without reopening" },
    )
    await handle.send("Continue with the current project configuration")
    expect(f.focused).toHaveLength(1)
    expect(f.handle()).toBe(handle)
    expect((await new DecisionStore(project).records()).map((record) => record.language)).toEqual([
      "en",
      expected,
    ])
    const suggestions = await readDocument(project, "suggestions.md")
    expect(suggestions.startsWith(oldSuggestion)).toBe(true)
    expect(suggestions).toContain(expected === "ja" ? "未確定の提案" : "Pending suggestion")
    expect(suggestions).toContain(`; ${expected})`)
    expect(readFileSync(evidencePath, "utf8").startsWith(before)).toBe(true)
    await new DecisionStore(project).recover()
  })
}

for (const name of ["ask_user", "record_decision"] as const) {
  for (const change of ["extension", "marker"] as const) {
    test(`${name} keeps an already-presented question's language stable across a ${change} change`, async (builtins) => {
      const f = await fixture(builtins, [
        { toolCalls: [{ id: "presented", name, args: { questions: offered } }] },
        {
          toolCalls: [
            { id: "subsequent-suggestion", name: "record_suggestion", args: { text: "新しい提案" } },
          ],
        },
        { toolCalls: [{ id: "subsequent-question", name: "ask_user", args: { questions: offered } }] },
        { text: "Subsequent work completed in the new language" },
      ])
      const project = await f.create({})
      await f.run("design")
      const shown = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<void>()
      cleanups.push(async () => answer.resolve())
      f.setAskHandler(async () => {
        shown.resolve()
        await answer.promise
        return structuredClone(confirmed)
      })
      const turn = f.handle().send("Present a question before the setting changes")
      await shown.promise
      try {
        if (change === "extension") await f.setLanguage("ja")
        else
          await writeFile(
            path.join(project.root, ".amira/project.json"),
            JSON.stringify({ ...project.marker, settings: { ...project.marker.settings, language: "ja" } }),
          )
        expect(f.mock.requests).toHaveLength(1)
        expect(f.asks[0]!.questions).toEqual(offered)
        f.setAskHandler(undefined)
        answer.resolve()
        await turn
        const result = toolResults(f.handle()).find((entry) => entry.toolCallId === "presented")!
        expect(result.details).toMatchObject({ questions: offered, outcome: { answers: confirmed } })
        if (name === "record_decision")
          expect(JSON.stringify(result.content)).toContain("Human-confirmed decisions saved")
        expect((await new DecisionStore(project).records()).map((record) => record.language)).toEqual([
          "en",
          "ja",
        ])
        expect(await readDocument(project, "suggestions.md")).toContain("未確定の提案")
        expect(
          f.mock.requests[1]!.tools.find((tool) => tool.name === "record_suggestion")?.description,
        ).toContain("Current human-facing output language: ja")
        await new DecisionStore(project).recover()
      } finally {
        answer.resolve()
        await turn
      }
    })
  }
}

for (const name of ["ask_user", "record_decision"] as const) {
  test(`${name} rejects a late human answer after the iteration revision changes`, async (builtins) => {
    const f = await fixture(builtins, [
      { toolCalls: [{ id: "late-question", name, args: { questions: offered } }] },
      { text: "The stale question was not accepted." },
    ])
    const project = await f.create()
    await f.run("design")
    const shown = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    cleanups.push(async () => answer.resolve())
    f.setAskHandler(async () => {
      shown.resolve()
      await answer.promise
      return structuredClone(confirmed)
    })
    const turn = f.handle().send("Ask before a stage revision changes")
    await shown.promise
    try {
      const store = new IterationStore(project)
      const state = await store.read()
      await store.saveArtifact(state.revision, {
        kind: "stage-summary",
        stage: "design",
        language: "en",
        summary: "A separate stage writer changed this revision",
        outputs: [],
        suggestion: "Review again",
      })
      answer.resolve()
      await turn
      expect(await new DecisionStore(project).records()).toEqual([])
      const result = toolResults(f.handle()).find((entry) => entry.toolCallId === "late-question")!
      expect(result.isError || JSON.stringify(result.content).includes("stale")).toBe(true)
      expect(f.executed).toEqual([])
    } finally {
      answer.resolve()
      await turn
    }
  })
}

for (const [language, native] of [
  ["zh-CN", "无法刷新项目设计状态"],
  ["ja", "設計の状態を更新できません"],
]) {
  test(`${language}: design interceptor localizes storage errors using the live language and preserves edits`, async (builtins) => {
    const f = await fixture(builtins, [])
    const project = await f.create({ language: "en" })
    await f.run("design")
    await writeFile(
      path.join(project.root, ".amira/project.json"),
      JSON.stringify({ ...project.marker, settings: { ...project.marker.settings, language } }),
    )
    const state = await new IterationStore(project).read()
    const file = path.join(project.root, ".amira/project/iterations/1/state.json")
    const edited = JSON.stringify({ ...state, manualNote: "preserve this human edit" })
    await writeFile(file, edited)
    const error = await f
      .handle()
      .send("Continue the design")
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(native!)
    expect((error as Error).message).not.toContain("Unable to refresh project design")
    expect((error as Error).message).not.toContain("Iteration state.json was manually edited")
    expect(await fs.readFile(file, "utf8")).toBe(edited)
    expect(f.mock.requests).toEqual([])
  })
}
