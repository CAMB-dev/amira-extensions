import type {
  AnyEvent,
  ChildSession,
  CommandContext,
  Extension,
  SessionControl,
  SessionData,
  SpawnGroup,
  UiControl,
  UserMessage,
  ViewDefinition,
  ViewLine,
} from "@amira/api"

const SYSTEM =
  "Answer this side question briefly using the forked conversation. You may read files, but must not change files or the main conversation."
const RETRY = "Close the dock with Esc or /btw clear, then ask again."
const DATA_KEY = "btw.pending"
const MAX_AGE = 24 * 60 * 60 * 1000
const COUNTER_KEY = "btw.retry.counter"
const LEGACY_RETRY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

type Pending = {
  question: string
  answer: string
  timestamp: number
  state: "queued" | "in-flight" | "interrupted"
  retryId?: string
}
type Entry = { kind: "question" | "reply" | "error" | "note"; text: string; pending?: Pending[] }

interface Side {
  sessionId: string
  question: string
  entries: Entry[]
  pending: Pending[]
  retries: Map<string, Pending>
  completed: Set<Pending>
  events?: AsyncIterator<AnyEvent>
  data?: SessionData
  child?: ChildSession
  group?: SpawnGroup
  control?: UiControl
  print: CommandContext["print"]
  status: string
  closed: boolean
  opened: boolean
  saved: boolean
  failure?: string
}

function details(side: Pick<Side, "entries">): string {
  return side.entries
    .filter((entry) => entry.text)
    .map((entry) => {
      const label = { question: "Question", reply: "Answer", error: "Error", note: "Status" }[entry.kind]
      return `**${label}**\n\n${entry.text}`
    })
    .join("\n\n")
}

function retryNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^r[1-9]\d*$/i.test(value)) return
  const number = Number(value.slice(1))
  return Number.isSafeInteger(number) ? number : undefined
}

function recoveryCounter(data?: SessionData): number {
  let counter = 0
  for (const value of data?.read(COUNTER_KEY) ?? []) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      counter = Math.max(counter, value)
    }
  }
  // Include historical snapshots before filtering stale items or consuming them. This
  // also reserves IDs if a snapshot is present without its separate counter record.
  for (const snapshot of data?.read(DATA_KEY) ?? []) {
    if (!Array.isArray(snapshot)) continue
    for (const item of snapshot) {
      if (item && typeof item === "object") counter = Math.max(counter, retryNumber(item.retryId) ?? 0)
    }
  }
  return counter
}

function recover(value: unknown): Pending[] {
  if (!Array.isArray(value)) return []
  const cutoff = Date.now() - MAX_AGE
  return value.filter((item): item is Pending => {
    if (!item || typeof item !== "object") return false
    return (
      typeof item.question === "string" &&
      !!item.question.trim() &&
      typeof item.answer === "string" &&
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp) &&
      item.timestamp >= cutoff &&
      ["queued", "in-flight", "interrupted"].includes(item.state) &&
      (item.retryId === undefined ||
        retryNumber(item.retryId) !== undefined ||
        (typeof item.retryId === "string" && LEGACY_RETRY_ID.test(item.retryId)))
    )
  })
}

