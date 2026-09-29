/** A lenient parser for Mermaid flowchart / graph source. */
import { cleanLabel, meaningfulLines } from "../util.ts"

export type Dir = "TD" | "BT" | "LR" | "RL"
export type Shape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "database"
  | "circle"
  | "dcircle"
  | "asym"
  | "rhombus"
  | "hexagon"
  | "para"
  | "paraAlt"
  | "trap"
  | "trapAlt"
export type LineStyle = "solid" | "dotted" | "thick" | "invisible"
export type Head = "none" | "arrow" | "circle" | "cross"

export interface FNode {
  id: string
  label: string
  shape: Shape
}

export interface FEdge {
  from: string
  to: string
  style: LineStyle
  headFrom: Head
  headTo: Head
  label: string
}

export interface FCluster {
  id: string
  title: string
  /** Index of the enclosing cluster, or -1. */
  parent: number
}

export interface Flowchart {
  dir: Dir
  nodes: FNode[]
  edges: FEdge[]
  clusters: FCluster[]
  /** Node id → index of its innermost cluster (absent: top level). */
  membership: Map<string, number>
}

const OPENERS: ReadonlyArray<readonly [string, string[], Shape[]]> = [
  ["(((", [")))"], ["dcircle"]],
  ["((", ["))"], ["circle"]],
  ["([", ["])"], ["stadium"]],
  ["[[", ["]]"], ["subroutine"]],
  ["[(", [")]"], ["database"]],
  ["[/", ["/]", "\\]"], ["para", "trap"]],
  ["[\\", ["\\]", "/]"], ["paraAlt", "trapAlt"]],
  ["{{", ["}}"], ["hexagon"]],
  ["(", [")"], ["round"]],
  ["[", ["]"], ["rect"]],
  ["{", ["}"], ["rhombus"]],
  [">", ["]"], ["asym"]],
]

const AT_SHAPES: Record<string, Shape> = {
  rect: "rect",
  rectangle: "rect",
  proc: "rect",
  process: "rect",
  rounded: "round",
  event: "round",
  stadium: "stadium",
  pill: "stadium",
  terminal: "stadium",
  subproc: "subroutine",
  subroutine: "subroutine",
  "framed-rectangle": "subroutine",
  cyl: "database",
  cylinder: "database",
  db: "database",
  database: "database",
  circle: "circle",
  circ: "circle",
  "dbl-circ": "dcircle",
  "double-circle": "dcircle",
  diam: "rhombus",
  diamond: "rhombus",
  decision: "rhombus",
  question: "rhombus",
  hex: "hexagon",
  hexagon: "hexagon",
  prepare: "hexagon",
  "lean-r": "para",
  "lean-right": "para",
  "lean-l": "paraAlt",
  "lean-left": "paraAlt",
  "trap-b": "trap",
  trapezoid: "trap",
  "trap-t": "trapAlt",
  "inv-trapezoid": "trapAlt",
  odd: "asym",
}

const IGNORED = /^(classDef|class|style|linkStyle|click|direction)\s/
const ID_BREAK = new Set([..."[](){}<>&;|\"'`"])
const WORD = /[\p{L}\p{N}_]/u

/** Splits a line into `;`-separated statements, keeping `;` inside quotes and `#entity;`. */
function splitStatements(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote = false
  // Length of a `#name` / `&name` run just before this character (-1: none), so `;` ending an
  // entity is not a separator. Tracked as we go to stay linear.
  let entity = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') quote = !quote
    if (ch === ";" && !quote && entity <= 0) {
      out.push(cur)
      cur = ""
      entity = -1
      continue
    }
    if (ch === "#" || ch === "&") entity = 0
    else if (entity >= 0 && /[a-zA-Z0-9]/.test(ch)) entity++
    else entity = -1
    cur += ch
  }
  out.push(cur)
  return out
}

interface Link {
  style: LineStyle
  headFrom: Head
  headTo: Head
  label: string
}

