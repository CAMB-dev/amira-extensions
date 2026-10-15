import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
  AskAnswer,
  AskQuestion,
  CommandContext,
  ConversationRuntime,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
  SpawnGroup,
  SpawnOptions,
  ToolDefinition,
  ToolPresenter,
} from "@amira/api"
import { textResult } from "@amira/api"
import { DesignSessions, type RecordDecisionDetails, recordDecisionPresenter } from "../src/design.ts"
import { LanguagePolicy } from "../src/language.ts"
import { DecisionStore, type Project } from "../src/store.ts"
import { hostTest, loadHostModule } from "./amira-source.ts"

interface HostAskUserModule {
  askUserTool: ToolDefinition<{ questions: AskQuestion[] }>
  askUserPresenter: ToolPresenter<{ questions: AskQuestion[] }>
}
const hostBuiltins = await loadHostModule<HostAskUserModule>("extensions/builtin-tools/src/ask-user.ts", [
  "askUserTool",
  "askUserPresenter",
])

function builtinTest(name: string, callback: (builtins: HostAskUserModule) => void | Promise<void>) {
  hostTest(name, hostBuiltins, () => callback(hostBuiltins.module!))
}

// Multi-turn mock tests now also flush revision-bound iteration state on Windows.
setDefaultTimeout(30_000)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "project-design-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = path.join(home, "project")
  const documents = path.join(root, ".amira", "project")
  await mkdir(path.join(documents, "research"), { recursive: true })
  await writeFile(path.join(documents, "design.md"), "Existing design")
  await writeFile(path.join(documents, "decisions.md"), "")
  await writeFile(path.join(documents, "suggestions.md"), "")
  const project: Project = {
    root,
    marker: {
      schemaVersion: 1,
      id: "project-one",
      name: "Example",
      created: "2026-10-14T00:00:00.000Z",
      currentIteration: 1,
      settings: {},
    },
  }
  await writeFile(path.join(root, ".amira", "project.json"), JSON.stringify(project.marker))
  const specs: ConversationSpec[] = []
  const runtimes: ConversationRuntime[] = []
  const opened: string[] = []
  const focused: OwnedConversation[] = []
  const printed: string[] = []
  let answers: AskAnswer[] | undefined = [{ selected: ["Small scope"] }]
  const asks: { questions: AskQuestion[]; options: unknown }[] = []
  const handles = new Map<string, OwnedConversation>()
  function handle(id: string, key = "project-one/design/1"): OwnedConversation {
    const result: OwnedConversation = {
      id,
      key,
      name: "Example · Design · 1",
      cwd: root,
      data: { read: () => [], append: () => {} },
      history: () => [],
      status: () => ({ state: "idle", busy: false }),
      events: { async *[Symbol.asyncIterator]() {} },
      send: async () => {
        throw new Error("Opening must not send a turn")
      },
      stop: async () => {},
      release: async () => {},
      createGroup: () => {
        throw new Error("Opening must not spawn research")
      },
      // Newer host declarations require this capability. Spreading the extra stub also
      // typechecks on 0.1.52, and any use fails: project does not depend on this host API.
      ...{
        runTool: async () => {
          throw new Error("Project design must not invoke direct host tool execution")
        },
      },
    }
    handles.set(id, result)
    return result
  }
  const conversations = {
    openOrCreate: async (spec: ConversationSpec, runtime: ConversationRuntime) => {
      specs.push(spec)
      runtimes.push(runtime)
      return handle(`design-${specs.length}`, spec.key)
    },
    open: async (id: string, runtime: ConversationRuntime) => {
      opened.push(id)
      runtimes.push(runtime)
      return handles.get(id) ?? handle(id)
    },
  }
  const control = { info: () => ({ id: "main-fixture" }) }
  const ctx = {
    session: control,
    signal: new AbortController().signal,
    ui: {
      ask: async (questions: AskQuestion[], options: unknown) => {
        asks.push({ questions, options })
        return answers
      },
    },
    print: (text: string) => {
      printed.push(text)
    },
    focusConversation: (conversation: OwnedConversation) => {
      focused.push(conversation)
      return true
    },
    unfocusConversation: () => true,
  } as unknown as CommandContext
  const renderers = new Map<string, unknown>()
  const api = {
    registerToolRenderer: (name: string, presenter: unknown) => {
      renderers.set(name, presenter)
      return () => renderers.delete(name)
    },
    conversations,
    dataDir: path.join(home, "data"),
    session: () => control,
  } as unknown as ExtensionAPI
  return {
    api,
    ctx,
    renderers,
    home,
    root,
    documents,
    project,
    specs,
    runtimes,
    opened,
    focused,
    asks,
    printed,
    setAnswers: (value: AskAnswer[] | undefined) => {
      answers = value
    },
    runtime: () => runtimes.at(-1)!,
  }
}

