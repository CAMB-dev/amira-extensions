import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  ExtensionView,
  PermissionMode,
  SpawnGroupOptions,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UserMessage,
  ViewDefinition,
} from "@amira/api"
import type { DashboardSource } from "../src/dashboard.ts"
import { asksForWorkflow, createWorkflowExtension, readSettings } from "../src/index.ts"
import { listRuns, readJournal, readRun } from "../src/journal.ts"
import type { ScriptWorker } from "../src/run.ts"
import type { RunnerResult as BoundResult, RunnerOwner, RunSnapshot, WorkflowRunner } from "../src/runner.ts"
import type { RunGit } from "../src/worktree.ts"
import { type Answer, type FakeGroup, fakeGroup } from "./fakes.ts"

const dirs: string[] = []
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SCRIPT = `export const meta = { name: "fanout", description: "Three looks and a check", phases: ["Explore", "Verify"] }
phase("Explore")
const found = await parallel([
  () => agent("look at api", { label: "api" }),
  () => agent("look at core", { label: "core" }),
  () => agent("look at tui", { label: "tui" }),
])
phase("Verify")
return await agent("verify " + found.join(", "), { label: "verify" })
`

type Handler = (e: { sessionId: string; parentSessionId?: string; data: unknown }) => void

type RunnerResult = {
  runId: string
  name: string
  status: string
  startedBy?: { sessionId: string; label: string }
  result?: unknown
  error?: string
}
interface Runner {
  start(
    request: {
      script?: string
      name?: string
      args?: unknown
      startedBy: { sessionId: string; label: string }
    },
    ctx: ToolContext,
  ): Promise<{ runId: string } | { error: string }>
  status(runId: string): RunnerResult | undefined
  stop(runId: string): boolean
  onResult(runId: string, listener: (result: RunnerResult) => void): () => void
}

function setup(
  opts: {
    settings?: Record<string, unknown>
    confirm?: boolean | undefined
    confirmDialog?: (signal?: AbortSignal) => Promise<boolean | undefined>
    permissionMode?: PermissionMode
    noSession?: boolean
    answer?: (o: { prompt: string }) => Answer | Promise<Answer>
    /** false: the session has no file yet (runs go to ~/.amira/workflow-runs). */
    sessionFile?: false
    git?: RunGit
    worker?: () => ScriptWorker
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "wf-ext-"))
  dirs.push(root)
  const cwd = path.join(root, "project")
  const home = path.join(root, "home")
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home, { recursive: true })
  let tool!: ToolDefinition
  let command!: CommandDefinition
  let view!: ViewDefinition
  const handlers = new Map<string, Handler[]>()
  const confirms: { title: string; message: string | undefined; sessionId?: string }[] = []
  const errors: string[] = []
  /** What the extension told the user (api.notify). */
  const told: string[] = []
  const groups: FakeGroup[] = []
  const notices: UserMessage[] = []
  const services = new Map<string, unknown>()
  const exits: (() => unknown)[] = []
  let dashboard!: DashboardSource
  services.set("dashboard.sources", {
    register(source: DashboardSource) {
      dashboard = source
      return () => {}
    },
  })
  let cancelled = 0
  let expected = 0
  let confirmAnswer: boolean | undefined = "confirm" in opts ? opts.confirm : true
  let permissionMode = opts.permissionMode
  const answer = opts.answer ?? ((o: { prompt: string }) => ({ text: `saw ${o.prompt.split(" ").at(-1)}` }))
  const api = {
    apiVersion: "0.1.0",
    provideService(name: string, value: unknown) {
      services.set(name, value)
      return () => {
        services.delete(name)
      }
    },
    useService: (name: string) => services.get(name),
    onExit: (dispose: () => unknown) => {
      exits.push(dispose)
      cleanup.push(dispose)
    },
    cwd,
    home,
    settings: { extensions: { workflow: opts.settings } },
    session: () =>
      opts.noSession
        ? undefined
        : { info: () => ({ permissions: permissionMode ? { mode: permissionMode, rules: 0 } : undefined }) },
    registerTool: (t: ToolDefinition) => {
      tool = t
      return () => {}
    },
    registerCommand: (c: CommandDefinition) => {
      command = c
      return () => {}
    },
    registerView: (v: ViewDefinition) => {
      view = v
      return () => {}
    },
    registerToolRenderer: () => () => {},
    registerStatusItem: () => () => {},
    registerSkill: () => () => {},
    requestRender: () => {},
    reportError: (e: string) => errors.push(e),
    notify: (t: string) => told.push(t),
    runCommand: async () => ({ output: "", exitCode: 1 }),
    ui: {
      confirm: async (
        title: string,
        message?: string,
        options?: { signal?: AbortSignal; sessionId?: string },
      ) => {
        confirms.push({ title, message, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) })
        return opts.confirmDialog ? opts.confirmDialog(options?.signal) : confirmAnswer
      },
    },
    on: (type: string, h: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h])
      return () => {}
    },
    intercept: () => () => {},
  } as unknown as ExtensionAPI
  createWorkflowExtension({ git: opts.git, worker: opts.worker })(api)
  const emit = (type: string, e: { sessionId?: string; parentSessionId?: string; data: unknown }) => {
    for (const h of handlers.get(type) ?? []) h({ sessionId: "s_root", ...e })
  }
  emit("session.start", {
    data: {
      reason: "startup",
      ...(opts.sessionFile === false ? {} : { sessionFile: path.join(home, "sessions", "s_root.jsonl") }),
    },
  })
  const say = (text: string) =>
    emit("turn.start", { data: { prompt: { role: "user", content: [{ type: "text", text }] } } })
  const createGroup = (o: SpawnGroupOptions) => {
    const g = fakeGroup(o, answer)
    groups.push(g)
    return g
  }
  const session = (depth = 0) => ({
    sessionId: depth ? "s_child" : "s_root",
    depth,
    maxDepth: 2,
    createGroup,
    expectNotice: () => {
      expected++
      return {
        deliver: (m: UserMessage) => notices.push(m),
        cancel: () => cancelled++,
      }
    },
  })
  const call = (params: Record<string, unknown>, depth = 0): Promise<ToolResult> =>
    tool.execute(params, {
      cwd,
      toolCallId: "c1",
      signal: new AbortController().signal,
      update: () => {},
      session: session(depth),
    } as unknown as ToolContext)
  const printed: string[] = []
  const opened: ExtensionView[] = []
  const sent: string[] = []
  const commandContext = {
    cwd,
    frontend: "tui",
    signal: new AbortController().signal,
    ui: api.ui,
    print: (t: string) => printed.push(t),
    openView: (v: ExtensionView) => opened.push(v),
    session: {
      ...session(),
      send: async (text: string) => {
        sent.push(text)
      },
    },
  } as unknown as CommandContext
  const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("")
  return {
    cwd,
    home,
    runner: services.get("workflow.runner") as WorkflowRunner,
    async dispose() {
      for (const exit of exits) await exit()
    },
    dashboard,
    memberContext: (signal = new AbortController().signal) =>
      ({
        cwd,
        toolCallId: "member-call",
        signal,
        update: () => {},
        session: session(1),
      }) as unknown as ToolContext,
    get tool() {
      return tool
    },
    get view() {
      return view
    },
    run: (line: string) => command.run(line, commandContext),
    call,
    say,
    emit,
    text,
    confirms,
    errors,
    told,
    groups,
    notices,
    printed,
    opened,
    sent,
    setPermissionMode(mode: PermissionMode) {
      permissionMode = mode
    },
    /** What the user answers the next confirmations with. */
    answerConfirm(v: boolean | undefined) {
      confirmAnswer = v
    },
    get cancelled() {
      return cancelled
    },
    get expected() {
      return expected
    },
  }
}

async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const startedBy = { sessionId: "s_child", label: "researcher" }

