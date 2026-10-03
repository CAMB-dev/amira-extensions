import { type SessionControl, summarizeTrace, type TraceRecord, type ViewLine } from "@amira/api"
import {
  type DashboardAgent,
  type DashboardDetails,
  type DashboardSnapshot,
  type DashboardSource,
  type DashboardStatus,
  languageOf,
} from "./source.ts"

type ChildRecord = Extract<TraceRecord, { type: "subagent" }>

interface SessionEntry {
  id: string
  name: string
  task: string
  status: DashboardStatus
  startedAt?: number
  durationMs?: number
  cost?: number
  parentSessionId?: string
  groupId?: string
  toolCallId?: string
}

function statusOf(status: string): DashboardStatus {
  switch (status) {
    case "working":
      return "running"
    case "blocked":
      return "paused"
    case "error":
      return "failed"
    case "aborted":
      return "stopped"
    case "queued":
    case "running":
    case "idle":
    case "paused":
    case "done":
    case "failed":
    case "stopped":
      return status
    default:
      return "idle"
  }
}

function childEntry(record: ChildRecord, parentSessionId: string): SessionEntry {
  return {
    id: record.childSessionId,
    name: record.role ?? "agent",
    task: record.title ?? record.childSessionId,
    status: statusOf(record.status),
    startedAt: record.start,
    durationMs: record.durationMs,
    cost: record.usage?.cost,
    parentSessionId,
    groupId: record.groupId,
    toolCallId: record.toolCallId,
  }
}

/** The API's summary covers reported usage only; do not price missing usage as zero. */
function ownCost(records: TraceRecord[], reportedCost?: number): number | undefined {
  const requests = records.filter(
    (record) => record.type === "model" || record.type === "compact" || record.type === "side",
  )
  if (!requests.length || requests.some((record) => record.usage?.cost === undefined)) return undefined
  return reportedCost
}

