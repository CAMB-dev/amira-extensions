import { describe, expect, test } from "bun:test"
import { parseFlowchart, type FEdge } from "../../src/text/flowchart/parse.ts"

const parse = (body: string, header = "flowchart TD") => parseFlowchart(`${header}\n${body}`)!
const edge = (src: string): Omit<FEdge, "from" | "to"> => {
  const e = parse(src).edges[0]!
  return { style: e.style, headFrom: e.headFrom, headTo: e.headTo, label: e.label }
}

describe("flowchart parser", () => {
  test("directions", () => {
    expect(parse("A", "flowchart").dir).toBe("TD")
    expect(parse("A", "graph TB").dir).toBe("TD")
    expect(parse("A", "graph BT").dir).toBe("BT")
    expect(parse("A", "flowchart LR").dir).toBe("LR")
    expect(parse("A", "flowchart RL").dir).toBe("RL")
  })

  test("every node shape", () => {
    const shapes: Record<string, string> = {
      "A[x]": "rect",
      "A(x)": "round",
      "A([x])": "stadium",
      "A[[x]]": "subroutine",
      "A[(x)]": "database",
      "A((x))": "circle",
      "A(((x)))": "dcircle",
      "A>x]": "asym",
      "A{x}": "rhombus",
      "A{{x}}": "hexagon",
      "A[/x/]": "para",
      "A[\\x\\]": "paraAlt",
      "A[/x\\]": "trap",
      "A[\\x/]": "trapAlt",
      'A@{ shape: cyl, label: "x" }': "database",
    }
    for (const [src, shape] of Object.entries(shapes)) {
      const n = parse(src).nodes[0]!
      expect([src, n.shape, n.label]).toEqual([src, shape, "x"])
    }
  })

  test("bare ids show the id; quoted labels keep brackets; <br> breaks lines", () => {
    const fc = parse('A\nB["text with (parens) and [brackets]"]\nC[one<br>two<br/>three]\nD["`**bold** and *it*`"]')
    expect(fc.nodes.map((n) => n.label)).toEqual([
      "A",
      "text with (parens) and [brackets]",
      "one\ntwo\nthree",
      "bold and it",
    ])
  })

  test("every edge type", () => {
    const a = { headFrom: "none" as const, label: "" }
    expect(edge("A --> B")).toEqual({ ...a, style: "solid", headTo: "arrow" })
    expect(edge("A --- B")).toEqual({ ...a, style: "solid", headTo: "none" })
    expect(edge("A -.-> B")).toEqual({ ...a, style: "dotted", headTo: "arrow" })
    expect(edge("A -.- B")).toEqual({ ...a, style: "dotted", headTo: "none" })
    expect(edge("A ==> B")).toEqual({ ...a, style: "thick", headTo: "arrow" })
    expect(edge("A === B")).toEqual({ ...a, style: "thick", headTo: "none" })
    expect(edge("A --o B")).toEqual({ ...a, style: "solid", headTo: "circle" })
    expect(edge("A --x B")).toEqual({ ...a, style: "solid", headTo: "cross" })
    expect(edge("A <--> B")).toEqual({ ...a, style: "solid", headFrom: "arrow", headTo: "arrow" })
    expect(edge("A o--o B")).toEqual({ ...a, style: "solid", headFrom: "circle", headTo: "circle" })
    expect(edge("A ~~~ B")).toEqual({ ...a, style: "invisible", headTo: "none" })
    expect(edge("A ---> B")).toEqual({ ...a, style: "solid", headTo: "arrow" })
    expect(edge("A-->B")).toEqual({ ...a, style: "solid", headTo: "arrow" })
  })

  test("every label syntax", () => {
    expect(edge("A -- some text --> B").label).toBe("some text")
    expect(edge("A -->|some text| B").label).toBe("some text")
    expect(edge("A -. some text .-> B")).toEqual({ style: "dotted", headFrom: "none", headTo: "arrow", label: "some text" })
    expect(edge("A == some text ==> B")).toEqual({ style: "thick", headFrom: "none", headTo: "arrow", label: "some text" })
    expect(edge("A -- open text --- B")).toEqual({ style: "solid", headFrom: "none", headTo: "none", label: "open text" })
    expect(edge('A -->|"quoted | text"| B').label).toBe("quoted | text")
  })

  test("chains and & fan-out", () => {
    const fc = parse("A --> B --> C\nD & E --> F & G")
    expect(fc.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["A>B", "B>C", "D>F", "D>G", "E>F", "E>G"])
  })

  test("ignored statements", () => {
    const fc = parse(
      [
        "%% a comment",
        "classDef green fill:#9f6",
        "class A green",
        "style B fill:#f9f",
        "linkStyle 0 stroke:#ff3",
        'click A "https://example.com"',
        "accTitle: The title",
        "accDescr: The description",
        "accDescr {",
        "  a multi-line",
        "  description",
        "}",
        "A:::green --> B;B --> C",
      ].join("\n"),
    )
    expect(fc.nodes.map((n) => n.id)).toEqual(["A", "B", "C"])
    expect(fc.edges.length).toBe(2)
  })

  test("ids with dashes and dots are not links", () => {
    const fc = parse("node-1 --> v1.2")
    expect(fc.nodes.map((n) => n.id)).toEqual(["node-1", "v1.2"])
  })

  test("subgraphs, nesting and edges to a subgraph", () => {
    const fc = parse(
      [
        "subgraph one [First]",
        "  a1 --> a2",
        "  subgraph two",
        "    b1",
        "  end",
        "end",
        'subgraph "Quoted title"',
        "  c1",
        "end",
        "x --> one",
        "one --> x",
      ].join("\n"),
    )
    expect(fc.clusters.map((c) => [c.id, c.title, c.parent])).toEqual([
      ["one", "First", -1],
      ["two", "two", 0],
      ["Quoted title", "Quoted title", -1],
    ])
    expect(fc.membership.get("a1")).toBe(0)
    expect(fc.membership.get("b1")).toBe(1)
    expect(fc.membership.get("c1")).toBe(2)
    expect(fc.membership.has("x")).toBe(false)
    // "x --> one" enters one's first member without incoming edges; "one --> x" leaves from its last sink.
    expect(fc.edges.slice(1).map((e) => `${e.from}>${e.to}`)).toEqual(["x>a1", "b1>x"])
    expect(fc.nodes.some((n) => n.id === "one")).toBe(false)
  })

  test("not a flowchart", () => {
    expect(parseFlowchart("sequenceDiagram\nA->>B: x")).toBeUndefined()
    expect(parseFlowchart("flowchart TD")).toBeUndefined()
  })
})
