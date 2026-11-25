import { afterEach, expect, spyOn, test } from "bun:test"
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
  StatusItem,
  SubagentResult,
  UiContext,
  UiControl,
  UiEvent,
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
          queued.length = 0
          waiter?.resolve({ done: true, value: undefined })
          waiter = undefined
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }
  return {
    events,
    active: () => !!waiter,
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

function retryCommand(notice: Parameters<ExtensionAPI["notify"]>): string {
  const command = notice[2]?.details?.match(/\/btw (retry (?:r\d+|[0-9a-f-]+))/i)?.[1]
  if (!command) throw new Error("Expected an ask-again action in the recovery notice")
  return command
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

  const records = new Map<string, unknown[]>()
  const writes: { id: string; key: string; value: unknown }[] = []
  const recoveryWrites: typeof writes = []
  const unloadHooks: (() => void)[] = []
  const hostClosers: (() => void)[] = []
  const notices: Parameters<ExtensionAPI["notify"]>[] = []
  let currentSession: SessionControl | undefined
  const commands: CommandDefinition[] = []
  const views: ViewDefinition[] = []
  const statusItems: StatusItem[] = []
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
      abortRejects: false,
      abortPending: false,
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
        if (state.abortRejects) result.reject(new DOMException("Cancelled", "AbortError"))
        else if (!state.abortPending) result.resolve(outcome("aborted"))
        if (!state.abortPending) source.end()
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
      result,
      async answer(text: string) {
        await emit("message.end", {
          message: { role: "assistant", model: modelRef, content: [{ type: "text", text }] },
        })
        await emit("turn.end", { reason: "done", steps: 1 })
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
    settings: strict<ExtensionAPI["settings"]>("settings", {
      ...settings,
      extensions: settings.extensions,
      layers: () => [],
    }),
    session: () => currentSession,
    notify: (...args) => void notices.push(args),
    onUnload(handler) {
      unloadHooks.push(handler)
      return () => {}
    },
    registerCommand(command) {
      commands.push(command)
      return () => {}
    },
    registerView(view) {
      views.push(view)
      return () => {}
    },
    registerStatusItem(item) {
      statusItems.push(item)
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
    // There is no main-history messages/send/append API in this strict fake.
    const mainHistory = Object.freeze([
      Object.freeze({ role: "user", content: Object.freeze([{ type: "text", text: "Main question" }]) }),
    ])
    let mounted: FrontendView | undefined
    let mountedDefinition: ViewDefinition | undefined
    let closes = 0
    const parentModel = { provider: "test", model: "session-model" }
    const session = strict<SessionControl>("session", {
      data: {
        read: (key) => structuredClone(records.get(`${id}:${key}`) ?? []),
        append(key, value) {
          const write = { id, key, value: structuredClone(value) }
          writes.push(write)
          if (key === "btw.pending") recoveryWrites.push(write)
          const recordKey = `${id}:${key}`
          records.set(recordKey, [...(records.get(recordKey) ?? []), structuredClone(value)])
        },
      },
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
    currentSession = session
    function hostClose() {
      closes++
      if (mounted && "data" in mounted) mountedDefinition?.onClose?.(mounted.data)
      mounted = undefined
    }
    hostClosers.push(hostClose)
    const statePatches: Parameters<UiControl["setState"]>[0][] = []
    const control = strict<UiControl>("control", {
      close: hostClose,
      setState: (patch) => {
        statePatches.push(patch)
      },
      focus: () => {},
    })
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
        ui: views[0]!.ui?.(view.data, {
          width: 100,
          now: 0,
          height: 12,
          state: { selected: {}, expanded: {}, activeTabs: {}, scroll: {}, inputValues: {} },
        } as UiContext),
        replies,
      }
    }
    function sendUiEvent(event: UiEvent) {
      const view = opened.at(-1)
      if (!view || !("data" in view)) throw new Error("Expected a dock")
      views[0]!.onEvent?.(event, view.data, control)
    }
    return {
      ctx,
      controller,
      printed,
      opened,
      hostClose,
      shown,
      sendUiEvent,
      statePatches,
      mainHistory,
      closes: () => closes,
    }
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
    writes,
    recoveryWrites,
    records,
    notices,
    retry: (index: number) => retryCommand(notices[index - 1]!),
    unload(closeViews = true) {
      // API 0.1.46 closes owned views synchronously before invoking unload hooks.
      if (closeViews) for (const close of hostClosers) close()
      for (const hook of unloadHooks.splice(0)) hook()
    },
    children,
    groups,
    commands,
    views,
    statusItems,
    spawnFails: (error: unknown) => {
      spawnError = error
    },
    renders: () => renders,
    startQueued: () => {
      initialState = "queued"
    },
    async reload() {
      this.unload()
      commands.length = 0
      views.length = 0
      statusItems.length = 0
      listeners.clear()
      await extension(api)
    },
  }
}

test("unload during streaming preserves the unanswered question and partial answer", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Unanswered?", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial" })
  s.unload()
  await flush()
  expect(s.recoveryWrites).toHaveLength(1)
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "Unanswered?", answer: "Partial", timestamp: expect.any(Number), state: "in-flight" },
  ])
  expect(c.printed).toEqual([])
  expect(s.children[0]!.aborts).toHaveLength(1)
})

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
  await flush()
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

