import { describe, expect, test } from "bun:test"
import { createHerdrExtension, detect, NESTED_VAR } from "../src/index.ts"
import { BIN, fakeApi, herdrEnv, PANE, ROOT, seqOf, settle, setup, startData } from "./fakes.ts"

const RESUME = ["--", "amira", "--resume", ROOT, "--model", "deepseek/deepseek-chat"]

describe("activation", () => {
  test("outside herdr nothing registers", () => {
    for (const env of [
      {},
      herdrEnv({ HERDR_ENV: "0" }),
      herdrEnv({ HERDR_PANE_ID: "" }),
      herdrEnv({ HERDR_BIN_PATH: " " }),
    ]) {
      const s = setup({ env })
      expect(s.handlers.size).toBe(0)
      expect(s.exits.length).toBe(0)
      expect(env[NESTED_VAR]).toBeUndefined()
    }
  })

  test("extensions.herdr.enabled false turns it off", () => {
    const s = setup({ settings: { enabled: false } })
    expect(s.handlers.size).toBe(0)
    expect(s.env[NESTED_VAR]).toBeUndefined()
  })

  test("sets the nested guard for child processes", () => {
    const s = setup()
    expect(s.env[NESTED_VAR]).toBe(PANE)
    expect(s.handlers.size).toBeGreaterThan(0)
  })

  test("an Amira started inside one that reports for this pane stays silent", () => {
    const s = setup({ env: herdrEnv({ [NESTED_VAR]: PANE }) })
    expect(s.handlers.size).toBe(0)
    expect(s.exits.length).toBe(0)
  })

  test("the guard for another pane does not silence it", () => {
    const s = setup({ env: herdrEnv({ [NESTED_VAR]: "p_other" }) })
    expect(s.handlers.size).toBeGreaterThan(0)
    expect(s.env[NESTED_VAR]).toBe(PANE)
  })

  test("a reload in the same process is not taken for nesting", () => {
    const first = setup()
    const again = setup({ env: first.env, owner: first.owner })
    expect(again.handlers.size).toBeGreaterThan(0)
  })

  test("detect reports why", () => {
    expect(detect({}, undefined, {})).toEqual({ inactive: "not in herdr" })
    expect(detect(herdrEnv(), { enabled: false }, {})).toEqual({ inactive: "disabled" })
    expect(detect(herdrEnv({ [NESTED_VAR]: PANE }), undefined, {})).toEqual({ inactive: "nested" })
    expect(detect(herdrEnv(), {}, {})).toEqual({ pane: PANE, bin: BIN })
  })
})

describe("state reports", () => {
  test("session.start reports idle with the session and its resume command", async () => {
    const s = setup()
    s.emit("session.start", startData())
    await settle()
    expect(s.calls[0]!.argv.slice(0, 4)).toEqual([BIN, "pane", "report-agent", PANE])
    expect(s.calls[0]!.argv).toContain("--source")
    expect(s.calls[0]!.opts.timeoutMs).toBe(2000)
    expect(s.calls[0]!.opts.cwd).toBe("/work/proj")
    expect(s.brief()).toEqual([["report-agent", "--state", "idle", "--agent-session-id", ROOT, ...RESUME]])
  })

  test("maps working, blocked, idle and error", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    await s.emit("status.changed", { status: "working" })
    await s.emit("status.changed", { status: "blocked", reason: "approval for bash", pending: 1 })
    await s.emit("status.changed", { status: "working" })
    await s.emit("status.changed", { status: "error" })
    await s.emit("status.changed", { status: "working" })
    await s.emit("status.changed", { status: "idle" })
    await settle()
    const states = s
      .brief()
      .map((b) => b.slice(0, b.indexOf("--state") + 2 + (b.includes("--message") ? 2 : 0)))
    expect(states).toEqual([
      ["report-agent", "--state", "idle"],
      ["report-agent", "--state", "working"],
      ["report-agent", "--state", "blocked", "--message", "approval for bash"],
      ["report-agent", "--state", "working"],
      ["report-agent", "--state", "idle"],
      ["report-agent", "--state", "working"],
      ["report-agent", "--state", "idle"],
    ])
    // The session went with the first report only.
    expect(s.calls.slice(1).some((c) => c.argv.includes("--agent-session-id"))).toBe(false)
  })

  test("the blocked message is one line of at most 80 characters", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("status.changed", { status: "blocked", reason: `--approval\u001b[31m for\n${"x".repeat(200)}` })
    await settle()
    const argv = s.calls[1]!.argv
    const message = argv[argv.indexOf("--message") + 1]!
    expect([...message].length).toBe(80)
    expect(message.startsWith("approval [31m for xxx")).toBe(true)
    expect(message.endsWith("…")).toBe(true)
  })

  test("the same state twice is reported once", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("status.changed", { status: "working" })
    s.emit("status.changed", { status: "working" })
    await settle()
    expect(s.calls.length).toBe(2)
  })

  test("sub-agent events are ignored", async () => {
    const s = setup()
    s.emit("session.start", startData())
    await settle()
    s.emit("session.start", startData({ resume: undefined }), { sessionId: "s_child", parentSessionId: ROOT })
    s.emit("status.changed", { status: "working" }, { sessionId: "s_child", parentSessionId: ROOT })
    s.emit(
      "status.changed",
      { status: "blocked", reason: "x" },
      { sessionId: "s_child", parentSessionId: ROOT },
    )
    s.emit("session.end", { reason: "exit" }, { sessionId: "s_child", parentSessionId: ROOT })
    await settle()
    expect(s.calls.length).toBe(1)
  })

  test("another parentless session without a resume command does not take over", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("session.start", startData({ resume: undefined }), { sessionId: "s_owned" })
    s.emit("status.changed", { status: "working" }, { sessionId: "s_owned" })
    s.emit("session.end", { reason: "exit" }, { sessionId: "s_owned" })
    await settle()
    expect(s.brief()).toEqual([["report-agent", "--state", "idle", "--agent-session-id", ROOT, ...RESUME]])
  })

  test("after a reload the host's current session is the root", async () => {
    const s = setup()
    s.setCurrentSession(ROOT)
    s.emit("status.changed", { status: "working" }, { sessionId: "s_owned" })
    s.emit("status.changed", { status: "working" })
    await settle()
    expect(s.brief()).toEqual([["report-agent", "--state", "working"]])
  })
})