test("runner auto start shares limits, journal, progress and dashboard attribution; results replay", async () => {
  const t = setup({ permissionMode: "auto", settings: { maxAgents: 7, maxConcurrent: 2 } })
  // Existing consumers can keep their old structural contract unchanged.
  const legacy: Runner = t.runner
  const start = await legacy.start({ script: SCRIPT, args: { topic: "api" }, startedBy }, t.memberContext())
  if ("error" in start) throw new Error(start.error)
  expect(t.confirms).toHaveLength(0)
  expect(t.groups[0]!.options).toMatchObject({ maxAgents: 7, maxConcurrent: 2 })
  expect(t.groups[0]!.options.budget).toBeUndefined()
  expect(t.runner.status(start.runId)).toMatchObject({ runId: start.runId, startedBy })
  expect(t.runner.status("unknown")).toBeUndefined()
  const results: RunnerResult[] = []
  t.runner.onResult(start.runId, (result) => results.push(result))
  await until(() => results.length === 1)
  expect(results[0]).toMatchObject({ status: "done", startedBy, result: "saw tui" })
  const record = readRun(path.join(t.home, "sessions", "workflows", start.runId))!.record
  expect(record).toMatchObject({ startedBy, args: { topic: "api" }, status: "done" })
  expect(t.groups[0]!.statuses.some((line) => line.includes("researcher"))).toBe(true)
  const header = t.view.header!({ id: start.runId }, { now: Date.now(), width: 80 })
  expect(JSON.stringify(header)).toContain("Started by: researcher (s_child)")
  const phases = t.dashboard.snapshot().phases
  expect(phases[0]!.name).toContain("researcher")
  const agent = phases[0]!.groups[0]!.agents[0]!
  expect(JSON.stringify(t.dashboard.details(agent.id))).toContain("Started by: researcher (s_child)")
  // Workflow children cannot inherit orchestration or the member's private tools.
  for (const spawned of t.groups[0]!.spawned) {
    expect(spawned.extraTools).toBeUndefined()
    expect(spawned.cwd).toBe(t.cwd)
    expect(spawned.context).toBe("fresh")
    for (const name of [
      "swarm",
      "workflow",
      "start_workflow",
      "workflow_status",
      "stop_workflow",
      "send_message",
      "blackboard_read",
      "blackboard_write",
      "list_agents",
      "finish",
    ])
      expect(spawned.excludeTools).toContain(name)
  }
  t.runner.onResult(start.runId, (result) => results.push(result))
  const unsubscribe = t.runner.onResult(start.runId, () => {
    throw new Error("unsubscribed")
  })
  unsubscribe()
  await until(() => results.length === 2)
  expect(t.errors).toEqual([])
  expect(t.expected).toBe(0)
  expect(t.notices).toEqual([])
  expect(t.runner.stop(start.runId)).toBe(false)
  // Resuming from the main session retains who originally started the run.
  await t.call({ resume: start.runId })
  await until(() => t.notices.length === 1)
  expect(t.runner.status(start.runId)?.startedBy).toEqual(startedBy)
})

test("workflow agents exclude orchestrators even in saved sub-workflows with a role allowlist", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const agentsDir = path.join(t.cwd, ".amira", "agents")
  const savedDir = path.join(t.cwd, ".amira", "workflows")
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(savedDir, { recursive: true })
  const denied = ["swarm", "workflow", "start_workflow", "workflow_status", "stop_workflow", "send_message"]
  writeFileSync(
    path.join(agentsDir, "nested.md"),
    `---\ntools: [read, ${denied.join(", ")}]\n---\nRead files.`,
  )
  writeFileSync(
    path.join(savedDir, "nested.ts"),
    'export const meta = { name: "nested", description: "Nested", phases: [] }; return await agent("read", { role: "nested" })',
  )
  const script =
    'export const meta = { name: "parent", description: "Parent", phases: [] }; return await workflow("nested", {})'
  const started = await t.runner.start({ script, startedBy }, t.memberContext())
  if ("error" in started) throw new Error(started.error)
  await until(() => t.runner.status(started.runId)?.status === "done")
  expect(t.groups).toHaveLength(1)
  const child = t.groups[0]!.spawned[0]!
  expect(child.tools).toEqual(["read", ...denied])
  for (const name of denied) expect(child.excludeTools).toContain(name)
  expect(child.extraTools).toBeUndefined()
})

test("runner follows D106 for auto, ask, always, never and missing permissions", async () => {
  for (const entry of [
    { settings: {}, permissionMode: "auto", asks: false, starts: true },
    { settings: {}, permissionMode: "edits", asks: true, starts: true },
    { settings: {}, permissionMode: "plan", asks: true, starts: true },
    { settings: {}, asks: true, starts: true },
    { settings: { enabled: "ask" }, permissionMode: "auto", asks: true, starts: true },
    { settings: { enabled: "always" }, permissionMode: "plan", asks: false, starts: true },
    { settings: { enabled: "never" }, permissionMode: "auto", asks: false, starts: false },
  ] as const) {
    const t = setup({
      settings: entry.settings,
      permissionMode: "permissionMode" in entry ? entry.permissionMode : undefined,
    })
    const start = await t.runner.start({ script: SCRIPT, startedBy }, t.memberContext())
    expect("runId" in start).toBe(entry.starts)
    expect(t.confirms.length).toBe(entry.asks ? 1 : 0)
    if (entry.asks) expect(t.confirms[0]!.message).toContain("Started by: researcher (s_child)")
    if ("runId" in start) await until(() => t.runner.status(start.runId)?.status === "done")
    else expect(start.error).toContain("turned off")
  }
})

test("runner shares validation, saved sources, decline suppression and cancellation", async () => {
  const t = setup({ settings: { enabled: "ask" }, confirm: false })
  const ctx = t.memberContext()
  expect(await t.runner.start({ script: "return 1", startedBy }, ctx)).toHaveProperty("error")
  expect(t.confirms).toHaveLength(0)
  const dir = path.join(t.cwd, ".amira", "workflows")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "fanout.ts"), SCRIPT)
  const denied = await t.runner.start({ name: "fanout", startedBy }, ctx)
  expect(denied).toHaveProperty("error")
  expect(JSON.stringify(denied)).toContain("declined")
  t.answerConfirm(true)
  expect(JSON.stringify(await t.runner.start({ script: SCRIPT, startedBy }, ctx))).toContain(
    "already declined",
  )
  expect(t.confirms).toHaveLength(1)
  t.say("use a workflow")
  const started = await t.runner.start({ name: "fanout", startedBy }, ctx)
  if ("error" in started) throw new Error(started.error)
  await until(() => t.runner.status(started.runId)?.status === "done")
  expect(readRun(path.join(t.home, "sessions", "workflows", started.runId))!.record.source).toBe(
    path.join(dir, "fanout.ts"),
  )
  const abort = new AbortController()
  abort.abort()
  expect(
    JSON.stringify(await t.runner.start({ script: SCRIPT, startedBy }, t.memberContext(abort.signal))),
  ).toContain("cancelled")
  expect(t.groups).toHaveLength(1)
})

test("runner waits for user confirmation and cancels an outstanding dialog", async () => {
  for (const cancel of [false, true]) {
    let confirm!: (yes: boolean) => void
    const t = setup({
      settings: { enabled: "ask" },
      confirmDialog: (signal) =>
        new Promise((resolve) => {
          confirm = resolve
          signal?.addEventListener("abort", () => resolve(undefined), { once: true })
        }),
    })
    const abort = new AbortController()
    const pending = t.runner.start({ script: SCRIPT, startedBy }, t.memberContext(abort.signal))
    expect(t.confirms).toHaveLength(1)
    expect(t.groups).toHaveLength(0)
    if (cancel) abort.abort()
    else confirm(true)
    const result = await pending
    if (cancel) {
      expect(result).toEqual({ error: "The workflow start was cancelled." })
      expect(t.groups).toHaveLength(0)
    } else {
      if ("error" in result) throw new Error(result.error)
      await until(() => t.runner.status(result.runId)?.status === "done")
    }
  }
})

test("runner stop settles agents and delivers failure without a root notice", async () => {
  const t = setup({ settings: { enabled: "always" }, answer: () => new Promise(() => {}) })
  const started = await t.runner.start({ script: SCRIPT, startedBy }, t.memberContext())
  if ("error" in started) throw new Error(started.error)
  await until(() => t.groups[0]!.spawned.length > 0)
  const result = new Promise<RunnerResult>((resolve) => t.runner.onResult(started.runId, resolve))
  expect(t.runner.stop(started.runId)).toBe(true)
  expect(await result).toMatchObject({ status: "stopped", startedBy, error: "stopped by the caller" })
  expect(t.groups[0]!.endReason).toBeDefined()
  expect(t.runner.stop(started.runId)).toBe(false)
  expect(t.runner.stop("unknown")).toBe(false)
  expect(t.notices).toEqual([])
})

test("extension disposal cancels pending starts and rejects a cached runner", async () => {
  const t = setup({
    settings: { enabled: "ask" },
    confirmDialog: (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      }),
  })
  const pending = t.runner.start({ script: SCRIPT, startedBy }, t.memberContext())
  expect(t.confirms).toHaveLength(1)
  await t.dispose()
  expect(await pending).toEqual({ error: "The workflow start was cancelled." })
  expect(await t.runner.start({ script: SCRIPT, startedBy }, t.memberContext())).toEqual({
    error: "The workflow start was cancelled.",
  })
  expect(t.confirms).toHaveLength(1)
  expect(t.groups).toHaveLength(0)
})

