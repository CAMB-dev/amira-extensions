import { expect, setDefaultTimeout, test } from "bun:test"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import type { AnyEvent, CommandContext, Settings } from "@amira/api"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { Blackboard } from "../src/blackboard.ts"
import {
  createSwarmExtension,
  DATA_KEY,
  DEFAULT_LIMITS,
  readSettings,
  type SwarmLimits,
} from "../src/index.ts"
import { type MemberSpec, Swarm, type SwarmRecord, swarmsFromRecords } from "../src/swarm.ts"

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
) {
  const { ai, mock } = makeAi(reply)
  const bus = new EventBus()
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "commander",
    bus,
    tree,
    tools: new ToolRegistry(),
  })
  const group = tree.createGroup(root, { name: "swarm" })
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
  return { root, mock, events, host, tree }
}

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
  expect(printed).toEqual(["✉ you → writer"])
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

test("the model may start a swarm only when the user asked for one, and only from the main session", async () => {
  let n = 0
  const { root } = await withExtension(
    (req) => {
      if (who(req) !== "commander") return { text: "member idle" }
      if (req.messages.at(-1)?.role === "toolResult" || textOf(req.messages.at(-1)).includes("ended:"))
        return { text: "ok" }
      n++
      return { toolCalls: [{ name: "swarm", args: { action: "start", goal: "g", members: pair } }] }
    },
    { extensions: { swarm: { confirm: false } } },
  )
  await root.prompt("answer this for me")
  const refused = root.messages.filter((m) => m.role === "toolResult").at(-1)!
  expect(refused.role === "toolResult" && refused.isError).toBe(true)
  expect(textOf(refused)).toContain("has not asked for a swarm")
  await root.prompt("run a swarm on it")
  const started = root.messages.filter((m) => m.role === "toolResult").at(-1)!
  expect(textOf(started)).toContain("Started swarm")
  await until(() => root.messages.some((m) => m.role === "user" && m.display?.origin === "swarm"))
  expect(n).toBe(2)
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
  expect(s.enabled).toBe("explicit")
  expect(s.confirm).toBe(false)
  expect(s.maxMembers).toBe(6)
  expect(s.limits.maxMessages).toBe(10)
  expect(s.limits.noProgressRounds).toBe(DEFAULT_LIMITS.noProgressRounds)
  expect(s.limits.budget).toEqual({ tokens: 5000 })
  expect(problems.length).toBe(3)
})