describe("dialogs", () => {
  test("a sub-agent's permission question shows as blocked until answered", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("status.changed", { status: "working" })
    await settle()
    // The child's own gate goes blocked; the root stays working.
    s.emit(
      "status.changed",
      { status: "blocked", reason: "approval for bash" },
      {
        sessionId: "s_child",
        parentSessionId: ROOT,
      },
    )
    s.emit(
      "ui.request",
      { kind: "confirm", title: "Allow bash: rm -rf build?", requestId: "ui_1" } as never,
      { sessionId: "s_child" },
    )
    await settle()
    s.emit("ui.resolved", { requestId: "ui_1", cancelled: false, value: true })
    await settle()
    expect(s.brief().slice(2)).toEqual([
      ["report-agent", "--state", "blocked", "--message", "Allow bash: rm -rf build?"],
      ["report-agent", "--state", "working"],
    ])
  })

  test("several dialogs: blocked until the last one closes", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    const child = { sessionId: "s_child" }
    await s.emit("ui.request", { kind: "confirm", title: "first", requestId: "a" } as never, child)
    await s.emit("ui.request", { kind: "confirm", title: "second", requestId: "b" } as never, child)
    await s.emit("ui.resolved", { requestId: "b", cancelled: true }, child)
    await s.emit("ui.resolved", { requestId: "a", cancelled: true }, child)
    await s.emit("ui.resolved", { requestId: "unknown", cancelled: true }, child)
    await settle()
    expect(s.brief().slice(1)).toEqual([
      ["report-agent", "--state", "blocked", "--message", "first"],
      ["report-agent", "--state", "blocked", "--message", "second"],
      ["report-agent", "--state", "blocked", "--message", "first"],
      ["report-agent", "--state", "idle"],
    ])
  })

  test("the user's own pickers and the root's dialogs do not count", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    // /model and other commands ask through the host's dialogs.
    await s.emit("ui.request", { kind: "select", title: "Model", options: ["a"], requestId: "m" } as never, {
      sessionId: "host",
    })
    // The root's approval: its status says blocked, the dialog adds nothing.
    await s.emit("status.changed", { status: "blocked", reason: "approval for bash" })
    await s.emit("ui.request", { kind: "confirm", title: "Allow bash?", requestId: "r" } as never)
    await s.emit("ui.resolved", { requestId: "r", cancelled: false, value: true })
    await s.emit("status.changed", { status: "working" })
    await s.emit("ui.resolved", { requestId: "m", cancelled: true }, { sessionId: "host" })
    expect(s.brief().slice(1)).toEqual([
      ["report-agent", "--state", "blocked", "--message", "approval for bash"],
      ["report-agent", "--state", "working"],
    ])
  })
})