test("ending a member's group stops even a script waiting without agents", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const script =
    'export const meta = { name: "wait", description: "Wait", phases: [] }; await new Promise(() => {})'
  const started = await t.runner.start({ script, startedBy }, t.memberContext())
  if ("error" in started) throw new Error(started.error)
  const ended = new Promise<RunnerResult>((resolve) => t.runner.onResult(started.runId, resolve))
  t.groups[0]!.end("the member ended")
  expect(await ended).toMatchObject({ status: "stopped", startedBy })
  expect(t.runner.status(started.runId)?.status).toBe("stopped")
})

test("runner reports script failures to its subscriber", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const script =
    'export const meta = { name: "fails", description: "Fails", phases: [] }; throw new Error("broken script")'
  const started = await t.runner.start({ script, startedBy }, t.memberContext())
  if ("error" in started) throw new Error(started.error)
  const result = await new Promise<RunnerResult>((resolve) => t.runner.onResult(started.runId, resolve))
  expect(result.status).toBe("error")
  expect(result.error).toContain("broken script")
})

test("the tool is main-session only and refuses sub-agents that reach it anyway", async () => {
  const t = setup({ settings: { enabled: "always" } })
  expect(t.tool.mainOnly).toBe(true)
  const r = await t.call({ script: SCRIPT }, 1)
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(/only be started from the main session/)
  expect(t.confirms).toHaveLength(0)
})

test("the model may propose a workflow: the confirmation, marked as the model's proposal, is the gate", async () => {
  const t = setup()
  t.say("sweep this small repo for bugs with several agents")
  const r = await t.call({ script: SCRIPT })
  expect(t.text(r)).toMatch(/Started workflow run wf_\w+ \(fanout\) in the background/)
  expect(t.confirms).toHaveLength(1)
  expect(t.confirms[0]!.title).toBe('Start workflow "fanout"?')
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("The model proposes this workflow.")
  expect(t.confirms[0]!.message).toContain("Agents: 4, at most 30, 6 at a time.")
  await until(() => t.notices.length === 1, "the notice")
})

test("a user message asking for a workflow marks the confirmation as asked for", async () => {
  const t = setup()
  t.say("Use a workflow to review the three packages")
  const r = await t.call({ script: SCRIPT })
  expect(t.text(r)).toMatch(/Started workflow run wf_\w+ \(fanout\) in the background/)
  expect(t.confirms[0]!.title).toBe('Start workflow "fanout"?')
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  expect(t.confirms[0]!.message).toContain("Three looks and a check")
  expect(t.confirms[0]!.message).toContain("Phases: Explore → Verify")
  expect(t.confirms[0]!.message).toContain("Agents: 4, at most 30, 6 at a time.")
  expect(t.confirms[0]!.message).toContain("Cost: no cost cap.")
  expect(t.confirms[0]!.message).toContain(
    "Files: its agents work in your working tree and can change your files.",
  )
  // The result comes back as a notice with a short display line.
  await until(() => t.notices.length === 1, "the notice")
  const notice = t.notices[0]!
  const body = notice.content.map((c) => (c.type === "text" ? c.text : "")).join("")
  expect(body).toContain("finished")
  expect(body).toContain('"saw tui"')
  expect(notice.display?.origin).toBe("workflow")
  expect(notice.display?.text).toMatch(/^◆ workflow fanout ✓ 4 agents · \d+s · 400 tok$/)
  // The next user message that does not ask makes the next start the model's proposal again.
  t.say("thanks")
  expect((await t.call({ script: SCRIPT })).isError).toBeUndefined()
  expect(t.confirms[1]!.message!.split("\n")[0]).toBe("The model proposes this workflow.")
  await until(() => t.notices.length === 2)
})

test("asking for a workflow takes asking, not just the word", async () => {
  for (const yes of [
    "Use a workflow to review the three packages",
    "run this as a workflow please",
    "do it with a multi-agent workflow",
    "review everything via workflows",
    "try the workflow tool on this",
    "/workflow review it",
    "用工作流审查这三个包",
    "请使用一个工作流来做",
    "通过 workflow 跑一下",
  ]) {
    expect(`${yes}: ${asksForWorkflow(yes)}`).toBe(`${yes}: true`)
  }
  for (const no of [
    "fix the failing GitHub Actions workflow",
    "explain the workflow in .github/workflows/ci.yml",
    "our git workflow is rebase-then-merge",
    "the release workflow broke after the last commit",
    "修复失败的 GitHub 工作流",
    "这个工作流的 yaml 有问题",
  ]) {
    expect(`${no}: ${asksForWorkflow(no)}`).toBe(`${no}: false`)
  }
  // Mentioning one without asking leaves the start the model's proposal.
  const t = setup()
  t.say("fix the failing GitHub Actions workflow")
  await t.call({ script: SCRIPT })
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("The model proposes this workflow.")
  await until(() => t.notices.length === 1)
})

test("a notice turn does not count as the user asking or not asking", async () => {
  const t = setup()
  t.say("run this as a workflow please")
  t.emit("turn.start", {
    data: {
      prompt: {
        role: "user",
        content: [{ type: "text", text: "sub-agent done" }],
        display: { text: "◆", origin: "agent" },
      },
    },
  })
  expect((await t.call({ script: SCRIPT })).isError).toBeUndefined()
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  await until(() => t.notices.length === 1)
})

