import { describe, expect, test } from "bun:test"
import { parseSequence, type Message } from "../../src/text/sequence/parse.ts"

const parse = (body: string) => parseSequence(`sequenceDiagram\n${body}`)!

describe("sequence parser", () => {
  test("participants, actors, aliases and first-appearance order", () => {
    const s = parse("participant B as Bob\nactor A\nC->>B: hi\nparticipant D as \"Dee Dee\"\nA->>D: x")
    expect(s.participants).toEqual([
      { id: "B", label: "Bob", actor: false },
      { id: "A", label: "A", actor: true },
      { id: "C", label: "C", actor: false },
      { id: "D", label: "Dee Dee", actor: false },
    ])
  })

  test("every arrow type", () => {
    const arrows: Record<string, [string, string, boolean]> = {
      "->>": ["solid", "arrow", false],
      "-->>": ["dotted", "arrow", false],
      "->": ["solid", "open", false],
      "-->": ["dotted", "open", false],
      "-x": ["solid", "cross", false],
      "--x": ["dotted", "cross", false],
      "-)": ["solid", "async", false],
      "--)": ["dotted", "async", false],
      "<<->>": ["solid", "arrow", true],
      "<<-->>": ["dotted", "arrow", true],
    }
    for (const [arrow, want] of Object.entries(arrows)) {
      const m = parse(`A${arrow}B: text`).events[0] as Message
      expect([arrow, m.line, m.head, m.both, m.from, m.to, m.text]).toEqual([arrow, ...want, 0, 1, "text"])
    }
  })

  test("activation markers are dropped; messages may omit text", () => {
    const s = parse("A->>+B: go\nB-->>-A: done\nA->>B\nactivate A\ndeactivate A")
    expect(s.events.map((e) => (e as Message).text)).toEqual(["go", "done", ""])
    expect(s.participants.map((p) => p.id)).toEqual(["A", "B"])
  })

  test("autonumber prefixes message text", () => {
    const s = parse("A->>B: one\nautonumber\nA->>B: two\nB->>A")
    expect(s.events.map((e) => (e as Message).text)).toEqual(["one", "1. two", "2."])
  })

  test("notes", () => {
    const s = parse("Note right of A: r\nnote left of B: l\nNote over A: o\nNote over B,A: two<br>lines")
    expect(s.events).toEqual([
      { t: "note", pos: "right", a: 0, b: 0, text: "r" },
      { t: "note", pos: "left", a: 1, b: 1, text: "l" },
      { t: "note", pos: "over", a: 0, b: 0, text: "o" },
      { t: "note", pos: "over", a: 0, b: 1, text: "two\nlines" },
    ])
  })

  test("blocks with sections, nesting, and transparent rect/box", () => {
    const s = parse(
      [
        "box Aqua Group",
        "participant A",
        "end",
        "alt ok",
        "  A->>B: yes",
        "  loop every second",
        "    B->>A: tick",
        "  end",
        "else failed",
        "  rect rgb(0, 0, 255)",
        "    A->>B: no",
        "  end",
        "end",
        "par one",
        "and two",
        "end",
      ].join("\n"),
    )
    const [alt, par] = s.events
    if (alt?.t !== "block" || par?.t !== "block") throw new Error("expected blocks")
    expect(alt.sections.map((x) => [x.kw, x.label, x.events.length])).toEqual([
      ["alt", "ok", 2],
      ["else", "failed", 1],
    ])
    expect(alt.sections[0]!.events[1]!.t).toBe("block")
    expect(par.sections.map((x) => x.kw)).toEqual(["par", "and"])
  })

  test("not a sequence diagram", () => {
    expect(parseSequence("graph TD\nA-->B")).toBeUndefined()
    expect(parseSequence("sequenceDiagram")).toBeUndefined()
  })
})
