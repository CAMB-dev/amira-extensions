import { afterEach, expect, test } from "bun:test"
import type {
  CommandContext,
  CommandDefinition,
  CompleteRequest,
  CompleteResult,
  EventEnvelope,
  EventMap,
  ExtensionAPI,
  FrontendView,
  Message,
  PanelDefinition,
  SessionControl,
  Settings,
  ToolLine,
  ViewDefinition,
} from "@amira/api"
import extension from "../src/index.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const audits: { forbidden: string[]; tuiPrints: unknown[] }[] = []

afterEach(() => {
  for (const audit of audits.splice(0)) {
    expect(audit.forbidden).toEqual([])
    expect(audit.tuiPrints).toEqual([])
  }
})

async function setup(settings: Settings = {}) {
  const forbidden: string[] = []
  const tuiPrints: unknown[] = []
  audits.push({ forbidden, tuiPrints })

  // A caught exception must not conceal an unexpected API call or session mutation.
  function strict<T extends object>(name: string, members: Partial<T>): T {
    function fail(property: PropertyKey): never {
      const message = `${name}.${String(property)}`
      forbidden.push(message)
      throw new Error(`Unexpected access: ${message}`)
    }
    return new Proxy(members, {
      get(target, property) {
        if (!Object.hasOwn(target, property)) return fail(property)
        return Reflect.get(target, property)
      },
      set: (_target, property) => fail(property),
      defineProperty: (_target, property) => fail(property),
      deleteProperty: (_target, property) => fail(property),
    }) as T
  }

  const commands: CommandDefinition[] = []
  const panels: PanelDefinition[] = []
  const views: ViewDefinition[] = []
  const calls: { request: CompleteRequest; reply: ReturnType<typeof deferred<CompleteResult>> }[] = []
  const listeners = new Map<keyof EventMap, Set<(event: EventEnvelope) => void>>()
  let renders = 0
  let sequence = 0

  function on<K extends keyof EventMap>(type: K, handler: (event: EventEnvelope<K>) => void) {
    const handlers = listeners.get(type) ?? new Set<(event: EventEnvelope) => void>()
    listeners.set(type, handlers)
    // The emitter dispatches only to the handlers registered for this exact event key.
    const listener = (event: EventEnvelope) => handler(event as EventEnvelope<K>)
    handlers.add(listener)
    return () => {
      handlers.delete(listener)
    }
  }

  const api = strict<ExtensionAPI>("api", {
    settings: { ...settings, layers: () => [] },
    registerCommand(command) {
      commands.push(command)
      return () => {}
    },
    registerPanel(panel) {
      panels.push(panel)
      return () => {}
    },
    registerView(view) {
      views.push(view)
      return () => {}
    },
    on,
    requestRender() {
      renders++
    },
    complete(request) {
      const reply = deferred<CompleteResult>()
      calls.push({ request, reply })
      // Deliberately do not settle on abort: late providers must not revive stale answers.
      return reply.promise
    },
  })
  await extension(api)
  expect(commands.map((command) => command.name)).toEqual(["btw"])
  expect(panels.map((panel) => panel.id)).toEqual(["btw"])
  expect(views.map((view) => view.kind)).toEqual(["btw"])

  function context(
    options: {
      id?: string
      frontend?: CommandContext["frontend"]
      messages?: Message[]
      openView?: boolean
    } = {},
  ) {
    const id = options.id ?? "session-a"
    const frontend = options.frontend ?? "tui"
    const controller = new AbortController()
    const messages = freeze(structuredClone(options.messages ?? []))
    const accesses: string[] = []
    const printed: Parameters<CommandContext["print"]>[] = []
    const opened: FrontendView[] = []
    const session = strict<SessionControl>("session", {
      info() {
        accesses.push("info")
        return freeze({
          id,
          cwd: "/work",
          model: { provider: "test", model: "session-model-not-the-host-default" },
          contextWindow: 100_000,
          busy: true,
          shell: "auto" as const,
        })
      },
      messages() {
        accesses.push("messages")
        return messages
      },
    })
    const ctx = strict<CommandContext>("ctx", {
      session,
      frontend,
      signal: controller.signal,
      print(...args) {
        printed.push(args)
        if (frontend === "tui") tuiPrints.push(args)
      },
      openView:
        options.openView === false
          ? undefined
          : (view) => {
              opened.push(view)
              return true
            },
    })
    return { ctx, controller, printed, opened, accesses, messages, id }
  }

  function run(args: string, ctx: CommandContext) {
    return commands[0]!.run(args, ctx)
  }

  function panel(sessionId = "session-a", collapsed = false) {
    return panels[0]!.render({ sessionId, collapsed, width: 100, now: 0 })
  }

  function emit<K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "session-a") {
    const event: EventEnvelope<K> = { type, data, sessionId, seq: ++sequence, ts: sequence }
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  async function answer(text: string, index = calls.length - 1) {
    const call = calls[index]!
    call.reply.resolve({
      text,
      message: {
        role: "assistant",
        model: { provider: "test", model: "side-question" },
        content: [{ type: "text", text }],
      },
    })
    await call.reply.promise
    await Promise.resolve()
  }

  async function reject(error: unknown, index = calls.length - 1) {
    const call = calls[index]!
    call.reply.reject(error)
    await call.reply.promise.catch(() => {})
    await Promise.resolve()
  }

  function shown(ctx: ReturnType<typeof context>) {
    const opened = ctx.opened.at(-1)
    if (!opened || !("data" in opened)) throw new Error("Expected an extension view")
    const view = views[0]!
    if (!view.render) throw new Error("Expected a line view")
    const options = { width: 100, now: 0 }
    return { title: view.title(opened.data, options), lines: view.render(opened.data, options) }
  }

  return { calls, context, run, panel, emit, answer, reject, shown, views, renders: () => renders }
}

