import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import command, { runAgentCommand } from "../src/command.ts"
import { BridgeError, createState, type JsonObject, type LaunchOptions } from "../src/storage.ts"
import type { ClientCall } from "../src/transport.ts"
import { commandContext, deferred, harness, sandbox } from "./helpers.ts"

test("command-only manifest registers agent and has no public JS export surface to snapshot", () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"))
  expect(manifest.amira.commands).toEqual({ agent: "./src/command.ts" })
  expect(manifest.amira.engines).toEqual({ amira: "^0.1.27" })
  expect(manifest.exports).toBeUndefined()
  expect(typeof command).toBe("function")
})

test("start emits only bridge/session IDs after the readiness result, and maps every launch flag", async () => {
  const h = sandbox()
  const ready = deferred<JsonObject>()
  try {
    const c = commandContext(h, [
      "start",
      "--model",
      "mock/m",
      "--cwd",
      "subdir",
      "--mode",
      "edits",
      "--resume",
      "s_saved",
      "--idle",
      "2",
      "--name",
      "Review",
    ])
    const launches: LaunchOptions[] = []
    const running = runAgentCommand(c.ctx, {
      start: async (_ctx, launch) => {
        launches.push(launch)
        return ready.promise
      },
    })
    expect(c.output()).toBe("")
    expect(launches).toEqual([
      {
        cwd: path.join(h.cwd, "subdir"),
        mode: "edits",
        idleMinutes: 2,
        requestTimeoutMinutes: 30,
        model: "mock/m",
        resume: "s_saved",
        name: "Review",
      },
    ])
    ready.resolve({ id: "bridge-id", sessionId: "s_saved" })
    expect(await running).toBe(0)
    expect(c.output()).toBe("bridge: bridge-id\nsession: s_saved\n")
    expect(c.errors()).toBe("")
  } finally {
    ready.resolve({})
    h.cleanup()
  }
})

const commands: Array<{ argv: string[]; call: ClientCall }> = [
  { argv: ["send", "ID", "hello"], call: { op: "send", text: "hello" } },
  { argv: ["send", "ID", "-", "--steer"], call: { op: "send", text: "stdin 🦊\n", steer: true } },
  { argv: ["steer", "ID", "-"], call: { op: "steer", text: "stdin 🦊\n" } },
  { argv: ["read", "ID"], call: { op: "read", since: 0, all: false, lastTurn: false } },
  {
    argv: ["read", "ID", "--since", "4", "--all"],
    call: { op: "read", since: 4, all: true, lastTurn: false },
  },
  { argv: ["read", "ID", "--last-turn"], call: { op: "read", since: 0, all: false, lastTurn: true } },
  {
    argv: ["wait", "ID", "--until", "reply", "--since", "5", "--timeout", "3"],
    call: { op: "wait", until: "reply", since: 5, timeout: 3 },
  },
  { argv: ["status", "ID"], call: { op: "status" } },
  { argv: ["respond", "ID", "q1", "null"], call: { op: "respond", requestId: "q1", value: null } },
  {
    argv: ["respond", "ID", "q2", '{"password":"secret"}'],
    call: { op: "respond", requestId: "q2", value: { password: "secret" } },
  },
  { argv: ["abort", "ID"], call: { op: "abort" } },
  { argv: ["stop", "ID"], call: { op: "stop" } },
]

for (const { argv, call } of commands) {
  test(`${argv.join(" ")} accepts --json and issues one short-lived client call`, async () => {
    const h = sandbox()
    try {
      const state = createState(h.home, {
        cwd: h.cwd,
        mode: "default",
        idleMinutes: 30,
        requestTimeoutMinutes: 30,
      })
      const c = commandContext(
        h,
        [...argv.map((part) => (part === "ID" ? state.id : part)), "--json"],
        "stdin 🦊\n",
      )
      const calls: ClientCall[] = []
      const result = { cursor: 9, result: "accepted" }
      const code = await runAgentCommand(c.ctx, {
        client: async (home, saved, request, options) => {
          expect(home).toBe(h.home)
          expect(saved.token).toBe(state.token)
          expect(options?.timeoutMs).toBe(call.op === "wait" ? 38_000 : call.op === "stop" ? 15_000 : 35_000)
          calls.push(request)
          return result
        },
      })
      expect(code).toBe(0)
      expect(calls).toEqual([call])
      expect(JSON.parse(c.output())).toEqual(result)
      expect(c.errors()).toBe("")
      expect(c.output()).not.toContain(state.token)
    } finally {
      h.cleanup()
    }
  })
}