test("design opens natively and reopens the saved project/iteration ID without mutating its spec", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  expect(f.specs).toHaveLength(1)
  expect(f.specs[0]?.cwd).toBe(f.root)
  expect(f.specs[0]?.systemPrompt).toContain("Existing design")
  expect(f.focused[0]?.id).toBe("design-1")
  await writeFile(path.join(f.documents, "design.md"), "Changed after creation")
  f.project.marker.name = "Renamed"
  await new DesignSessions(f.api).open(f.project, f.ctx, "zh-CN")
  expect(f.opened).toEqual(["design-1"])
  expect(f.specs).toHaveLength(1)
  expect(f.focused).toHaveLength(2)
})

const offered: AskQuestion[] = [
  {
    question: "Which scope should we build?",
    header: "Scope",
    options: [
      { label: "Small scope", description: "Recommended: validate sooner, with fewer features." },
      { label: "Large scope", description: "More features immediately, but slower feedback." },
    ],
  },
]

function context(id: string, signal = new AbortController().signal, call = "ask-1") {
  return {
    cwd: "/unused",
    toolCallId: call,
    signal,
    update: () => {},
    session: {
      sessionId: id,
      depth: 0,
      maxDepth: 2,
      model: { provider: "mock", model: "test" },
      deferredTools: () => [],
      loadTools: () => [],
    },
  } as Parameters<NonNullable<ConversationRuntime["extraTools"]>[number]["execute"]>[1]
}

function runtimeTool(runtime: ConversationRuntime, name: string) {
  const tool = runtime.extraTools?.find((tool) => tool.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool
}

test("each iteration has one separate conversation seeded from current documents, not a transcript", async () => {
  const f = await fixture()
  const sessions = new DesignSessions(f.api)
  await sessions.open(f.project, f.ctx, "en")
  await sessions.open(f.project, f.ctx, "en")
  expect(f.specs).toHaveLength(1)
  expect(f.focused[0]).toBe(f.focused[1])
  await writeFile(path.join(f.documents, "design.md"), "New iteration design")
  f.project.marker.currentIteration = 2
  await writeFile(path.join(f.root, ".amira", "project.json"), JSON.stringify(f.project.marker))
  await sessions.open(f.project, f.ctx, "en")
  expect(f.specs).toHaveLength(2)
  expect(f.specs[1]?.key).not.toBe(f.specs[0]?.key)
  expect(f.specs[1]?.systemPrompt).toContain("New iteration design")
  expect(f.specs[1]?.systemPrompt).not.toContain("Existing design")
  expect(f.focused[2]?.id).not.toBe(f.focused[0]?.id)
})

test("missing capabilities and unavailable native focus fail explicitly without a fallback", async () => {
  const f = await fixture()
  await expect(
    new DesignSessions({ ...f.api, conversations: undefined }).open(f.project, f.ctx, "en"),
  ).rejects.toThrow("0.1.52")
  await expect(
    new DesignSessions(f.api).open(f.project, { ...f.ctx, focusConversation: undefined }, "en"),
  ).rejects.toThrow("native conversation focus")
  expect(f.specs).toHaveLength(0)
  await expect(
    new DesignSessions(f.api).open(f.project, { ...f.ctx, focusConversation: () => false }, "en"),
  ).rejects.toThrow("unavailable right now")
  expect(f.specs).toHaveLength(1)
})

test("a lease conflict is an explicit in-use error, never a replacement conversation", async () => {
  const f = await fixture()
  f.api.conversations!.openOrCreate = async () => {
    throw new Error("conversation in use")
  }
  await expect(new DesignSessions(f.api).open(f.project, f.ctx, "en")).rejects.toThrow("in use")
  expect(f.focused).toHaveLength(0)
})

test("normal questions forward identity and cancellation, and durably record exact human evidence before returning", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "zh-CN")
  const signal = new AbortController().signal
  f.setAnswers([{ selected: [], other: "先验证核心流程。" }])
  const answer = await f.runtime().askUser(offered, { sessionId: "design-1", signal })
  expect(answer).toEqual([{ selected: [], other: "先验证核心流程。" }])
  expect(f.asks[0]?.options).toEqual({ sessionId: "design-1", signal })
  const records = await new DecisionStore(f.project).records()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    id: "D1",
    provenance: "human",
    question: offered[0],
    answer: answer?.[0],
    language: "zh-CN",
    sessionId: "design-1",
  })
  expect(records[0]?.rationale).toBeUndefined()
  // Durable evidence is the acknowledgment. Projection rejoins the write queue separately,
  // so cancellation cannot overtake an answer while Markdown I/O is pending.
  await new DecisionStore(f.project).recover()
  expect(await readFile(path.join(f.documents, "decisions.md"), "utf8")).toContain("先验证核心流程。")
  const evidence = await readFile(path.join(f.documents, "decisions.evidence.jsonl"), "utf8")
  expect(evidence).toContain("Small scope")
  expect(evidence).toContain("slower feedback")
})

