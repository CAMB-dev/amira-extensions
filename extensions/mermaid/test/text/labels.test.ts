// Edge labels sit on their own edge and never overlap other labels, lines or boxes; unrelated
// edges cross without joining. Expected diagrams are the renderer's output, reviewed by eye.
import { describe, expect, test } from "bun:test"
import { renderMermaidText } from "../../src/text/index.ts"

const render = (src: string, width: number) => renderMermaidText(src, width)?.map((l) => l.text)

describe("edge labels", () => {
  test("two labelled edges into one node stay apart", () => {
    const src = `graph TD
  A[Review] -->|approve| C[Merge]
  B[CI] -.->|passed| C`
    expect(render(src, 100)).toEqual([
      "┌────────┐  ┌────┐",
      "│ Review │  │ CI │",
      "└───┬────┘  └─┬──┘",
      "    │         ┆",
      " approve    passed",
      "    │         ┆",
      "    └──┐ ┌┄┄┄┄┘",
      "       ▼ ▼",
      "    ┌───────┐",
      "    │ Merge │",
      "    └───────┘",
    ])
  })

  test("labels on a back edge and a forward edge", () => {
    const src = `graph TD
  A[Start] --> B[Process]
  B -->|error| A
  B -->|ok| C[End]`
    expect(render(src, 100)).toEqual([
      " ┌───────┐",
      " │ Start │",
      " └──┬────┘",
      "    │ ▲",
      "    │ │",
      "   ┌┘ └┐",
      "   │ error",
      "   │   │",
      "   └┐ ┌┘",
      "    ▼ │",
      "┌─────┴───┐",
      "│ Process │",
      "└────┬────┘",
      "     │",
      "     ok",
      "     │",
      "     ▼",
      "  ┌─────┐",
      "  │ End │",
      "  └─────┘",
    ])
  })

  test("two labelled back edges", () => {
    const src = `graph TD
  A[Fetch] --> B{OK?}
  B -->|no, retry| A
  B -->|yes| C[Parse]
  C -->|invalid| A`
    expect(render(src, 100)).toEqual([
      "   ┌───────┐",
      "   │ Fetch │",
      "   └──┬────┘",
      "      │ ▲",
      "      │ │",
      "  ┌───┘ ├─────┐",
      "  │ no, retry │",
      "  │     │     │",
      "  └─┐ ┌─┘     └─┐",
      "    ▼ │         │",
      " ╱────┴──╲      │",
      "<   OK?   >  invalid",
      " ╲───┬───╱      │",
      "     │          │",
      "    yes         │",
      "     │          │",
      "     └──┐ ┌─────┘",
      "        ▼ │",
      "     ┌────┴──┐",
      "     │ Parse │",
      "     └───────┘",
    ])
  })

  test("a pipeline where every step can fail", () => {
    const src = `flowchart TD
  s0[Step 0] --> s1[Step 1]
  s0 -.->|fail| E[Error handler]
  s1 --> s2[Step 2]
  s1 -.->|fail| E`
    expect(render(src, 100)).toEqual([
      "  ┌────────┐",
      "  │ Step 0 │",
      "  └──┬──┬──┘",
      "     │  ┆",
      "     │  └┄┄┄┄┄┐",
      "     ▼        ┆",
      " ┌────────┐   ┆",
      " │ Step 1 │  fail",
      " └──┬──┬──┘   ┆",
      "    │  ┆      ┆",
      "    │  └┄┄┄┄┄┐┆",
      "    │        ┆└┄┄┐",
      "    ▼        ┆   ┆",
      "┌────────┐   ┆   ┆",
      "│ Step 2 │  fail ┆",
      "└────────┘   ┆   ┆",
      "             ┆   ┆",
      "             └┄┬┄┘",
      "               ▼",
      "       ┌───────────────┐",
      "       │ Error handler │",
      "       └───────────────┘",
    ])
  })

  test("a label stays on its own edge where edges merge", () => {
    const src = `flowchart TD
    A[User visits site] --> B{Logged in?}
    B -->|Yes| C[Show dashboard]
    B -->|No| D[Show login form]
    D --> E[User submits credentials]
    E --> F{Valid?}
    F -->|Yes| G[Create session]
    G --> C
    F -->|No| H[Show error]
    H --> D`
    expect(render(src, 100)).toEqual([
      " ┌──────────────────┐",
      " │ User visits site │",
      " └────────┬─────────┘",
      "          │",
      "          ▼",
      "     ╱──────────╲",
      "    < Logged in? >",
      "     ╲────┬─────╱",
      "          │",
      "      ┌───┴────┐",
      "      │        No",
      "      │        │",
      "      │        └──┐",
      "      │           ▼",
      "      │  ┌─────────────────┐",
      "      │  │ Show login form │",
      "      │  └─────┬───────────┘",
      "      │        │     ▲",
      "      │        │     │",
      " ┌────┘        └──┐  └─────────────┐",
      " │                ▼                │",
      " │   ┌──────────────────────────┐  │",
      "Yes  │ User submits credentials │  │",
      " │   └────────────┬─────────────┘  │",
      " │                │                │",
      " │                ▼                │",
      " │             ╱──────╲            │",
      " │            < Valid? >           │",
      " │             ╲──┬───╱            │",
      " │                │                │",
      " │             ┌──┴────┐           │",
      " │            Yes      No          │",
      " │             │       │           │",
      " │          ┌──┘       └─────┐  ┌──┘",
      " │          ▼                ▼  │",
      " │  ┌────────────────┐  ┌───────┴────┐",
      " │  │ Create session │  │ Show error │",
      " │  └───────┬────────┘  └────────────┘",
      " │          │",
      " └──────────┤",
      "            ▼",
      "    ┌────────────────┐",
      "    │ Show dashboard │",
      "    └────────────────┘",
    ])
  })

  test("an edge crossing a subgraph hops over the lines inside it", () => {
    const src = `flowchart TD
  A --> X
  subgraph S [Wide frame title here]
    X --> Y
    P --> Q
  end
  A --> Z
  Q --> Z`
    expect(render(src, 100)).toEqual([
      "       ╭╌ Wide frame title here ╌╮",
      "       ╎                         ╎",
      "┌───┐  ╎          ┌───┐          ╎",
      "│ A │  ╎          │ P │          ╎",
      "└─┬─┘  ╎          └─┬─┘          ╎",
      "  │    ╎            │            ╎",
      "  └─┬──────┐        │            ╎",
      "    │  ╎   ▼        ▼            ╎",
      "    │  ╎ ┌───┐    ┌───┐          ╎",
      "    │  ╎ │ X │    │ Q │          ╎",
      "    │  ╎ └─┬─┘    └─┬─┘          ╎",
      "    │  ╎   │        │            ╎",
      "    └──────│────────┴─────────────────┐",
      "       ╎   ▼                     ╎    ▼",
      "       ╎ ┌───┐                   ╎  ┌───┐",
      "       ╎ │ Y │                   ╎  │ Z │",
      "       ╎ └───┘                   ╎  └───┘",
      "       ╎                         ╎",
      "       ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯",
    ])
  })
})

