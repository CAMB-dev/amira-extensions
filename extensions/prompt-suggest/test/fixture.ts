import { mock } from "bun:test"
import {
  type AnyEvent,
  type CompleteRequest,
  type CompleteResult,
  type ContextPreview,
  type EventMap,
  type ExtensionAPI,
  type ExtensionSettingsField,
  type InputSuggestionSlot,
  type Message,
  type SessionControl,
  validateExtensionSetting,
} from "@amira/api"
import extension from "../src/index.ts"
import { userMessage } from "../src/prediction.ts"

export function reply(text: string): CompleteResult {
  return {
    text,
    toolsKept: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: { provider: "session", model: "current" },
      stopReason: "end",
    },
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function flush() {
  await Bun.sleep(0)
}

export function fixture(
  options: {
    settings?: Record<string, unknown>
    available?: boolean
    history?: Message[]
    ordered?: boolean
  } = {},
) {
  let sessionId = "main"
  let available = options.available ?? true
  let shown: string | undefined
  let unloaded: (() => void) | undefined
  let fields: readonly ExtensionSettingsField[] = []
  let saved = options.settings ?? {}
  const changed: (() => void)[] = []
  const listeners = new Map<keyof EventMap, ((event: AnyEvent) => void)[]>()
  const history = options.history ?? [userMessage("fix it"), reply("Fixed the bug.").message]
  const context: ContextPreview = {
    systemPrompt: "Original session system prompt",
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    messages: history,
  }
  const preview = mock(async () => context)
  const complete = mock(async (_request: CompleteRequest) => reply("run the tests"))
  const leases: {
    slot: InputSuggestionSlot
    controller: AbortController
    set: ReturnType<typeof mock>
    release: ReturnType<typeof mock>
  }[] = []
  const acquire = mock(() => {
    if (!available) return
    leases.at(-1)?.controller.abort()
    const controller = new AbortController()
    controller.signal.addEventListener(
      "abort",
      () => {
        shown = undefined
      },
      { once: true },
    )
    const set = mock((text: string) => {
      if (controller.signal.aborted) return false
      shown = text
      return true
    })
    const release = mock(() => controller.abort())
    const slot: InputSuggestionSlot = { signal: controller.signal, set, release }
    leases.push({ slot, controller, set, release })
    return slot
  })
  const values = () =>
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        validateExtensionSetting(field, saved[field.key]) ? field.default : saved[field.key],
      ]),
    )
  const session = {
    info: () => ({ id: sessionId, model: { provider: "session", model: "current" } }),
    messages: () => history,
    preview,
  } as unknown as SessionControl
  function on(type: keyof EventMap, handler: (event: AnyEvent) => void) {
    const handlers = listeners.get(type) ?? []
    handlers.push(handler)
    listeners.set(type, handlers)
    return () => {}
  }
  const api = {
    settings: {
      declare: (declaration: { fields: readonly ExtensionSettingsField[] }) => {
        fields = declaration.fields
        return {
          get: values,
          onChange: (fn: () => void) => {
            changed.push(fn)
            return () => {}
          },
        }
      },
    },
    session: () => session,
    ui: { acquireInputSuggestionSlot: acquire },
    complete,
    on,
    ...(options.ordered === false
      ? {}
      : {
          onEvents: (types: readonly (keyof EventMap)[], handler: (event: AnyEvent) => void) => {
            for (const type of types) on(type, handler)
            return () => {}
          },
        }),
    onUnload: (fn: () => void) => {
      unloaded = fn
      return () => {}
    },
  } as unknown as ExtensionAPI
  void extension(api)
  let seq = 0
  function emit<K extends keyof EventMap>(
    type: K,
    data: EventMap[K],
    meta: {
      sessionId?: string
      parentSessionId?: string
      turnId?: string
    } = {},
  ) {
    const event = { type, data, seq: ++seq, ts: 0, sessionId, turnId: "turn-1", ...meta } as AnyEvent
    for (const handler of listeners.get(type) ?? []) handler(event)
  }
  return {
    api,
    acquire,
    complete,
    context,
    preview,
    history,
    leases,
    emit,
    values,
    get fields() {
      return fields
    },
    get shown() {
      return shown
    },
    end: (reason: "done" | "error" | "aborted" = "done", turnId = "turn-1") =>
      emit("turn.end", { reason, steps: 1 }, { turnId }),
    start: (turnId = "turn-2") => emit("turn.start", { prompt: userMessage("next") }, { turnId }),
    edit: () => leases.at(-1)?.controller.abort(),
    unload: () => unloaded?.(),
    setAvailable: (value: boolean) => {
      available = value
    },
    switchSession: (id: string) => {
      emit("session.end", { reason: "switch" })
      sessionId = id
      emit("session.start", { reason: "clear", cwd: ".", model: { provider: "session", model: "current" } })
    },
    changeSettings: (value: Record<string, unknown>) => {
      saved = value
      for (const fn of changed) fn()
    },
  }
}
