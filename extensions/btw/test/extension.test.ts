import { afterEach, expect, test } from "bun:test"
import type {
  AnyEvent,
  ChildSession,
  ChildState,
  CommandContext,
  CommandDefinition,
  EventEnvelope,
  EventMap,
  ExtensionAPI,
  FrontendView,
  ModelRef,
  SessionControl,
  Settings,
  SpawnGroup,
  SpawnOptions,
  SubagentResult,
  UiControl,
  ViewDefinition,
  ViewLine,
} from "@amira/api"
import extension from "../src/index.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function stream() {
  const queued: AnyEvent[] = []
  let waiter: ReturnType<typeof deferred<IteratorResult<AnyEvent>>> | undefined
  let ended = false
  const events: AsyncIterable<AnyEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          const event = queued.shift()
          if (event) return Promise.resolve({ done: false as const, value: event })
          if (ended) return Promise.resolve({ done: true as const, value: undefined })
          waiter = deferred<IteratorResult<AnyEvent>>()
          return waiter.promise
        },
        return() {
          ended = true
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }
  return {
    events,
    push(event: AnyEvent) {
      if (waiter) {
        waiter.resolve({ done: false, value: event })
        waiter = undefined
      } else queued.push(event)
    },
    end() {
      ended = true
      waiter?.resolve({ done: true, value: undefined })
      waiter = undefined
    },
    reject(error: unknown) {
      if (!waiter) throw new Error("Expected an active event consumer")
      waiter.reject(error)
      waiter = undefined
    },
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const audits: { forbidden: string[]; cleanup: () => void }[] = []
afterEach(async () => {
  for (const audit of audits.splice(0)) {
    audit.cleanup()
    expect(audit.forbidden).toEqual([])
  }
  await flush()
})

async function setup(settings: Settings = {}) {
  const forbidden: string[] = []
  // Unexpected reads/writes remain visible even if the extension catches the exception.
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
  const views: ViewDefinition[] = []
  const listeners = new Map<keyof EventMap, (event: EventEnvelope) => void>()
  let renders = 0
  let seq = 0
  let childSequence = 0
  let spawnError: unknown
  let initialState: ChildState = "working"
  const children: ReturnType<typeof makeChild>[] = []
  const groups: { ends: string[]; options: Parameters<NonNullable<SessionControl["createGroup"]>>[0] }[] = []

  function makeChild(options: SpawnOptions, parentSessionId: string, parentModel: ModelRef) {
    const source = stream()
    const result = deferred<SubagentResult>()
    const state = {
      value: initialState,
      accepts: true,
      sendError: undefined as unknown,
    }
    const sent: Parameters<ChildSession["send"]>[0][] = []
    const aborts: (string | undefined)[] = []
    const id = `child-${++childSequence}`
    const [provider, model] = options.model?.split("/") ?? [parentModel.provider, parentModel.model]
    const modelRef = { provider: provider!, model: model! }
    const child = strict<ChildSession>(id, {
      id,
      model: modelRef,
      get state() {
        return state.value
      },
      events: source.events,
      result: () => result.promise,
      abort(reason) {
        aborts.push(reason)
        state.value = "ended"
        result.resolve(outcome("aborted"))
        source.end()
      },
      send(message) {
        if (state.sendError) throw state.sendError
        if (!state.accepts || state.value === "ended") return false
        sent.push(message)
        return true
      },
    })
    function outcome(status: SubagentResult["status"], extra: Partial<SubagentResult> = {}): SubagentResult {
      return {
        sessionId: id,
        status,
        text: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        steps: 1,
        durationMs: 1,
        ...extra,
      }
    }
    async function emit<K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = id) {
      const event: EventEnvelope<K> = { type, data, sessionId, seq: ++seq, ts: seq }
      source.push(event as AnyEvent)
      await flush()
    }
    return {
      child,
      options,
      sent,
      aborts,
      state,
      emit,
      source,
      async answer(text: string) {
        await emit("message.end", {
          message: { role: "assistant", model: modelRef, content: [{ type: "text", text }] },
        })
        state.value = "idle"
        await emit("subagent.state", { childSessionId: id, state: "idle", turns: 1 }, parentSessionId)
      },
      async end(status: SubagentResult["status"], extra: Partial<SubagentResult> = {}) {
        state.value = "ended"
        result.resolve(outcome(status, extra))
        source.end()
        await flush()
      },
    }
  }

  const api = strict<ExtensionAPI>("api", {
    settings: { ...settings, layers: () => [] },
    registerCommand(command) {
      commands.push(command)
      return () => {}
    },
    registerView(view) {
      views.push(view)
      return () => {}
    },
    on(type, handler) {
      listeners.set(type, (event) => handler(event as never))
      return () => {
        listeners.delete(type)
      }
    },
    requestRender() {
      renders++
    },
  })
  await extension(api)
  expect(commands.map((command) => command.name)).toEqual(["btw"])
  expect(views).toHaveLength(1)
  expect(views[0]!.kind).toMatch(/^btw:/)

  function context(
    options: {
      id?: string
      frontend?: CommandContext["frontend"]
      dock?: "missing" | "blocked" | "throws" | "deferred"
      tree?: boolean
    } = {},
  ) {
    const id = options.id ?? "session-a"
    const controller = new AbortController()
    const printed: Parameters<CommandContext["print"]>[] = []
    const opened: FrontendView[] = []
    // There is no session.messages/send/data/append API in this strict fake.
    const mainHistory = Object.freeze([
      Object.freeze({ role: "user", content: Object.freeze([{ type: "text", text: "Main question" }]) }),
    ])
    let mounted: FrontendView | undefined
    let mountedDefinition: ViewDefinition | undefined
    let closes = 0
    const parentModel = { provider: "test", model: "session-model" }
    const session = strict<SessionControl>("session", {
      info: () => ({
        id,
        cwd: "/work",
        model: parentModel,
        contextWindow: 100_000,
        busy: true,
        shell: "auto",
      }),
      createGroup:
        options.tree === false
          ? undefined
          : (groupOptions) => {
              const record = { ends: [] as string[], options: groupOptions }
              groups.push(record)
              return strict<SpawnGroup>("group", {
                spawn(spawnOptions) {
                  if (spawnError) throw spawnError
                  const fake = makeChild(spawnOptions, id, parentModel)
                  children.push(fake)
                  return fake.child
                },
                end: (reason) => {
                  record.ends.push(reason ?? "")
                },
              })
            },
    })
    function hostClose() {
      closes++
      if (mounted && "data" in mounted) mountedDefinition?.onClose?.(mounted.data)
      mounted = undefined
    }
    const control = strict<UiControl>("control", { close: hostClose })
    const ctx = strict<CommandContext>("ctx", {
      session,
      frontend: options.frontend ?? "tui",
      signal: controller.signal,
      print: (...args) => {
        printed.push(args)
      },
      openView:
        options.dock === "missing"
          ? undefined
          : (view) => {
              opened.push(view)
              if (options.dock === "throws") throw new Error("host view error")
              if (options.dock === "blocked") return false
              // API 0.1.44 reuses a mounted kind, keeping its old definition and skipping hooks.
              if (mounted?.kind === view.kind) {
                mounted = view
                return true
              }
              if (mounted) hostClose()
              mounted = view
              mountedDefinition = views.find((definition) => definition.kind === view.kind)
              if ("data" in view && options.dock !== "deferred")
                mountedDefinition?.onOpen?.(view.data, control)
              return true
            },
    })
    function shown(markdown = true) {
      const view = opened.at(-1)
      if (!view || !("data" in view)) throw new Error("Expected a dock")
      const replies: string[] = []
      const opts = {
        width: 100,
        now: 0,
        ...(markdown
          ? {
              renderReply: (text: string): ViewLine[] => {
                replies.push(text)
                return [{ kind: "text", text: `markdown:${text}` }]
              },
            }
          : {}),
      }
      return {
        title: views[0]!.title(view.data, opts),
        status: views[0]!.titleAside?.(view.data),
        lines: views[0]!.render!(view.data, opts),
        replies,
      }
    }
    return { ctx, controller, printed, opened, hostClose, shown, mainHistory, closes: () => closes }
  }
  function run(text: string, c: ReturnType<typeof context>) {
    return commands[0]!.run(text, c.ctx)
  }
  function emit<K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "session-a") {
    listeners.get(type)?.({ type, data, sessionId, seq: ++seq, ts: seq })
  }
  audits.push({
    forbidden,
    cleanup() {
      for (const child of children) child.source.end()
    },
  })
  return {
    context,
    run,
    emit,
    children,
    groups,
    commands,
    views,
    spawnFails: (error: unknown) => {
      spawnError = error
    },
    renders: () => renders,
    startQueued: () => {
      initialState = "queued"
    },
    async reload() {
      // Registration removal leaves mounted viewers and their callbacks intact.
      commands.length = 0
      views.length = 0
      listeners.clear()
      await extension(api)
    },
  }
}