test("cancelled, aborted, missing trade-offs and invalid human answers never become decisions", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  const signal = new AbortController().signal
  f.setAnswers(undefined)
  expect(await f.runtime().askUser(offered, { sessionId: "design-1", signal })).toBeUndefined()
  f.setAnswers([{ selected: ["Model invented this option"] }])
  await expect(f.runtime().askUser(offered, { sessionId: "design-1", signal })).rejects.toThrow(
    "invalid selection",
  )
  const aborted = new AbortController()
  aborted.abort()
  expect(
    await f.runtime().askUser(offered, { sessionId: "design-1", signal: aborted.signal }),
  ).toBeUndefined()
  await expect(
    f.runtime().askUser(
      [
        {
          question: "No trade-offs?",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      { sessionId: "design-1", signal },
    ),
  ).rejects.toThrow("trade-off")
  expect(await new DecisionStore(f.project).records()).toEqual([])
})

test("decision tools reject supplied model answers and ask the human afresh for supersession", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  const decision = runtimeTool(f.runtime(), "record_decision")
  const ctx = context("design-1")
  await expect(
    decision.execute({ questions: offered, answers: [{ selected: ["Large scope"] }] }, ctx),
  ).rejects.toThrow("Unexpected field")
  expect(await new DecisionStore(f.project).records()).toEqual([])
  const first = await decision.execute({ questions: offered }, ctx)
  expect(JSON.stringify(first.content)).toContain("Human-confirmed decisions saved: D1")
  expect(JSON.stringify(first.content)).toContain("Small scope")
  expect(first).toMatchObject({
    details: { questions: offered, outcome: { answers: [{ selected: ["Small scope"] }] }, ids: ["D1"] },
    persistDetails: true,
  })
  f.setAnswers(undefined)
  await decision.execute({ questions: offered, supersedes: ["D1"] }, context("design-1", undefined, "ask-2"))
  expect(await new DecisionStore(f.project).records()).toHaveLength(1)
  f.setAnswers([{ selected: ["Large scope"] }])
  const next = await decision.execute(
    { questions: offered, supersedes: ["D1"] },
    context("design-1", undefined, "ask-3"),
  )
  expect(JSON.stringify(next.content)).toContain("Human-confirmed decisions saved: D2")
  expect(JSON.stringify(next.content)).toContain("Large scope")
  expect(next).toMatchObject({
    details: {
      questions: f.asks.at(-1)?.questions,
      outcome: { answers: [{ selected: ["Large scope"] }] },
      ids: ["D2"],
    },
    persistDetails: true,
  })
  expect(f.asks.at(-1)?.questions[0]?.question).toContain("supersedes these decisions")
  expect(f.asks.at(-1)?.questions[0]?.question).toContain("D1")
  const records = await new DecisionStore(f.project).records()
  expect(records[0]?.supersededBy).toEqual(["D2"])
  expect(records[1]?.supersedes).toEqual(["D1"])
  expect(records[1]?.answer.selected).toEqual(["Large scope"])
  await expect(
    decision.execute({ questions: offered, supersedes: ["D404"] }, context("design-1")),
  ).rejects.toThrow("unknown decision")
})

test("persistence failure rejects the question callback rather than claiming a durable decision", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  await mkdir(path.join(f.documents, "decisions.evidence.jsonl"))
  await expect(
    f.runtime().askUser(offered, { sessionId: "design-1", signal: new AbortController().signal }),
  ).rejects.toThrow()
})

