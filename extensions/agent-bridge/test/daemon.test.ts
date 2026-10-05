import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { formatRead } from "../src/daemon.ts"
import { agentPath, type BridgeEvent, object, readState } from "../src/storage.ts"
import { callLocal } from "../src/transport.ts"
import { assistant, captureRejection, deferred, eventually, harness, signal } from "./helpers.ts"

function events(result: Record<string, unknown>): BridgeEvent[] {
  return result.events as BridgeEvent[]
}

test("readiness waits for root startup and state; child uses the temporary home and resume flags", async () => {
  const h = harness({ mode: "plan", model: "mock/m", resume: "s_saved", name: "Review" })
  h.child.sessionId = "s_saved"
  h.child.autoStart = false
  h.child.held.add("state")
  const started = h.daemon.start()
  try {
    await eventually(() => Boolean(h.child.options), "child spawn")
    expect(await h.call("probe")).toMatchObject({ ready: false, sessionId: null })
    await expect(h.call("send", { text: "too soon" })).rejects.toThrow("still starting")
    h.child.startSession()
    await eventually(() => h.child.requests.some((r) => r.cmd === "state"), "state barrier")
    expect(await h.call("probe")).toMatchObject({ ready: false })
    h.child.reply(h.child.requests.find((r) => r.cmd === "state")!, {
      sessionId: "s_saved",
      model: "mock/m",
      busy: false,
      uiRequests: [],
    })
    await started
    expect(await h.call("probe")).toMatchObject({ ready: true, sessionId: "s_saved" })
    expect(h.child.argv).toEqual([
      "fake-amira",
      "--rpc",
      "-C",
      h.cwd,
      "-m",
      "mock/m",
      "--resume",
      "s_saved",
      "--permission-mode",
      "plan",
    ])
    expect(h.child.options?.env?.AMIRA_HOME).toBe(h.home)
    expect(h.child.requests.find((r) => r.cmd === "session.rename")).toMatchObject({ title: "Review" })
    expect(readState(h.home, h.state.id)).toMatchObject({ sessionId: "s_saved", processStart: "test-birth" })
  } finally {
    await started.catch(() => {})
    await h.cleanup()
  }
})

test("startup death returns stderr tail, redacts the token, and persists failure", async () => {
  const h = harness()
  h.child.autoStart = false
  const started = h.daemon.start()
  const rejected = captureRejection(started, "bad model configuration")
  try {
    await eventually(() => Boolean(h.child.options), "child spawn")
    h.child.stderr(`bad model configuration ${h.state.token}`)
    h.child.exit(2)
    await rejected
    expect(h.state.status).toBe("failed")
    expect(h.state.error).toContain("RPC stderr")
    expect(h.state.error).not.toContain(h.state.token)
    expect(readFileSync(agentPath(h.home, h.state.id, ".events.jsonl"), "utf8")).not.toContain(h.state.token)
  } finally {
    await h.cleanup()
  }
})

test("cursor is independent of RPC seq; repeated reads are strict, durable and non-consuming", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    expect(h.child.argv).not.toContain("--permission-mode")
    const before = h.daemon.journal.cursor
    h.child.emit("message.delta", { kind: "text", text: "answer" })
    h.child.emit("message.end", { message: assistant("answer") })
    h.child.emit("turn.end", { reason: "done" })
    const first = await h.call("read", { since: before })
    expect(events(first).map((event) => event.seq)).toEqual([before + 1, before + 2, before + 3])
    expect(events(first)[0]?.event?.seq).toBeGreaterThan(100)
    expect(await h.call("read", { since: before })).toEqual(first)
    expect(events(await h.call("read", { since: first.cursor }))).toEqual([])
    expect(events(await h.call("read"))).toHaveLength(Number(first.cursor))
    expect(formatRead(first, h.state.id)).toBe(`answer\nturn end: done\ncursor: ${first.cursor}\n`)
    const persisted = readFileSync(agentPath(h.home, h.state.id, ".events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)))
    expect(persisted.map((event) => event.seq)).toEqual(
      events(await h.call("read")).map((event) => event.seq),
    )
    for (const since of [-1, 0.5, "2", Number.NaN]) {
      await expect(h.call("read", { since })).rejects.toThrow("nonnegative integer")
    }
  } finally {
    await h.cleanup()
  }
})

