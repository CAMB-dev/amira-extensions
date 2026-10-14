import type {
  AgentStatusState,
  UiControl,
  UiNode,
  UiTreeItem,
  ViewControl,
  ViewDefinition,
  ViewLine,
  ViewRenderOptions,
  ViewSegment,
} from "@amira/api"
import { textCells } from "@amira/api"
import type { JournalEntry, RunRecord } from "./journal.ts"
import {
  type AgentNode,
  agentsOf,
  type FlowNode,
  formatDuration,
  newFlow,
  phaseOf,
  runStateText,
  totals,
} from "./progress.ts"
import { agentStatusState, stateBadge, statusBadge } from "./status.ts"

export interface WorkflowViewRun {
  id: string
  meta: RunRecord["meta"]
  record: RunRecord
  flow: FlowNode
  status: RunRecord["status"]
  startedAt: number
  endedAt?: number
  error?: string
  logs: { level: "info" | "warning" | "error"; text: string; nest?: string }[]
  readOnly?: boolean
  stop?(): unknown
}

export interface WorkflowViewData {
  id?: string
  selectedCall?: number
  expandedCalls?: number[]
}

type Row = { depth: number } & ({ header: string } | { agent: AgentNode })

/** Group labels are presentation only: the navigation model contains agents, not headings. */
export function workflowRows(flow: FlowNode, depth = 0): Row[] {
  return flow.phases.flatMap((phase): Row[] => [
    ...(phase.title ? [{ header: phase.title, depth }] : []),
    ...phase.items.flatMap((item): Row[] =>
      item.kind === "agent"
        ? [{ agent: item, depth: depth + (phase.title ? 1 : 0) }]
        : [{ header: `Workflow ${item.name}`, depth: depth + 1 }, ...workflowRows(item, depth + 2)],
    ),
  ])
}

function selectedAgent(run: WorkflowViewRun, data: WorkflowViewData): AgentNode | undefined {
  const agents = agentsOf(run.flow)
  return agents.find((agent) => agent.call === data.selectedCall) ?? agents[0]
}

const text = (value: string, kind: "text" | "muted" = "text"): ViewLine => ({ kind, text: value })
const segments = (parts: ViewSegment[]): ViewLine => ({ kind: "segments", parts })
const money = (value: number | undefined) =>
  value === undefined
    ? "cost unknown"
    : `$${value < 0.01 && value !== 0 ? value.toFixed(4) : value.toFixed(2)}`
const active = (agent: AgentNode) => agent.status === "working" || agent.status === "queued"
const inset = (node: UiNode): UiNode => ({
  type: "row",
  children: [{ size: 2, node: { type: "spacer" } }, { node }],
})

function summary(run: WorkflowViewRun, opts: ViewRenderOptions): ViewLine {
  const counts = new Map<AgentStatusState, number>()
  for (const agent of agentsOf(run.flow)) {
    const state = agentStatusState(agent)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const states: AgentStatusState[] = ["queued", "working", "idle", "paused", "done", "failed", "stopped"]
  const countText = states
    .filter((state) => counts.has(state))
    .map((state) => `${state} ${counts.get(state)}`)
    .join(" · ")
  const elapsed =
    run.readOnly && run.endedAt === undefined
      ? run.record.totals?.durationMs === undefined
        ? "elapsed unknown"
        : formatDuration(run.record.totals.durationMs)
      : formatDuration((run.endedAt ?? opts.now) - run.startedAt)
  const state = run.status === "running" ? "working" : run.status === "error" ? "failed" : run.status
  return segments([
    { kind: "muted", text: `${countText || "0 agents"} · ` },
    { kind: "text", text: `Workflow ${run.meta.name} · ` },
    ...stateBadge(state, opts, false),
    { kind: "muted", text: ` · ${elapsed} · ${money(totals(run.flow).cost)}` },
  ])
}

function protectIdentity(parts: ViewSegment[], counts: string, width: number): ViewSegment[] {
  const [identity, ...details] = parts
  if (!identity) return details
  const room =
    width - Bun.stringWidth(counts) - 1 - Bun.stringWidth(details.map((part) => part.text).join(""))
  if (room < 8) return details
  if (Bun.stringWidth(identity.text) <= room) return parts
  let name = ""
  for (const grapheme of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    identity.text.replace(/ · $/, ""),
  )) {
    if (Bun.stringWidth(name + grapheme.segment) > room - 4) break
    name += grapheme.segment
  }
  return [{ ...identity, text: `${name}… · ` }, ...details]
}