test("new language takes effect without sending, translating prior evidence or changing the persisted spec", async () => {
  const f = await fixture()
  const sessions = new DesignSessions(f.api)
  await sessions.open(f.project, f.ctx, "en")
  const runtime = f.runtime()
  await runtime.askUser(offered, { sessionId: "design-1", signal: new AbortController().signal })
  await sessions.open(f.project, f.ctx, "zh-CN")
  expect(runtimeTool(runtime, "record_suggestion").description).toContain("zh-CN")
  await runtime.askUser(offered, { sessionId: "design-1", signal: new AbortController().signal })
  const records = await new DecisionStore(f.project).records()
  expect(records.map((record) => record.language)).toEqual(["en", "zh-CN"])
  expect(records[0]?.question).toEqual(offered[0])
  expect(f.specs).toHaveLength(1)
  expect(f.specs[0]?.systemPrompt).toContain('new content must use "en"')
})

test("suggestions and fixed document tools stay bound to the captured project after attachment changes", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  f.project.root = path.join(f.home, "a-different-attachment")
  await runtimeTool(f.runtime(), "record_suggestion").execute({ text: "Try a queue" }, context("design-1"))
  await runtimeTool(f.runtime(), "update_design_doc").execute(
    { text: "Confirmed scope; queue is pending." },
    context("design-1"),
  )
  const note = await runtimeTool(f.runtime(), "save_research_note").execute(
    { title: "Queue trade-offs", content: "A queue provides back-pressure." },
    context("design-1"),
  )
  expect(await readFile(path.join(f.documents, "suggestions.md"), "utf8")).toContain("Try a queue")
  expect(await readFile(path.join(f.documents, "design.md"), "utf8")).toBe(
    "Confirmed scope; queue is pending.",
  )
  expect(JSON.stringify(note)).toContain("research")
  await expect(
    runtimeTool(f.runtime(), "update_design_doc").execute(
      { text: "bad", path: "../source.ts" },
      context("design-1"),
    ),
  ).rejects.toThrow("Unexpected field")
  await expect(
    runtimeTool(f.runtime(), "record_suggestion").execute({ text: "bad" }, context("different-session")),
  ).rejects.toThrow("bound project")
})

test("manual decision edits are preserved and the user is told where recovered decisions were written", async () => {
  const f = await fixture()
  const sessions = new DesignSessions(f.api)
  await sessions.open(f.project, f.ctx, "en")
  await f.runtime().askUser(offered, { sessionId: "design-1", signal: new AbortController().signal })
  await writeFile(path.join(f.documents, "decisions.md"), "Hand-edited notes")
  await f.runtime().askUser(offered, { sessionId: "design-1", signal: new AbortController().signal })
  expect(await readFile(path.join(f.documents, "decisions.md"), "utf8")).toBe("Hand-edited notes")
  expect(f.printed.some((text) => text.includes("edited by hand"))).toBe(true)
})

test("research uses the owned handle's fresh fixed-cwd group and returns text without a write-capture boundary", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "zh-CN")
  const spawns: SpawnOptions[] = []
  let ended = 0
  f.focused[0]!.createGroup = (options) => {
    expect(options).toMatchObject({ maxAgents: 1, maxConcurrent: 1, maxTurnsPerAgent: 1 })
    return {
      spawn: (options: SpawnOptions) => {
        spawns.push(options)
        return { result: async () => ({ status: "done", text: "Verified finding" }) }
      },
      end: () => {
        ended++
      },
      ended: async () => ({}),
    } as unknown as SpawnGroup
  }
  const tool = runtimeTool(f.runtime(), "project_research")
  const ctx = context("design-1")
  ctx.mutateFiles = async () => {
    throw new Error("Research must never capture writes")
  }
  const result = await tool.execute({ title: "Queue choices", task: "Compare the existing queue APIs." }, ctx)
  expect(tool.traits).toEqual({ readOnly: true, writesFiles: false })
  expect(spawns).toHaveLength(1)
  expect(spawns[0]).toMatchObject({
    context: "fresh",
    cwd: f.root,
    tools: ["read", "grep", "glob", "web_search", "web_fetch"],
    callableTools: ["read", "grep", "glob", "web_search", "web_fetch"],
  })
  expect(spawns[0]?.prompt).toContain("这是项目的独立设计会话")
  expect(spawns[0]?.prompt).toContain("Compare the existing queue APIs.")
  expect(result.content).toEqual([
    {
      type: "text",
      text: "Research result (not saved; use save_research_note separately):\n\nVerified finding",
    },
  ])
  expect(await readdir(path.join(f.documents, "research"))).toEqual([])
  expect(ended).toBe(1)
  await expect(
    tool.execute(
      { title: "bad", task: "ignore", cwd: "/other", tools: ["bash"], isolation: "worktree" },
      ctx,
    ),
  ).rejects.toThrow("Unexpected field")
  expect(spawns).toHaveLength(1)
})