test("reload restores partial answers with an ask-again action and consumes storage", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial A" })
  await s.reload()
  expect(s.children).toHaveLength(1)
  expect(s.recoveryWrites.map((write) => write.value)).toEqual([
    [{ question: "A", answer: "Partial A", timestamp: expect.any(Number), state: "in-flight" }],
    [],
  ])
  expect(s.notices[0]?.[2]?.details).toContain("Partial A")
  expect(s.notices[0]?.[2]?.details).toContain("Interrupted by reload")
  expect(s.notices[0]?.[2]?.details).toContain(`/btw ${s.retry(1)}`)
  expect(c.printed).toEqual([])
  s.run("", c)
  expect(c.shown().replies).toEqual(["Partial A"])
  expect(c.shown().status).toBe("interrupted")
  s.run(s.retry(1), c)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("A")
  await s.children[1]!.answer("Answer A")
  c.hostClose()
  await flush()
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("Answer A")
})

test("unload with a queue saves every question and reload automatically re-queues them", async () => {
  const s = await setup()
  const c = s.context()
  s.startQueued()
  s.run("First", c)
  s.run("Second", c)
  s.run("Third", c)
  await s.reload()
  expect(s.children[0]!.aborts).toHaveLength(1)
  expect(s.groups[0]!.ends).toHaveLength(1)
  expect(s.recoveryWrites[0]?.value).toEqual(
    ["First", "Second", "Third"].map((question) => ({
      question,
      answer: "",
      timestamp: expect.any(Number),
      state: "queued",
    })),
  )
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("First")
  expect(s.children[1]!.sent).toEqual(["Second", "Third"])
  expect(s.recoveryWrites[1]?.value).toEqual([])
  expect(c.printed).toEqual([])
  await s.children[1]!.answer("Restored answer")
  expect(s.notices[0]?.[2]?.details).toContain("Restored answer")
  s.run("", c)
  expect(c.shown().replies).toContain("Restored answer")
})

test("a streaming question stays interrupted while its queued follow-ups restart", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial" })
  s.run("Next", c)
  s.run("Another", c)
  await s.reload()
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("Next")
  expect(s.children[1]!.sent).toEqual(["Another"])
  expect(s.notices).toHaveLength(1)
  expect(s.notices[0]?.[2]?.details).toContain("Partial")
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "First", answer: "Partial", timestamp: expect.any(Number), state: "in-flight" },
    { question: "Next", answer: "", timestamp: expect.any(Number), state: "queued" },
    { question: "Another", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("empty or fully answered sides write no recovery snapshot", async () => {
  const s = await setup()
  const c = s.context()
  await s.reload()
  expect(s.writes).toEqual([])
  expect(s.recoveryWrites).toEqual([])
  s.run("Done?", c)
  await s.children[0]!.answer("Done")
  await s.reload()
  expect(s.writes.filter((write) => write.key !== "btw.history")).toEqual([])
  expect(s.recoveryWrites).toEqual([])
  expect(s.children).toHaveLength(1)
})

test("completed questions are omitted while unanswered follow-ups are preserved", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Answered", c)
  await s.children[0]!.answer("Done")
  s.run("Pending", c)
  s.unload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "Pending", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("stale and malformed recovery items are dropped, and empty latest records prevent replay", async () => {
  const s = await setup()
  const c = s.context()
  const now = Date.now()
  s.records.set("session-a:btw.pending", [
    [
      { question: "Stale", answer: "Old", timestamp: now - 24 * 60 * 60 * 1000 - 1000, state: "in-flight" },
      { question: "Fresh", answer: "Partial", timestamp: now, state: "in-flight" },
      { question: "Bad", answer: 42, timestamp: now, state: "queued" },
      null,
    ],
  ])
  await s.reload()
  expect(s.notices).toHaveLength(1)
  expect(s.notices[0]?.[2]?.details).toContain("Fresh")
  expect(s.notices[0]?.[2]?.details).not.toContain("Stale")
  expect(s.recoveryWrites).toEqual([{ id: "session-a", key: "btw.pending", value: [] }])
  s.run("clear", c)
  const noticesAfterClear = s.notices.length
  await s.reload()
  expect(s.notices).toHaveLength(noticesAfterClear)
  expect(s.recoveryWrites).toHaveLength(1)
})

test("the 24-hour cutoff is inclusive and uses the original question timestamp", async () => {
  const now = 1_800_000_000_000
  const clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    const s = await setup()
    s.context()
    const boundary = now - 24 * 60 * 60 * 1000
    s.records.set("session-a:btw.pending", [
      [
        { question: "At cutoff", answer: "Partial", timestamp: boundary, state: "in-flight" },
        { question: "Expired", answer: "Old", timestamp: boundary - 1, state: "in-flight" },
      ],
    ])
    await s.reload()
    expect(s.notices).toHaveLength(1)
    expect(s.notices[0]?.[2]?.details).toContain("At cutoff")
    clock.mockReturnValue(now + 1)
    await s.reload()
    expect(s.notices).toHaveLength(1)
    expect(s.recoveryWrites.at(-1)?.value).toEqual([])
  } finally {
    clock.mockRestore()
  }
})

test("a stale-only snapshot is consumed without starting work or showing a notice", async () => {
  const s = await setup()
  s.context()
  s.records.set("session-a:btw.pending", [[{ question: "Stale", answer: "", timestamp: 0, state: "queued" }]])
  await s.reload()
  expect(s.children).toEqual([])
  expect(s.notices).toEqual([])
  expect(s.recoveryWrites[0]?.value).toEqual([])
  await s.reload()
  expect(s.recoveryWrites).toHaveLength(1)
})

test("explicit close and clear do not become reload recovery candidates", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  s.run("clear", c)
  await s.reload()
  expect(s.recoveryWrites).toEqual([])
  expect(s.children).toHaveLength(1)
  expect(c.printed).toHaveLength(1)
  s.run("B", c)
  c.hostClose()
  await flush()
  await s.reload()
  expect(s.recoveryWrites).toEqual([])
  expect(s.children).toHaveLength(2)
  expect(c.printed).toHaveLength(2)
})

