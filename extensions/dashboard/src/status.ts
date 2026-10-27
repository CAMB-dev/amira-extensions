import * as amira from "@amira/api"
import type { DashboardStatus } from "./source.ts"

type StatusApi = {
  agentStatusState?: (source: amira.AgentStatusSource) => amira.AgentStatusState
  AGENT_STATUS_BADGES?: typeof amira.AGENT_STATUS_BADGES
}

// The shared table's static vocabulary, for hosts predating its export. No private glyph set.
const fallback: typeof amira.AGENT_STATUS_BADGES = {
  queued: { symbol: "·", ascii: ".", role: "dim", label: "queued" },
  working: { symbol: "⠋", ascii: "*", role: "accent", label: "working" },
  idle: { symbol: "○", ascii: "o", role: "muted", label: "idle" },
  paused: { symbol: "‖", ascii: "|", role: "warning", label: "paused" },
  done: { symbol: "✓", ascii: "v", role: "success", label: "done" },
  failed: { symbol: "✗", ascii: "x", role: "error", label: "failed" },
  stopped: { symbol: "‖", ascii: "|", role: "warning", label: "stopped" },
}

/** Older mappers accepted strings only, or discarded notes and active pauses. */
export function displayState(
  source: amira.AgentStatusSource,
  api: StatusApi = amira,
): amira.AgentStatusState {
  if (typeof api.agentStatusState === "function") {
    try {
      if (
        api.agentStatusState({ status: "done", note: "" }) === "stopped" &&
        api.agentStatusState({ status: "running", paused: true }) === "paused"
      )
        return api.agentStatusState(source)
    } catch {
      // String-only hosts cannot consume complete lifecycle info.
    }
  }
  const info =
    typeof source === "string"
      ? { status: source }
      : "status" in source
        ? source
        : (source.end ?? {
            status: source.paused
              ? "paused"
              : source.idle
                ? "idle"
                : source.queued || source.startedAt === undefined
                  ? "queued"
                  : "working",
          })
  if (info.status === "done" && info.note !== undefined) return "stopped"
  if (info.status === "running" || info.status === "working")
    return "paused" in info && info.paused ? "paused" : "working"
  return info.status === "error" ? "failed" : info.status === "aborted" ? "stopped" : info.status
}

/** Preserve the source contract's running spelling; display vocabulary remains host-owned. */
export function dashboardStatus(source: amira.AgentStatusSource): DashboardStatus {
  const state = displayState(source)
  return state === "working" ? "running" : state
}

export function statusTone(source: amira.AgentStatusSource): amira.ViewSegment["kind"] {
  const state = displayState(source)
  return (amira.AGENT_STATUS_BADGES?.[state] ?? fallback[state]).role
}

/** Padded for aligned columns; headings and prose pass `pad: false`. */
export function statusBadge(
  source: amira.AgentStatusSource,
  opts: Pick<amira.ViewRenderOptions, "statusBadge"> = {},
  api: StatusApi = amira,
  pad = true,
): amira.ViewSegment[] {
  const state = displayState(source, api)
  if (typeof opts.statusBadge === "function") return opts.statusBadge(state, { pad })
  return staticStatusBadge(state, api, pad)
}

/** Historical events must not acquire the live helper's spinner metadata or cadence. */
export function staticStatusBadge(
  source: amira.AgentStatusSource,
  api: StatusApi = amira,
  pad = true,
): amira.ViewSegment[] {
  const state = displayState(source, api)
  const badge = api.AGENT_STATUS_BADGES?.[state] ?? fallback[state]
  // Render options expose no static theme glyph: ASCII is safe for every theme.
  return [{ kind: badge.role, text: `${badge.ascii} ${pad ? badge.label.padEnd(7) : badge.label}` }]
}

/** Compact slots keep the timeline rail fixed, using the host badge's symbol and style. */
export function statusMark(
  source: amira.AgentStatusSource,
  opts: amira.ViewRenderOptions,
): amira.ViewSegment[] {
  const badge = statusBadge(source, opts)
  const first = badge[0]
  return first ? [{ ...first, text: first.text.split(" ")[0]! }] : []
}
