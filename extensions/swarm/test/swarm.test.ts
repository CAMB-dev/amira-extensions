import { expect, setDefaultTimeout, test } from "bun:test"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import {
  type AnyEvent,
  type Budget,
  type CommandContext,
  defineTool,
  type Settings,
  type ToolDefinition,
  textResult,
} from "@amira/api"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { Blackboard } from "../src/blackboard.ts"
import { createSwarmSource } from "../src/dashboard.ts"
import {
  createSwarmExtension,
  DATA_KEY,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_LIMITS,
  readSettings,
  type SwarmLimits,
} from "../src/index.ts"
import { type MemberSpec, Swarm, type SwarmRecord, swarmsFromRecords } from "../src/swarm.ts"
import { timelineLine } from "../src/view.ts"

setDefaultTimeout(30_000)

/** Who a request is from: a member by the name in its system prompt, or the commander. */
const who = (req: ModelRequest) => /You are "([\w-]+)"/.exec(req.systemPrompt)?.[1] ?? "commander"
const textOf = (m: ModelRequest["messages"][number] | undefined) =>
  m?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? ""
const lastText = (req: ModelRequest) => textOf(req.messages.at(-1))
const lastIsResult = (req: ModelRequest) => req.messages.at(-1)?.role === "toolResult"
/** Every text the member's model has been sent from others, in order. */
const inbox = (req: ModelRequest) =>
  req.messages
    .filter((m) => m.role === "user")
    .map(textOf)
    .join("\n")
const send = (to: string, text: string) => ({ name: "send_message", args: { to, text } })
const write = (key: string, value: string) => ({ name: "blackboard_write", args: { key, value } })

async function until(done: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

function makeAi(reply: (req: ModelRequest) => MockReply) {
  const mock = createMockDialect()
  for (let i = 0; i < 400; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  return { ai, mock }
}

/** A swarm run straight on an agent tree, without the extension around it. */
function direct(
  reply: (req: ModelRequest) => MockReply,
  members: MemberSpec[],
  limits: Partial<SwarmLimits> = {},
  hooks: ConstructorParameters<typeof Swarm>[0]["hooks"] = {},
  opts: { tools?: ToolDefinition[]; maxConcurrent?: number; budget?: Budget } = {},
) {
  const { ai, mock } = makeAi(reply)
  const bus = new EventBus()
  const tree = new AgentTree({
    ai,
    sections: () => [{ name: "identity", text: "child" }],
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
  })
  const tools = new ToolRegistry()
  for (const t of opts.tools ?? []) tools.register(t, "test")
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "commander",
    bus,
    tree,
    tools,
  })
  const group = tree.createGroup(root, { name: "swarm", ...(opts.budget ? { budget: opts.budget } : {}) })
  const records: SwarmRecord[] = []
  const swarm = new Swarm({
    id: "sw1",
    goal: "test goal",
    members,
    limits: { ...DEFAULT_LIMITS, ...limits },
    group,
    hooks: { record: (r) => void records.push(r), ...hooks },
  })
  return { swarm, mock, tree, records, root }
}

const pair: MemberSpec[] = [
  { name: "a", role: "one", brief: "talk to b" },
  { name: "b", role: "two", brief: "answer a" },
]

/** The tool results `member` got for its calls of `tool`. */
function results(mock: ReturnType<typeof makeAi>["mock"], member: string, tool = "send_message") {
  const out = new Set<string>()
  for (const req of mock.requests) {
    if (who(req) !== member) continue
    for (const m of req.messages)
      if (m.role === "toolResult" && m.toolName === tool) out.add(`${m.isError ? "ERR " : ""}${textOf(m)}`)
  }
  return [...out]
}

async function withExtension(reply: (req: ModelRequest) => MockReply, settings: Settings) {
  const { ai, mock } = makeAi(reply)
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: process.cwd(), settings })
  expect(await host.load(createSwarmExtension(), "pkg:swarm")).toBe(true)
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const root = new Agent({
    ai,
    model: ai.model("mock/big"),
    cwd: process.cwd(),
    systemPrompt: "commander",
    bus,
    interceptors,
    tools,
    tree,
  })
  return { root, mock, events, host, tree, bus }
}

/** Runs `/swarm <text>` as a frontend would; returns what it printed. */
async function command(host: ExtensionHost, root: Agent, text: string): Promise<string[]> {
  const printed: string[] = []
  const ctx = {
    print: (t: string) => void printed.push(t),
    session: { data: root.data },
  } as unknown as CommandContext
  await host.commands.get("swarm")!.def.run(text, ctx)
  return printed
}

/** Answers every dialog the extensions open with `answer(title)`. */
function answerDialogs(host: ExtensionHost, bus: EventBus, answer: (title: string) => unknown) {
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request") return
      const title = "title" in e.data ? String(e.data.title) : ""
      setTimeout(() => host.ui.respond(e.data.requestId, answer(title)), 0)
    },
    { types: ["ui.request"] },
  )
}

/** Records every confirmation and answers it with `answer()` (undefined: nobody answers). */
function confirmations(host: ExtensionHost, bus: EventBus, answer: () => boolean | undefined) {
  const seen: { title: string; message: string }[] = []
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request" || e.data.kind !== "confirm") return
      seen.push({ title: e.data.title, message: e.data.message ?? "" })
      const v = answer()
      setTimeout(() => host.ui.respond(e.data.requestId, v ?? null), 0)
    },
    { types: ["ui.request"] },
  )
  return seen
}

const lastResult = (root: Agent) => textOf(root.messages.filter((m) => m.role === "toolResult").at(-1))

const roster3 = [
  { name: "planner", role: "planner", brief: "Write a plan to the blackboard and tell the researcher." },
  { name: "researcher", role: "researcher", brief: "Research what the plan asks and tell the writer." },
  { name: "writer", role: "writer", brief: "Write the answer from the findings." },
]

/** Three members that pass the work along through the blackboard and messages. */
function threeMembers(req: ModelRequest): MockReply {
  const me = who(req)
  if (lastIsResult(req)) return { text: `${me} done for now` }
  const text = lastText(req)
  if (me === "planner" && !text.includes("[message from")) {
    return {
      toolCalls: [write("plan", "1. find facts 2. write"), send("researcher", "plan is on the board")],
    }
  }
  if (me === "researcher" && text.includes("[message from planner]")) {
    return { toolCalls: [write("findings", "the sky is blue"), send("writer", "findings ready")] }
  }
  if (
    me === "writer" &&
    (text.includes("[message from researcher]") || text.includes("[message from the user]"))
  ) {
    return {
      toolCalls: [
        { name: "blackboard_read", args: {} },
        write("answer", text.includes("shorter") ? "Blue." : "The sky is blue."),
        { name: "finish", args: { result: "answer written" } },
      ],
    }
  }
  return { text: `${me} idle`, delayMs: 5 }
}

