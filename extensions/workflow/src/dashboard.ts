import path from "node:path"
import type { ExtensionAPI, TraceSummary, UiNode, ViewLine } from "@amira/api"
import { type JournalEntry, listRuns, type RunRecord, readJournal } from "./journal.ts"
import { type AgentNode, type FlowNode, formatTokens, runStateText } from "./progress.ts"
import type { WorkflowRun } from "./run.ts"

// Structural mirror of dashboard's experimental source service. No cross-extension imports or
// AmiraServices augmentation: installing two adapters must not conflict during declaration merging.
export interface DashboardAgent {
  id: string
  sessionId?: string
  name: string
  task: string
  status: "queued" | "running" | "idle" | "paused" | "done" | "failed" | "stopped"
  startedAt?: number
  durationMs?: number
  cost?: number
  language?: string
  progress?: number
  files: { path: string; diff?: ViewLine[] }[]
  actions: ("pause" | "resume" | "stop" | "request-changes")[]
}
export interface DashboardPhase {
  id: string
  name: string
  groups: { id: string; name: string; ref?: string; agents: DashboardAgent[] }[]
}
export interface DashboardDetails {
  summary: ViewLine[]
  logs: ViewLine[]
  stats?: TraceSummary
  tabs?: { key: string; label: string; render(): UiNode | ViewLine[] }[]
}
export interface DashboardSource {
  id: string
  label: string
  snapshot(): { workspace: string; phases: DashboardPhase[]; note?: string }
  details(agentId: string): DashboardDetails | undefined
  subscribe?(changed: () => void): () => void
  act?(agentId: string, action: DashboardAgent["actions"][number], text?: string): string | Promise<string>
}
export interface DashboardSources {
  register(source: DashboardSource): () => void
}

interface Call {
  node: AgentNode
  phase: string
  nest?: string
}

const line = (text: string): ViewLine => ({ kind: "text", text })
const dashboardStatus = (status: AgentNode["status"]): DashboardAgent["status"] => {
  if (status === "working") return "running"
  if (status === "error") return "failed"
  if (status === "aborted") return "stopped"
  return status === "cached" ? "done" : status
}

