import type { OpenPipeOptions, PipeProcess } from "@amira/api"
import { ownedPipe } from "./owned-pipe.ts"
import { BridgeError, errorMessage, type JsonObject, object } from "./storage.ts"

export type PipeFactory = (argv: string[], options: OpenPipeOptions) => PipeProcess
export interface RpcExit {
  code: number | null
  error?: string
}
export interface RpcConnection {
  readonly stderrTail: string
  readonly alive: boolean
  readonly exited: Promise<RpcExit>
  onEvent: (event: JsonObject) => void
  onExit: (exit: RpcExit) => void
  start(argv: string[], options: Omit<OpenPipeOptions, "onEvent">): void
  call(
    cmd: string,
    params?: JsonObject,
    timeoutMs?: number,
    onResult?: (result: JsonObject) => void,
  ): Promise<JsonObject>
  close(graceMs: number): void
}

/** JSONL RPC, not JSON-RPC 2.0. The child owns all session and turn behavior. */
export class RpcClient implements RpcConnection {
  stderrTail = ""
  alive = false
  pid?: number
  onEvent: (event: JsonObject) => void = () => {}
  onExit: (exit: RpcExit) => void = () => {}
  readonly exited: Promise<RpcExit>
  private resolveExit!: (exit: RpcExit) => void
  private pipe?: PipeProcess
  private buffer = ""
  private nextId = 0
  private ended = false
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonObject) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      onResult?: (result: JsonObject) => void
    }
  >()

  constructor(private readonly factory: PipeFactory = ownedPipe) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  start(argv: string[], options: Omit<OpenPipeOptions, "onEvent">): void {
    if (this.pipe || this.ended) throw new BridgeError("RPC child already started")
    this.alive = true
    try {
      this.pipe = this.factory(argv, {
        ...options,
        onEvent: (event) => {
          if (event.type === "spawned") this.pid = event.pid
          else if (event.type === "stderr") this.stderrTail = (this.stderrTail + event.data).slice(-16_384)
          else if (event.type === "exit") this.finish(event)
          else if (event.type === "stdout") this.consume(event.data)
        },
      })
      if (this.ended) this.pipe.close(0)
    } catch (error) {
      this.finish({ code: null, error: errorMessage(error) })
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    // History responses can be large, but a corrupt child must not grow memory forever.
    if (Buffer.byteLength(this.buffer) > 128 * 1024 * 1024) {
      this.protocolError("RPC line exceeded 128 MiB")
      return
    }
    let end = this.buffer.indexOf("\n")
    while (end >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) {
        try {
          const value = object(JSON.parse(line))
          if (typeof value.id === "number" && typeof value.ok === "boolean") {
            const pending = this.pending.get(value.id)
            if (pending) {
              this.pending.delete(value.id)
              clearTimeout(pending.timer)
              if (value.ok) {
                const { id: _id, ok: _ok, ...result } = value
                try {
                  // Apply snapshots in wire order, before later events in this chunk.
                  pending.onResult?.(result)
                  pending.resolve(result)
                } catch (error) {
                  pending.reject(new BridgeError(errorMessage(error)))
                }
              } else {
                const error = object(value.error)
                const code = typeof error.code === "string" ? error.code : "rpc_error"
                pending.reject(
                  new BridgeError(
                    code === "busy" ? "busy — use steer" : String(error.message ?? "RPC command failed"),
                    1,
                    code,
                  ),
                )
              }
            }
          } else if (typeof value.type === "string") {
            this.onEvent(value)
          } else {
            throw new Error("Expected RPC response or event")
          }
        } catch (error) {
          this.protocolError(`Invalid RPC output: ${errorMessage(error)}`)
          return
        }
      }
      end = this.buffer.indexOf("\n")
    }
  }

  private protocolError(message: string): void {
    this.close(0)
    this.finish({ code: null, error: message })
  }

  private finish(exit: RpcExit): void {
    if (this.ended) return
    this.ended = true
    this.alive = false
    const error = new BridgeError(
      `RPC child exited (${exit.code ?? "unknown"})${exit.error ? `: ${exit.error}` : ""}${this.stderrTail ? `\nRPC stderr:\n${this.stderrTail}` : ""}`,
      1,
      "child_exit",
    )
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.resolveExit(exit)
    this.onExit(exit)
  }

  call(
    cmd: string,
    params: JsonObject = {},
    timeoutMs = 30_000,
    onResult?: (result: JsonObject) => void,
  ): Promise<JsonObject> {
    if (!this.alive || !this.pipe)
      return Promise.reject(new BridgeError("RPC child is not running", 3, "not_running"))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`RPC ${cmd} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, onResult })
      try {
        this.pipe?.write(`${JSON.stringify({ ...params, id, cmd })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close(graceMs: number): void {
    this.pipe?.close(graceMs)
  }
}