test("three members coordinate on the blackboard; the commander gets the report once all are idle", async () => {
  const { root, mock, events } = await withExtension(
    (req) => {
      if (who(req) !== "commander") return threeMembers(req)
      const last = req.messages.at(-1)
      if (last?.role === "toolResult") return { text: "started, waiting" }
      if (textOf(last).includes("ended:")) return { text: "final answer: The sky is blue." }
      return {
        toolCalls: [
          { name: "swarm", args: { action: "start", goal: "Why is the sky blue?", members: roster3 } },
        ],
      }
    },
    { extensions: { swarm: { confirm: false } } },
  )
  await root.prompt("Use a swarm to answer: why is the sky blue?")
  expect(textOf(root.messages.find((m) => m.role === "toolResult"))).toContain("Started swarm")
  await until(() => root.messages.some((m) => m.role === "assistant" && textOf(m).includes("final answer")))

  const report = root.messages.find((m) => m.role === "user" && m.display?.origin === "swarm")!
  const text = textOf(report)
  expect(report.role === "user" && report.display!.text).toContain("every member is idle")
  expect(text).toContain("## plan (by planner)")
  expect(text).toContain("## findings (by researcher)")
  expect(text).toContain("## answer (by writer)")
  expect(text).toMatch(/writer \(writer\) · finished · \d+ turns/)
  expect(text).toContain("answer written")
  // The researcher and the writer slept after their first turn and were woken by a message.
  const starts = events.filter((e) => e.type === "subagent.state" && e.data.state === "working")
  expect(starts.length).toBeGreaterThanOrEqual(5)
  // The messages went out in the order the work flowed.
  const writerReq = mock.requests.find((r) => who(r) === "writer" && lastText(r).includes("findings ready"))
  expect(writerReq).toBeDefined()
  // Everything the swarm did is in the session, and reads back.
  const [past] = swarmsFromRecords(root.data.read(DATA_KEY))
  expect(past!.board.map((e) => e.key)).toEqual(["plan", "findings", "answer"])
  expect(past!.members.find((m) => m.name === "writer")!.result).toBe("answer written")
  expect(past!.timeline.filter((e) => e.kind === "message").map((e) => `${e.from}>${e.to}`)).toEqual([
    "planner>researcher",
    "researcher>writer",
  ])
  expect(past!.endReason).toContain("idle")
})

test("messages reach a member in the order they were sent", async () => {
  const { swarm, mock } = direct((req) => {
    const me = who(req)
    if (lastIsResult(req)) return { text: "ok" }
    if (me === "a" && !lastText(req).includes("[message")) {
      return { toolCalls: [send("b", "one"), send("b", "two"), send("b", "three")] }
    }
    return { text: "fine", delayMs: 5 }
  }, pair)
  const report = await swarm.done
  const seen = inbox(mock.requests.filter((r) => who(r) === "b").at(-1)!)
  expect(seen.indexOf("one")).toBeGreaterThan(-1)
  expect(seen.indexOf("one")).toBeLessThan(seen.indexOf("two"))
  expect(seen.indexOf("two")).toBeLessThan(seen.indexOf("three"))
  expect(report.messages).toBe(3)
  expect(report.reason).toContain("idle")
})

test("a message held for a paused member keeps the swarm from ending until it is resumed and read", async () => {
  let aDone = false
  const { swarm, mock } = direct((req) => {
    const me = who(req)
    if (lastIsResult(req)) {
      if (me === "a") aDone = true
      return { text: "ok" }
    }
    if (me === "a" && !lastText(req).includes("[message"))
      return { toolCalls: [send("b", "please answer")], delayMs: 20 }
    return { text: `${me} idle` }
  }, pair)
  expect(swarm.pause("b")).toBeUndefined()
  expect(swarm.member("b")!.status).toBe("paused")
  await until(() => aDone)
  // Both are idle, but a message is still on its way to b.
  await until(() => swarm.snapshot().members.every((m) => m.status !== "working" && m.status !== "queued"))
  await Bun.sleep(50)
  expect(swarm.state).toBe("running")
  expect(mock.requests.some((r) => who(r) === "b" && lastText(r).includes("please answer"))).toBe(false)
  expect(swarm.resume("b")).toBeUndefined()
  const report = await swarm.done
  expect(mock.requests.some((r) => who(r) === "b" && lastText(r).includes("please answer"))).toBe(true)
  expect(report.members.find((m) => m.name === "b")!.turns).toBe(2)
  expect(report.undelivered).toBe(0)
})

test("a message to an idle member wakes it before the swarm can end", async () => {
  // a takes long enough that b has gone idle before a's message comes.
  const { swarm, mock } = direct((req) => {
    const me = who(req)
    if (lastIsResult(req)) return { text: "ok" }
    if (me === "a" && !lastText(req).includes("[message"))
      return { toolCalls: [send("b", "wake up")], delayMs: 60 }
    return { text: `${me} idle` }
  }, pair)
  const states: string[] = []
  const timer = setInterval(() => states.push(swarm.member("b")!.status), 5)
  const report = await swarm.done
  clearInterval(timer)
  expect(states).toContain("idle")
  expect(report.members.find((m) => m.name === "b")!.turns).toBe(2)
  expect(mock.requests.some((r) => who(r) === "b" && lastText(r).includes("wake up"))).toBe(true)
})

test("per-member, per-pair and swarm message caps", async () => {
  // Per member: the third message is refused.
  const one = direct(
    (req) => {
      if (lastIsResult(req)) return { text: "ok" }
      if (who(req) === "a" && !lastText(req).includes("[message"))
        return { toolCalls: [send("b", "1"), send("b", "2"), send("b", "3")] }
      return { text: "idle" }
    },
    pair,
    { maxMessagesPerMember: 2 },
  )
  await one.swarm.done
  expect(results(one.mock, "a").filter((r) => r.startsWith("ERR"))).toEqual([
    "ERR You have sent all 2 messages a member may send. Put what is left on the blackboard, or call finish.",
  ])

  // Per pair: a ping-pong without blackboard writes is cut off.
  const two = direct(
    (req) => {
      const me = who(req)
      const other = me === "a" ? "b" : "a"
      if (lastIsResult(req)) return { text: "ok" }
      if (me === "a" && !lastText(req).includes("[message")) return { toolCalls: [send("b", "ping")] }
      if (lastText(req).includes("[message")) return { toolCalls: [send(other, "pong")] }
      return { text: "idle" }
    },
    pair,
    { maxPairExchanges: 3 },
  )
  const r2 = await two.swarm.done
  expect(r2.messages).toBe(3)
  expect(
    [...results(two.mock, "a"), ...results(two.mock, "b")].some((r) =>
      r.includes("have exchanged 3 messages"),
    ),
  ).toBe(true)

  // For the swarm: going over ends it.
  const three = direct(
    (req) => {
      if (lastIsResult(req)) return { text: "ok" }
      if (who(req) === "a" && !lastText(req).includes("[message"))
        return { toolCalls: [send("b", "1"), send("b", "2"), send("b", "3")] }
      return { text: "idle" }
    },
    pair,
    { maxMessages: 2 },
  )
  const r3 = await three.swarm.done
  expect(r3.reason).toBe("the members sent the 2 messages a swarm may send")
  expect(
    results(three.mock, "a").some((r) => r.startsWith("ERR The swarm has reached its message limit")),
  ).toBe(true)
})

