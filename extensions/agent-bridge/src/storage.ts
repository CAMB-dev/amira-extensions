import { randomBytes, randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { hostRunCommand, type PackageCommandContext } from "@amira/api"

export type JsonObject = Record<string, unknown>
export type BridgeStatus = "starting" | "running" | "idle" | "stopping" | "exited" | "failed"
export type Mode = "default" | "edits" | "auto" | "plan"
export interface BridgeSettings {
  idleMinutes: number
  requestTimeoutMinutes: number
}
export interface LaunchOptions extends BridgeSettings {
  cwd: string
  model?: string
  mode: Mode
  resume?: string
  name?: string
}
export interface BridgeState {
  id: string
  pid: number
  processStart: string | null
  endpoint: string
  token: string
  sessionId: string | null
  cwd: string
  model: string | null
  startedAt: string
  status: BridgeStatus
  name?: string
  error?: string
  launch: LaunchOptions
}
export interface BridgeEvent {
  seq: number
  ts: number
  type: string
  data: JsonObject
  sessionId?: string
  turnId?: string
  /** Original RPC event, including its independent sequence and unknown fields. */
  event?: JsonObject
}
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 = 1,
    readonly code = "error",
  ) {
    super(message)
    this.name = "BridgeError"
  }
}
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new BridgeError("Invalid bridge ID")
}
export function agentsDir(home: string): string {
  return path.join(home, "agents")
}
export function agentPath(home: string, id: string, suffix = ".json"): string {
  validateId(id)
  return path.join(agentsDir(home), `${id}${suffix}`)
}
export function endpointFor(home: string, id: string, platform = process.platform): string {
  validateId(id)
  return platform === "win32" ? `\\\\.\\pipe\\amira-agent-${id}` : agentPath(path.resolve(home), id, ".sock")
}
export function privateMode(file: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(file, mode)
}
export function ensureStore(home: string): void {
  const dir = agentsDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (lstatSync(dir).isSymbolicLink()) throw new BridgeError("The agents directory must not be a symlink")
  privateMode(dir, 0o700)
}
/** Establish Windows inheritance before creating any production credential file. */
export async function secureStore(home: string, run: PackageCommandContext["runCommand"]): Promise<void> {
  ensureStore(home)
  if (process.platform !== "win32") return
  const dir = agentsDir(home).replaceAll("'", "''")
  const script =
    `$ErrorActionPreference = 'Stop'; $dir = '${dir}'; ` +
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl = [System.Security.AccessControl.DirectorySecurity]::new(); " +
    "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); " +
    "$acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($dir, $acl)"
  const result = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: home,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  })
  if (result.exitCode !== 0)
    throw new BridgeError(
      `Cannot secure the agents directory; check Windows file permissions: ${result.output.trim()}`,
    )
}
export function readState(home: string, id: string): BridgeState {
  const file = agentPath(home, id)
  if (!existsSync(file)) throw new BridgeError(`Bridge ${id} not found`, 3, "not_found")
  if (lstatSync(file).isSymbolicLink()) throw new BridgeError("Bridge state must not be a symlink")
  const state = JSON.parse(readFileSync(file, "utf8")) as BridgeState
  if (
    state.id !== id ||
    state.endpoint !== endpointFor(home, id) ||
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token) ||
    !Number.isSafeInteger(state.pid) ||
    state.pid < 0 ||
    !(state.processStart === null || typeof state.processStart === "string")
  ) {
    throw new BridgeError(`Invalid state for bridge ${id}`)
  }
  return state
}
export function writeState(home: string, state: BridgeState): void {
  ensureStore(home)
  const file = agentPath(home, state.id)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
    privateMode(file, 0o600)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
export function createState(home: string, launch: LaunchOptions): BridgeState {
  const id = randomUUID()
  const state: BridgeState = {
    id,
    pid: 0,
    processStart: null,
    endpoint: endpointFor(home, id),
    token: randomBytes(32).toString("hex"),
    sessionId: null,
    cwd: launch.cwd,
    model: launch.model ?? null,
    startedAt: new Date().toISOString(),
    status: "starting",
    ...(launch.name ? { name: launch.name } : {}),
    launch,
  }
  writeState(home, state)
  return state
}
/** Never serialize state directly to a client: it holds the authentication secret. */
export function publicState(state: BridgeState): Omit<BridgeState, "token" | "launch"> {
  const { token, launch: _launch, ...visible } = state
  return JSON.parse(redact(JSON.stringify(visible), token)) as Omit<BridgeState, "token" | "launch">
}
export function redact(text: string, token: string): string {
  return text.replaceAll(token, "[redacted]")
}
export function removeEndpoint(home: string, state: BridgeState): void {
  if (state.endpoint !== endpointFor(home, state.id)) throw new BridgeError("Invalid bridge endpoint")
  if (process.platform !== "win32" && existsSync(state.endpoint)) unlinkSync(state.endpoint)
}

export function loadSettings(home: string, cwd: string, idle?: number): BridgeSettings {
  const settings: BridgeSettings = { idleMinutes: 30, requestTimeoutMinutes: 30 }
  for (const file of [
    path.join(home, "settings.json"),
    path.join(cwd, ".amira", "settings.json"),
    path.join(cwd, ".amira", "settings.local.json"),
  ]) {
    if (!existsSync(file)) continue
    const root = object(JSON.parse(readFileSync(file, "utf8")))
    const section = object(object(root.extensions)["agent-bridge"])
    for (const key of ["idleMinutes", "requestTimeoutMinutes"] as const) {
      const value = section[key]
      if (value === undefined) continue
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new BridgeError(`${file}: agent-bridge.${key} must be a positive number of minutes`)
      }
      settings[key] = value
    }
  }
  if (idle !== undefined) {
    if (!Number.isFinite(idle) || idle <= 0) throw new BridgeError("--idle must be positive minutes")
    settings.idleMinutes = idle
  }
  return settings
}

