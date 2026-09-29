import { readFileSync } from "node:fs"
import { type Diagnostic, LspClient, type OpenPipe } from "./client.ts"
import {
  findCommand,
  findRoot,
  isFile,
  languageIdFor,
  type ServerSpec,
  serverFor,
  type Which,
} from "./servers.ts"
import type { LspSettings } from "./settings.ts"
import { findTsc, type RunCommand, runTsc } from "./tsc.ts"
import { fileKey } from "./uri.ts"

export interface ManagerDeps {
  openPipe: OpenPipe
  runCommand: RunCommand
  which: Which
  /** A server failed to start or kept crashing: tell the user (once per server and folder). */
  reportError(message: string): void
  /** Something /lsp or the status bar shows changed. */
  onChange(): void
}

/** What checking one file found. */
export interface FileCheck {
  file: string
  /** The server id, or "tsc" for the fallback. */
  source: string
  diagnostics: Diagnostic[]
  /** False when the server did not answer in time (the diagnostics may be old, or none). */
  fresh: boolean
  /** Why the file could not be checked, when that is known (e.g. tsc: not in the project). */
  note?: string
}

interface Entry {
  spec: ServerSpec
  root: string
  client: LspClient
  /** Checks since it started; the first waits longer while the server loads the project. */
  checks: number
}

/** Crashes after which a server is left stopped until /lsp restart. */
const MAX_CRASHES = 3
/** The first check of a new server waits this many times `waitMs` (projects load first). */
const FIRST_CHECK_FACTOR = 4

/**
 * The longest one check may take: a server started and waited for (its first check waits
 * longest), or tsc, whichever is longer. Checks keep to it, so an interceptor given this
 * (plus a margin) never times out on one.
 */
export function checkBudgetMs(
  settings: Pick<LspSettings, "startupTimeoutMs" | "waitMs" | "tscTimeoutMs">,
  waitMs = settings.waitMs,
): number {
  return Math.max(settings.startupTimeoutMs + waitMs * FIRST_CHECK_FACTOR, settings.tscTimeoutMs)
}

/** Starts language servers when files of theirs are checked, one per server and root, and keeps them. */
export class ServerManager {
  readonly #settings: LspSettings
  readonly #deps: ManagerDeps
  #entries = new Map<string, Entry>()
  /** Commands found per server id (undefined: not installed); looked up once until restart. */
  #commands = new Map<string, string[] | undefined>()
  #tsc = new Map<string, string | undefined>()
  /** Servers (and folders) that failed to start: not tried again until restart. */
  #failed = new Map<string, string>()

  constructor(settings: LspSettings, deps: ManagerDeps) {
    this.#settings = settings
    this.#deps = deps
  }

