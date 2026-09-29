import {
  type ChildSession,
  type ChildState,
  type SpawnGroup,
  type SpawnOptions,
  type SubagentResult,
  type ToolDefinition,
  textResult,
  type UserMessage,
} from "@amira/api"
import { Blackboard, type BoardEntry, type BoardWrite } from "./blackboard.ts"
import type { SwarmLimits } from "./limits.ts"

/** One member of a swarm, as the commander describes it. */
export interface MemberSpec {
  /** What the others call it: letters, digits, - and _, e.g. "writer". */
  name: string
  /** A word or two for what it does, e.g. "researcher". */
  role: string
  /** Its part of the work, in a few sentences. */
  brief: string
  /** "provider/model"; default the commander's. */
  model?: string
}

/** Who sent a message: a member's name, or the user or the commander. */
export type Sender = string

export type TimelineKind = "start" | "message" | "board" | "finish" | "note" | "end"

/** One thing that happened in a swarm, as its timeline shows it. */
export interface TimelineEntry {
  seq: number
  at: number
  kind: TimelineKind
  from?: string
  to?: string
  key?: string
  text: string
}

/** What a swarm keeps in the session (SessionData, under the key "swarm"), in order. */
export type SwarmRecord =
  | { type: "start"; swarm: string; goal: string; members: MemberSpec[]; at: number }
  | { type: "board"; swarm: string; write: BoardWrite }
  | { type: "message"; swarm: string; from: string; to: string; text: string; at: number }
  | { type: "finish"; swarm: string; member: string; result: string; at: number }
  | { type: "end"; swarm: string; reason: string; at: number; report: string }

/** A member as views and list_agents show it. */
export interface MemberView {
  name: string
  role: string
  /** Its sub-agent's state, or "paused" while the user holds its messages. */
  status: ChildState | "paused"
  turns: number
  messagesSent: number
  /** What it handed in with finish, if it did. */
  result?: string
  /** Why it ended, once it did. */
  note?: string
}

export type SwarmState = "running" | "paused" | "ending" | "ended"

/** What a swarm view shows: a live swarm, or one read back from the session. */
export interface SwarmSnapshot {
  id: string
  goal: string
  state: SwarmState
  startedAt: number
  endedAt?: number
  endReason?: string
  members: MemberView[]
  board: BoardEntry[]
  timeline: TimelineEntry[]
  /** Messages the members sent. */
  messages: number
  /** Tokens the swarm's agents used, when known. */
  tokens?: number
}

export interface MemberReport {
  name: string
  role: string
  status: SubagentResult["status"]
  result?: string
  /** Its last reply. */
  text: string
  turns: number
  error?: string
  note?: string
}

/** How a swarm ended, for its commander. */
export interface SwarmReport {
  id: string
  goal: string
  reason: string
  members: MemberReport[]
  board: BoardEntry[]
  messages: number
  tokens: number
  durationMs: number
  /** Messages that never reached their member because the swarm ended first. */
  undelivered: number
}

export interface SwarmHooks {
  /** A member wrote to the commander. */
  toCommander?(from: string, text: string): void
  /** Something changed: frontends redraw. */
  changed?(): void
  /** Keeps a record in the session. */
  record?(rec: SwarmRecord): void
  /**
   * The swarm went round without progress and is paused: what to do. Undefined (nobody could
   * answer) stops it.
   */
  askStuck?(question: string): Promise<"continue" | "stop" | undefined>
}

export interface SwarmOptions {
  id: string
  goal: string
  members: MemberSpec[]
  limits: SwarmLimits
  /** The group its members are spawned in; the swarm ends it when it ends. */
  group: SpawnGroup
  /** Added to every member's spawn options: tools to leave out, the calling tool's id. */
  spawn?: Pick<SpawnOptions, "excludeTools" | "toolCallId" | "tools">
  hooks?: SwarmHooks
}

