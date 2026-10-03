import type {
  UiContext,
  UiControl,
  UiEvent,
  UiNode,
  UiTreeItem,
  ViewDefinition,
  ViewLine,
  ViewSegment,
} from "@amira/api"
import { agentsOf, type DashboardAgent, type DashboardSource, type DashboardStatus } from "./source.ts"

export const VIEW_KIND = "dashboard"
const TABS = ["summary", "diff", "logs", "actions", "stats"]
const mark: Record<DashboardStatus, string> = {
  queued: "◌",
  running: "●",
  idle: "○",
  paused: "‖",
  done: "✓",
  failed: "✗",
  stopped: "⊘",
}
const part = (text: string, kind: ViewSegment["kind"] = "text"): ViewSegment => ({ text, kind })
const text = (lines: ViewLine[], id?: string): UiNode => ({ type: "text", id, lines })
const line = (value: string): ViewLine => ({ kind: "text", text: value })
const money = (cost?: number) => (cost === undefined ? "cost unknown" : `$${cost.toFixed(3)}`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`
const clock = (at?: number) => (at === undefined ? "--:--:--" : new Date(at).toISOString().slice(11, 19))
const agentKey = (id: string) => `agent:${id}`
const tone = (status: DashboardStatus): ViewSegment["kind"] =>
  status === "failed" ? "error" : status === "done" ? "success" : status === "running" ? "accent" : "muted"

export interface DashboardViewData {
  source: DashboardSource
  selected?: string
  page?: string
  tab?: string
  flash?: string
  busy?: boolean
  /** Timeline shortcuts require an explicit, agent-keyed activation after host reconciliation. */
  pendingAction?: string
}

function card(agent: DashboardAgent, narrow: boolean): UiNode {
  return {
    type: "box",
    title: {
      kind: "segments",
      parts: [
        part(`${mark[agent.status]} ${agent.name}  `, tone(agent.status)),
        ...(agent.language ? [{ kind: "chip" as const, text: agent.language, tone: "info" as const }] : []),
      ],
    },
    aside: agent.status,
    child: {
      type: "column",
      children: [
        { size: narrow ? 2 : 1, node: text([line(agent.task)]) },
        {
          size: 1,
          node: {
            type: "progress",
            value: agent.progress ?? 0,
            width: 18,
            label: agent.progress === undefined ? "Progress unknown" : `${Math.round(agent.progress * 100)}%`,
          },
        },
        {
          size: 1,
          node: text([
            { kind: "muted", text: `${agent.files.length} files reported changed · ${money(agent.cost)}` },
          ]),
        },
        ...agent.files
          .slice(0, narrow ? 1 : 3)
          .map((file) => ({ size: 1, node: text([{ kind: "code" as const, text: file.path }]) })),
        {
          size: narrow ? 2 : 1,
          node: text([
            {
              kind: "accent",
              text: `o Open diff · p ${agent.status === "paused" ? "Resume" : "Pause"} · r Request changes · a ⋮ Actions`,
            },
          ]),
        },
      ],
    },
  }
}

function timeline(data: DashboardViewData, ctx: UiContext, selected?: string): UiNode {
  const expanded = new Set(ctx.state.expanded.timeline ?? [])
  const items: UiTreeItem[] = data.source.snapshot().phases.map((phase) => ({
    key: `phase:${phase.id}`,
    row: [part(phase.name, "accent")],
    rail: true,
    underline: true,
    node: [part("◉", "accent")],
    aside: [part(expanded.has(`phase:${phase.id}`) ? "▾" : "▸", "muted")],
    children: phase.groups.map((group) => {
      const running = group.agents.filter((agent) => agent.status === "running").length
      const times = group.agents.flatMap((agent) => (agent.startedAt === undefined ? [] : [agent.startedAt]))
      const failed = group.agents.some((agent) => agent.status === "failed")
      const done = group.agents.length > 0 && group.agents.every((agent) => agent.status === "done")
      return {
        key: `group:${phase.id}:${group.id}`,
        lead: [
          part(
            `${clock(times.length ? Math.min(...times) : undefined)}  ${running ? "●" : failed ? "✗" : done ? "✓" : "○"}`,
            failed ? "error" : "muted",
          ),
        ],
        node: [part(running ? "◉" : "○", running ? "accent" : "muted")],
        row: [part(`${group.name} ×${group.agents.length}`), part(`  ${running} running`, "muted")],
        aside: [
          part(
            `${group.ref ?? group.id}  ${expanded.has(`group:${phase.id}:${group.id}`) ? "▾" : "▸"}`,
            "muted",
          ),
        ],
        rail: true,
        underline: true,
        children: group.agents.map((agent) => ({
          key: agentKey(agent.id),
          row: [part(`${mark[agent.status]} ${agent.name}`, tone(agent.status))],
          aside: [part(agent.status, tone(agent.status))],
          rail: true,
          detail: ctx.width >= 110 || agent.id === selected ? card(agent, ctx.width < 110) : undefined,
        })),
      }
    }),
  }))
  return agentsOf(data.source.snapshot()).length
    ? { type: "tree", id: "timeline", items }
    : text([line("No agents yet. Start a task with sub-agents, then return here.")], "empty")
}

function statsPanel(data: DashboardViewData, agent: DashboardAgent): UiNode {
  const stats = data.source.details(agent.id)?.stats
  if (!stats) return text([line("No trace statistics available.")], "stats-empty")
  const rows = [
    ["First token wait", stats.modelWaitMs],
    ["Streaming", stats.modelStreamMs],
    ["Model time (unclassified)", stats.modelUnknownMs],
    ["Tools (interval union)", stats.toolTimeMs],
    ["Approval wait", stats.approvalWaitMs],
    ["Idle", stats.idleMs],
  ] as const
  // One scrollable text widget keeps every section reachable on a short terminal.
  const lines: ViewLine[] = [
    line(`Time split · wall ${seconds(stats.wallTimeMs)}`),
    ...rows.map(([label, ms]) => line(`${label.padEnd(26)} ${seconds(ms)}`)),
    { kind: "muted", text: "Intervals may overlap; these metrics do not add up to wall time." },
    line(""),
    line("Per-tool table · count / total / average / maximum / outcomes"),
    ...Object.entries(stats.tools).map(([name, tool]) =>
      line(
        `${name}  ${tool.count}  ${seconds(tool.totalMs)} / ${seconds(tool.avgMs)} / ${seconds(tool.maxMs)}  ${Object.entries(
          tool.outcomes,
        )
          .filter(([, count]) => count)
          .map(([outcome, count]) => `${outcome}:${count}`)
          .join(" ")}`,
      ),
    ),
    line(""),
    line("Failures"),
    ...(stats.failures.length
      ? stats.failures.map((failure) => ({
          kind: "error" as const,
          text: `${clock(failure.at)} ${failure.type === "tool" ? `${failure.name}: ${failure.outcome}` : `Turn ${failure.turnId}: ${failure.reason}`} ${failure.message ?? ""}`,
        }))
      : [line("No recorded failures.")]),
    line(""),
    line("Cost per agent · own usage only, no recursive totals"),
    ...agentsOf(data.source.snapshot()).map((item) => line(`${item.name}: ${money(item.cost)}`)),
  ]
  return text(lines, "stats")
}

function details(data: DashboardViewData, agent?: DashboardAgent): UiNode {
  if (!agent)
    return text([line("Select an agent in the timeline. Press e to expand all groups.")], "selection-hint")
  const detail = data.source.details(agent.id)
  const diff: ViewLine[] = agent.files.length
    ? agent.files.flatMap((file) => [
        { kind: "accent" as const, text: file.path },
        ...(file.diff?.length
          ? file.diff
          : [
              {
                kind: "muted" as const,
                text: "No diff available for this file (only its path was reported).",
              },
            ]),
      ])
    : [line("No diff available.")]
  const requested =
    data.pendingAction === "pause-resume"
      ? agent.status === "paused"
        ? "resume"
        : "pause"
      : data.pendingAction
  const labels = [
    ["open-diff", "Open diff", "o"],
    [agent.status === "paused" ? "resume" : "pause", agent.status === "paused" ? "Resume" : "Pause", "p"],
    ["request-changes", "Request changes", "r"],
    ["stop", "Stop agent", "x"],
  ].filter(([key]) => !requested || requested === key)
  const tabs = [
    {
      key: "summary",
      label: "Summary",
      body: text(
        [
          line(`${mark[agent.status]} ${agent.name} · ${agent.status} · ${money(agent.cost)}`),
          line(agent.task),
          ...(detail?.summary ?? []),
          ...(data.source.snapshot().note
            ? [{ kind: "muted" as const, text: data.source.snapshot().note! }]
            : []),
        ],
        "summary",
      ),
    },
    { key: "diff", label: "Diff", body: text(diff, "diff") },
    {
      key: "logs",
      label: "Logs",
      body: {
        type: "text" as const,
        id: "logs",
        follow: true,
        lines: detail?.logs.length ? detail.logs : [line("No recorded messages or tool events.")],
      },
    },
    {
      key: "actions",
      label: "Actions",
      body: {
        type: "table" as const,
        id: "actions",
        columns: [
          { key: "action", label: "Action" },
          { key: "key", label: "Key", size: 5 },
          { key: "available", label: "Availability" },
        ],
        rows: labels.map(([key, label, shortcut]) => ({
          key: JSON.stringify([agent.id, key]),
          cells: {
            action: `${label} · ${agent.name}`,
            key: shortcut!,
            available:
              key === "open-diff"
                ? "View reported files"
                : data.source.act && agent.actions.some((action) => action === key)
                  ? "Available"
                  : "Unavailable from this source",
          },
        })),
      },
    },
  ]
  if (detail?.stats) tabs.push({ key: "stats", label: "Stats", body: statsPanel(data, agent) })
  return { type: "tabs", id: "detail", tabs }
}

function selectedAgent(data: DashboardViewData, key?: string): DashboardAgent | undefined {
  const id = data.page ?? (key?.startsWith("agent:") ? key.slice(6) : key ? undefined : data.selected)
  return agentsOf(data.source.snapshot()).find((agent) => agent.id === id)
}

function setTab(data: DashboardViewData, view: UiControl, tab: string) {
  data.tab = tab
  if (tab !== "actions") data.pendingAction = undefined
  view.setState({ activeTabs: { detail: tab } })
}

export async function performAction(
  data: DashboardViewData,
  view: UiControl,
  action: string,
  agentId?: string,
): Promise<void> {
  const agent =
    agentId === undefined
      ? selectedAgent(data)
      : agentsOf(data.source.snapshot()).find((item) => item.id === agentId)
  if (!agent) {
    data.flash = "Select an agent first."
    view.requestRender()
    return
  }
  if (action === "open-diff") {
    setTab(data, view, "diff")
    view.focus("detail")
    return
  }
  if (data.busy) return
  data.busy = true
  try {
    let answer: string | undefined
    if (action === "request-changes") {
      answer = await view.prompt(`Request changes from ${agent.name}`)
      if (!answer) return
    }
    const capability = agent.actions.find((value) => value === action)
    if (!capability || !data.source.act) {
      data.flash =
        action === "request-changes"
          ? "Not sent: messaging this agent is unavailable from this source."
          : `${action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Stop"} is unavailable from this source.`
      return
    }
    if (
      action === "stop" &&
      !(await view.confirm(`Stop ${agent.name}?`, { yes: "stops the agent", no: "keeps it running" }))
    ) {
      data.flash = "Not stopped."
      return
    }
    data.flash = await data.source.act(agent.id, capability, answer)
  } catch (error) {
    data.flash = `Action failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    data.busy = false
    view.requestRender()
  }
}

function onEvent(event: UiEvent, data: DashboardViewData, view: UiControl) {
  if ((event.type === "select" || event.type === "activate") && event.id === "timeline") {
    data.selected = event.key.startsWith("agent:") ? event.key.slice(6) : undefined
    if (event.type === "activate" && data.selected) {
      data.page = data.selected
      setTab(data, view, "summary")
      view.focus("detail")
    }
  }
  if (event.type === "tab" && event.id === "detail") data.tab = event.key
  if (event.type === "activate" && event.id === "actions") {
    // The target travels in the rendered row key, never in a stale selection cache.
    try {
      const target: unknown = JSON.parse(event.key)
      if (
        Array.isArray(target) &&
        target.length === 2 &&
        typeof target[0] === "string" &&
        typeof target[1] === "string"
      ) {
        void performAction(data, view, target[1], target[0])
      }
    } catch {
      /* Ignore keys not produced by this view. */
    }
  }
  if (event.type !== "key") return
  const agent = selectedAgent(data)
  if (event.key === "b") {
    data.page = undefined
    data.pendingAction = undefined
    view.focus("timeline")
  } else if (event.key === "e") {
    view.setState({
      expanded: {
        timeline: data.source
          .snapshot()
          .phases.flatMap((phase) => [
            `phase:${phase.id}`,
            ...phase.groups.flatMap((group) => [
              `group:${phase.id}:${group.id}`,
              ...group.agents.map((item) => agentKey(item.id)),
            ]),
          ]),
      },
    })
  } else if (event.key === "?") {
    data.flash =
      "↑↓ select · ←→ expand or switch focused tabs · Enter open · Tab focus · 1–4 tabs · 5 stats · b back · Esc/q close"
  } else if (event.key === "a") {
    data.pendingAction = undefined
    setTab(data, view, "actions")
    view.focus("actions")
  } else if (["1", "2", "3", "4", "5", "left", "right"].includes(event.key)) {
    const tabs = data.source.details(agent?.id ?? "")?.stats ? TABS : TABS.slice(0, 4)
    const index = Math.max(0, tabs.indexOf(data.tab ?? "summary"))
    const tab =
      event.key === "left"
        ? tabs[(index + tabs.length - 1) % tabs.length]
        : event.key === "right"
          ? tabs[(index + 1) % tabs.length]
          : tabs[Number(event.key) - 1]
    if (tab) setTab(data, view, tab)
  } else {
    const actions: Record<string, string> = {
      o: "open-diff",
      p: agent?.status === "paused" ? "resume" : "pause",
      r: "request-changes",
      x: "stop",
    }
    const action = actions[event.key]
    if (action === "open-diff") {
      setTab(data, view, "diff")
      view.focus("detail")
    } else if (action && data.page) void performAction(data, view, action, data.page)
    else if (action) {
      data.pendingAction = event.key === "p" ? "pause-resume" : action
      data.flash = "Press Enter on the named action to continue. Press a to show all actions."
      setTab(data, view, "actions")
      view.focus("actions")
    }
  }
  view.requestRender()
}

export const dashboardView: ViewDefinition<DashboardViewData> = {
  kind: VIEW_KIND,
  title: (data) => (data.page ? "Dashboard · Agent" : `Dashboard · ${data.source.label}`),
  keys: [
    { key: "e", label: "expand all" },
    { key: "o", label: "diff" },
    { key: "p", label: "pause/resume" },
    { key: "r", label: "request changes" },
    { key: "x", label: "stop" },
    { key: "a", label: "actions" },
    { key: "b", label: "back" },
    { key: "?", label: "help" },
    ...["1", "2", "3", "4", "5", "left", "right"].map((key) => ({ key, label: "" })),
  ],
  ui(data, ctx) {
    const snapshot = data.source.snapshot()
    const agents = agentsOf(snapshot)
    const agent = selectedAgent(data, ctx.state.selected.timeline)
    const cost =
      agents.length && agents.every((item) => item.cost !== undefined)
        ? agents.reduce((sum, item) => sum + item.cost!, 0)
        : undefined
    const phase =
      snapshot.phases.find((item) =>
        item.groups.some((group) => group.agents.some((item) => item.status === "running")),
      ) ?? snapshot.phases[0]
    const narrow = ctx.width < 110
    const totals = `${phase?.name ?? "Agents"}  │ ${agents.filter((item) => item.status === "running").length}/${agents.length} running  │ ${money(cost)}`
    const top: UiNode = narrow
      ? {
          type: "column",
          children: [
            {
              size: 1,
              node: {
                type: "bar",
                left: [part("amira · ", "accent"), part(snapshot.workspace)],
                right: [part("? help", "muted")],
              },
            },
            { size: 1, node: { type: "bar", left: [part(totals)] } },
          ],
        }
      : {
          type: "bar",
          left: [part("amira · ", "accent"), part(`${snapshot.workspace}  │ ${totals}`)],
          right: [part("? help · b back · q quit", "muted")],
        }
    return {
      type: "column",
      children: [
        { size: narrow ? 2 : 1, node: top },
        {
          size: 1,
          node: {
            type: "rule",
            label: data.page
              ? `${agent?.name ?? "Agent unavailable"} · ${data.source.label}`
              : data.source.label,
          },
        },
        ...(!data.page ? [{ node: timeline(data, ctx, agent?.id) }] : []),
        {
          ...(data.page ? {} : { size: narrow ? 7 : 14 }),
          node: {
            type: "box",
            title: `Details${agent ? ` · ${agent.name}` : ""}`,
            child: details(data, agent),
          } as UiNode,
        },
        {
          size: narrow ? 3 : 2,
          node: text([
            {
              kind: data.flash ? "accent" : "muted",
              text:
                data.flash ??
                snapshot.note ??
                "Enter opens an agent · e expands all · Tab moves focus · 1–4 switches tabs",
            },
            {
              kind: "muted",
              text: data.page
                ? "←→ tabs · b back to dashboard · Esc/q closes dashboard"
                : "o diff · p pause/resume · r request changes · a actions · Esc/q close",
            },
          ]),
        },
      ],
    }
  },
  onEvent,
}