test("start/list/help JSON contain no credential and malformed commands exit 1", async () => {
  const h = sandbox()
  try {
    const state = createState(h.home, {
      cwd: h.cwd,
      mode: "default",
      idleMinutes: 30,
      requestTimeoutMinutes: 30,
    })
    for (const argv of [
      ["start", "--json"],
      ["list", "--json"],
      ["--help", "--json"],
    ]) {
      const c = commandContext(h, argv)
      expect(
        await runAgentCommand(c.ctx, {
          start: async () => ({ id: state.id, sessionId: "s_1" }),
          probe: async () => ({ kind: "unknown" }),
        }),
      ).toBe(0)
      expect(() => JSON.parse(c.output())).not.toThrow()
      expect(c.output()).not.toContain(state.token)
    }
    for (const argv of [
      ["send", state.id],
      ["start", "--mode", "unknown"],
      ["start", "--idle", "0"],
      ["read", state.id, "--all", "--last-turn"],
      ["read", state.id, "--since", "-1"],
      ["wait", state.id],
      ["wait", state.id, "--until", "bad"],
      ["status", state.id, "--steer"],
      ["respond", state.id, "q1", "not-json"],
      ["unknown"],
    ]) {
      const c = commandContext(h, [...argv, "--json"])
      expect(await runAgentCommand(c.ctx)).toBe(1)
      expect(JSON.parse(c.output())).toMatchObject({ exitCode: 1 })
    }
  } finally {
    h.cleanup()
  }
})

test("CLI wait timeout is exit 2 with read output; unknown/stopped bridge is exit 3, busy is exit 1", async () => {
  const h = harness()
  try {
    await h.daemon.start()
    const c = commandContext(h, ["wait", h.state.id, "--until", "reply", "--timeout", "0"])
    expect(await runAgentCommand(c.ctx)).toBe(2)
    expect(c.output()).toMatch(/wait timed out\ncursor: \d+\n$/)
    const json = commandContext(h, ["wait", h.state.id, "--until", "reply", "--timeout", "0", "--json"])
    expect(await runAgentCommand(json.ctx)).toBe(2)
    expect(JSON.parse(json.output())).toMatchObject({ timedOut: true, until: "reply" })
    const missing = commandContext(h, ["status", "missing", "--json"])
    expect(await runAgentCommand(missing.ctx)).toBe(3)
    expect(JSON.parse(missing.output())).toMatchObject({ exitCode: 3 })
    await h.call("send", { text: "first" })
    const busy = commandContext(h, ["send", h.state.id, "second", "--json"])
    expect(await runAgentCommand(busy.ctx)).toBe(1)
    expect(JSON.parse(busy.output())).toMatchObject({ error: "busy — use steer", exitCode: 1 })
    await h.call("stop")
    const stopped = commandContext(h, ["status", h.state.id, "--json"])
    expect(await runAgentCommand(stopped.ctx)).toBe(3)
  } finally {
    await h.cleanup()
  }
})

test("startup failures include stderr diagnostics but redact credential-shaped text", async () => {
  const h = sandbox()
  try {
    const c = commandContext(h, ["start", "--json"])
    const token = "b".repeat(64)
    expect(
      await runAgentCommand(c.ctx, {
        start: async () => {
          throw new BridgeError(`RPC stderr: startup failed ${token}`)
        },
      }),
    ).toBe(1)
    expect(c.output()).toContain("startup failed")
    expect(c.output()).not.toContain(token)
  } finally {
    h.cleanup()
  }
})