const extension: Extension = (api) => {
  const viewKind = `btw:${crypto.randomUUID()}`
  const sides = new Map<string, Side>()
  const counters = new Map<string, number>()
  // The host closes views BEFORE onUnload, without a close reason. Keep their recovery
  // candidates until the synchronous unload hook has had a chance to claim them.
  const closing = new Set<Side>()
  let unloaded = false

  function saveDisplay(side: Side, entries = side.entries) {
    if (side.saved) return
    side.saved = true
    const question = entries.find((entry) => entry.kind === "question")?.text ?? side.question
    side.print(`btw: ${question}`, "info", {
      details: details({ entries }),
      markdown: true,
      persist: true,
    })
  }

  function stopWatching(side: Side) {
    const events = side.events
    side.events = undefined
    if (!events?.return) return
    try {
      void Promise.resolve(events.return()).catch(() => {})
    } catch {
      // Cancellation cleanup must not add an error to the transcript.
    }
  }

  function finish(side: Side, persist = true, reason = "btw dock closed") {
    if (side.closed) return
    side.closed = true
    if (sides.get(side.sessionId) === side) sides.delete(side.sessionId)
    if (side.child && side.child.state !== "ended" && side.child.state !== "idle") {
      side.entries.push({ kind: "note", text: "Stopped before the answer finished." })
    }
    stopWatching(side)
    side.child?.abort(reason)
    side.group?.end(reason)
    if (persist) saveDisplay(side)
    api.requestRender()
  }

  function close(side: Side) {
    side.control?.close()
    // Explicit user/session closes are not reload recovery candidates.
    closing.delete(side)
    finish(side)
    saveDisplay(side)
  }

  function fail(side: Side, error: unknown) {
    if (side.closed) return
    const message = error instanceof Error ? error.message : String(error)
    const fresh = side.failure !== message
    if (fresh) {
      side.entries.push({ kind: "error", text: `Could not answer: ${message}\n${RETRY}` })
      side.failure = message
    }
    side.status = "failed"
    if (!side.opened && fresh) {
      side.print(`btw: ${side.question}`, "error", { details: details(side), markdown: true, persist: true })
    }
    api.requestRender()
  }

  const view: ViewDefinition<Side> = {
    kind: viewKind,
    title: (side) => `btw: ${side.question}`,
    titleAside: (side) => side.status,
    follow: true,
    hostKeys: "minimal",
    onOpen(side, control) {
      side.control = control
      if (side.closed) control.close()
    },
    onClose(side) {
      if (side.closed) return
      closing.add(side)
      finish(side, false)
      queueMicrotask(() => {
        if (closing.delete(side) && !unloaded) saveDisplay(side)
      })
    },
    render: (side, opts) => {
      const lines = side.entries.flatMap((entry): ViewLine[] => {
        if (entry.kind === "question") return [{ kind: "user-message", text: entry.text }]
        if (entry.kind === "reply") {
          return opts.renderReply?.(entry.text) ?? [{ kind: "text", text: entry.text }]
        }
        return [{ kind: entry.kind === "error" ? "error" : "muted", text: entry.text }]
      })
      if (side.status === "waiting" || side.status === "working") {
        lines.push({
          kind: "muted",
          text: side.status === "waiting" ? "Waiting for an agent slot…" : "Thinking…",
        })
      }
      return lines
    },
  }
  api.registerView(view)

  function activate(side: Side, message: UserMessage, queuedOnly = false) {
    // Promoted prompts contain one text block per delivered question. Match exact blocks
    // once each: substrings and repeated question text must not consume undelivered input.
    const matched = new Set<Pending>()
    for (const part of message.content) {
      if (part.type !== "text") continue
      const pending = side.pending.find(
        (item) =>
          !matched.has(item) &&
          item.question === part.text &&
          (queuedOnly ? item.state === "queued" : item.state !== "interrupted"),
      )
      if (pending) {
        matched.add(pending)
        pending.state = "in-flight"
      }
    }
  }

  function settle(side: Side) {
    const answered = side.pending.filter((item) => item.state === "in-flight")
    for (const item of answered) side.completed.add(item)
    side.pending = side.pending.filter((item) => item.state !== "in-flight")
    // There is no extension-level openView API. Automatically restarted work reports its
    // answers as display-only blocks until a command context can mount the dock again.
    if (!side.opened && answered.length) {
      side.print(`btw: ${answered[0]!.question}`, "info", {
        details: details({
          entries: answered.flatMap((item): Entry[] => [
            { kind: "question", text: item.question },
            { kind: "reply", text: item.answer },
          ]),
        }),
        markdown: true,
        persist: true,
      })
    }
  }

  async function watch(side: Side, child: ChildSession) {
    let reply: Entry | undefined
    const group = side.group
    const events = child.events[Symbol.asyncIterator]()
    side.events = events
    try {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (side.closed || side.child !== child) return
        if (event.type === "subagent.state" && event.data.childSessionId === child.id) {
          if (child.state !== "ended" && !side.failure) {
            side.status = { queued: "waiting", working: "working", idle: "ready", paused: "paused" }[
              event.data.state
            ]
          }
        } else if (event.sessionId === child.id) {
          if (event.type === "turn.start") activate(side, event.data.prompt)
          if (event.type === "turn.steer" && event.data.state === "injected") {
            activate(side, event.data.message, true)
          }
          if (event.type === "message.start") reply = undefined
          if (
            (event.type === "message.delta" && event.data.kind === "text") ||
            event.type === "message.end"
          ) {
            if (!reply) {
              // A spawn can enter the working state before turn.start reaches this stream.
              if (!side.pending.some((item) => item.state === "in-flight")) {
                const next = side.pending.find((item) => item.state === "queued")
                if (next) next.state = "in-flight"
              }
              reply = {
                kind: "reply",
                text: "",
                pending: side.pending.filter((item) => item.state === "in-flight"),
              }
              side.entries.push(reply)
            }
            if (event.type === "message.delta" && event.data.kind === "text") reply.text += event.data.text
            else if (event.type === "message.end") {
              reply.text = event.data.message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")
            }
            for (const pending of reply.pending ?? []) {
              pending.answer = side.entries
                .filter((entry) => entry.kind === "reply" && entry.pending?.includes(pending))
                .map((entry) => entry.text)
                .filter(Boolean)
                .join("\n\n")
            }
            if (event.type === "message.end") reply = undefined
          }
          if (event.type === "turn.end") {
            if (event.data.reason === "error") {
              fail(side, event.data.error ?? "The side agent's turn failed.")
            } else if (event.data.reason === "done") settle(side)
          }
          if (event.type === "events.lost") throw new Error("The side answer stream lost events.")
        }
        api.requestRender()
      }
    } catch (error) {
      if (side.closed || side.child !== child) return
      fail(side, error)
      child.abort("btw stream failed")
      group?.end("btw stream failed")
    } finally {
      if (side.events === events) stopWatching(side)
    }
  }

  async function ended(side: Side, child: ChildSession) {
    const group = side.group
    try {
      const result = await child.result()
      if (side.closed || side.child !== child) return
      if (result.status === "error") fail(side, result.error ?? "The side agent failed.")
      else if (!side.failure) {
        side.status = "ended"
        side.entries.push({ kind: "note", text: `Side agent ended. ${RETRY}` })
      }
      if (result.undelivered?.length) {
        side.entries.push({
          kind: "error",
          text: `${result.undelivered.length} follow-up message(s) did not reach the side agent.`,
        })
      }
      group?.end("btw agent ended")
      api.requestRender()
    } catch (error) {
      if (side.closed || side.child !== child) return
      fail(side, error)
      child.abort("btw result failed")
      group?.end("btw result failed")
    }
  }

  function start(side: Side, session: SessionControl, pending: Pending) {
    try {
      const setting = api.settings.extensions?.btw?.model
      const model = typeof setting === "string" ? setting.trim() : ""
      side.group = session.createGroup!({ name: "btw" })
      side.child = side.group.spawn({
        title: "btw",
        prompt: pending.question,
        context: "fork",
        ephemeral: true,
        callableTools: ["read", "grep", "glob"],
        ...(model ? { model } : {}),
        systemPrompt: SYSTEM,
      })
      pending.state = side.child.state === "queued" ? "queued" : "in-flight"
      side.status = side.child.state === "queued" ? "waiting" : "working"
      void watch(side, side.child)
      void ended(side, side.child)
    } catch (error) {
      side.group?.end("btw spawn failed")
      fail(side, error)
    }
    api.requestRender()
  }

  function send(side: Side, pending: Pending) {
    try {
      if (!side.child?.send(pending.question)) {
        fail(side, "The side agent is no longer accepting follow-ups.")
      } else {
        // Acceptance is not delivery, even from idle: admission may still be queued.
        pending.state = "queued"
        side.status = side.child.state === "queued" ? "waiting" : "working"
      }
    } catch (error) {
      fail(side, error)
    }
    api.requestRender()
  }

  function requeue(side: Side, session: SessionControl) {
    const queued = side.pending.filter((item) => item.state === "queued")
    if (!queued.length) return
    if (!session.createGroup) {
      side.status = "waiting"
      return
    }
    start(side, session, queued[0]!)
    if (side.child) for (const item of queued.slice(1)) send(side, item)
  }

  function open(side: Side, ctx: CommandContext) {
    if (side.opened) return
    if (!ctx.openView || !ctx.session.createGroup) {
      throw new Error("Side questions need a TUI dock and an agent tree.")
    }
    if (!ctx.openView({ kind: viewKind, data: side, placement: "dock" })) {
      throw new Error("The btw dock cannot open now. Close the active form or view and try again.")
    }
    side.opened = true
    side.print = ctx.print
  }

  function interrupt(side: Side, item: Pending, reloaded = true) {
    item.state = "interrupted"
    // Reserve the ID durably before publishing its notice. Consuming, clearing, or
    // dropping a recovery snapshot must never reset this session's high-water mark.
    const existing = retryNumber(item.retryId)
    let counter = Math.max(counters.get(side.sessionId) ?? 0, recoveryCounter(side.data), existing ?? 0)
    if (existing === undefined) {
      if (counter === Number.MAX_SAFE_INTEGER) throw new Error("The btw retry counter is exhausted.")
      counter++
      side.data?.append(COUNTER_KEY, counter)
    }
    counters.set(side.sessionId, counter)
    item.retryId = `r${existing ?? counter}`
    const retry = item.retryId
    side.retries.set(retry, item)
    const status = reloaded ? "Interrupted by reload." : "Side agent ended before the answer finished."
    const note = `${status} Ask again with /btw retry ${retry}.`
    side.entries.push({ kind: "note", text: note, pending: [item] })
    return note
  }

  api.registerCommand({
    name: "btw",
    description: "Ask a side question without interrupting the main agent",
    args: { hint: "<question> | clear | retry <id>" },
    echo: false,
    run(args, ctx) {
      ctx.signal.throwIfAborted()
      let question = args.trim()
      const id = ctx.session.info().id
      let side = sides.get(id)
      if (question === "clear") {
        if (side) close(side)
        sides.delete(id)
        return
      }
      const retry = /^retry (r\d+|[0-9a-f-]+)$/i.exec(question)
      const retryId = retry?.[1]?.toLowerCase()
      // Bare numbers are ambiguous with old numbered actions; recognize them only
      // to report unavailable. UUID actions are also retired, never reassigned.
      const isRetry =
        retryId !== undefined &&
        (/^r\d+$/.test(retryId) || /^\d+$/.test(retryId) || LEGACY_RETRY_ID.test(retryId))
      const retryItem = isRetry && retryId.startsWith("r") ? side?.retries.get(retryId) : undefined
      if (isRetry) {
        if (!retryItem) {
          ctx.print("That interrupted question is no longer available. Use /btw <question> to ask again.")
          return
        }
        question = retryItem.question
      }
      if (!question) {
        if (side && !side.opened) {
          open(side, ctx)
          if (!side.child && !side.failure) requeue(side, ctx.session)
        } else ctx.print("Use /btw <question> to ask or follow up; Esc or /btw clear closes the dock.")
        return
      }
      if (side && (side.closed || side.child?.state === "ended" || (!side.child && side.failure))) {
        if (!side.closed && side.pending.length) {
          // Preserve pending work even when a failed restart produced no retry actions.
          // A new child must not inherit the old child's active questions or callbacks.
          stopWatching(side)
          side.group?.end("btw agent replaced")
          for (const item of side.pending) {
            if (item.state === "in-flight") interrupt(side, item, false)
          }
          side.child = undefined
          side.group = undefined
          side.failure = undefined
        } else {
          close(side)
          sides.delete(id)
          side = undefined
        }
      }
      const pending: Pending = { question, answer: "", timestamp: Date.now(), state: "queued" }
      if (side) {
        open(side, ctx)
        // Consume only after opening succeeds. IDs stay stable for other displayed actions.
        if (isRetry && retryItem) {
          side.retries.delete(retryId)
          side.pending = side.pending.filter((item) => item !== retryItem)
        }
        side.entries.push({ kind: "question", text: question, pending: [pending] })
        side.pending.push(pending)
        if (side.child) send(side, pending)
        else requeue(side, ctx.session)
        return
      }
      if (!ctx.openView || !ctx.session.createGroup) {
        throw new Error("Side questions need a TUI dock and an agent tree.")
      }
      const next: Side = {
        sessionId: id,
        question,
        entries: [{ kind: "question", text: question, pending: [pending] }],
        pending: [pending],
        retries: new Map(),
        completed: new Set(),
        data: ctx.session.data,
        print: ctx.print,
        status: "working",
        closed: false,
        opened: false,
        saved: false,
      }
      sides.set(id, next)
      try {
        open(next, ctx)
      } catch (error) {
        finish(next, false)
        throw error
      }
      if (!next.closed) start(next, ctx.session, pending)
    },
  })

  function restore() {
    const session = api.session()
    if (!session) return
    const id = session.info().id
    if (sides.has(id)) return
    const data = session.data
    const raw = data?.read(DATA_KEY).at(-1)
    const pending = recover(raw)
    if (!pending.length) {
      if (raw !== undefined && (!Array.isArray(raw) || raw.length)) data?.append(DATA_KEY, [])
      return
    }
    const side: Side = {
      sessionId: id,
      question: pending[0]!.question,
      entries: [],
      pending,
      retries: new Map(),
      completed: new Set(),
      data,
      print: (...args) => api.notify(...args),
      status: "interrupted",
      closed: false,
      opened: false,
      saved: false,
    }
    sides.set(id, side)
    for (const item of pending) {
      side.entries.push({ kind: "question", text: item.question, pending: [item] })
      if (item.state === "queued") continue
      if (item.answer) side.entries.push({ kind: "reply", text: item.answer, pending: [item] })
      const note = interrupt(side, item)
      side.print(`btw: ${item.question}`, "info", {
        details: details({
          entries: [
            { kind: "question", text: item.question },
            { kind: "reply", text: item.answer },
            { kind: "note", text: note },
          ],
        }),
        markdown: true,
        persist: true,
      })
    }
    requeue(side, session)
    // SessionData is append-only: an empty latest record consumes the recovery snapshot.
    data?.append(DATA_KEY, [])
    api.requestRender()
  }

  api.onUnload(() => {
    unloaded = true
    for (const side of new Set([...sides.values(), ...closing])) {
      if (side.pending.length) {
        side.data?.append(
          DATA_KEY,
          side.pending.map(({ question, answer, timestamp, state, retryId }) => ({
            question,
            answer,
            timestamp,
            state,
            ...(retryId ? { retryId } : {}),
          })),
        )
        if (side.opened) {
          const completed = side.entries.filter((entry) =>
            entry.pending?.some((item) => side.completed.has(item)),
          )
          if (completed.length) saveDisplay(side, completed)
        }
      } else if (side.opened) saveDisplay(side)
      finish(side, false, "btw unloaded")
    }
    closing.clear()
  })
  api.on("session.end", (event) => {
    const side = sides.get(event.sessionId)
    if (side) close(side)
  })
  api.on("session.start", restore)
  restore()
}

export default extension
