import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OpenPipeOptions, PackageCommandContext } from "@amira/api"
import { BridgeDaemon, type DaemonOptions } from "../src/daemon.ts"
import { type PipeFactory, RpcClient } from "../src/rpc.ts"
import { createState, type JsonObject, type LaunchOptions, object } from "../src/storage.ts"

export function sandbox() {
  // Keep Unix socket paths short, and never use the real Amira home or project settings.
  const root = mkdtempSync(path.join(os.tmpdir(), "ab-"))
  const home = path.join(root, "h")
  const cwd = path.join(root, "w")
  mkdirSync(home)
  mkdirSync(cwd)
  return { root, home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) }
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

// Bun's .rejects matcher can synchronously pump the event loop. Register a
// normal continuation when the test itself still needs to trigger the rejection.
export function captureRejection(promise: Promise<unknown>, message: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected rejection containing: ${message}`)
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(message)
    },
  )
}

export const signal = () => new AbortController().signal
export const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

/** A fake stdio child, not a fake daemon: exercises the production JSONL adapter too. */
export class FakeChild {
  options?: OpenPipeOptions
  argv: string[] = []
  requests: JsonObject[] = []
  closed: number[] = []
  held = new Set<string>()
  autoStart = true
  exitOnClose = true
  ended = false
  busy = false
  sessionId = "s_root"
  turnId = "t_1"
  model = "mock/m"
  messages: unknown[] = []
  lastTurn: JsonObject = { messages: [] }
  uiRequests = new Map<string, JsonObject>()
  onRequest?: (request: JsonObject) => boolean
  private sequence = 100

  readonly factory: PipeFactory = (argv, options) => {
    if (!options.env?.AMIRA_HOME) throw new Error("Fake child requires an explicit temporary AMIRA_HOME")
    this.argv = argv
    this.options = options
    if (this.autoStart) queueMicrotask(() => this.startSession())
    return {
      write: (line) => {
        const request = object(JSON.parse(line))
        this.requests.push(request)
        if (this.held.has(String(request.cmd)) || this.onRequest?.(request)) return
        this.answer(request)
      },
      close: (grace) => {
        this.closed.push(grace)
        if (this.exitOnClose) this.exit(0)
      },
    }
  }

  startSession() {
    this.options?.onEvent({ type: "spawned", pid: 12345 })
    this.emit("session.start", { reason: "startup", model: { provider: "mock", model: "m" } })
  }

  stdout(data: string) {
    this.options?.onEvent({ type: "stdout", data })
  }

  stderr(data: string) {
    this.options?.onEvent({ type: "stderr", data })
  }

  reply(request: JsonObject, result: JsonObject = {}) {
    this.stdout(`${JSON.stringify({ id: request.id, ok: true, ...result })}\r\n`)
  }

  error(request: JsonObject, code: string, message: string) {
    this.stdout(`${JSON.stringify({ id: request.id, ok: false, error: { code, message } })}\n`)
  }

  emit(type: string, data: JsonObject = {}, sessionId = this.sessionId) {
    if (sessionId === this.sessionId) {
      if (type === "turn.start") this.busy = true
      if (type === "turn.end") this.busy = false
      if (type === "message.end") this.messages.push(data.message)
    }
    if (type === "ui.request") this.uiRequests.set(String(data.requestId), data)
    if (type === "ui.resolved") this.uiRequests.delete(String(data.requestId))
    this.stdout(
      `${JSON.stringify({
        seq: ++this.sequence,
        ts: Date.now(),
        sessionId,
        turnId: this.turnId,
        type,
        data,
      })}\n`,
    )
  }

  exit(code: number, error?: string) {
    if (this.ended) return
    this.ended = true
    this.options?.onEvent({ type: "exit", code, ...(error ? { error } : {}) })
  }

  private answer(request: JsonObject) {
    switch (request.cmd) {
      case "state":
        this.reply(request, {
          sessionId: this.sessionId,
          model: this.model,
          busy: this.busy,
          status: this.busy ? "working" : "idle",
          uiRequests: [...this.uiRequests.values()],
        })
        break
      case "session.read":
        this.reply(request, request.what === "lastTurn" ? this.lastTurn : { messages: this.messages })
        break
      case "session.rename":
        this.reply(request, { sessionId: this.sessionId, title: request.title })
        break
      case "prompt":
      case "steer": {
        if (request.cmd === "prompt" && this.busy) {
          this.error(request, "busy", "a turn is in progress")
          break
        }
        const queued = this.busy
        this.reply(request, { turnId: this.turnId, ...(request.cmd === "steer" ? { queued } : {}) })
        if (!queued) this.emit("turn.start")
        else this.emit("turn.steer", { state: "queued" })
        break
      }
      case "ui.respond": {
        const id = String(request.requestId)
        if (!this.uiRequests.has(id)) this.error(request, "not_found", "No such request")
        else if (request.value !== null && typeof request.value !== "boolean") {
          this.error(request, "invalid_params", "Expected a boolean or null")
        } else {
          this.emit("ui.resolved", { requestId: id, cancelled: request.value === null }, "host")
          this.reply(request)
        }
        break
      }
      case "abort":
        this.reply(request, { aborted: this.busy })
        if (this.busy) this.emit("turn.end", { reason: "aborted" })
        break
      default:
        this.error(request, "unknown_command", `Unknown command ${String(request.cmd)}`)
    }
  }
}

export function harness(launch: Partial<LaunchOptions> = {}, options: Partial<DaemonOptions> = {}) {
  const files = sandbox()
  const child = new FakeChild()
  const state = createState(files.home, {
    cwd: files.cwd,
    mode: "default",
    idleMinutes: 30,
    requestTimeoutMinutes: 30,
    ...launch,
  })
  let now = 1_700_000_000_000
  const daemon = new BridgeDaemon({
    home: files.home,
    state,
    amiraArgv: ["fake-amira"],
    rpc: new RpcClient(child.factory),
    probe: async () => ({ kind: "alive", identity: "test-birth" }),
    now: () => now,
    tickMs: 3_600_000,
    startupTimeoutMs: 1000,
    ...options,
  })
  return {
    ...files,
    child,
    state,
    daemon,
    advance: (ms: number) => {
      now += ms
    },
    call: (op: string, params: JsonObject = {}) => daemon.handle({ op, ...params }, signal()),
    async cleanup() {
      try {
        if (!["failed", "exited"].includes(state.status)) await daemon.stop("test cleanup")
        await daemon.done
      } finally {
        files.cleanup()
      }
    },
  }
}

export function commandContext(files: { home: string; cwd: string }, argv: string[], input = "") {
  let out = ""
  let err = ""
  const ctx: PackageCommandContext = {
    apiVersion: "0.1.27",
    argv,
    ...files,
    amiraArgv: ["fake-amira"],
    runCommand: async () => {
      throw new Error("Unexpected real process in unit test")
    },
    stdin: new Response(input).body!,
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
  }
  return { ctx, output: () => out, errors: () => err }
}

export async function eventually(check: () => boolean, message: string, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${message}`)
    await Bun.sleep(5)
  }
}
