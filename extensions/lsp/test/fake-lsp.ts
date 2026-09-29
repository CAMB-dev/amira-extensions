/**
 * A tiny language server over stdio for the tests. A line containing `ERROR: text`,
 * `WARN: text` or `INFO: text` is a diagnostic of that severity; a document containing
 * CRASH makes the server exit. Environment:
 *   FAKE_LSP_LOG     file to append every message it gets to, as JSON lines
 *   FAKE_LSP_PULL    "1": answer textDocument/diagnostic instead of publishing
 *   FAKE_LSP_DELAY   ms before publishing (default 20)
 *   FAKE_LSP_SILENT  "1": never publish
 *   FAKE_LSP_URIS    "vscode": publish URIs as file:///c%3A/... (lower-case drive, encoded colon)
 *   FAKE_LSP_STALE   "1": publish the old diagnostics again right after a change, without a version
 *   FAKE_LSP_EXIT_ON_SHUTDOWN "1": exit at shutdown without answering
 *   FAKE_LSP_PASSES  ms: publish in two passes without a version, as typescript-language-server
 *                    does: first without the `TYPE: text` lines (errors), this long after with them
 */
import { appendFileSync } from "node:fs"

const env = process.env
const pull = env.FAKE_LSP_PULL === "1"
const delay = Number(env.FAKE_LSP_DELAY ?? 20)
const docs = new Map<string, { text: string; version: number }>()

function log(entry: unknown) {
  if (env.FAKE_LSP_LOG) appendFileSync(env.FAKE_LSP_LOG, `${JSON.stringify(entry)}\n`)
}

function send(message: Record<string, unknown>) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function diagnosticsOf(text: string, types = true) {
  const out: unknown[] = []
  for (const [line, content] of text.split("\n").entries()) {
    const m = /(ERROR|WARN|INFO|TYPE): (.*)/.exec(content)
    if (!m || (m[1] === "TYPE" && !types)) continue
    const severity = m[1] === "ERROR" || m[1] === "TYPE" ? 1 : m[1] === "WARN" ? 2 : 3
    const start = { line, character: m.index }
    out.push({ range: { start, end: start }, severity, code: "F1", source: "fake", message: m[2] })
  }
  return out
}

function outUri(uri: string) {
  if (env.FAKE_LSP_URIS !== "vscode") return uri
  return uri.replace(/^file:\/\/\/([A-Za-z]):/, (_, d: string) => `file:///${d.toLowerCase()}%3A`)
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
function publishLater(uri: string) {
  if (env.FAKE_LSP_SILENT === "1" || pull) return
  clearTimeout(timers.get(uri))
  timers.set(
    uri,
    setTimeout(() => {
      const doc = docs.get(uri)
      if (!doc) return
      if (env.FAKE_LSP_PASSES) {
        send({
          method: "textDocument/publishDiagnostics",
          params: { uri: outUri(uri), diagnostics: diagnosticsOf(doc.text, false) },
        })
        const text = doc.text
        timers.set(
          uri,
          setTimeout(() => {
            send({
              method: "textDocument/publishDiagnostics",
              params: { uri: outUri(uri), diagnostics: diagnosticsOf(text) },
            })
          }, Number(env.FAKE_LSP_PASSES)),
        )
        return
      }
      send({
        method: "textDocument/publishDiagnostics",
        params: { uri: outUri(uri), version: doc.version, diagnostics: diagnosticsOf(doc.text) },
      })
    }, delay),
  )
}

let nextId = 1000
function onMessage(m: any) {
  log(m)
  if (m.id !== undefined && m.method === undefined) return // an answer to our request
  switch (m.method) {
    case "initialize":
      return send({
        id: m.id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
            ...(pull
              ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
              : {}),
          },
          serverInfo: { name: "fake-lsp", version: "1.0" },
        },
      })
    case "initialized":
      return send({
        id: nextId++,
        method: "workspace/configuration",
        params: { items: [{ section: "fake" }] },
      })
    case "textDocument/didOpen":
    case "textDocument/didChange": {
      const uri = m.params.textDocument.uri
      const text =
        m.method === "textDocument/didOpen" ? m.params.textDocument.text : m.params.contentChanges[0].text
      const before = docs.get(uri)
      docs.set(uri, { text, version: m.params.textDocument.version })
      if (text.includes("CRASH")) process.exit(3)
      if (env.FAKE_LSP_STALE === "1" && before) {
        send({
          method: "textDocument/publishDiagnostics",
          params: { uri: outUri(uri), diagnostics: diagnosticsOf(before.text) },
        })
      }
      return publishLater(uri)
    }
    case "textDocument/diagnostic": {
      const doc = docs.get(m.params.textDocument.uri)
      return send({ id: m.id, result: { kind: "full", items: doc ? diagnosticsOf(doc.text) : [] } })
    }
    case "shutdown":
      if (env.FAKE_LSP_EXIT_ON_SHUTDOWN === "1") process.exit(0)
      return send({ id: m.id, result: null })
    case "exit":
      return process.exit(0)
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no" } })
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    onMessage(JSON.parse(body))
  }
})
process.stdin.on("end", () => process.exit(0))