describe("coalescing and seq", () => {
  test("while a call runs only the latest report waits", async () => {
    const s = setup({ auto: false })
    s.emit("session.start", startData())
    s.emit("status.changed", { status: "working" })
    s.emit("status.changed", { status: "blocked", reason: "q" })
    s.emit("status.changed", { status: "working" })
    s.emit("status.changed", { status: "idle" })
    await settle()
    expect(s.calls.length).toBe(1)
    s.calls[0]!.finish()
    await settle()
    expect(s.calls.length).toBe(2)
    expect(s.brief()[1]).toEqual(["report-agent", "--state", "idle"])
    s.calls[1]!.finish()
    await settle()
    expect(s.calls.length).toBe(2)
  })

  test("seq strictly increases even when the clock stands still or goes back", async () => {
    let now = 1_700_000_000_000
    const s = setup({ now: () => now })
    s.emit("session.start", startData())
    s.emit("status.changed", { status: "working" })
    now -= 5000
    s.emit("status.changed", { status: "idle" })
    s.emit("status.changed", { status: "working" })
    await settle()
    const seqs = s.calls.map((c) => seqOf(c.argv))
    expect(seqs[0]).toBe(1_700_000_000_000 * 1000)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    expect(Number.isSafeInteger(seqs[seqs.length - 1]!)).toBe(true)
  })

  test("a failed call is ignored, and its session goes with the next report", async () => {
    const s = setup({ auto: false })
    s.emit("session.start", startData())
    await settle()
    s.calls[0]!.finish(1)
    await settle()
    s.emit("status.changed", { status: "working" })
    await settle()
    expect(s.brief()[1]).toEqual([
      "report-agent",
      "--state",
      "working",
      "--agent-session-id",
      ROOT,
      ...RESUME,
    ])
    expect(s.errors).toEqual([])
  })

  test("a runCommand that throws is ignored", async () => {
    const fake = fakeApi()
    let calls = 0
    createHerdrExtension({
      env: herdrEnv(),
      process: {},
      runCommand: async () => {
        calls++
        throw new Error("spawn failed")
      },
    })(fake.api)
    fake.emit("session.start", startData())
    fake.emit("status.changed", { status: "working" })
    await settle()
    expect(calls).toBe(2)
    expect(fake.errors).toEqual([])
  })
})

describe("failures and argv", () => {
  test("a final report that fails is sent again with the next event", async () => {
    const s = setup({ auto: false })
    await s.emit("session.start", startData())
    s.calls[0]!.finish()
    await s.emit("status.changed", { status: "working" })
    s.calls[1]!.finish()
    await s.emit("status.changed", { status: "idle" })
    s.calls[2]!.finish(1)
    await settle()
    // The same state again: herdr may still show working, so it goes out once more.
    await s.emit("status.changed", { status: "idle" })
    expect(s.calls.length).toBe(4)
    expect(s.brief()[3]).toEqual(["report-agent", "--state", "idle"])
    s.calls[3]!.finish()
    await s.emit("status.changed", { status: "idle" })
    expect(s.calls.length).toBe(4)
  })

  test("a failure with a newer report waiting does not repeat the old one", async () => {
    const s = setup({ auto: false })
    await s.emit("session.start", startData())
    await s.emit("status.changed", { status: "working" })
    s.calls[0]!.finish(1)
    await settle()
    s.calls[1]!.finish()
    await s.emit("status.changed", { status: "working" })
    expect(s.brief().map((b) => b[2])).toEqual(["idle", "working"])
  })

  test("a binary path with spaces is one argv element", async () => {
    const bin = "C:Program Filesherdrherdr.exe"
    const s = setup({ env: herdrEnv({ HERDR_BIN_PATH: bin }) })
    await s.emit("session.start", startData())
    await s.emit("session.end", { reason: "exit" })
    for (const c of s.calls) expect(c.argv[0]).toBe(bin)
    expect(s.calls.length).toBe(2)
  })

  test("a session id or message starting with - stays one element after its flag", async () => {
    const s = setup()
    const id = "-s_odd id"
    await s.emit("session.start", startData({ resume: ["amira", "--resume", id] }), { sessionId: id })
    await s.emit("status.changed", { status: "blocked", reason: "-x --y" }, { sessionId: id })
    const first = s.calls[0]!.argv
    expect(first[first.indexOf("--agent-session-id") + 1]).toBe(id)
    expect(first.slice(first.indexOf("--") + 1)).toEqual([
      "amira",
      "--resume",
      id,
      "--model",
      "deepseek/deepseek-chat",
    ])
    const second = s.calls[1]!.argv
    expect(second[second.indexOf("--message") + 1]).toBe("x --y")
  })
})

