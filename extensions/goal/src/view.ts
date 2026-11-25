import type {
  PanelDefinition,
  PanelLine,
  StatusItem,
  UiControl,
  UiEvent,
  UiNode,
  ViewDefinition,
  ViewLine,
} from "@amira/api"
import type { GoalEngine } from "./engine.ts"
import type { GoalState } from "./types.ts"

export const GOAL_VIEW_KIND = "goal-dock"

function chipTone(phase: GoalState["phase"]): "accent" | "success" | "warning" | "danger" | "neutral" {
  switch (phase) {
    case "running":
    case "verifying":
      return "accent"
    case "completed":
      return "success"
    case "paused":
      return "warning"
    case "failed":
      return "danger"
    default:
      return "neutral"
  }
}

export function createGoalStatusItem(engine: GoalEngine): StatusItem {
  return {
    id: "goal",
    align: "right",
    priority: 40,
    tone() {
      const p = engine.state?.phase
      if (p === "completed") return "success"
      if (p === "paused") return "warning"
      if (p === "failed") return "error"
      if (p === "running" || p === "verifying") return "accent"
      return "muted"
    },
    text() {
      const s = engine.state
      if (!s || s.phase === "idle" || s.phase === "stopped") return undefined
      const doneCount = s.config.criteria.filter((c) => c.done).length
      const totalCount = s.config.criteria.length
      const spend = s.spentUsd > 0 ? ` · $${s.spentUsd.toFixed(3)}` : ""
      if (s.phase === "completed") return `Goal ✓ ${s.iteration}it${spend}`
      if (s.phase === "paused")
        return `Goal ⏸ ${s.iteration}/${s.config.maxIterations} (${doneCount}/${totalCount})`
      if (s.phase === "verifying") return `Goal ⟳ verifying ${s.iteration}/${s.config.maxIterations}`
      return `Goal ${s.iteration}/${s.config.maxIterations} (${doneCount}/${totalCount})${spend}`
    },
  }
}

export function createGoalPanel(engine: GoalEngine): PanelDefinition {
  return {
    id: "goal-panel",
    order: 25,
    render(): PanelLine[] {
      const s = engine.state
      if (!s || s.phase === "idle" || s.phase === "stopped" || s.phase === "completed") return []
      const doneCount = s.config.criteria.filter((c) => c.done).length
      const totalCount = s.config.criteria.length
      const lines: PanelLine[] = [
        {
          kind: "segments",
          parts: [
            { kind: "chip", text: s.phase, tone: chipTone(s.phase) },
            {
              kind: "text",
              text: ` Goal ${s.iteration}/${s.config.maxIterations} (${doneCount}/${totalCount}) `,
            },
            { kind: "muted", text: s.config.prompt.slice(0, 72) },
          ],
        },
      ]
      for (const c of s.config.criteria.slice(0, 4)) {
        lines.push({
          kind: "segments",
          parts: [
            { kind: c.done ? "success" : "muted", text: c.done ? "  ✓ " : "  ○ " },
            { kind: "muted", text: `(${c.id}) ` },
            { kind: "text", text: c.text.slice(0, 86) },
          ],
        })
      }
      if (s.pauseReason) {
        lines.push({ kind: "warning", text: `  ! ${s.pauseReason.slice(0, 96)}` })
      } else if (s.logs.length) {
        const last = s.logs[s.logs.length - 1]!
        lines.push({
          kind: last.ok ? "success" : "error",
          text: `  ${last.ok ? "✓" : "×"} #${last.iteration}: ${last.summary.slice(0, 92)}`,
        })
      }
      return lines
    },
  }
}