describe("labels are whole and apart in any layout", () => {
  const cases = [
    "graph LR\n  A -->|first line<br>second line| C\n  B -.->|other one<br>more text| C",
    "graph TD\n  A -->|first| B\n  A -->|second| B\n  A -.->|third| B",
    "graph BT\n  A -->|up we go| B\n  A -->|and here| C\n  B --> D\n  C --> D",
    "graph RL\n  A -->|left| B\n  A -->|other way| C\n  B --> D\n  C --> D",
    "flowchart TD\n  S{Start?} -->|yes| A\n  S -->|no| B\n  S -->|maybe| C\n  S -->|never| D\n  A & B & C & D --> E",
  ]
  for (const src of cases)
    test(src.split("\n")[0]! + " " + src.split("|")[1], () => {
      const lines = render(src, 100)!
      const text = lines.join("\n")
      for (const m of src.matchAll(/\|([^|]+)\|/g))
        for (const part of m[1]!.split("<br>")) {
          // Each label appears once, whole, with a non-letter on both sides.
          const at = lines.flatMap((l) => [...l.matchAll(new RegExp(`(^|[^\\p{L}])${part}($|[^\\p{L}])`, "gu"))])
          expect([part, at.length]).toEqual([part, 1])
        }
      expect(text).not.toMatch(/[\p{L}][│┆┃]|[│┆┃][\p{L}]/u)
    })
})
