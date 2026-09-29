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

const minOf = (xs: readonly number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity)

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
  // Drop back edges found by an (iterative) DFS, then run Kahn's algorithm with declaration
  // order as tie-break (a binary heap keeps it n log n).
  const state = ids.map(() => 0)
  const keep = out.map(() => [] as number[])
  for (let s0 = 0; s0 < ids.length; s0++) {
    if (state[s0]) continue
    state[s0] = 1
    const stack: Array<[number, number]> = [[s0, 0]]
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const [v, k] = top
      if (k >= out[v]!.length) {
        state[v] = 2
        stack.pop()
        continue
      }
      top[1]++
      const w = out[v]![k]!
      if (state[w] === 1) continue
      keep[v]!.push(w)
      if (state[w] === 0) {
        state[w] = 1
        stack.push([w, 0])
      }
    }
  }
  const indeg = ids.map(() => 0)
  keep.forEach((ws) => ws.forEach((w) => indeg[w]!++))
  const heap: number[] = []
  const push = (v: number) => {
    heap.push(v)
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1
      if (heap[p]! <= heap[i]!) break
      ;[heap[p], heap[i]] = [heap[i]!, heap[p]!]
      i = p
    }
  }
  const pop = (): number => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ; ) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l]! < heap[m]!) m = l
        if (r < heap.length && heap[r]! < heap[m]!) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
        i = m
      }
    }
    return top
  }
  ids.forEach((_, i) => indeg[i] === 0 && push(i))
  const order: number[] = []
  const placed = new Set<number>()
  while (heap.length) {
    const v = pop()
    order.push(v)
    placed.add(v)
    for (const w of keep[v]!) if (--indeg[w]! === 0) push(w)
  }
  ids.forEach((_, i) => !placed.has(i) && order.push(i))
  return order.map((i) => ids[i]!)
}

export function compactFlowchart(fc: Flowchart, width: number): string[] {
  const nodes = new Map(fc.nodes.map((n) => [n.id, n]))
  const order = readingOrder(fc)
  const rank = new Map(order.map((id, i) => [id, i]))
  const lines: string[] = []
  const push = (s: string) => lines.push(truncate(s, width))
  const outEdges = new Map<string, FEdge[]>()
  for (const e of fc.edges) {
    if (e.style === "invisible") continue
    const list = outEdges.get(e.from)
    if (list) list.push(e)
    else outEdges.set(e.from, [e])
  }

  const emitNode = (id: string, prefix: string) => {
    const n = nodes.get(id)!
    const [l, r] = WRAP[n.shape]
    const head = l + flat(n.label || n.id) + r
    const pw = strWidth(prefix)
    wrapHanging(head, width - pw, width - pw - 1).forEach((t, i) => push(prefix + (i ? " " : "") + t))
    const outs = outEdges.get(id) ?? []
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
  const direct = new Map<number, string[]>()
  for (const id of order) {
    const c = fc.membership.get(id) ?? -1
    const list = direct.get(c)
    if (list) list.push(id)
    else direct.set(c, [id])
  }
  const kids = new Map<number, number[]>()
  fc.clusters.forEach((k, i) => {
    const list = kids.get(k.parent)
    if (list) list.push(i)
    else kids.set(k.parent, [i])
  })
  const membersOf = (c: number) => direct.get(c) ?? []
  const childClusters = (c: number) => (kids.get(c) ?? []).map((i) => ({ i }))
  // The earliest reading position inside each cluster, children first (clusters are numbered
  // in source order, so a parent always comes before its children).
  const first = fc.clusters.map((_, c) => minOf(membersOf(c).map((id) => rank.get(id)!)))
  for (let c = fc.clusters.length - 1; c >= 0; c--) {
    const p = fc.clusters[c]!.parent
    if (p >= 0) first[p] = Math.min(first[p]!, first[c]!)
  }
  const firstRank = (c: number): number => first[c]!
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
        // Deep nesting stops indenting at half the width, so text always has room.
        emitCluster(u.cluster!, strWidth(prefix) + 2 <= width / 2 ? prefix + "│ " : prefix)
        push(prefix + "╰─")
      }
    }
  }
  emitCluster(-1, "")
  return lines
}
