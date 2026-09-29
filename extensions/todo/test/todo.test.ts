import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import {
  type CommandContext,
  type PanelRenderOptions,
  type ToolCallView,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, SessionStore, ToolRegistry } from "@amira/core"
import {
  createTodoExtension,
  DATA_KEY,
  isMeaningful,
  PANEL_ID,
  panelLines,
  parseTodos,
  restore,
  type Todo,
  type TodoDetails,
  writePresenter,
} from "../src/index.ts"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const todo = (id: string, content: string, status: Todo["status"], activeForm?: string): Todo => ({
  id,
  content,
  status,
  ...(activeForm ? { activeForm } : {}),
})

const plan = (s1: Todo["status"], s2: Todo["status"], s3: Todo["status"]) => [
  todo("1", "Write the parser", s1, "Writing the parser"),
  todo("2", "Test it", s2, "Testing it"),
  todo("3", "Ship it", s3),
]

test("parseTodos checks items, fills in ids and takes common status spellings", () => {
  expect(
    parseTodos([
      { content: "  a\n b ", status: "completed" },
      { id: 7, content: "c", status: "In_Progress", activeForm: "Doing c" },
      { id: "x", content: "d" },
    ]),
  ).toEqual({
    todos: [todo("1", "a b", "done"), todo("7", "c", "in_progress", "Doing c"), todo("x", "d", "pending")],
  })
  expect(parseTodos([])).toEqual({ todos: [] })
  expect(parseTodos("nope")).toEqual({ error: expect.stringContaining("array") })
  expect(parseTodos([{ status: "done" }])).toEqual({ error: 'Item 1 has no "content".' })
  expect(parseTodos([{ content: "a", status: "later" }])).toEqual({ error: expect.stringContaining("later") })
  expect(
    parseTodos([
      { id: "1", content: "a" },
      { id: "1", content: "b" },
    ]),
  ).toEqual({
    error: expect.stringContaining("unique"),
  })
  expect(parseTodos(Array.from({ length: 51 }, () => ({ content: "a" })))).toEqual({
    error: expect.stringContaining("at most"),
  })
})

test("only a new plan, a finished list or a cleared one is worth committing", () => {
  expect(isMeaningful(undefined, [])).toBe(false)
  expect(isMeaningful(undefined, plan("in_progress", "pending", "pending"))).toBe(true)
  // Items moving on are not.
  expect(
    isMeaningful(plan("in_progress", "pending", "pending"), plan("done", "in_progress", "pending")),
  ).toBe(false)
  // An item added, or reworded, is.
  expect(
    isMeaningful(plan("done", "in_progress", "pending"), [
      ...plan("done", "in_progress", "pending"),
      todo("4", "Write docs", "pending"),
    ]),
  ).toBe(true)
  expect(
    isMeaningful(plan("done", "pending", "pending"), [
      todo("1", "Write the parser", "done"),
      todo("2", "Test it well", "pending"),
      todo("3", "Ship it", "pending"),
    ]),
  ).toBe(true)
  // Finishing is, once.
  expect(isMeaningful(plan("done", "done", "in_progress"), plan("done", "done", "done"))).toBe(true)
  expect(isMeaningful(plan("done", "done", "done"), plan("done", "done", "done"))).toBe(false)
  expect(isMeaningful(plan("done", "done", "done"), [])).toBe(true)
})

test("the panel: a header, done muted, in progress accent with its activeForm, pending plain", () => {
  expect(panelLines(plan("done", "in_progress", "pending"))).toEqual([
    { kind: "muted", text: "Todos 1/3 · › Testing it" },
    { kind: "muted", text: "  ✓ Write the parser" },
    { kind: "accent", text: "  › Testing it" },
    { kind: "text", text: "  • Ship it" },
  ])
  expect(panelLines(plan("done", "done", "done"))[0]).toEqual({ kind: "muted", text: "Todos 3/3 · all done" })
  expect(panelLines([])).toEqual([])
})

test("a long list shows a window around the item in progress, within the line limit", () => {
  const long = (working: number) =>
    Array.from({ length: 20 }, (_, i) =>
      todo(String(i + 1), `step ${i + 1}`, i < working ? "done" : i === working ? "in_progress" : "pending"),
    )
  const texts = (w: number) => panelLines(long(w), 8).map((l) => l.text.trim())
  for (const w of [0, 1, 2, 5, 12, 17, 18, 19]) {
    const t = texts(w)
    expect(t).toHaveLength(9)
    expect(t).toContain(`› step ${w + 1}`)
  }
  expect(texts(0).slice(1)).toEqual([
    ...Array.from({ length: 7 }, (_, i) => `${i === 0 ? "›" : "•"} step ${i + 1}`),
    "… 13 more",
  ])
  expect(texts(12)).toEqual([
    "Todos 12/20 · › step 13",
    "… 11 above",
    "✓ step 12",
    "› step 13",
    "• step 14",
    "• step 15",
    "• step 16",
    "• step 17",
    "… 3 more",
  ])
  expect(texts(19).slice(1, 2)).toEqual(["… 13 above"])
  expect(texts(19).at(-1)).toBe("› step 20")
})

