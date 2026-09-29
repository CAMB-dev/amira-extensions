/**
 * The narrow-terminal fallback: a list of nodes, each followed by its outgoing edges.
 *
 *   [Start]
 *     └──▶ Is it ok?
 *   {Is it ok?}
 *     ├── yes ─▶ Done
 *     └── no ──▶ Start
 */
import { strWidth, truncate, wrapHanging } from "../util.ts"
import type { FEdge, Flowchart, Head, Shape } from "./parse.ts"

const WRAP: Record<Shape, [string, string]> = {
  rect: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  subroutine: ["[[", "]]"],
  database: ["[(", ")]"],
  circle: ["((", "))"],
  dcircle: ["(((", ")))"],
  asym: [">", "]"],
  rhombus: ["{", "}"],
  hexagon: ["{{", "}}"],
  para: ["[/", "/]"],
  paraAlt: ["[\\", "\\]"],
  trap: ["[/", "\\]"],
  trapAlt: ["[\\", "/]"],
}

const LINE = { solid: "─", dotted: "┄", thick: "━", invisible: " " } as const

function headChar(h: Head, towardTarget: boolean): string {
  if (h === "arrow") return towardTarget ? "▶" : "◀"
  if (h === "circle") return "○"
  if (h === "cross") return "×"
  return ""
}

function flat(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}

/** Nodes in a reading order: topological over the graph with back edges ignored. */
function readingOrder(fc: Flowchart): string[] {
  const ids = fc.nodes.map((n) => n.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const out = ids.map(() => [] as number[])
  for (const e of fc.edges) {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a !== undefined && b !== undefined && a !== b) out[a]!.push(b)
  }
  // Drop back edges found by DFS, then run Kahn's algorithm with declaration order as tie-break.
  const state = ids.map(() => 0)
  const keep = out.map(() => [] as number[])
  const visit = (v: number) => {
    state[v] = 1
    for (const w of out[v]!) {
      if (state[w] === 1) continue
      keep[v]!.push(w)
      if (state[w] === 0) visit(w)
    }
    state[v] = 2
  }
  ids.forEach((_, i) => state[i] === 0 && visit(i))
  const indeg = ids.map(() => 0)
  keep.forEach((ws) => ws.forEach((w) => indeg[w]!++))
  const ready = ids.map((_, i) => i).filter((i) => indeg[i] === 0)
  const order: number[] = []
  while (ready.length) {
    ready.sort((p, q) => p - q)
    const v = ready.shift()!
    order.push(v)
    for (const w of keep[v]!) if (--indeg[w]! === 0) ready.push(w)
  }
  ids.forEach((_, i) => !order.includes(i) && order.push(i))
  return order.map((i) => ids[i]!)
}

export function compactFlowchart(fc: Flowchart, width: number): string[] {
  const nodes = new Map(fc.nodes.map((n) => [n.id, n]))
  const order = readingOrder(fc)
  const rank = new Map(order.map((id, i) => [id, i]))
  const lines: string[] = []
  const push = (s: string) => lines.push(truncate(s, width))

  const emitNode = (id: string, prefix: string) => {
    const n = nodes.get(id)!
    const [l, r] = WRAP[n.shape]
    const head = l + flat(n.label || n.id) + r
    const pw = strWidth(prefix)
    wrapHanging(head, width - pw, width - pw - 1).forEach((t, i) => push(prefix + (i ? " " : "") + t))
    const outs = fc.edges.filter((e) => e.from === id && e.style !== "invisible")
    outs.forEach((e, i) => emitEdge(e, prefix, i === outs.length - 1))
  }
  const emitEdge = (e: FEdge, prefix: string, last: boolean) => {
    const line = LINE[e.style]
    const from = headChar(e.headFrom, false)
    const to = headChar(e.headTo, true)
    const label = flat(e.label)
    const body = (from || line) + line + (label ? ` ${label} ${line}` : "") + (to || line)
    const target = nodes.get(e.to)
    const text = `${body} ${flat(target ? target.label || target.id : e.to)}`
    const lead = `${prefix}  ${last ? "└" : "├"}`
    const cont = `${prefix}  ${last ? " " : "│"}   `
    const parts = wrapHanging(text, width - strWidth(lead), width - strWidth(cont))
    parts.forEach((t, i) => push((i ? cont : lead) + t))
  }

  // Keep each subgraph's members together, in reading order.
  const membersOf = (c: number) => order.filter((id) => (fc.membership.get(id) ?? -1) === c)
  const childClusters = (c: number) => fc.clusters.map((k, i) => ({ k, i })).filter(({ k }) => k.parent === c)
  const firstRank = (c: number): number => {
    const own = membersOf(c).map((id) => rank.get(id)!)
    const kids = childClusters(c).map(({ i }) => firstRank(i))
    return Math.min(Infinity, ...own, ...kids)
  }
  const emitCluster = (c: number, prefix: string) => {
    const units: Array<{ key: number; node?: string; cluster?: number }> = [
      ...membersOf(c).map((id) => ({ key: rank.get(id)!, node: id })),
      ...childClusters(c)
        .map(({ i }) => ({ key: firstRank(i), cluster: i }))
        .filter((u) => Number.isFinite(u.key)),
    ]
    units.sort((p, q) => p.key - q.key)
    for (const u of units) {
      if (u.node !== undefined) emitNode(u.node, prefix)
      else {
        const k = fc.clusters[u.cluster!]!
        const title = flat(k.title || k.id)
        const pw = strWidth(prefix)
        wrapHanging(title, width - pw - 3, width - pw - 3).forEach((t, i) => push(prefix + (i ? "│  " : "╭─ ") + t))
        emitCluster(u.cluster!, prefix + "│ ")
        push(prefix + "╰─")
      }
    }
  }
  emitCluster(-1, "")
  return lines
}
