import type {
  EventEnvelope,
  EventMap,
  ExtensionAPI,
  Message,
  SessionControl,
  SubagentInfo,
  ViewLine,
} from "@amira/api"
import {
  type DashboardAction,
  type DashboardAgent,
  type DashboardGroup,
  type DashboardSource,
  type DashboardStatus,
  languageOf,
} from "./source.ts"

const MAX_AGENTS = 128
const MAX_LOGS = 200
const MAX_TEXT = 16_000
const MAX_LINE = 2_000
const MAX_FILES = 512

interface LiveDetails {
  text: string
  thinking: string
  reply?: string
  logs: ViewLine[]
  files: Set<string>
}

const tail = (text: string): string => text.slice(-MAX_TEXT)
const lines = (text: string): ViewLine[] =>
  tail(text)
    .split("\n")
    .slice(-MAX_LOGS)
    .map((text) => ({ kind: "text", text: text.slice(0, MAX_LINE) }))

function messageText(message: Pick<Message, "content">): string {
  // Keep only a bounded tail, including when a message contains many blocks.
  let text = ""
  for (const block of message.content) {
    if (block.type === "text") text = tail(text + tail(block.text))
  }
  return text
}

function statusOf(agent: SubagentInfo): DashboardStatus {
  return agent.status === "error" ? "failed" : agent.status === "aborted" ? "stopped" : agent.status
}

const stoppable = (agent: SubagentInfo): boolean =>
  ["queued", "running", "idle", "paused"].includes(agent.status)

function actionsOf(agent: SubagentInfo): DashboardAction[] {
  if (!stoppable(agent)) return []
  return [
    ...(agent.status === "running" ? ["pause" as const] : []),
    ...(agent.status === "paused" ? ["resume" as const] : []),
    "stop",
    "request-changes",
  ]
}