test("restored interruptions survive another reload without automatically asking again", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial" })
  await s.reload()
  await s.reload()
  expect(s.children).toHaveLength(1)
  const original = s.recoveryWrites[0]!.value
  if (!Array.isArray(original)) throw new Error("Expected a recovery snapshot")
  expect(s.recoveryWrites[2]?.value).toEqual([
    { ...original[0], state: "interrupted", retryId: s.retry(1).slice("retry ".length) },
  ])
  expect(s.notices.at(-1)?.[2]?.details).toContain("Partial")
  expect(retryCommand(s.notices.at(-1)!)).toBe(s.retry(1))
})

test("recovery is session-scoped and replayed session.start cannot restore twice", async () => {
  const s = await setup()
  const a = s.context({ id: "a" })
  s.run("A", a)
  const b = s.context({ id: "b" })
  s.run("B", b)
  await s.reload()
  expect(s.recoveryWrites.filter((write) => write.id === "a")[0]?.value).toEqual([
    { question: "A", answer: "", timestamp: expect.any(Number), state: "in-flight" },
  ])
  expect(s.notices).toHaveLength(1)
  expect(s.notices[0]?.[2]?.details).toContain("B")
  s.emit("session.start", { reason: "resume", cwd: "/work", model: { provider: "test", model: "m" } }, "b")
  expect(s.notices).toHaveLength(1)
  s.context({ id: "a" })
  s.emit("session.start", { reason: "resume", cwd: "/work", model: { provider: "test", model: "m" } }, "a")
  expect(s.notices).toHaveLength(2)
})

test("cancellation releases the event consumer and suppresses late stream/result errors", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const child = s.children[0]!
  await child.emit("message.delta", { kind: "text", text: "Partial" })
  child.source.reject(new DOMException("Cancelled stream", "AbortError"))
  child.state.abortRejects = true
  s.unload()
  const renders = s.renders()
  await flush()
  expect(child.aborts).toHaveLength(1)
  expect(s.groups[0]!.ends).toHaveLength(1)
  expect(child.source.active()).toBe(false)
  expect(s.renders()).toBe(renders)
  expect(c.shown().lines.filter((line) => line.kind === "error")).toEqual([])
  expect(c.printed).toEqual([])
  expect(s.notices).toEqual([])
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "A", answer: "Partial", timestamp: expect.any(Number), state: "in-flight" },
  ])
})

test("unload closes subscriptions without waiting for the host's request to settle", async () => {
  const s = await setup()
  const c = s.context({ dock: "deferred" })
  s.run("A", c)
  const child = s.children[0]!
  child.state.abortPending = true
  expect(child.source.active()).toBe(true)
  s.unload(false)
  expect(child.source.active()).toBe(false)
  child.result.reject(new DOMException("Late cancellation", "AbortError"))
  await flush()
  expect(child.aborts).toEqual(["btw unloaded"])
  expect(s.groups[0]!.ends).toEqual(["btw unloaded"])
  expect(c.printed).toEqual([])
  expect(c.shown().lines.filter((line) => line.kind === "error")).toEqual([])
})

test("buffered output after unload cannot change the persisted partial answer", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const child = s.children[0]!
  await child.emit("message.delta", { kind: "text", text: "Partial" })
  child.source.push({
    type: "message.delta",
    data: { kind: "text", text: "Too late" },
    sessionId: child.child.id,
    seq: 100,
    ts: 100,
  })
  s.unload()
  await flush()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "A", answer: "Partial", timestamp: expect.any(Number), state: "in-flight" },
  ])
  expect(c.printed).toEqual([])
})

test("retry IDs stay stable and blocked docks do not consume interrupted questions", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Partial A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Partial B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  const blocked = s.context({ dock: "blocked" })
  expect(() => s.run(s.retry(1), blocked)).toThrow("dock cannot open")
  s.run(s.retry(1), c)
  expect(s.children[0]!.options.prompt).toBe("A")
  await s.children[0]!.end("error", { error: "Turn failed" })
  s.run(s.retry(2), c)
  expect(s.children[1]!.options.prompt).toBe("B")
  s.run(s.retry(1), c)
  expect(c.printed.at(-1)?.[0]).toContain("no longer available")
})