test("a member ends after its turn limit, and the swarm ends when every member did", async () => {
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok" }
      if (me === "a" && !lastText(req).includes("[message")) return { toolCalls: [send("b", "ping")] }
      if (lastText(req).includes("[message")) return { toolCalls: [send(me === "a" ? "b" : "a", "pong")] }
      return { text: "idle" }
    },
    pair,
    { maxTurnsPerMember: 2, maxPairExchanges: 100, noProgressRounds: 100 },
  )
  const report = await swarm.done
  expect(report.members.map((m) => m.turns)).toEqual([2, 2])
  expect(report.members.some((m) => m.note === "reached its limit of 2 turns")).toBe(true)
})

test("rounds of chatter without progress pause the swarm and ask the user", async () => {
  const asked: string[] = []
  let answers = ["continue", "stop"] as ("continue" | "stop")[]
  let wroteOnce = false
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok" }
      if (me === "a" && !lastText(req).includes("[message")) return { toolCalls: [send("b", "ping")] }
      if (lastText(req).includes("[message")) {
        // One real piece of progress early on resets the count once.
        if (me === "b" && !wroteOnce) {
          wroteOnce = true
          return { toolCalls: [write("note", "x"), send("a", "pong")] }
        }
        return { toolCalls: [send(me === "a" ? "b" : "a", "pong")] }
      }
      return { text: "idle" }
    },
    pair,
    { noProgressRounds: 2, maxPairExchanges: 1000 },
    {
      askStuck: async (q) => {
        asked.push(q)
        expect(swarm.state).toBe("paused")
        return answers.shift()
      },
    },
  )
  const report = await swarm.done
  expect(asked.length).toBe(2)
  expect(asked[0]).toContain("went 2 rounds with messages but no blackboard change")
  expect(report.reason).toBe("no progress in 2 rounds")
  answers = []
})

test("nobody to ask about a stuck swarm stops it", async () => {
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok" }
      if (me === "a" && !lastText(req).includes("[message")) return { toolCalls: [send("b", "ping")] }
      if (lastText(req).includes("[message")) return { toolCalls: [send(me === "a" ? "b" : "a", "pong")] }
      return { text: "idle" }
    },
    pair,
    { noProgressRounds: 1, maxPairExchanges: 1000 },
  )
  expect((await swarm.done).reason).toBe("no progress in 1 round")
})

test("the user messages a member with @name; the swarm counts it as progress, not against caps", async () => {
  let gate = true
  const { root, mock, host } = await withExtension(
    (req) => {
      const me = who(req)
      if (me === "commander") {
        return req.messages.at(-1)?.role === "toolResult" || textOf(req.messages.at(-1)).includes("ended:")
          ? { text: "ok" }
          : { toolCalls: [{ name: "swarm", args: { action: "start", goal: "sky", members: roster3 } }] }
      }
      // The planner keeps the swarm alive until the user has spoken.
      if (me === "planner" && !lastIsResult(req) && gate) return { text: "thinking", delayMs: 40 }
      if (me === "planner") return { text: "planner idle" }
      return threeMembers(req)
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  await root.prompt("go")
  const printed: string[] = []
  const ctx = { print: (t: string) => void printed.push(t) } as unknown as CommandContext
  const handler = host.inputs.claim("@writer make it shorter")!
  expect(handler?.name).toBe("swarm")
  expect(host.inputs.claim("@nobody hi")).toBeUndefined()
  expect(host.inputs.claim("hello @writer")).toBeUndefined()
  await handler.run("@writer make it shorter", ctx)
  gate = false
  expect(printed).toEqual(["✉️ you → writer"])
  await until(() => root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm"))
  const writerSaw = mock.requests.find(
    (r) => who(r) === "writer" && lastText(r).includes("[message from the user] make it shorter"),
  )
  expect(writerSaw).toBeDefined()
  const [past] = swarmsFromRecords(root.data.read(DATA_KEY))
  expect(past!.board.find((e) => e.key === "answer")!.value).toBe("Blue.")
  expect(past!.timeline.find((e) => e.kind === "message")).toMatchObject({ from: "user", to: "writer" })
  // Once it ended, @lines go to the model again.
  expect(host.inputs.claim("@writer again")).toBeUndefined()
})

test("the model may propose a swarm: the confirmation, marked as its proposal, is the gate", async () => {
  const { root, host, bus } = await withExtension((req) => {
    if (who(req) !== "commander") return { text: "member idle" }
    if (req.messages.at(-1)?.role === "toolResult" || textOf(req.messages.at(-1)).includes("ended:"))
      return { text: "ok" }
    return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "Check the sky", members: pair } }] }
  }, {})
  const seen = confirmations(host, bus, () => true)
  await root.prompt("answer this for me")
  expect(lastResult(root)).toContain("Started swarm")
  expect(seen).toHaveLength(1)
  expect(seen[0]!.title).toBe("Start a swarm of 2 agents?")
  const lines = seen[0]!.message.split("\n")
  expect(lines[0]).toBe("The model proposes this swarm.")
  expect(lines[1]).toBe("Goal: Check the sky")
  expect(seen[0]!.message).toContain("  a (one): talk to b")
  expect(seen[0]!.message).toContain("  b (two): answer a")
  expect(seen[0]!.message).toContain(
    "Agents: 2, all at once; each works up to 20 turns and sends up to 30 messages (150 in all).",
  )
  expect(seen[0]!.message).toContain("Cost: stops at 3,000,000 tokens.")
  expect(seen[0]!.message).toContain(
    "Files: the members work in your working tree and can change your files.",
  )
  await until(() => root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm"))
})

