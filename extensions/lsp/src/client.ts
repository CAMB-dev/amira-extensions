import type { OpenPipeOptions, PipeProcess } from "@amira/api"
import { encodeMessage, MessageReader, type RpcMessage } from "./rpc.ts"
import { fileKey, pathToUri, uriKey } from "./uri.ts"

/** An LSP diagnostic, as far as this extension reads it. */
export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  /** 1 error, 2 warning, 3 information, 4 hint; unset counts as error. */
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export type OpenPipe = (argv: string[], options: OpenPipeOptions) => PipeProcess

export interface ClientOptions {
  argv: string[]
  /** The workspace folder the server is started for. */
  root: string
  env?: Record<string, string | undefined>
  openPipe: OpenPipe
  initializationOptions?: unknown
  /** Answers workspace/configuration and is sent with didChangeConfiguration. */
  settings?: Record<string, unknown>
  /** How long starting and initializing may take. */
  startupTimeoutMs: number
  /** Output of the server that is not protocol traffic (its stderr, log messages). */
  onLog?: (text: string) => void
  /** The server exited, or broke the protocol, after it had started. */
  onExit?: (reason: string) => void
  /**
   * Ends a server the host lost track of (it may still run). Default: process.kill; the
   * manager passes one that ends the whole process tree.
   */
  killProcess?: (pid: number) => void
}

export type ClientState = "starting" | "ready" | "failed" | "closed"

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  /** The server answered for the file's current text; false when this is older news or nothing. */
  fresh: boolean
}

interface Doc {
  uri: string
  path: string
  languageId: string
  version: number
  text: string
  /** `seq` of the last publish when the text was last sent: newer publishes are about it. */
  sentAt: number
}

interface Published {
  seq: number
  /** When it arrived (Date.now()). */
  at: number
  version?: number
  diagnostics: Diagnostic[]
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | undefined
}

/** How long a server gets to answer shutdown, and to exit after its stdin is closed. */
const SHUTDOWN_MS = 1500
const EXIT_GRACE_MS = 2000
/** How long to wait for more publishes without a version about a file once one arrived. */
export const DEFAULT_SETTLE_MS = 200

/** One language server process, spoken to over stdio. */
export class LspClient {
  state: ClientState = "starting"
  /** Why it failed or closed, for /lsp and error messages. */
  reason: string | undefined
  /** The server's name and version from its initialize answer, when it gives one. */
  serverInfo: string | undefined

  readonly #opts: ClientOptions
  #pipe: PipeProcess | undefined
  #nextId = 1
  #pending = new Map<number, Pending>()
  #docs = new Map<string, Doc>()
  #published = new Map<string, Published>()
  #seq = 0
  #listeners = new Set<(key: string) => void>()
  #capabilities: Record<string, any> = {}
  #started: Promise<void> | undefined
  #stderrTail = ""
  #closing: Promise<void> | undefined
  #pid: number | undefined

  constructor(opts: ClientOptions) {
    this.#opts = opts
  }

  get root(): string {
    return this.#opts.root
  }

  get argv(): string[] {
    return this.#opts.argv
  }

  /** Paths of the files this client has open. */
  openFiles(): string[] {
    return [...this.#docs.values()].map((d) => d.path)
  }

  /** Starts the server and initializes it; later calls wait for the same start. */
  start(): Promise<void> {
    this.#started ??= this.#start().then(
      () => {
        if (this.state === "starting") this.state = "ready"
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        this.#fail(reason)
        throw err instanceof Error ? err : new Error(reason)
      },
    )
    return this.#started
  }