test("short retry IDs are monotonic, case-insensitive, and never accept old bare numbers", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Partial A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Partial B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  expect(s.retry(1)).toBe("retry r1")
  expect(s.retry(2)).toBe("retry r2")
  expect(s.records.get("session-a:btw.retry.counter")).toEqual([1, 2])
  s.run("retry 1", c)
  expect(c.printed.at(-1)?.[0]).toContain("no longer available")
  expect(s.children).toHaveLength(0)
  s.run("retry R1", c)
  expect(s.children[0]!.options.prompt).toBe("A")
  await s.children[0]!.answer("Completed A")
  await s.reload()
  expect(retryCommand(s.notices.at(-1)!)).toBe("retry r2")
  expect(s.records.get("session-a:btw.retry.counter")).toEqual([1, 2])
  for (const action of ["retry r1", "retry R1", "retry 2"]) {
    s.run(action, c)
    expect(c.printed.at(-1)?.[0]).toContain("no longer available")
    expect(s.children).toHaveLength(1)
  }
  s.run("retry R2", c)
  expect(s.children[1]!.options.prompt).toBe("B")
})

test("persisted retry commands never change questions across multiple reloads", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Partial A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Partial B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  const askA = s.retry(1)
  const askB = s.retry(2)
  expect(askA).not.toBe(askB)
  s.run(askA, c)
  await s.children[0]!.answer("Completed A")
  await s.reload()
  s.run(askA, c)
  expect(c.printed.at(-1)?.[0]).toContain("no longer available")
  expect(s.children).toHaveLength(1)
  expect(retryCommand(s.notices.at(-1)!)).toBe(askB)
  await s.reload()
  expect(retryCommand(s.notices.at(-1)!)).toBe(askB)
  s.run(askB, c)
  expect(s.children[1]!.options.prompt).toBe("B")
  await s.children[1]!.answer("Completed B")
  await s.reload()
  s.run(askB, c)
  expect(c.printed.at(-1)?.[0]).toContain("no longer available")
  expect(s.children).toHaveLength(2)
})

test("cleared and stale retry IDs are reserved for the rest of the session", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.retry.counter", [5])
  s.records.set("session-a:btw.pending", [
    [
      { question: "Stale", answer: "Old", timestamp: 0, state: "interrupted", retryId: "r5" },
      { question: "Clear me", answer: "Partial", timestamp: Date.now(), state: "interrupted", retryId: "r2" },
    ],
  ])
  await s.reload()
  expect(s.notices).toHaveLength(1)
  expect(s.retry(1)).toBe("retry r2")
  s.run("clear", c)
  await s.reload()
  s.run("New question", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "New partial" })
  await s.reload()
  expect(retryCommand(s.notices.at(-1)!)).toBe("retry r6")
  expect(s.records.get("session-a:btw.retry.counter")).toEqual([5, 6])
  for (const action of ["retry r2", "retry R5", "retry 6"]) {
    s.run(action, c)
    expect(c.printed.at(-1)?.[0]).toContain("no longer available")
    expect(s.children).toHaveLength(1)
  }
  s.run("retry R6", c)
  expect(s.children[1]!.options.prompt).toBe("New question")
})

test("historical dropped IDs reserve the counter even without a matching counter record", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.retry.counter", [5, 3, "99", null])
  s.records.set("session-a:btw.pending", [
    [{ question: "Stale", answer: "Old", timestamp: 0, state: "interrupted", retryId: "r7" }],
  ])
  await s.reload()
  expect(s.notices).toEqual([])
  s.run("Fresh", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial" })
  await s.reload()
  expect(s.retry(1)).toBe("retry r8")
  expect(s.records.get("session-a:btw.retry.counter")).toEqual([5, 3, "99", null, 8])
})

test("retry counters are isolated per session", async () => {
  const s = await setup()
  const a = s.context({ id: "a" })
  s.run("A", a)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial A" })
  const b = s.context({ id: "b" })
  s.run("B", b)
  await s.children[1]!.emit("message.delta", { kind: "text", text: "Partial B" })
  await s.reload()
  expect(s.retry(1)).toBe("retry r1")
  expect(s.records.get("b:btw.retry.counter")).toEqual([1])
  expect(s.records.get("a:btw.retry.counter")).toBeUndefined()
  s.context({ id: "a" })
  s.emit("session.start", { reason: "resume", cwd: "/work", model: { provider: "test", model: "m" } }, "a")
  expect(s.retry(2)).toBe("retry r1")
  expect(s.records.get("a:btw.retry.counter")).toEqual([1])
})

test("UUID recovery records migrate to short IDs without reviving UUID actions", async () => {
  const s = await setup()
  const c = s.context()
  const legacy = "00000000-0000-4000-8000-000000000001"
  s.records.set("session-a:btw.pending", [
    [{ question: "A", answer: "Partial A", timestamp: Date.now(), state: "interrupted", retryId: legacy }],
  ])
  await s.reload()
  expect(s.retry(1)).toBe("retry r1")
  expect(s.notices[0]?.[2]?.details).toContain("Partial A")
  s.run(`retry ${legacy}`, c)
  expect(c.printed.at(-1)?.[0]).toContain("no longer available")
  expect(s.children).toHaveLength(0)
  s.run("retry r1", c)
  expect(s.children[0]!.options.prompt).toBe("A")
})

