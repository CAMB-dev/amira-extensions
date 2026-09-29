import type { ViewLine } from "@amira/api"

/** Where one agent() call of a run is. `cached` replayed from the journal. */
export type AgentStatus = "queued" | "working" | "done" | "error" | "aborted" | "cached"

export interface AgentNode {
  kind: "agent"
  /** The call's number within the run. */
  call: number
  label: string
  status: AgentStatus
  tokens: number
  cost?: number
  startedAt?: number
  durationMs?: number
  childId?: string
  /** Why it failed, or what happened to its worktree. */
  note?: string
}

export interface PhaseNode {
  title: string
  items: (AgentNode | FlowNode)[]
}

/** A workflow's progress: the run's own, or a nested workflow() under one of its phases. */
export interface FlowNode {
  kind: "workflow"
  name: string
  /** Phases in order: the ones meta names first, then others as the script uses them. */
  phases: PhaseNode[]
  /** The phase the script is in (phase(title)); agents without a phase of their own go there. */
  current?: string
  state: "running" | "done" | "error"
}

export function newFlow(name: string, phases: string[]): FlowNode {
  return { kind: "workflow", name, phases: phases.map((title) => ({ title, items: [] })), state: "running" }
}

export function phaseOf(flow: FlowNode, title: string | undefined): PhaseNode {
  const t = title ?? ""
  let p = flow.phases.find((x) => x.title === t)
  if (!p) {
    p = { title: t, items: [] }
    // Agents before any phase() go first.
    if (t === "") flow.phases.unshift(p)
    else flow.phases.push(p)
  }
  return p
}

/** Every agent of a flow, nested flows' included. */
export function agentsOf(flow: FlowNode): AgentNode[] {
  return flow.phases.flatMap((p) => p.items.flatMap((i) => (i.kind === "agent" ? [i] : agentsOf(i))))
}

export interface Totals {
  agents: number
  finished: number
  working: number
  queued: number
  failed: number
  cached: number
  tokens: number
  cost?: number
}

export function totals(flow: FlowNode): Totals {
  const t: Totals = { agents: 0, finished: 0, working: 0, queued: 0, failed: 0, cached: 0, tokens: 0 }
  for (const a of agentsOf(flow)) {
    t.agents++
    t.tokens += a.tokens
    if (a.cost !== undefined) t.cost = (t.cost ?? 0) + a.cost
    if (a.status === "working") t.working++
    else if (a.status === "queued") t.queued++
    else {
      t.finished++
      if (a.status === "error" || a.status === "aborted") t.failed++
      if (a.status === "cached") t.cached++
    }
  }
  return t
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "12s", "1m 05s", "1h 02m": as Amira's own screens write times. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60
    ? `${m}m ${String(s % 60).padStart(2, "0")}s`
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

function cost(c: number | undefined): string {
  return c === undefined || c === 0 ? "" : ` · $${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`
}

const MARK: Record<AgentStatus, string> = {
  queued: "◌",
  working: "●",
  done: "✓",
  error: "✗",
  aborted: "⊘",
  cached: "↺",
}

const KIND: Record<AgentStatus, ViewLine["kind"]> = {
  queued: "muted",
  working: "accent",
  done: "success",
  error: "error",
  aborted: "warning",
  cached: "muted",
}

/** One line about a run: "3/7 agents · 2 working · 12.3k tok · $0.01". */
export function countsLine(flow: FlowNode): string {
  const t = totals(flow)
  const parts = [`${t.finished}/${t.agents} agent${t.agents === 1 ? "" : "s"}`]
  if (t.working) parts.push(`${t.working} working`)
  if (t.queued) parts.push(`${t.queued} queued`)
  if (t.failed) parts.push(`${t.failed} failed`)
  if (t.cached) parts.push(`${t.cached} from the journal`)
  return `${parts.join(" · ")} · ${formatTokens(t.tokens)} tok${cost(t.cost)}`
}

/**
 * How a phase stands: not reached yet, going on, or over, and then whether all its agents did
 * their work: one that failed makes it failed, one stopped (and none failed) stopped.
 */
function phaseState(flow: FlowNode, p: PhaseNode): "pending" | "current" | "done" | "failed" | "stopped" {
  if (flow.current === p.title && flow.state === "running") return "current"
  const agents = p.items.flatMap((i) => (i.kind === "agent" ? [i] : agentsOf(i)))
  if (agents.some((a) => a.status === "working" || a.status === "queued")) return "current"
  if (!agents.length && !p.items.length) {
    const i = flow.phases.indexOf(p)
    const later = flow.phases.slice(i + 1).some((q) => q.items.length || q.title === flow.current)
    if (later || flow.state === "done") return "done"
    // A run that failed never got past the phase it failed in, nor to the ones after it.
    if (flow.state === "error") return flow.current === p.title ? "failed" : "pending"
    return "pending"
  }
  if (agents.some((a) => a.status === "error")) return "failed"
  if (agents.some((a) => a.status === "aborted")) return "stopped"
  return "done"
}

/** A phase's mark and line kind, in the marks every screen uses: ● ✓ ✗ ⊘, and ◌ not reached yet. */
const PHASE: Record<ReturnType<typeof phaseState>, { mark: string; kind: ViewLine["kind"] }> = {
  current: { mark: "●", kind: "accent" },
  done: { mark: "✓", kind: "text" },
  failed: { mark: "✗", kind: "error" },
  stopped: { mark: "⊘", kind: "warning" },
  pending: { mark: "◌", kind: "muted" },
}

/** The progress tree: phases, and under them agents (and nested workflows) with status, tokens and cost. */
export function treeLines(flow: FlowNode, now: number, prefix = ""): ViewLine[] {
  const out: ViewLine[] = []
  const phases = flow.phases.filter((p) => p.title !== "" || p.items.length)
  for (const [pi, p] of phases.entries()) {
    const lastPhase = pi === phases.length - 1
    const { mark, kind } = PHASE[phaseState(flow, p)]
    const branch = lastPhase ? "└ " : "├ "
    const inner = prefix + (lastPhase ? "  " : "│ ")
    if (p.title) out.push({ kind, text: `${prefix}${branch}${mark} ${p.title}` })
    const base = p.title ? inner : prefix
    for (const [ii, item] of p.items.entries()) {
      const last = ii === p.items.length - 1
      const b = last ? "└ " : "├ "
      if (item.kind === "agent")
        out.push({ kind: KIND[item.status], text: `${base}${b}${agentText(item, now)}` })
      else {
        const t = totals(item)
        const mark = item.state === "running" ? "●" : item.state === "done" ? "✓" : "✗"
        out.push({
          kind: item.state === "error" ? "error" : "accent",
          text: `${base}${b}${mark} workflow ${item.name} · ${t.finished}/${t.agents} agents · ${formatTokens(t.tokens)} tok${cost(t.cost)}`,
        })
        out.push(...treeLines(item, now, base + (last ? "  " : "│ ")))
      }
    }
  }
  return out
}

function agentText(a: AgentNode, now: number): string {
  const parts = [`${MARK[a.status]} ${a.label}`]
  if (a.status === "queued") parts.push("queued")
  else if (a.status === "cached") parts.push("from the journal")
  else {
    if (a.tokens) parts.push(`${formatTokens(a.tokens)} tok${cost(a.cost)}`)
    const ms = a.durationMs ?? (a.startedAt !== undefined ? now - a.startedAt : undefined)
    if (ms !== undefined) parts.push(formatDuration(ms))
  }
  if (a.note) parts.push(a.note)
  return parts.join(" · ")
}