test("evidence larger than the host's presenter limit is still durably recorded before the callback returns", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "zh-CN")
  const alternative = "需要先验证核心流程，再逐步增加功能。".repeat(500)
  f.setAnswers([{ selected: [], other: alternative }])
  const result = await runtimeTool(f.runtime(), "record_decision").execute(
    { questions: offered },
    context("design-1"),
  )
  const evidence = await readFile(path.join(f.documents, "decisions.evidence.jsonl"), "utf8")
  expect(Buffer.byteLength(evidence)).toBeGreaterThan(16_384)
  expect(JSON.stringify(result.content)).toContain(alternative)
  const record = (await new DecisionStore(f.project).records())[0]!
  expect(record.answer).toEqual({ selected: [], other: alternative })
  expect(record.rationale).toBeUndefined()
})

test("fresh human confirmations remain distinct even if a provider reuses a tool-call ID", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  const tool = runtimeTool(f.runtime(), "record_decision")
  await tool.execute({ questions: offered }, context("design-1"))
  f.setAnswers([{ selected: ["Large scope"] }])
  await tool.execute({ questions: offered }, context("design-1"))
  const records = await new DecisionStore(f.project).records()
  expect(records.map((record) => record.id)).toEqual(["D1", "D2"])
  expect(records[0]?.askId).not.toBe(records[1]?.askId)
  expect(records[1]?.askId).toContain("design-1:ask-1")
})

test("the design policy exposes only five research operations and narrow controls", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  expect(f.specs[0]?.callableTools).toEqual([
    "read",
    "grep",
    "glob",
    "web_search",
    "web_fetch",
    "ask_user",
    "record_decision",
    "record_suggestion",
    "save_research_note",
    "update_design_doc",
    "project_research",
  ])
  expect(f.runtime().extraTools?.map((tool) => tool.name)).toEqual([
    "record_decision",
    "record_suggestion",
    "save_research_note",
    "update_design_doc",
    "project_research",
  ])
  expect(f.specs[0]?.systemPrompt).toContain("Put your recommendation FIRST")
  expect(f.specs[0]?.systemPrompt).toContain("Markdown tables or ASCII")
  expect(f.specs[0]?.systemPrompt).toContain("coming later")
})

