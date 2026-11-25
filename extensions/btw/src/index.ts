import type {
  AnyEvent,
  ChildSession,
  CommandContext,
  Extension,
  SessionControl,
  SessionData,
  SpawnGroup,
  UiControl,
  UiNode,
  UserMessage,
  ViewDefinition,
  ViewLine,
  ViewRenderOptions,
  ViewSegment,
} from "@amira/api"

const SYSTEM =
  "Answer this side question briefly using the forked conversation. You may read files, but must not change files or the main conversation."
const RETRY = "Close the dock with Esc or /btw clear, then ask again."
const DATA_KEY = "btw.pending"
const MAX_AGE = 24 * 60 * 60 * 1000
const COUNTER_KEY = "btw.retry.counter"
const LEGACY_RETRY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const WORKING_SYMBOL = "●"
const PRIMARY_TOOL_ARGS = ["path", "file_path", "filePath", "pattern", "query", "command", "name"]

type Pending = {
  question: string
  answer: string
  timestamp: number
  state: "queued" | "in-flight" | "interrupted"
  retryId?: string
}

type ToolEntry = {
  kind: "tool"
  id: string
  name: string
  args: Record<string, unknown>
  startedAt: number
  finished?: boolean
  isError?: boolean
  durationMs?: number
}

type TextEntry = { kind: "question" | "reply" | "error" | "note"; text: string; pending?: Pending[] }