test("the entry point exports only the default extension", async () => {
  expect(Object.keys(await import("../src/index.ts"))).toEqual(["default"])
})

test("busy session forks an ephemeral child with inherited declarations and session model", async () => {
  const s = await setup({ model: "test/global-default" })
  const c = s.context()
  expect(s.run("  Side question?  ", c)).toBeUndefined()
  expect(s.commands[0]!.echo).toBe(false)
  expect(s.children).toHaveLength(1)
  const { options, child } = s.children[0]!
  expect(options).toMatchObject({ prompt: "Side question?", context: "fork", ephemeral: true })
  expect(options.callableTools).toEqual(["read", "grep", "glob"])
  for (const key of ["tools", "excludeTools", "extraTools", "schema", "model"]) {
    expect(options).not.toHaveProperty(key)
  }
  expect(child.model).toEqual({ provider: "test", model: "session-model" })
  expect(options.systemPrompt).toContain("must not change files or the main conversation")
  expect(c.opened[0]).toMatchObject({ kind: s.views[0]!.kind, placement: "dock" })
  expect(s.views[0]!.follow).toBe(true)
  expect(c.printed).toEqual([])
  const before = structuredClone(c.mainHistory)
  await s.children[0]!.answer("Answer")
  c.hostClose()
  expect(c.mainHistory).toEqual(before)
})

