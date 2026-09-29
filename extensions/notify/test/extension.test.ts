import { expect, test } from "bun:test"
import type { CommandContext, EventMap, Settings, SpawnGroupInfo } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { createNotifyExtension } from "../src/index.ts"
import { fakeFetch, fakeRun, fakeTimers } from "./fakes.ts"

const MAIN = "s_main"

async function setup(
  notify: Record<string, unknown> = {},
  env: Record<string, string> = { HOOK: "https://hook.test/x" },
) {
  const bus = new EventBus()
  const errors: string[] = []
  bus.subscribe((e) => void (e.type === "extension.error" && errors.push(e.data.error)), {
    types: ["extension.error"],
  })
  const settings: Settings = {
    extensions: { notify: { webhooks: [{ type: "json", urlEnv: "HOOK" }], ...notify } },
  }
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd: "/work/my-proj",
    settings,
  })
  const t = fakeTimers()
  const run = fakeRun()
  const f = fakeFetch()
  const ext = createNotifyExtension({
    runCommand: run.run,
    fetch: f.fetch,
    platform: "linux",
    env,
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  })
  expect(await host.load(ext, "pkg:notify")).toBe(true)
  /** Emits an event at `at` ms on the fake clock, and lets the subscribers and sends run. */
  const emit = async <K extends keyof EventMap>(
    type: K,
    data: EventMap[K],
    meta: { sessionId?: string; parentSessionId?: string; at?: number } = {},
  ) => {
    bus.emit(type, data, {
      sessionId: meta.sessionId ?? MAIN,
      ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      ts: meta.at ?? t.now(),
    } as never)
    await settle()
  }
  const settle = async () => {
    await bus.flush()
    for (let i = 0; i < 5; i++) await Bun.sleep(0)
  }
  /** The bodies the json webhook got, in order. */
  const bodies = () => f.calls.map((c) => c.body.body as string)
  const command = async (text: string) => {
    const printed: { text: string; level?: string }[] = []
    const ctx = {
      print: (t: string, level?: string) => void printed.push({ text: t, ...(level ? { level } : {}) }),
    } as unknown as CommandContext
    await host.commands.get("notify")!.def.run(text, ctx)
    return printed
  }
  return { bus, host, t, run, f, emit, settle, bodies, command, errors }
}

const assistant = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "mock", model: "m" },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
  }) as never

const prompt = { role: "user", content: [{ type: "text", text: "go" }] } as never

async function turn(
  s: Awaited<ReturnType<typeof setup>>,
  ms: number,
  reply = "All done.",
  reason: "done" | "error" | "aborted" = "done",
) {
  const start = s.t.now()
  await s.emit("turn.start", { prompt }, { at: start })
  await s.emit("message.end", { message: assistant(reply) })
  s.t.advance(ms)
  await s.emit(
    "turn.end",
    { reason, steps: 1, ...(reason === "error" ? { error: "HTTP 500 from provider" } : {}) },
    { at: start + ms },
  )
}

test("a long turn notifies on the desktop and the webhook with the reply's start; a short one does not", async () => {
  const s = await setup()
  await turn(s, 5_000)
  expect(s.bodies()).toEqual([])
  await turn(s, 95_000, "I refactored   the parser.\n\nEverything passes.")
  expect(s.bodies()).toEqual(["Done after 1m 35s\nI refactored the parser. Everything passes."])
  expect(s.f.calls[0]!.body.title).toBe("Amira · my-proj")
  expect(s.run.calls.map((c) => c.argv.slice(3))).toEqual([
    ["Amira · my-proj", "Done after 1m 35s\nI refactored the parser. Everything passes."],
  ])
})

test("an interrupted turn never notifies; a failed one says why", async () => {
  const s = await setup({ desktop: false, dedupeSeconds: 0 })
  await turn(s, 60_000, "x", "aborted")
  expect(s.bodies()).toEqual([])
  await turn(s, 60_000, "x", "error")
  expect(s.bodies()).toEqual(["Failed after 1m 00s: HTTP 500 from provider"])
})