test("a declined goal is not proposed again until the user asks; another goal may be", async () => {
  let turn = 0
  const goals = ["g", "g", "G  ", "another goal", "g"]
  const { root, host, bus } = await withExtension((req) => {
    if (who(req) !== "commander") return { text: "member idle" }
    const last = req.messages.at(-1)
    if (last?.role === "toolResult" || textOf(last).includes("ended:")) return { text: "ok" }
    const goal = goals[turn++]!
    return { toolCalls: [{ name: "swarm", args: { action: "start", goal, members: pair } }] }
  }, {})
  const seen = confirmations(host, bus, () => false)
  const told: string[] = []
  bus.subscribe((e) => {
    if (e.type === "extension.notice") told.push(e.data.text)
  })
  // Asked for with /swarm: marked as the user's, and declined.
  await root.prompt({
    role: "user",
    content: [{ type: "text", text: "Use a swarm (the swarm tool) for this task: g" }],
    display: { text: "/swarm g" },
  })
  expect(seen.map((c) => c.message.split("\n")[0])).toEqual(["You asked for this swarm."])
  expect(lastResult(root)).toMatch(/^The user declined the swarm, so it did not start\. Do not propose/)
  // The model tries the same goal again, and reworded: refused without asking.
  await root.prompt("ok, go on")
  expect(lastResult(root)).toContain("already declined a swarm for this goal")
  await root.prompt("go on")
  expect(lastResult(root)).toContain("already declined a swarm for this goal")
  expect(seen).toHaveLength(1)
  // Another goal may be proposed.
  await root.prompt("next")
  expect(seen).toHaveLength(2)
  expect(seen[1]!.message.split("\n")[0]).toBe("The model proposes this swarm.")
  // Declining the model's proposal tells the user how to start it themselves.
  await bus.flush()
  expect(told).toEqual([
    "Swarm not started; it will not be proposed again for this goal in this session. To start it yourself, run /swarm another goal.",
  ])
  // The user asks for a swarm: the declined goal may be proposed again.
  await root.prompt("fine, use a swarm for g")
  expect(seen).toHaveLength(3)
  expect(seen[2]!.message.split("\n")[0]).toBe("You asked for this swarm.")
})

test("a decline uses up the user's ask; a new session forgets what was declined", async () => {
  const goals = ["Check the sky", "check the sky.", "Check the sky"]
  let turn = 0
  const { root, host, bus } = await withExtension((req) => {
    if (who(req) !== "commander") return { text: "member idle" }
    const last = req.messages.at(-1)
    if (last?.role === "toolResult" && turn === 1) {
      // Same turn, right after the decline: the model tries again, with a full stop added.
      turn++
      return { toolCalls: [{ name: "swarm", args: { action: "start", goal: goals[1], members: pair } }] }
    }
    if (last?.role === "toolResult" || textOf(last).includes("ended:")) return { text: "ok" }
    const goal = goals[turn === 0 ? 0 : 2]!
    turn = turn === 0 ? 1 : 3
    return { toolCalls: [{ name: "swarm", args: { action: "start", goal, members: pair } }] }
  }, {})
  const seen = confirmations(host, bus, () => false)
  await root.prompt("use a swarm to check the sky")
  expect(seen).toHaveLength(1)
  expect(lastResult(root)).toContain("already declined a swarm for this goal")
  bus.emit(
    "session.start",
    { reason: "clear", cwd: process.cwd(), model: { provider: "mock", model: "big" } },
    { sessionId: root.sessionId },
  )
  await root.prompt("hello again")
  expect(seen).toHaveLength(2)
})

test("with nobody to confirm (print mode) the tool refuses and says how to start it", async () => {
  let n = 0
  const { root, host, bus } = await withExtension((req) => {
    if (who(req) !== "commander") return { text: "member idle" }
    if (req.messages.at(-1)?.role === "toolResult") return { text: "ok" }
    n++
    return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "Check the sky", members: pair } }] }
  }, {})
  confirmations(host, bus, () => undefined)
  await root.prompt("answer this for me")
  const text = lastResult(root)
  expect(text).toContain("Nobody confirmed the swarm, so it did not start")
  expect(text).toContain("/swarm Check the sky")
  expect(text).toContain('extensions.swarm.enabled to "always"')
  expect(root.expectedNotices).toBe(0)
  await root.prompt("and again")
  expect(lastResult(root)).toContain("already declined")
  expect(n).toBe(2)
})

