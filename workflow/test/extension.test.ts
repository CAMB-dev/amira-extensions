import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  ExtensionView,
  SpawnGroupOptions,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UserMessage,
  ViewDefinition,
} from "@amira/api"
import { asksForWorkflow, createWorkflowExtension, readSettings } from "../src/index.ts"
import { type Answer, type FakeGroup, fakeGroup } from "./fakes.ts"

const dirs: string[] = []
afterEach(() => {
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

function setup(
  opts: {
    settings?: Record<string, unknown>
    confirm?: boolean | undefined
    answer?: (o: { prompt: string }) => Answer | Promise<Answer>
    /** false: the session has no file yet (runs go to ~/.amira/workflow-runs). */
    sessionFile?: false
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
  const confirms: { title: string; message: string | undefined }[] = []
  const errors: string[] = []
  const groups: FakeGroup[] = []
  const notices: UserMessage[] = []
  let cancelled = 0
  let expected = 0
  const answer = opts.answer ?? ((o: { prompt: string }) => ({ text: `saw ${o.prompt.split(" ").at(-1)}` }))
  const api = {
    apiVersion: "0.1.0",
    cwd,
    home,
    settings: { extensions: { workflow: opts.settings } },
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
    runCommand: async () => ({ output: "", exitCode: 1 }),
    ui: {
      confirm: async (title: string, message?: string) => {
        confirms.push({ title, message })
        return "confirm" in opts ? opts.confirm : true
      },
    },
    on: (type: string, h: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h])
      return () => {}
    },
    intercept: () => () => {},
  } as unknown as ExtensionAPI
  createWorkflowExtension()(api)
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
    groups,
    notices,
    printed,
    opened,
    sent,
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

test("the tool is main-session only and refuses sub-agents that reach it anyway", async () => {
  const t = setup({ settings: { enabled: "always" } })
  expect(t.tool.mainOnly).toBe(true)
  const r = await t.call({ script: SCRIPT }, 1)
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(/only be started from the main session/)
  expect(t.confirms).toHaveLength(0)
})

test("without the user asking, the tool refuses and tells the model to propose a workflow", async () => {
  const t = setup()
  t.say("fix the flaky test")
  const r = await t.call({ script: SCRIPT })
  expect(r.isError).toBe(true)
  expect(t.text(r)).toMatch(/has not asked for a workflow.*propose it/s)
  expect(t.confirms).toHaveLength(0)
  expect(t.groups).toHaveLength(0)
})

test("a user message asking for a workflow lets the model start one, after the user confirms", async () => {
  const t = setup()
  t.say("Use a workflow to review the three packages")
  const r = await t.call({ script: SCRIPT })
  expect(t.text(r)).toMatch(/Started workflow run wf_\w+ \(fanout\) in the background/)
  expect(t.confirms[0]!.title).toBe('Start workflow "fanout"?')
  expect(t.confirms[0]!.message).toContain("Three looks and a check")
  expect(t.confirms[0]!.message).toContain("Phases: Explore → Verify")
  expect(t.confirms[0]!.message).toContain("Estimate: 4 agents")
  expect(t.confirms[0]!.message).toContain("Limits: at most 30 agents, 6 at once")
  // The result comes back as a notice with a short display line.
  await until(() => t.notices.length === 1, "the notice")
  const notice = t.notices[0]!
  const body = notice.content.map((c) => (c.type === "text" ? c.text : "")).join("")
  expect(body).toContain("finished")
  expect(body).toContain('"saw tui"')
  expect(notice.display?.origin).toBe("workflow")
  expect(notice.display?.text).toMatch(/^◆ workflow fanout finished · 4 agents · \d+s · 400 tok$/)
  // The next user message that does not ask shuts the gate again.
  t.say("thanks")
  expect((await t.call({ script: SCRIPT })).isError).toBe(true)
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
  // Mentioning one without asking keeps the tool shut.
  const t = setup()
  t.say("fix the failing GitHub Actions workflow")
  const r = await t.call({ script: SCRIPT })
  expect(t.text(r)).toMatch(/has not asked for a workflow/)
  expect(t.confirms).toHaveLength(0)
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
})

test('settings: "always" skips the ask, "never" refuses even when asked; limits come from settings', async () => {
  const always = setup({
    settings: { enabled: "always", maxAgents: 12, maxConcurrent: 3, budget: { tokens: 50000 } },
  })
  always.say("do the thing")
  expect((await always.call({ script: SCRIPT })).isError).toBeUndefined()
  expect(always.confirms[0]!.message).toContain("Limits: at most 12 agents, 3 at once, 50k tokens")
  expect(always.groups[0]!.options).toEqual({
    name: "workflow fanout",
    maxAgents: 12,
    maxConcurrent: 3,
    budget: { tokens: 50000 },
    compact: true,
  })
  const never = setup({ settings: { enabled: "never" } })
  never.say("use a workflow")
  expect(never.text(await never.call({ script: SCRIPT }))).toMatch(/turned off/)
})

test("defaults: a run's group gets 30 agents and 6 at once", async () => {
  const t = setup({ settings: { enabled: "always" } })
  await t.call({ script: SCRIPT })
  expect(t.groups[0]!.options).toMatchObject({ maxAgents: 30, maxConcurrent: 6, compact: true })
  expect(t.groups[0]!.options.budget).toBeUndefined()
})

test("declining the confirmation starts nothing and leaves no notice pending", async () => {
  const t = setup({ settings: { enabled: "always" }, confirm: false })
  const r = await t.call({ script: SCRIPT })
  expect(t.text(r)).toMatch(/declined/)
  expect(t.groups).toHaveLength(0)
  expect(t.expected - t.cancelled).toBe(0)
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
  const t = setup({ settings: { enabled: "always" } })
  const dynamic = `export const meta = { name: "loop", description: "loops", phases: [] }
    return await parallel(args.map((x) => () => agent(x)))`
  await t.call({ script: dynamic, args: ["a"] })
  expect(t.confirms[0]!.message).toMatch(/Estimate: dynamic/)
})

test("progress: the group's status line follows the phases and counts, and the view shows the tree", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  const statuses = t.groups[0]!.statuses
  expect(statuses.some((s) => s.startsWith(`${id} · Explore · `))).toBe(true)
  expect(statuses.at(-1)).toMatch(new RegExp(`^${id} · Verify · 4/4 agents · 400 tok$`))
  const lines = t.view.render({ id }, { now: Date.now(), width: 80 } as never).map((l) => l.text)
  expect(lines[0]).toBe("├ ✓ Explore")
  expect(lines.slice(1, 4).map((l) => l.replace(/ · \d+s$/, ""))).toEqual([
    "│ ├ ✓ api · 100 tok",
    "│ ├ ✓ core · 100 tok",
    "│ └ ✓ tui · 100 tok",
  ])
  expect(lines[4]).toBe("└ ✓ Verify")
  expect(t.view.title({ id })).toBe(`Workflow fanout · ${id} · done`)
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
  await until(() => t.notices.length === 1)
  expect(t.notices[0]!.content[0]).toMatchObject({ type: "text" })
  expect(JSON.stringify(t.notices[0]!.content)).toContain("saw hi")
  // Listing shows it.
  await t.run("")
  expect(t.printed.at(-1)).toContain("echo (project) - echoes")
})

test("/workflow <task> asks the model to use a workflow, which the gate then allows", async () => {
  const t = setup()
  await t.run("review the three packages")
  expect(t.sent).toEqual(["Use a workflow (the workflow tool) for this task: review the three packages"])
  expect((await t.call({ script: SCRIPT })).isError).toBeUndefined()
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
  expect(t.notices[0]!.display?.text).toMatch(/^◆ workflow slow was stopped/)
})

test("resume by id replays the journal: no agent runs again", async () => {
  const t = setup({ settings: { enabled: "always" } })
  const r = await t.call({ script: SCRIPT })
  const id = /run (wf_\w+)/.exec(t.text(r))![1]!
  await until(() => t.notices.length === 1)
  expect(t.groups[0]!.spawned).toHaveLength(4)
  const again = await t.call({ resume: id })
  expect(t.text(again)).toContain(`Started workflow run ${id}`)
  expect(t.confirms.at(-1)!.title).toBe('Resume workflow "fanout"?')
  expect(t.confirms.at(-1)!.message).toContain("4 journaled results")
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
    'settings: extensions.workflow.enabled must be "explicit", "always" or "never"; using the default',
    "settings: extensions.workflow.maxAgents must be a positive number; using the default",
    "settings: extensions.workflow.budget must be { tokens?, costUsd? } with positive numbers; using the default",
  ])
  expect(readSettings(undefined)).toEqual({})
})