test("accounting metadata uses neutral labels, never the private question", async () => {
  const s = await setup()
  const c = s.context()
  const question = "PRIVATE_QUESTION_MARKER why does this happen?"
  s.run(question, c)
  const { prompt, ...metadata } = s.children[0]!.options
  // The host derives an omitted title from the task, then persists it as side_usage.label.
  const title = metadata.title ?? prompt.split(/\s+/).slice(0, 5).join(" ")
  const accounting = { side_usage: { label: title }, group: s.groups[0]!.options, spawn: metadata }
  expect(prompt).toBe(question)
  expect(metadata.title).toBe("btw")
  expect(JSON.stringify(accounting)).not.toContain("PRIVATE_QUESTION_MARKER")
  expect(accounting.side_usage.label).toBe("btw")
})

test("reload replacement preserves the old question block exactly once", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.answer("Answer A")
  await s.reload()
  s.run("B", c)
  c.hostClose()
  expect(c.printed.filter(([head]) => head === "btw: A")).toHaveLength(1)
  expect(c.printed.find(([head]) => head === "btw: A")?.[2]?.details).toContain("Answer A")
  expect(c.printed.filter(([head]) => head === "btw: B")).toHaveLength(1)
})

test("after reload and Esc, the next question always starts a new child", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.reload()
  s.run("B", c)
  c.hostClose()
  s.run("C", c)
  expect(s.children).toHaveLength(3)
  expect(s.children[2]!.options.prompt).toBe("C")
  await s.children[2]!.answer("Answer C")
  c.hostClose()
  expect(c.printed.filter(([head]) => head === "btw: C")).toHaveLength(1)
})

test("a closed side left in a newer instance's map is saved once and replaced", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const oldDefinition = s.views[0]!
  await s.reload()
  s.run("B", c)
  const b = c.opened.at(-1)!
  // Defensively cover an old host callback receiving newer data without owning its map.
  if ("data" in b) oldDefinition.onClose?.(b.data)
  s.run("C", c)
  expect(s.children).toHaveLength(3)
  expect(s.children[2]!.options.prompt).toBe("C")
  if ("data" in b) oldDefinition.onClose?.(b.data)
  s.run("Follow C", c)
  expect(s.children[2]!.sent).toEqual(["Follow C"])
  expect(c.printed.filter(([head]) => head === "btw: B")).toHaveLength(1)
})