test('settings: "never" refuses the tool and /swarm; "always" starts without asking', async () => {
  const { root, host } = await withExtension(
    (req) => {
      if (req.messages.at(-1)?.role === "toolResult") return { text: "ok" }
      return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
    },
    { extensions: { swarm: { enabled: "never" } } },
  )
  await root.prompt("use a swarm")
  expect(lastResult(root)).toContain("turned off")
  await expect(command(host, root, "do it")).rejects.toThrow("turned off")
  const always = await withExtension(
    (req) => {
      if (who(req) !== "commander") return { text: "member idle" }
      if (req.messages.at(-1)?.role === "toolResult" || textOf(req.messages.at(-1)).includes("ended:"))
        return { text: "ok" }
      return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
    },
    { extensions: { swarm: { enabled: "always" } } },
  )
  const seen = confirmations(always.host, always.bus, () => false)
  await always.root.prompt("answer this")
  expect(lastResult(always.root)).toContain("Started swarm")
  expect(seen).toHaveLength(0)
  await until(() => always.root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm"))
})

test("no sub-agent, at any depth, is offered the swarm tool, even when it asks for it by name", async () => {
  const offered: string[][] = []
  const { root, tree } = await withExtension(
    (req) => {
      offered.push(req.tools.map((t) => t.name))
      return { text: "done" }
    },
    { extensions: { swarm: { confirm: false } } },
  )
  await tree.spawn(root, { prompt: "p", tools: ["swarm"] }).result()
  expect(offered.at(-1)).not.toContain("swarm")
  expect(root.tools.specs().map((t) => t.name)).toContain("swarm")
})
test("a roster that does not fit is refused", async () => {
  const { root } = await withExtension(
    (req) => {
      if (req.messages.at(-1)?.role === "toolResult") return { text: "ok" }
      return {
        toolCalls: [
          {
            name: "swarm",
            args: {
              action: "start",
              goal: "g",
              members: [
                { name: "commander", role: "x", brief: "y" },
                { name: "b", role: "x", brief: "y" },
              ],
            },
          },
        ],
      }
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  await root.prompt("swarm please")
  expect(textOf(root.messages.find((m) => m.role === "toolResult"))).toContain('"commander" is reserved')
})

test("the blackboard keeps an append-only log and reads back from it", () => {
  const board = new Blackboard()
  expect(board.write("a", "plan", "one").changed).toBe(true)
  expect(board.write("b", "plan", "two", { append: true }).entry.value).toBe("one\ntwo")
  expect(board.write("b", "plan", "one\ntwo").changed).toBe(false)
  board.write("a", "notes", "x")
  expect(board.log.map((w) => w.seq)).toEqual([1, 2, 3])
  const back = Blackboard.replay(board.log)
  expect(back.entries()).toEqual(board.entries())
  expect(() => board.write("a", "big", "x".repeat(30_000))).toThrow("keep it under")
})

test("settings: bad values are reported and ignored; a start can only lower the limits", () => {
  const problems: string[] = []
  const s = readSettings(
    {
      enabled: "sometimes",
      confirm: false,
      maxMembers: 1,
      limits: { maxMessages: 10, noProgressRounds: 0, budget: { tokens: 5000 } },
    },
    (p) => void problems.push(p),
  )
  // An unknown value is reported; the older confirm: false still skips the confirmation.
  expect(s.enabled).toBe("always")
  expect(s.maxMembers).toBe(6)
  expect(s.limits.maxMessages).toBe(10)
  expect(s.limits.noProgressRounds).toBe(DEFAULT_LIMITS.noProgressRounds)
  expect(s.limits.budget).toEqual({ tokens: 5000 })
  expect(problems.length).toBe(3)
  // Without settings a swarm still has a budget.
  expect(readSettings(undefined).limits.budget).toEqual({ tokens: DEFAULT_BUDGET_TOKENS })
  expect(readSettings(undefined).enabled).toBe("ask")
  // The older values: "explicit" is "ask"; confirm: false never overrides "never".
  const quiet: string[] = []
  expect(readSettings({ enabled: "explicit" }, (p) => void quiet.push(p)).enabled).toBe("ask")
  expect(readSettings({ enabled: "explicit", confirm: false }).enabled).toBe("always")
  expect(readSettings({ enabled: "never", confirm: false }).enabled).toBe("never")
  expect(readSettings({ confirm: true }).enabled).toBe("ask")
  expect(quiet).toEqual([])
})

// ---- review fixes ----

/** A tool that starts background work and ends at once; its result comes back as a notice. */
function backgroundTool(ms: number): ToolDefinition {
  return defineTool({
    name: "research_in_background",
    description: "starts work in the background",
    parameters: { type: "object", properties: {} },
    execute: async (_p, ctx) => {
      const notice = ctx.session!.expectNotice!()
      setTimeout(
        () =>
          notice.deliver({
            role: "user",
            content: [{ type: "text", text: "[background result] the sky is blue" }],
            display: { text: "background result", origin: "test" },
          }),
        ms,
      )
      return textResult("Started; the result comes back by itself. End your turn.")
    },
  })
}

test("a member waiting for its own background work keeps the swarm alive until the result comes", async () => {
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (me === "a" && lastText(req).includes("[background result]"))
        return {
          toolCalls: [write("findings", "the sky is blue"), { name: "finish", args: { result: "done" } }],
        }
      if (lastIsResult(req)) return { text: "waiting" }
      if (me === "a") return { toolCalls: [{ name: "research_in_background", args: {} }] }
      return { text: "b idle" }
    },
    pair,
    {},
    {},
    { tools: [backgroundTool(150)] },
  )
  const report = await swarm.done
  expect(report.reason).toContain("idle")
  expect(report.board.map((e) => e.key)).toEqual(["findings"])
  expect(report.members.find((m) => m.name === "a")).toMatchObject({
    status: "done",
    result: "done",
    turns: 2,
  })
})

test("a member that is stopping takes no more messages; nothing is lost silently", async () => {
  let aGo = false
  const { swarm, mock } = direct((req) => {
    const me = who(req)
    if (lastIsResult(req)) return { text: "ok" }
    if (me === "b") return { text: "b working", delayMs: 150 }
    if (me === "a" && aGo) return { toolCalls: [send("b", "findings ready")] }
    return { text: "a idle" }
  }, pair)
  await until(() => swarm.member("b")!.status === "working")
  expect(swarm.stopMember("b")).toBeUndefined()
  expect(swarm.stopMember("b")).toBe("b is stopping already.")
  expect(swarm.tell("user", "b", "hello")).toBe("b is stopping; it takes no more messages.")
  aGo = true
  expect(swarm.tell("user", "a", "tell b")).toBeUndefined()
  const report = await swarm.done
  expect(results(mock, "a")).toEqual(["ERR b is stopping; it cannot get messages any more."])
  expect(report.messages).toBe(0)
  expect(report.undelivered).toBe(0)
  expect(report.members.find((m) => m.name === "b")).toMatchObject({
    status: "done",
    note: "stopped by the user",
  })
})

test("a member whose turn fails ends with an error while the others go on", async () => {
  const { swarm, mock } = direct((req) => {
    const me = who(req)
    if (me === "b") return { error: { message: "model exploded" } }
    if (lastIsResult(req)) return { text: "ok" }
    if (me === "a" && !lastText(req).includes("[message")) return { text: "a first", delayMs: 60 }
    return { text: "idle" }
  }, pair)
  await until(() => swarm.member("b")!.status === "ended")
  expect(swarm.state).toBe("running")
  expect(swarm.tell("user", "a", "write it down")).toBeUndefined()
  const report = await swarm.done
  expect(report.members.find((m) => m.name === "b")).toMatchObject({ status: "error" })
  expect(report.members.find((m) => m.name === "a")).toMatchObject({ status: "done", turns: 2 })
  expect(mock.requests.some((r) => who(r) === "a" && lastText(r).includes("write it down"))).toBe(true)
  expect(swarm.snapshot().timeline.some((e) => e.text.includes("b failed"))).toBe(true)
})

test("a swarm over its budget ends, and says why", async () => {
  const usage = { input: 400 }
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok", usage }
      if (lastText(req).includes("[message"))
        return { toolCalls: [send(me === "a" ? "b" : "a", "more")], usage }
      if (me === "a") return { toolCalls: [send("b", "go")], usage }
      return { text: "idle", usage }
    },
    pair,
    { maxPairExchanges: 1000, noProgressRounds: 1000 },
    {},
    { budget: { tokens: 3000 } },
  )
  const report = await swarm.done
  expect(report.reason).toContain("ran out of budget")
  expect(report.tokens).toBeGreaterThanOrEqual(3000)
})

test("a message to a member waiting for a place to run still keeps the swarm alive", async () => {
  // One runs at a time, in roster order: b and c are idle by the time a writes to them, and
  // then wait for a place while a's turn still runs.
  const trio: MemberSpec[] = [pair[1]!, { name: "c", role: "three", brief: "answer a" }, pair[0]!]
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok", delayMs: 10 }
      if (me === "a" && !lastText(req).includes("[message"))
        return { toolCalls: [send("b", "one"), send("c", "two")], delayMs: 10 }
      return { text: `${me} idle`, delayMs: 10 }
    },
    trio,
    {},
    {},
    { maxConcurrent: 1 },
  )
  const queued: string[] = []
  const timer = setInterval(() => {
    for (const m of swarm.snapshot().members) if (m.status === "queued" && m.turns > 0) queued.push(m.name)
  }, 1)
  const report = await swarm.done
  clearInterval(timer)
  expect(queued.length).toBeGreaterThan(0)
  expect(report.members.map((m) => `${m.name}:${m.turns}`)).toEqual(["b:2", "c:2", "a:1"])
  expect(report.reason).toContain("idle")
})

