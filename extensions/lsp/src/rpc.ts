/**
 * The LSP base protocol: JSON-RPC 2.0 messages, each preceded by a `Content-Length` header
 * that counts UTF-8 bytes.
 */

export interface RpcMessage {
  jsonrpc?: "2.0"
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const HEADER_END = Buffer.from("\r\n\r\n")
/** Headers longer than this without an end are not LSP; the buffer is dropped. */
const MAX_HEADER = 8192

export function encodeMessage(message: RpcMessage): string {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message })
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
}

/**
 * Splits a server's stdout into messages. Chunks arrive as text decoded from UTF-8 (a
 * character is never split between chunks), so they are turned back into bytes to count.
 */
export class MessageReader {
  #buffer: Buffer = Buffer.alloc(0)
  /** Chunks after #buffer, joined only once a whole message may be there (#need bytes). */
  #chunks: Buffer[] = []
  #length = 0
  #need = 0

  constructor(
    private readonly onMessage: (message: RpcMessage) => void,
    /** Output that is not protocol traffic (e.g. a server logging to stdout). */
    private readonly onNoise: (text: string) => void = () => {},
  ) {}

  push(chunk: string): void {
    const bytes = Buffer.from(chunk, "utf8")
    this.#chunks.push(bytes)
    this.#length += bytes.length
    // A long message arrives in many chunks: copy them together once, not once per chunk.
    if (this.#length < this.#need) return
    this.#buffer = Buffer.concat([this.#buffer, ...this.#chunks], this.#length)
    this.#chunks = []
    this.#need = 0
    this.#parse()
  }

  #parse(): void {
    for (;;) {
      this.#length = this.#buffer.length
      const end = this.#buffer.indexOf(HEADER_END)
      if (end < 0) {
        if (this.#buffer.length > MAX_HEADER) this.#drop()
        return
      }
      const header = this.#buffer.subarray(0, end).toString("ascii")
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Not a header: skip to after the blank line and try again.
        this.onNoise(header)
        this.#buffer = this.#buffer.subarray(end + HEADER_END.length)
        continue
      }
      const start = end + HEADER_END.length
      const length = Number(match[1])
      if (this.#buffer.length < start + length) {
        this.#need = start + length
        return
      }
      const body = this.#buffer.subarray(start, start + length).toString("utf8")
      this.#buffer = this.#buffer.subarray(start + length)
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        this.onNoise(body)
        continue
      }
      if (message && typeof message === "object") this.onMessage(message as RpcMessage)
    }
  }

  #drop() {
    this.onNoise(this.#buffer.toString("utf8"))
    this.#buffer = Buffer.alloc(0)
    this.#length = 0
  }
}
