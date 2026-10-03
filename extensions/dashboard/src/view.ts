import type {
  Message,
  SessionControl,
  TraceSummary,
  UiContext,
  UiControl,
  UiEvent,
  UiNode,
  UiTreeItem,
  ViewDefinition,
  ViewLine,
  ViewSegment,
} from "@amira/api"
import { summarizeTrace } from "@amira/api"
import {
  agentsOf,
  type DashboardAction,
  type DashboardAgent,
  type DashboardSource,
  type DashboardStatus,
  type DashboardTab,
} from "./source.ts"
import { ownCost, traceLogLines } from "./trace.ts"

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
  session?: SessionControl
  selected?: string
  tab?: string
  flash?: string
  busy?: boolean
  /** Tab events retain nested source-widget choices when a dashboard shortcut replaces host maps. */
  activeTabs?: Record<string, string>
  /** Timeline shortcuts require an explicit, agent-keyed activation after host reconciliation. */
  pendingAction?: string
}

/** Key hints name only what this agent's source can do; Open diff and Actions always work. */
function hints(agent: DashboardAgent): string {
  const can = (action: DashboardAction) => agent.actions.includes(action)
  return [
    "o Open diff",
    ...(can("pause") || can("resume") ? [`p ${can("resume") ? "Resume" : "Pause"}`] : []),
    ...(can("request-changes") ? ["r Request changes"] : []),
    ...(can("stop") ? ["x Stop"] : []),
    "a ⋮ Actions",
  ].join(" · ")
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
            {
              kind: "muted",
              text: `${agent.files.length} ${agent.files.length === 1 ? "file" : "files"} reported changed · ${money(agent.cost)}`,
            },
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
              text: hints(agent),
            },
          ]),
        },
      ],
    },
  }
}

