/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, the lifecycle
 * (initialize, ping) and tools (list, call, cancellation). Nothing else of MCP is needed
 * to offer a few tools to another agent.
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>
}

export interface ToolOutcome {
  text: string
  isError?: boolean
  structured?: Record<string, unknown>
}

export interface ServerOptions {
  name: string
  version: string
  tools: McpTool[]
  /** Lines from the client. */
  input: ReadableStream<Uint8Array>
  /** Writes one line to the client. */
  write: (line: string) => void
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

type Id = string | number

interface Request {
  jsonrpc: "2.0"
  id?: Id
  method?: string
  params?: any
}

/** Serves until the client closes stdin; calls still running then are cancelled. */
export async function serve(opts: ServerOptions): Promise<void> {
  const running = new Map<Id, AbortController>()
  const inFlight = new Set<Promise<void>>()
  const send = (msg: unknown) => opts.write(JSON.stringify(msg))
  const reply = (id: Id, result: unknown) => send({ jsonrpc: "2.0", id, result })
  const fail = (id: Id | null, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } })

  const handle = (msg: Request) => {
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && "id" in msg && msg.id !== undefined) fail(msg.id, -32600, "invalid request")
      return
    }
    const { id, method, params } = msg
    if (id === undefined) {
      // Notifications: only cancellation needs an action.
      if (method === "notifications/cancelled") running.get(params?.requestId)?.abort()
      return
    }
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, version: opts.version },
        })
      }
      case "ping":
        return reply(id, {})
      case "tools/list":
        return reply(id, {
          tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        })
      case "tools/call": {
        const tool = opts.tools.find((t) => t.name === params?.name)
        if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`)
        const abort = new AbortController()
        running.set(id, abort)
        const done = tool
          .call(params?.arguments ?? {}, abort.signal)
          .then(
            (r) =>
              reply(id, {
                content: [{ type: "text", text: r.text }],
                ...(r.structured ? { structuredContent: r.structured } : {}),
                isError: !!r.isError,
              }),
            (err) =>
              reply(id, {
                content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
                isError: true,
              }),
          )
          .finally(() => {
            running.delete(id)
            inFlight.delete(done)
          })
        inFlight.add(done)
        return
      }
      default:
        return fail(id, -32601, `method not found: ${method}`)
    }
  }

  const decoder = new TextDecoder()
  let buffer = ""
  const onLine = (line: string) => {
    if (!line.trim()) return
    let msg: Request
    try {
      msg = JSON.parse(line)
    } catch {
      return fail(null, -32700, "parse error")
    }
    // Batches were dropped from MCP in 2025-06-18 but older clients may still send them.
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m)
  }
  for await (const chunk of opts.input) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      onLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
    }
  }
  onLine(buffer + decoder.decode())
  for (const a of running.values()) a.abort()
  await Promise.allSettled([...inFlight])
}