test('settings: "always" starts without asking, "never" refuses even when asked; limits come from settings', async () => {
  const limits = setup({ settings: { maxAgents: 12, maxConcurrent: 3, budget: { tokens: 50000 } } })
  await limits.call({ script: SCRIPT })
  expect(limits.confirms[0]!.message).toContain("Agents: 4, at most 12, 3 at a time.")
  expect(limits.confirms[0]!.message).toContain("Cost: stops at 50k tokens.")
  await until(() => limits.notices.length === 1)
  const always = setup({
    settings: { enabled: "always", maxAgents: 12, maxConcurrent: 3, budget: { tokens: 50000 } },
    confirm: false,
  })
  always.say("do the thing")
  expect((await always.call({ script: SCRIPT })).isError).toBeUndefined()
  expect(always.confirms).toHaveLength(0)
  expect(always.groups[0]!.options).toEqual({
    name: "workflow fanout",
    maxAgents: 12,
    maxConcurrent: 3,
    budget: { tokens: 50000 },
    compact: true,
  })
  const never = setup({ settings: { enabled: "never" } })
  never.say("use a workflow")
  const refused = await never.call({ script: SCRIPT })
  expect(refused.isError).toBe(true)
  expect(never.text(refused)).toMatch(/turned off/)
  // /workflow <name> too.
  mkdirSync(path.join(never.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(path.join(never.cwd, ".amira", "workflows", "fanout.ts"), SCRIPT)
  await never.run("fanout")
  expect(never.printed.at(-1)).toMatch(/turned off/)
  expect(never.confirms).toHaveLength(0)
  expect(never.groups).toHaveLength(0)
  expect(never.expected).toBe(0)
})

test('default "mode" checks the current permission mode for each start', async () => {
  for (const permissionMode of ["auto", "edits", "plan"] as const) {
    const t = setup({ permissionMode })
    expect((await t.call({ script: SCRIPT })).isError).toBeUndefined()
    expect(t.confirms).toHaveLength(permissionMode === "auto" ? 0 : 1)
    expect(t.told).toEqual(
      permissionMode === "auto" ? ['Workflow "fanout" started without asking: permission mode is auto.'] : [],
    )
    await until(() => t.notices.length === 1)
  }
  const t = setup({ settings: { enabled: "mode" }, permissionMode: "auto" })
  await t.call({ script: SCRIPT })
  await until(() => t.notices.length === 1)
  expect(t.confirms).toHaveLength(0)
  t.setPermissionMode("edits")
  await t.call({ script: SCRIPT })
  await until(() => t.notices.length === 2)
  expect(t.confirms).toHaveLength(1)
  t.setPermissionMode("auto")
  await t.call({ script: SCRIPT })
  await until(() => t.notices.length === 3)
  expect(t.confirms).toHaveLength(1)
  expect(t.told).toHaveLength(2)
})

test('"mode" asks without a session or permission info', async () => {
  for (const noSession of [true, false]) {
    const t = setup({ noSession, confirm: false })
    expect((await t.call({ script: SCRIPT })).isError).toBe(true)
    expect(t.confirms).toHaveLength(1)
    expect(t.groups).toHaveLength(0)
  }
})

test('explicit "ask", "always" and "never" override the permission mode', async () => {
  for (const permissionMode of ["auto", "edits", "plan"] as const) {
    for (const enabled of ["ask", "always", "never"] as const) {
      const t = setup({ settings: { enabled }, permissionMode, confirm: false })
      t.say("use a workflow to review this")
      const r = await t.call({ script: SCRIPT })
      expect(Boolean(r.isError)).toBe(enabled !== "always")
      expect(t.confirms).toHaveLength(enabled === "ask" ? 1 : 0)
      expect(t.groups).toHaveLength(enabled === "always" ? 1 : 0)
      expect(t.told.some((text) => text.includes("permission mode is auto"))).toBe(false)
      if (enabled === "always") await until(() => t.notices.length === 1)
    }
  }
})

test("print mode: auto starts without a dialog; edits refuses without an answer", async () => {
  for (const permissionMode of ["auto", "edits"] as const) {
    const t = setup({ permissionMode, confirm: undefined })
    const r = await t.call({ script: SCRIPT })
    expect(Boolean(r.isError)).toBe(permissionMode === "edits")
    expect(t.confirms).toHaveLength(permissionMode === "auto" ? 0 : 1)
    expect(t.groups).toHaveLength(permissionMode === "auto" ? 1 : 0)
    if (permissionMode === "auto") await until(() => t.notices.length === 1)
    else expect(t.text(r)).toContain("Nobody confirmed")
  }
})

test("user requests and /workflow starts follow the permission mode too", async () => {
  for (const permissionMode of ["auto", "edits", "plan"] as const) {
    const t = setup({ permissionMode })
    t.say("use a workflow to review this")
    await t.call({ script: SCRIPT })
    await until(() => t.notices.length === 1)
    expect(t.confirms).toHaveLength(permissionMode === "auto" ? 0 : 1)
    mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
    writeFileSync(path.join(t.cwd, ".amira", "workflows", "fanout.ts"), SCRIPT)
    await t.run("fanout")
    await until(() => t.notices.length === 2)
    expect(t.confirms).toHaveLength(permissionMode === "auto" ? 0 : 2)
  }
})

test("defaults: a run's group gets 30 agents and 6 at once", async () => {
  const t = setup({ settings: { enabled: "always" } })
  await t.call({ script: SCRIPT })
  expect(t.groups[0]!.options).toMatchObject({ maxAgents: 30, maxConcurrent: 6, compact: true })
  expect(t.groups[0]!.options.budget).toBeUndefined()
})

test("declining the confirmation starts nothing and leaves no notice pending", async () => {
  const t = setup({ confirm: false })
  const r = await t.call({ script: SCRIPT })
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(
    /The user declined the workflow "fanout", so it did not start\. Do not propose it again/,
  )
  expect(t.groups).toHaveLength(0)
  expect(t.expected - t.cancelled).toBe(0)
  // The user is told how to start it after all.
  expect(t.told).toEqual([
    'Workflow "fanout" not started; it will not be proposed again in this session. To start it yourself, save the script as .amira/workflows/fanout.ts and run /workflow fanout.',
  ])
})

test("a declined workflow is not proposed again, by name or by script, until the user asks", async () => {
  const t = setup({ confirm: false })
  t.say("find the bugs")
  await t.call({ script: SCRIPT })
  expect(t.confirms).toHaveLength(1)
  t.answerConfirm(true)
  // The same name with another script, and the same script under another name: refused unasked.
  const edited = `${SCRIPT}\n// tweaked`
  const renamed = SCRIPT.replace('name: "fanout"', 'name: "fanout2"')
  for (const script of [edited, renamed]) {
    const again = await t.call({ script })
    expect(again.isError).toBe(true)
    expect(t.text(again)).toMatch(/already declined the workflow "fanout2?" in this session/)
  }
  expect(t.confirms).toHaveLength(1)
  // A later message that does not ask for one keeps it refused.
  t.say("ok, go on")
  expect((await t.call({ script: SCRIPT })).isError).toBe(true)
  expect(t.confirms).toHaveLength(1)
  // A different workflow may still be proposed.
  const other = SCRIPT.replace('name: "fanout"', 'name: "other"').replace("look at api", "look at cli")
  expect(t.text(await t.call({ script: other }))).toMatch(/Started workflow run/)
  expect(t.confirms).toHaveLength(2)
  // Once the user asks for a workflow, the declined one may be proposed again.
  t.say("fine, use a workflow for it after all")
  expect(t.text(await t.call({ script: SCRIPT }))).toMatch(/Started workflow run/)
  expect(t.confirms).toHaveLength(3)
  expect(t.confirms[2]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  await until(() => t.notices.length === 2)
})

test("a user's ask is used up by a decline: the same workflow again in that turn is refused", async () => {
  const t = setup({ confirm: false })
  t.say("use a workflow to review the packages")
  await t.call({ script: SCRIPT })
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  const again = await t.call({ script: SCRIPT })
  expect(t.text(again)).toMatch(/already declined/)
  expect(t.confirms).toHaveLength(1)
})

test("with nobody to confirm, a resume is started again with /workflow resume", async () => {
  const t = setup()
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  t.answerConfirm(undefined)
  expect(t.text(await t.call({ resume: id }))).toContain(
    `the user can run /workflow resume ${id} in the interactive UI`,
  )
})

test("the user's own /workflow gets messages meant for the user, and never refuses before compiling", async () => {
  const t = setup({ confirm: false })
  mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(path.join(t.cwd, ".amira", "workflows", "fanout.ts"), SCRIPT)
  await t.run("fanout")
  expect(t.printed.at(-1)).toBe('Workflow "fanout" not started.')
  t.answerConfirm(undefined)
  await t.run("fanout")
  expect(t.printed.at(-1)).toMatch(
    /^Nobody confirmed the workflow "fanout", so it did not start \(nobody can answer dialogs here\)\. Set extensions\.workflow\.enabled to "always"/,
  )
  const never = setup({ settings: { enabled: "never" } })
  expect(never.text(await never.call({ script: "no meta here" }))).toMatch(/turned off/)
  await expect(never.run("review the packages")).rejects.toThrow(/turned off/)
  expect(never.sent).toEqual([])
})

test("a new session forgets what was declined", async () => {
  const t = setup({ confirm: false })
  await t.call({ script: SCRIPT })
  t.emit("session.start", { sessionId: "s_other", data: { reason: "new" } })
  t.answerConfirm(true)
  expect(t.text(await t.call({ script: SCRIPT }))).toMatch(/Started workflow run/)
  expect(t.confirms).toHaveLength(2)
  await until(() => t.notices.length === 1)
})

test("with nobody to confirm (print mode, rpc without dialogs) the tool refuses and says how to start it", async () => {
  const t = setup({ confirm: undefined })
  const r = await t.call({ script: SCRIPT })
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(/Nobody confirmed the workflow "fanout", so it did not start/)
  expect(t.text(r)).toContain("save the script as .amira/workflows/fanout.ts and run /workflow fanout")
  expect(t.text(r)).toContain('extensions.workflow.enabled to "always"')
  expect(t.groups).toHaveLength(0)
  expect(t.expected - t.cancelled).toBe(0)
  // A saved workflow is started by name; it is not proposed again unasked either.
  mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(
    path.join(t.cwd, ".amira", "workflows", "echo.ts"),
    `export const meta = { name: "echo", description: "echoes", phases: [] }\nreturn await agent("x")`,
  )
  expect(t.text(await t.call({ name: "echo" }))).toMatch(/can run \/workflow echo in the interactive UI/)
  expect(t.text(await t.call({ name: "echo" }))).toMatch(/already declined/)
})

test('the setting "explicit" (the earlier default) reads as "ask"', () => {
  const errors: string[] = []
  expect(readSettings({ enabled: "explicit" }, (e) => errors.push(e))).toEqual({ enabled: "ask" })
  expect(readSettings({ enabled: "ask" })).toEqual({ enabled: "ask" })
  expect(errors).toEqual([])
})

test("a script without meta, or that does not compile, is refused with no notice pending", async () => {
  // A pending notice keeps print and RPC mode waiting for it: one taken for a run that never
  // starts would keep them waiting forever.
  const t = setup({ settings: { enabled: "always" } })
  const r = await t.call({ script: 'return await agent("x")' })
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(/export const meta/)
  const broken = await t.call({
    script: `export const meta = { name: "b", description: "b", phases: [] }\nreturn (`,
  })
  expect(t.text(broken)).toMatch(/does not compile/)
  expect(t.confirms).toHaveLength(0)
  expect(t.expected - t.cancelled).toBe(0)
  // The same through /workflow <saved name>.
  mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(path.join(t.cwd, ".amira", "workflows", "nometa.ts"), 'return await agent("x")')
  await t.run("nometa")
  expect(t.printed.at(-1)).toMatch(/export const meta/)
  expect(t.expected - t.cancelled).toBe(0)
  // A run that starts takes exactly one.
  await t.call({ script: SCRIPT })
  expect(t.expected).toBe(1)
  await until(() => t.notices.length === 1)
})

test("the estimate says dynamic when agents are started in loops", async () => {
  const t = setup()
  const dynamic = `export const meta = { name: "loop", description: "loops", phases: [] }
    return await parallel(args.map((x) => () => agent(x)))`
  await t.call({ script: dynamic, args: ["a"] })
  expect(t.confirms[0]!.message).toContain("Agents: 1 or more (some run in loops)")
})

test("tool status and list report completed runs and saved workflows without confirming", async () => {
  const t = setup({ answer: () => ({ text: "ok", tokens: 250, cost: 0.01 }) })
  mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(path.join(t.cwd, ".amira", "workflows", "fanout.ts"), SCRIPT)
  expect(t.text(await t.call({ action: "status" }))).toBe("No workflow has run in this session.")
  expect(t.text(await t.call({ action: "list" }))).toContain("fanout (project)")
  // Omitting action remains a start, including saved workflows and arguments.
  const r = await t.call({ name: "fanout", args: { value: 1 } })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  const status = t.text(await t.call({ action: "status", id }))
  expect(status).toContain(`Workflow run ${id} (fanout) · done`)
  expect(status).toContain("Phase: Verify")
  expect(status).toMatch(/4\/4 agents · 1\.0k tok · \$0\.04 · \d+s/)
  expect(status).toContain("├ ✓ Explore")
  expect(status).toContain("└ ✓ Verify")
  expect(t.text(await t.call({ action: "status" }))).toBe(status)
  const list = t.text(await t.call({ action: "list" }))
  expect(list).toContain("fanout (project) - Three looks and a check")
  expect(list).toContain(`${id} fanout · done · 4/4 agents`)
  expect(t.confirms).toHaveLength(1)
})

test("tool status reports failed agents and phases", async () => {
  const t = setup({ settings: { enabled: "always" }, answer: () => ({ error: "provider down" }) })
  const r = await t.call({ action: "start", script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  const status = t.text(await t.call({ action: "status", id }))
  expect(status).toContain(`Workflow run ${id} (fanout) · failed`)
  expect(status).toMatch(/\d+ failed/)
  expect(status).toContain("├ ✗ Explore")
  expect(status).toContain("└ ✗ Verify")
  expect(status).toContain("provider down")
})

test("tool stop stops one run or all running runs and their agents without confirmation", async () => {
  const t = setup({ answer: () => new Promise<Answer>(() => {}) })
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await t.call({ script: SCRIPT })
    ids.push(/run (wf_\w+)/.exec(t.text(r))![1]!)
  }
  await until(() => t.groups.every((g) => g.spawned.length === 3))
  const status = t.text(await t.call({ action: "status" }))
  for (const id of ids) expect(status).toContain(`Workflow run ${id} (fanout) · running`)
  expect(status).toContain("Phase: Explore")
  expect(status).toContain("0/3 agents · 3 working")
  expect(status).toContain("├ ● Explore")
  expect(status).toContain("└ ◌ Verify")
  t.answerConfirm(false)
  expect(t.text(await t.call({ action: "stop", id: ids[0] }))).toBe(
    `Stopped workflow run ${ids[0]} (fanout).`,
  )
  await until(() => t.notices.length === 1)
  expect(t.groups[0]!.children()).toHaveLength(0)
  expect(t.groups[1]!.endReason).toBeUndefined()
  expect(t.groups[2]!.endReason).toBeUndefined()
  expect(t.text(await t.call({ action: "status", id: ids[0] }))).toContain("· stopped")
  const stopped = t.text(await t.call({ action: "stop" }))
  expect(stopped).not.toContain(ids[0]!)
  for (const id of ids.slice(1)) expect(stopped).toContain(`Stopped workflow run ${id}`)
  await until(() => t.notices.length === 3)
  for (const g of t.groups) {
    expect(g.children()).toHaveLength(0)
    expect(g.endReason).toBeDefined()
  }
  expect(t.text(await t.call({ action: "stop" }))).toBe("No workflow is running.")
  expect(t.text(await t.call({ action: "stop", id: ids[0] }))).toContain("is not running")
  expect(t.confirms).toHaveLength(3)
})

test("tool controls are main-only and scoped to this session", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  for (const action of ["status", "list", "stop"]) {
    expect((await t.call({ action }, 1)).isError).toBe(true)
  }
  t.emit("session.start", { sessionId: "s_other", data: { reason: "new" } })
  expect(t.text(await t.call({ action: "status" }))).toBe("No workflow has run in this session.")
  expect(t.text(await t.call({ action: "list" }))).not.toContain(id)
  for (const action of ["status", "stop"]) {
    for (const target of [id, "wf_missing"]) {
      const result = await t.call({ action, id: target })
      expect(result.isError).toBe(true)
      expect(t.text(result)).toBe(`No workflow run ${target} in this session.`)
    }
  }
  expect((await t.call({ action: "unknown" })).isError).toBe(true)
  expect(t.groups).toHaveLength(1)
})

test("progress: the group's status follows phases and counts, and the view lists agents without metrics", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  const statuses = t.groups[0]!.statuses
  expect(statuses.some((s) => s.startsWith(`${id} · Explore · `))).toBe(true)
  expect(statuses.at(-1)).toMatch(new RegExp(`^${id} · Verify · 4/4 agents · 400 tok$`))
  const renderOptions = { now: Date.now(), width: 80 }
  const lines = t.view.render!({ id }, renderOptions).map((line) =>
    line.kind === "segments" ? line.parts.map((part) => part.text).join("") : line.text,
  )
  expect(lines[0]).toBe("Explore")
  expect(lines.slice(1, 4)).toEqual(["> v done    api", "  v done    core", "  v done    tui"])
  expect(lines[4]).toBe("Verify")
  expect(lines.some((line) => line?.startsWith("Result:"))).toBe(true)
  expect(t.view.title({ id }, renderOptions)).toBe(`Workflow fanout · ${id} · done`)
})

test("/workflow <name> runs a saved workflow with args, and marks the start as asked for", async () => {
  const t = setup()
  mkdirSync(path.join(t.cwd, ".amira", "workflows"), { recursive: true })
  writeFileSync(
    path.join(t.cwd, ".amira", "workflows", "echo.ts"),
    `export const meta = { name: "echo", description: "echoes", phases: [] }\nreturn await agent("say " + args.word)`,
  )
  await t.run('echo {"word":"hi"}')
  expect(t.printed.at(-1)).toMatch(/Started workflow run wf_\w+ \(echo\)/)
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  await until(() => t.notices.length === 1)
  expect(t.notices[0]!.content[0]).toMatchObject({ type: "text" })
  expect(JSON.stringify(t.notices[0]!.content)).toContain("saw hi")
  // Listing shows it.
  await t.run("")
  expect(t.printed.at(-1)).toContain("echo (project) - echoes")
})

test("/workflow <task> asks the model to use a workflow, marked as asked for", async () => {
  const t = setup()
  await t.run("review the three packages")
  expect(t.sent).toEqual(["Use a workflow (the workflow tool) for this task: review the three packages"])
  expect((await t.call({ script: SCRIPT })).isError).toBeUndefined()
  expect(t.confirms[0]!.message!.split("\n")[0]).toBe("You asked for this workflow.")
  await until(() => t.notices.length === 1)
})

test("/workflow view opens the progress view; /workflow stop stops a run", async () => {
  const t = setup({ settings: { enabled: "always" }, answer: () => new Promise<Answer>(() => {}) })
  const slow = `export const meta = { name: "slow", description: "waits", phases: [] }
    return await agent("never answers")`
  const r = await t.call({ script: slow })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await t.run("view")
  expect(t.opened).toEqual([{ kind: "workflow", data: { id } }])
  await t.run(`stop ${id}`)
  expect(t.printed.at(-1)).toBe(`Stopped workflow run ${id}.`)
  await until(() => t.notices.length === 1)
  expect(t.notices[0]!.display?.text).toMatch(/^◆ workflow slow ⊘ /)
})

test("/workflow view opens a read-only archived run even without its script, with no stop hint", async () => {
  const t = setup()
  const dir = path.join(t.home, "workflow-runs", "wf_archived")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      id: "wf_archived",
      meta: { name: "archive", description: "A saved run", phases: ["Verify"] },
      args: null,
      source: "inline",
      status: "done",
      startedAt: 1000,
      endedAt: 2000,
    }),
  )
  writeFileSync(
    path.join(dir, "journal.jsonl"),
    `${JSON.stringify({
      key: "call#0",
      call: 1,
      phase: "Verify",
      label: "review",
      status: "done",
      text: "saved result",
      durationMs: 1000,
    })}\n`,
  )
  await t.run("view wf_archived")
  expect(t.opened).toEqual([{ kind: "workflow", data: { id: "wf_archived" } }])
  const requests: number[] = []
  const opts = { now: 5000, width: 100, requestRefresh: (ms: number) => requests.push(ms) }
  expect(JSON.stringify(t.view.header!({ id: "wf_archived" }, opts))).toContain("read-only")
  expect(JSON.stringify(t.view.render!({ id: "wf_archived" }, opts))).toContain("saved result")
  expect(requests).toEqual([])
  expect(t.groups).toHaveLength(0)
  expect(t.view.keys!.every((key) => key.label === "")).toBe(true)
})

