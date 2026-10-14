import type {
  AgentStatusState,
  UiContext,
  UiControl,
  UiNode,
  UiTreeItem,
  ViewControl,
  ViewDefinition,
  ViewLine,
  ViewRenderOptions,
  ViewSegment,
} from "@amira/api"
import { memberBadge, memberState, stateBadge } from "./status.ts"
import type { MemberView, SwarmSnapshot, TimelineEntry } from "./swarm.ts"

export const VIEW_KIND = "swarm"
export const READONLY_VIEW_KIND = "swarm-readonly"

/** Live controls are absent for swarms read back from the session. */
export interface SwarmViewData {
  snapshot(): SwarmSnapshot | undefined
  control?: {
    tell(to: string, text: string): string | undefined
    tellAll?(text: string): number | string
    pause(name?: string): string | undefined
    resume(name?: string): string | undefined
    stopMember(name: string): string | undefined
    stop(): void
  }
  flash?: string
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const known = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0
const cost = (n: number | undefined) => (known(n) ? `$${n.toFixed(2)}` : "cost unknown")

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

export function timelineLine(e: TimelineEntry): Exclude<ViewLine, { kind: "segments" }> {
  const t = clock(e.at)
  switch (e.kind) {
    case "message":
      return {
        kind: e.from === "user" ? "accent" : "text",
        text: `${t} ${e.from === "user" ? "you" : e.from} → ${e.to}: ${oneLine(e.text)}`,
      }
    case "board":
      return { kind: "success", text: `${t} ${e.from} wrote ${e.key}: ${oneLine(e.text)}` }
    case "finish":
      return { kind: "success", text: `${t} ${e.from} finished: ${oneLine(e.text)}` }
    case "end":
      return { kind: "warning", text: `${t} ended: ${oneLine(e.text)}` }
    default:
      return { kind: "muted", text: `${t} ${oneLine(e.text)}` }
  }
}

/** Plain command output uses the same state words as the interactive badge. */
export function memberLine(m: MemberView): Exclude<ViewLine, { kind: "segments" }> {
  return {
    kind: "text",
    text: `${m.name} · ${m.role} · ${memberState(m)} · ${m.turns} turns · ${m.messagesSent} sent${m.note !== undefined ? ` · ${oneLine(m.note)}` : ""}`,
  }
}

function stateCounts(s: SwarmSnapshot): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of s.members) {
    const state = memberState(m)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const order = ["queued", "working", "idle", "paused", "done", "failed", "stopped"]
  return new Map([...counts].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)))
}

