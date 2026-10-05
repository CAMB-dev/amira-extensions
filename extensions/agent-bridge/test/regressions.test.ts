import { expect, test } from "bun:test"
import { object } from "../src/storage.ts"
import { assistant, eventually, harness, signal } from "./helpers.ts"

test("idle waits span promoted turns, including the intervening idle status", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.emit("turn.start")
    let finished = false
    const waiting = h.daemon.wait("idle", 0, 2000, signal()).then((value) => {
      finished = true
      return value
    })
    h.child.emit("turn.steer", { state: "promoted", nextTurnId: "t_next" })
    h.child.emit("turn.end", { reason: "done" })
    h.child.emit("status.changed", { status: "idle" })
    await Bun.sleep(5)
    expect(finished).toBe(false)
    h.child.turnId = "t_next"
    h.child.emit("turn.start")
    h.child.emit("turn.end", { reason: "done" })
    expect(await waiting).toMatchObject({ timedOut: false })
  } finally {
    await h.cleanup()
  }
})

test("event-loss uncertainty prevents idle success and automatic shutdown", async () => {
  const h = harness({ idleMinutes: 1 })
  try {
    await h.daemon.start()
    h.child.emit("subagent.start", { childSessionId: "background" })
    h.child.emit("events.lost", { dropped: 3 })
    await eventually(
      () => h.daemon.journal.events.some((event) => event.type === "bridge.recovered"),
      "recovery",
    )
    expect(await h.call("wait", { until: "idle", timeout: 0 })).toMatchObject({ timedOut: true })
    h.advance(120_000)
    await h.daemon.tick()
    expect(h.child.closed).toEqual([])
    expect(h.daemon.status().idleSeconds).toBeNull()
    expect(object(h.daemon.status().usage).currentRunTree).toMatchObject({ uncertain: true })
  } finally {
    await h.cleanup()
  }
})

for (const mode of ["all", "lastTurn"]) {
  test(`history ${mode} cursor never skips events delivered just after the snapshot`, async () => {
    const h = harness()
    try {
      await h.daemon.start()
      h.child.onRequest = (request) => {
        if (request.cmd !== "session.read") return false
        h.child.reply(request, { messages: [] })
        h.child.emit("message.end", { message: assistant("after snapshot") })
        h.child.emit("turn.end", { reason: "done" })
        return true
      }
      const history = await h.call("read", { [mode]: true })
      expect(history.messages).toEqual([])
      const next = await h.call("read", { since: history.cursor })
      expect(JSON.stringify(next.events)).toContain("after snapshot")
      expect(JSON.stringify(next.events)).toContain("turn.end")
    } finally {
      await h.cleanup()
    }
  })
}

test("history usage does not double-count a delayed event or deduplicate genuine identical replies", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const message = { ...assistant("same"), usage: { input: 2, output: 3, cost: 0.1 } }
    h.child.messages = [message]
    expect(object((await h.call("status")).usage).rootSession).toMatchObject({ input: 2 })
    h.child.stdout(
      `${JSON.stringify({ type: "message.end", sessionId: h.child.sessionId, data: { message } })}\n`,
    )
    expect(object((await h.call("status")).usage).rootSession).toMatchObject({ input: 2, cost: 0.1 })
    h.child.emit("message.end", { message })
    expect(object((await h.call("status")).usage).rootSession).toMatchObject({ input: 4, cost: 0.2 })
  } finally {
    await h.cleanup()
  }
})

test("stop reports failed cleanup instead of returning success", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    h.child.exitOnClose = false
    await expect(h.call("stop")).rejects.toThrow("did not confirm exit")
    expect(h.state.status).toBe("failed")
  } finally {
    h.child.exit(0)
    await h.cleanup()
  }
}, 15_000)