test("compact reads include one-line tool results, request instructions, errors and final cursor", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const cursor = h.daemon.journal.cursor
    h.child.emit("tool.execute.start", { toolCallId: "a", name: "read", args: { path: "file.ts" } })
    h.child.emit("tool.execute.end", {
      toolCallId: "a",
      name: "read",
      result: { content: "line one\nline two" },
    })
    h.child.emit("tool.execute.end", {
      toolCallId: "b",
      name: "write",
      result: { isError: true, content: "denied" },
    })
    h.child.emit("extension.error", { error: "extension failed\nsecond line" })
    h.child.emit("ui.request", { requestId: "q", kind: "confirm", title: "Proceed?" }, "host")
    h.child.emit("turn.end", { reason: "error", error: "provider failed" })
    const text = formatRead(await h.call("read", { since: cursor }), h.state.id)
    expect(text).toContain('tool read: {"path":"file.ts"}')
    expect(text).toContain("tool read: ok line one line two")
    expect(text).toContain("tool write: error denied")
    expect(text).toContain("error: extension failed second line")
    expect(text).toContain(`answer: amira agent respond ${h.state.id} q`)
    expect(text).toContain("null cancels")
    expect(text).toContain("turn end: error — provider failed")
    expect(text).toEndWith(`cursor: ${h.daemon.journal.cursor}\n`)
  } finally {
    await h.cleanup()
  }
})

test("send while busy fails atomically; both steering forms queue and idle steer starts a turn", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const cursor = h.daemon.journal.cursor
    expect(await h.call("send", { text: "first" })).toMatchObject({ turnId: "t_1", cursor })
    await expect(h.call("send", { text: "second" })).rejects.toThrow("busy — use steer")
    expect(await h.call("steer", { text: "also this" })).toMatchObject({ queued: true })
    expect(await h.call("send", { text: "and this", steer: true })).toMatchObject({ queued: true })
    h.child.emit("turn.steer", { state: "injected" })
    h.child.emit("turn.steer", { state: "promoted", nextTurnId: "t_2" })
    h.child.emit("turn.steer", { state: "dropped" })
    h.child.emit("turn.end", { reason: "done" })
    expect(await h.call("steer", { text: "new turn" })).toMatchObject({ queued: false })
    expect(h.daemon.status().busy).toBe(true)
    const text = formatRead(await h.call("read", { since: cursor }), h.state.id)
    expect(text).toContain("steer injected")
    expect(text).toContain("steer promoted: t_2")
    expect(text).toContain("steer dropped")
  } finally {
    await h.cleanup()
  }
})

test("a whole turn in one RPC chunk is not skipped by send's returned cursor or left busy", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.onRequest = (request) => {
      if (request.cmd !== "prompt") return false
      h.child.reply(request, { turnId: "t_fast" })
      h.child.emit("turn.start")
      h.child.emit("message.end", { message: assistant("fast") })
      h.child.emit("turn.end", { reason: "done" })
      return true
    }
    const result = await h.call("send", { text: "go" })
    expect(h.daemon.status().busy).toBe(false)
    expect(formatRead(await h.call("read", { since: result.cursor }), h.state.id)).toContain("fast")
    expect(await h.call("wait", { until: "turn-end", since: result.cursor, timeout: 0 })).toMatchObject({
      timedOut: false,
    })
  } finally {
    await h.cleanup()
  }
})