export function createGoalView(
  engine: GoalEngine,
  actions: {
    onResume: () => void
    onPause: () => void
    onStop: () => void
  },
): ViewDefinition {
  return {
    kind: GOAL_VIEW_KIND,
    title: () => {
      const s = engine.state
      if (!s) return "Goal"
      return `Goal · ${s.phase} (${s.iteration}/${s.config.maxIterations})`
    },
    ui(): UiNode {
      const s = engine.state
      if (!s) {
        return {
          type: "column",
          gap: 1,
          children: [
            {
              node: {
                type: "text",
                lines: [
                  { kind: "muted", text: "No active goal." },
                  { kind: "accent", text: 'Start one with: /goal "<objective>" --verify "<test command>"' },
                ],
              },
            },
            {
              node: {
                type: "row",
                gap: 1,
                children: [{ node: { type: "button", id: "close", label: "Close" }, size: 10 }],
              },
              size: 1,
            },
          ],
        }
      }

      const doneCount = s.config.criteria.filter((c) => c.done).length
      const totalCount = Math.max(1, s.config.criteria.length)
      const budgetText =
        s.config.budgetUsd !== undefined
          ? `$${s.spentUsd.toFixed(4)} / $${s.config.budgetUsd.toFixed(2)}`
          : `$${s.spentUsd.toFixed(4)}`

      const criteriaLines: ViewLine[] = s.config.criteria.map((c) => ({
        kind: "segments",
        parts: [
          { kind: c.done ? "success" : "muted", text: c.done ? "✓ " : "○ " },
          { kind: "muted", text: `(${c.id}) ` },
          { kind: "text", text: c.text },
          ...(c.evidence ? [{ kind: "muted" as const, text: ` — ${c.evidence}` }] : []),
        ],
      }))

      const logLines: ViewLine[] = s.logs.length
        ? s.logs.slice(-8).map((l) => ({
            kind: "segments",
            parts: [
              { kind: l.ok ? "success" : "error", text: l.ok ? "✓ " : "× " },
              { kind: "muted", text: `#${l.iteration} ` },
              { kind: "text", text: l.summary },
            ],
          }))
        : [{ kind: "muted", text: "No verification checks recorded yet." }]

      const buttons: { node: UiNode; size?: number }[] = []
      if (s.phase === "running" || s.phase === "verifying") {
        buttons.push({ node: { type: "button", id: "pause", label: "Pause" }, size: 10 })
      } else if (s.phase === "paused") {
        buttons.push({ node: { type: "button", id: "resume", label: "Resume", tone: "accent" }, size: 12 })
      }
      if (s.phase !== "stopped" && s.phase !== "completed") {
        buttons.push({ node: { type: "button", id: "stop", label: "Stop" }, size: 10 })
      }
      buttons.push({ node: { type: "button", id: "close", label: "Close" }, size: 10 })

      const bodyChildren: { node: UiNode; size?: number }[] = [
        {
          node: {
            type: "bar",
            left: [
              { kind: "chip", text: s.phase.toUpperCase(), tone: chipTone(s.phase) },
              { kind: "text", text: ` ${s.config.prompt}` },
            ],
            right: [
              {
                kind: "muted",
                text: `${s.config.mode} · ${s.iteration}/${s.config.maxIterations} · ${budgetText}`,
              },
            ],
          },
          size: 1,
        },
        {
          node: {
            type: "progress",
            value: doneCount / totalCount,
            label: `Criteria ${doneCount}/${totalCount}`,
          },
          size: 1,
        },
      ]
      if (s.pauseReason) {
        bodyChildren.push({
          node: { type: "text", lines: [{ kind: "warning", text: `Note: ${s.pauseReason}` }] },
          size: 1,
        })
      }
      bodyChildren.push(
        {
          node: {
            type: "tabs",
            id: "goal-tabs",
            style: "divided",
            tabs: [
              {
                key: "criteria",
                label: `Criteria (${doneCount}/${totalCount})`,
                body: { type: "text", id: "goal-criteria", lines: criteriaLines },
              },
              {
                key: "logs",
                label: `Verify Logs (${s.logs.length})`,
                body: { type: "text", id: "goal-logs", lines: logLines, follow: true },
              },
            ],
          },
        },
        {
          node: { type: "row", gap: 1, children: buttons },
          size: 1,
        },
      )

      return { type: "column", gap: 1, children: bodyChildren }
    },
    onEvent(event: UiEvent, _data: unknown, control: UiControl) {
      if (event.type !== "activate") return
      if (event.key === "pause") actions.onPause()
      else if (event.key === "resume") actions.onResume()
      else if (event.key === "stop") actions.onStop()
      else if (event.key === "close") control.close()
    },
  }
}