test("new recoveries cannot reuse consumed or legacy numbered retry commands", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial A" })
  await s.reload()
  const askA = s.retry(1)
  s.run(askA, c)
  await s.children[1]!.answer("Completed A")
  s.run("clear", c)
  await s.reload()
  s.run("B", c)
  await s.children[2]!.emit("message.delta", { kind: "text", text: "Partial B" })
  await s.reload()
  const askB = retryCommand(s.notices.at(-1)!)
  expect(askA).toBe("retry r1")
  expect(askB).toBe("retry r2")
  expect(s.records.get("session-a:btw.retry.counter")).toEqual([1, 2])
  for (const action of [askA, "retry 1"]) {
    s.run(action, c)
    expect(c.printed.at(-1)?.[0]).toContain("no longer available")
    expect(s.children).toHaveLength(3)
  }
  s.run(askB, c)
  expect(s.children[3]!.options.prompt).toBe("B")
})

for (const reopen of [false, true]) {
  test(`Esc discards recovered work only with a reopened dock (${reopen})`, async () => {
    const s = await setup()
    const c = s.context()
    s.startQueued()
    s.run("A", c)
    await s.reload()
    const recovered = s.children[1]!
    const writes = s.recoveryWrites.length
    if (reopen) s.run("", c)
    c.hostClose()
    await flush()
    expect(recovered.aborts).toHaveLength(reopen ? 1 : 0)
    s.run("clear", c)
    expect(recovered.aborts).toHaveLength(1)
    s.unload()
    expect(s.recoveryWrites).toHaveLength(writes)
  })
}

test("turn delivery distinguishes injected questions from undelivered follow-ups", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First", c)
  const child = s.children[0]!
  s.run("Injected", c)
  s.run("Queued", c)
  await child.emit("turn.steer", {
    message: { role: "user", content: [{ type: "text", text: "Injected" }] },
    state: "injected",
  })
  await child.emit("message.delta", { kind: "text", text: "Shared partial" })
  s.unload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "First", answer: "Shared partial", timestamp: expect.any(Number), state: "in-flight" },
    { question: "Injected", answer: "Shared partial", timestamp: expect.any(Number), state: "in-flight" },
    { question: "Queued", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("repeated questions and substrings are not mistaken for delivered follow-ups", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First question", c)
  const child = s.children[0]!
  s.run("First question", c)
  s.run("question", c)
  await child.emit("turn.start", {
    prompt: { role: "user", content: [{ type: "text", text: "First question" }] },
  })
  await child.emit("message.delta", { kind: "text", text: "Partial" })
  s.unload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "First question", answer: "Partial", timestamp: expect.any(Number), state: "in-flight" },
    { question: "First question", answer: "", timestamp: expect.any(Number), state: "queued" },
    { question: "question", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("finished turns consume delivered questions but keep the remaining queue", async () => {
  const s = await setup()
  const c = s.context()
  s.startQueued()
  s.run("A", c)
  s.run("B", c)
  s.run("C", c)
  const child = s.children[0]!
  await child.emit("turn.start", {
    prompt: {
      role: "user",
      content: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ],
    },
  })
  await child.emit("message.delta", { kind: "text", text: "Answer A/B" })
  await child.emit("turn.end", { reason: "done", steps: 1 })
  s.unload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "C", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("a fully answered dock still saves its display block on unload", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.answer("Answer A")
  await s.reload()
  expect(s.recoveryWrites).toEqual([])
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("Answer A")
})

test("review: idle follow-ups awaiting admission stay queued across reload", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const child = s.children[0]!
  await child.answer("Answer A")
  s.run("B", c)
  child.state.value = "queued"
  await child.emit(
    "subagent.state",
    { childSessionId: child.child.id, state: "queued", turns: 1 },
    "session-a",
  )
  await s.reload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "B", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
  expect(s.children[1]!.options.prompt).toBe("B")
})

test("review: a replacement cannot attribute its partial output to a failed child's question", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Old A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Old B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  s.run(s.retry(1), c)
  await s.children[0]!.emit("message.delta", { kind: "text", text: "New A" })
  await s.children[0]!.end("error", { error: "A failed" })
  s.run(s.retry(2), c)
  await s.children[1]!.emit("message.delta", { kind: "text", text: "New B" })
  s.unload()
  expect(s.recoveryWrites.at(-1)?.value).toEqual([
    {
      question: "A",
      answer: "New A",
      timestamp: expect.any(Number),
      state: "interrupted",
      retryId: expect.any(String),
    },
    { question: "B", answer: "New B", timestamp: expect.any(Number), state: "in-flight" },
  ])
})

test("review: a late old-child result cannot fail or end its replacement", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Old A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Old B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  s.run(s.retry(1), c)
  const old = s.children[0]!
  old.state.value = "ended"
  old.source.push({
    type: "message.delta",
    data: { kind: "text", text: "Old output" },
    sessionId: old.child.id,
    seq: 100,
    ts: 100,
  })
  old.result.resolve({
    sessionId: old.child.id,
    status: "error",
    text: "",
    error: "Old failure",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    steps: 1,
    durationMs: 1,
  })
  // Do not flush the old callback before installing a replacement.
  s.run(s.retry(2), c)
  await flush()
  expect(s.groups[1]!.ends).toEqual([])
  expect(c.shown().status).toBe("working")
  expect(c.shown().lines.some((line) => "text" in line && line.text.includes("Old failure"))).toBe(false)
  expect(old.source.active()).toBe(false)
  expect(c.shown().replies).not.toContain("Old output")
})