/** Live session listings are authoritative; event caches contain only recent child details. */
export function createLiveSource(
  session: SessionControl,
  bus: Pick<ExtensionAPI, "on">,
): DashboardSource & { dispose(): void } {
  const root = session.info()
  const rootId = root.id
  const workspace = root.cwd
  const cache = new Map<string, LiveDetails>()
  const subscribers = new Set<() => void>()
  const removers: (() => void)[] = []
  let disposed = false
  let switched = false

  const current = (): boolean => !disposed && !switched && session.info().id === rootId
  const notify = (): void => {
    for (const changed of subscribers) changed()
  }

  /** A switched session never becomes current again: release the bus listeners at once, not at close. */
  function leave(): void {
    switched = true
    unlisten()
    notify()
  }

  function agents(): SubagentInfo[] {
    if (!current()) return []
    const listed = session.subagents()
    const included = new Set([rootId])
    // Listings normally use tree order, but do not rely on that for scoping descendants.
    let added = true
    while (added) {
      added = false
      for (const agent of listed) {
        if (!included.has(agent.id) && included.has(agent.parentSessionId)) {
          included.add(agent.id)
          added = true
        }
      }
    }
    return listed.filter((agent) => agent.id !== rootId && included.has(agent.id))
  }

  function live(id: string, listed: SubagentInfo[]): LiveDetails {
    const ids = new Set(listed.map((agent) => agent.id))
    for (const key of cache.keys()) if (!ids.has(key)) cache.delete(key)
    const value = cache.get(id) ?? { text: "", thinking: "", logs: [], files: new Set<string>() }
    // Refresh on events rather than reads, so snapshot/details remain side-effect-free.
    cache.delete(id)
    cache.set(id, value)
    if (cache.size > MAX_AGENTS) cache.delete(cache.keys().next().value!)
    return value
  }

  function log(value: LiveDetails, text: string): void {
    value.logs.push(...lines(text))
    if (value.logs.length > MAX_LOGS) value.logs.splice(0, value.logs.length - MAX_LOGS)
  }

  function on<K extends keyof EventMap>(
    type: K,
    handler: (event: EventEnvelope<K>, listed: SubagentInfo[]) => void,
  ): void {
    removers.push(
      bus.on(type, (event) => {
        if (disposed || switched) return
        if (session.info().id !== rootId) {
          leave()
          return
        }
        handler(event, agents())
      }),
    )
  }

  function child<K extends keyof EventMap>(
    type: K,
    handler: (event: EventEnvelope<K>, value: LiveDetails) => void,
  ): void {
    on(type, (event, listed) => {
      if (!listed.some((agent) => agent.id === event.sessionId)) return
      handler(event, live(event.sessionId, listed))
      notify()
    })
  }

  function listen(): void {
    for (const type of ["subagent.start", "subagent.state", "subagent.end"] as const) {
      on(type, (event, listed) => {
        if (event.sessionId === rootId || listed.some((agent) => agent.id === event.sessionId)) notify()
      })
    }
    for (const type of ["group.start", "group.update", "group.end"] as const) {
      on(type, (event, listed) => {
        if (event.sessionId === rootId || listed.some((agent) => agent.id === event.sessionId)) notify()
      })
    }
    on("session.start", () => {})
    on("session.end", (event) => {
      if (event.sessionId !== rootId || event.data.reason !== "switch") return
      leave()
    })
    child("message.start", (_event, value) => {
      value.text = ""
      value.thinking = ""
    })
    child("message.delta", (event, value) => {
      if (event.data.kind === "text") value.text = tail(value.text + tail(event.data.text))
      if (event.data.kind === "thinking") value.thinking = tail(value.thinking + tail(event.data.text))
    })
    child("message.end", (event, value) => {
      value.reply = messageText(event.data.message)
      value.text = ""
      value.thinking = ""
    })
    child("tool.execute.start", (event, value) => {
      log(value, `${event.data.name}: started`)
    })
    child("tool.execute.update", (event, value) => {
      log(value, `${event.data.name}: ${messageText(event.data.partial)}`)
    })
    child("tool.execute.end", (event, value) => {
      const { name, result, rejected, writtenPaths } = event.data
      log(
        value,
        `${name}: ${rejected ? "not run" : result.isError ? "failed" : "finished"}\n${messageText(result)}`,
      )
      // Arguments, start-event paths and result text are not evidence of a completed write.
      for (const path of writtenPaths ?? []) {
        if (value.files.size >= MAX_FILES) break
        value.files.add(path)
      }
    })
  }

  function unlisten(): void {
    for (const remove of removers.splice(0)) remove()
    cache.clear()
  }

  return {
    id: "agents",
    label: "Agents",
    snapshot() {
      if (!current()) {
        return {
          workspace,
          phases: [],
          note: disposed
            ? "Live source closed."
            : "Session changed. Reopen the dashboard to view its agents.",
        }
      }
      const listed = agents()
      const byId = new Map(listed.map((agent) => [agent.id, agent]))
      const knownParents = new Set([rootId, ...byId.keys()])
      const spawnGroups = (session.groups?.() ?? []).filter((group) =>
        knownParents.has(group.parentSessionId),
      )
      const groups = new Map<string, DashboardGroup>()
      for (const group of spawnGroups) {
        const id = JSON.stringify(["group", group.parentSessionId, group.id])
        groups.set(id, { id, name: group.name, ref: group.id, agents: [] })
      }
      for (const agent of listed) {
        // Descendants may inherit a spawn group owned by an ancestor, not their direct parent.
        const ancestry: string[] = []
        let parent: string | undefined = agent.parentSessionId
        while (parent && !ancestry.includes(parent)) {
          ancestry.push(parent)
          parent = byId.get(parent)?.parentSessionId
        }
        const spawnGroup =
          agent.groupId === undefined
            ? undefined
            : ancestry
                .map((parentId) =>
                  spawnGroups.find(
                    (group) => group.id === agent.groupId && group.parentSessionId === parentId,
                  ),
                )
                .find((group) => group !== undefined)
        const id = spawnGroup
          ? JSON.stringify(["group", spawnGroup.parentSessionId, spawnGroup.id])
          : agent.groupId !== undefined
            ? JSON.stringify(["group", agent.parentSessionId, agent.groupId])
            : agent.toolCallId !== undefined
              ? JSON.stringify(["tool", agent.parentSessionId, agent.toolCallId])
              : JSON.stringify(["session", agent.parentSessionId])
        let group = groups.get(id)
        if (!group) {
          group = {
            id,
            name:
              spawnGroup?.name ??
              (agent.groupId !== undefined
                ? "Spawn group"
                : agent.toolCallId !== undefined
                  ? "Agent call"
                  : "Agents"),
            ref: spawnGroup?.id ?? agent.groupId ?? agent.toolCallId,
            agents: [],
          }
          groups.set(id, group)
        }
        const files = [...(cache.get(agent.id)?.files ?? [])].map((path) => ({ path }))
        const item: DashboardAgent = {
          id: agent.id,
          name: agent.title,
          task: agent.task,
          status: statusOf(agent),
          startedAt: agent.startedAt,
          durationMs: agent.durationMs,
          cost: agent.usage.cost,
          language: languageOf(files),
          ...(agent.status === "done" ? { progress: 1 } : {}),
          files,
          actions: actionsOf(agent),
        }
        group.agents.push(item)
      }
      return {
        workspace,
        phases: [{ id: "agents", name: "Agents", groups: [...groups.values()] }],
        note: "Live files and logs cover recent activity while this dashboard is open; older details may be omitted.",
      }
    },
    details(agentId) {
      const agent = agents().find((agent) => agent.id === agentId)
      if (!agent) return undefined
      const history = (session.subagentMessages(agentId) ?? []).slice(-MAX_LOGS)
      const value = cache.get(agentId)
      const logs: ViewLine[] = []
      let reply = ""
      for (const message of history) {
        const text = messageText(message)
        if (text) logs.push(...lines(`${message.role}: ${text}`))
        if (message.role === "assistant") reply = text
        if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
      }
      if (value) logs.push(...value.logs, ...(value.thinking ? lines(value.thinking) : []))
      const summary = value?.text || value?.reply || reply || agent.error || agent.note || agent.task
      return { summary: lines(summary), logs: logs.slice(-MAX_LOGS) }
    },
    subscribe(changed) {
      if (!current()) return () => {}
      const listener = () => changed()
      subscribers.add(listener)
      if (subscribers.size === 1) listen()
      return () => {
        if (!subscribers.delete(listener)) return
        if (!subscribers.size) unlisten()
      }
    },
    act(agentId, action, text) {
      if (!current()) return "Session changed or closed. Reopen the dashboard before acting on an agent."
      const agent = agents().find((agent) => agent.id === agentId)
      if (!agent) return "Agent not found in this session."
      if (!stoppable(agent)) return "This agent has already ended."
      if (action === "pause") {
        if (agent.status !== "running") return "Agent is not running. Only running agents can be paused."
        return session.pauseSubagent(agentId)
          ? "Pause accepted. Current work can finish before the next model call is held."
          : "Pause not accepted. Agent may no longer be running or is already paused."
      }
      if (action === "resume") {
        if (agent.status !== "paused") return "Agent is not paused."
        return session.resumeSubagent(agentId)
          ? "Resume accepted."
          : "Resume not accepted. Agent may no longer be paused or has ended."
      }
      if (action === "request-changes") {
        if (!text?.trim()) return "Enter a message to send to this agent."
        return session.messageSubagent(agentId, text)
          ? "Message sent. The agent will receive it before its next model call."
          : "Not sent: agent is stopping or no longer running."
      }
      return session.stopSubagent(agentId)
        ? "Stop requested."
        : "Agent could not be stopped; it may have already ended."
    },
    dispose() {
      if (disposed) return
      disposed = true
      unlisten()
      subscribers.clear()
    },
  }
}