test("read --all and --last-turn delegate to session.read and keep unknown message fields", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const message = { ...assistant("saved reply"), extra: { future: true }, usage: { input: 3, output: 4 } }
    h.child.messages = [message]
    h.child.lastTurn = { messages: [message], turnId: "t_saved", text: "saved reply", reason: "done" }
    expect(await h.call("read", { all: true })).toMatchObject({ messages: [message] })
    expect(await h.call("read", { lastTurn: true })).toMatchObject(h.child.lastTurn)
    await expect(h.call("read", { all: true, lastTurn: true })).rejects.toThrow("not both")
  } finally {
    await h.cleanup()
  }
})

for (const until of ["reply", "turn-end"] as const) {
  test(`${until} waits only for the root after since, including already-buffered events`, async () => {
    const h = harness()
    try {
      await h.daemon.start()
      const type = until === "reply" ? "message.end" : "turn.end"
      const data = until === "reply" ? { message: assistant("root reply") } : { reason: "done" }
      h.child.emit(type, data)
      const cursor = h.daemon.journal.cursor
      h.child.emit(type, data, "s_child")
      expect(await h.call("wait", { until, since: cursor, timeout: 0 })).toMatchObject({ timedOut: true })
      const waiting = h.daemon.wait(until, cursor, 1000, signal())
      h.child.emit(type, data)
      expect(await waiting).toMatchObject({ timedOut: false, until })
      expect(await h.call("wait", { until, since: cursor, timeout: 0 })).toMatchObject({ timedOut: false })
      expect(await h.call("wait", { until, since: h.daemon.journal.cursor, timeout: 0 })).toMatchObject({
        timedOut: true,
      })
    } finally {
      await h.cleanup()
    }
  })
}

test("reply waits for completed text, not deltas, thinking or tool-only assistant messages", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const cursor = h.daemon.journal.cursor
    h.child.emit("message.delta", { kind: "text", text: "partial" })
    h.child.emit("message.end", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
    })
    h.child.emit("message.end", {
      message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
    })
    expect(await h.call("wait", { until: "reply", since: cursor, timeout: 0 })).toMatchObject({
      timedOut: true,
    })
  } finally {
    await h.cleanup()
  }
})

test("request includes host UI; idle waits for both turn end and pending answers", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    expect(await h.call("wait", { until: "idle", timeout: 0 })).toMatchObject({ timedOut: false })
    expect(await h.call("wait", { until: "request", timeout: 0 })).toMatchObject({ timedOut: true })
    h.child.emit("turn.start")
    const requestWait = h.daemon.wait("request", h.daemon.journal.cursor, 1000, signal())
    h.child.emit("ui.request", { requestId: "q1", kind: "confirm", title: "Proceed?" }, "host")
    expect(await requestWait).toMatchObject({ timedOut: false })
    // A current request is visible even when it predates the read cursor.
    expect(
      await h.call("wait", { until: "request", since: h.daemon.journal.cursor, timeout: 0 }),
    ).toMatchObject({ timedOut: false })
    h.child.emit("turn.end", { reason: "done" })
    expect(await h.call("wait", { until: "idle", timeout: 0 })).toMatchObject({ timedOut: true })
    const idle = h.daemon.wait("idle", 0, 1000, signal())
    await h.call("respond", { requestId: "q1", value: true })
    expect(await idle).toMatchObject({ timedOut: false })
  } finally {
    await h.cleanup()
  }
})

test("wait timeout returns its read range and disconnect releases the client without closing RPC", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const cursor = h.daemon.journal.cursor
    h.child.emit("extension.notice", { text: "still waiting" })
    const result = await h.call("wait", { until: "reply", since: cursor, timeout: 0 })
    expect(result).toMatchObject({ timedOut: true, cursor: cursor + 1 })
    expect(formatRead(result, h.state.id)).toContain("wait timed out")
    const controller = new AbortController()
    const waiting = h.daemon.handle({ op: "wait", until: "request", timeout: 10 }, controller.signal)
    const rejected = captureRejection(waiting, "Client disconnected")
    controller.abort()
    await rejected
    expect(h.daemon.status().activeCalls).toBe(0)
    expect(h.child.closed).toEqual([])
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(h.daemon.wait("reply", 0, 1000, alreadyAborted.signal)).rejects.toThrow("disconnected")
  } finally {
    await h.cleanup()
  }
})

