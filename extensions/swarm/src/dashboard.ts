import type { ExtensionAPI, ViewLine } from "@amira/api"
import type { MemberView, SwarmSnapshot } from "./swarm.ts"

/** Structural mirror of dashboard.sources; no cross-extension import or declaration merging. */
export interface DashboardSource {
  id: string
  label: string
  snapshot(): {
    workspace: string
    phases: {
      id: string
      name: string
      groups: {
        id: string
        name: string
        agents: {
          id: string
          name: string
          task: string
          status: "queued" | "running" | "idle" | "paused" | "done" | "failed" | "stopped"
          startedAt?: number
          durationMs?: number
          cost?: number
          files: { path: string; diff?: ViewLine[] }[]
          actions: ("pause" | "resume" | "stop" | "request-changes")[]
        }[]
      }[]
    }[]
    note?: string
  }
  details(agentId: string): { summary: ViewLine[]; logs: ViewLine[] } | undefined
  subscribe?(changed: () => void): () => void
}

export interface DashboardSources {
  register(source: DashboardSource): () => void
}

const idOf = (swarm: string, member: string) => `${encodeURIComponent(swarm)}:${encodeURIComponent(member)}`
const known = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0
const lines = (text: string): ViewLine[] => text.split("\n").map((text) => ({ kind: "text", text }))
const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}… (cut)` : text)
const NOTE =
  "Member costs and tokens are own reported usage only; missing values are unknown. Read-only: use /swarm to message, pause or stop members."

function statusOf(member: MemberView) {
  if (member.status === "working") return "running" as const
  if (member.status !== "ended") return member.status
  if (member.outcome === "error" || (!member.outcome && member.error)) return "failed" as const
  if (member.stopReason !== undefined) return "stopped" as const
  if (member.outcome === "done") return "done" as const
  // An old or interrupted record has no successful outcome; never invent one.
  return "stopped" as const
}

/** Pure reads over current snapshots, with bounded detail output and explicit change notifications. */
export function createSwarmSource(workspace: string, read: () => SwarmSnapshot[]) {
  const listeners = new Set<() => void>()
  const source: DashboardSource = {
    id: "swarm",
    label: "Swarm members",
    snapshot: () => ({
      workspace,
      phases: read().map((swarm) => ({
        id: swarm.id,
        name: `${swarm.id} · ${swarm.goal}`,
        groups: [
          {
            id: "members",
            name: `Members · ${swarm.state}`,
            agents: swarm.members.map((member) => ({
              id: idOf(swarm.id, member.name),
              name: `${member.name} (${member.role})`,
              task: member.brief ?? swarm.goal,
              status: statusOf(member),
              ...(known(member.startedAt) ? { startedAt: member.startedAt } : {}),
              ...(known(member.durationMs) ? { durationMs: member.durationMs } : {}),
              ...(known(member.cost) ? { cost: member.cost } : {}),
              files: [],
              actions: [],
            })),
          },
        ],
      })),
      note: NOTE,
    }),
    details(agentId) {
      for (const swarm of read()) {
        const member = swarm.members.find((m) => idOf(swarm.id, m.name) === agentId)
        if (!member) continue
        const tokens = known(member.tokens) ? `${member.tokens} tokens` : "Tokens unknown"
        const cost = known(member.cost) ? `$${member.cost.toFixed(6)}` : "Cost unknown"
        const duration = known(member.durationMs) ? `${member.durationMs} ms` : "Duration unknown"
        const summary = [
          `${member.name} · ${member.role} · ${statusOf(member)}`,
          `Swarm ${swarm.id}: ${swarm.goal}`,
          member.brief ?? "",
          `${tokens} · ${cost} · ${duration}`,
          `Session ID: ${member.sessionId ?? "unknown (not recorded)"}`,
          `${member.turns} turns · ${member.messagesSent} messages sent`,
          ...(member.usage
            ? [
                `Usage: input ${member.usage.input}, output ${member.usage.output}, cache read ${member.usage.cacheRead}, cache write ${member.usage.cacheWrite}`,
              ]
            : []),
          ...(member.error ? [`Error: ${member.error}`] : []),
          ...(member.note && member.note !== member.error ? [`Note: ${member.note}`] : []),
          ...(member.result !== undefined ? [`Result: ${clip(member.result)}`] : []),
          member.lastMessage !== undefined
            ? `Last message: ${clip(member.lastMessage)}`
            : "Last message unavailable",
          ...(swarm.endReason ? [`Swarm ended: ${swarm.endReason}`] : []),
          NOTE,
        ]
        const board = swarm.board
          .map((entry) => `${entry.key} (by ${entry.by}, ${entry.writes} writes):\n${entry.value}`)
          .join("\n\n")
        const timeline = swarm.timeline
          .slice(-200)
          .map(
            (entry) =>
              `${entry.at} · ${entry.kind}${entry.from ? ` · ${entry.from}` : ""}${entry.to ? ` → ${entry.to}` : ""}${entry.key ? ` · ${entry.key}` : ""}: ${clip(entry.text, 1000)}`,
          )
        return {
          summary: summary.flatMap((text) => lines(text)),
          logs: [
            ...lines(`Blackboard\n${board ? clip(board, 20_000) : "(empty)"}`),
            ...lines(
              `\nTimeline (last ${timeline.length} of ${swarm.timeline.length})\n${timeline.join("\n")}`,
            ),
          ],
        }
      }
      return undefined
    },
    subscribe(changed) {
      listeners.add(changed)
      return () => {
        listeners.delete(changed)
      }
    },
  }
  return {
    source,
    changed: () => {
      for (const listener of listeners) listener()
    },
  }
}

/**
 * The public API has no unload callback or service-change event. A host-owned lease becomes
 * absent immediately on unload; guarded reads then expose no stale data. An unref'ed timer
 * releases the external registration within a second and detects dashboard unload/reload.
 */
export function connectDashboardSource(api: ExtensionAPI, source: DashboardSource) {
  const lease = {}
  const key = "swarm.dashboardSource"
  let disposed = false
  let registry: DashboardSources | undefined
  let unregister: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const release = api.provideService?.(key, lease)
  const active = () => !disposed && !!release && api.useService?.(key) === lease
  const guarded: DashboardSource = {
    ...source,
    snapshot: () => (active() ? source.snapshot() : { workspace: api.cwd, phases: [] }),
    details: (id) => (active() ? source.details(id) : undefined),
    subscribe: (changed) =>
      source.subscribe?.(() => {
        if (active()) changed()
      }) ?? (() => {}),
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (timer) clearInterval(timer)
    unregister?.()
    unregister = undefined
    registry = undefined
    release?.()
  }
  const sync = () => {
    if (!active()) {
      dispose()
      return
    }
    // Local cast deliberately avoids augmenting AmiraServices alongside dashboard's types.
    const next = api.useService("dashboard.sources") as DashboardSources | undefined
    if (next === registry) return
    unregister?.()
    unregister = undefined
    registry = next
    if (typeof next?.register !== "function") return
    try {
      unregister = next.register(guarded)
    } catch {
      // Another instance may still be relinquishing its lease after a reload. Retry later.
      registry = undefined
    }
  }
  sync()
  if (!disposed) {
    timer = setInterval(sync, 1000)
    timer.unref?.()
    api.on("extension.loaded", sync)
    api.onExit(dispose)
  }
  return { sync, dispose }
}