  specFor(file: string): ServerSpec | undefined {
    return serverFor(this.#settings.servers, file)
  }

  /**
   * Checks files after they changed on disk: syncs them (and other open files that changed
   * meanwhile) to their servers and collects the diagnostics, all files at once. Files no
   * server covers are left out.
   */
  async check(
    files: string[],
    cwd: string,
    signal: AbortSignal,
    waitMs = this.#settings.waitMs,
  ): Promise<FileCheck[]> {
    const bySpec = new Map<ServerSpec, string[]>()
    for (const file of files) {
      const spec = this.specFor(file)
      if (spec) bySpec.set(spec, [...(bySpec.get(spec) ?? []), file])
    }
    // One time limit for the whole check: starting, asking and waiting (or tsc) all count.
    const started = Date.now()
    const limits = {
      server: started + this.#settings.startupTimeoutMs + waitMs * FIRST_CHECK_FACTOR,
      tsc: started + this.#settings.tscTimeoutMs,
    }
    const parts = await Promise.all(
      [...bySpec].map(([spec, list]) => this.#checkSpec(spec, list, cwd, signal, waitMs, limits)),
    )
    return parts.flat()
  }

  async #checkSpec(
    spec: ServerSpec,
    files: string[],
    cwd: string,
    signal: AbortSignal,
    waitMs: number,
    limits: { server: number; tsc: number },
  ): Promise<FileCheck[]> {
    const command = this.#command(spec)
    if (!command) {
      if (!spec.tscFallback) return []
      return this.#checkWithTsc(files, cwd, signal, limits.tsc)
    }
    const byRoot = new Map<string, string[]>()
    for (const file of files) {
      const root = findRoot(file, cwd, spec.rootMarkers)
      byRoot.set(root, [...(byRoot.get(root) ?? []), file])
    }
    const parts = await Promise.all(
      [...byRoot].map(async ([root, list]) => {
        const entry = await this.#client(spec, command, root)
        if (!entry || signal.aborted) return []
        return this.#checkWith(entry, list, signal, waitMs, limits.server)
      }),
    )
    return parts.flat()
  }

  async #checkWith(
    entry: Entry,
    files: string[],
    signal: AbortSignal,
    waitMs: number,
    deadline: number,
  ): Promise<FileCheck[]> {
    const { client, spec } = entry
    const wanted = new Set(files.map((f) => fileKey(f)))
    // Files opened earlier may have changed on disk since (other tools, the user): resend them,
    // so the server does not judge the files checked now against old text.
    for (const open of client.openFiles()) {
      if (wanted.has(fileKey(open))) continue
      const text = readText(open)
      if (text === undefined) client.closeFile(open)
      else client.sync(open, text, languageIdFor(spec, open))
    }
    const present: string[] = []
    for (const file of files) {
      const text = readText(file)
      if (text === undefined) {
        client.closeFile(file)
        continue
      }
      client.sync(file, text, languageIdFor(spec, file))
      present.push(file)
    }
    const wait = entry.checks++ === 0 ? waitMs * FIRST_CHECK_FACTOR : waitMs
    const results = await Promise.all(
      present.map((file) =>
        client.diagnostics(file, {
          waitMs: wait,
          deadline,
          signal,
          ...(spec.settleMs !== undefined ? { settleMs: spec.settleMs } : {}),
        }),
      ),
    )
    return present.map((file, i) => ({
      file,
      source: spec.id,
      diagnostics: results[i]!.diagnostics,
      fresh: results[i]!.fresh,
    }))
  }

