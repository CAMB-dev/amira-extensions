import type { AgentStatusState, ViewRenderOptions, ViewSegment } from "@amira/api"
import * as amira from "@amira/api"
import type { MemberView } from "./swarm.ts"

const FALLBACK = {
  queued: { ascii: ".", role: "dim", label: "queued" },
  working: { ascii: "*", role: "accent", label: "working" },
  idle: { ascii: "o", role: "muted", label: "idle" },
  paused: { ascii: "|", role: "warning", label: "paused" },
  done: { ascii: "v", role: "success", label: "done" },
  failed: { ascii: "x", role: "error", label: "failed" },
  stopped: { ascii: "|", role: "warning", label: "stopped" },
} as const

/** Adapt the member lifecycle, retaining all outcome/note information for the shared mapper. */
export function memberState(
  member: MemberView,
  api: Partial<Pick<typeof amira, "agentStatusState">> = amira,
): AgentStatusState {
  const source = {
    ...member,
    status:
      member.status === "ended"
        ? (member.outcome ?? (member.error !== undefined ? "error" : "aborted"))
        : member.status,
    note: member.stopReason ?? member.note,
    paused: member.status === "paused",
  }
  if (typeof api.agentStatusState === "function") {
    try {
      if (api.agentStatusState({ status: "done", note: "" }) === "stopped")
        return api.agentStatusState(source)
    } catch {
      // Older builds may only accept a string, not the complete result.
    }
  }
  if (source.status === "done") return source.note !== undefined ? "stopped" : "done"
  if (source.status === "error") return "failed"
  if (source.status === "aborted") return "stopped"
  return source.status
}

export function stateBadge(state: AgentStatusState, opts: ViewRenderOptions): ViewSegment[] {
  const badge = amira.AGENT_STATUS_BADGES?.[state] ?? FALLBACK[state]
  return (
    opts.statusBadge?.(state, { pad: true }) ?? [
      { kind: badge.role, text: `${badge.ascii} ${badge.label.padEnd(7)}` },
    ]
  )
}

export function memberBadge(member: MemberView, opts: ViewRenderOptions): ViewSegment[] {
  return stateBadge(memberState(member), opts)
}