test("clear removes a closed side even when its callback belonged to an older instance", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const oldDefinition = s.views[0]!
  await s.reload()
  s.run("B", c)
  const b = c.opened.at(-1)!
  if ("data" in b) oldDefinition.onClose?.(b.data)
  s.run("clear", c)
  s.run("C", c)
  expect(s.children).toHaveLength(3)
  expect(s.children[2]!.options.prompt).toBe("C")
  s.run("clear", c)
  expect(c.printed.filter(([head]) => head === "btw: B")).toHaveLength(1)
  expect(c.printed.filter(([head]) => head === "btw: C")).toHaveLength(1)
})

test("after reload, clear resets the dock and a later question starts normally", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.reload()
  s.run("B", c)
  s.run("clear", c)
  expect(c.closes()).toBeGreaterThan(0)
  s.run("C", c)
  expect(s.children).toHaveLength(3)
  s.run("clear", c)
  expect(c.printed.filter(([head]) => head === "btw: B")).toHaveLength(1)
  expect(c.printed.filter(([head]) => head === "btw: C")).toHaveLength(1)
})

test("the configured model override is trimmed and used at spawn", async () => {
  const s = await setup({ extensions: { btw: { model: "  other/fast  " } } })
  const c = s.context()
  s.run("Question", c)
  expect(s.children[0]!.options.model).toBe("other/fast")
  expect(s.children[0]!.child.model).toEqual({ provider: "other", model: "fast" })
})

for (const model of ["", "   ", 42]) {
  test(`invalid or empty override (${JSON.stringify(model)}) inherits the session model`, async () => {
    const s = await setup({ extensions: { btw: { model } } })
    s.run("Question", s.context())
    expect(s.children[0]!.options).not.toHaveProperty("model")
    expect(s.children[0]!.child.model.model).toBe("session-model")
  })
}

test("answer streams through Markdown and message.end reconciles without duplication", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  const renders = s.renders()
  await child.emit("message.start", { model: child.child.model })
  await child.emit("message.delta", { kind: "thinking", text: "private reasoning" })
  await child.emit("message.delta", { kind: "text", text: "**Part" })
  expect(c.shown().replies).toEqual(["**Part"])
  await child.emit("message.delta", { kind: "text", text: "ial**" })
  expect(c.shown().replies).toEqual(["**Partial**"])
  await child.answer("**Final**")
  expect(c.shown().replies).toEqual(["**Final**"])
  expect(c.shown(false).lines).toContainEqual({ kind: "text", text: "**Final**" })
  expect(c.shown().status).toBe("ready")
  expect(s.renders()).toBeGreaterThan(renders)
  expect(c.printed).toEqual([])
})

test("follow-ups reuse the same child, dock and originating printer", async () => {
  const s = await setup()
  const first = s.context()
  const follow = s.context()
  s.run("First", first)
  await s.children[0]!.answer("First answer")
  s.run("Follow-up", follow)
  expect(s.children).toHaveLength(1)
  expect(s.children[0]!.sent).toEqual(["Follow-up"])
  expect(follow.opened).toEqual([])
  await s.children[0]!.answer("Second answer")
  first.hostClose()
  expect(first.printed).toHaveLength(1)
  expect(follow.printed).toEqual([])
  expect(first.printed[0]).toEqual([
    "btw: First",
    "info",
    {
      details:
        "**Question**\n\nFirst\n\n**Answer**\n\nFirst answer\n\n**Question**\n\nFollow-up\n\n**Answer**\n\nSecond answer",
      markdown: true,
      persist: true,
    },
  ])
})

test("follow-ups during streaming do not replace or abort the current reply", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First", c)
  const child = s.children[0]!
  await child.emit("message.delta", { kind: "text", text: "In progress" })
  s.run("Next", c)
  s.run("Another", c)
  await child.emit("message.delta", { kind: "text", text: " still" })
  expect(child.sent).toEqual(["Next", "Another"])
  expect(child.aborts).toEqual([])
  expect(c.shown().replies).toEqual(["In progress still"])
  expect(c.opened).toHaveLength(1)
  await child.answer("Finished")
  await child.emit("message.start", { model: child.child.model })
  await child.answer("Combined follow-up answer")
  expect(c.shown().replies).toEqual(["Finished", "Combined follow-up answer"])
})