test("restore takes the latest list and the latest committed one; a finished list stays hidden", () => {
  const s = restore([
    { todos: plan("in_progress", "pending", "pending"), snapshot: true },
    { todos: plan("done", "in_progress", "pending"), snapshot: false },
    { junk: true },
    { todos: [{ status: "done" }], snapshot: true },
  ])
  expect(s.todos).toEqual(plan("done", "in_progress", "pending"))
  expect(s.committed).toEqual(plan("in_progress", "pending", "pending"))
  expect(s.hidden).toBe(false)
  expect(restore([{ todos: plan("done", "done", "done"), snapshot: true }]).hidden).toBe(true)
  expect(restore([]).todos).toEqual([])
})

/** A scripted model that makes the given todo_write calls, one per step, then says done. */
function script(lists: unknown[]) {
  const mock = createMockDialect()
  for (const todos of lists) mock.push({ toolCalls: [{ name: "todo_write", args: { todos } }] })
  mock.push({ toolCalls: [{ name: "todo_read", args: {} }] })
  mock.push((_req: ModelRequest): MockReply => ({ text: "all done" }))
  return createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
}

async function withTodo(lists: unknown[], store?: SessionStore) {
  const ai = script(lists)
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  expect(await host.load(createTodoExtension(), "pkg:todo")).toBe(true)
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    bus,
    tools,
    ...(store ? { session: store } : {}),
  })
  const panel = (collapsed = false) =>
    host.panels.snapshot({
      width: 80,
      now: 0,
      sessionId: agent.sessionId,
      data: agent.data,
      collapsed,
    } satisfies PanelRenderOptions)
  /** Each finished todo_write call: its arguments and result, as the transcript sees it. */
  const calls: { args: Record<string, unknown>; result: ToolResult }[] = []
  const starts = new Map<string, Record<string, unknown>>()
  bus.subscribe((e) => {
    if (e.type === "tool.execute.start") starts.set(e.data.toolCallId, e.data.args)
    if (e.type === "tool.execute.end" && e.data.name === "todo_write")
      calls.push({ args: starts.get(e.data.toolCallId)!, result: e.data.result })
  })
  return { agent, host, panel, calls, bus }
}

const view = (c: {
  args: Record<string, unknown>
  result: ToolResult
}): ToolCallView<Record<string, unknown>, TodoDetails> => ({
  args: c.args,
  result: c.result as ToolResult & { details?: TodoDetails },
  text: toolResultText(c.result),
})