const footer: ToolLine = { kind: "muted", text: "/btw show · /btw history · /btw clear" }

test("the entry point exports only the default extension", async () => {
  expect(Object.keys(await import("../src/index.ts"))).toMatchInlineSnapshot(`
[
  "default",
]
`)
})

test("one host-accounted call uses the btw label, plain context, no tools and the host default model", async () => {
  const s = await setup({ model: "test/host-default" })
  const c = s.context({
    messages: [
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      {
        role: "assistant",
        model: { provider: "test", model: "main" },
        content: [{ type: "text", text: "Original answer" }],
      },
    ],
  })
  const before = structuredClone(c.messages)
  expect(s.run("  Side question?  ", c.ctx)).toBeInstanceOf(Promise)
  expect(s.calls).toHaveLength(1)
  const request = s.calls[0]!.request
  expect(Object.keys(request).sort()).toEqual(["label", "messages", "signal", "system"])
  expect(request.label).toBe("btw")
  expect(request).not.toHaveProperty("tools")
  expect(request).not.toHaveProperty("model")
  expect(request.system).toContain("cannot use tools or change anything")
  expect(request.messages).toEqual([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Conversation so far (context only):\n\nuser:\nOriginal question\n\nassistant:\nOriginal answer",
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Side question?" }] },
  ])
  expect(c.accesses).toEqual(["info", "messages"])
  await s.answer("Side answer")
  expect(s.calls).toHaveLength(1)
  expect(c.messages).toEqual(before)
  expect(c.printed).toEqual([])
})

test("extensions.btw.model overrides the host default, without adding tools", async () => {
  const s = await setup({ extensions: { btw: { model: "  test/fast  " } } })
  const c = s.context()
  s.run("Quick question", c.ctx)
  expect(s.calls[0]!.request.model).toBe("test/fast")
  expect(s.calls[0]!.request.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Quick question" }] },
  ])
  expect(s.calls[0]!.request).not.toHaveProperty("tools")
  await s.answer("Done")
})

for (const model of ["", "   ", 42]) {
  test(`an empty or non-string side model (${JSON.stringify(model)}) leaves host defaults intact`, async () => {
    const s = await setup({ extensions: { btw: { model } } })
    const c = s.context()
    s.run("Question", c.ctx)
    expect(s.calls[0]!.request).not.toHaveProperty("model")
    await s.answer("Done")
  })
}

test("TUI keeps the command pending and redraws thinking, then an eight-line preview and full show view", async () => {
  const s = await setup()
  const c = s.context()
  expect(s.panel()).toEqual([])
  const work = s.run("Question", c.ctx)
  expect(work).toBeInstanceOf(Promise)
  expect(s.renders()).toBeGreaterThan(0)
  expect(s.panel()).toEqual([
    { kind: "accent", text: "btw: Question" },
    { kind: "muted", text: "thinking…" },
    footer,
  ])
  expect(s.panel(c.id, true)).toEqual([{ kind: "accent", text: "btw: Question" }])
  const renders = s.renders()
  const lines = Array.from({ length: 11 }, (_, i) => `Answer line ${i + 1}`)
  await s.answer(lines.join("\n"))
  await work
  expect(s.renders()).toBeGreaterThan(renders)
  expect(s.panel()).toEqual([
    { kind: "accent", text: "btw: Question" },
    ...lines.slice(0, 8).map((text): ToolLine => ({ kind: "text", text })),
    footer,
  ])
  expect(s.panel(c.id, true)).toEqual([{ kind: "accent", text: "btw: Question" }])
  expect(s.run("show", c.ctx)).toBeUndefined()
  expect(s.shown(c)).toEqual({
    title: "btw",
    lines: [
      { kind: "accent", text: "btw: Question" },
      ...lines.map((text): ToolLine => ({ kind: "text", text })),
      { kind: "text", text: "" },
    ],
  })
  expect(s.views[0]!.follow).toBe(false)
  expect(s.calls).toHaveLength(1)
  expect(c.printed).toEqual([])
})

