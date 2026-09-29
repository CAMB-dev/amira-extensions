import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest, userMessage } from "@amira/ai"
import {
  type CommandContext,
  defineTool,
  type Message,
  type SessionControl,
  textResult,
  type UiApi,
} from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { promptIndex } from "../src/format.ts"
import { createCheckpointsExtension, parseRewindArgs, readSettings } from "../src/index.ts"
import type { Checkpoint } from "../src/store.ts"
import { git, repo, tmp, write } from "./helpers.ts"

setDefaultTimeout(60_000)

/** The message a promise rejects with. */
async function failure(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "(no error)",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
}

let savedHome: string | undefined
beforeAll(() => {
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = tmp("home")
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
})

const textOf = (m: Message | undefined) =>
  m && m.role !== "assistant" ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("") : ""

/**
 * A model that runs `write <path> <content>[; write <path> <content>...]` prompts as write
 * tool calls, one per step; "take your time" answers slowly; anything else it just answers.
 */
function model(req: ModelRequest) {
  const prompt = textOf(req.messages.findLast((m) => m.role === "user"))
  if (prompt === "take your time") return { text: "slow", delayMs: 400 }
  const writes = [...prompt.matchAll(/write (\S+) ([^;]*)/g)]
  let i = 0
  for (let at = req.messages.length - 1; at >= 0 && req.messages[at]!.role !== "user"; at--) {
    if (req.messages[at]!.role === "toolResult") i++
  }
  const next = writes[i]
  if (next) return { toolCalls: [{ name: "write", args: { path: next[1]!, content: next[2]!.trim() } }] }
  return { text: i ? "done" : "ok" }
}

async function setup(settings: Record<string, unknown> = {}) {
  const dir = await repo({ "a.txt": "v1\n", ".gitignore": "*.log\n" })
  const mock = createMockDialect()
  for (let i = 0; i < 100; i++) mock.push(model)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  tools.register(
    defineTool<{ path: string; content: string }>({
      name: "write",
      description: "write a file",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      execute: async (args) => {
        write(dir, args.path, `${args.content}\n`)
        return textResult("written")
      },
    }),
    "test",
  )
  const host = new ExtensionHost({
    bus,
    interceptors,
    tools,
    cwd: dir,
    settings: { extensions: { checkpoints: settings } },
  })
  const errors: string[] = []
  bus.subscribe((e) => void (e.type === "extension.error" && errors.push(e.data.error)), {
    types: ["extension.error"],
  })
  expect(await host.load(createCheckpointsExtension(), "pkg:checkpoints")).toBe(true)
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    systemPrompt: "test",
    bus,
    interceptors,
    tools,
  })
  agent.start("startup")
  const rewound: number[] = []
  const session = {
    info: () => ({ id: agent.sessionId, busy: agent.busy }),
    messages: () => agent.messages,
    rewind: async (index: number) => {
      rewound.push(index)
      agent.messages.splice(index)
    },
  } as unknown as SessionControl

  /** Runs a command as a frontend would; `ui` answers its dialogs. */
  const command = async (
    name: string,
    args: string,
    opts: { ui?: Partial<UiApi>; frontend?: CommandContext["frontend"] } = {},
  ) => {
    const printed: string[] = []
    const none = async () => undefined
    const ctx = {
      cwd: dir,
      frontend: opts.frontend ?? "tui",
      signal: new AbortController().signal,
      session,
      ui: { select: none, confirm: none, input: none, reviewDiff: none, form: none, ...opts.ui },
      print: (t: string) => void printed.push(t),
    } as unknown as CommandContext
    await host.commands.get(name)!.def.run(args, ctx)
    return printed.join("\n")
  }
  const turn = async (text: string) => {
    await agent.prompt(userMessage(text))
    await bus.flush()
  }
  const refs = async () =>
    (await git(dir, "for-each-ref", "--format=%(refname)", "refs/amira/checkpoints/"))
      .split("\n")
      .filter(Boolean)
  const read = (p: string) =>
    existsSync(path.join(dir, p)) ? readFileSync(path.join(dir, p), "utf8") : undefined
  return { dir, agent, bus, host, interceptors, command, turn, refs, read, rewound, errors, mock }
}