export type IdentityResult = { kind: "alive"; identity: string } | { kind: "dead" | "unknown" }
export type IdentityProbe = (pid: number) => Promise<IdentityResult>
/** A process birth identity, not a state-file timestamp. Unknown never authorizes a kill. */
export async function processIdentity(
  pid: number,
  run: (
    argv: string[],
    options: Parameters<PackageCommandContext["runCommand"]>[1],
  ) => Promise<{ output: string; exitCode: number | null }> = hostRunCommand,
): Promise<IdentityResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "dead" }
  try {
    process.kill(pid, 0)
  } catch (error) {
    return { kind: object(error).code === "ESRCH" ? "dead" : "unknown" }
  }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      return ticks ? { kind: "alive", identity: `linux:${boot}:${ticks}` } : { kind: "unknown" }
    }
    const argv =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`,
          ]
        : ["ps", "-p", String(pid), "-o", "lstart="]
    const result = await run(argv, {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      stdoutOnly: true,
    })
    const birth = result.output.trim()
    return result.exitCode === 0 && birth
      ? { kind: "alive", identity: `${process.platform}:${birth}` }
      : { kind: "unknown" }
  } catch {
    return { kind: "unknown" }
  }
}
export async function listStates(
  home: string,
  probe: IdentityProbe = processIdentity,
): Promise<Array<ReturnType<typeof publicState> & { identityStatus: string }>> {
  if (!existsSync(agentsDir(home))) return []
  const result = []
  for (const name of readdirSync(agentsDir(home))) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue
    const state = readState(home, name.slice(0, -5))
    const identity = await probe(state.pid)
    const mismatch =
      identity.kind === "alive" && state.processStart !== null && identity.identity !== state.processStart
    // A start command has not handed the PID over yet; allow its bounded startup window.
    const starting = state.pid === 0 && Date.now() - Date.parse(state.startedAt) < 60_000
    if (!starting && (identity.kind === "dead" || mismatch) && !["exited", "failed"].includes(state.status)) {
      state.status = "exited"
      state.error = mismatch
        ? "Process ID was reused; stale bridge pruned"
        : "Bridge process is no longer running"
      writeState(home, state)
      removeEndpoint(home, state)
    }
    result.push({ ...publicState(state), identityStatus: mismatch ? "mismatch" : identity.kind })
  }
  return result
}

/** Each daemon owns one journal. Append to disk before exposing a cursor to clients. */
export class EventJournal {
  readonly events: BridgeEvent[] = []
  private sequence = 0
  private readonly file: string

  constructor(home: string, id: string) {
    ensureStore(home)
    this.file = agentPath(home, id, ".events.jsonl")
    if (existsSync(this.file)) {
      if (lstatSync(this.file).isSymbolicLink()) throw new BridgeError("Event log must not be a symlink")
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue
        const event = JSON.parse(line) as BridgeEvent
        if (!Number.isSafeInteger(event.seq) || event.seq <= this.sequence)
          throw new BridgeError("Invalid event cursor in journal")
        this.events.push(event)
        this.sequence = event.seq
      }
    }
  }

  get cursor(): number {
    return this.sequence
  }

  append(type: string, data: JsonObject = {}, rpc?: JsonObject): BridgeEvent {
    const event: BridgeEvent = {
      seq: this.sequence + 1,
      ts: Date.now(),
      type,
      data,
      ...(typeof rpc?.sessionId === "string" ? { sessionId: rpc.sessionId } : {}),
      ...(typeof rpc?.turnId === "string" ? { turnId: rpc.turnId } : {}),
      ...(rpc ? { event: rpc } : {}),
    }
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    privateMode(this.file, 0o600)
    this.events.push(event)
    this.sequence = event.seq
    return event
  }

  read(since = 0): { events: BridgeEvent[]; cursor: number } {
    return { events: this.events.filter((event) => event.seq > since), cursor: this.sequence }
  }
}