test("a replacement aborts the previous request and ignores its late resolution", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Old question", c.ctx)
  const oldSignal = s.calls[0]!.request.signal!
  s.run("New question", c.ctx)
  expect(oldSignal.aborted).toBe(true)
  expect(s.calls[1]!.request.signal!.aborted).toBe(false)
  await s.answer("Stale answer", 0)
  expect(s.panel()).toEqual([
    { kind: "accent", text: "btw: New question" },
    { kind: "muted", text: "thinking…" },
    footer,
  ])
  await s.answer("Fresh answer", 1)
  s.run("history", c.ctx)
  expect(s.shown(c).lines).toEqual([
    { kind: "accent", text: "btw: New question" },
    { kind: "text", text: "Fresh answer" },
    { kind: "text", text: "" },
  ])
})

test("late errors from a replaced request cannot overwrite the newer answer", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Old", c.ctx)
  s.run("New", c.ctx)
  await s.answer("Keep this", 1)
  const before = s.panel()
  await s.reject(new Error("stale failure"), 0)
  expect(s.panel()).toEqual(before)
})

test("clear aborts a pending question and its late completion cannot restore the panel or history", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Pending", c.ctx)
  const signal = s.calls[0]!.request.signal!
  const renders = s.renders()
  expect(s.run("clear", c.ctx)).toBeUndefined()
  expect(signal.aborted).toBe(true)
  expect(s.renders()).toBeGreaterThan(renders)
  expect(s.panel()).toEqual([])
  await s.answer("Too late")
  expect(s.panel()).toEqual([])
  s.run("history", c.ctx)
  expect(s.shown(c).lines).toContainEqual({ kind: "text", text: "No answers yet. Use /btw <question>." })
})

test("history retains only the last five completed answers in order, even after clear", async () => {
  const s = await setup()
  const c = s.context()
  for (let i = 1; i <= 7; i++) {
    s.run(`Question ${i}`, c.ctx)
    await s.answer(`Answer ${i}`)
  }
  s.run("clear", c.ctx)
  expect(s.panel()).toEqual([])
  s.run("history", c.ctx)
  expect(s.shown(c)).toEqual({
    title: "btw history",
    lines: [3, 4, 5, 6, 7].flatMap((i) => [
      { kind: "accent", text: `btw: Question ${i}` },
      { kind: "text", text: `Answer ${i}` },
      { kind: "text", text: "" },
    ]),
  })
  expect(s.calls).toHaveLength(7)
})

test("sessions have separate answers, requests and history, and ending one cleans up only that session", async () => {
  const s = await setup()
  const a = s.context({ id: "a" })
  const b = s.context({ id: "b" })
  s.run("A saved", a.ctx)
  await s.answer("A answer")
  s.run("A pending", a.ctx)
  s.run("B pending", b.ctx)
  const aSignal = s.calls[1]!.request.signal!
  const bSignal = s.calls[2]!.request.signal!
  expect(aSignal.aborted).toBe(false)
  expect(s.panel("a")[0]).toEqual({ kind: "accent", text: "btw: A pending" })
  expect(s.panel("b")[0]).toEqual({ kind: "accent", text: "btw: B pending" })
  s.emit("session.end", { reason: "switch" }, "a")
  expect(aSignal.aborted).toBe(true)
  expect(bSignal.aborted).toBe(false)
  expect(s.panel("a")).toEqual([])
  await s.answer("Stale A answer", 1)
  await s.answer("B answer", 2)
  expect(s.panel("a")).toEqual([])
  s.run("history", a.ctx)
  expect(s.shown(a).lines).toContainEqual({ kind: "text", text: "No answers yet. Use /btw <question>." })
  s.run("show", a.ctx)
  expect(s.shown(a).lines).toContainEqual({ kind: "text", text: "No answers yet. Use /btw <question>." })
  s.run("history", b.ctx)
  expect(s.shown(b).lines).toEqual([
    { kind: "accent", text: "btw: B pending" },
    { kind: "text", text: "B answer" },
    { kind: "text", text: "" },
  ])
  s.run("A fresh", a.ctx)
  await s.answer("New session state")
  expect(s.panel("a")[1]).toEqual({ kind: "text", text: "New session state" })
})