test("nothing while the terminal has focus; again once it is in the background", async () => {
  const s = await setup({ desktop: false, dedupeSeconds: 0 })
  await s.emit("ui.focus", { focused: true }, { sessionId: "host" })
  await turn(s, 60_000)
  expect(s.bodies()).toEqual([])
  await s.emit("ui.focus", { focused: false }, { sessionId: "host" })
  await turn(s, 60_000)
  expect(s.bodies()).toHaveLength(1)
})

test('"always" notifies while focused too; preview off keeps the reply out', async () => {
  const s = await setup({ desktop: false, when: "always", preview: false })
  await s.emit("ui.focus", { focused: true }, { sessionId: "host" })
  await turn(s, 60_000, "secret plans")
  expect(s.bodies()).toEqual(["Done after 1m 00s"])
})

test("a question left open notifies after the delay; one answered first does not", async () => {
  const s = await setup({ desktop: false })
  await s.emit(
    "ui.request",
    { kind: "confirm", title: "Run rm -rf build?", requestId: "r1" },
    { sessionId: "host" },
  )
  s.t.advance(1_000)
  await s.emit("ui.resolved", { requestId: "r1", cancelled: false, value: true }, { sessionId: "host" })
  s.t.advance(5_000)
  await s.settle()
  expect(s.bodies()).toEqual([])
  await s.emit(
    "ui.request",
    { kind: "select", title: "Which model?", options: ["a"], requestId: "r2" },
    { sessionId: "host" },
  )
  s.t.advance(2_000)
  await s.settle()
  expect(s.bodies()).toEqual(["Waiting for your answer: Which model?"])
})