function fold(label: string, value: string, expanded: boolean): ViewLine[] {
  // Segments never wrap, so collapsed events/results occupy exactly one terminal row.
  if (!expanded) return [segments([{ kind: "text", text: `${label}: ${value.replace(/\s+/g, " ")}` }])]
  return [text(`${label}:`), ...value.split("\n").map((line) => text(line))]
}

export function agentDetails(
  agent: AgentNode | undefined,
  opts: ViewRenderOptions,
  expanded: boolean,
): ViewLine[] {
  if (!agent) return [text("Agents appear here when the script calls agent().", "muted")]
  const ms = agent.durationMs ?? (agent.startedAt === undefined ? undefined : opts.now - agent.startedAt)
  return [
    segments([
      { kind: "accent", text: `${agent.label} · ` },
      { kind: "text", text: `${agent.role ?? "agent"} · ` },
      ...statusBadge(agent, opts, false),
      {
        kind: "text",
        text: ` · ${ms === undefined ? "elapsed unknown" : formatDuration(ms)}${agent.cost === undefined ? "" : ` · ${money(agent.cost)}`}`,
      },
    ]),
    ...(agent.status === "cached" ? [text("Replayed from journal; no new usage.", "muted")] : []),
    text(
      agent.currentTools?.length
        ? `Current tool: ${agent.currentTools.map((tool) => tool.name).join(", ")}`
        : `Last action: ${agent.lastAction ?? (active(agent) ? "Waiting for activity" : "Finished")}`,
    ),
    ...(agent.worktreeNote !== undefined ? fold("Worktree", agent.worktreeNote, expanded) : []),
    ...(agent.note !== undefined ? fold("Note", agent.note || "Stopped before completion", expanded) : []),
    text(""),
    text(
      `Events / result · ${expanded ? "expanded" : "folded"} (Enter to ${expanded ? "fold" : "expand"})`,
      "muted",
    ),
    ...(agent.events ?? []).flatMap((event) =>
      fold(
        formatDuration(event.ts - (agent.eventsStartedAt ?? agent.startedAt ?? event.ts)),
        event.text,
        expanded,
      ),
    ),
    ...(agent.text !== undefined ? fold("Result", agent.text, expanded) : []),
    ...(!agent.events?.length && agent.text === undefined ? [text("No agent events yet.", "muted")] : []),
  ]
}

function listLines(
  run: WorkflowViewRun,
  data: WorkflowViewData,
  opts: ViewRenderOptions,
  height: number,
): ViewLine[] {
  const selected = selectedAgent(run, data)
  const rows = workflowRows(run.flow)
  const selectedRow = rows.findIndex((row) => "agent" in row && row.agent === selected)
  // Keep the selected agent visible without giving phase labels selectable widget rows.
  const capacity = Math.max(1, height)
  const start = Math.max(0, Math.min(rows.length - capacity, selectedRow - Math.floor(capacity / 2)))
  return rows.slice(start, start + capacity).map((row) => {
    const indent = "  ".repeat(row.depth)
    if ("header" in row) return segments([{ kind: "muted", text: `${indent}${row.header}` }])
    const isSelected = row.agent === selected
    const kind: "dim" | "text" = opts.focused === false ? "dim" : "text"
    const badge = statusBadge(row.agent, opts)
    return segments([
      { kind, text: `${isSelected ? ">" : " "} ` },
      ...(isSelected ? badge.map((part) => ({ ...part, kind })) : badge),
      { kind: isSelected ? kind : "text", text: ` ${row.agent.label}` },
    ])
  })
}