function summary(s: SwarmSnapshot, opts: ViewRenderOptions): ViewSegment[] {
  const counts = stateCounts(s)
  const totalCost =
    s.members.length && s.members.every((m) => known(m.cost))
      ? s.members.reduce((sum, m) => sum + m.cost!, 0)
      : undefined
  const state: AgentStatusState =
    s.state === "paused"
      ? "paused"
      : s.state === "ended"
        ? counts.has("failed")
          ? "failed"
          : s.endReason === undefined || s.endReason.startsWith("every member")
            ? "done"
            : "stopped"
        : s.state === "ending"
          ? "stopped"
          : counts.has("working")
            ? "working"
            : counts.has("queued")
              ? "queued"
              : counts.has("paused")
                ? "paused"
                : "idle"
  const parts = [
    elapsed((s.endedAt ?? opts.now) - s.startedAt),
    ...(known(totalCost) ? [cost(totalCost)] : []),
  ]
  return [
    { kind: "accent", text: `Swarm ${s.id} · ` },
    ...stateBadge(state, opts),
    { kind: "muted", text: ` · ${parts.join(" · ")}` },
  ]
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

function refresh(s: SwarmSnapshot, opts: ViewRenderOptions) {
  if (
    s.endedAt === undefined &&
    (s.state === "running" || s.state === "ending") &&
    s.members.some((m) => memberState(m) === "working")
  )
    opts.requestRefresh?.(1000)
}

/** Each long item has a single clipped row and full text available with Enter. */
function folded(
  key: string,
  label: string,
  text: string,
  kind: "text" | "muted" | "warning" = "text",
): UiTreeItem {
  return {
    key,
    row: [{ kind, text: `${label}: ${oneLine(text)}` }],
    expandable: true,
    detail: text.split("\n").map((text) => ({ kind: "text", text })),
  }
}

function details(s: SwarmSnapshot, m: MemberView): UiTreeItem[] {
  const items: UiTreeItem[] = []
  if (m.brief !== undefined) items.push(folded("brief", "Brief", m.brief))
  if (m.note !== undefined) items.push(folded("note", "Note", m.note, "warning"))
  if (m.lastMessage !== undefined) items.push(folded("reply", "Last reply", m.lastMessage))
  if (m.result !== undefined) items.push(folded("result", "Result", m.result))
  for (const entry of s.board.filter((e) => e.by === m.name))
    items.push(folded(`board:${entry.key}`, `Board ${entry.key}`, entry.value))
  // Merge only this member's events and messages, keeping newest last.
  const events = [
    ...(m.events ?? []).map((e) => ({
      at: e.at,
      item: folded(`event:${e.seq}`, clock(e.at), e.text, "muted"),
    })),
    ...s.timeline
      .filter((e) => e.from === m.name || e.to === m.name || (e.kind === "message" && e.to === "all"))
      .map((e) => ({
        at: e.at,
        item: folded(`timeline:${e.seq}`, timelineLine({ ...e, text: "" }).text.replace(/: $/, ""), e.text),
      })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-40)
  items.push(...events.map((e) => e.item))
  if (!events.length)
    items.push({ key: "empty", row: [{ kind: "muted", text: "No recent events or messages." }] })
  return items
}

function keyHints(data: SwarmViewData, ctx: UiContext, readOnly: boolean): ViewLine[] {
  if (ctx.focused === false)
    return [{ kind: "segments", parts: [{ kind: "muted", text: "tab view · esc close" }] }]
  const s = data.snapshot()
  const live = !readOnly && data.control && s && s.state !== "ended" && s.state !== "ending"
  const detailId = ctx.state.focused ?? ""
  const detailKey = ctx.state.selected[detailId]
  const enter = detailId.startsWith("details:")
    ? detailKey && ctx.state.expanded[detailId]?.includes(detailKey)
      ? "enter fold"
      : "enter expand"
    : "enter details"
  return wrappedGroups(
    [
      "↑↓ select",
      "[ ] panes",
      enter,
      "? summary",
      ...(live ? ["m message/all", "p pause/resume", "x stop member", "s stop"] : []),
      "tab input",
      "esc close",
    ],
    ctx.width,
  )
}

function wrappedGroups(groups: string[], width: number): ViewLine[] {
  const rows: string[] = []
  let row = ""
  for (const group of groups) {
    const next = row ? `${row} · ${group}` : group
    if (row && Bun.stringWidth(next) > width) {
      rows.push(row)
      row = group
    } else row = next
  }
  if (row) rows.push(row)
  return rows.map((text) => ({ kind: "segments", parts: [{ kind: "muted", text }] }))
}

/** Native trees reserve two disclosure cells; put the shared badge symbol there, not a blank. */
function memberItem(m: MemberView, ctx: UiContext, selected: boolean, active: boolean): UiTreeItem {
  const parts = [...memberBadge(m, ctx), { kind: "text" as const, text: ` ${m.name}` }].map((p) =>
    selected ? { ...p, kind: active && ctx.focused !== false ? ("text" as const) : ("dim" as const) } : p,
  )
  const node: ViewSegment[] = []
  const row: ViewSegment[] = []
  let cells = 0
  for (const p of parts) {
    let at = 0
    for (const glyph of p.text) {
      const width = Bun.stringWidth(glyph)
      if (cells + width > 2) break
      cells += width
      at += glyph.length
    }
    if (at) node.push({ ...p, text: p.text.slice(0, at) })
    if (at < p.text.length) row.push({ ...p, text: p.text.slice(at) })
  }
  // Fitting animated node fragments closes styles mid-row. Keep provenance in the row,
  // while the selected symbol slot is a plain semantic fragment under one inverse style.
  const symbol =
    selected && active && ctx.focused !== false
      ? node.map((part) => ({ kind: "text" as const, text: part.text }))
      : node
  return { key: m.name, node: symbol, row, gap: 0 }
}

/** Inactive native trees still inverse their selection. Static rows preserve host-owned state. */
function pane(id: string, items: UiTreeItem[], ctx: UiContext, active: boolean): UiNode {
  if (active) return { type: "tree", id, items }
  const expanded = new Set(ctx.state.expanded[id])
  const lines: ViewLine[] = items.flatMap((item) => {
    const open = expanded.has(item.key)
    const prefix: ViewSegment[] = item.node ?? [
      { kind: "muted", text: item.expandable ? (open ? "▾ " : "▸ ") : "  " },
    ]
    return [
      { kind: "segments" as const, parts: [{ kind: "text" as const, text: "  " }, ...prefix, ...item.row] },
      ...(open && Array.isArray(item.detail)
        ? item.detail.map(
            (line): ViewLine =>
              line.kind === "segments"
                ? { kind: "segments", parts: [{ kind: "text", text: "    " }, ...line.parts] }
                : { ...line, text: `    ${line.text}` },
          )
        : []),
    ]
  })
  return { type: "text", lines: lines.slice(ctx.state.scroll[id]?.top ?? 0) }
}

function screen(data: SwarmViewData, ctx: UiContext, readOnly = false): UiNode {
  const s = data.snapshot()
  if (!s) return { type: "text", lines: [{ kind: "muted", text: "This swarm is gone." }] }
  // Semantic screens have no host margin option; match the host's two-cell left inset.
  const inner = { ...ctx, width: Math.max(1, ctx.width - 2) }
  return {
    type: "row",
    children: [{ size: 2, node: { type: "spacer" } }, { node: innerScreen(data, s, inner, readOnly) }],
  }
}

function innerScreen(data: SwarmViewData, s: SwarmSnapshot, ctx: UiContext, readOnly: boolean): UiNode {
  refresh(s, ctx)
  if (ctx.page?.data === "summary")
    return {
      type: "column",
      gap: 1,
      children: [
        {
          node: {
            type: "text",
            lines: [
              { kind: "text", text: `Swarm ${s.id}` },
              { kind: "text", text: s.goal },
              { kind: "segments", parts: summary(s, ctx).slice(1) },
              { kind: "text", text: [...stateCounts(s)].map(([state, n]) => `${state} ${n}`).join(" · ") },
              {
                kind: "text",
                text: "[ focuses the list pane; ] focuses the details pane. Enter in the list focuses details; Enter in details expands or folds the selected entry.",
              },
              ...(!readOnly && data.control && s.state !== "ended" && s.state !== "ending"
                ? [
                    {
                      kind: "text" as const,
                      text: "m messages a member or all; p pauses/resumes; x stops a member; s stops the swarm.",
                    },
                  ]
                : []),
            ],
          },
        },
        {
          size: 1,
          node: {
            type: "text",
            lines: [
              { kind: "muted", text: ctx.focused === false ? "tab view · esc back" : "tab input · esc back" },
            ],
          },
        },
      ],
    }
  const selected = s.members.find((m) => m.name === ctx.state.selected.members) ?? s.members[0]
  const detailId = `details:${selected?.name ?? "none"}`
  const membersActive = !ctx.state.focused?.startsWith("details:")
  const members: UiNode = {
    type: "box",
    title: "Members",
    border: "none",
    child: pane(
      "members",
      s.members.map((m) => memberItem(m, ctx, selected?.name === m.name, membersActive)),
      ctx,
      membersActive,
    ),
  }
  const duration =
    selected &&
    (memberState(selected) === "working" && selected.startedAt !== undefined
      ? ctx.now - selected.startedAt
      : selected.durationMs)
  const detail: UiNode = selected
    ? {
        type: "column",
        gap: 1,
        children: [
          {
            size: 2,
            node: {
              type: "text",
              lines: [
                {
                  kind: "segments",
                  parts: [
                    { kind: "accent", text: `${selected.name} · ` },
                    { kind: "text", text: `${selected.role} · ` },
                    ...memberBadge(selected, ctx),
                    {
                      kind: "muted",
                      text: ` · ${known(duration) ? elapsed(duration) : "elapsed unknown"}${known(selected.cost) ? ` · ${cost(selected.cost)}` : ""}`,
                    },
                  ],
                },
                {
                  kind: "segments",
                  parts: [
                    {
                      kind: "text",
                      text: selected.currentTools?.length
                        ? `Tool: ${selected.currentTools.map((t) => t.name).join(", ")}`
                        : `Last action: ${oneLine(selected.lastAction ?? "No activity yet")}`,
                    },
                  ],
                },
              ],
            },
          },
          { node: pane(detailId, details(s, selected), ctx, !membersActive) },
        ],
      }
    : { type: "text", lines: [{ kind: "muted", text: "No members." }] }
  const wide = ctx.width >= 80
  const body: UiNode = {
    type: wide ? "row" : "column",
    gap: 1,
    divider: wide,
    children: [
      {
        size: wide
          ? Math.min(28, Math.max(22, ...s.members.map((m) => Bun.stringWidth(m.name) + 14)))
          : Math.min(s.members.length + 1, Math.max(2, Math.floor(ctx.height / 3))),
        node: members,
      },
      { node: detail },
    ],
  }
  const hints = keyHints(data, ctx, readOnly)
  const counts = [...stateCounts(s)].map(([state, n]) => `${state} ${n}`)
  const countRows = wrappedGroups(counts, ctx.width)
  return {
    type: "column",
    gap: 1,
    children: [
      {
        size: Math.max(1, countRows.length),
        node:
          countRows.length > 1
            ? { type: "text", lines: countRows }
            : {
                type: "bar",
                left: protectIdentity(summary(s, ctx), counts.join(" · "), ctx.width),
                right: [{ kind: "muted", text: counts.join(" · ") }],
              },
      },
      ...(data.flash
        ? [
            {
              size: 1,
              node: { type: "text" as const, lines: [{ kind: "accent" as const, text: data.flash }] },
            },
          ]
        : []),
      { node: body },
      { size: hints.length, node: { type: "text", lines: hints } },
    ],
  }
}

const navigation: NonNullable<ViewDefinition<SwarmViewData>["keys"]> = [
  { key: "[", label: "" },
  { key: "]", label: "" },
  { key: "?", label: "" },
]

// Mirror only navigation events; rendering remains a pure read of host-owned state.
const viewSelection = new WeakMap<SwarmViewData, string>()
const expansions = new WeakMap<SwarmViewData, Record<string, string[]>>()

const base: ViewDefinition<SwarmViewData> = {
  kind: VIEW_KIND,
  title(data) {
    const s = data.snapshot()
    return s ? `Swarm ${s.id} · ${s.goal}` : "Swarm"
  },
  follow: false,
  // Intended host API: hide generic navigation footer; prompts/confirmations still appear.
  hostKeys: "none",
  ui: screen,
  onEvent(event, data, view: UiControl) {
    if (event.type === "select" && event.id === "members") viewSelection.set(data, event.key)
    if (event.type === "toggle" && event.id.startsWith("details:")) {
      const expanded = expansions.get(data) ?? {}
      const keys = new Set(expanded[event.id])
      if (event.expanded) keys.add(event.key)
      else keys.delete(event.key)
      expansions.set(data, { ...expanded, [event.id]: [...keys] })
    }
    if (event.type === "activate") {
      if (event.id === "members") {
        viewSelection.set(data, event.key)
        view.focus(`details:${event.key}`)
      } else if (event.id.startsWith("details:")) {
        const expanded = expansions.get(data) ?? {}
        const keys = new Set(expanded[event.id])
        if (keys.has(event.key)) keys.delete(event.key)
        else keys.add(event.key)
        const next = { ...expanded, [event.id]: [...keys] }
        expansions.set(data, next)
        view.setState({ expanded: next })
      }
    }
    if (event.type !== "key") return
    if (event.key === "?") view.pushPage({ title: "Swarm summary", data: "summary" })
    else if (event.key === "[") view.focus("members")
    else if (event.key === "]") {
      const selected =
        data.snapshot()?.members.find((m) => m.name === viewSelection.get(data)) ??
        data.snapshot()?.members[0]
      if (selected) view.focus(`details:${selected.name}`)
    } else swarmView.keys?.find((k) => k.key === event.key)?.run?.(data, view)
  },
}

export const swarmView: ViewDefinition<SwarmViewData> = {
  ...base,
  keys: [
    ...navigation,
    {
      key: "m",
      label: "",
      run(data, view) {
        void act(data, view, "Message a member (name: text; all: every member)", (c, answer) => {
          const m = /^@?([A-Za-z][\w-]*)\s*[:,]?\s+([\s\S]+)$/.exec(answer)
          if (!m) return 'Write it as "name: text".'
          if (m[1]!.toLowerCase() === "all" && c.tellAll) {
            const sent = c.tellAll(m[2]!)
            return typeof sent === "string" ? sent : `Sent to all (${sent} member${sent === 1 ? "" : "s"}).`
          }
          return c.tell(m[1]!, m[2]!) ?? `Sent to ${m[1]}.`
        })
      },
    },
    {
      key: "p",
      label: "",
      run(data, view) {
        void act(data, view, "Pause or resume which member? (all: the whole swarm)", (c, answer) => {
          const name = answer.toLowerCase() === "all" ? undefined : answer
          const s = data.snapshot()
          const paused = name
            ? s?.members.find((m) => m.name.toLowerCase() === name.toLowerCase())?.status === "paused"
            : s?.state === "paused"
          const problem = paused ? c.resume(name) : c.pause(name)
          return problem ?? `${paused ? "Resumed" : "Paused"} ${name ?? "the swarm"}.`
        })
      },
    },
    {
      key: "x",
      label: "",
      run(data, view) {
        void act(
          data,
          view,
          "Stop which member?",
          (c, answer) => c.stopMember(answer) ?? `Stopping ${answer}.`,
        )
      },
    },
    {
      key: "s",
      label: "",
      run(data, view) {
        const c = data.control
        const s = data.snapshot()
        if (!c || !s || s.state === "ended" || s.state === "ending") {
          data.flash = "The swarm is not running."
          view.requestRender()
          return
        }
        // Stopping ends every member: the user says so first, as for a sub-agent or a workflow.
        void confirmStop(view, "Stop the whole swarm?").then((yes) => {
          if (yes) c.stop()
          data.flash = yes ? "Stopping the swarm." : "Not stopped."
          view.requestRender()
        })
      },
    },
  ],
}

/** Keys are fixed per registered kind: historical swarms must not advertise actions. */
export const readonlySwarmView: ViewDefinition<SwarmViewData> = {
  ...base,
  kind: READONLY_VIEW_KIND,
  ui: (data, ctx) => screen(data, ctx, true),
  keys: navigation,
  onEvent(event, data, view) {
    if (event.type === "key" && !navigation.some((k) => k.key === event.key)) return
    base.onEvent?.(event, data, view)
  },
}

/**
 * Asks the user to confirm stopping, at the bottom of the view: "Stop …? y stops it · any other
 * key keeps it running" (ViewControl.confirm, API 0.1.4). A frontend without it asks for "yes"
 * to be typed instead.
 */
export async function confirmStop(view: ViewControl, question: string): Promise<boolean> {
  if (typeof view.confirm === "function")
    return view.confirm(question, { yes: "stops it", no: "keeps it running" })
  const answer = await view.prompt(`${question} Type "yes" to stop it:`)
  return answer?.toLowerCase() === "yes"
}

async function act(
  data: SwarmViewData,
  view: ViewControl,
  title: string,
  run: (c: NonNullable<SwarmViewData["control"]>, answer: string) => string,
) {
  const c = data.control
  const s = data.snapshot()
  if (!c || !s || s.state === "ended" || s.state === "ending") {
    data.flash = "The swarm is not running."
    view.requestRender()
    return
  }
  const answer = await view.prompt(title)
  if (answer === undefined) return
  data.flash = run(c, answer)
  view.requestRender()
}