  async #checkWithTsc(
    files: string[],
    cwd: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<FileCheck[]> {
    // Declaration files and JavaScript are left to a real server.
    const ts = files.filter((f) => /\.(ts|tsx|mts|cts)$/i.test(f) && !/\.d\.[mc]?ts$/i.test(f) && isFile(f))
    if (!ts.length) return []
    const tsc = this.#findTsc(cwd)
    if (!tsc) return []
    const run = await runTsc([tsc], ts, cwd, this.#deps.runCommand, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
    })
    if (run.error) {
      if (run.error !== "aborted") this.#reportOnce(`tsc:${cwd}`, `lsp: ${run.error}`)
      return ts.map((file) => ({ file, source: "tsc", diagnostics: [], fresh: false }))
    }
    return ts.map((file): FileCheck => {
      const key = fileKey(file)
      const note = run.notChecked.get(key)
      if (note !== undefined) return { file, source: "tsc", diagnostics: [], fresh: false, note }
      return { file, source: "tsc", diagnostics: run.byFile.get(key) ?? [], fresh: run.byFile.has(key) }
    })
  }

  #findTsc(cwd: string): string | undefined {
    const key = fileKey(cwd)
    if (!this.#tsc.has(key)) this.#tsc.set(key, findTsc(cwd, this.#deps.which))
    return this.#tsc.get(key)
  }

  #command(spec: ServerSpec): string[] | undefined {
    if (!this.#commands.has(spec.id)) this.#commands.set(spec.id, findCommand(spec, this.#deps.which))
    return this.#commands.get(spec.id)
  }

  async #client(spec: ServerSpec, command: string[], root: string): Promise<Entry | undefined> {
    const key = `${spec.id}\0${fileKey(root)}`
    if (this.#failed.has(key)) return undefined
    let entry = this.#entries.get(key)
    if (!entry) {
      const client = new LspClient({
        argv: command,
        root,
        openPipe: this.#deps.openPipe,
        startupTimeoutMs: this.#settings.startupTimeoutMs,
        ...(spec.initializationOptions !== undefined
          ? { initializationOptions: spec.initializationOptions }
          : {}),
        ...(spec.settings ? { settings: spec.settings } : {}),
        onExit: (reason) => this.#onCrash(key, client, spec, root, reason),
        killProcess: (pid) => this.#killTree(pid, root),
      })
      entry = { spec, root, client, checks: 0 }
      this.#entries.set(key, entry)
      this.#deps.onChange()
    }
    try {
      await entry.client.start()
      return entry
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (this.#entries.get(key) === entry) {
        this.#entries.delete(key)
        this.#failed.set(key, reason)
        this.#reportOnce(key, `lsp: the ${spec.id} server for ${root} failed: ${reason}`)
        this.#deps.onChange()
      }
      return undefined
    }
  }

  /** Ends a server process and what it started (a `.cmd` launcher's node, say). */
  #killTree(pid: number, cwd: string) {
    if (process.platform !== "win32") {
      process.kill(pid, "SIGKILL")
      return
    }
    const argv = ["taskkill", "/PID", String(pid), "/T", "/F"]
    this.#deps
      .runCommand(argv, { cwd, timeoutMs: 10_000, signal: new AbortController().signal })
      .catch(() => {})
  }

  #crashes = new Map<string, number>()

  #onCrash(key: string, client: LspClient, spec: ServerSpec, root: string, reason: string) {
    // A server replaced meanwhile (stopped, then started again) is not this one's to remove.
    if (this.#entries.get(key)?.client !== client) return
    this.#entries.delete(key)
    const crashes = (this.#crashes.get(key) ?? 0) + 1
    this.#crashes.set(key, crashes)
    // Started again at the next check, unless it keeps crashing.
    if (crashes >= MAX_CRASHES) {
      this.#failed.set(key, `crashed ${crashes} times: ${reason}`)
      this.#reportOnce(
        key,
        `lsp: the ${spec.id} server for ${root} crashed ${crashes} times; last: ${reason}`,
      )
    }
    this.#deps.onChange()
  }

  #reported = new Set<string>()

  #reportOnce(key: string, message: string) {
    if (this.#reported.has(key)) return
    this.#reported.add(key)
    this.#deps.reportError(message)
  }

  /** Every server this manager knows of, for /lsp. */
  describe(): ServerDescription[] {
    const out: ServerDescription[] = []
    for (const spec of this.#settings.servers) {
      const running = [...this.#entries.values()].filter((e) => e.spec === spec)
      const failed = [...this.#failed]
        .filter(([k]) => k.startsWith(`${spec.id}\0`))
        .map(([, reason]) => reason)
      const command = this.#commands.has(spec.id)
        ? this.#commands.get(spec.id)
        : findCommand(spec, this.#deps.which)
      out.push({
        id: spec.id,
        extensions: spec.extensions,
        command,
        fallback: !command && spec.tscFallback ? "tsc --noEmit" : undefined,
        running: running.map((e) => ({
          root: e.root,
          state: e.client.state,
          program: e.client.argv[0] ?? "",
          files: e.client.openFiles().length,
          ...(e.client.serverInfo ? { serverInfo: e.client.serverInfo } : {}),
        })),
        failed,
      })
    }
    return out
  }

  /** Servers running now. */
  get running(): number {
    return this.#entries.size
  }

  /** Stops every server and forgets failures and commands found, so the next check starts afresh. */
  async restart(): Promise<void> {
    await this.stopAll()
    this.#commands.clear()
    this.#tsc.clear()
    this.#failed.clear()
    this.#crashes.clear()
    this.#reported.clear()
    this.#deps.onChange()
  }

  /** Stops every server; resolves once they are stopped, including ones a call before began to stop. */
  async stopAll(): Promise<void> {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    for (const e of entries) {
      const closing = e.client.close().catch(() => {})
      this.#closing.add(closing)
      void closing.then(() => this.#closing.delete(closing))
    }
    await Promise.all([...this.#closing])
    this.#deps.onChange()
  }

  #closing = new Set<Promise<void>>()
}

export interface ServerDescription {
  id: string
  extensions: string[]
  /** The command it starts with; undefined when it is not installed. */
  command: string[] | undefined
  fallback: string | undefined
  running: { root: string; state: string; program: string; files: number; serverInfo?: string }[]
  failed: string[]
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}
