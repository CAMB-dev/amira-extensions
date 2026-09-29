/**
 * Layered flowchart layout on a character grid.
 *
 * Coordinates are computed along a "main" axis (the flow direction: down for TD, right for LR)
 * and a "cross" axis, then mapped to x/y for the chosen direction. Steps: break cycles by
 * reversing back edges, assign layers (longest path; a labelled edge spans at least two layers
 * so its label gets a layer slot of its own), insert dummy items for long edges, label items for
 * edge labels and spacer items for subgraph frames, order layers by barycenter sweeps (keeping
 * subgraph members together), place items along the cross axis under difference constraints,
 * route every edge orthogonally through per-gap channel rows, and draw.
 *
 * Edge labels are items like nodes: they take part in ordering and spacing, so a label never
 * overlaps another label, a box or a line, and it always sits on its own edge.
 */
import { Canvas, DOWN, LEFT, RIGHT, UP, type Style } from "../canvas.ts"
import { maxWidth, strWidth, truncate, wrapText } from "../util.ts"
import type { Dir, Flowchart, Head } from "./parse.ts"
import { makeBox, portSlots, type Box, type Range } from "./shapes.ts"

export interface LayoutOptions {
  dir: Dir
  /** Maximum label width (columns) inside node boxes. */
  nodeWrap: number
  /** Maximum edge label width (columns). */
  edgeWrap: number
}

/** Layouts with more items than this are not attempted (the compact list is used instead). */
export const ITEM_BUDGET = 3000

interface Item {
  idx: number
  /** `bound`: a virtual left/right frame border used only by the placement constraints. */
  kind: "node" | "dummy" | "label" | "spacer" | "bound"
  node: number
  layer: number
  cluster: number
  box: Box | undefined
  text: string[]
  cs: number
  ms: number
  x: number
  L: number
  R: number
  up: Seg[]
  down: Seg[]
  pos: number
  near: Port[]
  far: Port[]
  m0: number
}

interface Seg {
  u: Item
  v: Item
  style: Style
  first: boolean
  last: boolean
  headU: Head
  headD: Head
  uPort: Port | undefined
  vPort: Port | undefined
  row: number
  /** Index of the edge this segment belongs to. */
  edge: number
}

interface Port {
  item: Item
  far: boolean
  key: string
  segs: Seg[]
  off: number
}

interface Group {
  segs: Seg[]
  lo: number
  hi: number
  src: number[]
  tgt: number[]
  needsRow: boolean
  row: number
}

const ARROWS: Record<Dir, [string, string]> = {
  TD: ["▼", "▲"],
  BT: ["▲", "▼"],
  LR: ["▶", "◀"],
  RL: ["◀", "▶"],
}

const minOf = (xs: readonly number[], init = Infinity) => xs.reduce((a, b) => (b < a ? b : a), init)
const maxOf = (xs: readonly number[], init = -Infinity) => xs.reduce((a, b) => (b > a ? b : a), init)

/**
 * Lays the flowchart out and returns its lines, or undefined when the drawing would be wider
 * than `width` (or too big to lay out). The width is known before anything is drawn.
 */