/**
 * Only agents become host tree items. Headings are display-only detail after the preceding
 * agent (or leading text), so Up/Down indexes agents while groups remain visible. The tree
 * uses no disclosure glyphs; its header details stay expanded and cannot be collapsed.
 */
function agentTree(
  run: WorkflowViewRun,
  opts: ViewRenderOptions,
  selected: AgentNode | undefined,
): { leading: ViewLine[]; items: UiTreeItem[] } {
  const leading: ViewLine[] = []
  const items: UiTreeItem[] = []
  for (const row of workflowRows(run.flow)) {
    const indent = "  ".repeat(row.depth)
    if ("header" in row) {
      const line = segments([{ kind: "muted", text: `${indent}${row.header}` }])
      const previous = items.at(-1)
      if (!previous) leading.push(line)
      else {
        const detail = Array.isArray(previous.detail) ? previous.detail : []
        previous.detail = [...detail, line]
      }
    } else {
      const badge = statusBadge(row.agent, opts)
      const first = badge[0]
      const split = first?.text.indexOf(" ") ?? -1
      const kind: "dim" | "text" = opts.focused === false ? "dim" : "text"
      const selectedParts = (parts: ViewSegment[]) =>
        row.agent === selected ? parts.map((part) => ({ ...part, kind })) : parts
      // The native two-cell node slot holds the symbol; the row starts at the state word.
      items.push({
        key: String(row.agent.call),
        // The fitted symbol must not carry animation provenance that resets inverse mid-row.
        // The word/name row retains the host's redraw demand and the shared symbol itself.
        node:
          row.agent === selected && opts.focused !== false
            ? first && split >= 0
              ? [{ kind: "text", text: first.text.slice(0, split + 1) }]
              : []
            : selectedParts(first && split >= 0 ? [{ ...first, text: first.text.slice(0, split + 1) }] : []),
        row: selectedParts([
          ...(first && split >= 0
            ? [{ ...first, text: first.text.slice(split + 1) }, ...badge.slice(1)]
            : badge),
          { kind: "text", text: ` ${row.agent.label}` },
        ]),
      })
    }
  }
  return { leading, items }
}

function hintLines(hints: string[], width: number): ViewLine[] {
  const rows: string[] = []
  let row = ""
  for (const hint of hints) {
    const next = row ? `${row} · ${hint}` : hint
    if (row && textCells(next) > width) {
      rows.push(row)
      row = hint
    } else row = next
  }
  if (row) rows.push(row)
  return rows.map((row) => segments([{ kind: "muted", text: row }]))
}

/** State patches replace maps, so keep all retained detail expansions alongside group labels. */
function syncExpansion(run: WorkflowViewRun, data: WorkflowViewData, view: UiControl): void {
  const agents = agentsOf(run.flow)
  view.setState({
    expanded: {
      [`workflow-agents:${run.id}`]: agents.map((agent) => String(agent.call)),
      ...Object.fromEntries(
        agents.map((agent) => [
          `workflow-details:${run.id}:${agent.call}`,
          (data.expandedCalls ?? []).includes(agent.call) ? [String(agent.call)] : [],
        ]),
      ),
    },
  })
}