class ChainParser {
  i = 0
  constructor(private readonly s: string) {}

  get done(): boolean {
    return this.i >= this.s.length
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++
  }

  id(): string {
    const s = this.s
    const start = this.i
    while (this.i < s.length) {
      const ch = s[this.i]!
      if (/\s/.test(ch) || ID_BREAK.has(ch)) break
      if (ch === ":" && s.startsWith(":::", this.i)) break
      if (ch === "@" && s[this.i + 1] === "{") break
      if (ch === "-" || ch === "=" || ch === "~" || ch === ".") {
        const next = s[this.i + 1]
        if ((ch === "-" || ch === ".") && this.i > start && next && WORD.test(next)) {
          this.i++
          continue
        }
        break
      }
      this.i++
    }
    return s.slice(start, this.i)
  }

  /** Reads `[label]`-style shape syntax after an id, if present. */
  shape(): { shape: Shape; label: string } | undefined {
    const s = this.s
    if (s[this.i] === "@" && s[this.i + 1] === "{") {
      const end = s.indexOf("}", this.i)
      if (end < 0) return undefined
      const body = s.slice(this.i + 2, end)
      this.i = end + 1
      const shapeName = /shape\s*:\s*"?([\w-]+)"?/.exec(body)?.[1]
      const label = /label\s*:\s*"([^"]*)"/.exec(body)?.[1]
      return { shape: (shapeName && AT_SHAPES[shapeName]) || "rect", label: cleanLabel(label ?? "") }
    }
    for (const [open, closers, shapes] of OPENERS) {
      if (!s.startsWith(open, this.i)) continue
      let j = this.i + open.length
      let label: string
      let quoted: string | undefined
      let k = j
      while (k < s.length && s[k] === " ") k++
      if (s[k] === '"') {
        const q = s.indexOf('"', k + 1)
        if (q >= 0) {
          quoted = s.slice(k + 1, q)
          j = q + 1
        }
      }
      let best = -1
      let which = 0
      closers.forEach((c, n) => {
        const at = s.indexOf(c, j)
        if (at >= 0 && (best < 0 || at < best)) {
          best = at
          which = n
        }
      })
      if (best < 0) return undefined
      label = quoted !== undefined ? quoted : s.slice(j, best)
      this.i = best + closers[which]!.length
      return { shape: shapes[which]!, label: cleanLabel(label) }
    }
    return undefined
  }

  classSuffix(): void {
    if (this.s.startsWith(":::", this.i)) {
      this.i += 3
      while (this.i < this.s.length && /[\w-]/.test(this.s[this.i]!)) this.i++
    }
  }

  /** Reads a link (`-->`, `-- text -->`, `-.->|x|`, …) or returns undefined. */
  link(): Link | undefined {
    const s = this.s
    const save = this.i
    let headFrom: Head = "none"
    const c0 = s[this.i]
    if (c0 === "<") {
      headFrom = "arrow"
      this.i++
    } else if ((c0 === "o" || c0 === "x") && /^[-=.]{2}/.test(s.slice(this.i + 1, this.i + 3))) {
      headFrom = c0 === "o" ? "circle" : "cross"
      this.i++
    }
    const headOf = (ch: string | undefined): Head =>
      ch === ">" ? "arrow" : ch === "o" ? "circle" : ch === "x" ? "cross" : "none"
    const finish = (style: LineStyle, headTo: Head, label: string): Link => {
      this.ws()
      if (s[this.i] === "|") {
        let from = this.i + 1
        while (s[from] === " ") from++
        const close = s[from] === '"' ? s.indexOf('"', from + 1) : -1
        const end = s.indexOf("|", close >= 0 ? close + 1 : this.i + 1)
        if (end >= 0) {
          label = s.slice(this.i + 1, end)
          this.i = end + 1
        }
      }
      return { style, headFrom, headTo, label: cleanLabel(label) }
    }
    if (s.startsWith("~~~", this.i)) {
      while (s[this.i] === "~") this.i++
      return finish("invisible", "none", "")
    }
    const labelMode = (terminator: RegExp, style: LineStyle): Link | undefined => {
      const rest = s.slice(this.i)
      const m = terminator.exec(rest)
      if (!m) return undefined
      const label = rest.slice(0, m.index)
      this.i += m.index + m[0].length
      return finish(style, headOf(m[0].at(-1)), label)
    }
    if (s[this.i] === "=") {
      let k = 0
      while (s[this.i + k] === "=") k++
      if (k < 2) {
        this.i = save
        return undefined
      }
      this.i += k
      const h = headOf(s[this.i])
      if (h !== "none") {
        this.i++
        return finish("thick", h, "")
      }
      if (k >= 3) return finish("thick", "none", "")
      const r = labelMode(/={2,}[>ox]|={3,}/, "thick")
      if (r) return r
      this.i = save
      return undefined
    }
    if (s[this.i] === "-") {
      if (s[this.i + 1] === ".") {
        this.i += 1
        while (s[this.i] === ".") this.i++
        if (s[this.i] === "-") {
          this.i++
          const h = headOf(s[this.i])
          if (h !== "none") this.i++
          return finish("dotted", h, "")
        }
        const r = labelMode(/\.+-[>ox]?/, "dotted")
        if (r) return r
        this.i = save
        return undefined
      }
      let k = 0
      while (s[this.i + k] === "-") k++
      if (k < 2) {
        this.i = save
        return undefined
      }
      this.i += k
      const h = headOf(s[this.i])
      if (h !== "none") {
        this.i++
        return finish("solid", h, "")
      }
      if (k >= 3) return finish("solid", "none", "")
      const r = labelMode(/-{2,}[>ox]|-{3,}/, "solid")
      if (r) return r
      this.i = save
      return undefined
    }
    this.i = save
    return undefined
  }
}

