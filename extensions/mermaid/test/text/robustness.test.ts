import { describe, expect, test } from "bun:test"
import { renderMermaidText } from "../../src/text/index.ts"
import { wrapText } from "../../src/text/util.ts"

const render = (src: string, width: number) => renderMermaidText(src, width)?.map((l) => l.text)

describe("hostile text", () => {
  test("escape sequences and control characters never reach the output", () => {
    expect(render("flowchart LR\n  A[\x1b[31mred\x1b[0m label] --> B[tab\there\x07]", 80)).toEqual([
      "┌───────────┐    ┌──────────┐",
      "│ red label ├───▶│ tab here │",
      "└───────────┘    └──────────┘",
    ])
    const seq = render("sequenceDiagram\n  A->>B: \x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b[1mbold\x1b[0m", 80)!
    expect(seq.join("\n")).toContain("link bold")
    expect(seq.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  })

  test("an entity outside Unicode is dropped instead of failing the diagram", () => {
    expect(render("flowchart LR\n  A[see #99999999; x] --> B[#35; ok]", 80)).toEqual([
      "┌───────┐    ┌──────┐",
      "│ see x ├───▶│ # ok │",
      "└───────┘    └──────┘",
    ])
  })
})

// Everything runs on the UI thread: inputs up to ~20 000 characters must stay fast. The bounds
// are generous (the typical time is a few to a few tens of milliseconds) to avoid flaky runs.
const LIMIT_MS = 1000
const timed = (src: string, width = 120) => {
  const t = performance.now()
  const out = renderMermaidText(src, width)
  const ms = performance.now() - t
  for (const l of out ?? []) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(width)
  return ms
}

describe("performance", () => {
  const cases: Record<string, () => string> = {
    "a hub: n0 feeds every node of a chain": () =>
      "flowchart TD\n" + Array.from({ length: 300 }, (_, i) => `n${i} --> n${i + 1}\nn0 --> n${i + 1}`).join("\n"),
    "a sink: every node of a chain can fail": () =>
      "flowchart TD\n" + Array.from({ length: 300 }, (_, i) => `n${i} --> n${i + 1}\nn${i} -.-> ERR`).join("\n"),
    "random graph, 300 nodes": () => {
      let s = 7
      const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
      return "flowchart TD\n" + Array.from({ length: 600 }, () => `n${Math.floor(r() * 300)} --> n${Math.floor(r() * 300)}`).join("\n")
    },
    "300 nested subgraphs": () =>
      "flowchart TD\n" +
      Array.from({ length: 300 }, (_, i) => `subgraph s${i}\nn${i}`).join("\n") +
      "\n" +
      "end\n".repeat(300) +
      Array.from({ length: 299 }, (_, i) => `n${i} --> n${i + 1}`).join("\n"),
    "a labelled chain": () => "flowchart TD\n" + Array.from({ length: 400 }, (_, i) => `n${i} -->|step ${i}| n${i + 1}`).join("\n"),
    "1000 messages between 400 participants": () =>
      "sequenceDiagram\n" + Array.from({ length: 1000 }, (_, i) => `P${i % 400}->>P${(i * 7) % 400}: m${i}`).join("\n"),
    "300 nested loops": () => "sequenceDiagram\n" + "loop x\n".repeat(300) + "A->>B: hi\n" + "end\n".repeat(300),
    "one 20 000 character word in a node": () => `flowchart TD\nA[${"x".repeat(20000)}] --> B`,
    "one 20 000 character message": () => `sequenceDiagram\nA->>B: ${"x".repeat(20000)}`,
    "semicolons inside quotes": () => `flowchart TD\nA["${"a;".repeat(10000)}"]`,
    "entities": () => `flowchart TD\nA[${"#35;".repeat(5000)}]`,
    "a very long link": () => `flowchart TD\nA ${"-".repeat(20000)} B`,
    "arrows without text": () => "sequenceDiagram\n" + "A->".repeat(6000),
  }
  for (const [name, make] of Object.entries(cases))
    test(name, () => {
      const src = make()
      for (const w of [40, 120, 250]) expect([w, timed(src, w)]).toEqual([w, expect.any(Number)])
      const worst = Math.max(...[40, 120, 250].map((w) => timed(src, w)))
      expect(worst).toBeLessThan(LIMIT_MS)
    })

  test("wrapping a long word is linear", () => {
    const t = performance.now()
    expect(wrapText("x".repeat(40000), 10).length).toBe(4000)
    expect(performance.now() - t).toBeLessThan(LIMIT_MS)
  })
})