/** Cached, coherent reads. Disk loading and rebuilding happen outside dashboard rendering. */
export function createWorkflowSource(workspace: string) {
  const live = new Map<string, WorkflowRun>()
  const stored = new Map<string, { record: RunRecord; entries: JournalEntry[] }>()
  const listeners = new Set<() => void>()
  let phases: DashboardPhase[] = []
  let details = new Map<string, DashboardDetails>()
  const rebuild = () => {
    const next: DashboardPhase[] = []
    const detail = new Map<string, DashboardDetails>()
    const add = (record: RunRecord, phaseNames: string[], calls: Call[], logs: ViewLine[]) => {
      const prefix = `${record.id}:${record.resumes ?? 0}`
      const names = [...new Set([...phaseNames, ...calls.map((call) => call.phase)])]
      if (!names.length) names.push("")
      for (const name of names) {
        const phase: DashboardPhase = {
          id: `${prefix}:phase:${encodeURIComponent(name)}`,
          name: `${record.meta.name} · ${name || "Unphased"}`,
          groups: [],
        }
        for (const { node, nest } of calls.filter((call) => call.phase === name)) {
          const groupId = `${prefix}:${nest ?? "root"}`
          let group = phase.groups.find((item) => item.id === groupId)
          if (!group) {
            group = { id: groupId, name: nest ?? record.meta.name, ref: record.id, agents: [] }
            phase.groups.push(group)
          }
          const id = `${prefix}:call:${node.call}`
          group.agents.push({
            id,
            ...(node.childId !== undefined ? { sessionId: node.childId } : {}),
            name: node.label,
            task: node.prompt ?? node.label,
            status: dashboardStatus(node.status),
            ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
            ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
            ...(node.cost !== undefined ? { cost: node.cost } : {}),
            ...(node.status === "done" || node.status === "cached" ? { progress: 1 } : {}),
            files: [],
            actions: [],
          })
          detail.set(id, {
            summary: [
              line(
                `Run ${record.id} · attempt ${(record.resumes ?? 0) + 1} · ${runStateText(record.status)}`,
              ),
              line(`Phase: ${name || "Unphased"}${nest ? ` · workflow ${nest}` : ""}`),
              line(
                `Call ${node.call}: ${runStateText(node.status)}${node.status === "cached" ? " (replayed; no new usage)" : ""}`,
              ),
              line(
                `Tokens: ${formatTokens(node.tokens)} · cost: ${node.cost === undefined ? "unknown" : `$${node.cost}`}`,
              ),
              line(`Model: ${node.model ?? "unknown"}`),
              line(`Child session: ${node.childId ?? "none"}`),
              line(node.prompt ?? node.label),
              ...(node.note ? [line(node.note)] : []),
            ],
            logs: [
              ...(node.text ? [line(node.text)] : []),
              ...(node.note ? [line(node.note)] : []),
              ...logs.slice(-50),
            ],
          })
        }
        next.push(phase)
      }
    }
    for (const { record, entries } of stored.values()) {
      if (live.has(record.id)) continue
      // Journal lines append across resumes. Show the final attempt, in script-call order.
      const latest = new Map<string, JournalEntry>()
      const legacy = entries.every((entry) => entry.attempt === undefined)
      for (const entry of entries) {
        // Older journals have no attempt numbers, even when the run was resumed.
        if (legacy || entry.attempt === (record.resumes ?? 0)) latest.set(entry.key, entry)
      }
      const calls = [...latest.values()]
        .sort((a, b) => (a.call ?? 0) - (b.call ?? 0))
        .map(
          (entry, index): Call => ({
            phase: entry.phase ?? "",
            nest: entry.nest,
            node: {
              kind: "agent" as const,
              call: entry.call ?? index,
              label: entry.label,
              status: entry.status ?? "done",
              tokens: entry.tokens,
              cost: entry.cost,
              startedAt: entry.startedAt,
              durationMs: entry.durationMs,
              model: entry.model,
              childId: entry.sessionId,
              prompt: entry.prompt,
              text: entry.text,
              note: entry.error,
            },
          }),
        )
      add(record, record.meta.phases, calls, record.error ? [line(record.error)] : [])
    }
    for (const run of live.values()) {
      const calls: Call[] = []
      const names: string[] = []
      const walk = (flow: FlowNode, nest?: string) => {
        for (const phase of flow.phases) {
          names.push(phase.title)
          for (const item of phase.items) {
            if (item.kind === "agent") calls.push({ node: item, phase: phase.title, nest })
            else walk(item, item.nest ?? item.name)
          }
        }
      }
      walk(run.flow)
      add(
        run.record,
        names,
        calls,
        run.logs.map(
          (log): ViewLine => ({
            kind: log.level === "info" ? "text" : log.level,
            text: `${log.nest ? `[${log.nest}] ` : ""}${log.text}`,
          }),
        ),
      )
    }
    phases = next
    details = detail
    for (const changed of listeners) changed()
  }
  const source: DashboardSource = {
    id: "workflow",
    label: "Workflow runs",
    snapshot: () => ({
      workspace,
      phases,
      note: "Own agent usage only; unknown cost stays unknown. Cached calls spend no new tokens or cost.",
    }),
    details: (id) => details.get(id),
    subscribe(changed) {
      listeners.add(changed)
      return () => {
        listeners.delete(changed)
      }
    },
  }
  return {
    source,
    update(run: WorkflowRun) {
      live.set(run.id, run)
      rebuild()
    },
    load(roots: string[]) {
      stored.clear()
      for (const root of roots) {
        for (const record of listRuns(root)) {
          if (record.status !== "running" && !stored.has(record.id)) {
            stored.set(record.id, { record, entries: readJournal(path.join(root, record.id)) })
          }
        }
      }
      rebuild()
    },
    dispose() {
      listeners.clear()
      live.clear()
      stored.clear()
      phases = []
      details.clear()
    },
  }
}

/**
 * Services have no unload event. A host-owned lease detects our unload; a low-frequency,
 * unref'ed check also handles dashboard removal/replacement without a workflow event.
 */
export function bindWorkflowSource(api: ExtensionAPI, source: DashboardSource, onDispose = () => {}) {
  let service: DashboardSources | undefined
  let unregister: (() => void) | undefined
  let disposed = false
  let active = true
  let timer: ReturnType<typeof setInterval> | undefined
  const lease = {}
  const releaseLease: (() => void) | undefined =
    typeof api.provideService === "function"
      ? api.provideService("workflow.dashboard-owner", lease)
      : undefined
  const disconnect = () => {
    unregister?.()
    unregister = undefined
    service = undefined
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (timer) clearInterval(timer)
    disconnect()
    releaseLease?.()
    onDispose()
  }
  const refresh = () => {
    if (disposed || typeof api.useService !== "function") return
    if (releaseLease && api.useService("workflow.dashboard-owner") !== lease) {
      dispose()
      return
    }
    if (!active) return
    const next = api.useService("dashboard.sources") as DashboardSources | undefined
    if (next === service) return
    disconnect()
    if (typeof next?.register !== "function") return
    try {
      unregister = next.register(source)
      service = next
    } catch {
      // A previous instance may still be releasing its lease after reload. Retry later.
    }
  }
  if (typeof api.useService === "function" && releaseLease) {
    timer = setInterval(refresh, 1000)
    timer.unref()
  }
  refresh()
  return {
    refresh,
    resume() {
      active = true
      refresh()
    },
    pause() {
      active = false
      disconnect()
    },
    dispose,
  }
}