test("review: completed answers are saved independently of pending recovery", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  await s.children[0]!.answer("Answer A")
  s.run("B", c)
  await s.children[0]!.emit("turn.start", {
    prompt: { role: "user", content: [{ type: "text", text: "B" }] },
  })
  await s.children[0]!.emit("message.delta", { kind: "text", text: "Partial B" })
  await s.reload()
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toBe("**Question**\n\nA\n\n**Answer**\n\nAnswer A")
  expect(s.notices[0]?.[2]?.details).toContain("Partial B")
})

test("replacement explicitly resends old queued questions and tracks repeated delivery separately", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [
      { question: "A", answer: "Old A", timestamp: Date.now(), state: "in-flight" },
      { question: "B", answer: "Old B", timestamp: Date.now(), state: "in-flight" },
    ],
  ])
  await s.reload()
  s.run(s.retry(1), c)
  s.run("B", c)
  await s.children[0]!.end("error", { error: "A failed before B was delivered" })
  s.startQueued()
  s.run(s.retry(2), c)
  const replacement = s.children[1]!
  expect(replacement.options.prompt).toBe("B")
  expect(replacement.sent).toEqual(["B"])
  const prompt: EventMap["turn.start"]["prompt"] = { role: "user", content: [{ type: "text", text: "B" }] }
  await replacement.emit("turn.start", { prompt })
  await replacement.answer("Answer to queued B")
  await replacement.emit("turn.start", { prompt })
  await replacement.answer("Answer to retried B")
  s.unload()
  expect(s.recoveryWrites.at(-1)?.value).toEqual([
    {
      question: "A",
      answer: "",
      timestamp: expect.any(Number),
      state: "interrupted",
      retryId: expect.any(String),
    },
  ])
  expect(c.printed[0]?.[2]?.details).toContain("Answer to queued B")
  expect(c.printed[0]?.[2]?.details).toContain("Answer to retried B")
})

test("an earlier buffered turn.end cannot settle a newly accepted follow-up", async () => {
  const s = await setup()
  const c = s.context()
  s.run("A", c)
  const child = s.children[0]!
  await child.emit("message.end", {
    message: { role: "assistant", model: child.child.model, content: [{ type: "text", text: "Answer A" }] },
  })
  child.state.value = "idle"
  child.source.push({
    type: "turn.end",
    data: { reason: "done", steps: 1 },
    sessionId: child.child.id,
    seq: 100,
    ts: 100,
  })
  s.run("B", c)
  await flush()
  s.unload()
  expect(s.recoveryWrites[0]?.value).toEqual([
    { question: "B", answer: "", timestamp: expect.any(Number), state: "queued" },
  ])
})

test("restored queues wait safely for an agent tree and resume when a command can provide one", async () => {
  const s = await setup()
  const c = s.context()
  s.startQueued()
  s.run("A", c)
  s.context({ tree: false })
  await s.reload()
  expect(s.children).toHaveLength(1)
  expect(s.recoveryWrites.at(-1)?.value).toEqual([])
  const ready = s.context()
  s.run("", ready)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("A")
})

test("failed automatic restarts stay visible and retain the queue before new questions", async () => {
  const s = await setup()
  const c = s.context()
  s.startQueued()
  s.run("A", c)
  s.run("B", c)
  s.spawnFails(new Error("budget exhausted"))
  await s.reload()
  expect(s.notices).toHaveLength(1)
  expect(s.notices[0]?.[1]).toBe("error")
  expect(s.notices[0]?.[2]?.details).toContain("budget exhausted")
  s.spawnFails(undefined)
  s.run("C", c)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("A")
  expect(s.children[1]!.sent).toEqual(["B", "C"])
  s.unload()
  expect(s.recoveryWrites.at(-1)?.value).toEqual(
    ["A", "B", "C"].map((question) => ({
      question,
      answer: "",
      timestamp: expect.any(Number),
      state: "queued",
    })),
  )
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
  await flush()
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
  await flush()
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
  await flush()
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
  await flush()
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("provider unavailable")
})

test("an ended child is replaced without discarding its unanswered question", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Question", c)
  await s.children[0]!.end("aborted")
  s.run("Next question", c)
  expect(s.children).toHaveLength(2)
  expect(s.children[1]!.options.prompt).toBe("Next question")
  expect(s.children[0]!.sent).toEqual([])
  expect(c.printed).toEqual([])
  expect(
    c.shown().lines.some((line) => "text" in line && line.text.includes("Ask again with /btw retry")),
  ).toBe(true)
  s.unload()
  expect(s.recoveryWrites.at(-1)?.value).toEqual([
    {
      question: "Question",
      answer: "",
      timestamp: expect.any(Number),
      state: "interrupted",
      retryId: expect.any(String),
    },
    { question: "Next question", answer: "", timestamp: expect.any(Number), state: "in-flight" },
  ])
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
  await flush()
  expect(s.children[0]!.aborts).toHaveLength(1)
  expect(s.children[1]!.aborts).toEqual([])
  expect(a.printed).toHaveLength(1)
  expect(b.printed).toEqual([])
  await s.children[1]!.answer("B answer")
  b.hostClose()
  await flush()
  expect(b.printed[0]?.[2]?.details).toContain("B answer")
})