test("background sub-agents: told when the main session is idle, batched; with the turn when it is busy", async () => {
  const s = await setup({ desktop: false })
  const start = (id: string, title: string, groupId?: string) =>
    s.emit("subagent.start", {
      childSessionId: id,
      role: "explorer",
      title,
      prompt: "p",
      model: { provider: "mock", model: "m" },
      depth: 1,
      cwd: "/w",
      context: "fresh",
      queued: false,
      ...(groupId ? { groupId } : {}),
    })
  const end = (id: string, status: "done" | "error" | "aborted" = "done") =>
    s.emit("subagent.end", {
      childSessionId: id,
      status,
      ...(status === "error" ? { error: "rate limited" } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never,
      durationMs: 42_000,
    })
  await start("c1", "Map the parser")
  await start("c2", "Read the tests")
  await start("c3", "Stopped one")
  await end("c1")
  await end("c2", "error")
  await end("c3", "aborted")
  // A sub-agent's own events are not the main session's turns.
  await s.emit("turn.start", { prompt }, { sessionId: "c1", parentSessionId: MAIN })
  expect(s.bodies()).toEqual([])
  s.t.advance(1_500)
  await s.settle()
  expect(s.bodies()).toEqual([
    "2 background tasks ended\n◆ Map the parser finished (42s)\n◆ Read the tests failed: rate limited",
  ])

  // While the main session is in a (short) turn, the result waits for its end.
  await start("c4", "Late one")
  const at = s.t.now()
  await s.emit("turn.start", { prompt }, { at })
  await end("c4")
  s.t.advance(3_000)
  await s.emit("turn.end", { reason: "done", steps: 1 }, { at: at + 3_000 })
  expect(s.bodies().at(-1)).toBe("◆ Late one finished (42s)")

  // Ending while idle, its result starts a turn at once (as a notice): the turn's end tells,
  // even when that turn is over before the batch would have gone out (print mode exits then).
  const count = s.bodies().length
  await start("c5", "Quick one")
  await end("c5")
  const at2 = s.t.now()
  await s.emit("turn.start", { prompt }, { at: at2 })
  s.t.advance(800)
  await s.emit("turn.end", { reason: "done", steps: 1 }, { at: at2 + 800 })
  expect(s.bodies().slice(count)).toEqual(["◆ Quick one finished (42s)"])
  s.t.advance(5_000)
  await s.settle()
  expect(s.bodies().slice(count)).toHaveLength(1)
})

test("workflows and swarms: their group's end, not each member's", async () => {
  const s = await setup({ desktop: false })
  const group: SpawnGroupInfo = {
    id: "g1",
    name: "workflow review",
    parentSessionId: MAIN,
    state: "ended",
    limits: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never,
    tokens: 0,
    agents: { total: 1 } as never,
    endReason: "the workflow finished",
  }
  await s.emit("group.start", { group })
  await s.emit("subagent.start", {
    childSessionId: "m1",
    title: "member",
    prompt: "p",
    model: { provider: "mock", model: "m" },
    depth: 1,
    cwd: "/w",
    context: "fresh",
    queued: false,
    groupId: "g1",
  })
  await s.emit("subagent.end", {
    childSessionId: "m1",
    status: "done",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never,
    durationMs: 1,
  })
  await s.emit("group.end", { group })
  s.t.advance(1_500)
  await s.settle()
  expect(s.bodies()).toEqual(["◆ workflow review: the workflow finished"])
})

test("/notify off mutes the session and shows in the status bar; /notify on undoes it", async () => {
  const s = await setup({ desktop: false, dedupeSeconds: 0 })
  const status = () => s.host.status.snapshot().find((i) => i.id === "notify")?.text
  expect(status()).toBeUndefined()
  expect((await s.command("off"))[0]!.text).toBe("Notifications off for this session.")
  expect(status()).toBe("notify off")
  await turn(s, 60_000)
  expect(s.bodies()).toEqual([])
  await s.command("on")
  expect(status()).toBeUndefined()
  await turn(s, 60_000)
  expect(s.bodies()).toHaveLength(1)
})

test("/notify shows the setup; /notify test sends through every channel past the gates", async () => {
  const s = await setup({
    webhooks: [
      { type: "json", urlEnv: "HOOK" },
      { type: "discord", urlEnv: "NOPE" },
    ],
  })
  await s.emit("ui.focus", { focused: true }, { sessionId: "host" })
  const shown = (await s.command(""))[0]!.text
  expect(shown).toContain(
    "Notifications are on, only while the terminal is in the background (the terminal has focus now).",
  )
  expect(shown).toContain(
    "For: turns longer than 30s, questions left open 2s, background agents, workflows and swarms ending.",
  )
  expect(shown).toContain("  desktop (notify-send)\n  json webhook\n  discord - not ready: NOPE is not set")
  const out = await s.command("test")
  expect(out[0]).toEqual({
    text: "Some channels failed (tests ignore focus, limits and /notify off):\n  desktop (notify-send): sent\n  json webhook: sent\n  discord: failed - NOPE is not set",
    level: "warning",
  })
  expect(s.f.calls[0]!.body.kind).toBe("test")
  expect(s.run.calls).toHaveLength(1)
  // Tests report in the command's output, not as extension errors.
  expect(s.errors).toEqual([])
  await expect(s.command("bogus")).rejects.toThrow("usage: /notify [test | on | off]")
})

test("with no channel, /notify test says so", async () => {
  const s = await setup({ desktop: false, webhooks: [] })
  const out = await s.command("test")
  expect(out[0]!.text).toContain("No channel: the desktop is off and no webhook is set up.")
  expect(out[0]!.level).toBe("warning")
})

test("bad settings are reported as extension errors, without the secret", async () => {
  const s = await setup({
    when: "sometimes",
    webhooks: [{ type: "discord", url: "https://discord.com/api/webhooks/SECRET" }],
  })
  await s.settle()
  expect(s.errors).toHaveLength(2)
  expect(s.errors.join("\n")).not.toContain("SECRET")
})

test("a webhook that keeps failing is reported once", async () => {
  const s = await setup({ desktop: false, dedupeSeconds: 0 }, {})
  await turn(s, 60_000)
  await turn(s, 60_000)
  expect(s.errors).toEqual(["notify: json webhook failed: HOOK is not set"])
})