test("host Esc/onClose aborts unfinished work and persists exactly one display-only block", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  await child.emit("message.delta", { kind: "text", text: "Partial answer" })
  const data = c.opened[0]!
  // Resolve a pending iterator read, but close before its continuation can run.
  child.source.push({
    type: "message.delta",
    data: { kind: "text", text: "Buffered after close" },
    sessionId: child.child.id,
    seq: 100,
    ts: 100,
  })
  c.hostClose()
  if ("data" in data) s.views[0]!.onClose?.(data.data)
  s.run("clear", c)
  expect(child.aborts).toEqual(["btw dock closed"])
  expect(s.groups[0]!.ends).toEqual(["btw dock closed"])
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[0]).toBe("btw: Question")
  expect(c.printed[0]?.[2]).toEqual({
    details:
      "**Question**\n\nQuestion\n\n**Answer**\n\nPartial answer\n\n**Status**\n\nStopped before the answer finished.",
    markdown: true,
    persist: true,
  })
  await child.emit("message.delta", { kind: "text", text: "Too late" })
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).not.toContain("Too late")
})

test("clear closes the mounted dock and idle child once, then a new question forks afresh", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First", c)
  await s.children[0]!.answer("Done")
  s.run("clear", c)
  expect(c.closes()).toBe(1)
  expect(s.children[0]!.aborts).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).not.toContain("Stopped before")
  s.run("New", c)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("New")
})

test("clear before onOpen still cleans up and late mounting immediately closes", async () => {
  const s = await setup()
  const c = s.context({ dock: "deferred" })
  s.run("Question", c)
  s.run("clear", c)
  expect(s.children[0]!.aborts).toHaveLength(1)
  const opened = c.opened[0]!
  if ("data" in opened) s.views[0]!.onOpen?.(opened.data, { close: c.hostClose } as UiControl)
  expect(c.printed).toHaveLength(1)
  expect(c.closes()).toBe(1)
})

for (const dock of ["blocked", "throws"] as const) {
  test(`a ${dock} dock starts no child and saves no display block`, async () => {
    const s = await setup()
    const c = s.context({ dock })
    expect(() => s.run("Question", c)).toThrow()
    expect(s.children).toEqual([])
    expect(s.groups).toEqual([])
    s.run("clear", c)
    expect(c.printed).toEqual([])
  })
}

for (const frontend of ["tui", "rpc", "print"] as const) {
  test(`${frontend} without a dock is rejected before spawning`, async () => {
    const s = await setup()
    const c = s.context({ frontend, dock: "missing" })
    expect(() => s.run("Question", c)).toThrow("TUI dock and an agent tree")
    expect(s.children).toEqual([])
    expect(c.printed).toEqual([])
  })
}

test("missing agent tree is rejected without opening a dock", async () => {
  const s = await setup()
  const c = s.context({ tree: false })
  expect(() => s.run("Question", c)).toThrow("agent tree")
  expect(c.opened).toEqual([])
})

test("spawn errors appear in the dock and are persisted only on close", async () => {
  const s = await setup()
  const c = s.context()
  s.spawnFails(new Error("budget exhausted"))
  s.run("Question", c)
  expect(c.shown().status).toBe("failed")
  expect(c.shown().lines).toContainEqual({
    kind: "error",
    text: "Could not answer: budget exhausted\nClose the dock with Esc or /btw clear, then ask again.",
  })
  expect(c.printed).toEqual([])
  c.hostClose()
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("budget exhausted")
})

test("turn and child errors show in the dock without duplicate errors", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  await child.emit("turn.end", { reason: "error", steps: 0, error: "provider unavailable" })
  await child.end("error", { error: "provider unavailable" })
  expect(c.shown().lines.filter((line) => line.kind === "error")).toHaveLength(1)
  expect(c.shown().status).toBe("failed")
  expect(c.printed).toEqual([])
  c.hostClose()
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("provider unavailable")
})

test("an ended child is saved and replaced by a fresh child for the next question", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  await s.children[0]!.end("aborted")
  s.run("Next question", c)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("Next question")
  expect(s.children[0]!.sent).toEqual([])
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[0]).toBe("btw: Question")
})

test("send exceptions stay in the dock", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  s.children[0]!.state.sendError = new Error("delivery failed")
  s.run("Follow-up", c)
  expect(c.shown().status).toBe("failed")
  expect(c.shown().lines.some((line) => "text" in line && line.text.includes("delivery failed"))).toBe(true)
  expect(c.printed).toEqual([])
})