for (const event of ["turn.start", "turn.steer"] as const) {
  test(`${event} hides the matching panel and a pending answer does not make it reappear`, async () => {
    const s = await setup()
    const c = s.context()
    s.run("Side question", c.ctx)
    const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "Main question" }] }
    const hide = (sessionId: string) => {
      if (event === "turn.start") s.emit(event, { prompt }, sessionId)
      else s.emit(event, { message: prompt, state: "queued" }, sessionId)
    }
    hide("another-session")
    expect(s.panel()).not.toEqual([])
    const renders = s.renders()
    hide(c.id)
    expect(s.panel()).toEqual([])
    expect(s.renders()).toBeGreaterThan(renders)
    await s.answer("Still available in history")
    expect(s.panel()).toEqual([])
    s.run("show", c.ctx)
    expect(s.shown(c).lines).toContainEqual({ kind: "text", text: "Still available in history" })
    expect(s.panel()).toEqual([])
  })
}

test("non-queued steering does not hide a side question", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c.ctx)
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "Main question" }] }
  for (const state of ["injected", "dropped"] as const) {
    s.emit("turn.steer", { message, state })
    expect(s.panel()).not.toEqual([])
  }
  await s.answer("Answer")
})

test("completion errors are shown in the TUI panel, never the transcript or successful history", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c.ctx)
  await s.reject(new Error("provider unavailable"))
  expect(s.panel()).toEqual([
    { kind: "accent", text: "btw: Question" },
    { kind: "text", text: "Could not answer: provider unavailable" },
    { kind: "text", text: "Try /btw again." },
    footer,
  ])
  expect(c.printed).toEqual([])
  s.run("history", c.ctx)
  expect(s.shown(c).lines).toContainEqual({ kind: "text", text: "No answers yet. Use /btw <question>." })
})

test("a TUI without openView never falls back to transcript output", async () => {
  const s = await setup()
  const c = s.context({ openView: false })
  s.run("", c.ctx)
  s.run("history", c.ctx)
  s.run("Question", c.ctx)
  await s.answer("Answer")
  s.run("show", c.ctx)
  expect(c.opened).toEqual([])
  expect(c.printed).toEqual([])
})

for (const frontend of ["print", "rpc"] as const) {
  test(`${frontend} awaits the completion and prints the answer exactly once`, async () => {
    const s = await setup()
    const c = s.context({ frontend })
    const work = s.run("Question", c.ctx)
    expect(work).toBeInstanceOf(Promise)
    let settled = false
    const done = Promise.resolve(work).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(c.printed).toEqual([])
    expect(s.panel()).toEqual([])
    await s.answer("Full\nanswer")
    await done
    expect(settled).toBe(true)
    expect(c.printed).toEqual([["Full\nanswer"]])
    expect(s.calls).toHaveLength(1)
    expect(s.panel()).toEqual([])
    expect(c.opened).toEqual([])
    expect(c.accesses).toEqual(["info", "messages"])
  })

  test(`${frontend} awaits errors and prints one error, without rejecting the command`, async () => {
    const s = await setup()
    const c = s.context({ frontend })
    const work = s.run("Question", c.ctx)
    expect(work).toBeInstanceOf(Promise)
    await s.reject(new Error("offline"))
    await work
    expect(c.printed).toEqual([["Could not answer: offline\nTry /btw again.", "error"]])
    expect(s.panel()).toEqual([])
  })
}

for (const frontend of ["tui", "print", "rpc"] as const) {
  test(`${frontend} forwards command cancellation and ignores a late successful reply`, async () => {
    const s = await setup()
    const c = s.context({ frontend })
    const work = s.run("Question", c.ctx)
    const signal = s.calls[0]!.request.signal!
    expect(signal.aborted).toBe(false)
    const reason = new Error("command cancelled")
    c.controller.abort(reason)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
    await s.answer("Do not show this")
    await work
    expect(s.panel()).toEqual([])
    expect(c.printed).toEqual([])
  })
}

test("an already-aborted command makes no completion request and shows no panel", async () => {
  const s = await setup()
  const c = s.context()
  c.controller.abort()
  await s.run("Question", c.ctx)
  expect(s.calls).toEqual([])
  expect(s.panel()).toEqual([])
  expect(c.accesses).toEqual(["info"])
})