test("pending UI survives short-lived clients; invalid answers stay pending and explicit null cancels", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.emit("ui.request", { requestId: "q1", kind: "confirm", title: "Proceed?" }, "host")
    const read = await callLocal(h.home, h.state, { op: "read" })
    expect(read.pendingRequests).toEqual([expect.objectContaining({ requestId: "q1" })])
    expect(formatRead(read, h.state.id)).toContain(`amira agent respond ${h.state.id} q1`)
    await expect(h.call("respond", { requestId: "q1" })).rejects.toThrow("value is required")
    await expect(h.call("respond", { requestId: "q1", value: "private-answer" })).rejects.toThrow("boolean")
    expect(h.daemon.status().pendingRequests).toHaveLength(1)
    const log = () => readFileSync(agentPath(h.home, h.state.id, ".events.jsonl"), "utf8")
    expect(log()).not.toContain("private-answer")
    expect(h.child.closed).toEqual([])
    await callLocal(h.home, h.state, { op: "respond", requestId: "q1", value: null })
    expect(h.daemon.status().pendingRequests).toEqual([])
    await expect(h.call("respond", { requestId: "q1", value: true })).rejects.toThrow("No such request")
    expect(log()).toContain('"cancelled":true')
    h.child.emit("ui.request", { requestId: "form", kind: "form", title: "Credentials" }, "host")
    h.child.onRequest = (request) => {
      if (request.cmd !== "ui.respond") return false
      expect(request.value).toEqual({ password: "accepted-private-answer" })
      h.child.emit("ui.resolved", { requestId: "form", cancelled: false }, "host")
      h.child.reply(request)
      return true
    }
    await h.call("respond", { requestId: "form", value: { password: "accepted-private-answer" } })
    expect(h.daemon.status().pendingRequests).toEqual([])
    expect(log()).not.toContain("accepted-private-answer")
  } finally {
    await h.cleanup()
  }
})

for (const race of [false, true]) {
  test(`request deadline survives refresh and auto-responds explicit null${race ? " despite a resolved race" : ""}`, async () => {
    const h = harness({ requestTimeoutMinutes: 1, idleMinutes: 10 })
    try {
      await h.daemon.start()
      h.child.emit("ui.request", { requestId: "expires", kind: "confirm" }, "host")
      const original = object((h.daemon.status().pendingRequests as unknown[])[0]).deadline
      h.advance(59_999)
      await h.call("status")
      expect(object((h.daemon.status().pendingRequests as unknown[])[0]).deadline).toBe(original)
      await h.daemon.tick()
      expect(h.child.requests.filter((r) => r.cmd === "ui.respond")).toEqual([])
      if (race) h.child.uiRequests.delete("expires")
      h.advance(1)
      await h.daemon.tick()
      expect(h.child.requests.filter((r) => r.cmd === "ui.respond")).toEqual([
        expect.objectContaining({ requestId: "expires", value: null }),
      ])
      expect(h.daemon.status().pendingRequests).toEqual([])
      expect(h.state.status).toBe("idle")
      expect(formatRead(h.daemon.read(), h.state.id)).toContain("auto-cancelled with null")
      h.advance(60_000)
      await h.daemon.tick()
      expect(h.child.requests.filter((r) => r.cmd === "ui.respond")).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })
}

test("idle shutdown pauses for running work, UI and authenticated calls, then aborts and retains history", async () => {
  const h = harness({ idleMinutes: 1, requestTimeoutMinutes: 30 })
  const retainedSession = path.join(h.home, "session-retained.jsonl")
  try {
    writeFileSync(retainedSession, "session history\n")
    await h.daemon.start()
    h.child.emit("turn.start")
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.state.status).toBe("running")
    expect(h.daemon.status().idleSeconds).toBeNull()
    h.child.emit("turn.end", { reason: "done" })
    h.child.emit("ui.request", { requestId: "q1", kind: "confirm" }, "host")
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.child.closed).toEqual([])
    await h.call("respond", { requestId: "q1", value: true })
    h.child.held.add("session.read")
    const active = h.call("read", { all: true })
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.daemon.status().activeCalls).toBe(1)
    expect(h.child.closed).toEqual([])
    h.child.reply(h.child.requests.at(-1)!, { messages: [] })
    await active
    h.advance(59_999)
    await h.daemon.tick()
    expect(h.child.closed).toEqual([])
    h.advance(2)
    await h.daemon.tick()
    await h.daemon.done
    expect(h.state.status).toBe("exited")
    expect(h.child.requests.at(-1)?.cmd).toBe("abort")
    expect(h.child.closed).toEqual([2000])
    expect(readState(h.home, h.state.id).status).toBe("exited")
    expect(readFileSync(retainedSession, "utf8")).toBe("session history\n")
    if (process.platform !== "win32") expect(existsSync(h.state.endpoint)).toBe(false)
  } finally {
    await h.cleanup()
  }
})

