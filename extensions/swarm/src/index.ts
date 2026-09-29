import type {
  CommandCandidate,
  CommandContext,
  Extension,
  ExtensionAPI,
  PendingNotice,
  SessionData,
  SpawnGroup,
  SpawnGroupOptions,
  ToolDefinition,
  ToolResult,
  UiApi,
  UserMessage,
} from "@amira/api"
import { textResult } from "@amira/api"
import { readSettings, type SwarmSettings, withOverrides } from "./limits.ts"
import {
  checkRoster,
  type MemberSpec,
  reportText,
  Swarm,
  type SwarmSnapshot,
  swarmsFromRecords,
} from "./swarm.ts"
import { memberLine, type SwarmViewData, swarmView, timelineLine, VIEW_KIND } from "./view.ts"

export { Blackboard } from "./blackboard.ts"
export {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_LIMITS,
  readSettings,
  type SwarmLimits,
  type SwarmSettings,
} from "./limits.ts"
export * from "./swarm.ts"
export { swarmView, VIEW_KIND } from "./view.ts"

export const SWARM_TOOL = "swarm"
/** The key a swarm's records go under in the session (SessionData). */
export const DATA_KEY = "swarm"
/** Tools a swarm member never gets: starting swarms and workflows is the main session's (D81). */
const MEMBER_EXCLUDED = [SWARM_TOOL, "workflow"]

/** Whether a user's message asks for a swarm. */
export function asksForSwarm(text: string): boolean {
  return /\bswarm\b|蜂群/i.test(text)
}

const notice = (text: string, display: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  display: { text: display, origin: "swarm" },
})

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

interface Live {
  swarm: Swarm
  /** The top-level session that started it. */
  owner: string
  /** The report its commander expects, until it is delivered. */
  final?: PendingNotice
  /**
   * Its commander's conversation was closed (/clear, /resume, the session ended): nothing is
   * delivered to it any more, since that would run a turn nobody sees.
   */
  orphaned?: boolean
}

/** Where a swarm starts from: the swarm tool of the main session, or a command. */
interface Launch {
  goal: string
  members: MemberSpec[]
  limits?: Record<string, unknown>
  toolCallId?: string
  createGroup(opts: SpawnGroupOptions): SpawnGroup
  expectNotice?: () => PendingNotice
  data?: SessionData
  ui: UiApi
  signal?: AbortSignal
  /**
   * Who wants the swarm: "user" when the message the turn answers asks for one (or came from
   * /swarm <goal>), else "model" (the model proposes it). Shown in the confirmation.
   */
  initiator: "user" | "model"
}

/** A goal as the "declined" memory compares it: case and spacing do not make it another. */
const goalKey = (goal: string) =>
  oneLine(goal)
    .toLowerCase()
    .replace(/[\s.!?。！？]+$/u, "")

type Params = {
  action?: string
  goal?: string
  members?: MemberSpec[]
  to?: string
  text?: string
  limits?: Record<string, unknown>
}