/** Names a member may have. */
export const MEMBER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
/** Names that are not members. */
export const RESERVED_NAMES = new Set(["commander", "user", "all", "swarm"])
/** Longest message, in characters. */
export const MAX_MESSAGE_CHARS = 4000
/** Longest blackboard key. */
export const MAX_KEY_CHARS = 80
/** Most of the blackboard one blackboard_read without a key returns, in characters. */
const READ_ALL_CHARS = 12_000

interface Member {
  spec: MemberSpec
  child: ChildSession
  sent: number
  paused: boolean
  /** Messages held while it (or the swarm) is paused, in order. */
  held: UserMessage[]
  /** Turns it had when a message was sent to it while idle: it has not picked that up yet. */
  wakeAt?: number
  result?: string
  ended?: SubagentResult
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** The problem with a roster, or undefined when it can start. */
export function checkRoster(members: MemberSpec[], maxMembers: number): string | undefined {
  if (!Array.isArray(members) || members.length < 2) return "A swarm needs at least 2 members."
  if (members.length > maxMembers) return `A swarm may have at most ${maxMembers} members.`
  const seen = new Set<string>()
  for (const m of members) {
    if (!m || typeof m.name !== "string" || !MEMBER_NAME.test(m.name)) {
      return `Member name "${m?.name}" does not fit: start with a letter; letters, digits, - and _ only; up to 32 characters.`
    }
    const key = m.name.toLowerCase()
    if (RESERVED_NAMES.has(key)) return `"${m.name}" is reserved; pick another member name.`
    if (seen.has(key)) return `Two members are called "${m.name}".`
    seen.add(key)
    if (typeof m.brief !== "string" || !m.brief.trim()) return `Member "${m.name}" needs a brief.`
    if (typeof m.role !== "string" || !m.role.trim()) return `Member "${m.name}" needs a role.`
  }
  return undefined
}

/**
 * A swarm (D82): long-lived sub-agents of one spawn group working on one goal, through a shared
 * blackboard and direct messages. It ends once every member is idle (or ended) with no message
 * on its way, when stopped, or when a limit is hit; `done` then settles with the report.
 */
export class Swarm {
  readonly id: string
  readonly goal: string
  readonly limits: SwarmLimits
  readonly board = new Blackboard()
  readonly startedAt = Date.now()
  readonly done: Promise<SwarmReport>
  #state: SwarmState = "running"
  #members = new Map<string, Member>()
  #timeline: TimelineEntry[] = []
  #group: SpawnGroup
  #hooks: SwarmHooks
  #messages = 0
  #pairs = new Map<string, number>()
  /** Member turns ended, and member messages sent, since the last progress. */
  #idleTurns = 0
  #chatter = 0
  #endReason?: string
  #endedAt?: number
  #resolve!: (r: SwarmReport) => void
  #checking = false