test("empty args explain the dock commands and show is an ordinary question", async () => {
  const s = await setup()
  const c = s.context()
  s.run("", c)
  expect(c.printed[0]?.[0]).toContain("Use /btw <question> to ask or follow up")
  expect(s.children).toEqual([])
  s.run("show", c)
  expect(s.children[0]!.options.prompt).toBe("show")
})

test("an already-aborted command starts no dock or child", async () => {
  const s = await setup()
  const c = s.context()
  c.controller.abort()
  expect(() => s.run("Question", c)).toThrow()
  expect(s.children).toEqual([])
  expect(c.opened).toEqual([])
})

test("declarative ui submits inline follow-ups, hides without killing the child, and switches full/dock", async () => {
  const s = await setup()
  const c = s.context()
  s.run("First question", c)
  const child = s.children[0]!
  expect(s.statusItems[0]?.text()).toBe("● btw")
  await child.answer("First answer")
  expect(s.statusItems[0]?.text()).toBeUndefined()

  // Inline follow-up input inside the focus-bordered dock is the first focusable widget so Tab lands directly in it.
  const ui = c.shown().ui
  expect(ui?.type).toBe("box")
  if (ui?.type === "box" && ui.child.type === "column") {
    const transcript = ui.child.children.find((entry) => entry.node.type === "text")?.node
    expect(transcript?.type === "text" && transcript.id).toBeUndefined()
  }
  c.sendUiEvent({ type: "submit", id: "followup", value: "  Second question  " })
  expect(c.statePatches.at(-1)).toEqual({ inputValues: { followup: "" } })
  expect(child.sent).toEqual(["Second question"])
  expect(s.children).toHaveLength(1)
  await child.answer("Second answer")

  // Clicking [ Hide ] closes the dock WITHOUT aborting the child or printing early, and shows status pill.
  c.sendUiEvent({ type: "activate", id: "hide", key: "hide" })
  await flush()
  expect(child.aborts).toEqual([])
  expect(c.printed).toEqual([])
  expect(s.statusItems[0]?.text()).toBe("btw · hidden (2)")

  // Running /btw reopens the same living side conversation.
  s.run("", c)
  expect(c.opened.at(-1)).toMatchObject({ placement: "dock" })
  expect(s.statusItems[0]?.text()).toBeUndefined()

  // /btw full switches to fullscreen without killing the child; /btw dock returns to dock.
  s.run("full", c)
  expect(c.opened.at(-1)).toMatchObject({ placement: "fullscreen" })
  expect(child.aborts).toEqual([])
  s.run("dock", c)
  expect(c.opened.at(-1)).toMatchObject({ placement: "dock" })
  expect(child.aborts).toEqual([])

  // Clicking [ Clear ] closes cleanly and persists all Q&A once.
  c.sendUiEvent({ type: "activate", id: "clear", key: "clear" })
  await flush()
  expect(child.aborts).toHaveLength(1)
  expect(c.printed).toHaveLength(1)
  expect(c.printed[0]?.[2]?.details).toContain("First answer")
  expect(c.printed[0]?.[2]?.details).toContain("Second answer")
})

test("live tool calls render in the dock without polluting saved display details", async () => {
  const s = await setup()
  const c = s.context()
  s.run("Inspect file", c)
  const child = s.children[0]!
  await child.emit("tool.execute.start", {
    toolCallId: "t1",
    name: "read",
    args: { path: "src/index.ts" },
  })
  expect(
    c
      .shown()
      .lines.some(
        (line) =>
          line.kind === "segments" &&
          line.parts.some((p) => "text" in p && p.text.includes("read")) &&
          line.parts.some((p) => "text" in p && p.text.includes("src/index.ts")),
      ),
  ).toBe(true)
  await child.emit("tool.execute.end", {
    toolCallId: "t1",
    name: "read",
    durationMs: 42,
    result: { content: [{ type: "text", text: "ok" }], isError: false },
  })
  expect(
    c
      .shown()
      .lines.some(
        (line) =>
          line.kind === "segments" &&
          line.parts.some((p) => "text" in p && p.text === "✓") &&
          line.parts.some((p) => "text" in p && p.text.includes("42ms")),
      ),
  ).toBe(true)
  await child.answer("Found it")
  c.hostClose()
  await flush()
  expect(c.printed[0]?.[2]?.details).toBe("**Question**\n\nInspect file\n\n**Answer**\n\nFound it")
})

test("clicking [ Retry r1 ] in the dock retries an interrupted question directly", async () => {
  const s = await setup()
  const c = s.context()
  s.records.set("session-a:btw.pending", [
    [{ question: "Interrupted Q", answer: "Partial", timestamp: Date.now(), state: "in-flight" }],
  ])
  await s.reload()
  expect(s.statusItems[0]?.text()).toBe("btw · retry r1")
  s.run("", c)
  c.sendUiEvent({ type: "activate", id: "retry", key: "r1" })
  expect(s.children).toHaveLength(1)
  expect(s.children[0]!.options.prompt).toBe("Interrupted Q")
})

