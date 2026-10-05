import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, openSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import type { PackageCommandContext } from "@amira/api"
import { BridgeDaemon, formatRead } from "./daemon.ts"
import {
  agentPath,
  BridgeError,
  createState,
  errorMessage,
  type IdentityProbe,
  type JsonObject,
  type LaunchOptions,
  listStates,
  loadSettings,
  type Mode,
  object,
  privateMode,
  processIdentity,
  readState,
  redact,
  secureStore,
  writeState,
} from "./storage.ts"
import { type ClientCall, callLocal, MAX_REQUEST_BYTES } from "./transport.ts"

export const USAGE = `Usage: amira agent <command> [options]

One detached Amira session, reached through short-lived local CLI calls.
Every command accepts --json. No command prints the authentication token.

  start [--model ref] [--cwd dir] [--mode default|edits|auto|plan]
        [--resume sessionId] [--idle minutes] [--name label]
  send id text|- [--steer]       Start a turn; '-' reads stdin
  steer id text|-                Steer a running turn, or start one when idle
  read id [--since cursor] [--all|--last-turn]
  wait id --until turn-end|reply|request|idle [--since cursor] [--timeout seconds]
  status id                      State, tools, requests, usage and idle countdown
  respond id requestId value-json Answer a request; null cancels
  abort id                       Abort the running turn
  stop id                        Abort and shut down; keep session history
  list                           List bridges and prune stale process identities

Reads default to cursor 0 and do not change a shared read position. Compact reads
show completed assistant messages (not streaming deltas), then 'cursor: n'.
'reply' waits for a completed root assistant message containing text. 'request'
and 'idle' inspect current state; turn-end/reply inspect events after --since.
Wait defaults to 60 seconds. Idle/request timeouts default to 30 minutes; configure
extensions["agent-bridge"].idleMinutes and requestTimeoutMinutes in settings.json.
Stop retains the session: use start --resume sessionId with the same --cwd.

Exit codes: 0 success, 1 error, 2 wait timeout, 3 bridge not found/not running.`

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  model: { type: "string" },
  cwd: { type: "string" },
  mode: { type: "string" },
  resume: { type: "string" },
  idle: { type: "string" },
  name: { type: "string" },
  steer: { type: "boolean" },
  since: { type: "string" },
  all: { type: "boolean" },
  "last-turn": { type: "boolean" },
  until: { type: "string" },
  timeout: { type: "string" },
} as const
const ALLOWED: Record<string, string[]> = {
  start: ["model", "cwd", "mode", "resume", "idle", "name"],
  send: ["steer"],
  steer: [],
  read: ["since", "all", "last-turn"],
  wait: ["until", "since", "timeout"],
  status: [],
  respond: [],
  abort: [],
  stop: [],
  list: [],
}
function numeric(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!value.trim() || !Number.isFinite(number)) throw new BridgeError(`${flag} must be a number`)
  return number
}
async function stdinText(ctx: PackageCommandContext): Promise<string> {
  const reader = ctx.stdin.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_REQUEST_BYTES - 1024) {
        await reader.cancel()
        throw new BridgeError("Input is too large")
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export interface CommandDependencies {
  start?: typeof startBridge
  client?: typeof callLocal
  probe?: IdentityProbe
}

/** Detach only the tiny command bootstrap; the daemon's RPC child uses public openPipe. */
export async function startBridge(ctx: PackageCommandContext, launch: LaunchOptions): Promise<JsonObject> {
  if (!statSync(launch.cwd).isDirectory()) throw new BridgeError(`Not a directory: ${launch.cwd}`)
  await secureStore(ctx.home, ctx.runCommand)
  const state = createState(ctx.home, launch)
  const log = agentPath(ctx.home, state.id, ".stderr.log")
  const fd = openSync(log, "wx", 0o600)
  privateMode(log, 0o600)
  let spawnError: string | undefined
  let exited = false
  let ownedPid: number | undefined
  let child: ChildProcess | undefined
  try {
    const [executable, ...args] = ctx.amiraArgv
    if (!executable) throw new BridgeError("Amira invocation is unavailable")
    child = spawn(executable, [...args, "agent", "__daemon", state.id], {
      // Preserve command discovery when this is a project-installed package.
      cwd: ctx.cwd,
      env: { ...process.env, AMIRA_HOME: ctx.home },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    })
    ownedPid = child.pid
    child.on("error", (error) => {
      spawnError = error.message
    })
    child.on("exit", () => {
      exited = true
    })
    child.unref()
  } catch (error) {
    spawnError = errorMessage(error)
  } finally {
    closeSync(fd)
  }
  const identity = ownedPid ? await processIdentity(ownedPid, ctx.runCommand) : undefined
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const current = readState(ctx.home, state.id)
    if (current.status === "failed" || current.status === "exited" || spawnError || exited) break
    if (current.sessionId && ["idle", "running"].includes(current.status)) {
      try {
        const probe = await callLocal(ctx.home, current, { op: "probe" }, { timeoutMs: 1500 })
        if (probe.ready === true && probe.sessionId === current.sessionId) {
          return { id: current.id, sessionId: current.sessionId }
        }
      } catch {
        // A bound endpoint is not enough; wait for authenticated readiness.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  let current = readState(ctx.home, state.id)
  // Ask our daemon to stop through its authenticated endpoint, never by a recycled PID.
  if (["starting", "running", "idle"].includes(current.status)) {
    try {
      await callLocal(ctx.home, current, { op: "stop" }, { timeoutMs: 15_000 })
    } catch {}
    current = readState(ctx.home, state.id)
  }
  // If package discovery itself hung, there is no endpoint yet. Only signal our
  // own bootstrap after checking the process birth identity captured at spawn.
  if (current.status === "starting" && ownedPid && identity?.kind === "alive" && !exited) {
    const now = await processIdentity(ownedPid, ctx.runCommand)
    if (now.kind === "alive" && now.identity === identity.identity) {
      child?.kill("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 100))
      current = readState(ctx.home, state.id)
    }
  }
  let tail = ""
  try {
    tail = readFileSync(log, "utf8").slice(-16_384)
  } catch {}
  const message = redact(
    current.error ?? spawnError ?? `Bridge startup failed${ownedPid ? ` (PID ${ownedPid})` : ""}`,
    state.token,
  )
  if (current.pid === 0 && (spawnError || exited)) {
    current.status = "failed"
    current.error = message
    writeState(ctx.home, current)
  }
  throw new BridgeError(`${message}${tail ? `\nStartup stderr:\n${redact(tail, state.token)}` : ""}`)
}

async function runDaemon(ctx: PackageCommandContext, id: string): Promise<number> {
  const state = readState(ctx.home, id)
  if (state.pid !== 0 || state.status !== "starting") throw new BridgeError("Bridge has already been started")
  const daemon = new BridgeDaemon({
    home: ctx.home,
    state,
    amiraArgv: ctx.amiraArgv,
    probe: (pid) => processIdentity(pid, ctx.runCommand),
  })
  const stop = () => {
    void daemon.stop("process signal")
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  try {
    await daemon.start()
    await daemon.done
    return daemon.state.status === "failed" ? 1 : 0
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
  }
}

export async function runAgentCommand(
  ctx: PackageCommandContext,
  deps: CommandDependencies = {},
): Promise<number> {
  let json = ctx.argv.includes("--json")
  try {
    if (ctx.argv[0] === "__daemon") {
      if (ctx.argv.length !== 2 || !ctx.argv[1]) throw new BridgeError("Invalid daemon invocation")
      return await runDaemon(ctx, ctx.argv[1])
    }
    const { values, positionals } = parseArgs({
      args: ctx.argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    })
    json = values.json === true
    const [sub, ...args] = positionals
    if (!sub || sub === "help" || values.help) {
      ctx.stdout(json ? `${JSON.stringify({ help: USAGE })}\n` : `${USAGE}\n`)
      return 0
    }
    const allowed = ALLOWED[sub]
    if (!allowed) throw new BridgeError(`Unknown agent command: ${sub}. Run amira agent --help`)
    for (const key of Object.keys(values)) {
      if (key !== "json" && key !== "help" && !allowed.includes(key))
        throw new BridgeError(`--${key} is not an option for ${sub}`)
    }
    const counts: Record<string, number> = {
      start: 0,
      list: 0,
      send: 2,
      steer: 2,
      read: 1,
      wait: 1,
      status: 1,
      respond: 3,
      abort: 1,
      stop: 1,
    }
    if (args.length !== counts[sub])
      throw new BridgeError(`Invalid arguments for ${sub}. Run amira agent --help`)
    let result: JsonObject
    if (sub === "start") {
      const mode = values.mode ?? "default"
      if (!["default", "edits", "auto", "plan"].includes(mode))
        throw new BridgeError("--mode must be default, edits, auto, or plan")
      const cwd = path.resolve(ctx.cwd, values.cwd ?? ".")
      const launch: LaunchOptions = {
        cwd,
        mode: mode as Mode,
        ...loadSettings(ctx.home, cwd, numeric(values.idle, "--idle")),
        ...(values.model ? { model: values.model } : {}),
        ...(values.resume ? { resume: values.resume } : {}),
        ...(values.name ? { name: values.name } : {}),
      }
      result = await (deps.start ?? startBridge)(ctx, launch)
    } else if (sub === "list") {
      result = {
        agents: await listStates(ctx.home, deps.probe ?? ((pid) => processIdentity(pid, ctx.runCommand))),
      }
    } else {
      const id = args[0]!
      const state = readState(ctx.home, id)
      const call: ClientCall = { op: sub }
      if (sub === "send" || sub === "steer") {
        call.text = args[1] === "-" ? await stdinText(ctx) : args[1]
        if (values.steer) call.steer = true
      }
      if (sub === "read" || sub === "wait") {
        call.since = numeric(values.since, "--since") ?? 0
        if (!Number.isSafeInteger(call.since) || Number(call.since) < 0)
          throw new BridgeError("--since must be a nonnegative integer cursor")
      }
      if (sub === "read") {
        if (values.all && values["last-turn"]) throw new BridgeError("Choose --all or --last-turn, not both")
        call.all = values.all === true
        call.lastTurn = values["last-turn"] === true
      }
      if (sub === "wait") {
        if (!values.until || !["turn-end", "reply", "request", "idle"].includes(values.until))
          throw new BridgeError("--until must be turn-end, reply, request, or idle")
        call.until = values.until
        call.timeout = numeric(values.timeout, "--timeout") ?? 60
        if (Number(call.timeout) < 0 || Number(call.timeout) > 2_000_000)
          throw new BridgeError("--timeout must be between 0 and 2000000 seconds")
      }
      if (sub === "respond") {
        call.requestId = args[1]
        try {
          call.value = JSON.parse(args[2]!)
        } catch {
          throw new BridgeError("value-json must be valid JSON; use null to cancel")
        }
      }
      result = await (deps.client ?? callLocal)(ctx.home, state, call, {
        timeoutMs: sub === "wait" ? Number(call.timeout) * 1000 + 35_000 : sub === "stop" ? 15_000 : 35_000,
      })
    }
    if (json) ctx.stdout(`${JSON.stringify(result)}\n`)
    else if (sub === "start")
      ctx.stdout(`bridge: ${String(result.id)}\nsession: ${String(result.sessionId)}\n`)
    else if (sub === "read" || sub === "wait") ctx.stdout(formatRead(result, args[0]!))
    else if (sub === "list") {
      const agents = Array.isArray(result.agents) ? result.agents : []
      ctx.stdout(
        agents.length
          ? `${agents
              .map((value) => {
                const agent = object(value)
                return `${String(agent.id)} ${String(agent.status)} session:${String(agent.sessionId ?? "-")} ${String(agent.cwd)}`
              })
              .join("\n")}\n`
          : "No bridges. Start one with amira agent start.\n",
      )
    } else if (sub === "status") {
      ctx.stdout(
        `${String(result.id)} ${String(result.status)}\nsession: ${String(result.sessionId)}\nmodel: ${String(result.model)}\n`,
      )
      ctx.stdout(
        `current tool: ${result.currentTool ? String(object(result.currentTool).name) : result.projectionsUncertain ? "unknown (events lost)" : "none"}\n`,
      )
      ctx.stdout(
        `pending requests: ${JSON.stringify(result.pendingRequests)}\nsubagents: ${JSON.stringify(result.subagents)}\nusage: ${JSON.stringify(result.usage)}\n`,
      )
      ctx.stdout(
        `idle countdown: ${result.idleSeconds === null ? "paused" : `${Math.ceil(Number(result.idleSeconds))}s`}\n`,
      )
    } else ctx.stdout(`${JSON.stringify(result)}\n`)
    return result.timedOut === true ? 2 : 0
  } catch (error) {
    const exitCode = error instanceof BridgeError ? error.exitCode : 1
    // Errors from corrupt secret-bearing files must not echo credential-shaped strings.
    const message = errorMessage(error).replace(/\b[a-f0-9]{64}\b/g, "[redacted]")
    if (json) ctx.stdout(`${JSON.stringify({ error: message, exitCode })}\n`)
    else ctx.stderr(`amira agent: ${message}\n`)
    return exitCode
  }
}

export default function agent(ctx: PackageCommandContext): Promise<number> {
  return runAgentCommand(ctx)
}
