import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PackageCommandContext } from "@amira/api"
import { runAgentCommand } from "../src/command.ts"
import {
  type BridgeEvent,
  type BridgeState,
  type JsonObject,
  object,
  processIdentity,
  readState,
} from "../src/storage.ts"
import { callLocal } from "../src/transport.ts"
import { eventually, sandbox } from "./helpers.ts"

const core = path.resolve(process.env.AMIRA_TEST_CORE ?? "D:/dev/Amira")
const main = path.join(core, "packages", "cli", "src", "main.ts")

/** The linked core is used as an executable only, never imported as a private package. */
test.skipIf(!existsSync(main))(
  "real offline CLI: detached start, send, busy, steer, wait, read, answer and stop",
  async () => {
    const h = sandbox()
    const replies = [
      { toolCalls: [{ name: "wait", args: { ms: 1500 } }] },
      { text: "done" },
      { toolCalls: [{ name: "ask", args: {} }] },
      { text: "asked" },
    ]
    const env = {
      ...process.env,
      AMIRA_HOME: h.home,
      AMIRA_BRIDGE_TEST_HOME: h.home,
      AMIRA_TEST_MOCK: JSON.stringify(replies),
    }
    let state: BridgeState | undefined

    async function run(argv: string[], cwd = h.cwd, timeoutMs = 90_000) {
      const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      // Drain both streams immediately, including while startup waits on its readiness barrier.
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill() // Only this owned short-lived child; never signal by image name.
      }, timeoutMs)
      try {
        const [code, out, err] = await Promise.all([child.exited, stdout, stderr])
        if (timedOut) throw new Error(`Test command timed out: ${argv.join(" ")}\n${err}`)
        return { code, out, err }
      } finally {
        clearTimeout(timer)
      }
    }

    const runCommand: PackageCommandContext["runCommand"] = async (argv, options) => {
      const result = await run(argv, options.cwd, options.timeoutMs)
      return {
        output: result.out,
        exitCode: result.code,
        signalCode: null,
        truncated: false,
        timedOut: false,
        aborted: false,
        settled: true,
        contained: true,
      }
    }

    async function cli(argv: string[], input = "") {
      let out = ""
      let err = ""
      const ctx: PackageCommandContext = {
        apiVersion: "0.1.27",
        argv,
        cwd: h.cwd,
        home: h.home,
        amiraArgv: [process.execPath, main],
        runCommand,
        stdin: new Response(input).body!,
        stdout: (text) => {
          out += text
        },
        stderr: (text) => {
          err += text
        },
      }
      const code = await runAgentCommand(ctx)
      return { code, out, err }
    }

    async function json(argv: string[], input = ""): Promise<JsonObject> {
      const result = await cli([...argv, "--json"], input)
      if (result.code !== 0) throw new Error(`agent ${argv.join(" ")}: ${result.out}${result.err}`)
      expect(result.err).toBe("")
      expect(result.out).not.toContain(state!.token)
      return object(JSON.parse(result.out))
    }

    function owned(): Array<{ pid: number; identity: JsonObject; role: string }> {
      const file = path.join(h.home, "owned-processes.jsonl")
      if (!existsSync(file)) return []
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    }

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    try {
      writeFileSync(path.join(h.home, "settings.json"), JSON.stringify({ sessions: { autoTitle: false } }))
      // Register a command-only fixture without an install command, network access, or core edits.
      const pkg = path.join(h.home, "packages", "agent-bridge")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "agent-bridge",
          version: "0.1.0",
          type: "module",
          amira: { engines: { amira: "^0.1.27" }, commands: { agent: "./command.ts" } },
        }),
      )
      const fixture = pathToFileURL(path.join(import.meta.dir, "fixtures", "command.ts")).href
      writeFileSync(path.join(pkg, "command.ts"), `export { default } from ${JSON.stringify(fixture)}\n`)
      writeFileSync(
        path.join(h.home, "packages.lock"),
        JSON.stringify({
          lockfileVersion: 1,
          packages: {
            "agent-bridge": {
              version: "0.1.0",
              source: { type: "path", path: pkg },
              pinned: {},
              installedAt: new Date().toISOString(),
            },
          },
        }),
      )

      // Production startBridge detaches the host command; the test wrapper changes only RPC fixture args.
      const started = await run([
        process.execPath,
        main,
        "agent",
        "start",
        "--model",
        "mock/m",
        "--cwd",
        h.cwd,
        "--name",
        "Offline bridge integration",
        "--json",
      ])
      expect(started.code, started.err || started.out).toBe(0)
      const ids = object(JSON.parse(started.out))
      expect(Object.keys(ids).sort()).toEqual(["id", "sessionId"])
      expect(typeof ids.id).toBe("string")
      expect(typeof ids.sessionId).toBe("string")
      state = readState(h.home, String(ids.id))
      expect(started.out).not.toContain(state.token)
      expect(state.sessionId).toBe(String(ids.sessionId))
      expect(state.pid).not.toBe(process.pid)
      expect(state.processStart).toBeTruthy()
      expect(await callLocal(h.home, state, { op: "probe" })).toMatchObject({
        ready: true,
        sessionId: ids.sessionId,
      })

      const sent = await json(["send", state.id, "-"], "go\n")
      const since = String(sent.cursor)
      let latest: JsonObject = {}
      const toolDeadline = Date.now() + 10_000
      for (;;) {
        latest = await json(["read", state.id, "--since", since])
        if ((latest.events as BridgeEvent[]).some((event) => event.type === "tool.execute.start")) break
        if (Date.now() >= toolDeadline) throw new Error(`Tool did not start: ${JSON.stringify(latest)}`)
        await Bun.sleep(10)
      }
      const busy = await cli(["send", state.id, "too early", "--json"])
      expect(busy.code).toBe(1)
      expect(JSON.parse(busy.out)).toMatchObject({ error: "busy — use steer" })
      expect(await json(["steer", state.id, "also B"])).toMatchObject({ queued: true, turnId: sent.turnId })
      expect(
        await json(["wait", state.id, "--until", "turn-end", "--since", since, "--timeout", "20"]),
      ).toMatchObject({ timedOut: false })
      const first = await json(["read", state.id, "--since", since])
      const firstEvents = first.events as BridgeEvent[]
      expect(
        firstEvents.some((event) => event.type === "turn.steer" && event.data.state === "injected"),
      ).toBe(true)
      expect(firstEvents.some((event) => event.type === "turn.end" && event.data.reason === "done")).toBe(
        true,
      )
      const compact = await cli(["read", state.id, "--since", since])
      expect(compact.code).toBe(0)
      expect(compact.out).toContain("done")
      expect(compact.out).toContain("steer injected")
      expect(compact.out).toMatch(/cursor: \d+\n$/)
      expect(await json(["read", state.id, "--last-turn"])).toMatchObject({
        turnId: sent.turnId,
        text: "done",
        reason: "done",
      })
      expect(await json(["wait", state.id, "--until", "idle", "--timeout", "5"])).toMatchObject({
        timedOut: false,
      })
      const noReply = await cli([
        "wait",
        state.id,
        "--until",
        "reply",
        "--since",
        String(first.cursor),
        "--timeout",
        "0",
        "--json",
      ])
      expect(noReply.code).toBe(2)
      expect(JSON.parse(noReply.out)).toMatchObject({ timedOut: true })

      const second = await json(["send", state.id, "ask me"])
      const request = await json([
        "wait",
        state.id,
        "--until",
        "request",
        "--since",
        String(second.cursor),
        "--timeout",
        "20",
      ])
      const pending = (request.pendingRequests as JsonObject[])[0]!
      expect(pending).toMatchObject({ kind: "confirm", title: "Deploy?" })
      const invalid = await cli(["respond", state.id, String(pending.requestId), '"yes"', "--json"])
      expect(invalid.code).toBe(1)
      expect((await json(["status", state.id])).pendingRequests).toHaveLength(1)
      await json(["respond", state.id, String(pending.requestId), "true"])
      await json([
        "wait",
        state.id,
        "--until",
        "turn-end",
        "--since",
        String(second.cursor),
        "--timeout",
        "20",
      ])
      const history = await json(["read", state.id, "--all"])
      expect(JSON.stringify(history.messages)).toContain("answer: true")
      expect(JSON.stringify(history.messages)).toContain("also B")
      expect(JSON.stringify(history.messages)).toContain("asked")
      expect((await json(["status", state.id])).status).toBe("idle")

      const everything = await json(["read", state.id])
      const sessionStart = (everything.events as BridgeEvent[]).find(
        (event) => event.type === "session.start",
      )!
      const sessionFile = String(sessionStart.data.sessionFile)
      expect(path.relative(h.home, sessionFile).startsWith("..")).toBe(false)
      expect(existsSync(sessionFile)).toBe(true)
      const saved = readFileSync(sessionFile, "utf8")
      expect(await json(["stop", state.id])).toMatchObject({ status: "exited" })
      expect(readState(h.home, state.id).status).toBe("exited")
      expect(readFileSync(sessionFile, "utf8")).toContain("asked")
      expect(readFileSync(sessionFile, "utf8").length).toBeGreaterThanOrEqual(saved.length)
      await eventually(() => owned().length >= 2, "owned daemon and child identities", 20_000)
      expect(
        owned()
          .map((entry) => entry.role)
          .sort(),
      ).toEqual(["daemon", "rpc"])
      await eventually(() => owned().every((entry) => !alive(entry.pid)), "daemon and RPC child exit", 20_000)
      if (process.platform !== "win32") expect(existsSync(state.endpoint)).toBe(false)
      expect((await cli(["status", state.id, "--json"])).code).toBe(3)
    } finally {
      // Recover the ID even when startup failed before it returned stdout.
      const agents = path.join(h.home, "agents")
      const states = existsSync(agents) ? readdirSync(agents).filter((name) => name.endsWith(".json")) : []
      for (const name of states) {
        try {
          const saved = readState(h.home, name.slice(0, -5))
          if (!["exited", "failed"].includes(saved.status)) {
            await callLocal(h.home, saved, { op: "stop" }, { timeoutMs: 15_000 })
          }
        } catch {
          /* Fall back only to recorded owned PIDs, with a matching birth identity. */
        }
      }
      for (const entry of owned()) {
        if (!alive(entry.pid)) continue
        const current = await processIdentity(entry.pid, runCommand)
        if (
          current.kind === "alive" &&
          entry.identity.kind === "alive" &&
          current.identity === entry.identity.identity
        ) {
          try {
            process.kill(entry.pid, "SIGTERM")
          } catch {
            /* Already exited. */
          }
        }
      }
      await eventually(() => owned().every((entry) => !alive(entry.pid)), "owned process cleanup", 20_000)
      h.cleanup()
    }
  },
  180_000,
)