/** A responsive semantic screen; Tab, /, i and host scrolling remain frontend-owned. */
export function createWorkflowView(
  runOf: (data: WorkflowViewData) => WorkflowViewRun | undefined,
  confirmStop: (view: ViewControl, question: string) => Promise<boolean>,
): ViewDefinition<WorkflowViewData> {
  const stop = (data: WorkflowViewData, view: ViewControl) => {
    const run = runOf(data)
    if (!run || run.readOnly || run.status !== "running" || !run.stop) return
    void confirmStop(view, `Stop the workflow run ${run.meta.name}?`).then((yes) => {
      if (yes) run.stop?.()
      view.requestRender()
    })
  }
  return {
    kind: "workflow",
    title(data) {
      const run = runOf(data)
      return run ? `Workflow ${run.meta.name} · ${run.id} · ${runStateText(run.status)}` : "Workflow"
    },
    // The line fallback is kept for frontends which have not adopted semantic widgets.
    header(data, opts) {
      const run = runOf(data)
      if (!run) return [text("No workflow has run in this session.", "muted")]
      if (!run.readOnly && (run.status === "running" || agentsOf(run.flow).some(active)))
        opts.requestRefresh?.(1000)
      return [
        summary(run, opts),
        ...(run.readOnly ? [text("Archived run · read-only", "muted")] : []),
        ...(run.record.startedBy
          ? [text(`Started by: ${run.record.startedBy.label} (${run.record.startedBy.sessionId})`)]
          : []),
        ...(run.error ? [{ kind: "error" as const, text: run.error }] : []),
      ]
    },
    render(data, opts) {
      const run = runOf(data)
      if (!run) return []
      if (!run.readOnly && (run.status === "running" || agentsOf(run.flow).some(active)))
        opts.requestRefresh?.(1000)
      const selected = selectedAgent(run, data)
      return [
        ...listLines(run, data, opts, workflowRows(run.flow).length),
        text(""),
        text("Selected agent", "muted"),
        ...agentDetails(
          selected,
          opts,
          selected !== undefined && (data.expandedCalls ?? []).includes(selected.call),
        ),
      ]
    },
    ui(data, opts): UiNode {
      const run = runOf(data)
      if (!run)
        return {
          type: "text",
          lines: [text("No workflow has run in this session. Start one with /workflow <name>.", "muted")],
        }
      if (!run.readOnly && (run.status === "running" || agentsOf(run.flow).some(active)))
        opts.requestRefresh?.(1000)
      const selected =
        agentsOf(run.flow).find(
          (agent) => String(agent.call) === opts.state.selected[`workflow-agents:${run.id}`],
        ) ?? selectedAgent(run, data)
      const expanded = selected !== undefined && (data.expandedCalls ?? []).includes(selected.call)
      const heading = summary(run, opts)
      const attribution = run.record.startedBy
        ? ` · Started by: ${run.record.startedBy.label} (${run.record.startedBy.sessionId})`
        : ""
      const headingLines = [
        heading,
        text(`${run.id}${run.readOnly ? " · archived, read-only" : ""}${attribution}`, "muted"),
        ...(run.error ? [segments([{ kind: "error", text: run.error }])] : []),
      ]
      if (opts.page?.data === "summary") {
        return inset({
          type: "column",
          children: [
            {
              node: {
                type: "text",
                id: `workflow-summary:${run.id}`,
                lines: [
                  text(heading.kind === "segments" ? heading.parts.map((part) => part.text).join("") : ""),
                  ...headingLines.slice(1),
                  text(
                    "[ focuses the list pane; ] focuses the details pane. Enter in the list focuses details; Enter in details expands or folds the selected entry.",
                  ),
                ],
              },
            },
            {
              size: 1,
              node: {
                type: "text",
                lines: [
                  segments([
                    {
                      kind: "muted",
                      text: opts.focused === false ? "tab view · esc back" : "tab input · esc back",
                    },
                  ]),
                ],
              },
            },
          ],
        })
      }
      const innerWidth = Math.max(1, opts.width - 2)
      const wide = innerWidth >= 80
      const actions = !run.readOnly && run.status === "running" && run.stop ? ["x stop"] : []
      const treeId = `workflow-agents:${run.id}`
      const detailId = `workflow-details:${run.id}:${selected?.call ?? "none"}`
      const detailsActive = opts.state.focused === detailId
      const enter = detailsActive ? (expanded ? "enter fold" : "enter expand") : "enter details"
      const hints =
        opts.focused === false
          ? [segments([{ kind: "muted", text: "tab view · esc close" }])]
          : hintLines(
              ["↑↓ select", "[ ] panes", enter, "? summary", ...actions, "tab input", "esc close"],
              innerWidth,
            )
      const counts = heading.kind === "segments" ? heading.parts[0]!.text.replace(/ · $/, "") : "0 agents"
      const primary =
        heading.kind === "segments" ? protectIdentity(heading.parts.slice(1), counts, innerWidth) : []
      const countRows = hintLines(counts.split(" · "), innerWidth)
      const headerHeight = Math.max(1, countRows.length) + (run.error ? 1 : 0)
      const bodyHeight = Math.max(1, opts.height - headerHeight - hints.length - 2)
      const listHeight = wide
        ? bodyHeight
        : Math.max(2, Math.min(Math.floor(bodyHeight * 0.4), workflowRows(run.flow).length + 2))
      const tree = agentTree(run, opts, selected)
      const list: UiNode = {
        type: "column",
        children: [
          {
            size: detailsActive ? 0 : tree.leading.length,
            node: {
              type: "text",
              lines: detailsActive ? [] : tree.leading,
            },
          },
          {
            node: detailsActive
              ? {
                  type: "text",
                  lines: listLines(run, data, { ...opts, focused: false }, Math.max(1, listHeight - 1)),
                }
              : { type: "tree", id: treeId, expanded: "all", items: tree.items },
          },
        ],
      }
      const detailLines = agentDetails(selected, opts, expanded)
      const eventRow = detailLines.findIndex(
        (line) => line.kind === "muted" && line.text.startsWith("Events / result"),
      )
      const details: UiNode = {
        type: "column",
        children: [
          ...(detailsActive && selected
            ? [
                { size: eventRow, node: { type: "text" as const, lines: detailLines.slice(0, eventRow) } },
                {
                  size: expanded ? undefined : 1,
                  node: {
                    type: "tree" as const,
                    id: detailId,
                    items: [
                      {
                        key: String(selected.call),
                        row: [
                          {
                            kind: opts.focused === false ? ("dim" as const) : ("text" as const),
                            text: `Events / result · ${expanded ? "expanded" : "folded"}`,
                          },
                        ],
                        expandable: true,
                        detail: agentDetails(selected, opts, true).slice(eventRow + 1),
                      },
                    ],
                  },
                },
                ...(!expanded
                  ? [{ node: { type: "text" as const, lines: detailLines.slice(eventRow + 1) } }]
                  : []),
              ]
            : [{ node: { type: "text" as const, lines: detailLines } }]),
        ],
      }
      return inset({
        type: "column",
        gap: 1,
        children: [
          {
            size: headerHeight,
            node: {
              type: "column",
              children: [
                {
                  size: countRows.length,
                  node:
                    countRows.length > 1
                      ? { type: "text", lines: countRows }
                      : { type: "bar", left: primary, right: [{ kind: "muted", text: counts }] },
                },
                ...(run.error
                  ? [
                      {
                        size: 1,
                        node: {
                          type: "text" as const,
                          lines: [segments([{ kind: "error", text: run.error }])],
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
          {
            node: {
              type: wide ? "row" : "column",
              gap: 1,
              divider: wide,
              children: [
                {
                  size: wide
                    ? Math.min(
                        28,
                        Math.max(
                          22,
                          ...workflowRows(run.flow).flatMap((row) =>
                            "agent" in row ? [textCells(row.agent.label) + 14] : [],
                          ),
                        ),
                      )
                    : listHeight,
                  node: list,
                },
                { node: details },
              ],
            },
          },
          {
            size: hints.length,
            node: { type: "text", lines: hints },
          },
        ],
      })
    },
    keys: [
      { key: "[", label: "" },
      { key: "]", label: "" },
      // Compatibility for one release: keep the old toggle silent in hints.
      { key: "d", label: "" },
      { key: "?", label: "" },
      { key: "x", label: "", run: stop },
    ],
    onEvent(event, data, view) {
      if (event.type === "key" && event.key === "x") {
        stop(data, view)
        return
      }
      const run = runOf(data)
      if (!run) return
      if (event.type === "key" && event.key === "?") {
        view.pushPage({ title: "Workflow summary", data: "summary" })
        return
      }
      const treeId = `workflow-agents:${run.id}`
      if (event.type === "toggle" && event.id === treeId) {
        // Group labels are not collapsible content or selectable rows.
        syncExpansion(run, data, view)
      } else if (
        (event.type === "activate" || event.type === "toggle") &&
        event.id.startsWith(`workflow-details:${run.id}:`)
      ) {
        const call = Number(event.key)
        const expanded = data.expandedCalls ?? []
        const open = event.type === "toggle" ? event.expanded : !expanded.includes(call)
        data.expandedCalls = open
          ? [...new Set([...expanded, call])]
          : expanded.filter((item) => item !== call)
        syncExpansion(run, data, view)
      } else if ((event.type === "select" || event.type === "activate") && event.id === treeId) {
        const selected = agentsOf(run.flow).find((agent) => String(agent.call) === event.key)
        if (!selected) return
        data.selectedCall = selected.call
        if (event.type === "activate") view.focus(`workflow-details:${run.id}:${selected.call}`)
      } else if (event.type === "key" && event.key === "[") {
        view.focus(treeId)
      } else if (event.type === "key" && event.key === "]") {
        const selected = selectedAgent(run, data)
        if (selected) view.focus(`workflow-details:${run.id}:${selected.call}`)
      } else if (event.type === "key" && event.key === "d") {
        const selected = selectedAgent(run, data)
        view.focus(
          event.focused === treeId ? `workflow-details:${run.id}:${selected?.call ?? "none"}` : treeId,
        )
      } else return
      view.requestRender()
    },
    // Own the wrapped hints; hiding host chrome does not change host key handling.
    hostKeys: "none",
    follow: false,
  }
}

/** Build an immutable, read-only snapshot at command time, never while rendering. */
export function archivedWorkflow(record: RunRecord, entries: JournalEntry[]): WorkflowViewRun {
  const flow = newFlow(record.meta.name, record.meta.phases)
  flow.state = record.status === "done" ? "done" : "error"
  const latest = new Map<string, JournalEntry>()
  const legacy = entries.every((entry) => entry.attempt === undefined)
  for (const entry of entries) {
    if (legacy || entry.attempt === (record.resumes ?? 0)) latest.set(entry.key, entry)
  }
  const nests = new Map<string, FlowNode>()
  for (const [index, entry] of [...latest.values()].sort((a, b) => (a.call ?? 0) - (b.call ?? 0)).entries()) {
    let parent = flow
    if (entry.nest) {
      // Recorded paths distinguish a known unphased invocation from unknown legacy ancestry.
      const path =
        entry.nestPath?.length && entry.nestPath.at(-1)?.nest === entry.nest
          ? entry.nestPath
          : [{ nest: entry.nest, parentPhase: "Unknown parent phase" }]
      for (const ancestor of path) {
        let nested = nests.get(ancestor.nest)
        if (!nested) {
          nested = newFlow(ancestor.nest, [])
          nested.nest = ancestor.nest
          nested.state = flow.state
          nests.set(ancestor.nest, nested)
          phaseOf(parent, ancestor.parentPhase).items.push(nested)
        }
        parent = nested
      }
    }
    phaseOf(parent, entry.phase).items.push({
      kind: "agent",
      call: entry.call ?? index,
      label: entry.label,
      status: entry.status ?? "done",
      role: entry.role,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      cost: entry.cost,
      tokens: entry.tokens,
      prompt: entry.prompt,
      model: entry.model,
      childId: entry.sessionId,
      note: entry.note ?? entry.error,
      worktreeNote: entry.worktreeNote,
      events: entry.events,
      eventsStartedAt: entry.eventsStartedAt,
      lastAction: entry.events?.at(-1)?.text.replace(/\s+/g, " ").slice(0, 160),
      text: entry.text,
    })
  }
  // A cold snapshot has no live controller. Unclosed running records are interrupted,
  // not live elapsed clocks or working spinners; retain the original record for diagnostics.
  return {
    ...record,
    status: record.status === "running" ? "stopped" : record.status,
    record,
    flow,
    logs: [],
    readOnly: true,
  }
}
