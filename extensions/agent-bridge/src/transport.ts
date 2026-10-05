import { timingSafeEqual } from "node:crypto"
import { createConnection, createServer, type Socket } from "node:net"
import {
  BridgeError,
  type BridgeState,
  endpointFor,
  errorMessage,
  type JsonObject,
  object,
  privateMode,
  redact,
} from "./storage.ts"

export const MAX_REQUEST_BYTES = 8 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024
export interface ClientCall {
  op: string
  [key: string]: unknown
}
export type RequestHandler = (call: ClientCall, signal: AbortSignal) => Promise<JsonObject>
export interface LocalServer {
  close(): Promise<void>
}

function authenticated(value: unknown, token: string): boolean {
  if (typeof value !== "string") return false
  const a = Buffer.from(value)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A single authenticated call per connection; no TCP address is accepted anywhere. */
export async function listenLocal(
  home: string,
  state: BridgeState,
  handle: RequestHandler,
): Promise<LocalServer> {
  if (state.endpoint !== endpointFor(home, state.id)) throw new BridgeError("Invalid bridge endpoint")
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    const controller = new AbortController()
    let buffer = ""
    let bytes = 0
    let received = false
    socket.setEncoding("utf8")
    socket.setTimeout(2000, () => socket.destroy())
    socket.on("error", () => {})
    socket.on("close", () => {
      sockets.delete(socket)
      controller.abort()
    })
    socket.on("end", () => controller.abort())
    const reply = (value: unknown) => {
      if (!socket.destroyed) socket.end(`${redact(JSON.stringify(value), state.token)}\n`)
    }
    socket.on("data", (chunk: string) => {
      if (received) {
        socket.destroy()
        return
      }
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_REQUEST_BYTES) {
        received = true
        reply({ ok: false, error: "Request is too large", exitCode: 1 })
        return
      }
      buffer += chunk
      const end = buffer.indexOf("\n")
      if (end < 0) return
      received = true
      let request: JsonObject
      try {
        request = object(JSON.parse(buffer.slice(0, end)))
      } catch {
        reply({ ok: false, error: "Invalid request JSON", exitCode: 1 })
        return
      }
      if (!authenticated(request.token, state.token)) {
        reply({ ok: false, error: "Authentication failed", exitCode: 1 })
        return
      }
      if (buffer.slice(end + 1).trim() || typeof request.op !== "string") {
        reply({ ok: false, error: "Send one operation per connection", exitCode: 1 })
        return
      }
      socket.setTimeout(0)
      const { token: _token, ...call } = request
      void handle(call as ClientCall, controller.signal).then(
        (result) => reply({ ok: true, result }),
        (error: unknown) =>
          reply({
            ok: false,
            error: errorMessage(error),
            exitCode: error instanceof BridgeError ? error.exitCode : 1,
            code: error instanceof BridgeError ? error.code : "error",
          }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(state.endpoint, () => {
      server.off("error", reject)
      resolve()
    })
  })
  server.on("error", () => {})
  if (process.platform !== "win32") privateMode(state.endpoint, 0o600)
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, 1500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      return closing
    },
  }
}

export async function callLocal(
  home: string,
  state: BridgeState,
  call: ClientCall,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JsonObject> {
  if (state.endpoint !== endpointFor(home, state.id)) throw new BridgeError("Invalid bridge endpoint")
  if (["exited", "failed"].includes(state.status)) {
    throw new BridgeError(
      `Bridge ${state.id} is not running${state.error ? `: ${state.error}` : ""}`,
      3,
      "not_running",
    )
  }
  return new Promise((resolve, reject) => {
    let buffer = ""
    let bytes = 0
    let finished = false
    const socket = createConnection(state.endpoint)
    const timer = setTimeout(
      () => finish(new BridgeError("Bridge call timed out")),
      options.timeoutMs ?? 35_000,
    )
    const abort = () => finish(new BridgeError("Bridge call cancelled"))
    function finish(error?: Error, result?: JsonObject) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result ?? {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      const line = `${JSON.stringify({ ...call, token: state.token })}\n`
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
        finish(new BridgeError("Request is too large"))
        return
      }
      socket.write(line)
    })
    socket.on("error", (error) =>
      finish(
        new BridgeError(
          `Bridge ${state.id} is not reachable: ${redact(error.message, state.token)}`,
          3,
          "not_running",
        ),
      ),
    )
    socket.on("close", () =>
      finish(new BridgeError(`Bridge ${state.id} closed the connection`, 3, "not_running")),
    )
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new BridgeError("Bridge response is too large; read a narrower cursor range"))
        return
      }
      buffer += chunk
      const end = buffer.indexOf("\n")
      if (end < 0) return
      try {
        const response = object(JSON.parse(buffer.slice(0, end)))
        if (response.ok !== true) {
          const exitCode = response.exitCode === 2 || response.exitCode === 3 ? response.exitCode : 1
          finish(
            new BridgeError(
              typeof response.error === "string" ? response.error : "Bridge call failed",
              exitCode,
              typeof response.code === "string" ? response.code : "error",
            ),
          )
        } else {
          finish(undefined, object(response.result))
        }
      } catch {
        finish(new BridgeError("Invalid bridge response"))
      }
    })
  })
}
