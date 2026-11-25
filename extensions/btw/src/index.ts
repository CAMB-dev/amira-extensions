import type {
  AnyEvent,
  ChildSession,
  CommandCandidate,
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
const HISTORY_KEY = "btw.history"
const MAX_AGE = 24 * 60 * 60 * 1000
const MAX_HISTORY_THREADS = 20
const MAX_HISTORY_TURNS = 30
const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_CONTEXT_CHARS = 24_000
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
  deliveredPrompt?: string
}

type HistoryTurn = {
  question: string
  answer: string
}

type HistoryThread = {
  id: string
  title: string
  turns: HistoryTurn[]
  createdAt: number
  updatedAt: number
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
  localId: string
  threadId?: string
  question: string
  entries: Entry[]
  pending: Pending[]
  retries: Map<string, Pending>
  completed: Set<Pending>
  historyContext?: HistoryTurn[]
  lastSavedHistorySig?: string
  selectedHistoryId?: string
  mode: "chat" | "history"
  events?: AsyncIterator<AnyEvent>
  data?: SessionData
  child?: ChildSession
  group?: SpawnGroup
  control?: UiControl
  openView?: CommandContext["openView"]
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

function trimHistoryText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_HISTORY_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_HISTORY_CHARS - 1)}…`
}

function historyNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^h[1-9]\d*$/i.test(value)) return
  const num = Number(value.slice(1))
  return Number.isSafeInteger(num) ? num : undefined
}

function parseHistory(value: unknown): HistoryThread[] {
  if (!Array.isArray(value)) return []
  const out: HistoryThread[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== "string" || !raw.id.trim() || seen.has(raw.id)) continue
    if (!Array.isArray(raw.turns)) continue
    const turns: HistoryTurn[] = []
    for (const turn of raw.turns) {
      if (!turn || typeof turn !== "object") continue
      const t = turn as Record<string, unknown>
      if (
        typeof t.question === "string" &&
        t.question.trim() &&
        typeof t.answer === "string" &&
        t.answer.trim()
      ) {
        turns.push({ question: trimHistoryText(t.question), answer: trimHistoryText(t.answer) })
      }
    }
    if (!turns.length) continue
    const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
    const updatedAt =
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : turns[0]!.question
    seen.add(raw.id)
    out.push({ id: raw.id, title, turns: turns.slice(-MAX_HISTORY_TURNS), createdAt, updatedAt })
  }
  return out.slice(0, MAX_HISTORY_THREADS)
}

function extractCompletedTurns(side: Pick<Side, "entries" | "completed">): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let currentQuestion: string | undefined
  let replies: string[] = []
  const isCompleted = (entry: TextEntry) =>
    !entry.pending?.length || entry.pending.every((item) => side.completed.has(item))
  const flush = () => {
    const answer = replies.join("\n\n").trim()
    if (currentQuestion && answer) {
      turns.push({ question: trimHistoryText(currentQuestion), answer: trimHistoryText(answer) })
    }
    currentQuestion = undefined
    replies = []
  }
  for (const entry of side.entries) {
    if (entry.kind === "question") {
      flush()
      if (!isCompleted(entry)) continue
      const q = entry.text.trim()
      if (q) currentQuestion = q
    } else if (entry.kind === "reply" && currentQuestion && isCompleted(entry)) {
      const a = entry.text.trim()
      if (a) replies.push(a)
    }
  }
  flush()
  return turns.slice(-MAX_HISTORY_TURNS)
}

function historySignature(turns: HistoryTurn[]): string {
  return turns
    .map((turn) => `${turn.question.length}:${turn.question}\0${turn.answer.length}:${turn.answer}`)
    .join("\x1e")
}

function buildPromptWithHistory(question: string, history?: HistoryTurn[]): string {
  if (!history?.length) return question
  const selected: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]!
    const block = `User: ${turn.question}\nAssistant: ${turn.answer}`
    if (selected.length > 0 && used + block.length > MAX_HISTORY_CONTEXT_CHARS) break
    selected.unshift(block)
    used += block.length + 2
  }
  if (!selected.length) return question
  return `Continuing a previous side (btw) conversation from this session. Prior btw turns:\n\n${selected.join("\n\n")}\n\nNew follow-up question:\n${question}`
}

function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ""
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
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
  const stashed = new Map<string, Map<string, Side>>()
  const tabOrder = new Map<string, string[]>()
  const counters = new Map<string, number>()
  const memoryHistory = new Map<string, HistoryThread[]>()
  // The host closes views BEFORE onUnload, without a close reason. Keep their recovery
  // candidates until the synchronous unload hook has had a chance to claim them.
  const closing = new Set<Side>()
  let localSeq = 0
  let unloaded = false

  const nextLocalId = () => `t${++localSeq}`
  const tabKeyOf = (side: Pick<Side, "threadId" | "localId">) => side.threadId ?? side.localId
  const ensureTabOrder = (sessionId: string, keys: string[]) => {
    let order = tabOrder.get(sessionId)
    if (!order) {
      order = []
      tabOrder.set(sessionId, order)
    }
    for (const key of keys) {
      if (!order.includes(key)) order.push(key)
    }
    return order
  }
  const renameTabOrder = (sessionId: string, oldKey: string, newKey: string) => {
    if (oldKey === newKey) return
    const order = tabOrder.get(sessionId)
    if (!order) return
    const at = order.indexOf(oldKey)
    if (at === -1) return
    if (order.includes(newKey)) order.splice(at, 1)
    else order[at] = newKey
  }
  const dropTabOrder = (sessionId: string, key: string) => {
    const order = tabOrder.get(sessionId)
    if (!order) return
    const at = order.indexOf(key)
    if (at !== -1) order.splice(at, 1)
  }
  const sessionStash = (sessionId: string) => {
    let bucket = stashed.get(sessionId)
    if (!bucket) {
      bucket = new Map()
      stashed.set(sessionId, bucket)
    }
    return bucket
  }
  const removeFromStash = (side: Side) => {
    const bucket = stashed.get(side.sessionId)
    if (!bucket) return
    for (const [key, value] of bucket) {
      if (value === side || key === side.localId || (side.threadId && key === side.threadId)) {
        bucket.delete(key)
      }
    }
    if (!bucket.size) stashed.delete(side.sessionId)
  }
  const stashSide = (side: Side) => {
    if (side.closed) return
    if (side.entries.length) saveHistory(side)
    side.control = undefined
    if (!side.entries.length && !side.child) return
    removeFromStash(side)
    sessionStash(side.sessionId).set(tabKeyOf(side), side)
  }
  const createBlankSide = (
    sessionId: string,
    opts: {
      data?: SessionData
      print: CommandContext["print"]
      openView?: CommandContext["openView"]
      placement?: "dock" | "fullscreen"
      question?: string
      status?: string
      mode?: "chat" | "history"
      saved?: boolean
    },
  ): Side => ({
    sessionId,
    localId: nextLocalId(),
    question: opts.question ?? "New btw",
    entries: [],
    pending: [],
    retries: new Map(),
    completed: new Set(),
    mode: opts.mode ?? "chat",
    data: opts.data,
    openView: opts.openView,
    print: opts.print,
    status: opts.status ?? "ready",
    placement: opts.placement ?? "dock",
    hidden: false,
    hiding: false,
    repositioning: false,
    closed: false,
    opened: false,
    saved: opts.saved ?? true,
  })

  function readHistory(sessionId: string, data?: SessionData): HistoryThread[] {
    if (data) return parseHistory(data.read(HISTORY_KEY).at(-1))
    return (memoryHistory.get(sessionId) ?? []).map((thread) => ({
      ...thread,
      turns: thread.turns.map((turn) => ({ ...turn })),
    }))
  }

  function writeHistory(sessionId: string, data: SessionData | undefined, threads: HistoryThread[]) {
    const capped = threads.slice(0, MAX_HISTORY_THREADS).map((thread) => ({
      ...thread,
      turns: thread.turns.slice(-MAX_HISTORY_TURNS).map((turn) => ({
        question: trimHistoryText(turn.question),
        answer: trimHistoryText(turn.answer),
      })),
    }))
    if (data) data.append(HISTORY_KEY, capped)
    else memoryHistory.set(sessionId, capped)
  }

  function nextHistoryId(sessionId: string, data?: SessionData, current?: HistoryThread[]): string {
    let max = 0
    for (const thread of current ?? readHistory(sessionId, data)) {
      max = Math.max(max, historyNumber(thread.id) ?? 0)
    }
    for (const snapshot of data?.read(HISTORY_KEY) ?? []) {
      if (!Array.isArray(snapshot)) continue
      for (const item of snapshot) {
        if (item && typeof item === "object") {
          max = Math.max(max, historyNumber((item as Record<string, unknown>).id) ?? 0)
        }
      }
    }
    return `h${max + 1}`
  }

  function saveHistory(side: Side) {
    const turns = extractCompletedTurns(side)
    if (!turns.length) return
    const sig = historySignature(turns)
    if (side.lastSavedHistorySig === sig && side.threadId) return
    const existing = readHistory(side.sessionId, side.data)
    const now = Date.now()
    const match = side.threadId ? existing.find((thread) => thread.id === side.threadId) : undefined
    const id = match?.id ?? side.threadId ?? nextHistoryId(side.sessionId, side.data, existing)
    const prevKey = tabKeyOf(side)
    side.threadId = id
    side.lastSavedHistorySig = sig
    if (prevKey !== id) {
      renameTabOrder(side.sessionId, prevKey, id)
      if (sides.get(side.sessionId) === side) {
        side.control?.setState({ activeTabs: { threads: id } })
      }
    }
    const updated: HistoryThread = {
      id,
      title: match?.title ?? turns[0]!.question,
      turns,
      createdAt: match?.createdAt ?? now,
      updatedAt: now,
    }
    const next = [updated, ...existing.filter((thread) => thread.id !== id)]
    writeHistory(side.sessionId, side.data, next)
  }

  function applyHistoryThread(side: Side, thread: HistoryThread) {
    if (side.entries.length) saveHistory(side)
    stopWatching(side)
    side.child?.abort("btw switched thread")
    side.group?.end("btw switched thread")
    side.child = undefined
    side.group = undefined
    side.failure = undefined
    side.pending = []
    side.retries.clear()
    side.completed.clear()
    side.threadId = thread.id
    side.question = thread.title
    side.entries = [
      ...thread.turns.flatMap((turn): Entry[] => [
        { kind: "question", text: turn.question },
        { kind: "reply", text: turn.answer },
      ]),
      {
        kind: "note",
        text: `Restored ${thread.id} (${thread.turns.length} turn${thread.turns.length === 1 ? "" : "s"}). Ask a follow-up to continue.`,
      },
    ]
    side.historyContext = thread.turns.map((turn) => ({ ...turn }))
    side.lastSavedHistorySig = historySignature(thread.turns)
    side.selectedHistoryId = thread.id
    side.mode = "chat"
    side.saved = true
    setStatus(side, "history")
    api.requestRender()
  }

  function deleteHistoryThread(side: Side, threadId: string) {
    const existing = readHistory(side.sessionId, side.data)
    const next = existing.filter((thread) => thread.id !== threadId)
    if (next.length === existing.length) return
    writeHistory(side.sessionId, side.data, next)
    if (side.threadId === threadId) {
      side.threadId = undefined
      side.lastSavedHistorySig = undefined
    }
    dropTabOrder(side.sessionId, threadId)
    side.selectedHistoryId = next[0]?.id
    api.requestRender()
  }

  function clearAllHistory(side: Side) {
    const existing = readHistory(side.sessionId, side.data)
    if (!existing.length) return
    writeHistory(side.sessionId, side.data, [])
    for (const thread of existing) dropTabOrder(side.sessionId, thread.id)
    side.threadId = undefined
    side.lastSavedHistorySig = undefined
    side.selectedHistoryId = undefined
    api.requestRender()
  }

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
    if (side.saved || !entries.length) return
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
    saveHistory(side)
    side.closed = true
    side.hidden = false
    removeFromStash(side)
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

  function closeStashedForSession(sessionId: string, persist = true, reason = "btw dock closed") {
    const bucket = stashed.get(sessionId)
    if (!bucket) return
    stashed.delete(sessionId)
    for (const item of new Set(bucket.values())) {
      finish(item, persist, reason)
    }
  }

  function close(side: Side) {
    side.hiding = false
    side.repositioning = false
    side.control?.close()
    // Explicit user/session closes are not reload recovery candidates.
    closing.delete(side)
    closeStashedForSession(side.sessionId)
    finish(side)
    saveDisplay(side)
  }

  function clearSide(side: Side) {
    if (side.closed) return
    const oldKey = tabKeyOf(side)
    const hadThreadId = side.threadId
    stopWatching(side)
    side.child?.abort("btw cleared")
    side.group?.end("btw cleared")
    side.child = undefined
    side.group = undefined
    side.failure = undefined
    side.pending = []
    side.retries.clear()
    side.completed.clear()
    side.historyContext = undefined
    if (hadThreadId) deleteHistoryThread(side, hadThreadId)
    else dropTabOrder(side.sessionId, oldKey)
    side.threadId = undefined
    side.lastSavedHistorySig = undefined
    side.entries = []
    side.question = "New btw"
    side.mode = "chat"
    side.saved = true
    setStatus(side, "ready")
    // When not currently shown in a mounted panel, finish cleanup instead of leaving an empty hidden stub.
    if (!side.opened || side.hidden || !side.control) {
      side.closed = true
      if (sides.get(side.sessionId) === side) sides.delete(side.sessionId)
      closing.delete(side)
      api.requestRender()
      return
    }
    side.localId = nextLocalId()
    side.control.setState({ activeTabs: { threads: tabKeyOf(side) }, inputValues: { followup: "" } })
    side.control.focus("followup")
    api.requestRender()
  }

  function switchToSide(current: Side, target: Side) {
    if (current === target) return
    const placement = current.placement
    const openView = current.openView ?? target.openView
    const control = current.control
    stashSide(current)
    removeFromStash(target)
    target.placement = placement
    target.openView = openView
    target.opened = true
    target.hidden = false
    target.mode = "chat"
    sides.set(current.sessionId, target)
    const nextState = { activeTabs: { threads: tabKeyOf(target) }, focused: "followup" }
    if (openView) {
      target.control = control
      openView({ kind: viewKind, data: target, placement, state: nextState })
    } else {
      target.control = control
    }
    target.control?.setState({ activeTabs: { threads: tabKeyOf(target) } })
    target.control?.focus("followup")
    api.requestRender()
  }

  function togglePlacement(side: Side, requested?: "dock" | "fullscreen"): boolean {
    const nextPlacement = requested ?? (side.placement === "dock" ? "fullscreen" : "dock")
    if (side.placement === nextPlacement || !side.openView) return false
    side.repositioning = true
    side.control?.close()
    const ok = side.openView({
      kind: viewKind,
      data: side,
      placement: nextPlacement,
      state:
        side.mode === "history"
          ? {
              ...(side.selectedHistoryId ? { selected: { "history-list": side.selectedHistoryId } } : {}),
              focused: "history-list",
            }
          : { activeTabs: { threads: tabKeyOf(side) }, focused: "followup" },
    })
    side.repositioning = false
    if (!ok) return false
    side.placement = nextPlacement
    side.opened = true
    side.hidden = false
    api.requestRender()
    return true
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
    if (!lines.length && side.status === "ready") {
      lines.push({
        kind: "muted",
        text: "Ask a side question below (Enter to send · Tab switches main/btw · + New starts another thread).",
      })
    }
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
    if (!side.entries.length) side.question = question
    side.mode = "chat"
    side.saved = false
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
      if (!side.historyContext?.length) {
        const turns = extractCompletedTurns(side)
        if (turns.length) side.historyContext = turns
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

  function tabLabelFor(label: string, idPrefix?: string, busy = false): string {
    const flat = label.replace(/\s+/g, " ").trim()
    const base = flat && flat !== "New btw" ? flat : "New"
    const clipped = base.length > 16 ? `${base.slice(0, 15)}…` : base
    const tag = idPrefix ? `${idPrefix} ${clipped}` : clipped
    return busy ? `${WORKING_SYMBOL} ${tag}` : tag
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
      if (side.closed) {
        control.close()
        return
      }
      if (side.mode === "history") {
        if (side.selectedHistoryId) control.setState({ selected: { "history-list": side.selectedHistoryId } })
        control.focus("history-list")
      } else {
        control.setState({ activeTabs: { threads: tabKeyOf(side) } })
        control.focus("followup")
      }
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
      // If another thread became active via switchToSide, do not close the newly active thread.
      if (sides.get(side.sessionId) !== side) return
      closing.add(side)
      closeStashedForSession(side.sessionId, false)
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
      const history = readHistory(side.sessionId, side.data)
      if (side.mode === "history") {
        const selectedKey =
          (ctx.state.selected["history-list"] &&
          history.some((thread) => thread.id === ctx.state.selected["history-list"])
            ? ctx.state.selected["history-list"]
            : undefined) ??
          (side.selectedHistoryId && history.some((thread) => thread.id === side.selectedHistoryId)
            ? side.selectedHistoryId
            : undefined) ??
          history[0]?.id
        const body: UiNode = history.length
          ? {
              type: "table",
              id: "history-list",
              columns: [
                { key: "id", label: "ID", size: 4 },
                { key: "topic", label: "Topic", size: "fill" },
                { key: "turns", label: "Turns", size: 8, align: "right" },
                { key: "when", label: "Saved", size: 9, align: "right" },
              ],
              rows: history.map((thread) => {
                const flat = thread.title.replace(/\s+/g, " ").trim()
                const activeMark = thread.id === side.threadId ? " (active)" : ""
                return {
                  key: thread.id,
                  cells: {
                    id: [{ kind: "accent", text: thread.id }],
                    topic: `${flat}${activeMark}`,
                    turns: `${thread.turns.length} turn${thread.turns.length === 1 ? "" : "s"}`,
                    when: formatRelativeTime(thread.updatedAt, ctx.now),
                  },
                }
              }),
            }
          : {
              type: "text",
              lines: [{ kind: "muted", text: "No saved btw history in this session yet." }],
            }
        const actions: { node: UiNode; size?: number | "fill" }[] = [
          ...(selectedKey
            ? [
                {
                  size: 11,
                  node: {
                    type: "button" as const,
                    id: "history-restore",
                    label: "Restore",
                    tone: "accent" as const,
                  },
                },
                {
                  size: 10,
                  node: {
                    type: "button" as const,
                    id: "history-delete",
                    label: "Delete",
                    tone: "normal" as const,
                  },
                },
                {
                  size: 13,
                  node: {
                    type: "button" as const,
                    id: "history-clear",
                    label: "Clear All",
                    tone: "normal" as const,
                  },
                },
              ]
            : []),
          { size: "fill", node: { type: "spacer" } },
          ...(side.openView
            ? [
                {
                  size: 8,
                  node: {
                    type: "button" as const,
                    id: "placement",
                    label: side.placement === "dock" ? "Full" : "Dock",
                    tone: "normal" as const,
                  },
                },
              ]
            : []),
          {
            size: 8,
            node: { type: "button", id: "history-back", label: "Back", tone: "normal" },
          },
        ]
        const showRule = ctx.height >= 7
        return {
          type: "box",
          tone: "focus",
          title: {
            kind: "segments",
            parts: [
              { kind: "chip", text: "btw", tone: "accent" },
              { kind: "text", text: " History" },
              { kind: "dim", text: ` ${sep} ${history.length} saved` },
            ],
          },
          aside: "Enter to restore",
          child: {
            type: "column",
            children: [
              { size: "fill", node: body },
              ...(showRule ? [{ size: 1, node: { type: "rule" as const } }] : []),
              { size: 1, node: { type: "row", gap: 1, children: actions } },
            ],
          },
        }
      }

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
      const compactChip = ctx.width < 94
      const actionChildren: { node: UiNode; size?: number | "fill"; min?: number }[] = [
        {
          size: compactChip ? 5 : 11,
          node: {
            type: "bar",
            left: [{ kind: "chip", text: compactChip ? "btw" : "btw reply", tone: "accent" }],
          },
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
        ...(side.openView
          ? [
              {
                size: 8,
                node: {
                  type: "button" as const,
                  id: "placement",
                  label: side.placement === "dock" ? "Full" : "Dock",
                  tone: "normal" as const,
                },
              },
            ]
          : []),
        ...(history.length > 0
          ? [
              {
                size: 11,
                node: { type: "button" as const, id: "history", label: "History", tone: "normal" as const },
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
        {
          size: 9,
          node: { type: "button", id: "close", label: "Close", tone: "normal" },
        },
      ]
      const showRule = ctx.height >= 7
      const chatColumn: UiNode = {
        type: "column",
        children: [
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
        ],
      }
      const activeKey = tabKeyOf(side)
      const tabByKey = new Map<string, { key: string; label: string; body: UiNode }>()
      const recentHistory = history
        .slice(0, 5)
        .sort((a, b) => a.createdAt - b.createdAt || (historyNumber(a.id) ?? 0) - (historyNumber(b.id) ?? 0))
      for (const thread of recentHistory) {
        tabByKey.set(thread.id, {
          key: thread.id,
          label: tabLabelFor(thread.title, thread.id, false),
          body: chatColumn,
        })
      }
      for (const other of stashed.get(side.sessionId)?.values() ?? []) {
        const key = tabKeyOf(other)
        tabByKey.set(key, {
          key,
          label: tabLabelFor(
            other.question,
            other.threadId,
            other.status === "working" || other.status === "waiting",
          ),
          body: chatColumn,
        })
      }
      tabByKey.set(activeKey, {
        key: activeKey,
        label: tabLabelFor(
          side.question,
          side.threadId,
          side.status === "working" || side.status === "waiting",
        ),
        body: chatColumn,
      })
      const order = ensureTabOrder(side.sessionId, [...tabByKey.keys()])
      const threadTabs: { key: string; label: string; body: UiNode }[] = []
      for (const key of order) {
        const tab = tabByKey.get(key)
        if (tab) threadTabs.push(tab)
      }
      threadTabs.push({ key: "__new__", label: "+ New", body: chatColumn })
      const content: UiNode =
        ctx.height >= 7
          ? {
              type: "tabs",
              id: "threads",
              style: "divided",
              tabs: threadTabs,
            }
          : chatColumn
      return {
        type: "box",
        tone: "focus",
        title: { kind: "segments", parts: titleParts },
        aside: side.status,
        child: content,
      }
    },
    onEvent(event, side, control) {
      if (event.type === "tab" && event.id === "threads") {
        if (event.key === tabKeyOf(side)) {
          control.focus("followup")
          return
        }
        if (event.key === "__new__") {
          const fresh = createBlankSide(side.sessionId, {
            data: side.data,
            print: side.print,
            openView: side.openView,
            placement: side.placement,
          })
          switchToSide(side, fresh)
          return
        }
        const liveTarget = [...(stashed.get(side.sessionId)?.values() ?? [])].find(
          (item) => tabKeyOf(item) === event.key,
        )
        if (liveTarget) {
          switchToSide(side, liveTarget)
          return
        }
        const historyTarget = readHistory(side.sessionId, side.data).find((thread) => thread.id === event.key)
        if (historyTarget) {
          const restored = createBlankSide(side.sessionId, {
            data: side.data,
            print: side.print,
            openView: side.openView,
            placement: side.placement,
            question: historyTarget.title,
            status: "history",
          })
          applyHistoryThread(restored, historyTarget)
          switchToSide(side, restored)
        }
        return
      }
      if (event.type === "select" && event.id === "history-list") {
        side.selectedHistoryId = event.key
        return
      }
      if (event.type === "submit" && event.id === "followup") {
        const value = event.value.trim()
        if (!value) return
        control.setState({ inputValues: { followup: "" } })
        sendFollowUpInView(side, value)
        return
      }
      if (event.type === "activate") {
        if (event.id === "placement") {
          togglePlacement(side)
          return
        }
        if (event.id === "history-list") {
          const target = readHistory(side.sessionId, side.data).find((thread) => thread.id === event.key)
          if (target) {
            applyHistoryThread(side, target)
            control.setState({ activeTabs: { threads: tabKeyOf(side) } })
            control.focus("followup")
          }
          return
        }
        if (event.id === "history") {
          saveHistory(side)
          const history = readHistory(side.sessionId, side.data)
          side.mode = "history"
          side.selectedHistoryId = side.threadId ?? history[0]?.id
          if (side.selectedHistoryId) {
            control.setState({ selected: { "history-list": side.selectedHistoryId } })
            control.focus("history-list")
          }
          api.requestRender()
          return
        }
        if (event.id === "history-restore") {
          const history = readHistory(side.sessionId, side.data)
          const target = history.find((thread) => thread.id === side.selectedHistoryId) ?? history[0]
          if (target) {
            applyHistoryThread(side, target)
            control.setState({ activeTabs: { threads: tabKeyOf(side) } })
            control.focus("followup")
          }
          return
        }
        if (event.id === "history-delete") {
          const history = readHistory(side.sessionId, side.data)
          const target = history.find((thread) => thread.id === side.selectedHistoryId) ?? history[0]
          if (target) {
            deleteHistoryThread(side, target.id)
            if (side.selectedHistoryId) {
              control.setState({ selected: { "history-list": side.selectedHistoryId } })
            }
          }
          return
        }
        if (event.id === "history-clear") {
          clearAllHistory(side)
          return
        }
        if (event.id === "history-back") {
          if (side.entries.length) {
            side.mode = "chat"
            control.setState({ activeTabs: { threads: tabKeyOf(side) } })
            control.focus("followup")
            api.requestRender()
          } else {
            close(side)
          }
          return
        }
        if (event.id === "hide") hide(side)
        else if (event.id === "clear") clearSide(side)
        else if (event.id === "close") close(side)
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
          (item.question === part.text || item.deliveredPrompt === part.text) &&
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
    saveHistory(side)
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
      const prompt = buildPromptWithHistory(pending.question, side.historyContext)
      pending.deliveredPrompt = prompt
      side.group = session.createGroup!({ name: "btw" })
      side.child = side.group.spawn({
        title: "btw",
        prompt,
        context: "fork",
        ephemeral: true,
        callableTools: ["read", "grep", "glob"],
        ...(model ? { model } : {}),
        systemPrompt: SYSTEM,
      })
      side.historyContext = undefined
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
    if (ctx.openView) side.openView = ctx.openView
    const changingPlacement = side.opened && !side.hidden && side.placement !== placement
    if (side.opened && !side.hidden && !changingPlacement) return
    if (!ctx.openView || !ctx.session.createGroup) {
      throw new Error("Side questions need a TUI dock and an agent tree.")
    }
    if (changingPlacement) {
      side.repositioning = true
      side.control?.close()
    }
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
    description: "Open the btw panel or ask a side question without interrupting the main agent",
    args: {
      hint: "[question] | new | resume [id] | history | full | dock | hide | clear | close",
      complete(prefix, ctx): CommandCandidate[] {
        const trimmed = prefix.trimStart()
        const lower = trimmed.toLowerCase()
        // Never hijack multi-word free-text questions except after explicit `resume ` or `retry `.
        if (/\s/.test(trimmed) && !lower.startsWith("resume ") && !lower.startsWith("retry ")) {
          return []
        }
        const id = ctx.session.info().id
        const side = sides.get(id)
        const history = readHistory(id, ctx.session.data)
        const candidates: CommandCandidate[] = [
          { value: "new", description: "Start a new btw conversation thread" },
        ]
        if (history.length) {
          const latest = history[0]!
          const preview = latest.title.replace(/\s+/g, " ").trim()
          candidates.push({
            value: "resume",
            description: `Restore latest (${latest.id}: ${preview.length > 36 ? `${preview.slice(0, 35)}…` : preview})`,
          })
          for (const thread of history.slice(0, 8)) {
            const topic = thread.title.replace(/\s+/g, " ").trim()
            candidates.push({
              value: `resume ${thread.id}`,
              description: `${thread.turns.length} turn${thread.turns.length === 1 ? "" : "s"} · ${topic.length > 36 ? `${topic.slice(0, 35)}…` : topic}`,
            })
          }
        }
        candidates.push({
          value: "history",
          description: history.length
            ? `Browse, switch, or delete saved btw threads (${history.length})`
            : "Browse saved btw threads",
        })
        if (side && !side.closed) {
          if (side.placement === "dock") {
            candidates.push({ value: "full", description: "Expand btw panel to fullscreen" })
          } else {
            candidates.push({ value: "dock", description: "Dock btw panel above the composer" })
          }
          if (!side.hidden) {
            candidates.push({ value: "hide", description: "Minimize btw panel while keeping it alive" })
          }
          candidates.push({ value: "clear", description: "Clear the current btw conversation" })
          candidates.push({ value: "close", description: "Archive and close the btw panel" })
          for (const [retryId, item] of side.retries) {
            const preview = item.question.replace(/\s+/g, " ").trim()
            candidates.push({
              value: `retry ${retryId}`,
              description: `Retry: ${preview.length > 40 ? `${preview.slice(0, 39)}…` : preview}`,
            })
          }
        }
        return candidates
      },
    },
    echo: false,
    run(args, ctx) {
      ctx.signal.throwIfAborted()
      let question = args.trim()
      const id = ctx.session.info().id
      let side = sides.get(id)
      if (side && ctx.openView) side.openView = ctx.openView
      if (question === "close") {
        if (side) close(side)
        else closeStashedForSession(id)
        sides.delete(id)
        return
      }
      if (question === "clear") {
        if (side) clearSide(side)
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
      if (question === "new") {
        if (side && !side.closed) {
          const fresh = createBlankSide(id, {
            data: ctx.session.data,
            print: ctx.print,
            openView: ctx.openView,
            placement: side.placement,
            question: "New btw",
            status: "ready",
            saved: true,
          })
          if (side.opened && !side.hidden) {
            switchToSide(side, fresh)
          } else {
            stashSide(side)
            sides.set(id, fresh)
            open(fresh, ctx)
          }
          return
        }
        if (!ctx.openView || !ctx.session.createGroup) {
          throw new Error("Side questions need a TUI dock and an agent tree.")
        }
        const fresh = createBlankSide(id, {
          data: ctx.session.data,
          print: ctx.print,
          openView: ctx.openView,
          question: "New btw",
          status: "ready",
          saved: true,
        })
        sides.set(id, fresh)
        try {
          open(fresh, ctx)
        } catch (error) {
          finish(fresh, false)
          throw error
        }
        return
      }
      if (question === "history") {
        if (side && !side.closed) saveHistory(side)
        const history = readHistory(id, ctx.session.data)
        if (!history.length && (!side || side.closed)) {
          ctx.print("No saved btw history in this session yet.")
          return
        }
        if (side && !side.closed) {
          side.mode = "history"
          side.selectedHistoryId = side.threadId ?? history[0]?.id
          open(side, ctx)
          if (side.selectedHistoryId) {
            side.control?.setState({ selected: { "history-list": side.selectedHistoryId } })
            side.control?.focus("history-list")
          }
          api.requestRender()
          return
        }
        if (!ctx.openView || !ctx.session.createGroup) {
          throw new Error("Side questions need a TUI dock and an agent tree.")
        }
        const browser = createBlankSide(id, {
          data: ctx.session.data,
          print: ctx.print,
          openView: ctx.openView,
          question: "History",
          status: "history",
          mode: "history",
          saved: true,
        })
        browser.selectedHistoryId = history[0]?.id
        sides.set(id, browser)
        try {
          open(browser, ctx)
        } catch (error) {
          finish(browser, false)
          throw error
        }
        if (browser.selectedHistoryId) {
          browser.control?.setState({ selected: { "history-list": browser.selectedHistoryId } })
          browser.control?.focus("history-list")
        }
        api.requestRender()
        return
      }
      const resumeMatch = /^resume(?:\s+(\S+))?$/i.exec(question)
      if (resumeMatch) {
        if (side && !side.closed) saveHistory(side)
        const history = readHistory(id, ctx.session.data)
        const targetId = resumeMatch[1]?.toLowerCase()
        const thread = targetId ? history.find((item) => item.id.toLowerCase() === targetId) : history[0]
        if (!thread) {
          ctx.print(
            targetId
              ? `No saved btw conversation "${resumeMatch[1]}" found. Use /btw history to list saved conversations.`
              : "No saved btw history to resume in this session.",
          )
          return
        }
        const liveTarget = [...(stashed.get(id)?.values() ?? [])].find((item) => item.threadId === thread.id)
        if (side && !side.closed) {
          if (liveTarget) {
            switchToSide(side, liveTarget)
            open(liveTarget, ctx)
            return
          }
          applyHistoryThread(side, thread)
          open(side, ctx)
          side.control?.setState({ activeTabs: { threads: tabKeyOf(side) } })
          side.control?.focus("followup")
          api.requestRender()
          return
        }
        if (!ctx.openView || !ctx.session.createGroup) {
          throw new Error("Side questions need a TUI dock and an agent tree.")
        }
        const restored =
          liveTarget ??
          createBlankSide(id, {
            data: ctx.session.data,
            print: ctx.print,
            openView: ctx.openView,
            question: thread.title,
            status: "history",
            saved: true,
          })
        if (!liveTarget) applyHistoryThread(restored, thread)
        else removeFromStash(restored)
        sides.set(id, restored)
        try {
          open(restored, ctx)
        } catch (error) {
          finish(restored, false)
          throw error
        }
        restored.control?.setState({ activeTabs: { threads: tabKeyOf(restored) } })
        restored.control?.focus("followup")
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
        if (side && !side.closed) {
          if (side.mode === "history") side.mode = "chat"
          if (!side.opened || side.hidden) {
            open(side, ctx)
            if (!side.child && !side.failure) requeue(side, ctx.session)
          }
          side.control?.setState({ activeTabs: { threads: tabKeyOf(side) } })
          side.control?.focus("followup")
          api.requestRender()
          return
        }
        const history = readHistory(id, ctx.session.data)
        if (ctx.openView && ctx.session.createGroup) {
          const latest = history[0]
          const panel = createBlankSide(id, {
            data: ctx.session.data,
            print: ctx.print,
            openView: ctx.openView,
            question: latest?.title ?? "New btw",
            status: latest ? "history" : "ready",
            saved: true,
          })
          if (latest) applyHistoryThread(panel, latest)
          sides.set(id, panel)
          try {
            open(panel, ctx)
          } catch (error) {
            finish(panel, false)
            throw error
          }
          panel.control?.setState({ activeTabs: { threads: tabKeyOf(panel) } })
          panel.control?.focus("followup")
          api.requestRender()
          return
        }
        const historyHint = history.length
          ? ` /btw resume restores the latest (${history.length} saved in /btw history);`
          : ""
        ctx.print(
          `Use /btw <question> to ask or follow up (or Tab into the dock);${historyHint} /btw hide minimizes, Esc or /btw clear closes.`,
        )
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
          if (!side.historyContext?.length) {
            const turns = extractCompletedTurns(side)
            if (turns.length) side.historyContext = turns
          }
        } else {
          close(side)
          sides.delete(id)
          side = undefined
        }
      }
      const pending: Pending = { question, answer: "", timestamp: Date.now(), state: "queued" }
      if (side) {
        if (!side.entries.length) side.question = question
        side.mode = "chat"
        side.saved = false
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
      const next = createBlankSide(id, {
        data: ctx.session.data,
        print: ctx.print,
        openView: ctx.openView,
        question,
        status: "working",
        saved: false,
      })
      next.entries = [{ kind: "question", text: question, pending: [pending] }]
      next.pending = [pending]
      next.startedAt = Date.now()
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
    const side = createBlankSide(id, {
      data,
      print: (...args) => api.notify(...args),
      question: pending[0]!.question,
      status: "interrupted",
      saved: false,
    })
    side.pending = pending
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
    const allStashed = [...stashed.values()].flatMap((bucket) => [...bucket.values()])
    stashed.clear()
    for (const side of new Set([...sides.values(), ...allStashed, ...closing])) {
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
    else closeStashedForSession(event.sessionId)
  })
  api.on("session.start", restore)
  restore()
}

export default extension