export function parseFlowchart(source: string): Flowchart | undefined {
  const lines = meaningfulLines(source)
  if (lines.length === 0) return undefined
  const header = /^\s*(flowchart-elk|flowchart|graph)(?![\w-])(?:\s+(TD|TB|BT|LR|RL|[<>^v])(?![\w-]))?\s*;?(.*)$/i.exec(lines[0]!)
  if (!header) return undefined
  const dirRaw = (header[2] ?? "TD").toUpperCase()
  const dir: Dir =
    dirRaw === "LR" || dirRaw === ">"
      ? "LR"
      : dirRaw === "RL" || dirRaw === "<"
        ? "RL"
        : dirRaw === "BT" || dirRaw === "^"
          ? "BT"
          : "TD"
  const body = [header[3] ?? "", ...lines.slice(1)]

  const nodes = new Map<string, FNode>()
  const explicit = new Set<string>()
  const edges: FEdge[] = []
  const clusters: FCluster[] = []
  const membership = new Map<string, number>()
  const stack: number[] = []

  const touch = (id: string, shape?: { shape: Shape; label: string }) => {
    let n = nodes.get(id)
    if (!n) {
      n = { id, label: id, shape: "rect" }
      nodes.set(id, n)
    }
    if (shape) {
      n.shape = shape.shape
      n.label = shape.label
      explicit.add(id)
    }
    const cur = stack.at(-1)
    if (cur !== undefined && !membership.has(id)) membership.set(id, cur)
  }

  let skipBlock = false
  for (const rawLine of body) {
    if (skipBlock) {
      if (rawLine.includes("}")) skipBlock = false
      continue
    }
    for (const raw of splitStatements(rawLine)) {
      const st = raw.trim()
      if (!st) continue
      if (/^accDescr\s*\{/.test(st)) {
        if (!st.includes("}")) skipBlock = true
        continue
      }
      if (/^acc(Title|Descr)\s*:/.test(st) || IGNORED.test(st)) continue
      if (st === "end") {
        stack.pop()
        continue
      }
      const sg = /^subgraph\s+(.*)$/.exec(st)
      if (sg) {
        const rest = sg[1]!.trim()
        let id: string
        let title: string
        const m = /^([^\s[\]"]+)\s*\[(.*)\]\s*$/.exec(rest)
        if (m) {
          id = m[1]!
          title = cleanLabel(m[2]!)
        } else {
          title = cleanLabel(rest)
          id = rest.replace(/^"|"$/g, "")
        }
        clusters.push({ id, title, parent: stack.at(-1) ?? -1 })
        stack.push(clusters.length - 1)
        continue
      }
      if (st === "subgraph") {
        clusters.push({ id: `subgraph${clusters.length}`, title: "", parent: stack.at(-1) ?? -1 })
        stack.push(clusters.length - 1)
        continue
      }
      parseChain(st, touch, edges)
    }
  }

  // Edges that name a subgraph connect to one of its members.
  const clusterIds = new Map(clusters.map((c, i) => [c.id, i]))
  const order = new Map([...nodes.keys()].map((id, i) => [id, i]))
  const members = (ci: number): string[] => {
    const out: string[] = []
    for (const [id, c] of membership) {
      let k: number = c
      while (k >= 0 && k !== ci) k = clusters[k]!.parent
      if (k === ci && !clusterIds.has(id)) out.push(id)
    }
    return out.sort((a, b) => order.get(a)! - order.get(b)!)
  }
  const endpoints = new Set(edges.flatMap((e) => [e.from, e.to]))
  for (const [cid, ci] of clusterIds) {
    if (explicit.has(cid)) continue
    if (!endpoints.has(cid)) {
      if (nodes.has(cid) && members(ci).length) {
        nodes.delete(cid)
        membership.delete(cid)
      }
      continue
    }
    const m = members(ci)
    if (m.length === 0) continue
    // An edge out of a subgraph leaves from its last member without an outgoing edge inside it;
    // an edge into a subgraph enters its first member without an incoming edge inside it.
    const mset = new Set(m)
    const inside = edges.filter((e) => mset.has(e.from) && mset.has(e.to))
    const hasOut = new Set(inside.map((e) => e.from))
    const hasIn = new Set(inside.map((e) => e.to))
    const sinks = m.filter((id) => !hasOut.has(id))
    const sources = m.filter((id) => !hasIn.has(id))
    const exit = sinks[sinks.length - 1] ?? m[m.length - 1]!
    const entry = sources[0] ?? m[0]!
    let used = false
    for (const e of edges) {
      if (e.from === cid) {
        e.from = exit
        used = true
      }
      if (e.to === cid) {
        e.to = entry
        used = true
      }
    }
    if (used || nodes.has(cid)) {
      nodes.delete(cid)
      membership.delete(cid)
    }
  }

  if (nodes.size === 0) return undefined
  return { dir, nodes: [...nodes.values()], edges, clusters, membership }
}

function parseChain(
  st: string,
  touch: (id: string, shape?: { shape: Shape; label: string }) => void,
  edges: FEdge[],
): void {
  const p = new ChainParser(st)
  const group = (): string[] | undefined => {
    const ids: string[] = []
    for (;;) {
      p.ws()
      const id = p.id()
      if (!id) return ids.length ? ids : undefined
      const shape = p.shape()
      p.classSuffix()
      touch(id, shape)
      ids.push(id)
      p.ws()
      if (st[p.i] === "&") {
        p.i++
        continue
      }
      return ids
    }
  }
  let left = group()
  if (!left) return
  for (;;) {
    p.ws()
    if (p.done) return
    const link = p.link()
    if (!link) return
    p.ws()
    const right = group()
    if (!right) return
    for (const a of left)
      for (const b of right)
        edges.push({ from: a, to: b, style: link.style, headFrom: link.headFrom, headTo: link.headTo, label: link.label })
    left = right
  }
}