test("a pause for lack of progress waits for its answer even with nothing on its way", async () => {
  let answered = false
  const { swarm } = direct(
    (req) => {
      const me = who(req)
      if (lastIsResult(req)) return { text: "ok" }
      if (me === "a" && !lastText(req).includes("[message")) return { toolCalls: [send("b", "ping")] }
      if (me === "b" && lastText(req).includes("[message")) return { toolCalls: [send("a", "pong")] }
      return { text: `${me} says nothing more` }
    },
    pair,
    { noProgressRounds: 1, maxPairExchanges: 1000 },
    {
      askStuck: async () => {
        // Both members go idle with nothing on its way while the user thinks.
        await until(() =>
          swarm.snapshot().members.every((m) => m.status !== "working" && m.status !== "queued"),
        )
        await Bun.sleep(60)
        expect(swarm.state).toBe("paused")
        answered = true
        return "stop"
      },
    },
  )
  const report = await swarm.done
  expect(answered).toBe(true)
  expect(report.reason).toBe("no progress in 1 round")
})

test("the commander's replies count and are no progress: a member-commander loop stops", async () => {
  let commanderTurns = 0
  const { root, host, bus } = await withExtension(
    (req) => {
      const me = who(req)
      const last = req.messages.at(-1)
      if (me === "commander") {
        if (last?.role === "toolResult") return { text: "ok" }
        const text = textOf(last)
        if (text.includes("ended:")) return { text: "done" }
        const asked = /message from (\w+)\]/.exec(text)
        if (asked) {
          commanderTurns++
          return {
            toolCalls: [{ name: "swarm", args: { action: "message", to: asked[1], text: "answer" } }],
          }
        }
        return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
      }
      if (lastIsResult(req)) return { text: "asked" }
      if (me === "a") return { toolCalls: [send("commander", "a question?")] }
      return { text: "b idle" }
    },
    {
      extensions: {
        swarm: {
          confirm: false,
          enabled: "always",
          limits: { noProgressRounds: 2, maxPairExchanges: 1000 },
        },
      },
    },
  )
  const asked: string[] = []
  answerDialogs(host, bus, (title) => {
    asked.push(title)
    return "Stop the swarm"
  })
  await root.prompt("start")
  const ended = () => root.messages.findLast((m) => m.role === "user" && textOf(m).includes("ended:"))
  await until(() => ended() !== undefined)
  expect(textOf(ended())).toContain("ended: no progress in 2 rounds")
  expect(asked.length).toBe(1)
  expect(commanderTurns).toBeLessThan(6)
})

test("the commander's messages are refused past the pair limit; the user's never", async () => {
  const { swarm } = direct(
    (req) => (lastIsResult(req) ? { text: "ok" } : { text: `${who(req)} idle`, delayMs: 30 }),
    pair,
    { maxPairExchanges: 2 },
  )
  expect(swarm.tell("commander", "a", "one")).toBeUndefined()
  expect(swarm.tell("commander", "a", "two")).toBeUndefined()
  expect(swarm.tell("commander", "a", "three")).toContain("have exchanged 2 messages")
  expect(swarm.tell("user", "a", "the user may always")).toBeUndefined()
  expect(swarm.snapshot().messages).toBe(2)
  await swarm.stop()
})