  async #start(): Promise<void> {
    const spawned = Promise.withResolvers<void>()
    const reader = new MessageReader(
      (m) => this.#onMessage(m),
      (text) => this.#log(text),
    )
    this.#pipe = this.#opts.openPipe(this.#opts.argv, {
      cwd: this.#opts.root,
      ...(this.#opts.env ? { env: this.#opts.env } : {}),
      onEvent: (e) => {
        if (e.type === "spawned") {
          this.#pid = e.pid
          spawned.resolve()
        }
        else if (e.type === "stdout") reader.push(e.data)
        else if (e.type === "stderr") {
          this.#stderrTail = (this.#stderrTail + e.data).slice(-2000)
          this.#log(e.data)
        } else {
          const tail = this.#stderrTail.trim()
          const reason =
            e.error ?? `exited with code ${e.code}${tail ? `: ${tail.split("\n").slice(-3).join(" ")}` : ""}`
          spawned.reject(new Error(`could not start ${this.#opts.argv[0]}: ${reason}`))
          // An exit with an error after it started: the host lost the process, which may
          // still run. End it, or it keeps running beside the server started in its place.
          if (e.error && this.#pid !== undefined) this.#kill(this.#pid)
          this.#onExit(reason)
        }
      },
    })
    // One budget for starting and initializing, not one for each.
    const timeout = this.#opts.startupTimeoutMs
    const deadline = Date.now() + timeout
    await withTimeout(spawned.promise, timeout, `${this.#opts.argv[0]} did not start in ${timeout} ms`)
    const root = this.#opts.root
    const init = (await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "amira-lsp" },
        rootPath: root,
        rootUri: pathToUri(root),
        workspaceFolders: [{ uri: pathToUri(root), name: baseName(root) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: true },
        },
        ...(this.#opts.initializationOptions !== undefined
          ? { initializationOptions: this.#opts.initializationOptions }
          : {}),
      },
      Math.max(1, deadline - Date.now()),
    )) as { capabilities?: Record<string, any>; serverInfo?: { name?: string; version?: string } } | null
    this.#capabilities = init?.capabilities ?? {}
    const info = init?.serverInfo
    if (info?.name) this.serverInfo = info.version ? `${info.name} ${info.version}` : info.name
    this.notify("initialized", {})
    if (this.#opts.settings)
      this.notify("workspace/didChangeConfiguration", { settings: this.#opts.settings })
  }

  /** Whether the server answers textDocument/diagnostic (pull diagnostics). */
  get pulls(): boolean {
    return Boolean(this.#capabilities.diagnosticProvider)
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.state === "failed" || this.state === "closed" || !this.#pipe) {
      return Promise.reject(new Error(`the ${this.#opts.argv[0]} server is not running`))
    }
    if (signal?.aborted) return Promise.reject(new Error("aborted"))
    const id = this.#nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const entry: Pending = { resolve, reject, timer: undefined }
    entry.timer = setTimeout(() => {
      this.#pending.delete(id)
      this.notify("$/cancelRequest", { id })
      reject(new Error(`${method} got no answer in ${timeoutMs} ms`))
    }, timeoutMs)
    this.#pending.set(id, entry)
    const onAbort = () => {
      if (!this.#pending.delete(id)) return
      clearTimeout(entry.timer)
      this.notify("$/cancelRequest", { id })
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    this.#pipe.write(encodeMessage({ id, method, params }))
    return promise.finally(() => signal?.removeEventListener("abort", onAbort))
  }

  notify(method: string, params: unknown): void {
    if (this.state === "failed" || this.state === "closed") return
    this.#pipe?.write(encodeMessage({ method, params }))
  }

  /**
   * Tells the server about a file's current text: opens it the first time, sends the whole
   * text again when it changed, and saves it (some servers only check on save). Returns
   * whether anything was sent.
   */
  sync(file: string, text: string, languageId: string): boolean {
    const key = fileKey(file)
    const doc = this.#docs.get(key)
    if (doc && doc.text === text) return false
    const uri = doc?.uri ?? pathToUri(file)
    if (!doc) {
      const next: Doc = { uri, path: file, languageId, version: 1, text, sentAt: this.#seq }
      this.#docs.set(key, next)
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
    } else {
      doc.version++
      doc.text = text
      doc.sentAt = this.#seq
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      })
    }
    const save = this.#capabilities.textDocumentSync?.save
    const includeText = typeof save === "object" && save?.includeText === true
    this.notify("textDocument/didSave", { textDocument: { uri }, ...(includeText ? { text } : {}) })
    return true
  }

  /** Forgets a file (e.g. it was deleted). */
  closeFile(file: string): void {
    const key = fileKey(file)
    const doc = this.#docs.get(key)
    if (!doc) return
    this.#docs.delete(key)
    this.#published.delete(key)
    this.notify("textDocument/didClose", { textDocument: { uri: doc.uri } })
  }

  /**
   * The diagnostics for a file synced before: asked for when the server answers requests for
   * them, otherwise the ones it publishes about the text last sent, waiting up to `waitMs`.
   * A publish that names the version sent (or a later one) is the answer. One without a
   * version may be a first pass (typescript-language-server publishes syntax errors, then
   * type errors): the answer is the last one once `settleMs` passed without another.
   * `deadline` (a Date.now() time) ends the wait earlier than `waitMs` would; asking and then
   * waiting for a publish share the same time.
   */
  async diagnostics(
    file: string,
    opts: { waitMs: number; deadline?: number; settleMs?: number; signal?: AbortSignal },
  ): Promise<DiagnosticsResult> {
    const key = fileKey(file)
    const doc = this.#docs.get(key)
    if (!doc) return { diagnostics: [], fresh: false }
    const deadline = Math.min(Date.now() + opts.waitMs, opts.deadline ?? Number.POSITIVE_INFINITY)
    if (this.pulls) {
      try {
        return { diagnostics: await this.#pull(doc, deadline, opts.signal), fresh: true }
      } catch {
        // Fall back to what the server published, in the time left.
        if (opts.signal?.aborted) return { diagnostics: [], fresh: false }
      }
    }
    return this.#waitForPublish(key, doc, deadline, opts.settleMs ?? DEFAULT_SETTLE_MS, opts.signal)
  }

  async #pull(doc: Doc, deadline: number, signal?: AbortSignal): Promise<Diagnostic[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const report = (await this.request(
          "textDocument/diagnostic",
          { textDocument: { uri: doc.uri } },
          Math.max(1, deadline - Date.now()),
          signal,
        )) as { kind?: string; items?: Diagnostic[] } | null
        if (report?.kind === "full" && Array.isArray(report.items)) return report.items
        // "unchanged" (we send no previous result id, so unusual): the last known ones.
        return this.#published.get(fileKey(doc.path))?.diagnostics ?? []
      } catch (err) {
        // ServerCancelled with retriggerRequest: ask again, once or twice, while time is left.
        const retry = (err as { code?: number }).code === -32802 && attempt < 3 && Date.now() < deadline - 100
        if (!retry) throw err
        await Bun.sleep(100)
      }
    }
  }

  #waitForPublish(
    key: string,
    doc: Doc,
    deadlineAt: number,
    settleMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticsResult> {
    const current = () => {
      const p = this.#published.get(key)
      if (!p || p.seq <= doc.sentAt) return undefined
      // A server that says which version it checked must have checked this one.
      if (p.version !== undefined && p.version < doc.version) return undefined
      return p
    }
    return new Promise((resolve) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      const finish = (fresh: boolean) => {
        clearTimeout(deadline)
        clearTimeout(settle)
        this.#listeners.delete(listener)
        signal?.removeEventListener("abort", onAbort)
        const p = fresh ? current() : this.#published.get(key)
        resolve({ diagnostics: p?.diagnostics ?? [], fresh: fresh && p !== undefined })
      }
      const settled = () => {
        const p = current()
        if (!p) return
        if (p.version !== undefined) return finish(true)
        clearTimeout(settle)
        settle = setTimeout(() => finish(true), Math.max(0, p.at + settleMs - Date.now()))
      }
      const listener = (k: string) => {
        if (k === "*") return finish(false)
        if (k === key) settled()
      }
      const onAbort = () => finish(false)
      const deadline = setTimeout(
        () => finish(current() !== undefined),
        Math.max(0, deadlineAt - Date.now()),
      )
      this.#listeners.add(listener)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) return finish(false)
      if (this.state === "failed" || this.state === "closed") return finish(false)
      // Already answered (e.g. while other files were being synced, or the text is unchanged).
      settled()
    })
  }

  /**
   * Asks the server to shut down, then ends it. Its exiting meanwhile is expected, not a
   * crash: onExit is not called.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return
    const wasReady = this.state === "ready"
    if (wasReady) {
      try {
        await this.request("shutdown", null, SHUTDOWN_MS)
      } catch {}
      this.notify("exit", null)
    }
    this.state = "closed"
    this.reason ??= "stopped"
    this.#pipe?.close(EXIT_GRACE_MS)
    this.#rejectAll("the server was stopped")
    this.#emit("*")
  }

  #onMessage(m: RpcMessage) {
    if (m.method !== undefined && m.id !== undefined && m.id !== null) return this.#answer(m)
    if (m.method !== undefined) return this.#onNotification(m.method, m.params)
    if (typeof m.id !== "number") return
    const pending = this.#pending.get(m.id)
    if (!pending) return
    this.#pending.delete(m.id)
    clearTimeout(pending.timer)
    if (m.error) {
      const err = new Error(m.error.message) as Error & { code?: number }
      err.code = m.error.code
      pending.reject(err)
    } else pending.resolve(m.result ?? null)
  }

  #onNotification(method: string, params: any) {
    if (method === "textDocument/publishDiagnostics") {
      const key = typeof params?.uri === "string" ? uriKey(params.uri) : undefined
      if (!key || !Array.isArray(params.diagnostics)) return
      this.#published.set(key, {
        seq: ++this.#seq,
        at: Date.now(),
        ...(typeof params.version === "number" ? { version: params.version } : {}),
        diagnostics: params.diagnostics,
      })
      this.#emit(key)
    } else if (method === "window/logMessage" || method === "window/showMessage") {
      if (typeof params?.message === "string") this.#log(`${params.message}\n`)
    }
  }

  /** Requests from the server: the few a client must answer, the rest refused. */
  #answer(m: RpcMessage) {
    const reply = (result: unknown) => this.#pipe?.write(encodeMessage({ id: m.id!, result }))
    const params = m.params as any
    switch (m.method) {
      case "workspace/configuration": {
        const items: { section?: string }[] = Array.isArray(params?.items) ? params.items : []
        return reply(items.map((item) => section(this.#opts.settings, item.section)))
      }
      case "workspace/workspaceFolders":
        return reply([{ uri: pathToUri(this.#opts.root), name: baseName(this.#opts.root) }])
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
        return reply(null)
      default:
        this.#pipe?.write(
          encodeMessage({ id: m.id!, error: { code: -32601, message: `${m.method} is not supported` } }),
        )
    }
  }

  #onExit(reason: string) {
    if (this.state === "closed" || this.state === "failed") return
    if (this.#closing) {
      // Stopping anyway: the shutdown request need not wait for an answer that cannot come.
      this.#rejectAll(reason)
      return
    }
    const wasRunning = this.state === "ready"
    this.#fail(reason)
    if (wasRunning) this.#opts.onExit?.(reason)
  }

  #fail(reason: string) {
    if (this.state === "closed") return
    if (this.state !== "failed") {
      this.state = "failed"
      this.reason = reason
      this.#pipe?.close(0)
    }
    this.#rejectAll(reason)
    this.#emit("*")
  }

  #rejectAll(reason: string) {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
      this.#pending.delete(id)
    }
  }

  #kill(pid: number) {
    try {
      if (this.#opts.killProcess) this.#opts.killProcess(pid)
      else process.kill(pid)
    } catch {
      // Gone already.
    }
  }

  #emit(key: string) {
    for (const l of [...this.#listeners]) l(key)
  }

  #log(text: string) {
    this.#opts.onLog?.(text)
  }
}

/** The part of the settings a `workspace/configuration` item asks for ("a.b" walks down). */
function section(settings: Record<string, unknown> | undefined, name: string | undefined): unknown {
  if (!settings) return null
  if (!name) return settings
  let at: unknown = settings
  for (const part of name.split(".")) {
    if (!at || typeof at !== "object" || !(part in at)) return null
    at = (at as Record<string, unknown>)[part]
  }
  return at ?? null
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