export function createSwarmExtension(): Extension {
  return (api: ExtensionAPI) => {
    const swarms = new Map<string, Live>()
    let root: string | undefined
    /** The user asked for a swarm in the message the current turn answers. */
    let explicit = false
    /** The user typed `/swarm <goal>`: the turn it asked for counts as asking for a swarm. */
    let requested = false
    /** Goals the user turned down in this session: the model may not propose them again unasked. */
    const declined = new Set<string>()
    let lastData: SessionData | undefined
    let seq = 0

    const settings = (): SwarmSettings =>
      readSettings(api.settings.extensions?.[DATA_KEY], (problem) =>
        api.reportError(`swarm settings: ${problem}`),
      )

    const live = (): Live | undefined => [...swarms.values()].reverse().find((l) => l.swarm.live)

    const launch = async (l: Launch): Promise<Swarm | string> => {
      const s = settings()
      if (s.enabled === "never") return "Swarms are turned off in settings (extensions.swarm.enabled: never)."
      if (live()) return `Swarm ${live()!.swarm.id} is still running; stop it first or talk to its members.`
      const goal = typeof l.goal === "string" ? oneLine(l.goal) : ""
      if (!goal) return '"goal" is required.'
      if (l.initiator === "model" && declined.has(goalKey(goal))) {
        return "The user already declined a swarm for this goal in this session, so it was not proposed again. Do not propose it again, reworded or with another roster; carry on without it (e.g. with the agent tool) unless the user asks for a swarm."
      }
      const members = (l.members ?? []).map((m) => ({
        ...m,
        name: typeof m?.name === "string" ? m.name.trim() : (m?.name as string),
        role: typeof m?.role === "string" ? oneLine(m.role) : (m?.role as string),
      }))
      const problem = checkRoster(members, s.maxMembers)
      if (problem) return problem
      const limits = withOverrides(s.limits, l.limits)
      if (s.enabled === "ask") {
        const roster = members
          .map((m) => `  ${m.name} (${m.role}): ${clip(oneLine(m.brief), 100)}`)
          .join("\n")
        // The swarm's own budget, else the session's: what stops it spending more.
        const cap = limits.budget ?? api.settings.budget
        const budget = [
          cap?.tokens !== undefined ? `${cap.tokens.toLocaleString("en-US")} tokens` : "",
          cap?.costUsd !== undefined ? `$${cap.costUsd}` : "",
        ].filter(Boolean)
        const ok = await l.ui.confirm(
          `Start a swarm of ${members.length} agents?`,
          [
            l.initiator === "user" ? "You asked for this swarm." : "The model proposes this swarm.",
            `Goal: ${goal}`,
            "",
            roster,
            "",
            `Agents: ${members.length}${limits.maxConcurrent ? `, ${limits.maxConcurrent} at a time` : ", all at once"}; each works up to ${limits.maxTurnsPerMember} turns and sends up to ${limits.maxMessagesPerMember} messages (${limits.maxMessages} in all).`,
            `Cost: ${budget.length ? `stops at ${budget.join(" or ")}` : "no cost cap"}.`,
            "Files: the members work in your working tree and can change your files.",
          ].join("\n"),
          l.signal ? { signal: l.signal } : {},
        )
        if (ok !== true) {
          declined.add(goalKey(goal))
          // The user's ask is used up: asking again is what lets this goal be proposed again.
          explicit = false
          requested = false
          // The user said no to the model's proposal: tell them how to start it after all.
          if (l.initiator === "model") {
            api.notify(
              `Swarm not started; it will not be proposed again for this goal in this session. To start it yourself, run /swarm ${clip(goal, 200)}.`,
            )
          }
          if (ok === false)
            return "The user declined the swarm, so it did not start. Do not propose a swarm for this goal again in this session unless the user asks for one; carry on without it (e.g. with the agent tool), or ask the user how they want to proceed."
          // After /swarm <goal> the user already did the first; only the setting is left to suggest.
          const how =
            l.initiator === "user"
              ? `The user can set extensions.swarm.enabled to "always" in settings.json to start swarms without confirming.`
              : `To start it themselves, the user can run /swarm ${clip(goal, 200)} in the interactive UI, or set extensions.swarm.enabled to "always" in settings.json to start swarms without confirming.`
          return `Nobody confirmed the swarm, so it did not start: the confirmation was dismissed, or nobody can answer it here (print mode, or an rpc client that does not answer dialogs). Do not propose it again in this session unless the user asks. ${how}`
        }
      }
      let group: SpawnGroup
      try {
        group = l.createGroup({
          name: `swarm: ${clip(goal, 40)}`,
          ...(limits.maxConcurrent ? { maxConcurrent: limits.maxConcurrent } : {}),
          ...(limits.budget ? { budget: limits.budget } : {}),
          maxTurnsPerAgent: limits.maxTurnsPerMember,
          maxAgents: members.length * 4,
        })
      } catch (err) {
        return `The swarm could not start: ${err instanceof Error ? err.message : String(err)}`
      }
      const id = `sw${Date.now().toString(36).slice(-5)}${++seq}`
      const final = l.expectNotice?.()
      const data = l.data
      if (data) lastData = data
      let entry: Live | undefined
      let swarm: Swarm
      try {
        swarm = new Swarm({
          id,
          goal,
          members,
          limits,
          group,
          spawn: { excludeTools: MEMBER_EXCLUDED, ...(l.toolCallId ? { toolCallId: l.toolCallId } : {}) },
          hooks: {
            changed: () => api.requestRender(),
            record: (rec) => data?.append(DATA_KEY, rec),
            toCommander: (from, text) => {
              if (entry?.orphaned) return
              l.expectNotice?.()?.deliver(
                notice(
                  `[swarm ${id} · message from ${from}] ${text}\n\n(If it needs an answer, give it with the swarm tool: action "message", to "${from}". Otherwise just end your turn.)`,
                  `✉ swarm · ${from}: ${clip(oneLine(text), 160)}`,
                ),
              )
            },
            askStuck: async (question, signal) => {
              const answer = await api.ui.select(question, ["Keep going", "Stop the swarm"], { signal })
              return answer === "Keep going" ? "continue" : answer === undefined ? undefined : "stop"
            },
          },
        })
      } catch (err) {
        group.end("the swarm could not start")
        final?.cancel()
        return `The swarm could not start: ${err instanceof Error ? err.message : String(err)}`
      }
      requested = false
      const started: Live = { swarm, owner: root ?? "", ...(final ? { final } : {}) }
      entry = started
      swarms.set(id, started)
      void swarm.done.then((report) => {
        api.requestRender()
        if (started.orphaned) return
        final?.deliver(notice(reportText(report), `◆ swarm ${id} ended: ${clip(report.reason, 80)}`))
      })
      api.requestRender()
      return swarm
    }

    const statusText = (s: SwarmSnapshot, tail = 20): string => {
      const lines = [
        `Swarm ${s.id} · ${s.state}${s.endReason ? ` (${s.endReason})` : ""} · ${s.messages} messages · ${s.tokens ?? 0} tokens`,
        `Goal: ${s.goal}`,
        "",
        "Members:",
        ...s.members.map((m) => memberLine(m).text),
        "",
        `Blackboard keys: ${s.board.map((e) => `${e.key} (${e.value.length} chars, by ${e.by})`).join(", ") || "none"}`,
        "",
        `Timeline (last ${Math.min(tail, s.timeline.length)} of ${s.timeline.length}):`,
        ...s.timeline.slice(-tail).map((e) => clip(timelineLine(e).text, 300)),
      ]
      return lines.join("\n")
    }

    const tool: ToolDefinition<Params> = {
      name: SWARM_TOOL,
      description:
        'Runs a swarm: long-lived sub-agents (members) that work on one goal together in the background, through a shared blackboard and messages to each other. Start one when it clearly helps (several agents that must keep talking to each other over a longer task); for one-off sub-tasks use the agent tool. action "start" takes "goal" and "members" (2 or more, each {name, role, brief, model?}); it proposes the swarm: the user sees the goal, roster and limits and approves or declines it. When the user declines, do not start a swarm for that goal again unless they ask. The call returns at once: members\' messages to you and the final report (members\' results and the blackboard) come back by themselves, so end your turn instead of waiting. "message" sends "text" to member "to"; "status" shows members, blackboard keys and the latest timeline; "stop" ends the swarm.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "message", "status", "stop"] },
          goal: { type: "string", description: "start: what the swarm must produce." },
          members: {
            type: "array",
            description: "start: the roster.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: 'A short name the others use, e.g. "writer".' },
                role: { type: "string", description: 'A word or two, e.g. "researcher".' },
                brief: { type: "string", description: "Its part of the work, and whom it hands results to." },
                model: { type: "string", description: '"provider/model"; default yours.' },
              },
              required: ["name", "role", "brief"],
            },
          },
          to: { type: "string", description: "message: the member's name." },
          text: { type: "string", description: "message: what to tell it." },
          limits: {
            type: "object",
            description:
              "start: lower limits than the settings' (max_messages, max_messages_per_member, max_turns_per_member).",
          },
        },
        required: ["action"],
      },
      concurrency: "serial",
      // Only the user's own session starts swarms (D81): no sub-agent is offered this tool.
      mainOnly: true,
      async execute(p, ctx): Promise<ToolResult> {
        const session = ctx.session
        const action = p.action ?? "start"
        if (action === "start") {
          if (!session?.createGroup || session.depth > 0) {
            return textResult("A swarm can only be started from the main session.", true)
          }
          const r = await launch({
            goal: p.goal ?? "",
            members: p.members ?? [],
            ...(p.limits ? { limits: p.limits } : {}),
            toolCallId: ctx.toolCallId,
            createGroup: (o) => session.createGroup!(o),
            ...(session.expectNotice ? { expectNotice: () => session.expectNotice!() } : {}),
            ...(session.data ? { data: session.data } : {}),
            ui: api.ui,
            signal: ctx.signal,
            initiator: explicit || requested ? "user" : "model",
          })
          if (typeof r === "string") return textResult(r, true)
          return {
            content: [
              {
                type: "text",
                text: `Started swarm ${r.id} with ${r.names().join(", ")}. It runs in the background: members' messages to you and its final report come back by themselves. End your turn now; use action "status" to look in, "message" to talk to a member, "stop" to end it.`,
              },
            ],
            details: { swarm: r.id, members: r.names() },
          }
        }
        const l = live()
        if (action === "status") {
          const s = l?.swarm.snapshot() ?? pastSwarms(session?.data).at(-1)
          return s ? textResult(statusText(s)) : textResult("No swarm has run in this session.", true)
        }
        if (!l) return textResult("No swarm is running.", true)
        if (action === "message") {
          const problem = l.swarm.tell("commander", p.to ?? "", p.text ?? "")
          return problem ? textResult(problem, true) : textResult(`Sent to ${p.to}.`)
        }
        if (action === "stop") {
          void l.swarm.stop("stopped by the commander")
          return textResult(`Stopping swarm ${l.swarm.id}; its report follows.`)
        }
        return textResult(`Unknown action "${action}": use start, message, status or stop.`, true)
      },
    }

    const pastSwarms = (data: SessionData | undefined): SwarmSnapshot[] => {
      try {
        return swarmsFromRecords((data ?? lastData)?.read(DATA_KEY) ?? [])
      } catch {
        return []
      }
    }

    /** A swarm by id (or the newest one): live, or read back from the session. */
    const find = (ctx: CommandContext, id?: string): SwarmViewData | undefined => {
      const l = id ? swarms.get(id) : (live() ?? [...swarms.values()].at(-1))
      if (l) {
        const s = l.swarm
        return {
          snapshot: () => s.snapshot(),
          control: {
            tell: (to, text) => s.tell("user", to, text),
            tellAll: (text) => s.tellAll(text),
            pause: (name) => s.pause(name),
            resume: (name) => s.resume(name),
            stopMember: (name) => s.stopMember(name),
            stop: () => void s.stop(),
          },
        }
      }
      const past = pastSwarms(ctx.session.data)
      const snap = id ? past.find((s) => s.id === id) : past.at(-1)
      return snap ? { snapshot: () => snap } : undefined
    }

    const tellFromUser = (ctx: CommandContext, name: string, text: string) => {
      const l = live()
      if (!l) throw new Error("no swarm is running")
      const problem = l.swarm.tell("user", name, text)
      if (problem) throw new Error(problem)
      const m = l.swarm.member(name)
      ctx.print(`✉ you → ${m?.name ?? name}${m?.status === "paused" ? " (held until it is resumed)" : ""}`)
    }

    /** `@all <text>` and `/swarm msg all <text>`: one message to every member. */
    const tellAllFromUser = (ctx: CommandContext, text: string) => {
      const l = live()
      if (!l) throw new Error("no swarm is running")
      const sent = l.swarm.tellAll(text)
      if (typeof sent === "string") throw new Error(sent)
      ctx.print(`✉ you → all (${sent} member${sent === 1 ? "" : "s"})`)
    }

    /** Whether `name` (after @ or `/swarm msg`) means every member. */
    const isAll = (name: string) => name.toLowerCase() === "all"

    api.registerCommand({
      name: "swarm",
      description: "Ask for a swarm, or watch, message, pause and stop the running one",
      args: {
        hint: "<goal> | view [id] | list | msg <name|all> <text> | pause [name] | resume [name] | stop [name]",
        complete: (): CommandCandidate[] => {
          const names = live()?.swarm.names() ?? []
          return [
            { value: "view", description: "the live timeline and members" },
            { value: "list", description: "swarms of this session" },
            { value: "stop", description: "stop the swarm (or one member)" },
            { value: "pause", description: "hold a member's messages (or the whole swarm's)" },
            { value: "resume", description: "deliver what was held" },
            ...(names.length ? [{ value: "msg all ", description: "message every member" }] : []),
            ...names.map((n) => ({ value: `msg ${n} `, description: `message ${n}` })),
          ]
        },
      },
      async run(text, ctx) {
        const [first = "", ...rest] = text.split(/\s+/)
        const name = rest[0]
        const l = live()
        switch (first) {
          case "":
          case "list": {
            const all = [
              ...pastSwarms(ctx.session.data).filter((s) => !swarms.has(s.id)),
              ...[...swarms.values()].map((x) => x.swarm.snapshot()),
            ]
            if (!all.length) {
              ctx.print("No swarm has run in this session. /swarm <goal> asks for one.")
              return
            }
            ctx.print(
              all
                .map(
                  (s) =>
                    `${s.id} · ${s.state} · ${s.members.map((m) => m.name).join(", ")} · ${clip(s.goal, 60)}`,
                )
                .join("\n"),
            )
            return
          }
          case "view": {
            const data = find(ctx, name)
            if (!data)
              throw new Error(name ? `no swarm ${name} in this session` : "no swarm has run in this session")
            if (!ctx.openView) {
              ctx.print(statusText(data.snapshot()!))
              return
            }
            ctx.openView({ kind: VIEW_KIND, data })
            return
          }
          case "stop": {
            if (!l) throw new Error("no swarm is running")
            if (name) {
              const problem = l.swarm.stopMember(name)
              if (problem) throw new Error(problem)
              ctx.print(`Stopping ${name}.`)
              return
            }
            void l.swarm.stop("stopped by the user")
            ctx.print(`Stopping swarm ${l.swarm.id}.`)
            return
          }
          case "pause":
          case "resume": {
            if (!l) throw new Error("no swarm is running")
            const problem = first === "pause" ? l.swarm.pause(name) : l.swarm.resume(name)
            if (problem) throw new Error(problem)
            ctx.print(`${first === "pause" ? "Paused" : "Resumed"} ${name ?? `swarm ${l.swarm.id}`}.`)
            return
          }
          case "msg": {
            if (!name || rest.length < 2) throw new Error("usage: /swarm msg <name|all> <text>")
            const body = text.slice(text.indexOf(name) + name.length).trim()
            if (isAll(name)) tellAllFromUser(ctx, body)
            else tellFromUser(ctx, name, body)
            return
          }
        }
        // Anything else is a goal: the model designs the roster and starts it.
        if (settings().enabled === "never")
          throw new Error("swarms are turned off in settings (extensions.swarm.enabled)")
        requested = true
        explicit = true
        await ctx.session.send(
          `Use a swarm (the swarm tool) for this task: ${text}\n\nPick 2 to 4 members with distinct roles and clear briefs (who writes what to the blackboard, and who hands results to whom), then start it.`,
          { display: { text: `/swarm ${text}` } },
        )
      },
    })

    api.registerInputHandler({
      name: "swarm",
      claims(text) {
        const l = live()
        const m = /^@([A-Za-z][\w-]*)[\s:,]+\S/.exec(text)
        return !!(l && m && (isAll(m[1]!) || l.swarm.member(m[1]!)))
      },
      run(text, ctx) {
        const m = /^@([A-Za-z][\w-]*)[\s:,]+([\s\S]+)$/.exec(text)!
        if (isAll(m[1]!)) tellAllFromUser(ctx, m[2]!)
        else tellFromUser(ctx, m[1]!, m[2]!)
      },
    })

    api.registerView(swarmView)
    api.registerTool(tool)
    api.registerStatusItem({
      id: "swarm",
      align: "right",
      tone: "accent",
      text() {
        const l = live()
        if (!l) return undefined
        const s = l.swarm.snapshot()
        const working = s.members.filter((m) => m.status === "working").length
        return `swarm ${working}/${s.members.length} working${s.state === "paused" ? " · paused" : ""}`
      },
    })

    /** Stops a swarm whose commander is gone, without delivering anything to it. */
    const orphan = (l: Live, reason: string) => {
      l.orphaned = true
      l.final?.cancel()
      if (l.swarm.live) void l.swarm.stop(reason)
    }
    api.on("session.start", (e) => {
      if (e.parentSessionId !== undefined) return
      if (root && root !== e.sessionId) {
        // Another conversation took over (/clear, /resume): its swarms have nobody to report to.
        for (const l of swarms.values()) if (l.owner !== e.sessionId) orphan(l, "its session was closed")
      }
      root = e.sessionId
      explicit = false
      requested = false
      declined.clear()
    })
    api.on("session.end", (e) => {
      if (e.parentSessionId !== undefined) return
      for (const l of swarms.values()) orphan(l, "the session ended")
    })
    api.on("turn.end", (e) => {
      // `/swarm <goal>` lets the start of the turn it asked for through, not a later one.
      if (e.parentSessionId === undefined && (!root || e.sessionId === root)) requested = false
    })
    api.on("turn.start", (e) => {
      if (e.parentSessionId !== undefined || (root && e.sessionId !== root)) return
      const prompt = e.data.prompt
      // A notice (a swarm's or a sub-agent's report) is not the user asking.
      if (prompt.display?.origin) return
      // The turn `/swarm <goal>` asked for (it may have waited behind a running one).
      if (/^\/swarm\s+\S/.test(prompt.display?.text ?? "")) requested = true
      const text = prompt.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      explicit = requested || asksForSwarm(text) || asksForSwarm(prompt.display?.text ?? "")
    })
    api.on("turn.steer", (e) => {
      if (e.parentSessionId !== undefined || (root && e.sessionId !== root) || e.data.state !== "queued")
        return
      const m = e.data.message
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      if (!m.display?.origin && asksForSwarm(text)) explicit = true
    })
  }
}

export default createSwarmExtension()
