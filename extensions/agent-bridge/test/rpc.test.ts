import { expect, test } from "bun:test"
import { RpcClient } from "../src/rpc.ts"
import type { JsonObject } from "../src/storage.ts"
import { captureRejection, FakeChild, sandbox } from "./helpers.ts"

function rpcHarness() {
  const files = sandbox()
  const child = new FakeChild()
  child.autoStart = false
  const rpc = new RpcClient(child.factory)
  rpc.start(["fake-amira", "--rpc"], { cwd: files.cwd, env: { AMIRA_HOME: files.home } })
  return {
    ...files,
    child,
    rpc,
    cleanup() {
      rpc.close(0)
      files.cleanup()
    },
  }
}

test("fragmented CRLF JSONL interleaves events with concurrent responses by unique IDs", async () => {
  const h = rpcHarness()
  try {
    h.child.held.add("one")
    h.child.held.add("two")
    const events: JsonObject[] = []
    const order: string[] = []
    h.rpc.onEvent = (event) => {
      events.push(event)
      order.push(String(event.type))
    }
    const first = h.rpc.call("one", { text: "input" }, 1000, () => {
      order.push("snapshot")
    })
    const second = h.rpc.call("two", {}, 1000)
    const [a, b] = h.child.requests
    expect(a?.id).not.toBe(b?.id)
    expect(a).toMatchObject({ cmd: "one", text: "input" })
    expect(a).not.toHaveProperty("params")
    h.child.stdout(`\r\n{"id":${b?.id},"ok":true,"value":"second"}\r\n{"ty`)
    expect(await second).toEqual({ value: "second" })
    h.child.stdout(`pe":"turn.start","seq":7,"data":{}}\n{"id":${a?.id},"ok":true,`)
    h.child.stdout('"value":"first"}\n{"type":"turn.end","seq":8,"data":{"reason":"done"}}\n')
    expect(await first).toEqual({ value: "first" })
    expect(order).toEqual(["turn.start", "snapshot", "turn.end"])
    expect(events.map((event) => event.seq)).toEqual([7, 8])
  } finally {
    h.cleanup()
  }
})

test("busy errors use bridge guidance; other RPC codes survive unchanged", async () => {
  const h = rpcHarness()
  try {
    h.child.busy = true
    await expect(h.rpc.call("prompt", { text: "go" })).rejects.toMatchObject({
      code: "busy",
      exitCode: 1,
      message: "busy — use steer",
    })
    await expect(h.rpc.call("ui.respond", { requestId: "missing", value: null })).rejects.toMatchObject({
      code: "not_found",
      message: "No such request",
    })
    expect(await h.rpc.call("steer", { text: "instead" })).toMatchObject({ queued: true })
  } finally {
    h.cleanup()
  }
})

test("child exit rejects all pending calls, keeps a bounded stderr tail and fires exit once", async () => {
  const h = rpcHarness()
  try {
    h.child.held.add("state")
    const pending = [h.rpc.call("state"), h.rpc.call("state")]
    const rejections = pending.map((call) => captureRejection(call, "stderr sentinel"))
    let exits = 0
    h.rpc.onExit = () => {
      exits++
    }
    h.child.stderr(`${"x".repeat(20_000)}stderr sentinel`)
    h.child.exit(9)
    h.child.options?.onEvent({ type: "exit", code: 9 })
    await Promise.all(rejections)
    expect(h.rpc.stderrTail).toHaveLength(16_384)
    expect(await h.rpc.exited).toMatchObject({ code: 9 })
    expect(h.rpc.alive).toBe(false)
    expect(exits).toBe(1)
    await expect(h.rpc.call("state")).rejects.toMatchObject({ exitCode: 3, code: "not_running" })
  } finally {
    h.cleanup()
  }
})

test("a timed-out response does not poison later calls and delayed spawn still permits writes", async () => {
  const h = rpcHarness()
  try {
    h.child.held.add("state")
    await expect(h.rpc.call("state", {}, 5)).rejects.toThrow("RPC state timed out")
    h.child.reply(h.child.requests[0]!, { stale: true })
    h.child.options?.onEvent({ type: "spawned", pid: 23456 })
    h.child.held.delete("state")
    expect(await h.rpc.call("state")).toMatchObject({ sessionId: "s_root" })
    expect(h.rpc.pid).toBe(23456)
  } finally {
    h.cleanup()
  }
})

test("malformed child output fails outstanding calls and closes only its own pipe", async () => {
  const h = rpcHarness()
  try {
    h.child.held.add("state")
    const waiting = h.rpc.call("state")
    const rejected = captureRejection(waiting, "RPC child exited")
    h.child.stdout("not JSON\n")
    await rejected
    expect(h.child.closed).toEqual([0])
    expect(h.rpc.alive).toBe(false)
  } finally {
    h.cleanup()
  }
})
