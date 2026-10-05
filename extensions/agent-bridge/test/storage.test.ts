import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  agentPath,
  createState,
  EventJournal,
  endpointFor,
  type IdentityResult,
  listStates,
  loadSettings,
  publicState,
  readState,
  writeState,
} from "../src/storage.ts"
import { sandbox } from "./helpers.ts"

function stored() {
  const files = sandbox()
  const state = createState(files.home, {
    cwd: files.cwd,
    mode: "default",
    idleMinutes: 30,
    requestTimeoutMinutes: 30,
  })
  state.pid = 54321
  state.processStart = "birth-original"
  state.status = "idle"
  state.sessionId = "s_retained"
  writeState(files.home, state)
  return { ...files, state }
}

test("settings default to 30 minutes and apply user/project/local/CLI scalar precedence", () => {
  const h = sandbox()
  try {
    expect(loadSettings(h.home, h.cwd)).toEqual({ idleMinutes: 30, requestTimeoutMinutes: 30 })
    mkdirSync(path.join(h.cwd, ".amira"))
    const settings = (idleMinutes?: number, requestTimeoutMinutes?: number) =>
      JSON.stringify({
        extensions: { "agent-bridge": { idleMinutes, requestTimeoutMinutes } },
      })
    writeFileSync(path.join(h.home, "settings.json"), settings(10, 15))
    writeFileSync(path.join(h.cwd, ".amira", "settings.json"), settings(20))
    writeFileSync(path.join(h.cwd, ".amira", "settings.local.json"), settings(undefined, 25))
    expect(loadSettings(h.home, h.cwd)).toEqual({ idleMinutes: 20, requestTimeoutMinutes: 25 })
    expect(loadSettings(h.home, h.cwd, 2)).toEqual({ idleMinutes: 2, requestTimeoutMinutes: 25 })
    expect(() => loadSettings(h.home, h.cwd, 0)).toThrow("positive")
    writeFileSync(path.join(h.cwd, ".amira", "settings.local.json"), settings(-1))
    expect(() => loadSettings(h.home, h.cwd)).toThrow("positive")
  } finally {
    h.cleanup()
  }
})

for (const [label, identity, expectedStatus, identityStatus] of [
  ["dead PID", { kind: "dead" }, "exited", "dead"],
  ["recycled PID", { kind: "alive", identity: "birth-new" }, "exited", "mismatch"],
  ["same process", { kind: "alive", identity: "birth-original" }, "idle", "alive"],
  ["unreadable identity", { kind: "unknown" }, "idle", "unknown"],
] as const) {
  test(`list prunes ${label} by PID AND birth identity without deleting session/events`, async () => {
    const h = stored()
    try {
      const session = path.join(h.home, "retained-session.jsonl")
      writeFileSync(session, "conversation\n")
      const journal = new EventJournal(h.home, h.state.id)
      journal.append("bridge.ready", { sessionId: "s_retained" })
      if (process.platform !== "win32") writeFileSync(h.state.endpoint, "stale socket placeholder")
      const seen: number[] = []
      const listed = await listStates(h.home, async (pid): Promise<IdentityResult> => {
        seen.push(pid)
        return identity
      })
      expect(seen).toEqual([54321])
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ status: expectedStatus, identityStatus, sessionId: "s_retained" })
      expect(readState(h.home, h.state.id).status).toBe(expectedStatus)
      expect(JSON.stringify(listed)).not.toContain(h.state.token)
      expect(listed[0]).not.toHaveProperty("token")
      expect(readFileSync(session, "utf8")).toBe("conversation\n")
      expect(existsSync(agentPath(h.home, h.state.id, ".events.jsonl"))).toBe(true)
      if (process.platform !== "win32") expect(existsSync(h.state.endpoint)).toBe(expectedStatus !== "exited")
    } finally {
      h.cleanup()
    }
  })
}

test("fresh bootstrap gets its startup grace; missing birth identity never implies PID reuse", async () => {
  const h = stored()
  try {
    h.state.pid = 0
    h.state.status = "starting"
    h.state.processStart = null
    writeState(h.home, h.state)
    expect((await listStates(h.home, async () => ({ kind: "dead" })))[0]?.status).toBe("starting")
    h.state.startedAt = new Date(Date.now() - 120_000).toISOString()
    writeState(h.home, h.state)
    expect((await listStates(h.home, async () => ({ kind: "dead" })))[0]?.status).toBe("exited")
    h.state.pid = 54321
    h.state.status = "idle"
    writeState(h.home, h.state)
    expect((await listStates(h.home, async () => ({ kind: "alive", identity: "unproven" })))[0]?.status).toBe(
      "idle",
    )
  } finally {
    h.cleanup()
  }
})