  constructor(opts: SwarmOptions) {
    this.id = opts.id
    this.goal = oneLine(opts.goal)
    this.limits = opts.limits
    this.#group = opts.group
    this.#hooks = opts.hooks ?? {}
    this.done = new Promise((resolve) => {
      this.#resolve = resolve
    })
    this.#record({ type: "start", swarm: this.id, goal: this.goal, members: opts.members, at: Date.now() })
    this.#log({
      kind: "start",
      text: `${plural(opts.members.length, "member")}: ${opts.members.map((m) => m.name).join(", ")}`,
    })
    const roster = opts.members
    for (const spec of roster) {
      const child = this.#group.spawn({
        ...opts.spawn,
        role: spec.role,
        title: spec.name,
        prompt: memberPrompt(spec),
        systemPrompt: memberSystemPrompt(spec, this.goal, roster, this.limits),
        persistent: true,
        maxTurns: this.limits.maxTurnsPerMember,
        ...(spec.model ? { model: spec.model } : {}),
        extraTools: this.#tools(spec.name),
      })
      const m: Member = { spec, child, sent: 0, paused: false, held: [] }
      this.#members.set(spec.name.toLowerCase(), m)
      void this.#watch(m)
    }
  }

  get state(): SwarmState {
    return this.#state
  }

  get live(): boolean {
    return this.#state === "running" || this.#state === "paused"
  }

  /** Member names, in roster order. */
  names(): string[] {
    return [...this.#members.values()].map((m) => m.spec.name)
  }

  member(name: string): MemberView | undefined {
    const m = this.#find(name)
    return m && this.#view(m)
  }

  snapshot(): SwarmSnapshot {
    return {
      id: this.id,
      goal: this.goal,
      state: this.#state,
      startedAt: this.startedAt,
      ...(this.#endedAt !== undefined ? { endedAt: this.#endedAt } : {}),
      ...(this.#endReason !== undefined ? { endReason: this.#endReason } : {}),
      members: [...this.#members.values()].map((m) => this.#view(m)),
      board: this.board.entries(),
      timeline: [...this.#timeline],
      messages: this.#messages,
      tokens: this.#group.info().tokens,
    }
  }

  /**
   * Sends `text` to member `to` from the user or the commander: not counted against the
   * limits, and it counts as progress. Returns the problem, or undefined once sent (or held
   * for a paused member).
   */
  tell(from: "user" | "commander", to: string, text: string): string | undefined {
    if (!this.live) return `The swarm has ${this.#state === "ended" ? "ended" : "is ending"}.`
    const m = this.#find(to)
    if (!m) return `No member "${to}"; the members are ${this.names().join(", ")}.`
    if (m.child.state === "ended") return `${m.spec.name} has ended.`
    const body = oneLine(text) ? text.trim() : ""
    if (!body) return "The message is empty."
    this.#progress()
    this.#deliver(from, m, body)
    return undefined
  }

  /** Holds the messages of one member (or, without a name, of every member) until resumed. */
  pause(name?: string): string | undefined {
    if (!this.live) return "The swarm is not running."
    if (name === undefined) {
      if (this.#state === "paused") return "The swarm is paused already."
      this.#state = "paused"
      this.#log({ kind: "note", text: "paused" })
      return undefined
    }
    const m = this.#find(name)
    if (!m) return `No member "${name}".`
    if (m.child.state === "ended") return `${m.spec.name} has ended.`
    if (m.paused) return `${m.spec.name} is paused already.`
    m.paused = true
    this.#log({ kind: "note", text: `${m.spec.name} paused` })
    return undefined
  }

  /** Delivers what was held for one member (or the whole swarm) and lets it run again. */
  resume(name?: string): string | undefined {
    if (!this.live) return "The swarm is not running."
    if (name === undefined) {
      if (this.#state !== "paused") return "The swarm is not paused."
      this.#state = "running"
      this.#progress()
      this.#log({ kind: "note", text: "resumed" })
      for (const m of this.#members.values()) this.#flush(m)
      this.#check()
      return undefined
    }
    const m = this.#find(name)
    if (!m) return `No member "${name}".`
    if (!m.paused) return `${m.spec.name} is not paused.`
    m.paused = false
    this.#log({ kind: "note", text: `${m.spec.name} resumed` })
    this.#flush(m)
    this.#check()
    return undefined
  }

  /** Stops one member after its running turn (the swarm goes on without it). */
  stopMember(name: string, reason = "stopped by the user"): string | undefined {
    const m = this.#find(name)
    if (!m) return `No member "${name}".`
    if (m.child.state === "ended") return `${m.spec.name} has ended already.`
    m.child.stop(reason)
    this.#log({ kind: "note", text: `${m.spec.name}: ${reason}` })
    return undefined
  }

  /**
   * Ends the swarm: `now` aborts working members at once; otherwise they finish their running
   * turn first. Resolves with the report.
   */
  stop(reason = "stopped by the user", now = true): Promise<SwarmReport> {
    void this.#end(reason, now)
    return this.done
  }

  // ---- members' tools ----

  #tools(self: string): ToolDefinition[] {
    const swarm = this
    return [
      {
        name: "send_message",
        description:
          'Sends a short message to another member of the swarm, or to "commander" (who started the swarm). It wakes an idle member, or reaches a working one before its next step. Put results on the blackboard instead of in messages; do not send thanks or acknowledgements.',
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: 'A member\'s name, or "commander".' },
            text: { type: "string", description: "The message." },
          },
          required: ["to", "text"],
        },
        async execute(p: { to?: unknown; text?: unknown }) {
          const problem = swarm.#send(self, String(p.to ?? ""), typeof p.text === "string" ? p.text : "")
          return problem ? textResult(problem, true) : textResult(`Sent to ${p.to}.`)
        },
      },
      {
        name: "list_agents",
        description: "Lists the swarm's members with their roles and states, and your messages left.",
        parameters: { type: "object", properties: {} },
        concurrency: "parallel",
        async execute() {
          return textResult(swarm.#listText(self))
        },
      },
      {
        name: "blackboard_read",
        description:
          "Reads the swarm's shared blackboard: one key's value, or without a key every key with its value (long boards are cut; then read keys one by one).",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "The key to read; leave out for all." } },
        },
        concurrency: "parallel",
        async execute(p: { key?: unknown }) {
          return swarm.#read(typeof p.key === "string" ? p.key.trim() : "")
        },
      },
      {
        name: "blackboard_write",
        description:
          'Writes a value under a key of the shared blackboard, which every member reads: findings, the plan, drafts, decisions. "append": true adds the text on a new line instead of replacing the value. Every write is logged.',
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: 'A short name, e.g. "plan" or "findings/pricing".' },
            value: { type: "string" },
            append: { type: "boolean", description: "Add to the value instead of replacing it." },
          },
          required: ["key", "value"],
        },
        async execute(p: { key?: unknown; value?: unknown; append?: unknown }) {
          return swarm.#write(self, p)
        },
      },
      {
        name: "finish",
        description:
          "Declares your part of the swarm's work done, with a short summary of what you did and where it is (e.g. which blackboard keys). Then end your turn. You may still be woken by messages; calling finish again replaces the summary.",
        parameters: {
          type: "object",
          properties: { result: { type: "string", description: "What you did, in a few sentences." } },
          required: ["result"],
        },
        async execute(p: { result?: unknown }) {
          const result = typeof p.result === "string" ? p.result.trim() : ""
          if (!result) return textResult('"result" must say what you did.', true)
          swarm.#finish(self, result)
          return textResult("Recorded. End your turn now; a message wakes you if anyone needs you again.")
        },
      },
    ]
  }

  #send(from: string, to: string, text: string): string | undefined {
    if (!this.live) return "The swarm is ending; end your turn."
    const sender = this.#find(from)!
    const body = text.trim()
    if (!body) return '"text" is empty.'
    if (body.length > MAX_MESSAGE_CHARS) {
      return `The message is ${body.length} characters long; keep it under ${MAX_MESSAGE_CHARS}, and put long material on the blackboard.`
    }
    const target = to.trim().replace(/^@/, "")
    const toCommander = target.toLowerCase() === "commander"
    const m = toCommander ? undefined : this.#find(target)
    if (!toCommander && !m) {
      return `No member "${target}". The members are ${this.names().join(", ")}; "commander" reaches who started the swarm.`
    }
    if (m === sender) return "That is you."
    if (m?.child.state === "ended") return `${m.spec.name} has ended; it cannot get messages any more.`
    if (sender.sent >= this.limits.maxMessagesPerMember) {
      return `You have sent all ${this.limits.maxMessagesPerMember} messages a member may send. Put what is left on the blackboard, or call finish.`
    }
    const pair = m ? pairKey(sender.spec.name, m.spec.name) : undefined
    const count = pair ? (this.#pairs.get(pair) ?? 0) : 0
    if (m && count >= this.limits.maxPairExchanges) {
      return `You and ${m.spec.name} have exchanged ${count} messages while neither wrote to the blackboard. Write your findings or decision to the blackboard (or call finish) instead of messaging further.`
    }
    if (this.#messages >= this.limits.maxMessages) {
      void this.#end(`the members sent the ${this.limits.maxMessages} messages a swarm may send`, false)
      return "The swarm has reached its message limit and is ending. End your turn."
    }
    if (pair) this.#pairs.set(pair, count + 1)
    sender.sent++
    this.#messages++
    this.#chatter++
    if (m) this.#deliver(sender.spec.name, m, body)
    else {
      this.#record({
        type: "message",
        swarm: this.id,
        from: sender.spec.name,
        to: "commander",
        text: body,
        at: Date.now(),
      })
      this.#log({ kind: "message", from: sender.spec.name, to: "commander", text: body })
      this.#hooks.toCommander?.(sender.spec.name, body)
    }
    return undefined
  }

  #deliver(from: string, m: Member, text: string) {
    const at = Date.now()
    this.#record({ type: "message", swarm: this.id, from, to: m.spec.name, text, at })
    this.#log({ kind: "message", from, to: m.spec.name, text })
    const who = from === "user" ? "the user" : from === "commander" ? "the commander" : from
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: `[message from ${who}] ${text}` }],
      display: { text: `✉ ${from}: ${clip(oneLine(text), 200)}`, origin: "swarm" },
    }
    if (m.paused || this.#state === "paused") m.held.push(msg)
    else this.#send$(m, msg)
  }

  #send$(m: Member, msg: UserMessage) {
    const idle = m.child.state === "idle"
    if (!m.child.send(msg)) return
    if (idle && m.wakeAt === undefined) m.wakeAt = m.child.turns
  }

  #flush(m: Member) {
    if (m.paused || this.#state === "paused") return
    for (const msg of m.held.splice(0)) this.#send$(m, msg)
  }

  #read(key: string) {
    if (key) {
      const e = this.board.get(key)
      if (!e) {
        const keys = this.board.keys()
        return textResult(
          `No key "${key}" on the blackboard. ${keys.length ? `Keys: ${keys.join(", ")}.` : "It is empty."}`,
        )
      }
      return textResult(`${e.key} (by ${e.by}, ${plural(e.writes, "write")}):\n${e.value}`)
    }
    const entries = this.board.entries()
    if (!entries.length) return textResult("The blackboard is empty.")
    let out = ""
    const cut: string[] = []
    for (const e of entries) {
      const block = `## ${e.key} (by ${e.by}, ${plural(e.writes, "write")})\n${e.value}\n\n`
      if (out.length + block.length > READ_ALL_CHARS) cut.push(e.key)
      else out += block
    }
    if (cut.length) out += `Not shown (read them by key): ${cut.join(", ")}`
    return textResult(out.trim())
  }

  #write(self: string, p: { key?: unknown; value?: unknown; append?: unknown }) {
    if (!this.live) return textResult("The swarm is ending; end your turn.", true)
    const key = typeof p.key === "string" ? p.key.trim() : ""
    if (!key || key.length > MAX_KEY_CHARS || /[\r\n]/.test(key)) {
      return textResult(`"key" must be one line of 1 to ${MAX_KEY_CHARS} characters.`, true)
    }
    if (typeof p.value !== "string") return textResult('"value" must be text.', true)
    let r: ReturnType<Blackboard["write"]>
    try {
      r = this.board.write(self, key, p.value, { append: p.append === true })
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true)
    }
    if (!r.changed) return textResult(`"${key}" already holds that; nothing changed.`)
    this.#record({ type: "board", swarm: this.id, write: r.write! })
    this.#log({ kind: "board", from: self, key, text: p.value })
    this.#progress(self)
    return textResult(`Wrote "${key}" (${r.entry.value.length} characters).`)
  }

  #finish(self: string, result: string) {
    const m = this.#find(self)!
    m.result = result
    this.#record({ type: "finish", swarm: this.id, member: m.spec.name, result, at: Date.now() })
    this.#log({ kind: "finish", from: m.spec.name, text: result })
    this.#progress(self)
  }

  #listText(self: string): string {
    const lines = [...this.#members.values()].map((m) => {
      const v = this.#view(m)
      const you = m.spec.name === self ? " (you)" : ""
      return `- ${v.name}${you}: ${v.role} · ${v.status}${v.result ? " · finished" : ""}`
    })
    const me = this.#find(self)!
    return [
      ...lines,
      '- commander: started the swarm; reach it with send_message(to: "commander")',
      "",
      `Messages you may still send: ${Math.max(0, this.limits.maxMessagesPerMember - me.sent)} (the swarm: ${Math.max(0, this.limits.maxMessages - this.#messages)}).`,
    ].join("\n")
  }

  // ---- progress, termination ----

  /** Something moved the work on: the round counters start again. */
  #progress(member?: string) {
    this.#idleTurns = 0
    this.#chatter = 0
    if (member) {
      for (const k of [...this.#pairs.keys()]) if (k.split("\n").includes(member)) this.#pairs.delete(k)
    } else this.#pairs.clear()
  }

  async #watch(m: Member) {
    try {
      for await (const e of m.child.events) {
        if (e.type === "turn.end" && e.sessionId === m.child.id) this.#turnEnded()
        if (e.type === "subagent.state" && e.data.childSessionId === m.child.id) {
          if (m.wakeAt !== undefined && (e.data.state !== "idle" || m.child.turns > m.wakeAt))
            m.wakeAt = undefined
        }
        this.#hooks.changed?.()
        this.#check()
      }
    } catch {
      // The events of a member are best effort; its result still comes.
    }
    m.ended = await m.child.result()
    const r = m.ended
    if (this.live) {
      const why =
        r.status === "error"
          ? `failed: ${r.error}`
          : r.status === "aborted"
            ? `stopped: ${r.error ?? "aborted"}`
            : (r.note ?? "ended")
      this.#log({ kind: "note", text: `${m.spec.name} ${why}` })
    }
    this.#hooks.changed?.()
    this.#check()
  }

  #turnEnded() {
    this.#idleTurns++
    const live = [...this.#members.values()].filter((m) => m.child.state !== "ended").length || 1
    if (this.#state !== "running" || this.#chatter === 0) return
    if (this.#idleTurns < this.limits.noProgressRounds * live) return
    this.#state = "paused"
    const question = `The swarm "${clip(this.goal, 60)}" went ${plural(this.limits.noProgressRounds, "round")} with messages but no blackboard change or finished part. Keep it going?`
    this.#log({ kind: "note", text: `paused: ${this.limits.noProgressRounds} rounds without progress` })
    const ask = this.#hooks.askStuck
    void (async () => {
      const answer = ask ? await ask(question).catch(() => undefined) : undefined
      if (this.#state !== "paused") return
      if (answer === "continue") this.resume()
      else void this.#end(`no progress in ${plural(this.limits.noProgressRounds, "round")}`, false)
    })()
  }

  /** Whether a member has a message it has not picked up yet. */
  #inFlight(m: Member): boolean {
    if (m.child.state === "ended") return false
    if (m.held.length) return true
    if (m.wakeAt === undefined) return false
    if (m.child.state !== "idle" || m.child.turns > m.wakeAt) {
      m.wakeAt = undefined
      return false
    }
    return true
  }

  #check() {
    if (!this.live || this.#checking) return
    const all = [...this.#members.values()]
    if (all.every((m) => m.child.state === "ended")) {
      void this.#end("every member ended", false)
      return
    }
    // A paused swarm waits for its answer; its held messages keep it from ending anyway.
    if (all.every((m) => (m.child.state === "idle" || m.child.state === "ended") && !this.#inFlight(m))) {
      this.#checking = true
      // Once more after anything that is already on its way (a state event, a send).
      setTimeout(() => {
        this.#checking = false
        if (!this.live) return
        const quiet = all.every(
          (m) => (m.child.state === "idle" || m.child.state === "ended") && !this.#inFlight(m),
        )
        if (quiet) void this.#end("every member is idle and no message is on its way", false)
      }, 0)
    }
  }

  async #end(reason: string, now: boolean) {
    if (!this.live) return
    this.#state = "ending"
    this.#endReason = reason
    this.#log({ kind: "note", text: `ending: ${reason}` })
    let undelivered = 0
    for (const m of this.#members.values()) {
      undelivered += m.held.splice(0).length
      if (now) m.child.abort(reason)
      else m.child.stop(reason)
    }
    const results = await Promise.all([...this.#members.values()].map((m) => m.child.result()))
    this.#group.end(reason)
    const info = await this.#group.ended()
    this.#state = "ended"
    this.#endedAt = Date.now()
    const members = [...this.#members.values()]
    const report: SwarmReport = {
      id: this.id,
      goal: this.goal,
      reason: info.exceeded ? (info.endReason ?? reason) : reason,
      members: members.map((m, i) => {
        const r = results[i]!
        undelivered += r.undelivered?.length ?? 0
        return {
          name: m.spec.name,
          role: m.spec.role,
          status: r.status,
          ...(m.result !== undefined ? { result: m.result } : {}),
          text: r.text,
          turns: r.turns ?? m.child.turns,
          ...(r.error !== undefined ? { error: r.error } : {}),
          ...(r.note !== undefined ? { note: r.note } : {}),
        }
      }),
      board: this.board.entries(),
      messages: this.#messages,
      tokens: info.tokens,
      durationMs: this.#endedAt - this.startedAt,
      undelivered,
    }
    const text = reportText(report)
    this.#log({ kind: "end", text: report.reason })
    this.#record({ type: "end", swarm: this.id, reason: report.reason, at: this.#endedAt, report: text })
    this.#hooks.changed?.()
    this.#resolve(report)
  }

  // ---- helpers ----

  #find(name: string): Member | undefined {
    return this.#members.get(name.trim().replace(/^@/, "").toLowerCase())
  }

  #view(m: Member): MemberView {
    const status =
      m.child.state !== "ended" && (m.paused || (this.#state === "paused" && m.child.state === "idle"))
        ? "paused"
        : m.child.state
    const note = m.ended ? (m.ended.error ?? m.ended.note) : undefined
    return {
      name: m.spec.name,
      role: m.spec.role,
      status,
      turns: m.child.turns,
      messagesSent: m.sent,
      ...(m.result !== undefined ? { result: m.result } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  }

  #log(e: Omit<TimelineEntry, "seq" | "at">) {
    this.#timeline.push({ seq: this.#timeline.length + 1, at: Date.now(), ...e })
    this.#hooks.changed?.()
  }

  #record(rec: SwarmRecord) {
    try {
      this.#hooks.record?.(rec)
    } catch {
      // Keeping records is best effort; the swarm goes on.
    }
  }
}

const pairKey = (a: string, b: string) => [a, b].sort().join("\n")

function memberSystemPrompt(
  self: MemberSpec,
  goal: string,
  roster: MemberSpec[],
  limits: SwarmLimits,
): string {
  const others = roster
    .filter((m) => m !== self)
    .map((m) => `- ${m.name} (${m.role}): ${oneLine(m.brief)}`)
    .join("\n")
  return [
    `You are "${self.name}", the ${self.role} in a swarm: long-lived agents working together on one goal. The swarm's goal: ${goal}`,
    `The other members:\n${others}`,
    [
      "How the swarm works:",
      "- The blackboard is the swarm's shared memory. Put plans, findings, drafts and decisions there (blackboard_write) and read what the others wrote (blackboard_read) before you start and when woken. Prefer it over long messages.",
      '- send_message(to, text) reaches one member, or "commander" (who started the swarm) for questions only it can answer. Keep messages short and actionable; never send thanks, greetings or acknowledgements.',
      '- After each turn you go idle; a message wakes you. Messages reach you as "[message from <name>] ...". Never wait for others inside a turn (no sleep commands, no re-reading the blackboard in a loop): when you need the work of someone else, end your turn; their message wakes you.',
      "- When your part is done, call finish(result) with a short summary, then end your turn.",
      `- The swarm ends once every member is idle and no message is on its way. Limits: ${limits.maxMessagesPerMember} messages per member, ${limits.maxTurnsPerMember} turns per member.`,
    ].join("\n"),
  ].join("\n\n")
}

function memberPrompt(self: MemberSpec): string {
  return `Your part: ${self.brief.trim()}\n\nStart now: read the blackboard, do your part, write results to the blackboard, and message the members who need to act on them.`
}

/** The report the commander gets when a swarm ends. */
export function reportText(r: SwarmReport): string {
  const lines = [
    `Swarm ${r.id} ended: ${r.reason}.`,
    `Goal: ${r.goal}`,
    `${plural(r.members.length, "member")}, ${plural(r.messages, "message")}, ${r.tokens} tokens, ${Math.round(r.durationMs / 1000)}s.${r.undelivered ? ` ${plural(r.undelivered, "message")} never reached its member.` : ""}`,
    "",
    "Members:",
  ]
  for (const m of r.members) {
    const state = m.status === "done" ? (m.result !== undefined ? "finished" : "done") : m.status
    lines.push(
      `- ${m.name} (${m.role}) · ${state} · ${plural(m.turns, "turn")}${m.error ? ` · ${m.error}` : ""}`,
    )
    const said = m.result ?? m.text
    if (said.trim()) lines.push(indent(clip(said.trim(), 1500)))
  }
  lines.push("", "Blackboard:")
  if (!r.board.length) lines.push("(empty)")
  let room = 12_000
  for (const e of r.board) {
    const body = e.value.length > room ? `${e.value.slice(0, Math.max(0, room))}… (cut)` : e.value
    room -= body.length
    lines.push(`## ${e.key} (by ${e.by})`, body)
    if (room <= 0) {
      lines.push("(the rest of the blackboard is cut; /swarm view shows it)")
      break
    }
  }
  return lines.join("\n")
}

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n")

/** Swarms of a session, read back from its records (oldest first). */
export function swarmsFromRecords(records: readonly unknown[]): SwarmSnapshot[] {
  const out = new Map<string, SwarmSnapshot & { writes: BoardWrite[] }>()
  for (const raw of records) {
    const rec = raw as SwarmRecord
    if (!rec || typeof rec !== "object" || typeof rec.swarm !== "string") continue
    if (rec.type === "start") {
      out.set(rec.swarm, {
        id: rec.swarm,
        goal: rec.goal,
        state: "ended",
        startedAt: rec.at,
        members: (rec.members ?? []).map((m) => ({
          name: m.name,
          role: m.role,
          status: "ended",
          turns: 0,
          messagesSent: 0,
        })),
        board: [],
        timeline: [],
        messages: 0,
        writes: [],
      })
      continue
    }
    const s = out.get(rec.swarm)
    if (!s) continue
    const push = (e: Omit<TimelineEntry, "seq">) => s.timeline.push({ seq: s.timeline.length + 1, ...e })
    if (rec.type === "board") {
      s.writes.push(rec.write)
      push({ at: rec.write.at, kind: "board", from: rec.write.by, key: rec.write.key, text: rec.write.value })
    } else if (rec.type === "message") {
      const m = s.members.find((x) => x.name === rec.from)
      if (m) {
        m.messagesSent++
        s.messages++
      }
      push({ at: rec.at, kind: "message", from: rec.from, to: rec.to, text: rec.text })
    } else if (rec.type === "finish") {
      const m = s.members.find((x) => x.name === rec.member)
      if (m) m.result = rec.result
      push({ at: rec.at, kind: "finish", from: rec.member, text: rec.result })
    } else if (rec.type === "end") {
      s.endReason = rec.reason
      s.endedAt = rec.at
      push({ at: rec.at, kind: "end", text: rec.reason })
    }
  }
  return [...out.values()].map(({ writes, ...s }) => {
    const board = Blackboard.replay(writes).entries()
    // A swarm whose session stopped before it ended did not finish.
    return {
      ...s,
      board,
      ...(s.endReason === undefined ? { endReason: "the session ended before the swarm did" } : {}),
    }
  })
}