test("active tools and subagents pause idle expiry and status keeps usage scopes distinct", async () => {
  const h = harness({ idleMinutes: 1 })
  try {
    await h.daemon.start()
    h.child.emit("tool.execute.start", { toolCallId: "same", name: "root-tool", args: {} })
    h.child.emit("tool.execute.start", { toolCallId: "same", name: "child-tool", args: {} }, "child")
    h.child.emit("subagent.start", { childSessionId: "child" })
    h.child.emit("message.end", { message: { ...assistant("root"), usage: { input: 2, output: 3 } } })
    h.child.emit(
      "message.end",
      { message: { ...assistant("child"), usage: { input: 100, output: 100 } } },
      "child",
    )
    h.child.emit("budget.update", { tokens: 205, costUsd: 0.2 })
    expect(h.daemon.status().tools).toHaveLength(2)
    expect(h.daemon.status().subagents).toHaveLength(1)
    expect((await h.call("status")).usage).toMatchObject({
      rootSession: { input: 2, output: 3, cost: null },
      currentRunTree: { tokens: 205, costUsd: 0.2 },
    })
    h.child.emit("budget.update", { tokens: 305, costUsd: 0.3 }, "child")
    expect(object(h.daemon.status().usage).currentRunTree).toMatchObject({ tokens: 305, costUsd: 0.3 })
    h.child.emit("tool.execute.end", { toolCallId: "same", name: "root-tool", result: { content: [] } })
    expect(h.daemon.status().tools).toHaveLength(1)
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.child.closed).toEqual([])
    h.child.emit(
      "tool.execute.end",
      { toolCallId: "same", name: "child-tool", result: { content: [] } },
      "child",
    )
    h.child.emit("subagent.end", { childSessionId: "child", usage: { input: 100, output: 100 } })
    expect(h.daemon.status().subagents).toEqual([])
    expect(object(object(h.daemon.status().usage).rootSession).input).toBe(2)
  } finally {
    await h.cleanup()
  }
})

test("event loss reconciles state/history, releases missed turn waits, and marks projections uncertain", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.emit("turn.start")
    h.child.emit("tool.execute.start", { toolCallId: "lost", name: "read" })
    h.child.emit("subagent.start", { childSessionId: "lost-child" })
    const cursor = h.daemon.journal.cursor
    const waiting = h.daemon.wait("turn-end", cursor, 1000, signal())
    h.child.busy = false
    h.child.messages = [assistant("recovered answer")]
    h.child.lastTurn = { messages: h.child.messages, turnId: "t_1", text: "recovered answer", reason: "done" }
    h.child.uiRequests.set("missed-request", { requestId: "missed-request", kind: "confirm" })
    h.child.emit("events.lost", { dropped: 7 })
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(events(result).map((event) => event.type)).toEqual(["events.lost", "bridge.recovered"])
    expect(h.daemon.status()).toMatchObject({
      busy: false,
      tools: [],
      subagents: [],
      projectionsUncertain: true,
    })
    expect(h.daemon.status().pendingRequests).toHaveLength(1)
    expect(formatRead(result, h.state.id)).toContain("recovered answer")
    // A second loss marker must not re-report the same already-read completed turn.
    const recoveredCursor = h.daemon.journal.cursor
    h.child.emit("events.lost", { dropped: 1 })
    await eventually(
      () => h.daemon.journal.events.filter((e) => e.type === "bridge.recovered").length === 2,
      "second recovery",
    )
    expect(await h.call("wait", { until: "turn-end", since: recoveredCursor, timeout: 0 })).toMatchObject({
      timedOut: true,
    })
  } finally {
    await h.cleanup()
  }
})