test("accepted but undelivered follow-ups are reported when the child ends", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  s.run("Follow-up", c)
  await s.children[0]!.end("error", {
    error: "turn failed",
    undelivered: [{ role: "user", content: [{ type: "text", text: "Follow-up" }] }],
  })
  expect(c.shown().lines).toContainEqual({
    kind: "error",
    text: "1 follow-up message(s) did not reach the side agent.",
  })
})

test("event stream failures abort the child and display the error in the dock", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  child.source.reject(new Error("stream disconnected"))
  await flush()
  expect(child.aborts).toEqual(["btw stream failed"])
  expect(c.shown().status).toBe("failed")
  expect(c.shown().lines.some((line) => "text" in line && line.text.includes("stream disconnected"))).toBe(
    true,
  )
})

test("buffered nonterminal states cannot overwrite a settled child result", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  for (const state of ["working", "idle"] as const) {
    child.source.push({
      type: "subagent.state",
      data: { childSessionId: child.child.id, state, turns: 1 },
      sessionId: "session-a",
      seq: 100,
      ts: 100,
    })
  }
  await child.end("aborted")
  expect(c.shown().status).toBe("ended")
  expect(c.shown().lines).not.toContainEqual({ kind: "muted", text: "Thinking…" })
})

test("initial queued state is shown without relying on replay of subagent.start", async () => {
  const s = await setup()
  const c = s.context()
  s.startQueued()
  s.run("Question", c)
  expect(c.shown().status).toBe("waiting")
  expect(c.shown().lines).toContainEqual({ kind: "muted", text: "Waiting for an agent slot…" })
})

test("lost stream events fail visibly and stop the child", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  await s.children[0]!.emit("events.lost", { dropped: 1 })
  expect(c.shown().status).toBe("failed")
  expect(s.children[0]!.aborts).toEqual(["btw stream failed"])
  expect(c.shown().lines.some((line) => "text" in line && line.text.includes("lost events"))).toBe(true)
})

test("queued and later working child states are visible", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const child = s.children[0]!
  await child.emit(
    "subagent.state",
    { childSessionId: child.child.id, state: "queued", turns: 1 },
    "session-a",
  )
  expect(c.shown().status).toBe("waiting")
  expect(c.shown().lines).toContainEqual({ kind: "muted", text: "Waiting for an agent slot…" })
  await child.emit(
    "subagent.state",
    { childSessionId: child.child.id, state: "working", turns: 1 },
    "session-a",
  )
  expect(c.shown().status).toBe("working")
})

test("main turn events and unrelated child messages never enter or hide the dock", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "Main follow-up" }] }
  s.emit("turn.start", { prompt })
  s.emit("turn.steer", { message: prompt, state: "queued" })
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Another child" }, "other-child")
  expect(c.shown().replies).toEqual([])
  expect(c.closes()).toBe(0)
  expect(c.printed).toEqual([])
})

test("session end closes only its side and prints into its originating session exactly once", async () => {
  const s = await setup()
  const a = s.context({ id: "a" })
  const b = s.context({ id: "b" })
  s.run("A", a)
  s.run("B", b)
  s.emit("session.end", { reason: "switch" }, "a")
  a.hostClose()
  expect(s.children[0]!.aborts).toHaveLength(1)
  expect(s.children[1]!.aborts).toEqual([])
  expect(a.printed).toHaveLength(1)
  expect(b.printed).toEqual([])
  await s.children[1]!.answer("B answer")
  b.hostClose()
  expect(b.printed[0]?.[2]?.details).toContain("B answer")
})

test("empty args explain the dock commands and show/history are ordinary questions", async () => {
  const s = await setup()
  const c = s.context()
  s.run("", c)
  expect(c.printed).toEqual([["Use /btw <question> to ask or follow up; Esc or /btw clear closes the dock."]])
  expect(s.children).toEqual([])
  s.run("show", c)
  s.run("history", c)
  expect(s.children[0]!.options.prompt).toBe("show")
  expect(s.children[0]!.sent).toEqual(["history"])
})

test("an already-aborted command starts no dock or child", async () => {
  const s = await setup()
  const c = s.context()
  c.controller.abort()
  expect(() => s.run("Question", c)).toThrow()
  expect(s.children).toEqual([])
  expect(c.opened).toEqual([])
})