test("state rejects traversal and foreign endpoints; public output redacts embedded credentials", () => {
  const h = stored()
  try {
    for (const id of ["../outside", "..\\outside", "/tmp/foo", "a/b", "", "x".repeat(81)]) {
      expect(() => readState(h.home, id)).toThrow("Invalid bridge ID")
    }
    expect(() => readState(h.home, "missing")).toThrow("not found")
    h.state.error = `unexpected ${h.state.token}`
    expect(JSON.stringify(publicState(h.state))).not.toContain(h.state.token)
    expect(publicState(h.state)).not.toHaveProperty("launch")
    expect(endpointFor(h.home, "safe", "win32")).toBe("\\\\.\\pipe\\amira-agent-safe")
    expect(endpointFor(h.home, "safe", "linux")).toBe(path.join(path.resolve(h.home), "agents", "safe.sock"))
    h.state.endpoint = "127.0.0.1:9000"
    writeState(h.home, h.state)
    expect(() => readState(h.home, h.state.id)).toThrow("Invalid state")
  } finally {
    h.cleanup()
  }
})

test("journal survives reopening, appends monotonically and preserves unknown RPC fields", () => {
  const h = stored()
  try {
    const first = new EventJournal(h.home, h.state.id)
    first.append("bridge.ready")
    const second = new EventJournal(h.home, h.state.id)
    second.append(
      "message.end",
      { message: { role: "assistant" } },
      {
        seq: 999,
        sessionId: "s_retained",
        turnId: "t_1",
        futureField: { nested: true },
      },
    )
    expect(second.read(1)).toMatchObject({
      cursor: 2,
      events: [
        {
          seq: 2,
          sessionId: "s_retained",
          event: { seq: 999, futureField: { nested: true } },
        },
      ],
    })
    const file = agentPath(h.home, h.state.id, ".events.jsonl")
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2}\n`)
    expect(() => new EventJournal(h.home, h.state.id)).toThrow("Invalid event cursor")
  } finally {
    h.cleanup()
  }
})

test.skipIf(process.platform === "win32")(
  "Unix store/state/journal are owner-only and reject symlinks",
  () => {
    const h = stored()
    try {
      const journal = new EventJournal(h.home, h.state.id)
      journal.append("bridge.ready")
      expect(statSync(path.join(h.home, "agents")).mode & 0o777).toBe(0o700)
      expect(statSync(agentPath(h.home, h.state.id)).mode & 0o777).toBe(0o600)
      expect(statSync(agentPath(h.home, h.state.id, ".events.jsonl")).mode & 0o777).toBe(0o600)
      symlinkSync(agentPath(h.home, h.state.id), agentPath(h.home, "linked"))
      expect(() => readState(h.home, "linked")).toThrow("symlink")
      symlinkSync(
        agentPath(h.home, h.state.id, ".events.jsonl"),
        agentPath(h.home, "linked", ".events.jsonl"),
      )
      expect(() => new EventJournal(h.home, "linked")).toThrow("symlink")
      const otherHome = path.join(h.root, "other-home")
      mkdirSync(otherHome)
      symlinkSync(path.join(h.home, "agents"), path.join(otherHome, "agents"))
      expect(() => createState(otherHome, h.state.launch)).toThrow("symlink")
    } finally {
      h.cleanup()
    }
  },
)

test("list reports a damaged state file without hiding other bridges or echoing it", async () => {
  const h = stored()
  try {
    const secret = "a".repeat(64)
    writeFileSync(path.join(h.home, "agents", "broken.json"), `{"token":"${secret}"`)
    const listed = await listStates(h.home, async () => ({ kind: "alive", identity: "x" }))
    expect(listed.map((entry) => entry.id)).toContain(h.state.id)
    const broken = listed.find((entry) => entry.id === "broken")
    expect(broken?.status).toBe("invalid")
    expect(JSON.stringify(listed)).not.toContain(secret)
  } finally {
    h.cleanup()
  }
})