test("multi-turn btw conversations are archived and can be resumed across close and reload with full context", async () => {
  const s = await setup()
  const c = s.context()
  s.run("How does auth work?", c)
  await s.children[0]!.answer("It uses JWT cookies.")
  s.run("Where is the secret loaded?", c)
  await s.children[0]!.answer("From AUTH_SECRET in src/auth.ts.")

  // Close the dock and reload the extension (simulating /resume or restart).
  c.hostClose()
  await flush()
  expect(c.printed).toHaveLength(1)
  await s.reload()

  // /btw resume restores the full 2-turn conversation without spawning a child yet.
  const c2 = s.context()
  s.run("resume", c2)
  expect(s.children).toHaveLength(1)
  expect(c2.shown().status).toBe("history")
  expect(c2.shown().lines).toContainEqual({ kind: "user-message", text: "How does auth work?" })
  expect(c2.shown().lines).toContainEqual({ kind: "user-message", text: "Where is the secret loaded?" })

  // Closing a read-only resumed thread does not duplicate the saved display block.
  c2.hostClose()
  await flush()
  expect(c2.printed).toEqual([])

  // Resume again and send a 3rd follow-up: new child forks with prior btw turns in the prompt (keeping systemPrompt unchanged).
  const c3 = s.context()
  s.run("resume h1", c3)
  c3.sendUiEvent({ type: "submit", id: "followup", value: "Is token rotation implemented?" })
  expect(s.children).toHaveLength(2)
  const resumedChild = s.children[1]!
  expect(resumedChild.options.context).toBe("fork")
  expect(resumedChild.options.prompt).toContain("How does auth work?")
  expect(resumedChild.options.prompt).toContain("It uses JWT cookies.")
  expect(resumedChild.options.prompt).toContain("Where is the secret loaded?")
  expect(resumedChild.options.prompt).toContain("From AUTH_SECRET in src/auth.ts.")
  expect(resumedChild.options.prompt).toContain("Is token rotation implemented?")
  await resumedChild.emit("turn.start", {
    prompt: { role: "user", content: [{ type: "text", text: resumedChild.options.prompt }] },
  })
  await resumedChild.answer("Not yet, tokens expire after 24h.")

  // Subsequent follow-up reuses the live child directly without re-wrapping history.
  c3.sendUiEvent({ type: "submit", id: "followup", value: "Thanks!" })
  expect(resumedChild.sent).toEqual(["Thanks!"])
  await resumedChild.answer("You're welcome.")

  // Closing saves the updated thread once and updates h1 in place with all 4 turns.
  c3.hostClose()
  await flush()
  expect(c3.printed).toHaveLength(1)
  const latest = s.records.get("session-a:btw.history")?.at(-1) as { id: string; turns: unknown[] }[]
  expect(latest).toHaveLength(1)
  expect(latest[0]?.id).toBe("h1")
  expect(latest[0]?.turns).toHaveLength(4)
})

test("/btw history opens the interactive history table and supports restore, delete, and clear all", async () => {
  const s = await setup()
  const c = s.context()
  s.run("history", c)
  expect(c.printed[0]?.[0]).toContain("No saved btw history")

  // Create two separate threads.
  s.run("Topic A", c)
  await s.children[0]!.answer("Answer A")
  s.run("clear", c)
  s.run("Topic B", c)
  await s.children[1]!.answer("Answer B")
  s.run("clear", c)

  // Open /btw history and verify table lists newest first (h2 then h1).
  const c2 = s.context()
  s.run("history", c2)
  const ui = c2.shown().ui
  expect(ui?.type).toBe("box")
  const table =
    ui?.type === "box" && ui.child.type === "column"
      ? ui.child.children.find((entry) => entry.node.type === "table")?.node
      : undefined
  expect(table?.type).toBe("table")
  if (table?.type === "table") {
    expect(table.rows.map((r) => r.key)).toEqual(["h2", "h1"])
  }

  // Selecting and activating h1 restores Topic A into the dock.
  c2.sendUiEvent({ type: "select", id: "history-list", key: "h1" })
  c2.sendUiEvent({ type: "activate", id: "history-list", key: "h1" })
  expect(c2.shown().lines).toContainEqual({ kind: "user-message", text: "Topic A" })

  // Clicking [History] inside chat returns to history table, then [Delete] removes h1 and [Clear All] empties it.
  c2.sendUiEvent({ type: "activate", id: "history", key: "history" })
  c2.sendUiEvent({ type: "select", id: "history-list", key: "h1" })
  c2.sendUiEvent({ type: "activate", id: "history-delete", key: "history-delete" })
  const remaining = (s.records.get("session-a:btw.history")?.at(-1) as { id: string }[] | undefined) ?? []
  expect(remaining.map((t) => t.id)).toEqual(["h2"])

  c2.sendUiEvent({ type: "activate", id: "history-clear", key: "history-clear" })
  expect(s.records.get("session-a:btw.history")?.at(-1)).toEqual([])
})
