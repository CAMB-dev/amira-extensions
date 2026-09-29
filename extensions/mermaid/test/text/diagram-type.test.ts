import { describe, expect, test } from "bun:test"
import { diagramType, renderMermaidText } from "../../src/text/index.ts"

describe("diagramType", () => {
  test("graph and flowchart are both flowcharts", () => {
    expect(diagramType("graph TD\nA-->B")).toBe("flowchart")
    expect(diagramType("flowchart LR\nA-->B")).toBe("flowchart")
    expect(diagramType("graph\nA-->B")).toBe("flowchart")
    expect(diagramType("graph TD;A-->B;")).toBe("flowchart")
  })

  test("sequenceDiagram is sequence", () => {
    expect(diagramType("sequenceDiagram\nA->>B: hi")).toBe("sequence")
  })

  test("other types give their raw keyword", () => {
    expect(diagramType('pie title Pets\n"Dogs" : 386')).toBe("pie")
    expect(diagramType("gantt\ntitle A Gantt Diagram")).toBe("gantt")
    expect(diagramType("classDiagram\nclass Animal")).toBe("classDiagram")
    expect(diagramType("stateDiagram-v2\n[*] --> Still")).toBe("stateDiagram-v2")
  })

  test("skips blank lines, %% comments, directives and front matter", () => {
    expect(diagramType("\n\n  %% a comment\n%%{init: {'theme':'dark'}}%%\n  graph TD\nA-->B")).toBe("flowchart")
    expect(diagramType("---\ntitle: Hello\nconfig:\n  theme: forest\n---\nsequenceDiagram\nA->>B: x")).toBe("sequence")
    expect(diagramType("---\ntitle: x\n---\n\n%% c\ngantt")).toBe("gantt")
  })

  test("empty input is undefined", () => {
    expect(diagramType("")).toBeUndefined()
    expect(diagramType("  \n\n %% only a comment\n")).toBeUndefined()
  })
})

describe("renderMermaidText", () => {
  test("types without a text renderer give undefined", () => {
    expect(renderMermaidText('pie title Pets\n"Dogs" : 386', 80)).toBeUndefined()
    expect(renderMermaidText("gantt\ntitle x", 80)).toBeUndefined()
    expect(renderMermaidText("", 80)).toBeUndefined()
  })

  test("unparseable source gives undefined", () => {
    expect(renderMermaidText("flowchart TD\n", 80)).toBeUndefined()
    expect(renderMermaidText("sequenceDiagram\n", 80)).toBeUndefined()
  })

  test("absurdly small widths give undefined", () => {
    expect(renderMermaidText("graph TD\nA-->B", 0)).toBeUndefined()
    expect(renderMermaidText("graph TD\nA-->B", 3)).toBeUndefined()
  })

  test("lines are code by default, plain text, trimmed", () => {
    const out = renderMermaidText("graph TD\nA-->B", 80)!
    expect(out.length).toBeGreaterThan(0)
    for (const l of out) {
      expect(l.kind).toBe("code")
      expect(l.text).not.toMatch(/[\n\x1b]/)
      expect(l.text).toBe(l.text.trimEnd())
    }
  })

  test("output is deterministic", () => {
    const src = "flowchart TD\nA-->B & C\nB-->D\nC-->D\nD-->A"
    expect(renderMermaidText(src, 60)).toEqual(renderMermaidText(src, 60)!)
  })
})