test("x in the view asks before it stops the run; no keeps it running", async () => {
  const t = setup({ settings: { enabled: "always" }, answer: () => new Promise<Answer>(() => {}) })
  const slow = `export const meta = { name: "slow", description: "waits", phases: [] }
    return await agent("never answers")`
  const r = await t.call({ script: slow })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  const asked: string[] = []
  let yes = false
  const control = {
    close: () => {},
    pushPage: () => {},
    popPage: () => {},
    print: () => {},
    requestRender: () => {},
    prompt: async () => undefined,
    confirm: async (q: string, o?: { yes?: string; no?: string }) => {
      asked.push(`${q} y ${o?.yes} · ${o?.no}`)
      return yes
    },
  }
  const x = t.view.keys!.find((k) => k.key === "x")!
  x.run!({ id }, control)
  await until(() => asked.length === 1)
  expect(asked[0]).toBe("Stop the workflow run slow? y stops it · keeps it running")
  await Bun.sleep(20)
  expect(t.notices).toHaveLength(0)
  yes = true
  x.run!({ id }, control)
  await until(() => t.notices.length === 1, "stopped")
  expect(t.notices[0]!.display?.text).toMatch(/^◆ workflow slow ⊘ /)
  // Once it has ended, x has nothing to stop and asks nothing.
  x.run!({ id }, control)
  await Bun.sleep(20)
  expect(asked).toHaveLength(2)
})