type Entry = TextEntry | ToolEntry

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
  startedAt?: number
  placement: "dock" | "fullscreen"
  hidden: boolean
  hiding: boolean
  repositioning: boolean
  closed: boolean
  opened: boolean
  saved: boolean
  failure?: string
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  for (const key of PRIMARY_TOOL_ARGS) {
    const val = args[key]
    if (typeof val === "string" && val.trim()) {
      const flat = val.replace(/\s+/g, " ").trim()
      return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
    }
  }
  return ""
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ""
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function details(side: Pick<Side, "entries">): string {
  return side.entries
    .filter((entry): entry is TextEntry => entry.kind !== "tool" && !!entry.text)
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

function turnCount(side: Side): number {
  return side.entries.filter((entry) => entry.kind === "question").length
}

function latestQuestion(side: Side): string {
  for (let i = side.entries.length - 1; i >= 0; i--) {
    const entry = side.entries[i]!
    if (entry.kind === "question") return entry.text
  }
  return side.question
}

function renderEntryLines(entry: Entry, opts: ViewRenderOptions): ViewLine[] {
  if (entry.kind === "question") return [{ kind: "user-message", text: entry.text }]
  if (entry.kind === "reply") {
    return opts.renderReply?.(entry.text) ?? [{ kind: "text", text: entry.text }]
  }
  if (entry.kind === "tool") {
    const summary = summarizeToolArgs(entry.args)
    if (!entry.finished) {
      if (opts.renderRunningTool) {
        return opts.renderRunningTool(entry.name, { args: entry.args, startedAt: entry.startedAt })
      }
      const parts: ViewSegment[] = [
        { kind: "spinner" },
        { kind: "text", text: " " },
        { kind: "accent", text: entry.name },
        ...(summary ? [{ kind: "muted" as const, text: ` ${summary}` }] : []),
      ]
      return [{ kind: "segments", parts }]
    }
    const sep = opts.glyphs?.separator ?? "·"
    const elapsed = formatMs(entry.durationMs)
    const parts: ViewSegment[] = [
      entry.isError ? { kind: "error", text: opts.glyphs?.error ?? "✗" } : { kind: "success", text: "✓" },
      { kind: "muted", text: ` ${entry.name}${summary ? ` ${summary}` : ""}` },
      ...(elapsed ? [{ kind: "dim" as const, text: ` ${sep} ${elapsed}` }] : []),
    ]
    return [{ kind: "segments", parts }]
  }
  return [{ kind: entry.kind === "error" ? "error" : "muted", text: entry.text }]
}

const extension: Extension = (api) => {
  const viewKind = `btw:${crypto.randomUUID()}`
  const sides = new Map<string, Side>()
  const counters = new Map<string, number>()
  // The host closes views BEFORE onUnload, without a close reason. Keep their recovery
  // candidates until the synchronous unload hook has had a chance to claim them.
  const closing = new Set<Side>()
  let unloaded = false

  api.registerStatusItem({
    id: "btw",
    align: "left",
    priority: 25,
    tone() {
      const id = api.session()?.info().id
      const side = id ? sides.get(id) : undefined
      if (!side || side.closed) return undefined
      if (side.status === "failed" || side.retries.size > 0) return "warning"
      if (side.status === "working" || side.status === "waiting") return "accent"
      return "muted"
    },
    text() {
      const id = api.session()?.info().id
      const side = id ? sides.get(id) : undefined
      if (!side || side.closed) return undefined
      const turns = turnCount(side)
      const count = turns > 1 ? ` (${turns})` : ""
      if (side.status === "working") {
        return `${WORKING_SYMBOL} btw${side.hidden ? " hidden" : ""}${count}`
      }
      if (side.status === "waiting") {
        return `btw · waiting${count}`
      }
      if (side.retries.size > 0) {
        const first = side.retries.keys().next().value as string
        return `btw · retry ${first}`
      }
      if (side.hidden) {
        return `btw · hidden${count}`
      }
      return undefined
    },
  })

  function saveDisplay(side: Side, entries = side.entries) {
    if (side.saved) return
    side.saved = true
    const firstQuestion = entries.find((entry): entry is TextEntry => entry.kind === "question")
    const question = firstQuestion?.text ?? side.question
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
    side.hidden = false
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
    side.hiding = false
    side.repositioning = false
    side.control?.close()
    // Explicit user/session closes are not reload recovery candidates.
    closing.delete(side)
    finish(side)
    saveDisplay(side)
  }

  function hide(side: Side) {
    if (side.closed || side.hidden) return
    side.hiding = true
    side.hidden = true
    side.control?.close()
    side.control = undefined
    side.hiding = false
    api.requestRender()
  }

  function setStatus(side: Side, status: string) {
    if (status === "working") {
      if (side.status !== "working" || side.startedAt === undefined) side.startedAt = Date.now()
    } else {
      side.startedAt = undefined
    }
    side.status = status
  }

  function fail(side: Side, error: unknown) {
    if (side.closed) return
    const message = error instanceof Error ? error.message : String(error)
    const fresh = side.failure !== message
    if (fresh) {
      side.entries.push({ kind: "error", text: `Could not answer: ${message}\n${RETRY}` })
      side.failure = message
    }
    setStatus(side, "failed")
    if (!side.opened && fresh) {
      side.print(`btw: ${side.question}`, "error", { details: details(side), markdown: true, persist: true })
    }
    api.requestRender()
  }

  function buildUiLines(side: Side, opts: ViewRenderOptions): ViewLine[] {
    const lines = side.entries.flatMap((entry) => renderEntryLines(entry, opts))
    if (side.status === "waiting") {
      lines.push({
        kind: "segments",
        parts: [{ kind: "badge", state: "queued", label: "Waiting for an agent slot…" }],
      })
    } else if (side.status === "working") {
      const sep = opts.glyphs?.separator ?? "·"
      lines.push({
        kind: "segments",
        parts: [
          { kind: "spinner" },
          { kind: "text", text: " " },
          {
            kind: "shimmer",
            text: "Thinking…",
            ...(side.startedAt !== undefined ? { startedAt: side.startedAt } : {}),
          },
          ...(side.startedAt !== undefined
            ? [
                { kind: "dim" as const, text: ` ${sep} ` },
                { kind: "elapsed" as const, since: side.startedAt, tone: "dim" as const },
              ]
            : []),
        ],
      })
    }
    return lines
  }

  function sendFollowUpInView(side: Side, raw: string, retryKey?: string) {
    const session = api.session()
    let question = raw.trim()
    let retryItem: Pending | undefined
    if (retryKey) {
      retryItem = side.retries.get(retryKey)
      if (!retryItem) return
      question = retryItem.question
    }
    if (!question) return
    if (side.closed || side.child?.state === "ended" || (!side.child && side.failure)) {
      if (!side.closed && side.pending.length) {
        stopWatching(side)
        side.group?.end("btw agent replaced")
        for (const item of side.pending) {
          if (item.state === "in-flight") interrupt(side, item, false)
        }
        side.child = undefined
        side.group = undefined
        side.failure = undefined
      } else if (side.child?.state === "ended" || (!side.child && side.failure)) {
        stopWatching(side)
        side.group?.end("btw agent replaced")
        side.child = undefined
        side.group = undefined
        side.failure = undefined
      }
    }
    if (retryKey && retryItem) {
      side.retries.delete(retryKey)
      side.pending = side.pending.filter((item) => item !== retryItem)
    }
    const pending: Pending = { question, answer: "", timestamp: Date.now(), state: "queued" }
    side.entries.push({ kind: "question", text: question, pending: [pending] })
    side.pending.push(pending)
    if (side.child) send(side, pending)
    else if (session) requeue(side, session)
    else setStatus(side, "waiting")
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
      side.hidden = false
      side.hiding = false
      side.repositioning = false
      if (side.closed) control.close()
    },
    onClose(side) {
      if (side.closed) return
      if (side.hiding || side.repositioning) {
        side.control = undefined
        side.hiding = false
        side.repositioning = false
        api.requestRender()
        return
      }
      closing.add(side)
      finish(side, false)
      queueMicrotask(() => {
        if (closing.delete(side) && !unloaded) saveDisplay(side)
      })
    },
    render: (side, opts) => {
      const lines = side.entries.flatMap((entry) => renderEntryLines(entry, opts))
      if (side.status === "waiting" || side.status === "working") {
        lines.push({
          kind: "muted",
          text: side.status === "waiting" ? "Waiting for an agent slot…" : "Thinking…",
        })
      }
      return lines
    },
    ui: (side, ctx): UiNode => {
      const sep = ctx.glyphs?.separator ?? "·"
      const turns = turnCount(side)
      const queuedCount = side.pending.filter((item) => item.state === "queued").length
      const topic = latestQuestion(side).replace(/\s+/g, " ").trim()
      const shortTopic = topic.length > 42 ? `${topic.slice(0, 41)}…` : topic
      const titleParts: ViewSegment[] = [
        { kind: "chip", text: "btw", tone: "accent" },
        { kind: "text", text: ` ${shortTopic}` },
        ...(turns > 1 ? [{ kind: "dim" as const, text: ` ${sep} ${turns} turns` }] : []),
        ...(queuedCount > 0
          ? [
              { kind: "text" as const, text: " " },
              { kind: "chip" as const, text: `${queuedCount} queued`, tone: "info" as const },
            ]
          : []),
      ]
      const firstRetry = side.retries.keys().next().value as string | undefined
      const actionChildren: { node: UiNode; size?: number | "fill"; min?: number }[] = [
        {
          size: 11,
          node: { type: "bar", left: [{ kind: "chip", text: "btw reply", tone: "accent" }] },
        },
        {
          size: "fill",
          min: 14,
          node: {
            type: "input",
            id: "followup",
            placeholder:
              side.status === "working" || side.status === "waiting"
                ? "Queue a btw follow-up… (Tab / click)"
                : "Ask btw a follow-up… (Tab / click)",
            hint: "Enter",
          },
        },
        ...(firstRetry
          ? [
              {
                size: firstRetry.length + 10,
                node: {
                  type: "button" as const,
                  id: "retry",
                  key: firstRetry,
                  label: `Retry ${firstRetry}`,
                  tone: "accent" as const,
                },
              },
            ]
          : []),
        {
          size: 8,
          node: { type: "button", id: "hide", label: "Hide", tone: "normal" },
        },
        {
          size: 9,
          node: { type: "button", id: "clear", label: "Clear", tone: "normal" },
        },
      ]
      const showRule = ctx.height >= 7
      const children: { node: UiNode; size?: number | "fill" }[] = [
        {
          size: "fill",
          node: {
            type: "text",
            follow: true,
            lines: buildUiLines(side, ctx),
          },
        },
        ...(showRule ? [{ size: 1, node: { type: "rule" as const } }] : []),
        { size: 1, node: { type: "row", gap: 1, children: actionChildren } },
      ]
      return {
        type: "box",
        tone: "focus",
        title: { kind: "segments", parts: titleParts },
        aside: side.status,
        child: { type: "column", children },
      }
    },
    onEvent(event, side, control) {
      if (event.type === "submit" && event.id === "followup") {
        const value = event.value.trim()
        if (!value) return
        control.setState({ inputValues: { followup: "" } })
        sendFollowUpInView(side, value)
        return
      }
      if (event.type === "activate") {
        if (event.id === "hide") hide(side)
        else if (event.id === "clear") close(side)
        else if (event.id === "retry") sendFollowUpInView(side, "", event.key)
      }
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
    let reply: TextEntry | undefined
    const group = side.group
    const events = child.events[Symbol.asyncIterator]()
    side.events = events
    try {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (side.closed || side.child !== child) return
        if (event.type === "subagent.state" && event.data.childSessionId === child.id) {
          if (child.state !== "ended" && !side.failure) {
            setStatus(
              side,
              { queued: "waiting", working: "working", idle: "ready", paused: "paused" }[event.data.state],
            )
          }
        } else if (event.sessionId === child.id) {
          if (event.type === "turn.start") activate(side, event.data.prompt)
          if (event.type === "turn.steer" && event.data.state === "injected") {
            activate(side, event.data.message, true)
          }
          if (event.type === "tool.execute.start") {
            reply = undefined
            side.entries.push({
              kind: "tool",
              id: event.data.toolCallId,
              name: event.data.name,
              args: event.data.args,
              startedAt: event.ts || Date.now(),
            })
          }
          if (event.type === "tool.execute.end") {
            const tool = side.entries.find(
              (entry): entry is ToolEntry => entry.kind === "tool" && entry.id === event.data.toolCallId,
            )
            if (tool) {
              tool.finished = true
              tool.isError = event.data.result.isError
              tool.durationMs = event.data.durationMs
            }
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
                .filter(
                  (entry): entry is TextEntry => entry.kind === "reply" && !!entry.pending?.includes(pending),
                )
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
        setStatus(side, "ended")
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
      setStatus(side, side.child.state === "queued" ? "waiting" : "working")
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
        setStatus(side, side.child.state === "queued" ? "waiting" : "working")
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
      setStatus(side, "waiting")
      return
    }
    start(side, session, queued[0]!)
    if (side.child) for (const item of queued.slice(1)) send(side, item)
  }

  function open(side: Side, ctx: CommandContext, placement = side.placement) {
    const changingPlacement = side.opened && !side.hidden && side.placement !== placement
    if (side.opened && !side.hidden && !changingPlacement) return
    if (!ctx.openView || !ctx.session.createGroup) {
      throw new Error("Side questions need a TUI dock and an agent tree.")
    }
    if (changingPlacement) side.repositioning = true
    const opened = ctx.openView({ kind: viewKind, data: side, placement })
    if (!opened) {
      side.repositioning = false
      throw new Error("The btw dock cannot open now. Close the active form or view and try again.")
    }
    const wasOpened = side.opened
    side.placement = placement
    side.opened = true
    side.hidden = false
    if (!wasOpened) side.print = ctx.print
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
    args: { hint: "<question> | hide | full | dock | clear | retry <id>" },
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
      if (question === "hide") {
        if (side && !side.closed) hide(side)
        else ctx.print("No open btw conversation to hide.")
        return
      }
      if (question === "full" || question === "dock") {
        if (!side || side.closed) {
          ctx.print("No active btw conversation. Ask a question with /btw <question> first.")
          return
        }
        open(side, ctx, question === "full" ? "fullscreen" : "dock")
        api.requestRender()
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
        if (side && (!side.opened || side.hidden)) {
          open(side, ctx)
          if (!side.child && !side.failure) requeue(side, ctx.session)
          api.requestRender()
        } else {
          ctx.print(
            "Use /btw <question> to ask or follow up (or Tab into the dock); /btw hide minimizes, Esc or /btw clear closes.",
          )
        }
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
        startedAt: Date.now(),
        placement: "dock",
        hidden: false,
        hiding: false,
        repositioning: false,
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
      placement: "dock",
      hidden: false,
      hiding: false,
      repositioning: false,
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
          const completed = side.entries.filter(
            (entry) => entry.kind !== "tool" && entry.pending?.some((item) => side.completed.has(item)),
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