function timeline(data: DashboardViewData, ctx: UiContext, selected?: string): UiNode {
  const expanded = ctx.state.expanded.timeline
  const isExpanded = (key: string) => expanded === undefined || expanded.includes(key)
  const items: UiTreeItem[] = data.source.snapshot().phases.map((phase) => ({
    key: `phase:${phase.id}`,
    row: [part(phase.name, "accent")],
    rail: true,
    underline: true,
    node: [part("◉", "accent")],
    aside: [part(isExpanded(`phase:${phase.id}`) ? "▾" : "▸", "muted")],
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
            `${group.ref ?? group.id}  ${isExpanded(`group:${phase.id}:${group.id}`) ? "▾" : "▸"}`,
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
    ? { type: "tree", id: "timeline", expanded: "all", items }
    : text([line("No agents yet. Start a task with sub-agents, then return here.")], "empty")
}

function statsPanel(stats: TraceSummary | undefined, agents: DashboardAgent[]): UiNode {
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
    ...agents.map((item) => line(`${item.name}: ${money(item.cost)}`)),
  ]
  return text(lines, "stats")
}

function details(data: DashboardViewData, agent?: DashboardAgent): UiNode {
  if (!agent)
    return text(
      [line("Select an agent in the timeline, then press Enter to open its page.")],
      "selection-hint",
    )
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
    ...(agent.sessionId && readable(data.session, agent.sessionId)
      ? [
          ["open-transcript", "Open transcript", ""],
          ["open-trace", "Open trace", ""],
        ]
      : []),
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
                : key === "open-transcript" || key === "open-trace"
                  ? "View child session"
                  : data.source.act && agent.actions.some((action) => action === key)
                    ? "Available"
                    : "Unavailable from this source",
          },
        })),
      },
    },
  ]
  if (detail?.stats)
    tabs.push({
      key: "stats",
      label: "Stats",
      body: statsPanel(detail.stats, agentsOf(data.source.snapshot())),
    })
  for (const tab of sourceTabs(detail?.tabs)) {
    let body: UiNode | ViewLine[]
    try {
      body = tab.render()
    } catch (error) {
      body = [
        {
          kind: "warning",
          text: `This tab failed to render: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]
    }
    tabs.push({
      key: tab.key,
      label: tab.label,
      body: mapWidgetIds(Array.isArray(body) ? text(body, "body") : body, (id) =>
        JSON.stringify(["source-tab", tab.key, id, agent.id]),
      ),
    })
  }
  return { type: "tabs", id: "detail", tabs }
}

/** Transcript and trace are offered only for descendants the session itself lists. */
function readable(session: SessionControl | undefined, id: string): boolean {
  try {
    return !!session?.subagents().some((child) => child.id === id)
  } catch {
    return false
  }
}

function sourceTabs(tabs: DashboardTab[] = []): DashboardTab[] {
  const seen = new Set(TABS)
  return tabs.filter((tab) => {
    if (!tab.key || seen.has(tab.key)) return false
    seen.add(tab.key)
    return true
  })
}

/** Namespace entire source subtrees, including inactive tabs and tree details. */
function mapWidgetIds(node: UiNode, map: (id: string) => string): UiNode {
  if (node.type === "column" || node.type === "row")
    return {
      ...node,
      children: node.children.map((child) => ({ ...child, node: mapWidgetIds(child.node, map) })),
    }
  if (node.type === "box") return { ...node, child: mapWidgetIds(node.child, map) }
  if (node.type === "tabs")
    return {
      ...node,
      id: map(node.id),
      tabs: node.tabs.map((tab) => ({ ...tab, body: mapWidgetIds(tab.body, map) })),
    }
  if (node.type === "tree") {
    const items = (rows: UiTreeItem[]): UiTreeItem[] =>
      rows.map((item) => ({
        ...item,
        ...(item.children ? { children: items(item.children) } : {}),
        ...(item.detail && !Array.isArray(item.detail) ? { detail: mapWidgetIds(item.detail, map) } : {}),
      }))
    return { ...node, id: map(node.id), items: items(node.items) }
  }
  return "id" in node && node.id ? { ...node, id: map(node.id) } : node
}

function selectedAgent(data: DashboardViewData, key?: string): DashboardAgent | undefined {
  const id = key?.startsWith("agent:") ? key.slice(6) : key ? undefined : data.selected
  return agentsOf(data.source.snapshot()).find((agent) => agent.id === id)
}

// Page identity travels through host-owned focus, not a cache that would outlive Esc.
const pageWidget = (agentId: string, id: string) => JSON.stringify(["agent-page", agentId, id])
function widgetTarget(id?: string): { agentId?: string; id?: string; page?: boolean } {
  try {
    const value: unknown = JSON.parse(id ?? "")
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === "agent-page" &&
      typeof value[1] === "string" &&
      typeof value[2] === "string"
    )
      return { agentId: value[1], id: value[2], page: true }
    if (Array.isArray(value) && value[0] === "source-tab" && typeof value[3] === "string")
      return { agentId: value[3], id }
  } catch {
    // Root widgets have plain IDs.
  }
  return { id }
}

function pageDetails(node: UiNode, agentId: string): UiNode {
  return mapWidgetIds(node, (id) => pageWidget(agentId, id))
}

function pageControl(view: UiControl, data: DashboardViewData, agentId?: string): UiControl {
  const widget = (id: string) => (agentId ? pageWidget(agentId, id) : id)
  return {
    ...view,
    focus: (id) => view.focus(widget(id)),
    setState: (patch) => {
      if (patch.activeTabs) {
        data.activeTabs = {
          ...data.activeTabs,
          ...Object.fromEntries(Object.entries(patch.activeTabs).map(([id, tab]) => [widget(id), tab])),
        }
        patch = { ...patch, activeTabs: data.activeTabs }
      }
      view.setState(patch)
    },
  }
}

function setTab(data: DashboardViewData, view: UiControl, tab: string) {
  data.tab = tab
  if (tab !== "actions") data.pendingAction = undefined
  view.setState({ activeTabs: { detail: tab } })
}

interface SessionPage {
  kind: "session"
  source: DashboardSource
  rootId: string
  body: UiNode
}

function transcriptLines(messages: readonly Message[] | undefined): ViewLine[] {
  if (!messages?.length) return [line("No transcript messages available for this child session.")]
  return messages.flatMap((message) => [
    {
      kind: "accent" as const,
      text:
        message.role === "toolResult"
          ? `tool: ${message.toolName}${message.isError ? " (error)" : ""}`
          : message.role,
    },
    ...message.content.flatMap((block): ViewLine[] => {
      if (block.type === "text" || block.type === "thinking")
        return block.text
          .split("\n")
          .map((value) => ({ kind: block.type === "thinking" ? "muted" : "text", text: value }))
      if (block.type === "toolCall") return [line(`${block.name} ${JSON.stringify(block.args)}`)]
      return [{ kind: "muted", text: `[${block.type}]` }]
    }),
    line(""),
  ])
}

async function openSessionPage(
  data: DashboardViewData,
  view: UiControl,
  agent: DashboardAgent,
  trace: boolean,
) {
  const session = data.session
  if (!session || !agent.sessionId) {
    data.flash = "No child session is available from this source."
    return
  }
  const rootId = session.info().id
  const sessionId = agent.sessionId
  const page: SessionPage = {
    kind: "session",
    source: data.source,
    rootId,
    body: text([line("Loading…")], "session-page:loading"),
  }
  // Push before awaiting. Esc can discard this page; completion must never push it back.
  view.pushPage({ title: `${trace ? "Trace" : "Transcript"} · ${agent.name}`, data: page })
  try {
    if (!trace) {
      page.body = text(transcriptLines(session.subagentMessages(sessionId)), "session-page:transcript")
    } else {
      const records = await session.trace(sessionId)
      if (session.info().id !== rootId) throw new Error("Session changed. Reopen the dashboard.")
      if (records.some((record) => record.type === "trace" && record.sessionId !== sessionId))
        throw new Error("Trace records belong to another session.")
      const stats = records.length ? summarizeTrace(records) : undefined
      page.body = mapWidgetIds(
        {
          type: "tabs",
          id: "trace",
          tabs: [
            {
              key: "stats",
              label: "Stats",
              body: statsPanel(stats, [{ ...agent, cost: ownCost(records, stats?.usage.cost) }]),
            },
            {
              key: "logs",
              label: "Logs",
              body: text(
                records.length ? records.flatMap(traceLogLines) : [line("No trace records available.")],
                "logs",
              ),
            },
          ],
        },
        (id) => `session-page:${id}`,
      )
    }
  } catch (error) {
    page.body = text(
      [
        {
          kind: "warning",
          text: `Could not open ${trace ? "trace" : "transcript"}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      "session-page:error",
    )
  }
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
  if (action === "open-transcript" || action === "open-trace") {
    await openSessionPage(data, view, agent, action === "open-trace")
    view.requestRender()
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

function onEvent(event: UiEvent, data: DashboardViewData, host: UiControl) {
  const target = widgetTarget(event.type === "key" ? event.focused : event.id)
  if (target.id?.startsWith("session-page:")) {
    if (event.type === "key" && event.key === "5")
      host.setState({ activeTabs: { "session-page:trace": "stats" } })
    else if (event.type === "key" && (event.key === "left" || event.key === "right")) {
      host.setState({
        activeTabs: { "session-page:trace": target.id === "session-page:logs" ? "stats" : "logs" },
      })
    }
    return
  }
  const view = pageControl(host, data, target.page ? target.agentId : undefined)
  if (event.type === "tab") data.activeTabs = { ...data.activeTabs, [event.id]: event.key }
  if ((event.type === "select" || event.type === "activate") && event.id === "timeline") {
    data.selected = event.key.startsWith("agent:") ? event.key.slice(6) : undefined
    if (event.type === "activate" && data.selected) {
      data.pendingAction = undefined
      view.pushPage({
        data: data.selected,
        state: {
          activeTabs: { [pageWidget(data.selected, "detail")]: "summary" },
          focused: pageWidget(data.selected, "detail"),
        },
      })
    }
  }
  if (event.type === "tab" && target.id === "detail") data.tab = event.key
  if (event.type === "activate" && target.id === "actions") {
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
  const agent = selectedAgent(data, target.agentId ? agentKey(target.agentId) : undefined)
  if (event.key === "e") {
    // Remove the explicit key list: the host's expanded="all" mode includes future rows.
    view.setState({ expanded: {} })
  } else if (event.key === "?") {
    data.flash =
      "↑↓ select · ←→ expand or switch focused tabs · Enter open · Tab focus · 1–4 tabs · 5 stats · Esc back/close · q close"
  } else if (event.key === "a") {
    data.pendingAction = undefined
    setTab(data, view, "actions")
    view.focus("actions")
  } else if (["1", "2", "3", "4", "5", "left", "right"].includes(event.key)) {
    const detail = data.source.details(agent?.id ?? "")
    const tabs = [
      ...(detail?.stats ? TABS : TABS.slice(0, 4)),
      ...sourceTabs(detail?.tabs).map((tab) => tab.key),
    ]
    let focusedTab = target.id
    try {
      const value: unknown = JSON.parse(target.id ?? "")
      if (Array.isArray(value) && value[0] === "source-tab" && typeof value[1] === "string")
        focusedTab = value[1]
    } catch {
      /* Built-in widgets have plain IDs. */
    }
    const index = Math.max(
      0,
      tabs.indexOf(tabs.includes(focusedTab ?? "") ? focusedTab! : (data.tab ?? "summary")),
    )
    const tab =
      event.key === "left"
        ? tabs[(index + tabs.length - 1) % tabs.length]
        : event.key === "right"
          ? tabs[(index + 1) % tabs.length]
          : // Let the host reconcile missing tabs; event selection may lag its retained state.
            TABS[Number(event.key) - 1]
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
    } else if (action && target.page && target.agentId) void performAction(data, view, action, target.agentId)
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
  title: (data, ctx) => (ctx.page ? "Dashboard · Agent" : `Dashboard · ${data.source.label}`),
  keys: [
    { key: "e", label: "expand all" },
    { key: "o", label: "diff" },
    // Capability-specific hints live beside the selected agent, not in the static host key bar.
    { key: "p", label: "" },
    { key: "r", label: "" },
    { key: "x", label: "" },
    { key: "a", label: "actions" },
    { key: "?", label: "help" },
    ...["1", "2", "3", "4", "5", "left", "right"].map((key) => ({ key, label: "" })),
  ],
  ui(data, ctx) {
    const sessionPage = ctx.page?.data as SessionPage | undefined
    if (sessionPage?.kind === "session") {
      return sessionPage.source === data.source && sessionPage.rootId === data.session?.info().id
        ? sessionPage.body
        : text(
            [line("Dashboard source or session changed. Press Esc to return.")],
            "session-page:unavailable",
          )
    }
    const snapshot = data.source.snapshot()
    const agents = agentsOf(snapshot)
    const page = typeof ctx.page?.data === "string" ? ctx.page.data : undefined
    const agent = selectedAgent(data, page ? agentKey(page) : ctx.state.selected.timeline)
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
          right: [part("? help · q close", "muted")],
        }
    return {
      type: "column",
      children: [
        { size: narrow ? 2 : 1, node: top },
        {
          size: 1,
          node: {
            type: "rule",
            label: page ? `${agent?.name ?? "Agent unavailable"} · ${data.source.label}` : data.source.label,
          },
        },
        ...(!page ? [{ node: timeline(data, ctx, agent?.id ?? agents[0]?.id) }] : []),
        {
          ...(page ? {} : { size: agent ? Math.max(7, Math.min(18, Math.round(ctx.height * 0.35))) : 7 }),
          node: {
            type: "box",
            title: `Details${agent ? ` · ${agent.name}` : ""}`,
            child: page ? pageDetails(details(data, agent), page) : details(data, agent),
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
              text: page
                ? `${agent ? hints(agent) : "Agent unavailable"} · Esc back`
                : `${agent ? hints(agent) : "Enter opens an agent"} · Esc/q close`,
            },
          ]),
        },
      ],
    }
  },
  onEvent,
}
