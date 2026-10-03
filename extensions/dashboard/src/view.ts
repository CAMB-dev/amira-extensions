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
import { clock, phaseInfo, summary, timeline } from "./layout.ts"
import { agentsOf, type DashboardAgent, type DashboardSource, type DashboardTab } from "./source.ts"
import { ownCost, traceLogLines } from "./trace.ts"

export const VIEW_KIND = "dashboard"
const TABS = ["summary", "diff", "logs", "actions", "stats"]
const part = (text: string, kind: ViewSegment["kind"] = "text"): ViewSegment => ({ text, kind })
const text = (lines: ViewLine[], id?: string): UiNode => ({ type: "text", id, lines })
const line = (value: string): ViewLine => ({ kind: "text", text: value })
const money = (cost?: number) => (cost === undefined ? "cost unknown" : `$${cost.toFixed(3)}`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`
const agentKey = (id: string) => `agent:${id}`

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

function statsPanel(stats: TraceSummary | undefined, agents: DashboardAgent[], note?: string): UiNode {
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
    { kind: "muted", text: "ⓘ Missing reported costs are unknown, not zero." },
    ...agents.map((item) => line(`${item.name}: ${money(item.cost)}`)),
    ...(note ? [{ kind: "muted" as const, text: `ⓘ ${note}` }] : []),
  ]
  return text(lines, "stats")
}

function details(data: DashboardViewData, ctx: UiContext, agent?: DashboardAgent): UiNode {
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
      body: summary(data.source, agent, ctx),
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
      body: statsPanel(detail.stats, agentsOf(data.source.snapshot()), data.source.snapshot().note),
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
  const id = typeof ctx.page?.data === "string" ? pageWidget(ctx.page.data, "detail") : "detail"
  const active = tabs.find((tab) => tab.key === ctx.state.activeTabs[id]) ?? tabs[0]!
  return {
    type: "column",
    children: [
      {
        size: 1,
        node: {
          type: "row",
          children: [
            {
              size: ctx.width < 110 ? "fill" : 72,
              node: {
                type: "tabs",
                id: "detail",
                tabs: tabs.map((tab) => ({ ...tab, body: { type: "spacer" } })),
              },
            },
            ...(ctx.width < 110
              ? []
              : [
                  {
                    node: {
                      type: "bar" as const,
                      left: [],
                      right: [part(`${agent.name}  ${agent.task}   ✕ `, "muted")],
                    },
                  },
                ]),
          ],
        },
      },
      { size: 1, node: { type: "rule" } },
      { node: active.body },
    ],
  }
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
      "e expand all · o diff · p pause/resume · r request changes · a actions · x stop · 1–4 tabs · 5 stats"
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
  onOpen(data, view) {
    const phases = data.source.snapshot().phases
    const active =
      phases.find((phase) =>
        phaseInfo(phase, Date.now()).agents.some(
          (agent) => agent.status === "running" || agent.status === "paused",
        ),
      ) ?? phases[0]
    const first = active?.groups.flatMap((group) => group.agents)[0]
    data.selected = first?.id
    view.setState({
      selected: { timeline: first ? agentKey(first.id) : `phase:${active?.id ?? ""}` },
      focused: "timeline",
    })
  },
  title: (data, ctx) => (ctx.page ? "Dashboard · Agent" : `Dashboard · ${data.source.label}`),
  keys: [
    { key: "e", label: "" },
    { key: "o", label: "" },
    // Capability-specific hints live beside the selected agent, not in the static host key bar.
    { key: "p", label: "" },
    { key: "r", label: "" },
    { key: "x", label: "" },
    { key: "a", label: "" },
    { key: "?", label: "" },
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
    const totals = `phase: ${phase?.name ?? "Agents"}  │  running: ${agents.filter((item) => item.status === "running").length}/${agents.length}  │  cost: ${cost === undefined ? "unknown" : `$${cost.toFixed(4)}`}`
    const top: UiNode = {
      type: "bar",
      left: [
        part(" amira", "accent"),
        part(`  │  workspace: ${snapshot.workspace}${narrow ? "" : `  │  ${totals}`}`),
      ],
      right: [part(narrow ? "? help · q quit" : "? shortcuts  │  q quit ", "muted")],
    }
    const detailHeight = agent ? (narrow ? 6 : Math.min(15, Math.max(9, Math.round(ctx.height * 0.3)))) : 2
    const flashHeight = data.flash ? (narrow ? 2 : 1) : 0
    const panel: UiNode = {
      type: "column",
      children: [
        {
          size: 1,
          node: text([
            {
              kind: "segments",
              parts: [
                part(
                  `${"─".repeat(Math.max(0, Math.floor((ctx.width - 3) / 2)))} ≡ ${"─".repeat(Math.max(0, Math.ceil((ctx.width - 3) / 2)))}`,
                  "muted",
                ),
              ],
            },
          ]),
        },
        { node: page ? pageDetails(details(data, ctx, agent), page) : details(data, ctx, agent) },
        ...(agent
          ? [
              {
                size: 1,
                node: narrow
                  ? text([{ kind: "muted" as const, text: " 1–4 tabs · o diff · a actions · ? shortcuts" }])
                  : {
                      type: "bar" as const,
                      left: [
                        part(
                          " o open diff   p pause/resume   r request changes   a actions   x stop",
                          "muted",
                        ),
                      ],
                      right: [part("1–4 tabs · 5 stats (when available) ", "muted")],
                    },
              },
            ]
          : []),
      ],
    }
    return {
      type: "column",
      children: [
        { size: 1, node: top },
        ...(narrow ? [{ size: 1, node: { type: "bar" as const, left: [part(totals, "muted")] } }] : []),
        { size: 1, node: { type: "rule" } },
        ...(!page
          ? [
              {
                node: timeline(
                  data.source,
                  {
                    ...ctx,
                    height: Math.max(0, ctx.height - (narrow ? 3 : 2) - detailHeight - 3 - flashHeight),
                  },
                  agent?.id,
                ),
              },
            ]
          : []),
        { ...(page ? {} : { size: detailHeight }), node: panel },
        ...(data.flash
          ? [{ size: flashHeight, node: text([{ kind: "accent" as const, text: data.flash }]) }]
          : []),
        {
          size: 3,
          node: {
            type: "box",
            child: {
              type: "bar",
              left: [
                part(
                  narrow
                    ? " > Ask Amira after closing this view"
                    : " > Ask Amira or enter a command after closing this view…",
                  "muted",
                ),
              ],
              right: narrow ? [] : [part("Hint only · close this view to send ", "muted")],
            },
          },
        },
      ],
    }
  },
  onEvent,
}