test("child death rejects outstanding calls/waits, records failure and reports it to later clients", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.held.add("session.read")
    const reading = h.call("read", { all: true })
    const waiting = h.daemon.wait("turn-end", h.daemon.journal.cursor, 1000, signal())
    const readError = captureRejection(reading, "child crashed")
    const waitError = captureRejection(waiting, "child crashed")
    h.child.stderr("child crashed")
    h.child.exit(17)
    await Promise.all([readError, waitError, h.daemon.done])
    expect(readState(h.home, h.state.id).status).toBe("failed")
    expect(h.daemon.journal.events.at(-1)?.type).toBe("bridge.failed")
    await expect(callLocal(h.home, h.state, { op: "status" })).rejects.toMatchObject({ exitCode: 3 })
  } finally {
    await h.cleanup()
  }
})

for (const activity of ["idle", "turn", "request"] as const) {
  test(`stop while ${activity} aborts, closes the child, rejects waits and retains the journal`, async () => {
    const h = harness()
    try {
      await h.daemon.start()
      if (activity !== "idle") h.child.emit("turn.start")
      if (activity === "request") h.child.emit("ui.request", { requestId: "q1", kind: "confirm" }, "host")
      const waiting = h.daemon.wait("reply", h.daemon.journal.cursor, 1000, signal())
      const rejected = captureRejection(waiting, "stopping")
      expect(await h.call("stop")).toMatchObject({ status: "exited" })
      await rejected
      await h.daemon.done
      expect(h.child.closed).toEqual([2000])
      expect(h.child.requests.at(-1)?.cmd).toBe("abort")
      expect(existsSync(agentPath(h.home, h.state.id, ".events.jsonl"))).toBe(true)
      expect(readState(h.home, h.state.id).sessionId).toBe("s_root")
    } finally {
      await h.cleanup()
    }
  })
}

test("startup timeout is bounded and closes an unready child", async () => {
  const h = harness({}, { startupTimeoutMs: 250 })
  h.child.autoStart = false
  try {
    await expect(h.daemon.start()).rejects.toThrow("startup timed out")
    expect(h.state.status).toBe("failed")
    expect(h.child.closed).toEqual([1000])
  } finally {
    await h.cleanup()
  }
})

test("an authenticated outstanding wait blocks idle shutdown until disconnect", async () => {
  const h = harness({ idleMinutes: 1 })
  const controller = new AbortController()
  const entered = deferred<void>()
  try {
    await h.daemon.start()
    const original = h.child.onRequest
    h.child.onRequest = (request) => {
      if (request.cmd === "state") entered.resolve()
      return original?.(request) ?? false
    }
    const waiting = callLocal(
      h.home,
      h.state,
      { op: "wait", until: "request", timeout: 10 },
      {
        signal: controller.signal,
      },
    )
    const rejection = captureRejection(waiting, "cancelled")
    await entered.promise
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.child.closed).toEqual([])
    controller.abort()
    await rejection
    await eventually(() => h.daemon.status().activeCalls === 0, "disconnected wait cleanup")
    h.advance(60_001)
    await h.daemon.tick()
    expect(h.state.status).toBe("exited")
  } finally {
    controller.abort()
    await h.cleanup()
  }
})