test("/clear during a swarm stops it without waking the old conversation", async () => {
  const { root, mock, bus, events } = await withExtension(
    (req) => {
      if (who(req) !== "commander") return { text: `${who(req)} working`, delayMs: 30 }
      if (req.messages.at(-1)?.role === "toolResult") return { text: "started" }
      return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  root.start("startup")
  await root.prompt("go")
  const before = mock.requests.filter((r) => who(r) === "commander").length
  bus.emit(
    "session.start",
    { reason: "clear", cwd: process.cwd(), model: { provider: "mock", model: "big" } },
    { sessionId: "s_after_clear" },
  )
  await until(() => events.filter((e) => e.type === "subagent.end").length === 2)
  await Bun.sleep(50)
  expect(mock.requests.filter((r) => who(r) === "commander").length).toBe(before)
  expect(root.expectedNotices).toBe(0)
  expect(root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm")).toBe(false)
  const [past] = swarmsFromRecords(root.data.read(DATA_KEY))
  expect(past!.endReason).toBe("its session was closed")
})

test("/swarm commands and the commander's tool actions steer a running swarm", async () => {
  let release = false
  const { root, host, mock } = await withExtension(
    (req) => {
      const me = who(req)
      if (me === "commander") {
        const last = req.messages.at(-1)
        if (last?.role === "toolResult") return { text: "ok" }
        const text = textOf(last)
        if (text.includes("ended:")) return { text: "done" }
        if (text === "stop it") return { toolCalls: [{ name: "swarm", args: { action: "stop" } }] }
        if (text === "tell a")
          return {
            toolCalls: [{ name: "swarm", args: { action: "message", to: "a", text: "from the top" } }],
          }
        if (text === "status") return { toolCalls: [{ name: "swarm", args: { action: "status" } }] }
        return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
      }
      if (lastIsResult(req)) return { text: "ok" }
      // b keeps the swarm alive until the test lets it go.
      if (me === "b" && !release) return { text: "b busy", delayMs: 400 }
      return { text: `${me} idle` }
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  await root.prompt("start")
  expect(await command(host, root, "pause a")).toEqual(["Paused a."])
  expect(await command(host, root, "msg a hello there")).toEqual(["✉️ you → a (held until it is resumed)"])
  await Bun.sleep(30)
  const got = (text: string) => mock.requests.some((r) => who(r) === "a" && lastText(r).includes(text))
  expect(got("hello there")).toBe(false)
  expect(await command(host, root, "resume a")).toEqual(["Resumed a."])
  await until(() => got("[message from the user] hello there"))
  await root.prompt("tell a")
  await until(() => got("[message from the commander] from the top"))
  await root.prompt("status")
  expect(textOf(root.messages.filter((m) => m.role === "toolResult").at(-1))).toContain("Members:")
  expect((await command(host, root, "list"))[0]).toMatch(/running · a, b · g/)
  await expect(command(host, root, "stop nobody")).rejects.toThrow('No member "nobody"')
  await root.prompt("stop it")
  await until(() =>
    root.messages.some((m) => m.role === "user" && textOf(m).includes("ended: stopped by the commander")),
  )
  release = true
  await expect(command(host, root, "stop")).rejects.toThrow("no swarm is running")
})

test("@all from the input box reaches every member; the timeline keeps it once", async () => {
  let gate = true
  const { root, mock, host } = await withExtension(
    (req) => {
      const me = who(req)
      if (me === "commander") {
        return req.messages.at(-1)?.role === "toolResult" || textOf(req.messages.at(-1)).includes("ended:")
          ? { text: "ok" }
          : { toolCalls: [{ name: "swarm", args: { action: "start", goal: "sky", members: roster3 } }] }
      }
      if (lastIsResult(req)) return { text: "ok" }
      // The planner keeps the swarm alive until the user has spoken.
      if (me === "planner" && gate) return { text: "thinking", delayMs: 40 }
      return { text: `${me} idle` }
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  await root.prompt("go")
  const printed: string[] = []
  const ctx = { print: (t: string) => void printed.push(t) } as unknown as CommandContext
  const handler = host.inputs.claim("@all check in")!
  expect(handler?.name).toBe("swarm")
  expect(host.inputs.claim("@ALL: check in")?.name).toBe("swarm")
  // "@all" with nothing after it is no message: it goes to the model.
  expect(host.inputs.claim("@all")).toBeUndefined()
  await handler.run("@all check in", ctx)
  gate = false
  expect(printed).toEqual(["✉️ you → all (3 members)"])
  await until(() => root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm"))
  for (const name of ["planner", "researcher", "writer"]) {
    const saw = mock.requests.filter(
      (r) => who(r) === name && inbox(r).includes("[message from the user, to every member] check in"),
    )
    expect(saw.length).toBeGreaterThan(0)
  }
  const [past] = swarmsFromRecords(root.data.read(DATA_KEY))
  const messages = past!.timeline.filter((e) => e.kind === "message")
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ from: "user", to: "all", text: "check in" })
  expect(timelineLine(messages[0]!).text).toMatch(/✉️ you → all: check in$/)
  // Once it ended, @all goes to the model again.
  expect(host.inputs.claim("@all again")).toBeUndefined()
})

test("/swarm msg all reaches every member; a paused one gets it on resume", async () => {
  let release = false
  const { root, host, mock } = await withExtension(
    (req) => {
      const me = who(req)
      if (me === "commander") {
        const last = req.messages.at(-1)
        if (last?.role === "toolResult") return { text: "ok" }
        if (textOf(last).includes("ended:")) return { text: "done" }
        if (textOf(last) === "stop it") return { toolCalls: [{ name: "swarm", args: { action: "stop" } }] }
        return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
      }
      if (lastIsResult(req)) return { text: "ok" }
      // b keeps the swarm alive until the test lets it go.
      if (me === "b" && !release) return { text: "b busy", delayMs: 100 }
      return { text: `${me} idle` }
    },
    { extensions: { swarm: { confirm: false, enabled: "always" } } },
  )
  await root.prompt("start")
  const complete = host.commands.get("swarm")!.def.args!.complete!
  expect((await complete("", {} as never)).map((c) => c.value)).toContain("msg all ")
  expect(await command(host, root, "pause a")).toEqual(["Paused a."])
  expect(await command(host, root, "msg all hello everyone")).toEqual(["✉️ you → all (2 members)"])
  const got = (name: string) =>
    mock.requests.some((r) => who(r) === name && lastText(r).includes("to every member] hello everyone"))
  await until(() => got("b"))
  expect(got("a")).toBe(false)
  expect(await command(host, root, "resume a")).toEqual(["Resumed a."])
  await until(() => got("a"))
  const snap = swarmsFromRecords(root.data.read(DATA_KEY))[0]!
  expect(snap.timeline.filter((e) => e.kind === "message").map((e) => `${e.from}>${e.to}`)).toEqual([
    "user>all",
  ])
  // Empty text is refused, and a bare "msg all" is a usage error.
  await expect(command(host, root, "msg all   ")).rejects.toThrow("The message is empty.")
  await expect(command(host, root, "msg all")).rejects.toThrow("usage: /swarm msg <name|all> <text>")
  await root.prompt("stop it")
  await until(() => root.messages.some((m) => m.role === "user" && textOf(m).includes("ended:")))
  release = true
  await expect(command(host, root, "msg all hi")).rejects.toThrow("no swarm is running")
})

test("a message to all goes to the members that can still get it, and says when none can", async () => {
  const { swarm, records } = direct((req) => {
    if (lastIsResult(req)) return { text: "ok" }
    return { text: `${who(req)} busy`, delayMs: 200 }
  }, pair)
  expect(swarm.tellAll("   ")).toBe("The message is empty.")
  await until(() => swarm.snapshot().members.every((m) => m.status === "working"))
  expect(swarm.stopMember("a")).toBeUndefined()
  expect(swarm.tellAll("only b")).toBe(1)
  expect(swarm.stopMember("b")).toBeUndefined()
  expect(swarm.tellAll("nobody")).toBe(
    "No member can get messages any more: every one has ended or is stopping.",
  )
  await swarm.done
  expect(swarm.tellAll("late")).toBe("The swarm has ended.")
  expect(records.filter((r) => r.type === "message")).toMatchObject([
    { from: "user", to: "all", text: "only b" },
  ])
})

test("explicitly stopping a queued member stays stopped live and after reconstruction", async () => {
  const { swarm, records, mock } = direct(
    () => ({ text: "done", delayMs: 50 }),
    pair,
    {},
    {},
    { maxConcurrent: 1 },
  )
  expect(swarm.member("b")!.status).toBe("queued")
  expect(swarm.stopMember("b")).toBeUndefined()
  const source = createSwarmSource("workspace", () => [swarm.snapshot()]).source
  expect(source.snapshot().phases[0]!.groups[0]!.agents[1]!.status).toBe("stopped")
  const interrupted = swarmsFromRecords(JSON.parse(JSON.stringify(records)))
  expect(interrupted[0]!.members[1]!.stopReason).toBe("stopped by the user")
  const report = await swarm.done
  expect(mock.requests.some((req) => who(req) === "b")).toBe(false)
  expect(report.members[1]).toMatchObject({ status: "done", turns: 0, stopReason: "stopped by the user" })
  const restored = swarmsFromRecords(JSON.parse(JSON.stringify(records)))
  const historical = createSwarmSource("workspace", () => restored).source
  expect(historical.snapshot().phases[0]!.groups[0]!.agents.map((agent) => agent.status)).toEqual([
    "done",
    "stopped",
  ])
  expect(swarm.member("a")!.stopReason).toBeUndefined()
})

test("start maps child sessions and end records round-trip each member's own totals", async () => {
  const usage = { input: 12, output: 7, cacheRead: 3, cacheWrite: 2, cost: 0.025 }
  const { swarm, records } = direct(() => ({ text: "completed reply", usage }), pair)
  const start = records[0]!
  expect(start.type).toBe("start")
  if (start.type !== "start") throw new Error("missing start")
  expect(start.members.map((member) => member.sessionId)).toEqual(
    swarm.snapshot().members.map((member) => member.sessionId),
  )
  expect(new Set(start.members.map((member) => member.sessionId)).size).toBe(2)
  expect(start.members.every((member) => !!member.sessionId)).toBe(true)
  const source = createSwarmSource("workspace", () => [swarm.snapshot()]).source
  expect(source.snapshot().phases[0]!.groups[0]!.agents.map((agent) => agent.sessionId)).toEqual(
    start.members.map((member) => member.sessionId),
  )
  const report = await swarm.done
  const end = records.at(-1)!
  expect(end.type).toBe("end")
  if (end.type !== "end") throw new Error("missing end")
  expect(end.members).toEqual(report.members)
  for (const member of report.members) {
    expect(member.usage).toEqual(usage)
    expect(member.tokens).toBe(24)
    expect(member.cost).toBe(0.025)
    expect(member.durationMs).toBeGreaterThanOrEqual(0)
    expect(member.text).toBe("completed reply")
  }
  const restored = swarmsFromRecords(JSON.parse(JSON.stringify(records)))[0]!
  expect(restored.members).toEqual(swarm.snapshot().members)
  expect(restored.tokens).toBe(report.tokens)
  expect(restored.messages).toBe(report.messages)
})

test("failed member errors and unknown prices survive record serialization", async () => {
  const { swarm, records } = direct(
    (req) =>
      who(req) === "a"
        ? { error: { message: "model unavailable" } }
        : { text: "ok", usage: { input: 2, output: 1 } },
    pair,
  )
  await swarm.done
  const restored = swarmsFromRecords(JSON.parse(JSON.stringify(records)))[0]!
  expect(restored.members[0]!.outcome).toBe("error")
  expect(restored.members[0]!.error).toContain("model unavailable")
  expect(restored.members[0]!.error).toBe(swarm.member("a")!.error)
  expect(restored.members[0]!.sessionId).toBe(swarm.member("a")!.sessionId)
  expect(restored.members[1]!.cost).toBeUndefined()
  expect(restored.members[1]!.usage?.cost).toBeUndefined()
  expect(restored.members[1]!.tokens).toBe(3)
})

test("live member metrics exclude descendants and never total a partly unknown price", async () => {
  const ownTokens: number[] = []
  let running: Swarm | undefined
  const childWork: ToolDefinition = {
    name: "child_work",
    description: "Run one child",
    parameters: { type: "object", properties: {} },
    async execute(_params, ctx) {
      await ctx.session!.spawn!({ prompt: "Do the nested work" }).result()
      return textResult("Child finished")
    },
  }
  const { swarm, records } = direct(
    (req) => {
      if (who(req) === "commander") return { text: "nested reply", usage: { input: 1000, cost: 1 } }
      if (who(req) === "b") return { text: "b reply", usage: { input: 1, cost: 0 } }
      if (lastIsResult(req)) return { text: "a reply", usage: { input: 2, cost: 0.02 } }
      return { toolCalls: [{ name: "child_work", args: {} }], usage: { input: 1 } }
    },
    pair,
    {},
    {
      changed() {
        const tokens = running?.member("a")?.tokens
        if (tokens !== undefined) ownTokens.push(tokens)
      },
    },
    { tools: [childWork] },
  )
  running = swarm
  const report = await swarm.done
  expect(ownTokens.length).toBeGreaterThan(0)
  expect(ownTokens.every((tokens) => tokens <= 3)).toBe(true)
  expect(report.members[0]!.tokens).toBe(3)
  expect(report.members[0]!.cost).toBeUndefined()
  expect(report.members[0]!.usage?.cost).toBeUndefined()
  expect(report.members[1]!.cost).toBe(0)
  expect(report.tokens).toBe(1004)
  expect(swarmsFromRecords(JSON.parse(JSON.stringify(records)))[0]!.members[0]!.cost).toBeUndefined()
})

test("unobserved commander consultations update live tokens but never invent a complete price", async () => {
  const childWork: ToolDefinition = {
    name: "consult_child",
    description: "Run a child that consults its commander",
    parameters: { type: "object", properties: {} },
    async execute(_params, ctx) {
      if (ctx.session!.depth === 1) {
        await ctx.session!.spawn!({ prompt: "Ask your commander" }).result()
      } else {
        await ctx.session!.askUser!(
          [{ question: "Which approach?", options: [{ label: "Safe" }] }],
          ctx.signal,
        )
      }
      return textResult("Finished")
    },
  }
  for (const authoritative of [false, true]) {
    let running: Swarm | undefined
    let tree: AgentTree | undefined
    let reads = 0
    const liveTokens: number[] = []
    const run = direct(
      (req) => {
        if (/asks you (?:this question|these questions)/.test(lastText(req))) {
          return { text: "1: Safe", usage: { input: 9 } }
        }
        if (who(req) === "b") return { text: "b done", usage: { input: 1, cost: 0 } }
        if (lastIsResult(req)) return { text: "done", usage: { input: 2, cost: 0.02 } }
        return { toolCalls: [{ name: "consult_child", args: {} }], usage: { input: 1, cost: 0.01 } }
      },
      pair,
      {},
      {
        ...(authoritative
          ? {
              ownUsage: (id: string) => {
                reads++
                return tree?.subagent(id)?.info.usage
              },
            }
          : {}),
        changed() {
          const member = running?.member("a")
          if (member?.tokens !== undefined) liveTokens.push(member.tokens)
          const before = reads
          running?.snapshot()
          expect(reads).toBe(before)
        },
      },
      { tools: [childWork] },
    )
    running = run.swarm
    tree = run.tree
    const report = await run.swarm.done
    expect(report.members[0]!.tokens).toBe(12)
    expect(report.members[0]!.cost).toBeUndefined()
    expect(report.members[0]!.usage?.cost).toBeUndefined()
    expect(report.members[1]!.cost).toBe(0)
    const restored = swarmsFromRecords(JSON.parse(JSON.stringify(run.records)))[0]!
    expect(restored.members[0]!.tokens).toBe(12)
    expect(restored.members[0]!.cost).toBeUndefined()
    if (authoritative) {
      expect(reads).toBeGreaterThan(0)
      expect(liveTokens).toContain(10)
    }
  }
})