test("resume by id replays the journal: no agent runs again", async () => {
  const t = setup()
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  expect(t.groups[0]!.spawned).toHaveLength(4)
  const again = await t.call({ resume: id })
  expect(t.text(again)).toContain(`Started workflow run ${id}`)
  expect(t.confirms.at(-1)!.title).toBe('Resume workflow "fanout"?')
  expect(t.confirms.at(-1)!.message).toContain("4 successful journaled results")
  await until(() => t.notices.length === 2)
  expect(t.groups[1]!.spawned).toHaveLength(0)
  expect(JSON.stringify(t.notices[1]!.content)).toContain("saw tui")
})

test("a run resumed twice, from a run kept before the session had a file, keeps every attempt's results", async () => {
  let failing = "look at core"
  const t = setup({
    settings: { enabled: "always" },
    sessionFile: false,
    answer: (o) => (o.prompt === failing ? { error: "provider down" } : { text: `saw ${o.prompt}` }),
  })
  const sequential = `export const meta = { name: "seq", description: "one after another", phases: [] }
    const out = []
    for (const p of ["api", "core", "tui"]) out.push(await agent("look at " + p))
    return out`
  const r = await t.call({ script: sequential })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  expect(existsSync(path.join(t.home, "workflow-runs", id, "journal.jsonl"))).toBe(true)
  // The session gets its file; runs from now on go next to it.
  t.emit("session.start", {
    data: { reason: "startup", sessionFile: path.join(t.home, "sessions", "s_root.jsonl") },
  })
  failing = "look at tui"
  await t.call({ resume: id })
  await until(() => t.notices.length === 2)
  expect(t.groups[1]!.spawned.map((o) => o.prompt)).toEqual(["look at core", "look at tui"])
  failing = ""
  await t.call({ resume: id })
  await until(() => t.notices.length === 3)
  // api (first attempt) and core (second) replay: only tui runs again.
  expect(t.groups[2]!.spawned.map((o) => o.prompt)).toEqual(["look at tui"])
  expect(JSON.stringify(t.notices[2]!.content)).toContain("saw look at api")
})

test("settings are checked: bad fields are reported once and left at their defaults", () => {
  const errors: string[] = []
  expect(
    readSettings({ enabled: "sometimes", maxAgents: -1, maxConcurrent: 2.5, budget: { tokens: "x" } }, (e) =>
      errors.push(e),
    ),
  ).toEqual({
    maxConcurrent: 2,
  })
  expect(errors).toEqual([
    'settings: extensions.workflow.enabled must be "mode", "ask", "always" or "never"; using the default',
    "settings: extensions.workflow.maxAgents must be a positive number; using the default",
    "settings: extensions.workflow.budget must be { tokens?, costUsd? } with positive numbers; using the default",
  ])
  expect(readSettings(undefined)).toEqual({})
  expect(readSettings({ enabled: "mode" })).toEqual({ enabled: "mode" })
  expect(readSettings({ enabled: "explicit" })).toEqual({ enabled: "ask" })
})

function boundOwner(answer: (o: { prompt: string }) => Answer | Promise<Answer> = () => ({ text: "done" })) {
  const abort = new AbortController()
  const groups: FakeGroup[] = []
  const owner: RunnerOwner = {
    sessionId: "s_owned",
    label: "iteration",
    signal: abort.signal,
    createGroup(options) {
      const group = fakeGroup(options, answer)
      groups.push(group)
      return group
    },
  }
  return { owner, abort, groups }
}

const BOUND_SCRIPT = `export const meta = { name: "bound", description: "Bound test", phases: ["Build"] }
phase("Build")
return await agent("implement", { model: "requested/implementer" })`

function resultOf(runner: WorkflowRunner, runId: string): Promise<BoundResult> {
  return new Promise((resolve) => runner.onResult(runId, resolve))
}

test("bound runs resolve saved/nested source and roles at cwd, force fresh isolation none, and record effective execution", async () => {
  let gitCalls = 0
  const t = setup({
    settings: { enabled: "always", maxAgents: 8, maxConcurrent: 2 },
    git: async () => {
      gitCalls++
      throw new Error("bound agents must not create worktrees")
    },
  })
  expect(t.runner.capabilities).toEqual({
    cwd: true,
    freshRun: true,
    models: true,
    ownedLifetime: true,
    progress: true,
  })
  const cwd = path.join(t.cwd, "iteration")
  for (const dir of [t.cwd, cwd]) {
    mkdirSync(path.join(dir, ".amira", "agents"), { recursive: true })
    mkdirSync(path.join(dir, ".amira", "workflows"), { recursive: true })
    writeFileSync(
      path.join(dir, ".amira", "agents", "builder.md"),
      `---\nmodel: requested/${dir === cwd ? "iteration" : "main"}\nisolation: worktree\n---\n${dir === cwd ? "Iteration role" : "Wrong main role"}`,
    )
    writeFileSync(
      path.join(dir, ".amira", "workflows", "nested.ts"),
      `export const meta = { name: "nested", description: "Nested", phases: ["Nested"] }; phase("Nested"); return await agent("${dir === cwd ? "nested work" : "wrong source"}", { role: "builder", isolation: "worktree" })`,
    )
    writeFileSync(
      path.join(dir, ".amira", "workflows", "parent.ts"),
      `export const meta = { name: "parent", description: "Parent", phases: ["Build"] }; phase("Build"); await agent("${dir === cwd ? "root work" : "wrong source"}", { role: "builder" }); await agent("override", { role: "builder", model: "requested/override", isolation: "worktree" }); return await workflow("nested", {})`,
    )
  }
  const b = boundOwner()
  const ids: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = await t.runner.startBound({ name: "parent", cwd, startedBy }, b.owner)
    if ("error" in started) throw new Error(started.error)
    ids.push(started.runId)
    const snapshots: RunSnapshot[] = []
    t.runner.onProgress(started.runId, (s) => snapshots.push(s))
    const result = await resultOf(t.runner, started.runId)
    expect(result).toMatchObject({
      status: "done",
      cwd,
      ownerSessionId: b.owner.sessionId,
      groupId: "g1",
      sessionIds: ["s_child1", "s_child2", "s_child3"],
      models: ["x/y"],
      startedBy,
    })
    expect(b.groups[attempt]!.spawned.map((o) => [o.prompt, o.model, o.cwd, o.context])).toEqual([
      ["root work", "requested/iteration", cwd, "fresh"],
      ["override", "requested/override", cwd, "fresh"],
      ["nested work", "requested/iteration", cwd, "fresh"],
    ])
    for (const spawn of b.groups[attempt]!.spawned) {
      expect(spawn.systemPrompt).toContain("Iteration role")
      expect(spawn.systemPrompt).not.toContain("Wrong main role")
      expect(spawn.systemPrompt).not.toContain("your own git worktree")
      expect("isolation" in spawn).toBe(false) // Host SpawnOptions has no isolation field.
    }
    expect(snapshots.at(-1)).toMatchObject({
      settled: true,
      phase: "Build",
      children: [
        { sessionId: "s_child1", model: "x/y", state: "done" },
        { sessionId: "s_child2", model: "x/y", state: "done" },
        { sessionId: "s_child3", model: "x/y", phase: "Nested", nest: expect.any(String), state: "done" },
      ],
    })
    const stored = readRun(path.join(t.home, "sessions", "workflows", started.runId))!
    expect(stored.record).toMatchObject({
      cwd,
      ownerSessionId: b.owner.sessionId,
      sessionIds: result.sessionIds,
      models: ["x/y"],
    })
    expect(readJournal(path.join(t.home, "sessions", "workflows", started.runId))).toHaveLength(3)
    expect(t.text(await t.call({ resume: started.runId }))).toContain("start a fresh bound run")
  }
  expect(ids[0]).not.toBe(ids[1])
  expect(gitCalls).toBe(0)
  expect(t.groups).toHaveLength(0)
  expect(t.notices).toHaveLength(0)
  expect(t.expected).toBe(0)
})

