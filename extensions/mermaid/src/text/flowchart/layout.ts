/**
 * Layered flowchart layout on a character grid.
 *
 * Coordinates are computed along a "main" axis (the flow direction: down for TD, right for LR)
 * and a "cross" axis, then mapped to x/y for the chosen direction. Steps: break cycles by
 * reversing back edges, assign layers (longest path), insert dummy items for long edges and
 * spacer items for subgraph frames, order layers by barycenter sweeps (keeping subgraph members
 * together), place items along the cross axis under difference constraints, route every edge
 * orthogonally through per-gap channel rows, and draw.
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

interface Item {
  idx: number
  kind: "node" | "dummy" | "spacer"
  node: number
  layer: number
  cluster: number
  box: Box | undefined
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
  labels: string[]
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

export function layoutFlowchart(fc: Flowchart, o: LayoutOptions): string[] {
  const dir = o.dir
  const vertical = dir === "TD" || dir === "BT"
  const nodeIndex = new Map(fc.nodes.map((n, i) => [n.id, i]))
  const clusters = fc.clusters

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
  const ledges: Array<[number, number]> = []
  for (const e of fc.edges) {
    const a = nodeIndex.get(e.from)
    const b = nodeIndex.get(e.to)
    if (a === undefined || b === undefined) continue
    if (a === b) {
      if (e.style !== "invisible") selfLoops[a]!.push(e.label)
      continue
    }
    ledges.push([a, b])
    if (e.style === "invisible") continue
    drawn.push({
      a,
      b,
      style: e.style,
      headFrom: e.headFrom,
      headTo: e.headTo,
      label: e.label ? wrapText(e.label, o.edgeWrap).filter((l, i, all) => l || all.length === 1) : [],
      layoutIdx: ledges.length - 1,
    })
  }
  const nodeLines = fc.nodes.map((n, i) => {
    const lines = wrapText(n.label || n.id, o.nodeWrap)
    for (const l of selfLoops[i]!) lines.push(...wrapText(l ? `↻ ${l}` : "↻", o.nodeWrap))
    return lines
  })

  // ---- cycle breaking (DFS back edges get reversed) ------------------------------------
  const N = fc.nodes.length
  const out: number[][] = fc.nodes.map(() => [])
  ledges.forEach(([a], i) => out[a]!.push(i))
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
      const w = ledges[ei]![1]
      if (state[w] === 1) reversed[ei] = true
      else if (state[w] === 0) {
        state[w] = 1
        stack.push([w, 0])
      }
    }
  }
  const dag = ledges.map(([a, b], i) => (reversed[i] ? ([b, a] as const) : ([a, b] as const)))

  // ---- layering (longest path, sources pulled down next to their children) --------------
  const indeg = new Array<number>(N).fill(0)
  const succ: number[][] = fc.nodes.map(() => [])
  const pred: number[][] = fc.nodes.map(() => [])
  for (const [a, b] of dag) {
    succ[a]!.push(b)
    pred[b]!.push(a)
    indeg[b]!++
  }
  const topo: number[] = []
  const ready: number[] = []
  for (let i = 0; i < N; i++) if (indeg[i] === 0) ready.push(i)
  while (ready.length) {
    ready.sort((p, q) => p - q)
    const v = ready.shift()!
    topo.push(v)
    for (const w of succ[v]!) if (--indeg[w]! === 0) ready.push(w)
  }
  for (let i = 0; i < N; i++) if (!topo.includes(i)) topo.push(i)
  const layerOf = new Array<number>(N).fill(0)
  for (const v of topo) for (const w of succ[v]!) layerOf[w] = Math.max(layerOf[w]!, layerOf[v]! + 1)
  for (let t = topo.length - 1; t >= 0; t--) {
    const v = topo[t]!
    if (pred[v]!.length === 0 && succ[v]!.length > 0) {
      layerOf[v] = Math.min(...succ[v]!.map((w) => layerOf[w]!)) - 1
    }
  }
  const used = [...new Set(layerOf)].sort((p, q) => p - q)
  const remap = new Map(used.map((l, i) => [l, i]))
  for (let i = 0; i < N; i++) layerOf[i] = remap.get(layerOf[i]!)!
  const layerCount = used.length

  // ---- clusters -------------------------------------------------------------------------
  const nodeCluster = fc.nodes.map((n) => fc.membership.get(n.id) ?? -1)
  const depth = clusters.map((_, i) => {
    let d = 0
    for (let c = clusters[i]!.parent; c >= 0; c = clusters[c]!.parent) d++
    return d
  })
  const chain = (c: number): number[] => {
    const r: number[] = []
    for (let k = c; k >= 0; k = clusters[k]!.parent) r.push(k)
    return r
  }
  const within = (c: number, anc: number): boolean => {
    for (let k = c; k >= 0; k = clusters[k]!.parent) if (k === anc) return true
    return anc === -1
  }
  const lca = (c1: number, c2: number): number => {
    const a = chain(c1)
    for (let k = c2; k >= 0; k = clusters[k]!.parent) if (a.includes(k)) return k
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
  const edgeSegs: Seg[][] = []
  for (const e of drawn) {
    const rev = reversed[e.layoutIdx]!
    const U = rev ? e.b : e.a
    const D = rev ? e.a : e.b
    const headU = rev ? e.headTo : e.headFrom
    const headD = rev ? e.headFrom : e.headTo
    const cl = lca(nodeCluster[U]!, nodeCluster[D]!)
    const segs: Seg[] = []
    let prev = nodeItems[U]!
    const lu = layerOf[U]!
    const ld = layerOf[D]!
    for (let l = lu + 1; l <= ld; l++) {
      const next = l === ld ? nodeItems[D]! : mk("dummy", -1, l, cl)
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
        edge: edgeSegs.length,
      }
      prev.down.push(seg)
      next.up.push(seg)
      segs.push(seg)
      prev = next
    }
    edgeSegs.push(segs)
  }

  // Frames: which clusters are drawn, their layer spans, spacers where a span has a hole.
  const drawnCluster = clusters.map(() => false)
  const span: Array<[number, number]> = clusters.map(() => [Infinity, -Infinity])
  const byDepth = clusters.map((_, i) => i).sort((p, q) => depth[q]! - depth[p]! || p - q)
  for (const c of byDepth) {
    const members = items.filter((it) => it.cluster >= 0 && within(it.cluster, c))
    if (members.length === 0) continue
    drawnCluster[c] = true
    const lo = Math.min(...members.map((m) => m.layer))
    const hi = Math.max(...members.map((m) => m.layer))
    span[c] = [lo, hi]
    for (let l = lo; l <= hi; l++) if (!members.some((m) => m.layer === l)) mk("spacer", -1, l, c)
  }
  const frameChain = (c: number) => chain(c).filter((k) => drawnCluster[k])

  // ---- ports and boxes ------------------------------------------------------------------------
  const portKey = (head: Head, style: Style) => `${head}|${style}`
  for (const it of items) {
    if (it.kind === "spacer") continue
    const nearGroups = new Map<string, Port>()
    const farGroups = new Map<string, Port>()
    for (const s of it.up) {
      const key = it.kind === "dummy" ? "d" : portKey(s.headD, s.style)
      let p = nearGroups.get(key)
      if (!p) nearGroups.set(key, (p = { item: it, far: false, key, segs: [], off: 0, labels: [] }))
      p.segs.push(s)
      s.vPort = p
    }
    for (const s of it.down) {
      const key = it.kind === "dummy" ? "d" : portKey(s.headU, s.style)
      let p = farGroups.get(key)
      if (!p) farGroups.set(key, (p = { item: it, far: true, key, segs: [], off: 0, labels: [] }))
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

  // Edge labels sit next to the port that only this edge uses (target side preferred).
  drawn.forEach((e, i) => {
    if (!e.label.length) return
    const segs = edgeSegs[i]!
    const last = segs[segs.length - 1]!
    const first = segs[0]!
    const target = last.vPort!
    const source = first.uPort!
    const port = target.segs.length === 1 || source.segs.length !== 1 ? target : source
    port.labels.push(...e.label)
  })
  const blockSize = (lines: string[]) => {
    const bw = maxWidth(lines)
    return vertical ? { main: lines.length, cross: bw, bw } : { main: bw + 2, cross: lines.length, bw }
  }
  const labelStart = (portCross: number, lines: string[]) => {
    const { bw } = blockSize(lines)
    return vertical ? portCross - Math.floor(bw / 2) : portCross - Math.floor((lines.length - 1) / 2)
  }
  // ---- ordering ---------------------------------------------------------------------------------
  const layers: Item[][] = Array.from({ length: layerCount }, () => [])
  for (const it of items) layers[it.layer]!.push(it)
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
    for (const it of list) {
      if (it.cluster === parent) {
        units.push({ key: key.get(it)!, first: it.pos, cluster: -2, items: [it] })
        continue
      }
      let c = it.cluster
      while (c >= 0 && clusters[c]!.parent !== parent) c = clusters[c]!.parent
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
  const crossings = (): number => {
    let n = 0
    for (let l = 0; l + 1 < layerCount; l++) {
      const segs = layers[l]!.flatMap((it) => it.down)
      for (let i = 0; i < segs.length; i++)
        for (let j = i + 1; j < segs.length; j++) {
          const a = segs[i]!
          const b = segs[j]!
          if ((a.u.pos - b.u.pos) * (a.v.pos - b.v.pos) < 0) n++
        }
    }
    return n
  }
  const sweepLayer = (l: number, down: boolean) => {
    const ly = layers[l]!
    const key = new Map<Item, number>()
    const rank = clusterRank()
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
  // Group cluster members from the start.
  for (let l = 0; l < layerCount; l++) sweepLayer(l, true)
  let best = layers.map((ly) => [...ly])
  let bestC = crossings()
  for (let iter = 0; iter < 8 && bestC > 0; iter++) {
    const down = iter % 2 === 0
    if (down) for (let l = 1; l < layerCount; l++) sweepLayer(l, true)
    else for (let l = layerCount - 2; l >= 0; l--) sweepLayer(l, false)
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
      const firstEdge = (p: Port) => Math.min(...p.segs.map((sg) => sg.edge))
      ports.sort((p, q) => other(p) - other(q) || firstEdge(p) - firstEdge(q))
      const slots = it.kind === "node" ? portSlots(rangeOf(it, far), ports.length, it.cs, vertical) : [0]
      ports.forEach((p, i) => (p.off = slots[i] ?? slots[0]!))
    }
  }
  // Cross extents: the item plus any edge labels hanging off its ports.
  for (const it of items) {
    it.L = 0
    it.R = it.cs - 1
    for (const p of [...it.near, ...it.far]) {
      if (!p.labels.length) continue
      const a = labelStart(p.off, p.labels)
      it.L = Math.min(it.L, a)
      it.R = Math.max(it.R, a + blockSize(p.labels).cross - 1)
    }
  }

  // ---- cross-axis placement ------------------------------------------------------------------
  const gapBase = vertical ? 2 : 1
  const margin = 2
  const framesBetween = (a: Item, b: Item) => {
    const ca = frameChain(a.cluster)
    const cb = frameChain(b.cluster)
    return ca.filter((c) => !cb.includes(c)).length + cb.filter((c) => !ca.includes(c)).length
  }
  const sep = (a: Item, b: Item) => a.R + 1 + gapBase + margin * framesBetween(a, b) - b.L
  // Frames need room for their title on the top border: widen the first layer's members.
  if (vertical)
    for (let c = 0; c < clusters.length; c++) {
      if (!drawnCluster[c] || !clusters[c]!.title) continue
      const l = dir === "TD" ? span[c]![0] : span[c]![1]
      const run = layers[l]!.filter((it) => it.cluster >= 0 && within(it.cluster, c))
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
  const cons: Array<[Item, Item, number]> = []
  for (const ly of layers) for (let i = 0; i + 1 < ly.length; i++) cons.push([ly[i]!, ly[i + 1]!, sep(ly[i]!, ly[i + 1]!)])
  for (let c = 0; c < clusters.length; c++) {
    if (!drawnCluster[c]) continue
    const [lo, hi] = span[c]!
    const firsts: Item[] = []
    const lasts: Item[] = []
    const prevs: Item[] = []
    const nexts: Item[] = []
    for (let l = lo; l <= hi; l++) {
      const run = layers[l]!.filter((it) => it.cluster >= 0 && within(it.cluster, c))
      if (!run.length) continue
      const f = run[0]!
      const t = run[run.length - 1]!
      firsts.push(f)
      lasts.push(t)
      const p = layers[l]![f.pos - 1]
      const q = layers[l]![t.pos + 1]
      if (p) prevs.push(p)
      if (q) nexts.push(q)
    }
    for (const p of prevs) for (const f of firsts) if (p.layer !== f.layer) cons.push([p, f, sep(p, f)])
    for (const t of lasts) for (const q of nexts) if (t.layer !== q.layer) cons.push([t, q, sep(t, q)])
  }
  for (let pass = 0; pass < items.length + 2; pass++) {
    let changed = false
    for (const [a, b, c] of cons)
      if (b.x < a.x + c) {
        b.x = a.x + c
        changed = true
      }
    if (!changed) break
  }
  const inC = new Map<Item, Array<[Item, number]>>()
  const outC = new Map<Item, Array<[Item, number]>>()
  for (const [a, b, c] of cons) {
    if (!inC.has(b)) inC.set(b, [])
    if (!outC.has(a)) outC.set(a, [])
    inC.get(b)!.push([a, c])
    outC.get(a)!.push([b, c])
  }
  const co = (it: Item) => (it.kind === "node" ? Math.floor((it.cs - 1) / 2) : 0)
  const bounds = (it: Item): [number, number] => {
    let lo = -Infinity
    let hi = Infinity
    for (const [a, c] of inC.get(it) ?? []) lo = Math.max(lo, a.x + c)
    for (const [b, c] of outC.get(it) ?? []) hi = Math.min(hi, b.x - c)
    return [lo, hi]
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((p, q) => p - q)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : Math.floor((s[m - 1]! + s[m]!) / 2)
  }
  const clusterCenter = (c: number): number | undefined => {
    const xs = items.filter((it) => it.kind !== "spacer" && it.cluster >= 0 && within(it.cluster, c))
    return xs.length ? median(xs.map((it) => it.x + co(it))) : undefined
  }
  for (let round = 0; round < 12; round++) {
    const down = round % 2 === 0
    const order = down ? layers : [...layers].reverse()
    for (const ly of order) {
      const want = new Map<Item, number>()
      for (const it of ly) {
        let nb: Item[]
        if (it.kind === "spacer") {
          const cc = clusterCenter(it.cluster)
          if (cc !== undefined) want.set(it, cc)
          continue
        }
        if (it.kind === "dummy") nb = [...it.up.map((s) => s.u), ...it.down.map((s) => s.v)]
        else {
          nb = down ? it.up.map((s) => s.u) : it.down.map((s) => s.v)
          if (!nb.length) nb = down ? it.down.map((s) => s.v) : it.up.map((s) => s.u)
          // Long edges bend around the node; the node lines up with its direct neighbours.
          const real = nb.filter((n) => n.kind === "node")
          if (real.length) nb = real
        }
        if (!nb.length) continue
        // Line up the ports at both ends of each edge, so edges run straight.
        const segs = [...it.up, ...it.down].filter((sg) => nb.includes(sg.u === it ? sg.v : sg.u))
        want.set(
          it,
          median(segs.map((sg) => (sg.u === it ? sg.v.x + sg.vPort!.off - sg.uPort!.off : sg.u.x + sg.uPort!.off - sg.vPort!.off))),
        )
      }
      const right = ly.filter((it) => want.has(it) && want.get(it)! > it.x).reverse()
      const left = ly.filter((it) => want.has(it) && want.get(it)! < it.x)
      for (const it of [...right, ...left]) {
        const [lo, hi] = bounds(it)
        it.x = Math.max(lo, Math.min(hi, want.get(it)!))
      }
    }
  }

  const portX = (p: Port) => p.item.x + p.off

  // ---- channels per gap ------------------------------------------------------------------------
  const minCh = vertical ? 1 : 3
  const gapChannels: number[] = []
  const gapUsed: number[] = []
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
    const rowed = groups.filter((gr) => gr.needsRow)
    const touch = (gr: Group, x: number) => x >= gr.lo && x <= gr.hi
    const overlap = (p: Group, q: Group) => p.lo <= q.hi + 1 && q.lo <= p.hi + 1
    const before = new Map<Group, Set<Group>>(rowed.map((gr) => [gr, new Set()]))
    for (let i = 0; i < rowed.length; i++)
      for (let j = i + 1; j < rowed.length; j++) {
        const p = rowed[i]!
        const q = rowed[j]!
        if (!overlap(p, q)) continue
        // p above q avoids crossings when q's targets or p's sources lie under p's / q's span.
        const pFirst = q.tgt.filter((x) => touch(p, x)).length + p.src.filter((x) => touch(q, x)).length
        const qFirst = q.src.filter((x) => touch(p, x)).length + p.tgt.filter((x) => touch(q, x)).length
        if (pFirst > qFirst) before.get(q)!.add(p)
        else if (qFirst > pFirst) before.get(p)!.add(q)
      }
    const done = new Set<Group>()
    const orderG: Group[] = []
    while (orderG.length < rowed.length) {
      const avail = rowed.filter((gr) => !done.has(gr))
      avail.sort((p, q) => {
        const pa = [...before.get(p)!].filter((x) => !done.has(x)).length
        const qa = [...before.get(q)!].filter((x) => !done.has(x)).length
        return pa - qa || p.lo - q.lo || p.hi - q.hi
      })
      const gr = avail[0]!
      done.add(gr)
      orderG.push(gr)
    }
    const assigned: Group[] = []
    for (const gr of orderG) {
      let r = 0
      for (const p of before.get(gr)!) if (assigned.includes(p)) r = Math.max(r, p.row + 1)
      while (assigned.some((p) => p.row === r && overlap(p, gr))) r++
      gr.row = r
      assigned.push(gr)
    }
    const usedRows = assigned.length ? Math.max(...assigned.map((gr) => gr.row)) + 1 : 0
    // A short stub leaves each box before the first turn.
    const channels = usedRows === 0 ? minCh : Math.max(minCh, usedRows + 1)
    const offset = usedRows === 0 ? 0 : vertical ? channels - usedRows : Math.ceil((channels - usedRows) / 2)
    for (const gr of groups) for (const s of gr.segs) s.row = gr.row + offset
    gapChannels.push(channels)
    gapUsed.push(usedRows)
  }
  function mkGroup(segs: Seg[]): Group {
    const src = segs.map((s) => portX(s.uPort!))
    const tgt = segs.map((s) => portX(s.vPort!))
    const all = [...src, ...tgt]
    return {
      segs,
      lo: Math.min(...all),
      hi: Math.max(...all),
      src: [...new Set(src)],
      tgt: [...new Set(tgt)],
      needsRow: segs.some((s) => portX(s.uPort!) !== portX(s.vPort!)),
      row: 0,
    }
  }

  // ---- main-axis positions ---------------------------------------------------------------------
  const lsz = layers.map((ly) => Math.max(1, ...ly.map((it) => it.ms)))
  const tops = (l: number) =>
    clusters
      .map((_, c) => c)
      .filter((c) => drawnCluster[c] && span[c]![0] === l)
      .sort((p, q) => depth[p]! - depth[q]! || p - q)
  const bottoms = (l: number) =>
    clusters
      .map((_, c) => c)
      .filter((c) => drawnCluster[c] && span[c]![1] === l)
      .sort((p, q) => depth[q]! - depth[p]! || p - q)
  const frameTop = clusters.map(() => 0)
  const frameBottom = clusters.map(() => 0)
  const layerStart: number[] = []
  const gapSrc: number[] = []
  const gapCh: number[] = []
  const gapTgt: number[] = []
  const labelMain = (ports: Port[]) => Math.max(0, ...ports.filter((p) => p.labels.length).map((p) => blockSize(p.labels).main))
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
    gapSrc[l] = m
    m += labelMain(layers[l]!.flatMap((it) => it.far))
    gapCh[l] = m
    m += gapChannels[l]!
    gapTgt[l] = m
    m += labelMain(layers[l + 1]!.flatMap((it) => it.near))
    const n = placeRows(tops(l + 1), m, frameTop, true)
    m += n + (n ? 1 : 0)
    m += 1 // arrow row
  }
  const M = m
  for (const it of items) it.m0 = layerStart[it.layer]! + Math.floor((lsz[it.layer]! - it.ms) / 2)
  // Pull frame borders in to their members when the members are smaller than their layer
  // (keeping the blank row and the arrow row inside the frame).
  for (const c of byDepth) {
    if (!drawnCluster[c]) continue
    let inTop = Infinity
    let inBottom = -Infinity
    for (const it of nodeItems)
      if (it.cluster === c) {
        inTop = Math.min(inTop, it.m0 - 3)
        inBottom = Math.max(inBottom, it.m0 + it.ms + 1)
      }
    for (let k = 0; k < clusters.length; k++)
      if (drawnCluster[k] && clusters[k]!.parent === c) {
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
    for (const it of items)
      if (it.cluster === c) {
        fl[c] = Math.min(fl[c]!, it.x + it.L - margin)
        fr[c] = Math.max(fr[c]!, it.x + it.R + margin)
      }
    for (let k = 0; k < clusters.length; k++)
      if (drawnCluster[k] && clusters[k]!.parent === c) {
        fl[c] = Math.min(fl[c]!, fl[k]! - margin)
        fr[c] = Math.max(fr[c]!, fr[k]! + margin)
      }
  }
  let minX = Math.min(...items.map((it) => it.x + it.L), ...fl.filter((v) => Number.isFinite(v)))
  if (!Number.isFinite(minX)) minX = 0
  for (const it of items) it.x -= minX
  for (let c = 0; c < clusters.length; c++) {
    fl[c]! -= minX
    fr[c]! -= minX
  }

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
  const rect = (m0: number, ms: number, c0: number, cs: number) => {
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
  for (const it of items)
    if (it.kind === "dummy") {
      const s = it.up[0] ?? it.down[0]
      if (!s) continue
      cv.path([pt(layerStart[it.layer]!, it.x), pt(layerStart[it.layer]! + lsz[it.layer]! - 1, it.x)], s.style)
    }

  for (const it of nodeItems) {
    const box = it.box!
    const r = rect(it.m0, it.ms, it.x, it.cs)
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
  for (const it of items)
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

  // Edge labels.
  for (const it of items) {
    for (const p of [...it.near, ...it.far]) {
      if (!p.labels.length) continue
      const { main, cross, bw } = blockSize(p.labels)
      let m0: number
      if (p.far) m0 = gapSrc[it.layer]!
      else m0 = gapCh[it.layer - 1]! + gapChannels[it.layer - 1]! + (labelMain(layers[it.layer]!.flatMap((x) => x.near)) - main)
      const c0 = labelStart(portX(p), p.labels)
      const r = rect(m0, main, c0, cross)
      p.labels.forEach((line, i) => {
        const w = strWidth(line)
        if (vertical) cv.text(r.x + Math.floor((bw - w) / 2), r.y + i, line)
        else cv.text(r.x + 1 + Math.floor((bw - w) / 2), r.y + i, line)
      })
    }
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