describe("dialogs across sessions", () => {
  test("a new root session forgets the dialogs of the one before", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    await s.emit("ui.request", { kind: "confirm", title: "Allow?", requestId: "z" } as never, {
      sessionId: "s_child",
    })
    await s.emit("session.end", { reason: "switch" })
    await s.emit("session.start", startData({ reason: "clear", resume: ["amira", "--resume", "s_new"] }), {
      sessionId: "s_new",
    })
    expect(s.brief().map((b) => b[2])).toEqual(["idle", "blocked", "idle"])
  })

  test("an extension's own conversation's dialog counts", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    await s.emit("ui.request", { kind: "input", title: "Token?", requestId: "o" } as never, {
      sessionId: "s_owned",
    })
    expect(s.brief()[1]).toEqual(["report-agent", "--state", "blocked", "--message", "Token?"])
  })
})

describe("sessions", () => {
  test("every new session (clear, resume, fork) reports its resume command", async () => {
    const s = setup()
    await s.emit("session.start", startData())
    await s.emit("status.changed", { status: "working" })
    await s.emit("session.end", { reason: "switch" })
    await s.emit("session.start", startData({ reason: "clear", resume: ["amira", "--resume", "s_new"] }), {
      sessionId: "s_new",
    })
    await settle()
    expect(s.brief()[2]).toEqual([
      "report-agent",
      "--state",
      "idle",
      "--agent-session-id",
      "s_new",
      "--",
      "amira",
      "--resume",
      "s_new",
      "--model",
      "deepseek/deepseek-chat",
    ])
    // The old root is not the root any more.
    await s.emit("status.changed", { status: "working" })
    await settle()
    expect(s.calls.length).toBe(3)
  })

  test("a model change reports the resume command again", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("model.changed", {
      from: { provider: "deepseek", model: "deepseek-chat" },
      to: { provider: "openai", model: "gpt-5" },
    })
    await settle()
    expect(s.brief()[1]).toEqual([
      "report-agent",
      "--state",
      "idle",
      "--agent-session-id",
      ROOT,
      "--",
      "amira",
      "--resume",
      ROOT,
      "--model",
      "openai/gpt-5",
    ])
  })

  test("an invalid resume command is left out, the state is still reported", async () => {
    const s = setup()
    s.emit("session.start", startData({ resume: ["/usr/bin/amira", "--resume", ROOT] }))
    await settle()
    expect(s.brief()).toEqual([["report-agent", "--state", "idle", "--agent-session-id", ROOT]])
  })

  test("without a model the command has no --model", async () => {
    const s = setup()
    s.emit("session.start", startData({ model: { provider: "", model: "" } }))
    await settle()
    expect(s.brief()[0]!.slice(-4)).toEqual(["--", "amira", "--resume", ROOT])
  })
})

describe("release", () => {
  test("a switch does not release", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("session.end", { reason: "switch" })
    await settle()
    expect(s.brief().some((b) => b[0] === "release-agent")).toBe(false)
  })

  test("exit releases once, also through onExit", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("session.end", { reason: "exit" })
    await s.exits[0]!(new AbortController().signal)
    await settle()
    const releases = s.calls.filter((c) => c.argv[2] === "release-agent")
    expect(releases.length).toBe(1)
    expect(releases[0]!.argv.slice(0, 4)).toEqual([BIN, "pane", "release-agent", PANE])
    expect(seqOf(releases[0]!.argv)).toBeGreaterThan(seqOf(s.calls[0]!.argv))
    // Nothing after the release.
    s.emit("status.changed", { status: "working" })
    await settle()
    expect(s.calls.length).toBe(2)
  })

  test("an error end releases", async () => {
    const s = setup()
    s.emit("session.start", startData())
    s.emit("session.end", { reason: "error" })
    await settle()
    expect(s.brief().at(-1)).toEqual(["release-agent"])
  })

  test("onExit alone releases, and waits at most about a second", async () => {
    const s = setup({ auto: false })
    s.emit("session.start", startData())
    await settle()
    const started = Date.now()
    await s.exits[0]!(new AbortController().signal)
    const waited = Date.now() - started
    expect(waited).toBeLessThan(1500)
    expect(waited).toBeGreaterThanOrEqual(900)
    expect(s.calls[1]!.argv[2]).toBe("release-agent")
    expect(s.calls[1]!.opts.timeoutMs).toBe(1000)
  })

  test("onExit returns at once when its signal aborts", async () => {
    const s = setup({ auto: false })
    s.emit("session.start", startData())
    await settle()
    const abort = new AbortController()
    abort.abort()
    const started = Date.now()
    await s.exits[0]!(abort.signal)
    expect(Date.now() - started).toBeLessThan(200)
    expect(s.calls[1]!.opts.signal.aborted).toBe(true)
  })

  test("nothing reported, nothing released", async () => {
    const s = setup()
    await s.exits[0]!(new AbortController().signal)
    expect(s.calls.length).toBe(0)
  })
})