test("a checkpoint is taken before each turn, and /rewind brings the files back", async () => {
  const t = await setup()
  await t.turn("write a.txt v2")
  await t.turn("write b.txt new")
  const refs = await t.refs()
  expect(refs).toEqual([
    `refs/amira/checkpoints/${t.agent.sessionId}/1`,
    `refs/amira/checkpoints/${t.agent.sessionId}/2`,
  ])
  // Checkpoint 2 was taken before turn 2 wrote b.txt, and after turn 1 wrote a.txt.
  expect(await git(t.dir, "show", `${refs[1]}:a.txt`)).toBe("v2\n")
  expect(await git(t.dir, "ls-tree", "--name-only", refs[1]!)).not.toContain("b.txt")

  const list = await t.command("checkpoints", "")
  expect(list).toContain("#2")
  expect(list).toMatch(/#2 {2}\d\d:\d\d {2}turn 2 · “write b.txt new” · 1 file changed since/)
  expect(list).toMatch(/#1 {2}\d\d:\d\d {2}turn 1 · “write a.txt v2” · 2 files changed since/)

  const out = await t.command("rewind", "1 --yes")
  expect(out).toContain("Restored 2 files from checkpoint #1: a.txt, b.txt")
  expect(out).toContain("/rewind 3 goes back to them")
  expect(t.read("a.txt")).toBe("v1\n")
  expect(t.read("b.txt")).toBeUndefined()
  // The conversation was left alone.
  expect(t.rewound).toEqual([])
  // And back again.
  await t.command("rewind", "3 --yes")
  expect(t.read("a.txt")).toBe("v2\n")
  expect(t.read("b.txt")).toBe("new\n")
  expect(t.errors).toEqual([])
})

test("/rewind asks which checkpoint, shows the diff, and can take the conversation back too", async () => {
  const t = await setup()
  await t.turn("write a.txt v2")
  await t.turn("write a.txt v3")
  const titles: string[] = []
  let offered: string[] = []
  const out = await t.command("rewind", "", {
    ui: {
      select: async (title, options) => {
        titles.push(title)
        return options.find((o) => o.startsWith("#2 "))
      },
      reviewDiff: async (title, diff, options) => {
        titles.push(title)
        expect(diff).toContain("-v3")
        expect(diff).toContain("+v2")
        offered = options
        return options[1]
      },
    },
  })
  expect(titles[0]).toBe("Rewind to which checkpoint?")
  expect(titles[1]).toMatch(/^Rewind to #2 \(\d\d:\d\d, turn 2 · “write a.txt v3”\)\?$/)
  expect(offered).toEqual([
    "Restore 1 file",
    "Restore 1 file and rewind the conversation to before turn 2",
    "Cancel",
  ])
  expect(t.read("a.txt")).toBe("v2\n")
  // The prompt of turn 2 is the third message: user, assistant(call), result, assistant, user...
  const index = t.rewound[0]!
  expect(index).toBeGreaterThan(0)
  expect(out).toContain("The conversation is back to before turn 2.")
  expect(out).toContain("“write a.txt v3”")

  // The next turn is turn 2 again.
  await t.turn("write a.txt v4")
  expect(await t.command("checkpoints", "")).toMatch(/turn 2 · “write a.txt v4”/)

  // Cancelling restores nothing.
  const cancelled = await t.command("rewind", "1", { ui: { reviewDiff: async () => "Cancel" } })
  expect(cancelled).toBe("Nothing restored.")
  expect(t.read("a.txt")).toBe("v4\n")
})

test("/rewind --files restores only the files named", async () => {
  const t = await setup()
  await t.turn("write a.txt v2")
  await t.turn("write b.txt b2")
  await t.turn("write c.txt c3")
  expect(await t.command("rewind", "1 --files a.txt c.txt --yes")).toContain(
    "Restored 2 files from checkpoint #1: a.txt, c.txt",
  )
  expect(t.read("a.txt")).toBe("v1\n")
  expect(t.read("b.txt")).toBe("b2\n")
  expect(t.read("c.txt")).toBeUndefined()
  expect(await failure(t.command("rewind", "1 --files b.txt --conversation"))).toContain("files only")
})

test("/rewind explains itself when there is nothing to do or nobody to ask", async () => {
  const t = await setup()
  expect(await t.command("rewind", "")).toBe(
    "No checkpoints in this session yet; one is taken before each turn.",
  )
  await t.turn("hello")
  expect(await failure(t.command("rewind", "1 --yes"))).toContain(
    "the files already match; add --conversation",
  )
  expect(await t.command("rewind", "1 --files a.txt --yes")).toBe(
    "The files already match checkpoint #1 for a.txt; nothing to restore.",
  )
  // Only the conversation goes back.
  expect(await t.command("rewind", "1 --conversation --yes")).toBe(
    "The conversation is back to before turn 1. Its message was: “hello”",
  )
  expect(t.rewound).toEqual([0])
  await t.turn("write a.txt v2")
  // Print mode cannot ask: it lists them and says how to go on.
  const listed = await t.command("rewind", "", { frontend: "print" })
  expect(listed).toContain("Checkpoints, newest first:")
  expect(listed).toContain("Run /rewind <n> [--yes] to restore one.")
  expect(await t.command("rewind", "1", { frontend: "print" })).toContain("run /rewind 1 --yes")
  expect(t.read("a.txt")).toBe("v2\n")
  expect(await failure(t.command("rewind", "9"))).toContain("no checkpoint #9")
  expect(await failure(t.command("rewind", "1 --files ../outside.txt"))).toContain("is outside")
})

test("with beforeTools, a checkpoint is also taken before listed tool calls that follow a change", async () => {
  const t = await setup({ beforeTools: ["write"] })
  await t.turn("write a.txt v2")
  // Before the turn, then before the write: nothing changed in between, so no second one.
  expect((await t.refs()).length).toBe(1)
  // Two writes in one turn: the second follows a change.
  await t.turn("write a.txt v3; write b.txt b1")
  const list = await t.command("checkpoints", "")
  expect(list).toMatch(/#3 {2}\d\d:\d\d {2}before write b\.txt · 1 file changed since/)
  expect(list).toMatch(/#2 {2}\d\d:\d\d {2}turn 2 · “write a.txt v3; write b.txt b1” · 2 files changed since/)
  expect((await t.refs()).length).toBe(3)
  expect(await git(t.dir, "show", `refs/amira/checkpoints/${t.agent.sessionId}/3:a.txt`)).toBe("v3\n")
})

test("sub-agent turns take no checkpoints of their own", async () => {
  const t = await setup()
  const child = "s_child"
  t.bus.emit(
    "subagent.start",
    {
      childSessionId: child,
      prompt: "x",
      model: { provider: "mock", model: "m" },
      depth: 1,
      cwd: t.dir,
      context: "fresh",
      queued: false,
    },
    { sessionId: t.agent.sessionId },
  )
  t.bus.emit(
    "turn.start",
    { prompt: userMessage("child work") },
    {
      sessionId: child,
      parentSessionId: t.agent.sessionId,
      turnId: "t_child",
    },
  )
  await t.bus.flush()
  const signal = new AbortController().signal
  await t.interceptors.run("context.build", { systemPrompt: "", messages: [] }, { sessionId: child, signal })
  await t.interceptors.run(
    "tool.call.before",
    { toolCallId: "c1", name: "write", args: {} },
    { sessionId: child, signal },
  )
  expect(await t.refs()).toEqual([])
})

test("a running turn refuses /rewind", async () => {
  const t = await setup()
  await t.turn("write a.txt v2")
  const running = t.agent.prompt("take your time")
  await Bun.sleep(20)
  expect(await failure(t.command("rewind", "1 --yes"))).toContain("a turn is running")
  await running
})

test("settings: bad values are reported and the defaults kept", () => {
  const problems: string[] = []
  const s = readSettings(
    { keep: 0, beforeTools: "yes", nonGit: "copy", enabled: "no", timeoutMs: 5, maxFileBytes: 10 },
    (p) => problems.push(p),
  )
  expect(s.keep).toBe(50)
  expect(s.beforeTools).toEqual([])
  expect(s.nonGit).toBe("shadow")
  expect(s.enabled).toBe(true)
  expect(s.maxFileBytes).toBe(10)
  expect(problems.length).toBe(5)
  expect(readSettings({ beforeTools: true }).beforeTools).toEqual(["edit", "write", "bash", "powershell"])
})

test("/rewind arguments", () => {
  expect(parseRewindArgs("")).toEqual({ conversation: false, yes: false })
  expect(parseRewindArgs("#3 --yes")).toEqual({ n: 3, conversation: false, yes: true })
  expect(parseRewindArgs('2 --files a.txt "dir/with space.txt" -y')).toEqual({
    n: 2,
    files: ["a.txt", "dir/with space.txt"],
    conversation: false,
    yes: true,
  })
  expect(parseRewindArgs("2 --conversation")).toEqual({ n: 2, conversation: true, yes: false })
  expect(parseRewindArgs("2 --files a --conversation")).toHaveProperty("error")
  expect(parseRewindArgs("two")).toHaveProperty("error")
})

test("a checkpoint's prompt is found by its text when the message object is not known", () => {
  const cp = (n: number, prompt: string, kind: "turn" | "restore" = "turn"): Checkpoint => ({
    session: "s",
    n,
    ref: "",
    commit: "",
    tree: "",
    meta: { v: 1, kind, ts: n, turn: n, prompt, changed: [], changedCount: 0 },
  })
  const u = (text: string): Message => userMessage(text)
  const a: Message = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider: "m", model: "m" },
  }
  const messages = [u("fix it"), a, u("more"), a, u("fix it"), a]
  const list = [cp(1, "fix it"), cp(2, "more"), cp(3, "x", "restore"), cp(4, "fix it")]
  const none = new Map()
  expect(promptIndex(messages, list[3]!, list, none)).toBe(4)
  expect(promptIndex(messages, list[1]!, list, none)).toBe(2)
  expect(promptIndex(messages, list[0]!, list, none)).toBe(0)
  expect(promptIndex(messages, list[2]!, list, none)).toBeUndefined()
  // A turn cut off earlier is not matched to a later message of the same text.
  const cut = [u("more"), a]
  expect(promptIndex(cut, list[3]!, list, none)).toBeUndefined()
})