export function layoutFlowchart(fc: Flowchart, o: LayoutOptions, width = Infinity): string[] | undefined {
  const dir = o.dir
  const vertical = dir === "TD" || dir === "BT"
  const nodeIndex = new Map(fc.nodes.map((n, i) => [n.id, i]))
  const clusters = fc.clusters
  const N = fc.nodes.length

  // ---- edges, self loops, labels -------------------------------------------------------
  const selfLoops: string[][] = fc.nodes.map(() => [])
  interface DEdge {
    a: number
    b: number
    style: Style
    headFrom: Head
    headTo: Head
    label: string[]
    layoutIdx: number
  }
  const drawn: DEdge[] = []
  const ledges: Array<{ a: number; b: number; len: number }> = []
  for (const e of fc.edges) {
    const a = nodeIndex.get(e.from)
    const b = nodeIndex.get(e.to)
    if (a === undefined || b === undefined) continue
    if (a === b) {
      if (e.style !== "invisible") selfLoops[a]!.push(e.label)
      continue
    }
    const label = e.style !== "invisible" && e.label.trim() ? wrapText(e.label, o.edgeWrap).filter((l) => l) : []
    ledges.push({ a, b, len: label.length ? 2 : 1 })
    if (e.style === "invisible") continue
    drawn.push({ a, b, style: e.style, headFrom: e.headFrom, headTo: e.headTo, label, layoutIdx: ledges.length - 1 })
  }
  const nodeLines = fc.nodes.map((n, i) => {
    const lines = wrapText(n.label || n.id, o.nodeWrap)
    for (const l of selfLoops[i]!) lines.push(...wrapText(l ? `↻ ${l}` : "↻", o.nodeWrap))
    return lines
  })

  // ---- cycle breaking (DFS back edges get reversed) ------------------------------------
  const out: number[][] = fc.nodes.map(() => [])
  ledges.forEach(({ a }, i) => out[a]!.push(i))
  const reversed = ledges.map(() => false)
  const state = new Array<number>(N).fill(0)
  for (let s = 0; s < N; s++) {
    if (state[s]) continue
    const stack: Array<[number, number]> = [[s, 0]]
    state[s] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const [v, k] = top
      if (k >= out[v]!.length) {
        state[v] = 2
        stack.pop()
        continue
      }
      top[1]++
      const ei = out[v]![k]!
      const w = ledges[ei]!.b
      if (state[w] === 1) reversed[ei] = true
      else if (state[w] === 0) {
        state[w] = 1
        stack.push([w, 0])
      }
    }
  }

  // ---- layering (longest path, sources pulled down next to their children) --------------
  const indeg = new Array<number>(N).fill(0)
  const succ: Array<Array<[number, number]>> = fc.nodes.map(() => [])
  const predCount = new Array<number>(N).fill(0)
  ledges.forEach(({ a, b, len }, i) => {
    const [u, v] = reversed[i] ? [b, a] : [a, b]
    succ[u]!.push([v, len])
    predCount[v]!++
    indeg[v]!++
  })
  const topo: number[] = []
  let ready: number[] = []
  for (let i = 0; i < N; i++) if (indeg[i] === 0) ready.push(i)
  while (ready.length) {
    const next: number[] = []
    for (const v of ready) {
      topo.push(v)
      for (const [w] of succ[v]!) if (--indeg[w]! === 0) next.push(w)
    }
    ready = next.sort((p, q) => p - q)
  }
  if (topo.length < N) {
    const seen = new Set(topo)
    for (let i = 0; i < N; i++) if (!seen.has(i)) topo.push(i)
  }
  const layerOf = new Array<number>(N).fill(0)
  for (const v of topo) for (const [w, len] of succ[v]!) if (layerOf[v]! + len > layerOf[w]!) layerOf[w] = layerOf[v]! + len
  for (let t = topo.length - 1; t >= 0; t--) {
    const v = topo[t]!
    if (predCount[v] === 0 && succ[v]!.length > 0) layerOf[v] = minOf(succ[v]!.map(([w, len]) => layerOf[w]! - len))
  }
  const lmin = minOf(layerOf, 0)
  for (let i = 0; i < N; i++) layerOf[i]! -= lmin

  // Long edges need one dummy per layer they cross: too many means no drawing will fit.
  let dummyCount = 0
  for (const e of drawn) dummyCount += Math.abs(layerOf[e.b]! - layerOf[e.a]!) - 1
  if (N + dummyCount > ITEM_BUDGET) return undefined

  // ---- clusters -------------------------------------------------------------------------
  const nodeCluster = fc.nodes.map((n) => fc.membership.get(n.id) ?? -1)
  const depth: number[] = []
  const anc: Array<Set<number>> = []
  const chainOf: number[][] = []
  const chain = (c: number): number[] => {
    if (c < 0) return []
    let r = chainOf[c]
    if (!r) {
      r = [c, ...chain(clusters[c]!.parent)]
      chainOf[c] = r
    }
    return r
  }
  for (let c = 0; c < clusters.length; c++) {
    anc[c] = new Set(chain(c))
    depth[c] = chain(c).length - 1
  }
  const within = (c: number, a: number): boolean => a === -1 || (c >= 0 && anc[c]!.has(a))
  const lca = (c1: number, c2: number): number => {
    if (c1 < 0) return -1
    for (const k of chain(c2)) if (anc[c1]!.has(k)) return k
    return -1
  }

  // ---- items and segments ------------------------------------------------------------------
  const items: Item[] = []
  const mk = (kind: Item["kind"], node: number, layer: number, cluster: number): Item => {
    const it: Item = {
      idx: items.length,
      kind,
      node,
      layer,
      cluster,
      box: undefined,
      text: [],
      cs: 1,
      ms: 0,
      x: 0,
      L: 0,
      R: 0,
      up: [],
      down: [],
      pos: 0,
      near: [],
      far: [],
      m0: 0,
    }
    items.push(it)
    return it
  }
  const nodeItems = fc.nodes.map((_, i) => mk("node", i, layerOf[i]!, nodeCluster[i]!))
  drawn.forEach((e, ei) => {
    const rev = reversed[e.layoutIdx]!
    const U = rev ? e.b : e.a
    const D = rev ? e.a : e.b
    const headU = rev ? e.headTo : e.headFrom
    const headD = rev ? e.headFrom : e.headTo
    const cl = lca(nodeCluster[U]!, nodeCluster[D]!)
    let prev = nodeItems[U]!
    const lu = layerOf[U]!
    const ld = layerOf[D]!
    const labelAt = e.label.length ? lu + Math.floor((ld - lu) / 2) : -1
    for (let l = lu + 1; l <= ld; l++) {
      let next: Item
      if (l === ld) next = nodeItems[D]!
      else if (l === labelAt) {
        next = mk("label", -1, l, cl)
        next.text = e.label
        const bw = maxWidth(e.label)
        next.cs = vertical ? bw : e.label.length
        next.ms = vertical ? e.label.length : bw + 2
      } else next = mk("dummy", -1, l, cl)
      const seg: Seg = {
        u: prev,
        v: next,
        style: e.style as Style,
        first: l === lu + 1,
        last: l === ld,
        headU: l === lu + 1 ? headU : "none",
        headD: l === ld ? headD : "none",
        uPort: undefined,
        vPort: undefined,
        row: 0,
        edge: ei,
      }
      prev.down.push(seg)
      next.up.push(seg)
      prev = next
    }
  })

  // Frames: which clusters are drawn, their layer spans, spacers where a span has a hole.
  const drawnCluster = clusters.map(() => false)
  const span: Array<[number, number]> = clusters.map(() => [Infinity, -Infinity])
  const layersOf: Array<Set<number>> = clusters.map(() => new Set())
  for (const it of items) for (const c of chain(it.cluster)) layersOf[c]!.add(it.layer)
  const byDepth = clusters.map((_, i) => i).sort((p, q) => depth[q]! - depth[p]! || p - q)
  for (const c of byDepth) {
    const ls = layersOf[c]!
    if (ls.size === 0) continue
    drawnCluster[c] = true
    const lo = minOf([...ls])
    const hi = maxOf([...ls])
    span[c] = [lo, hi]
    for (let l = lo; l <= hi; l++)
      if (!ls.has(l)) {
        mk("spacer", -1, l, c)
        for (const k of chain(c)) layersOf[k]!.add(l)
      }
  }
  // Drawn frames around each cluster (itself included).
  const dd = clusters.map((_, c) => chain(c).filter((k) => drawnCluster[k]).length)
  const ddOf = (c: number) => (c < 0 ? 0 : dd[c]!)

  // ---- ports and boxes ------------------------------------------------------------------------
  const portKey = (head: Head, style: Style) => `${head}|${style}`
  for (const it of items) {
    if (it.kind === "spacer") continue
    const passThrough = it.kind !== "node"
    const nearGroups = new Map<string, Port>()
    const farGroups = new Map<string, Port>()
    for (const s of it.up) {
      const key = passThrough ? "d" : portKey(s.headD, s.style)
      let p = nearGroups.get(key)
      if (!p) nearGroups.set(key, (p = { item: it, far: false, key, segs: [], off: 0 }))
      p.segs.push(s)
      s.vPort = p
    }
    for (const s of it.down) {
      const key = passThrough ? "d" : portKey(s.headU, s.style)
      let p = farGroups.get(key)
      if (!p) farGroups.set(key, (p = { item: it, far: true, key, segs: [], off: 0 }))
      p.segs.push(s)
      s.uPort = p
    }
    it.near = [...nearGroups.values()]
    it.far = [...farGroups.values()]
  }
  const sideOf = (far: boolean): "top" | "bottom" | "left" | "right" => {
    const nearSide = { TD: "top", BT: "bottom", LR: "left", RL: "right" } as const
    const farSide = { TD: "bottom", BT: "top", LR: "right", RL: "left" } as const
    return far ? farSide[dir] : nearSide[dir]
  }
  for (const it of nodeItems) {
    const needs = { top: 0, bottom: 0, left: 0, right: 0 }
    needs[sideOf(false)] = it.near.length
    needs[sideOf(true)] = it.far.length
    const box = makeBox(fc.nodes[it.node]!.shape, nodeLines[it.node]!, needs, vertical)
    it.box = box
    it.cs = vertical ? box.w : box.h
    it.ms = vertical ? box.h : box.w
  }
  const rangeOf = (it: Item, far: boolean): Range => (it.box ? it.box[sideOf(far)] : [0, 0])
  const co = (it: Item) => Math.floor((it.cs - 1) / 2)

  // ---- drop empty layers, check the size can fit before doing the expensive work --------------
  {
    const used = [...new Set(items.map((it) => it.layer))].sort((p, q) => p - q)
    const remap = new Map(used.map((l, i) => [l, i]))
    for (const it of items) it.layer = remap.get(it.layer)!
    for (let c = 0; c < clusters.length; c++)
      if (drawnCluster[c]) span[c] = [remap.get(span[c]![0])!, remap.get(span[c]![1])!]
  }
  const layerCount = maxOf(items.map((it) => it.layer), -1) + 1
  const gapBase = vertical ? 2 : 1
  const margin = 2
  const minCh = vertical ? 1 : 3
  const layers: Item[][] = Array.from({ length: layerCount }, () => [])
  for (const it of items) layers[it.layer]!.push(it)
  const lsz = layers.map((ly) => maxOf(ly.map((it) => it.ms), 1))
  if (vertical) {
    const frameRoom = 2 * margin * maxOf(dd, 0)
    for (const ly of layers) {
      let w = frameRoom - gapBase
      for (const it of ly) w += it.cs + gapBase
      if (w > width) return undefined
    }
  } else {
    let w = 0
    for (let l = 0; l < layerCount; l++) w += lsz[l]! + (l ? minCh + 1 : 0)
    if (w > width) return undefined
  }

  // ---- ordering ---------------------------------------------------------------------------------
  const setPos = () => layers.forEach((ly) => ly.forEach((it, i) => (it.pos = i)))
  setPos()
  const norm = (it: Item) => (it.pos + 0.5) / layers[it.layer]!.length
  const clusterRank = (): number[] => {
    const sum = clusters.map(() => 0)
    const cnt = clusters.map(() => 0)
    for (const it of items)
      for (const c of chain(it.cluster)) {
        sum[c]! += norm(it)
        cnt[c]!++
      }
    return sum.map((s, i) => (cnt[i] ? s / cnt[i]! : 0))
  }
  const arrange = (parent: number, list: Item[], key: Map<Item, number>, rank: number[]): Item[] => {
    interface Unit {
      key: number
      first: number
      cluster: number
      items: Item[]
    }
    const units: Unit[] = []
    const byCluster = new Map<number, Unit>()
    const pd = parent < 0 ? -1 : depth[parent]!
    for (const it of list) {
      if (it.cluster === parent) {
        units.push({ key: key.get(it)!, first: it.pos, cluster: -2, items: [it] })
        continue
      }
      // The ancestor of the item's cluster one level below `parent`.
      const ch = chain(it.cluster)
      const c = ch[ch.length - 1 - (pd + 1)]!
      let u = byCluster.get(c)
      if (!u) {
        u = { key: 0, first: it.pos, cluster: c, items: [] }
        byCluster.set(c, u)
        units.push(u)
      }
      u.items.push(it)
      u.first = Math.min(u.first, it.pos)
    }
    const cl = units.filter((u) => u.cluster !== -2)
    for (const u of cl) u.key = u.items.reduce((s, it) => s + key.get(it)!, 0) / u.items.length
    // Sibling clusters keep one global order across layers, so frames never interleave.
    cl.sort((p, q) => rank[p.cluster]! - rank[q.cluster]! || p.cluster - q.cluster)
    const keys = cl.map((u) => u.key).sort((p, q) => p - q)
    cl.forEach((u, i) => (u.key = keys[i]!))
    units.sort((p, q) => p.key - q.key || p.first - q.first)
    return units.flatMap((u) => (u.cluster === -2 ? u.items : arrange(u.cluster, u.items, key, rank)))
  }
  // Crossings between adjacent layers, by counting inversions with a Fenwick tree.
  const crossings = (): number => {
    let n = 0
    for (let l = 0; l + 1 < layerCount; l++) {
      const segs = layers[l]!.flatMap((it) => it.down).map((s) => [s.u.pos, s.v.pos] as const)
      segs.sort((p, q) => p[0] - q[0] || p[1] - q[1])
      const size = layers[l + 1]!.length
      const tree = new Array<number>(size + 1).fill(0)
      let seen = 0
      for (const [, v] of segs) {
        let le = 0
        for (let i = v + 1; i > 0; i -= i & -i) le += tree[i]!
        n += seen - le
        for (let i = v + 1; i <= size; i += i & -i) tree[i]!++
        seen++
      }
    }
    return n
  }
  const sweepLayer = (l: number, down: boolean, rank: number[]) => {
    const ly = layers[l]!
    const key = new Map<Item, number>()
    // Where an edge meets its neighbour: the neighbour's position, nudged by which of the
    // neighbour's port groups it uses, so edges sharing a port end up side by side.
    const at = (s: Seg): number => {
      const n = down ? s.u : s.v
      const ports = down ? n.far : n.near
      const p = down ? s.uPort! : s.vPort!
      const k = ports.length
      const frac = k > 1 ? (ports.indexOf(p) + 0.5) / k - 0.5 : 0
      return norm(n) + (frac * 0.8) / layers[n.layer]!.length
    }
    for (const it of ly) {
      const segs = down ? it.up : it.down
      key.set(it, segs.length ? segs.reduce((s, sg) => s + at(sg), 0) / segs.length : norm(it))
    }
    layers[l] = arrange(-1, ly, key, rank)
    layers[l]!.forEach((it, i) => (it.pos = i))
  }
  {
    const rank = clusterRank()
    for (let l = 0; l < layerCount; l++) sweepLayer(l, true, rank)
  }
  let best = layers.map((ly) => [...ly])
  let bestC = crossings()
  for (let iter = 0; iter < 8 && bestC > 0; iter++) {
    const down = iter % 2 === 0
    const rank = clusterRank()
    if (down) for (let l = 1; l < layerCount; l++) sweepLayer(l, true, rank)
    else for (let l = layerCount - 2; l >= 0; l--) sweepLayer(l, false, rank)
    const c = crossings()
    if (c < bestC) {
      bestC = c
      best = layers.map((ly) => [...ly])
    }
  }
  best.forEach((ly, l) => (layers[l] = ly))
  setPos()

  // ---- ports: order each side's groups by where their other ends are ---------------------------
  for (const it of items) {
    for (const far of [false, true]) {
      const ports = far ? it.far : it.near
      if (!ports.length) continue
      const other = (p: Port) => p.segs.reduce((s, sg) => s + (far ? sg.v.pos : sg.u.pos), 0) / p.segs.length
      // Ties (several edges to the same neighbour) go by edge order, the same at both ends.
      const firstEdge = (p: Port) => minOf(p.segs.map((sg) => sg.edge))
      ports.sort((p, q) => other(p) - other(q) || firstEdge(p) - firstEdge(q))
      const slots = it.kind === "node" ? portSlots(rangeOf(it, far), ports.length, it.cs, vertical) : [co(it)]
      ports.forEach((p, i) => (p.off = slots[i] ?? slots[0]!))
    }
  }
  for (const it of items) {
    it.L = 0
    it.R = it.cs - 1
  }

  // ---- cross-axis placement ------------------------------------------------------------------
  const framesBetween = (a: Item, b: Item) => ddOf(a.cluster) + ddOf(b.cluster) - 2 * ddOf(lca(a.cluster, b.cluster))
  // A line may pass one column from a label or another line; two labels keep three columns
  // apart so they never read as one phrase.
  const gapOf = (a: Item, b: Item) => {
    if (!vertical) return gapBase
    if (a.kind === "label" && b.kind === "label") return 3
    return a.kind !== "node" && b.kind !== "node" ? 1 : gapBase
  }
  const sep = (a: Item, b: Item) => a.R + 1 + gapOf(a, b) + margin * framesBetween(a, b) - b.L
  const runOf = (l: number, c: number) => layers[l]!.filter((it) => it.cluster >= 0 && within(it.cluster, c))
  // Frames need room for their title on the top border: widen the first layer's members.
  if (vertical)
    for (let c = 0; c < clusters.length; c++) {
      if (!drawnCluster[c] || !clusters[c]!.title) continue
      const l = dir === "TD" ? span[c]![0] : span[c]![1]
      const run = runOf(l, c)
      if (!run.length) continue
      const tw = strWidth(clusters[c]!.title.replace(/\n/g, " ")) + 2
      const gapAfter = (i: number) => (i + 1 < run.length ? gapBase + margin * framesBetween(run[i]!, run[i + 1]!) : 0)
      // Edges entering through the top border split it; the title then goes right of them.
      let crossAt = -1
      let crossOff = 0
      run.forEach((it, i) => {
        const segs = dir === "TD" ? it.up : it.down
        for (const sg of segs) {
          const other = dir === "TD" ? sg.u : sg.v
          if (other.cluster >= 0 && within(other.cluster, c)) continue
          const off = dir === "TD" ? sg.vPort!.off : sg.uPort!.off
          if (i > crossAt || off > crossOff) {
            crossAt = i
            crossOff = off
          }
        }
      })
      let def: number
      if (crossAt >= 0) {
        let right = run[crossAt]!.R - crossOff + gapAfter(crossAt)
        for (let i = crossAt + 1; i < run.length; i++) right += run[i]!.R - run[i]!.L + 1 + gapAfter(i)
        def = tw + 2 - (right + margin - 1)
        if (def > 0) run[run.length - 1]!.R += def
      } else {
        let ext = 0
        run.forEach((it, i) => (ext += it.R - it.L + 1 + gapAfter(i)))
        def = tw - ext
        if (def > 0) {
          run[0]!.L -= Math.floor(def / 2)
          run[run.length - 1]!.R += Math.ceil(def / 2)
        }
      }
    }
  // Difference constraints x_b >= x_a + c. Frames get virtual left/right border items, so the
  // items beside a frame (in any of its layers) stay outside it.
  const cons: Array<[Item, Item, number]> = []
  for (const ly of layers) for (let i = 0; i + 1 < ly.length; i++) cons.push([ly[i]!, ly[i + 1]!, sep(ly[i]!, ly[i + 1]!)])
  for (let c = 0; c < clusters.length; c++) {
    if (!drawnCluster[c]) continue
    const [lo, hi] = span[c]!
    const lb = mk("bound", -1, -1, c)
    const rb = mk("bound", -1, -1, c)
    const inner = (it: Item) => margin * (ddOf(it.cluster) - dd[c]! + 1)
    const outer = (it: Item) => {
      const l = lca(it.cluster, c)
      return 1 + gapBase + margin * (ddOf(it.cluster) - ddOf(l)) + margin * (dd[c]! - ddOf(l) - 1)
    }
    for (let l = lo; l <= hi; l++) {
      const run = runOf(l, c)
      if (!run.length) continue
      const f = run[0]!
      const t = run[run.length - 1]!
      cons.push([lb, f, inner(f) - f.L])
      cons.push([t, rb, t.R + inner(t)])
      const p = layers[l]![f.pos - 1]
      const q = layers[l]![t.pos + 1]
      if (p) cons.push([p, lb, p.R + outer(p)])
      if (q) cons.push([rb, q, outer(q) - q.L])
    }
  }
  const inC = new Map<Item, Array<[Item, number]>>()
  const outC = new Map<Item, Array<[Item, number]>>()
  for (const [a, b, c] of cons) {
    if (!inC.has(b)) inC.set(b, [])
    if (!outC.has(a)) outC.set(a, [])
    inC.get(b)!.push([a, c])
    outC.get(a)!.push([b, c])
  }
  // Left-packed start: longest paths through the constraint graph (a DAG) in topological order.
  {
    const deg = new Map<Item, number>()
    for (const [, b] of cons) deg.set(b, (deg.get(b) ?? 0) + 1)
    let queue = items.filter((it) => !deg.get(it))
    const done = new Set<Item>()
    while (queue.length) {
      const next: Item[] = []
      for (const a of queue) {
        done.add(a)
        for (const [b, c] of outC.get(a) ?? []) {
          if (b.x < a.x + c) b.x = a.x + c
          const d = deg.get(b)! - 1
          deg.set(b, d)
          if (d === 0) next.push(b)
        }
      }
      queue = next
    }
    // A cycle would be a bug in the ordering; relax what is left a bounded number of times.
    if (done.size < items.length)
      for (let pass = 0; pass < 50; pass++) {
        let changed = false
        for (const [a, b, c] of cons)
          if (b.x < a.x + c) {
            b.x = a.x + c
            changed = true
          }
        if (!changed) break
      }
  }
  // Frame borders are not placed: an item next to one is bounded by the items across it.
  const loOf = (it: Item): number => {
    let lo = -Infinity
    for (const [a, c] of inC.get(it) ?? []) lo = Math.max(lo, (a.kind === "bound" ? loOf(a) : a.x) + c)
    return lo
  }
  const hiOf = (it: Item): number => {
    let hi = Infinity
    for (const [b, c] of outC.get(it) ?? []) hi = Math.min(hi, (b.kind === "bound" ? hiOf(b) : b.x) - c)
    return hi
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((p, q) => p - q)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : Math.floor((s[m - 1]! + s[m]!) / 2)
  }
  const clusterItems = clusters.map(() => [] as Item[])
  for (const it of items) if (it.kind !== "spacer" && it.kind !== "bound") for (const c of chain(it.cluster)) clusterItems[c]!.push(it)
  for (let round = 0; round < 12; round++) {
    const down = round % 2 === 0
    const order = down ? layers : [...layers].reverse()
    for (const ly of order) {
      const want = new Map<Item, number>()
      for (const it of ly) {
        if (it.kind === "spacer") {
          const xs = clusterItems[it.cluster]!
          if (xs.length) want.set(it, median(xs.map((m) => m.x + co(m))))
          continue
        }
        let segs: Seg[]
        if (it.kind !== "node") segs = [...it.up, ...it.down]
        else {
          segs = down ? it.up : it.down
          if (!segs.length) segs = down ? it.down : it.up
          // Long edges bend around the node; the node lines up with its direct neighbours.
          const real = segs.filter((sg) => (sg.u === it ? sg.v : sg.u).kind === "node")
          if (real.length) segs = real
        }
        if (!segs.length) continue
        // Line up the ports at both ends of each edge, so edges run straight.
        want.set(
          it,
          median(segs.map((sg) => (sg.u === it ? sg.v.x + sg.vPort!.off - sg.uPort!.off : sg.u.x + sg.uPort!.off - sg.vPort!.off))),
        )
      }
      const right = ly.filter((it) => want.has(it) && want.get(it)! > it.x).reverse()
      const left = ly.filter((it) => want.has(it) && want.get(it)! < it.x)
      for (const it of [...right, ...left]) it.x = Math.max(loOf(it), Math.min(hiOf(it), want.get(it)!))
    }
  }
  // Finally straighten one-to-one links (a node, its label, the next node) from the top down,
  // so simple chains run without jogs.
  for (let pass = 0; pass < 2; pass++)
    for (const ly of layers) {
      const want = new Map<Item, number>()
      for (const it of ly) {
        if (it.up.length !== 1) continue
        const sg = it.up[0]!
        if (sg.u.kind === "node" && sg.u.down.length !== 1) continue
        want.set(it, sg.u.x + sg.uPort!.off - sg.vPort!.off)
      }
      const right = ly.filter((it) => want.has(it) && want.get(it)! > it.x).reverse()
      const left = ly.filter((it) => want.has(it) && want.get(it)! < it.x)
      for (const it of [...right, ...left]) it.x = Math.max(loOf(it), Math.min(hiOf(it), want.get(it)!))
    }
  const real = items.filter((it) => it.kind !== "bound")

  const portX = (p: Port) => p.item.x + p.off

  // ---- channels per gap ------------------------------------------------------------------------
  const gapChannels: number[] = []
  const mkGroup = (segs: Seg[]): Group => {
    const src = segs.map((s) => portX(s.uPort!))
    const tgt = segs.map((s) => portX(s.vPort!))
    return {
      segs,
      lo: Math.min(minOf(src), minOf(tgt)),
      hi: Math.max(maxOf(src), maxOf(tgt)),
      src: [...new Set(src)],
      tgt: [...new Set(tgt)],
      needsRow: segs.some((s) => portX(s.uPort!) !== portX(s.vPort!)),
      row: 0,
    }
  }
  for (let g = 0; g + 1 < layerCount; g++) {
    const segs = layers[g]!.flatMap((it) => it.down)
    const groups: Group[] = []
    const bySrc = new Map<Port, Seg[]>()
    for (const s of segs) {
      if (!bySrc.has(s.uPort!)) bySrc.set(s.uPort!, [])
      bySrc.get(s.uPort!)!.push(s)
    }
    const byTgt = new Map<Port, Seg[]>()
    for (const list of bySrc.values()) {
      if (list.length >= 2) groups.push(mkGroup(list))
      else {
        const s = list[0]!
        if (!byTgt.has(s.vPort!)) byTgt.set(s.vPort!, [])
        byTgt.get(s.vPort!)!.push(s)
      }
    }
    for (const list of byTgt.values()) groups.push(mkGroup(list))
    const rowed = groups.filter((gr) => gr.needsRow).sort((p, q) => p.lo - q.lo || p.hi - q.hi)
    const touch = (gr: Group, x: number) => x >= gr.lo && x <= gr.hi
    const overlap = (p: Group, q: Group) => p.lo <= q.hi + 1 && q.lo <= p.hi + 1
    // Which group's row should come first so its horizontal does not cross the other's verticals.
    const preds = new Map<Group, Group[]>(rowed.map((gr) => [gr, []]))
    const succs = new Map<Group, Group[]>(rowed.map((gr) => [gr, []]))
    for (let i = 0; i < rowed.length; i++)
      for (let j = i + 1; j < rowed.length && rowed[j]!.lo <= rowed[i]!.hi + 1; j++) {
        const p = rowed[i]!
        const q = rowed[j]!
        if (!overlap(p, q)) continue
        const pFirst = q.tgt.filter((x) => touch(p, x)).length + p.src.filter((x) => touch(q, x)).length
        const qFirst = q.src.filter((x) => touch(p, x)).length + p.tgt.filter((x) => touch(q, x)).length
        if (pFirst > qFirst) {
          preds.get(q)!.push(p)
          succs.get(p)!.push(q)
        } else if (qFirst > pFirst) {
          preds.get(p)!.push(q)
          succs.get(q)!.push(p)
        }
      }
    // Kahn's order (leftmost first); a cycle is broken at its leftmost group.
    const left = new Map<Group, number>(rowed.map((gr) => [gr, preds.get(gr)!.length]))
    const done = new Set<Group>()
    const orderG: Group[] = []
    let avail = rowed.filter((gr) => left.get(gr) === 0)
    while (orderG.length < rowed.length) {
      if (!avail.length) avail = [rowed.find((gr) => !done.has(gr))!]
      avail.sort((p, q) => p.lo - q.lo || p.hi - q.hi)
      const gr = avail.shift()!
      if (done.has(gr)) continue
      done.add(gr)
      orderG.push(gr)
      for (const q of succs.get(gr)!) {
        const n = left.get(q)! - 1
        left.set(q, n)
        if (n === 0 && !done.has(q)) avail.push(q)
      }
    }
    const rows: Group[][] = []
    const assigned = new Set<Group>()
    for (const gr of orderG) {
      let r = 0
      for (const p of preds.get(gr)!) if (assigned.has(p)) r = Math.max(r, p.row + 1)
      while (rows[r]?.some((p) => overlap(p, gr))) r++
      gr.row = r
      ;(rows[r] ??= []).push(gr)
      assigned.add(gr)
    }
    const usedRows = rows.length
    // A short stub leaves each box before the first turn.
    const channels = usedRows === 0 ? minCh : Math.max(minCh, usedRows + 1)
    const offset = usedRows === 0 ? 0 : vertical ? channels - usedRows : Math.ceil((channels - usedRows) / 2)
    for (const gr of groups) for (const s of gr.segs) s.row = gr.row + offset
    gapChannels.push(channels)
  }

  // ---- main-axis positions ---------------------------------------------------------------------
  const frameList = clusters.map((_, c) => c).filter((c) => drawnCluster[c])
  const tops = (l: number) => frameList.filter((c) => span[c]![0] === l)
  const bottoms = (l: number) => frameList.filter((c) => span[c]![1] === l)
  const frameTop = clusters.map(() => 0)
  const frameBottom = clusters.map(() => 0)
  const layerStart: number[] = []
  const gapCh: number[] = []
  // Frames of the same depth never overlap, so they share a border row.
  const placeRows = (list: number[], at: number, into: number[], outerFirst: boolean): number => {
    const ds = [...new Set(list.map((c) => depth[c]!))].sort((p, q) => (outerFirst ? p - q : q - p))
    for (const c of list) into[c] = at + ds.indexOf(depth[c]!)
    return ds.length
  }
  let m = 0
  {
    const n = placeRows(tops(0), m, frameTop, true)
    m += n + (n ? 1 : 0)
  }
  for (let l = 0; l < layerCount; l++) {
    layerStart[l] = m
    m += lsz[l]!
    const b = bottoms(l)
    if (b.length) m += 1
    m += placeRows(b, m, frameBottom, false)
    if (l + 1 >= layerCount) break
    const segs = layers[l]!.flatMap((it) => it.down)
    if (segs.some((s) => s.headU !== "none")) m += 1
    gapCh[l] = m
    m += gapChannels[l]!
    const n = placeRows(tops(l + 1), m, frameTop, true)
    m += n + (n ? 1 : 0)
    // The row for arrowheads (and open-end stubs) in front of a box.
    if (segs.some((s) => s.v.kind === "node")) m += 1
  }
  const M = m
  for (const it of real) it.m0 = layerStart[it.layer]! + Math.floor((lsz[it.layer]! - it.ms) / 2)
  // Pull frame borders in to their members when the members are smaller than their layer
  // (keeping the blank row and the arrow row inside the frame).
  const childFrames = clusters.map(() => [] as number[])
  for (const c of frameList) if (clusters[c]!.parent >= 0) childFrames[clusters[c]!.parent]!.push(c)
  const directItems = clusters.map(() => [] as Item[])
  for (const it of real) if (it.cluster >= 0) directItems[it.cluster]!.push(it)
  for (const c of byDepth) {
    if (!drawnCluster[c]) continue
    let inTop = Infinity
    let inBottom = -Infinity
    for (const it of directItems[c]!)
      if (it.kind === "node") {
        inTop = Math.min(inTop, it.m0 - 3)
        inBottom = Math.max(inBottom, it.m0 + it.ms + 1)
      }
    for (const k of childFrames[c]!) {
      inTop = Math.min(inTop, frameTop[k]! - 1)
      inBottom = Math.max(inBottom, frameBottom[k]! + 1)
    }
    if (Number.isFinite(inTop)) frameTop[c] = Math.max(frameTop[c]!, inTop)
    if (Number.isFinite(inBottom)) frameBottom[c] = Math.min(frameBottom[c]!, inBottom)
  }

  // ---- frames (cross extents) and normalisation -----------------------------------------------
  const fl = clusters.map(() => Infinity)
  const fr = clusters.map(() => -Infinity)
  for (const c of byDepth) {
    if (!drawnCluster[c]) continue
    for (const it of directItems[c]!) {
      fl[c] = Math.min(fl[c]!, it.x + it.L - margin)
      fr[c] = Math.max(fr[c]!, it.x + it.R + margin)
    }
    for (const k of childFrames[c]!) {
      fl[c] = Math.min(fl[c]!, fl[k]! - margin)
      fr[c] = Math.max(fr[c]!, fr[k]! + margin)
    }
  }
  let minX = Math.min(minOf(real.map((it) => it.x + it.L)), minOf(fl))
  if (!Number.isFinite(minX)) minX = 0
  for (const it of real) it.x -= minX
  for (let c = 0; c < clusters.length; c++) {
    fl[c]! -= minX
    fr[c]! -= minX
  }
  const crossSize = Math.max(maxOf(real.map((it) => it.x + it.R + 1), 0), maxOf(fr.map((v) => v + 1), 0))
  if ((vertical ? crossSize : M) > width) return undefined

  // ---- drawing ---------------------------------------------------------------------------------
  const cv = new Canvas()
  const pt = (mm: number, c: number): [number, number] => {
    switch (dir) {
      case "TD":
        return [c, mm]
      case "BT":
        return [c, M - 1 - mm]
      case "LR":
        return [mm, c]
      case "RL":
        return [M - 1 - mm, c]
    }
  }
  const rect = (m0: number, ms: number, c0: number) => {
    switch (dir) {
      case "TD":
        return { x: c0, y: m0 }
      case "BT":
        return { x: c0, y: M - m0 - ms }
      case "LR":
        return { x: m0, y: c0 }
      case "RL":
        return { x: M - m0 - ms, y: c0 }
    }
  }
  const plusBit = { TD: DOWN, BT: UP, LR: RIGHT, RL: LEFT }[dir]
  const minusBit = { TD: UP, BT: DOWN, LR: LEFT, RL: RIGHT }[dir]

  // Frames first: edges drawn later cut through them.
  for (const c of [...byDepth].reverse()) {
    if (!drawnCluster[c]) continue
    const [x1, y1] = pt(frameTop[c]!, fl[c]!)
    const [x2, y2] = pt(frameBottom[c]!, fr[c]!)
    const x0 = Math.min(x1, x2)
    const xe = Math.max(x1, x2)
    const y0 = Math.min(y1, y2)
    const ye = Math.max(y1, y2)
    cv.text(x0, y0, "╭" + "╌".repeat(xe - x0 - 1) + "╮")
    cv.text(x0, ye, "╰" + "╌".repeat(xe - x0 - 1) + "╯")
    for (let y = y0 + 1; y < ye; y++) {
      cv.text(x0, y, "╎")
      cv.text(xe, y, "╎")
    }
  }

  const farBorder = (it: Item) => (it.kind === "node" ? it.m0 + it.ms - 1 : layerStart[it.layer]! + lsz[it.layer]! - 1)
  const nearBorder = (it: Item) => (it.kind === "node" ? it.m0 : layerStart[it.layer]!)
  for (let g = 0; g + 1 < layerCount; g++) {
    for (const it of layers[g]!)
      for (const s of it.down) {
        const a = portX(s.uPort!)
        const b = portX(s.vPort!)
        const m1 = farBorder(s.u)
        const m2 = nearBorder(s.v)
        const pts: Array<[number, number]> =
          a === b
            ? [pt(m1, a), pt(m2, b)]
            : [pt(m1, a), pt(gapCh[g]! + s.row, a), pt(gapCh[g]! + s.row, b), pt(m2, b)]
        cv.path(pts, s.style)
      }
  }
  // Dummies and labels: the edge runs straight through their layer.
  for (const it of real)
    if (it.kind === "dummy" || it.kind === "label") {
      const s = it.up[0] ?? it.down[0]
      if (!s) continue
      const c = it.x + co(it)
      cv.path([pt(layerStart[it.layer]!, c), pt(layerStart[it.layer]! + lsz[it.layer]! - 1, c)], s.style)
    }

  for (const it of nodeItems) {
    const box = it.box!
    const r = rect(it.m0, it.ms, it.x)
    box.rows.forEach((row, i) => {
      const lead = row.length - row.trimStart().length
      cv.text(r.x + lead, r.y + i, row.trim())
    })
  }

  const headGlyph = (h: Head, plus: boolean) =>
    h === "arrow" ? ARROWS[dir][plus ? 0 : 1] : h === "circle" ? "○" : h === "cross" ? "×" : ""
  const tee = (mm: number, c: number, outward: number, style: Style) => {
    const [x, y] = pt(mm, c)
    const ch = cv.charAt(x, y)
    const thick = style === "thick"
    let t = ""
    if (ch === "─") t = outward === DOWN ? (thick ? "┰" : "┬") : outward === UP ? (thick ? "┸" : "┴") : ""
    else if (ch === "│") t = outward === RIGHT ? (thick ? "┝" : "├") : outward === LEFT ? (thick ? "┥" : "┤") : ""
    if (t) cv.text(x, y, t)
  }
  for (const it of real)
    for (const s of it.down) {
      if (s.first && s.u.kind === "node") {
        const a = portX(s.uPort!)
        const mb = farBorder(s.u)
        if (s.headU !== "none") {
          const [x, y] = pt(mb + 1, a)
          cv.text(x, y, headGlyph(s.headU, false))
        } else tee(mb, a, plusBit, s.style)
      }
      if (s.last && s.v.kind === "node") {
        const b = portX(s.vPort!)
        const mb = nearBorder(s.v)
        if (s.headD !== "none") {
          const [x, y] = pt(mb - 1, b)
          cv.text(x, y, headGlyph(s.headD, true))
        } else tee(mb, b, minusBit, s.style)
      }
    }

  // Edge labels, over their own edge's line.
  for (const it of real) {
    if (it.kind !== "label") continue
    const r = rect(it.m0, it.ms, it.x)
    const bw = maxWidth(it.text)
    it.text.forEach((line, i) => {
      const w = strWidth(line)
      if (vertical) cv.text(r.x + Math.floor((bw - w) / 2), r.y + i, line)
      else cv.text(r.x + 1 + Math.floor((bw - w) / 2), r.y + i, line)
    })
  }

  // Frame titles go on the frame's top border where no edge crosses it.
  for (const c of byDepth) {
    if (!drawnCluster[c] || !clusters[c]!.title) continue
    const [x1, y1] = pt(frameTop[c]!, fl[c]!)
    const [x2, y2] = pt(frameBottom[c]!, fr[c]!)
    const x0 = Math.min(x1, x2)
    const xe = Math.max(x1, x2)
    const y0 = Math.min(y1, y2)
    const runs: Array<[number, number]> = []
    let start = -1
    for (let x = x0 + 1; x <= xe; x++) {
      const free = x < xe && cv.charAt(x, y0) === "╌" && !cv.hasLine(x, y0)
      if (free && start < 0) start = x
      if (!free && start >= 0) {
        runs.push([start, x - start])
        start = -1
      }
    }
    const title = clusters[c]!.title.replace(/\n/g, " ")
    const tw = strWidth(title) + 2
    const fit = runs.find(([s, len]) => len - (s === x0 + 1 ? 1 : 0) >= tw)
    if (fit) {
      cv.text(fit[0] + (fit[0] === x0 + 1 ? 1 : 0), y0, ` ${title} `)
      continue
    }
    const longest = [...runs].sort((p, q) => q[1] - p[1])[0]
    if (longest && longest[1] >= 5) {
      const off = longest[0] === x0 + 1 ? 1 : 0
      cv.text(longest[0] + off, y0, ` ${truncate(title, longest[1] - off - 2)} `)
    }
  }

  const lines = cv.toLines()
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  while (lines.length && lines[0] === "") lines.shift()
  return lines
}