function logLines(record: TraceRecord): ViewLine[] {
  switch (record.type) {
    case "trace":
      return [
        {
          kind: "muted",
          text: `Recording started at ${record.startedAt}${record.title ? ` · ${record.title}` : ""}`,
        },
      ]
    case "model":
      return [
        {
          kind: "text",
          text: `${record.model} · ${record.end - record.start} ms${record.stopReason ? ` · ${record.stopReason}` : ""}`,
        },
      ]
    case "tool":
      return [
        {
          kind: record.outcome === "ok" ? "text" : "warning",
          text: `${record.name} · ${record.outcome} · ${record.durationMs} ms`,
        },
        ...(record.argsPreview ? [{ kind: "muted" as const, text: record.argsPreview }] : []),
        ...(record.resultPreview ? [{ kind: "text" as const, text: record.resultPreview }] : []),
        ...(record.artifact ? [{ kind: "muted" as const, text: `Saved output: ${record.artifact}` }] : []),
      ]
    case "turn":
      return [
        {
          kind: record.reason === "done" ? "text" : "warning",
          text: `Turn ${record.turnId} · ${record.reason}${record.failure ? ` · ${record.failure.message}` : ""}`,
        },
      ]
    case "status":
      return [{ kind: "muted", text: `${record.status}${record.reason ? ` · ${record.reason}` : ""}` }]
    case "subagent":
      return [
        {
          kind: "text",
          text: `${record.title ?? record.childSessionId} · ${record.status}${record.error ? ` · ${record.error}` : ""}`,
        },
      ]
    case "compact":
      return [{ kind: "muted", text: `Compaction · ${record.reason} · ${record.end - record.start} ms` }]
    case "side":
      return [{ kind: "muted", text: `${record.label ?? "Side request"} · ${record.model}` }]
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** A fixed, read-only replay. Each session is summarized independently, including the root. */
export async function createTraceSource(
  session: SessionControl,
  signal?: AbortSignal,
): Promise<DashboardSource> {
  signal?.throwIfAborted()
  // SessionControl follows the selected session. Capture metadata before the first await,
  // use explicit IDs, and reject a replay if the selection changes while loading it.
  const info = structuredClone(session.info())
  const children = structuredClone(session.subagents())
  const spawnGroups = structuredClone(session.groups?.() ?? [])
  const entries = new Map<string, SessionEntry>([
    [
      info.id,
      {
        id: info.id,
        name: "Session",
        task: info.title ?? info.id,
        status: info.busy ? "running" : "idle",
      },
    ],
  ])
  for (const child of children) {
    if (entries.has(child.id)) continue
    entries.set(child.id, {
      id: child.id,
      name: child.role,
      task: child.task || child.title,
      status: statusOf(child.status),
      startedAt: child.startedAt,
      durationMs: child.durationMs,
      cost: child.usage.cost,
      parentSessionId: child.parentSessionId,
      groupId: child.groupId,
      toolCallId: child.toolCallId,
    })
  }
  const assertSession = () => {
    signal?.throwIfAborted()
    if (session.info().id !== info.id)
      throw new Error("Session changed while loading the trace. Open the trace again.")
  }
  const traces = new Map<string, TraceRecord[]>()
  const unavailable = new Set<string>()
  // Map iteration also visits descendants recovered from completed subagent records.
  for (const entry of entries.values()) {
    assertSession()
    let records: TraceRecord[]
    try {
      records = structuredClone(await session.trace(entry.id))
    } catch {
      records = []
    }
    assertSession()
    // A host returning another session's records must not contaminate this replay.
    if (records.some((record) => record.type === "trace" && record.sessionId !== entry.id)) records = []
    traces.set(entry.id, records)
    if (!records.length) unavailable.add(entry.id)
    for (const record of records) {
      if (record.type !== "subagent" || record.childSessionId === info.id) continue
      const known = entries.get(record.childSessionId)
      if (!known) entries.set(record.childSessionId, childEntry(record, entry.id))
      else {
        known.startedAt ??= record.start
        known.durationMs ??= record.durationMs
        known.cost ??= record.usage?.cost
        known.groupId ??= record.groupId
        known.toolCallId ??= record.toolCallId
      }
    }
  }

  const agents: DashboardAgent[] = []
  const details = new Map<string, DashboardDetails>()
  for (const entry of entries.values()) {
    const records = traces.get(entry.id)!
    const stats = records.length ? summarizeTrace(records) : undefined
    const files = [
      ...new Set(records.flatMap((record) => (record.type === "tool" ? (record.writtenPaths ?? []) : []))),
    ].map((path) => ({ path }))
    const cost = records.length ? ownCost(records, stats?.usage.cost) : entry.cost
    let status = entry.status
    if (entry.id === info.id) {
      for (const record of records) {
        if (record.type === "status") status = statusOf(record.status)
        if (record.type === "turn") status = record.reason === "done" ? "done" : statusOf(record.reason)
      }
    }
    const agent: DashboardAgent = {
      id: entry.id,
      name: entry.name,
      task: entry.task,
      status,
      startedAt: stats?.start ?? entry.startedAt,
      durationMs: stats?.wallTimeMs ?? entry.durationMs,
      cost,
      language: languageOf(files),
      files,
      actions: [],
      ...(status === "done" ? { progress: 1 } : {}),
    }
    agents.push(agent)
    details.set(
      entry.id,
      freeze<DashboardDetails>({
        summary: [
          { kind: "text", text: entry.task },
          { kind: "muted", text: `Session: ${entry.id}` },
          {
            kind: "text",
            text: `Own cost: ${cost === undefined ? "unknown" : `$${cost.toFixed(4)}`}${!records.length && cost !== undefined ? " (reported usage; trace unavailable)" : ""}`,
          },
          {
            kind: "muted",
            text: "Stats cover recorded events only. Missing usage and unfinished intervals cannot be reconstructed.",
          },
          ...(!records.length
            ? [
                {
                  kind: "warning" as const,
                  text: "No trace records available. Timing, logs, and files are unknown.",
                },
              ]
            : []),
        ],
        logs: records.flatMap(logLines),
        ...(stats ? { stats } : {}),
      }),
    )
  }
  const groups = new Map<string, { id: string; name: string; ref?: string; agents: DashboardAgent[] }>()
  for (const agent of agents) {
    const entry = entries.get(agent.id)!
    const ancestry: string[] = []
    let parent = entry.parentSessionId
    while (parent && !ancestry.includes(parent)) {
      ancestry.push(parent)
      parent = entries.get(parent)?.parentSessionId
    }
    const spawnGroup = ancestry.flatMap((parentId) =>
      spawnGroups.filter((group) => group.id === entry.groupId && group.parentSessionId === parentId),
    )[0]
    const parentId = spawnGroup?.parentSessionId ?? entry.parentSessionId
    const key = entry.groupId
      ? JSON.stringify(["group", parentId, entry.groupId])
      : entry.toolCallId
        ? JSON.stringify(["tool", parentId, entry.toolCallId])
        : "agents"
    let group = groups.get(key)
    if (!group) {
      group = {
        id: key,
        name:
          spawnGroup?.name ?? (entry.groupId ? "Spawn group" : entry.toolCallId ? "Agent call" : "Agents"),
        ref: entry.groupId ?? entry.toolCallId,
        agents: [],
      }
      groups.set(key, group)
    }
    group.agents.push(agent)
  }
  const snapshot: DashboardSnapshot = freeze({
    workspace: info.cwd,
    phases: [{ id: "agents", name: "Agents", groups: [...groups.values()] }],
    note: `Read-only snapshot of completed intervals only. Missing data and unreported usage are unknown; costs are per session, not combined.${unavailable.size ? ` No trace records for ${unavailable.size} session(s).` : ""}`,
  })
  return freeze({
    id: "trace",
    label: "Trace",
    snapshot: () => snapshot,
    details: (agentId: string) => details.get(agentId),
  })
}