test("the model's lists: shown live, committed when they change meaningfully, kept with the session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-todo-"))
  dirs.push(dir)
  const store = SessionStore.create({ cwd: process.cwd(), dir })
  const lists = [
    plan("in_progress", "pending", "pending"),
    plan("done", "in_progress", "pending"),
    [...plan("done", "in_progress", "pending"), { id: "4", content: "Write docs", status: "pending" }],
    // Two in progress: accepted, with a reminder.
    [...plan("done", "done", "in_progress"), { id: "4", content: "Write docs", status: "in_progress" }],
  ]
  const { agent, host, panel, calls, bus } = await withTodo(lists, store)
  let seenMidTurn: string[] = []
  bus.subscribe((e) => {
    if (e.type === "tool.execute.end" && e.data.name === "todo_write" && calls.length === 1)
      seenMidTurn = panel()[0]?.lines.map((l) => l.text) ?? []
  })
  expect(panel()).toEqual([])
  await agent.prompt("build it")
  await bus.flush()

  expect(seenMidTurn[0]).toBe("Todos 0/3 · › Writing the parser")
  expect(calls).toHaveLength(4)
  const texts = calls.map((c) => toolResultText(c.result))
  // The first list and the one that added an item come back whole; the others are one line.
  expect(texts[0]).toBe(
    "Todo list updated: 0 of 3 done; in progress: Write the parser.\n[>] 1. Write the parser\n[ ] 2. Test it\n[ ] 3. Ship it",
  )
  expect(texts[1]).toBe("Todo list updated: 1 of 3 done; in progress: Test it.")
  expect(texts[2]).toContain("[ ] 4. Write docs")
  expect(texts[3]).toContain("keep exactly one in progress")
  expect(calls.map((c) => (c.result.details as TodoDetails).snapshot)).toEqual([true, false, true, false])

  // The transcript: progress on the head, the list under committed calls only.
  expect(writePresenter.summary!(calls[1]!.args)).toBe("1/3 done")
  expect(writePresenter.result!(view(calls[1]!))).toBe("› Testing it")
  // A committed call lists the items under it, so its result line only names the plan.
  expect(writePresenter.result!(view(calls[0]!))).toBe("plan · 3 items")
  expect(writePresenter.result!(view(calls[2]!))).toBe("plan · 4 items")
  expect(writePresenter.body!(view(calls[1]!), { detail: "summary", width: 80 })).toEqual([])
  expect(writePresenter.body!(view(calls[2]!), { detail: "summary", width: 80 })).toEqual([
    { kind: "muted", text: "✓ Write the parser" },
    { kind: "accent", text: "› Testing it" },
    { kind: "text", text: "• Ship it" },
    { kind: "text", text: "• Write docs" },
  ])
  // A resumed call has no details: its result text tells whether it was committed.
  const bare = (c: (typeof calls)[number]) => ({ ...view(c), result: { ...c.result, details: undefined } })
  expect(writePresenter.body!(bare(calls[0]!), { detail: "summary", width: 80 })).toHaveLength(3)
  expect(writePresenter.body!(bare(calls[1]!), { detail: "summary", width: 80 })).toEqual([])

  // The panel shows the latest list; folded, only its header.
  expect(panel()[0]!.id).toBe(PANEL_ID)
  expect(panel()[0]!.lines.map((l) => l.text)).toEqual([
    "Todos 2/4 · › Ship it",
    "  ✓ Write the parser",
    "  ✓ Test it",
    "  › Ship it",
    "  › Write docs",
  ])
  expect(panel(true)[0]!.lines).toHaveLength(1)
  expect(agent.data.read(DATA_KEY)).toHaveLength(4)

  // /todos prints it.
  const printed: string[] = []
  await host.commands.get("todos")!.def.run("", {
    print: (t: string) => void printed.push(t),
    session: { info: () => ({ id: agent.sessionId }), data: agent.data },
  } as unknown as CommandContext)
  expect(printed[0]).toContain("› Write docs")

  // Resumed in a new process (-c): the list is back before any tool runs.
  const again = await withTodo([], SessionStore.open(store.file))
  expect(again.agent.sessionId).toBe(agent.sessionId)
  expect(again.panel()[0]!.lines.map((l) => l.text)).toEqual(panel()[0]!.lines.map((l) => l.text))
})

test("a finished list stays until its turn ends, then steps aside; a cleared list is committed", async () => {
  const { agent, panel, calls, bus } = await withTodo([
    plan("in_progress", "pending", "pending"),
    plan("done", "done", "done"),
  ])
  let atFinish: string | undefined
  bus.subscribe((e) => {
    if (e.type === "tool.execute.end" && calls.length === 2) atFinish = panel()[0]?.lines[0]?.text
  })
  await agent.prompt("go")
  await bus.flush()
  expect(atFinish).toBe("Todos 3/3 · all done")
  expect(calls.map((c) => (c.result.details as TodoDetails).snapshot)).toEqual([true, true])
  expect(writePresenter.result!(view(calls[1]!))).toBe("all done")
  expect(panel()).toEqual([])

  const cleared = await withTodo([plan("in_progress", "pending", "pending"), []])
  await cleared.agent.prompt("go")
  await cleared.bus.flush()
  expect(cleared.calls.map((c) => (c.result.details as TodoDetails).snapshot)).toEqual([true, true])
  expect(toolResultText(cleared.calls[1]!.result)).toBe("Todo list cleared.")
  expect(writePresenter.result!(view(cleared.calls[1]!))).toBe("cleared the list")
  expect(cleared.panel()).toEqual([])
})

test("a bad list is an error for the model and changes nothing", async () => {
  const { agent, panel, calls, bus } = await withTodo([
    plan("in_progress", "pending", "pending"),
    [{ id: "1", content: "a", status: "maybe" }],
  ])
  await agent.prompt("go")
  await bus.flush()
  expect(calls[1]!.result.isError).toBe(true)
  expect(writePresenter.body!(view(calls[1]!), { detail: "summary", width: 80 })).toEqual([])
  expect(panel()[0]!.lines[0]!.text).toBe("Todos 0/3 · › Writing the parser")
})