test("bound lifetime survives main root replacement/end but owner abort drains children and replays progress", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const b = boundOwner(() => new Promise(() => {}))
  const start = await t.runner.startBound({ script: BOUND_SCRIPT, cwd: t.cwd, startedBy }, b.owner)
  if ("error" in start) throw new Error(start.error)
  await until(() => b.groups[0]!.spawned.length === 1)
  t.emit("session.start", { sessionId: "s_new_main", data: { reason: "clear" } })
  t.emit("session.end", { sessionId: "s_new_main", data: {} })
  expect(t.runner.status(start.runId)?.status).toBe("running")
  const snapshots: RunSnapshot[] = []
  t.runner.onProgress(start.runId, (s) => snapshots.push(s))
  await Promise.resolve()
  expect(snapshots[0]).toMatchObject({
    phase: "Build",
    children: [{ sessionId: "s_child1", model: "x/y", state: "working" }],
  })
  b.abort.abort()
  const result = await resultOf(t.runner, start.runId)
  expect(result).toMatchObject({
    status: "stopped",
    cwd: t.cwd,
    ownerSessionId: "s_owned",
    sessionIds: ["s_child1"],
    error: "the workflow owner was aborted",
  })
  expect(snapshots.at(-1)).toMatchObject({
    settled: true,
    status: "stopped",
    children: [{ state: "stopped", error: expect.any(String) }],
  })
  expect(b.groups[0]!.endReason).toBeDefined()
  expect(t.notices).toEqual([])
})

test("bound confirmation targets the owner session and owner cancellation prevents group creation", async () => {
  for (const cancel of [false, true]) {
    let respond!: (answer: boolean) => void
    const t = setup({
      settings: { enabled: "ask" },
      confirmDialog: (signal) =>
        new Promise((resolve) => {
          respond = resolve
          signal?.addEventListener("abort", () => resolve(undefined), { once: true })
        }),
    })
    const b = boundOwner()
    const pending = t.runner.startBound({ script: BOUND_SCRIPT, cwd: t.cwd, startedBy }, b.owner)
    await until(() => t.confirms.length === 1)
    expect(t.confirms[0]).toMatchObject({ sessionId: b.owner.sessionId })
    expect(b.groups).toHaveLength(0)
    if (cancel) b.abort.abort()
    else respond(true)
    const start = await pending
    if (cancel) {
      expect(start).toEqual({ error: "The workflow start was cancelled." })
      expect(b.groups).toHaveLength(0)
    } else {
      if ("error" in start) throw new Error(start.error)
      expect((await resultOf(t.runner, start.runId)).status).toBe("done")
    }
  }
})

test("bound declines are scoped to the owner and do not suppress another owner or legacy start", async () => {
  const t = setup({ settings: { enabled: "ask" }, confirm: false })
  const a = boundOwner()
  const request = { script: BOUND_SCRIPT, cwd: t.cwd, startedBy }
  expect(await t.runner.startBound(request, a.owner)).toHaveProperty("error")
  t.answerConfirm(true)
  expect(JSON.stringify(await t.runner.startBound(request, a.owner))).toContain("already declined")
  const b = boundOwner()
  b.owner.sessionId = "s_other_owner"
  const start = await t.runner.startBound(request, b.owner)
  if ("error" in start) throw new Error(start.error)
  expect((await resultOf(t.runner, start.runId)).status).toBe("done")
  const legacy = await t.runner.start(request, t.memberContext())
  if ("error" in legacy) throw new Error(legacy.error)
  await resultOf(t.runner, legacy.runId)
  expect(t.confirms).toHaveLength(3)
})

test("immediate bound completion replays detached snapshots/results; unsubscribe cancels queued callbacks", async () => {
  const t = setup({
    settings: { enabled: "always" },
    worker: () => {
      const worker: ScriptWorker = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(m) {
          if (m.t === "run") worker.onmessage?.({ data: { t: "done", value: { ok: [1] } } })
        },
      }
      return worker
    },
  })
  const b = boundOwner()
  const start = await t.runner.startBound({ script: BOUND_SCRIPT, cwd: t.cwd, startedBy }, b.owner)
  if ("error" in start) throw new Error(start.error)
  let called = 0
  const snapshots: RunSnapshot[] = []
  t.runner.onProgress(start.runId, (s) => snapshots.push(s))
  const unsubProgress = t.runner.onProgress(start.runId, () => called++)
  const unsubResult = t.runner.onResult(start.runId, () => called++)
  unsubProgress()
  unsubResult()
  expect(snapshots).toEqual([])
  await Promise.resolve()
  expect(called).toBe(0)
  expect(snapshots[0]).toMatchObject({
    settled: true,
    status: "done",
    cwd: t.cwd,
    children: [],
    result: { ok: [1] },
  })
  snapshots[0]!.models!.push("tampered/model")
  ;(snapshots[0]!.result as { ok: number[] }).ok.push(2)
  snapshots[0]!.startedBy!.label = "tampered"
  expect(await resultOf(t.runner, start.runId)).toMatchObject({ models: [], result: { ok: [1] }, startedBy })
  t.runner.onProgress(start.runId, () => {
    throw new Error("bad progress subscriber")
  })
  t.runner.onResult(start.runId, () => {
    throw new Error("bad result subscriber")
  })
  await Promise.resolve()
  expect(t.errors).toHaveLength(2)
  expect(t.runner.onProgress("missing", () => called++)()).toBeUndefined()
  expect(t.runner.onResult("missing", () => called++)()).toBeUndefined()
  b.abort.abort() // A completed run no longer listens to its owner.
  expect(t.runner.status(start.runId)?.status).toBe("done")
})

test("bound progress reports effective models, nested child errors and failed run state", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const b = boundOwner(() => ({ error: "mock model failed" }))
  const start = await t.runner.startBound({ script: BOUND_SCRIPT, cwd: t.cwd, startedBy }, b.owner)
  if ("error" in start) throw new Error(start.error)
  const snapshots: RunSnapshot[] = []
  t.runner.onProgress(start.runId, (s) => snapshots.push(s))
  const result = await resultOf(t.runner, start.runId)
  expect(result).toMatchObject({ status: "error", models: ["x/y"], sessionIds: ["s_child1"] })
  expect(result.error).toContain("mock model failed")
  expect(snapshots.at(-1)).toMatchObject({
    settled: true,
    phase: "Build",
    children: [
      {
        childId: "s_child1",
        sessionId: "s_child1",
        status: "error",
        state: "failed",
        model: "x/y",
        error: "mock model failed",
      },
    ],
  })
})

test("bound stop and extension unload settle active runs and reject retained service starts", async () => {
  for (const unload of [false, true]) {
    const t = setup({ settings: { enabled: "always" } })
    const b = boundOwner(() => new Promise(() => {}))
    const request = { script: BOUND_SCRIPT, cwd: t.cwd, startedBy }
    const start = await t.runner.startBound(request, b.owner)
    if ("error" in start) throw new Error(start.error)
    await until(() => b.groups[0]!.spawned.length === 1)
    if (unload) await t.dispose()
    else expect(t.runner.stop(start.runId)).toBe(true)
    expect((await resultOf(t.runner, start.runId)).status).toBe("stopped")
    expect(t.runner.stop(start.runId)).toBe(false)
    if (unload)
      expect(await t.runner.startBound(request, b.owner)).toEqual({
        error: "The workflow start was cancelled.",
      })
  }
})