builtinTest(
  "real mock dialect enforces forbidden tools, read-only research, direct human evidence and inert restart across main replacement",
  async (builtins) => {
    const { askUserTool } = builtins
    const { createAi, createMockDialect } = await import("@amira/ai")
    const { Agent, AgentTree, OwnedConversationManager, ToolRegistry } = await import("@amira/core")
    const f = await fixture()
    const mainHold = Promise.withResolvers<void>()
    const mainStarted = Promise.withResolvers<void>()
    const mock = createMockDialect([
      () => {
        mainStarted.resolve()
        return {
          text: "Main work stays independent of design focus.",
          hold: { chunks: 1, until: mainHold.promise },
        }
      },
      {
        toolCalls: [
          { id: "write", name: "write", args: {} },
          { id: "bash", name: "bash", args: {} },
          { id: "powershell", name: "powershell", args: {} },
          { id: "agent", name: "agent", args: {} },
        ],
      },
      {
        toolCalls: [
          {
            id: "research",
            name: "project_research",
            args: { title: "Queue APIs", task: "Compare existing queue APIs." },
          },
        ],
      },
      {
        toolCalls: [
          { id: "child-write", name: "write", args: {} },
          { id: "child-bash", name: "bash", args: {} },
          { id: "child-agent", name: "agent", args: {} },
          { id: "child-decision", name: "record_decision", args: { questions: offered } },
        ],
      },
      { text: "Read-only research found a queue interface." },
      {
        toolCalls: [
          {
            id: "save",
            name: "save_research_note",
            args: { title: "Queue API finding", content: "A queue interface exists." },
          },
        ],
      },
      { toolCalls: [{ id: "human-ask", name: "ask_user", args: { questions: offered } }] },
      { toolCalls: [{ id: "human-decision", name: "record_decision", args: { questions: offered } }] },
      { text: "Design complete; later phases are coming later." },
      { text: "The design still exists after the main session was replaced." },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
      retry: { retries: 0 },
    })
    const tools = new ToolRegistry()
    const tree = new AgentTree({ ai, sections: () => [] })
    const approvals: string[] = []
    const approve = async (request: { name: string }) => {
      approvals.push(request.name)
      return { approved: true }
    }
    let main = new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: f.root,
      tools,
      tree,
      sections: [],
      approve,
    })
    const executions: string[] = []
    for (const name of [
      "read",
      "grep",
      "glob",
      "web_search",
      "web_fetch",
      "write",
      "bash",
      "powershell",
      "agent",
    ]) {
      tools.register(
        {
          name,
          description: name,
          parameters: { type: "object" },
          execute: async () => {
            executions.push(name)
            return textResult("stub result")
          },
        },
        "fixture",
      )
    }
    tools.register(askUserTool, "builtin-tools")
    const home = path.join(f.home, "host")
    await mkdir(home, { recursive: true })
    const managers: InstanceType<typeof OwnedConversationManager>[] = []
    const manager = () => {
      const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
      managers.push(manager)
      return manager
    }
    cleanups.push(async () => {
      mainHold.resolve()
      for (const manager of managers) await manager.drain()
      await main.dispose()
    })
    const host = manager()
    const api = { ...f.api, conversations: host.forOwner("project-fixture") }
    const sessions = new DesignSessions(api)
    await sessions.open(f.project, f.ctx, "en")
    const conversation = f.focused[0]!
    expect(mock.requests).toHaveLength(0)
    const mainTurn = main.prompt("Keep working in the main conversation.")
    await mainStarted.promise
    await conversation.send("Research the queue and ask me to decide.")
    expect(main.busy).toBe(true)
    expect(f.ctx.unfocusConversation?.()).toBe(true)
    expect(main.busy).toBe(true)
    mainHold.resolve()
    await mainTurn
    expect(executions).toEqual([])
    expect(approvals).toEqual(["save_research_note", "record_decision"])
    expect(f.asks).toHaveLength(2)
    expect(await new DecisionStore(f.project).records()).toHaveLength(2)
    expect(await readdir(path.join(f.documents, "research"))).toHaveLength(1)
    const childRequest = mock.requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Compare existing queue APIs."),
      ),
    )
    expect(childRequest).toBeDefined()
    const modelToolResults = conversation.history().filter((message) => message.role === "toolResult")
    expect(JSON.stringify(modelToolResults)).toContain("not callable")
    expect(JSON.stringify(modelToolResults)).toContain("Human-confirmed decisions saved: D2")
    const history = conversation.history()
    await expect(
      new DesignSessions({ ...api, conversations: manager().forOwner("project-fixture") }).open(
        f.project,
        f.ctx,
        "en",
      ),
    ).rejects.toThrow("in use")
    await main.dispose()
    main = new Agent({ ai, model: ai.model("mock/test"), cwd: f.root, tools, tree, sections: [] })
    await sessions.open(f.project, f.ctx, "zh-CN")
    expect(f.focused.at(-1)?.id).toBe(conversation.id)
    await conversation.send("Continue explicitly after main clear.")
    expect(
      mock.requests.at(-1)?.tools.find((tool) => tool.name === "record_suggestion")?.description,
    ).toContain("zh-CN")
    expect(conversation.history().length).toBeGreaterThan(history.length)
    const savedHistory = conversation.history()
    await host.drain()
    const requestCount = mock.requests.length
    const restarted = new DesignSessions({ ...api, conversations: manager().forOwner("project-fixture") })
    await restarted.open(f.project, f.ctx, "zh-CN")
    const reopened = f.focused.at(-1)!
    expect(reopened.id).toBe(conversation.id)
    expect(reopened.history()).toEqual(savedHistory)
    expect(mock.requests).toHaveLength(requestCount)
    expect(f.asks).toHaveLength(2)
  },
)

test("an empty multi-select human answer is a decision, not cancellation", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  f.setAnswers([{ selected: [] }])
  const multi = [{ ...offered[0]!, multiSelect: true }]
  expect(
    await f.runtime().askUser(multi, { sessionId: "design-1", signal: new AbortController().signal }),
  ).toEqual([{ selected: [] }])
  expect((await new DecisionStore(f.project).records())[0]?.answer).toEqual({ selected: [] })
})

