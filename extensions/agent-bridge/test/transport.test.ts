import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { createConnection } from "node:net"
import { BridgeError, createState, object } from "../src/storage.ts"
import { callLocal, type LocalServer, listenLocal, MAX_REQUEST_BYTES } from "../src/transport.ts"
import { captureRejection, deferred, harness, sandbox } from "./helpers.ts"

function raw(endpoint: string, request: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let text = ""
    socket.setEncoding("utf8")
    socket.setTimeout(2000, () => socket.destroy(new Error("Test socket timeout")))
    socket.on("connect", () => socket.write(request))
    socket.on("error", reject)
    socket.on("data", (chunk: string) => {
      text += chunk
      if (!text.includes("\n")) return
      socket.destroy()
      try {
        resolve(object(JSON.parse(text.split("\n")[0]!)))
      } catch (error) {
        reject(error)
      }
    })
    socket.on("close", () => {
      if (!text.includes("\n")) reject(new Error("No response"))
    })
  })
}

test("every connection requires the exact token; failures never reach the handler or leak credentials", async () => {
  const h = sandbox()
  const state = createState(h.home, {
    cwd: h.cwd,
    mode: "default",
    idleMinutes: 30,
    requestTimeoutMinutes: 30,
  })
  const calls: unknown[] = []
  let server: LocalServer | undefined
  try {
    server = await listenLocal(h.home, state, async (call) => {
      calls.push(call)
      return { text: `accidental ${state.token}` }
    })
    for (const token of [undefined, "wrong", "f".repeat(64), 123, null]) {
      const response = await raw(state.endpoint, `${JSON.stringify({ op: "status", token })}\n`)
      expect(response).toMatchObject({ ok: false, exitCode: 1, error: "Authentication failed" })
      expect(JSON.stringify(response)).not.toContain(state.token)
    }
    expect(calls).toEqual([])
    expect(await callLocal(h.home, state, { op: "status" })).toEqual({ text: "accidental [redacted]" })
    expect(calls).toEqual([{ op: "status" }])
    // A previous successful authenticated client confers no rights on a new socket.
    expect(await raw(state.endpoint, '{"op":"status"}\n')).toMatchObject({ ok: false })
    expect(calls).toHaveLength(1)
    if (process.platform !== "win32") expect(statSync(state.endpoint).mode & 0o777).toBe(0o600)
  } finally {
    await server?.close()
    h.cleanup()
  }
})

test("transport rejects malformed, oversized and multi-operation requests before dispatch", async () => {
  const h = sandbox()
  const state = createState(h.home, {
    cwd: h.cwd,
    mode: "default",
    idleMinutes: 30,
    requestTimeoutMinutes: 30,
  })
  let calls = 0
  let server: LocalServer | undefined
  try {
    server = await listenLocal(h.home, state, async () => {
      calls++
      return {}
    })
    expect(await raw(state.endpoint, "not-json\n")).toMatchObject({ error: "Invalid request JSON" })
    const first = JSON.stringify({ op: "status", token: state.token })
    expect(await raw(state.endpoint, `${first}\n${first}\n`)).toMatchObject({
      error: "Send one operation per connection",
    })
    expect(await raw(state.endpoint, `${JSON.stringify({ token: state.token })}\n`)).toMatchObject({
      error: "Send one operation per connection",
    })
    await expect(
      callLocal(h.home, state, { op: "send", text: "x".repeat(MAX_REQUEST_BYTES) }),
    ).rejects.toThrow("too large")
    expect(calls).toBe(0)
    await expect(
      callLocal(h.home, { ...state, endpoint: "127.0.0.1:9000" }, { op: "status" }),
    ).rejects.toThrow("Invalid bridge endpoint")
    await expect(
      listenLocal(h.home, { ...state, endpoint: "127.0.0.1:9000" }, async () => ({})),
    ).rejects.toThrow("Invalid bridge endpoint")
  } finally {
    await server?.close()
    h.cleanup()
  }
})

test("a cancelled local client signals only its own handler, and error replies redact tokens", async () => {
  const h = sandbox()
  const state = createState(h.home, {
    cwd: h.cwd,
    mode: "default",
    idleMinutes: 30,
    requestTimeoutMinutes: 30,
  })
  const entered = deferred<void>()
  const disconnected = deferred<void>()
  const controller = new AbortController()
  let server: LocalServer | undefined
  try {
    server = await listenLocal(h.home, state, async (call, signal) => {
      if (call.op === "error") throw new BridgeError(`secret ${state.token}`)
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            disconnected.resolve()
            resolve()
          },
          { once: true },
        ),
      )
      return {}
    })
    const waiting = callLocal(h.home, state, { op: "wait" }, { signal: controller.signal })
    const rejected = captureRejection(waiting, "cancelled")
    await entered.promise
    controller.abort()
    await rejected
    await disconnected.promise
    await expect(callLocal(h.home, state, { op: "error" })).rejects.toThrow("secret [redacted]")
  } finally {
    controller.abort()
    await server?.close()
    h.cleanup()
  }
})

test("unauthenticated traffic cannot renew the daemon's idle lease", async () => {
  const h = harness({ idleMinutes: 1 })
  try {
    await h.daemon.start()
    h.advance(59_999)
    expect(await raw(h.state.endpoint, '{"op":"status","token":"wrong"}\n')).toMatchObject({
      error: "Authentication failed",
    })
    h.advance(2)
    await h.daemon.tick()
    expect(h.state.status).toBe("exited")
  } finally {
    await h.cleanup()
  }
})
