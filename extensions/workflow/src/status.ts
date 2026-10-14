import type { AgentStatusState, ViewRenderOptions, ViewSegment } from "@amira/api"
import * as amira from "@amira/api"
import type { AgentNode } from "./progress.ts"

// Namespace detection matters: an optional render helper does not protect missing named exports.
const FALLBACK_BADGES = {
  queued: { ascii: ".", role: "dim", label: "queued" },
  working: { ascii: "*", role: "accent", label: "working" },
  idle: { ascii: "o", role: "muted", label: "idle" },
  paused: { ascii: "|", role: "warning", label: "paused" },
  done: { ascii: "v", role: "success", label: "done" },
  failed: { ascii: "x", role: "error", label: "failed" },
  stopped: { ascii: "|", role: "warning", label: "stopped" },
} as const

/** Workflow-only lifecycle names are normalized before handing the complete info to the host. */
export function agentStatusState(
  agent: Pick<AgentNode, "status" | "note" | "paused" | "idle">,
): AgentStatusState {
  const info = {
    ...agent,
    status:
      agent.status === "cached"
        ? ("done" as const)
        : agent.idle && agent.status === "working"
          ? ("idle" as const)
          : agent.status,
  }
  if (typeof amira.agentStatusState === "function") {
    try {
      // Older mappers accepted only strings, or lost empty early-end notes.
      if (amira.agentStatusState({ status: "done", note: "" }) === "stopped")
        return amira.agentStatusState(info)
    } catch {}
  }
  if (info.status === "done" && info.note !== undefined) return "stopped"
  if (info.status === "working" && info.paused) return "paused"
  return info.status === "error" ? "failed" : info.status === "aborted" ? "stopped" : info.status
}

export function statusBadge(
  agent: Pick<AgentNode, "status" | "note" | "paused" | "idle">,
  opts: ViewRenderOptions,
  pad = true,
): ViewSegment[] {
  return stateBadge(agentStatusState(agent), opts, pad)
}

export function stateBadge(state: AgentStatusState, opts: ViewRenderOptions, pad = true): ViewSegment[] {
  const badge = (amira.AGENT_STATUS_BADGES ?? FALLBACK_BADGES)[state]
  return (
    opts.statusBadge?.(state, { pad }) ?? [
      { kind: badge.role, text: `${badge.ascii} ${pad ? badge.label.padEnd(7) : badge.label}` },
    ]
  )
}