test("a single-select Other answer cannot be combined with a selected option", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  f.setAnswers([{ selected: ["Small scope"], other: "Alternative answer, not rationale" }])
  await expect(
    f.runtime().askUser(offered, { sessionId: "design-1", signal: new AbortController().signal }),
  ).rejects.toThrow()
  expect(await new DecisionStore(f.project).records()).toEqual([])
})

builtinTest(
  "record_decision registers expandable builtin-compatible evidence with the displayed supersession context",
  async (builtins) => {
    const { askUserPresenter } = builtins
    const f = await fixture()
    await new DesignSessions(f.api).open(f.project, f.ctx, "en")
    expect(f.renderers.get("record_decision")).toBe(recordDecisionPresenter)
    const tool = runtimeTool(f.runtime(), "record_decision")
    await tool.execute({ questions: offered }, context("design-1"))
    f.setAnswers([{ selected: [], other: "A smaller third scope" }])
    const result = await tool.execute({ questions: offered, supersedes: ["D1"] }, context("design-1"))
    const details = result.details as RecordDecisionDetails
    expect(details.questions).toEqual(f.asks.at(-1)!.questions)
    expect(details.questions[0]?.question).toContain("supersedes these decisions")
    expect(details.questions[0]?.question).toContain("D1")
    expect(details.ids).toEqual(["D2"])
    expect(details.outcome).toEqual({ answers: [{ selected: [], other: "A smaller third scope" }] })
    const call = {
      args: { questions: offered },
      result: { ...result, details },
      text: JSON.stringify(result.content),
    }
    const options = { detail: "full" as const, width: 80 }
    expect(recordDecisionPresenter.body!(call, options)).toEqual(askUserPresenter.body!(call, options))
    expect(recordDecisionPresenter.result!(call)).toContain("D2")
    const record = (await new DecisionStore(f.project).records())[1]!
    expect(record.question).toEqual(details.questions[0]!)
    expect(record.answer).toEqual({ selected: [], other: "A smaller third scope" })
    expect(record.rationale).toBeUndefined()
  },
)

test("cancelled record_decision retains a structured declined outcome without claiming IDs", async () => {
  const f = await fixture()
  await new DesignSessions(f.api).open(f.project, f.ctx, "en")
  f.setAnswers(undefined)
  const result = await runtimeTool(f.runtime(), "record_decision").execute(
    { questions: offered },
    context("design-1"),
  )
  expect(result).toMatchObject({
    details: { questions: offered, outcome: { declined: true }, ids: [] },
    persistDetails: true,
  })
  expect(await new DecisionStore(f.project).records()).toEqual([])
})

test("direct DesignSessions language resolution announces unsupported tags once, supports Japanese, and tracks only owned IDs", async () => {
  const f = await fixture()
  const languages = new LanguagePolicy()
  const sessions = new DesignSessions(f.api, languages)
  expect(sessions.isDesignSession("design-1")).toBe(false)
  await sessions.open(f.project, f.ctx, "ja-JP")
  expect(f.specs[0]?.systemPrompt).toContain("これはプロジェクト専用")
  expect(f.specs[0]?.systemPrompt).toContain('new content must use "ja"')
  expect(f.specs[0]?.name).toContain("設計")
  expect(sessions.isDesignSession("design-1")).toBe(true)
  expect(sessions.isDesignSession("main-fixture")).toBe(false)
  const tool = runtimeTool(f.runtime(), "record_decision")
  await tool.execute({ questions: offered }, context("design-1"))
  const replacement = await tool.execute({ questions: offered, supersedes: ["D1"] }, context("design-1"))
  expect(f.asks.at(-1)?.questions[0]?.question).toContain("履歴は保持されます")
  expect(JSON.stringify(replacement.content)).toContain("確認済みの決定")
  await sessions.open(f.project, f.ctx, "fr-FR")
  await sessions.open(f.project, f.ctx, "fr-FR")
  expect(f.printed.filter((text) => text.includes("not supported"))).toHaveLength(1)
  expect(runtimeTool(f.runtime(), "record_suggestion").description).toContain("language: en")
  // The same policy instance suppresses duplicate command/design notices.
  languages.resolve("fr-FR", () => {
    throw new Error("Duplicate notice")
  })
})