test("unload cancels owner-targeted bound confirmation", async () => {
  const t = setup({
    settings: { enabled: "ask" },
    confirmDialog: (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      }),
  })
  const b = boundOwner()
  const pending = t.runner.startBound({ script: BOUND_SCRIPT, cwd: t.cwd, startedBy }, b.owner)
  await until(() => t.confirms.length === 1)
  await t.dispose()
  expect(await pending).toEqual({ error: "The workflow start was cancelled." })
  expect(b.groups).toHaveLength(0)
})

test("bound start validates owner, cwd, source, attribution, settings and group errors before executing", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const b = boundOwner()
  const request = { script: BOUND_SCRIPT, cwd: t.cwd, startedBy }
  expect(await t.runner.startBound({ ...request, cwd: "relative" }, b.owner)).toHaveProperty("error")
  expect(await t.runner.startBound(request, { ...b.owner, sessionId: "" })).toHaveProperty("error")
  expect(await t.runner.startBound(request, { ...b.owner, createGroup: undefined! })).toHaveProperty("error")
  expect(
    await t.runner.startBound({ ...request, startedBy: { sessionId: "", label: "" } }, b.owner),
  ).toHaveProperty("error")
  expect(await t.runner.startBound({ ...request, script: "return 1" }, b.owner)).toHaveProperty("error")
  expect(await t.runner.startBound({ cwd: t.cwd, name: "missing", startedBy }, b.owner)).toHaveProperty(
    "error",
  )
  expect(
    await t.runner.startBound(request, {
      ...b.owner,
      createGroup() {
        throw new Error("owner group denied")
      },
    }),
  ).toEqual({ error: "The workflow could not start: owner group denied" })
  b.abort.abort()
  expect(await t.runner.startBound(request, b.owner)).toEqual({ error: "The workflow start was cancelled." })
  expect(b.groups).toHaveLength(0)
  const disabled = setup({ settings: { enabled: "never" } })
  expect(
    JSON.stringify(await disabled.runner.startBound({ ...request, cwd: disabled.cwd }, boundOwner().owner)),
  ).toContain("turned off")
})

test("result subscription waits for pending calls and worktree finalization before final progress and replay", async () => {
  let worker!: ScriptWorker
  let finish!: () => void
  let finalizing = false
  const finishing = new Promise<void>((resolve) => {
    finish = resolve
  })
  const t = setup({
    settings: { enabled: "always" },
    answer: () => new Promise(() => {}),
    worker: () => {
      worker = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(m) {
          if (m.t === "run")
            worker.onmessage?.({
              data: { t: "agent", id: 1, seen: 0, prompt: "work", opts: { isolation: "worktree" } },
            })
        },
      }
      return worker
    },
    git: async (args, cwd) => {
      if (args.includes("--show-toplevel")) return { output: cwd, ok: true }
      if (args[0] === "add") {
        finalizing = true
        await finishing
      }
      return { output: args.includes("HEAD") ? "abc123" : "", ok: true }
    },
  })
  const start = await t.runner.start({ script: BOUND_SCRIPT, startedBy }, t.memberContext())
  if ("error" in start) throw new Error(start.error)
  await until(() => t.groups[0]!.spawned.length === 1)
  const snapshots: RunSnapshot[] = []
  const results: BoundResult[] = []
  t.runner.onProgress(start.runId, (s) => snapshots.push(s))
  t.runner.onResult(start.runId, (r) => results.push(r))
  worker.onmessage?.({ data: { t: "done", value: "early terminal" } })
  await until(() => finalizing)
  expect(t.runner.status(start.runId)?.status).toBe("done")
  expect(results).toEqual([])
  expect(snapshots.at(-1)!.settled).toBe(false)
  finish()
  await until(() => results.length === 1)
  expect(snapshots.at(-1)).toMatchObject({
    settled: true,
    status: "done",
    children: [{ status: "aborted", sessionId: "s_child1" }],
  })
  const dir = path.join(t.home, "sessions", "workflows", start.runId)
  expect(readJournal(dir)).toHaveLength(1)
  expect(readRun(dir)!.record).toMatchObject({ status: "done", cwd: t.cwd, sessionIds: ["s_child1"] })
  expect(await resultOf(t.runner, start.runId)).toEqual(results[0]!)
})

test("legacy start preserves caller cwd inheritance while ignoring an unknown request cwd", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const callerCwd = path.join(t.cwd, "legacy-caller")
  const saved = path.join(t.cwd, ".amira", "workflows")
  mkdirSync(callerCwd, { recursive: true })
  mkdirSync(saved, { recursive: true })
  writeFileSync(path.join(saved, "legacy.ts"), BOUND_SCRIPT)
  const request = { name: "legacy", startedBy, cwd: path.join(t.cwd, "ignored") }
  const start = await t.runner.start(request, { ...t.memberContext(), cwd: callerCwd })
  if ("error" in start) throw new Error(start.error)
  expect((await resultOf(t.runner, start.runId)).status).toBe("done")
  expect(t.groups[0]!.spawned[0]!.cwd).toBe(callerCwd)
  expect(t.groups[0]!.spawned[0]!.prompt).toBe("implement")
})

for (const bound of [false, true]) {
  for (const failure of ["construction", "handlers", "dispatch"] as const) {
    test(`${bound ? "bound" : "legacy"} startup ${failure} exception drains and settles without leaked listeners`, async () => {
      let terminated = 0
      const t = setup({
        settings: { enabled: "always" },
        worker: () => {
          if (failure === "construction") throw new Error("worker construction failed")
          const worker: ScriptWorker = {
            onmessage: null,
            onerror: null,
            postMessage() {
              if (failure === "dispatch") throw new Error("worker dispatch failed")
            },
            terminate() {
              terminated++
            },
          }
          if (failure === "handlers")
            Object.defineProperty(worker, "onmessage", {
              set() {
                throw new Error("worker handlers failed")
              },
            })
          return worker
        },
      })
      const owner = boundOwner().owner
      const groups: FakeGroup[] = []
      let release!: () => void
      const drain = new Promise<void>((resolve) => {
        release = resolve
      })
      const createGroup = (options: SpawnGroupOptions) => {
        const group = fakeGroup(options, () => ({ text: "unexpected" }))
        const ended = group.ended.bind(group)
        group.ended = async () => {
          const info = await ended()
          await drain
          return info
        }
        groups.push(group)
        return group
      }
      const added = spyOn(AbortSignal.prototype, "addEventListener")
      const removed = spyOn(AbortSignal.prototype, "removeEventListener")
      const request = { script: BOUND_SCRIPT, startedBy }
      const ctx = t.memberContext()
      ctx.session!.createGroup = createGroup
      const pending = bound
        ? t.runner.startBound({ ...request, cwd: t.cwd }, { ...owner, createGroup })
        : t.runner.start(request, ctx)
      let returned = false
      void pending.then(() => {
        returned = true
      })
      try {
        await Bun.sleep(1)
        expect(groups).toHaveLength(1)
        expect(groups[0]!.endReason).toBeDefined()
        expect(returned).toBe(false)
        release()
        expect(await pending).toEqual({ error: `worker ${failure} failed` })
        const records = listRuns(path.join(t.home, "sessions", "workflows"))
        expect(records).toHaveLength(1)
        expect(records[0]!.status).not.toBe("running")
        expect(t.runner.status(records[0]!.id)?.status).not.toBe("running")
        expect((await resultOf(t.runner, records[0]!.id)).status).not.toBe("running")
        expect(terminated).toBe(failure === "construction" ? 0 : 1)
        const aborts = added.mock.calls.filter(([type]) => type === "abort")
        if (bound) expect(aborts.length).toBeGreaterThan(0)
        for (const [, listener] of aborts)
          expect(removed.mock.calls.some(([type, removed]) => type === "abort" && removed === listener)).toBe(
            true,
          )
        expect(t.notices).toEqual([])
        expect(t.expected).toBe(0)
      } finally {
        release()
        added.mockRestore()
        removed.mockRestore()
      }
    })
  }
}

test("tool startup failure cancels its notice reservation without delivering a completion", async () => {
  const t = setup({
    settings: { enabled: "always" },
    worker: () => {
      throw new Error("worker construction failed")
    },
  })
  const result = await t.call({ script: BOUND_SCRIPT })
  expect(result.isError).toBe(true)
  expect(t.text(result)).toContain("worker construction failed")
  expect(t.groups[0]!.endReason).toBeDefined()
  expect(t.expected).toBe(1)
  expect(t.cancelled).toBe(1)
  expect(t.notices).toEqual([])
  expect(listRuns(path.join(t.home, "sessions", "workflows"))).toMatchObject([{ status: "error" }])
})
