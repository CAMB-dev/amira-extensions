// Generated from the renderer's output and reviewed by eye: each array is the diagram.
import { describe, expect, test } from "bun:test"
import { renderMermaidText } from "../../src/text/index.ts"

const render = (src: string, width: number) => renderMermaidText(src, width)?.map((l) => l.text)

describe("flowchart rendering", () => {
  test("TD: a decision with yes/no branches and a loop back", () => {
    const src = `flowchart TD
    A[Start] --> B{Is it ok?}
    B -->|Yes| C[Keep going]
    B -->|No| D[Rethink]
    D --> A
    C --> E((Done))`
    expect(render(src, 100)).toEqual([
      "   ┌───────┐",
      "   │ Start │",
      "   └──┬────┘",
      "      │ ▲",
      "      │ │",
      "      │ └──────┐",
      "      ▼        │",
      " ╱─────────╲   │",
      "< Is it ok? >  │",
      " ╲────┬────╱   │",
      "      │        │",
      "      │        └──────┐",
      "      ├─────────────┐ │",
      "     Yes           No │",
      "      ▼             ▼ │",
      "┌────────────┐  ┌─────┴───┐",
      "│ Keep going │  │ Rethink │",
      "└─────┬──────┘  └─────────┘",
      "      │",
      "      ▼",
      "    ╭────╮",
      "   ( Done )",
      "    ╰────╯",
    ])
  })

  test("graph TD: the classic shopping example", () => {
    const src = `graph TD
    A[Christmas] -->|Get money| B(Go shopping)
    B --> C{Let me think}
    C -->|One| D[Laptop]
    C -->|Two| E[iPhone]
    C -->|Three| F[fa:fa-car Car]`
    expect(render(src, 100)).toEqual([
      "          ┌───────────┐",
      "          │ Christmas │",
      "          └─────┬─────┘",
      "                │",
      "            Get money",
      "                ▼",
      "         ╭─────────────╮",
      "         │ Go shopping │",
      "         ╰──────┬──────╯",
      "                │",
      "                ▼",
      "          ╱────────────╲",
      "         < Let me think >",
      "          ╲─────┬──────╱",
      "                │",
      "    ┌───────────┼──────────┐",
      "   One         Two       Three",
      "    ▼           ▼          ▼",
      "┌────────┐  ┌────────┐  ┌─────┐",
      "│ Laptop │  │ iPhone │  │ Car │",
      "└────────┘  └────────┘  └─────┘",
    ])
  })

  test("LR: labels, a database, a dotted edge and a thick edge back", () => {
    const src = `graph LR
    A[Client] -- request --> B(Server)
    B --> C[(Database)]
    B -.-> D>Log]
    C ==> B`
    expect(render(src, 100)).toEqual([
      "                                      ╭──────────╮",
      "                       ╭────────╮     ├──────────┤",
      "                       │        ├────▶│          │",
      "┌────────┐             │        │     │ Database │",
      "│ Client ├────request─▶│ Server │◀━━━━┥          │",
      "└────────┘             │        │     ╰──────────╯",
      "                       │        ├┄┄┐",
      "                       ╰────────╯  ┆    ──────┐",
      "                                   └┄┄┄▶> Log │",
      "                                        ──────┘",
    ])
  })

  test("BT: flows upwards", () => {
    const src = `flowchart BT
    A[Bottom] --> B[Middle] --> C[Top]
    A --> C`
    expect(render(src, 100)).toEqual([
      " ┌─────┐",
      " │ Top │",
      " └─────┘",
      "    ▲",
      "    ├───────┐",
      "    │       │",
      "┌───┴────┐  │",
      "│ Middle │  │",
      "└────────┘  │",
      "    ▲       │",
      "    ├───────┘",
      "    │",
      "┌───┴────┐",
      "│ Bottom │",
      "└────────┘",
    ])
  })

  test("RL: flows leftwards", () => {
    const src = `flowchart RL
    A[Right] --> B[Left]
    A -- label --> C[Other]`
    expect(render(src, 100)).toEqual([
      " ┌──────┐",
      " │ Left │◀────────┐",
      " └──────┘         │ ┌───────┐",
      "                  ├─┤ Right │",
      "┌───────┐         │ └───────┘",
      "│ Other │◀─label──┘",
      "└───────┘",
    ])
  })

  test("every node shape", () => {
    const src = `flowchart TD
    a[rect] --> b(round) --> c([stadium]) --> d[[subroutine]]
    d --> e[(database)] --> f((circle)) --> g>asym] --> h{rhombus}
    h --> i{{hexagon}} --> j[/para/] --> k[\\alt\\] --> l[/trap\\] --> m[\\trapalt/] --> n(((double)))`
    expect(render(src, 100)).toEqual([
      "    ┌──────┐",
      "    │ rect │",
      "    └──┬───┘",
      "       │",
      "       ▼",
      "   ╭───────╮",
      "   │ round │",
      "   ╰───┬───╯",
      "       │",
      "       ▼",
      "  ╭─────────╮",
      "  ( stadium )",
      "  ╰────┬────╯",
      "       │",
      "       ▼",
      "┌┬────────────┬┐",
      "││ subroutine ││",
      "└┴─────┬──────┴┘",
      "       │",
      "       ▼",
      "  ╭──────────╮",
      "  ├──────────┤",
      "  │ database │",
      "  ╰────┬─────╯",
      "       │",
      "       ▼",
      "    ╭──────╮",
      "   ( circle )",
      "    ╰──┬───╯",
      "       │",
      "       ▼",
      "    ───────┐",
      "    > asym │",
      "    ───┬───┘",
      "       │",
      "       ▼",
      "   ╱───────╲",
      "  < rhombus >",
      "   ╲───┬───╱",
      "       │",
      "       ▼",
      "  ╱─────────╲",
      "  │ hexagon │",
      "  ╲────┬────╱",
      "       │",
      "       ▼",
      "     ┌─────┐",
      "    ╱ para ╱",
      "    └──┬──┘",
      "       │",
      "       ▼",
      "    ┌────┐",
      "    ╲ alt ╲",
      "     └─┬──┘",
      "       │",
      "       ▼",
      "     ┌────┐",
      "    ╱ trap ╲",
      "    └──┬───┘",
      "       │",
      "       ▼",
      "  ┌─────────┐",
      "  ╲ trapalt ╱",
      "   └───┬───┘",
      "       │",
      "       ▼",
      "   ╭────────╮",
      "  (( double ))",
      "   ╰────────╯",
    ])
  })

  test("every edge type (LR)", () => {
    const src = `flowchart LR
    A --> B
    A --- C
    A -.-> D
    A -.- E
    A ==> F
    A === G
    A --o H
    A --x I
    A <--> J
    A ~~~ K`
    expect(render(src, 100)).toEqual([
      "           ┌───┐",
      "       ┌──▶│ B │",
      "       │   └───┘",
      "       │",
      "       │   ┌───┐",
      "       ├───┤ C │",
      "       │   └───┘",
      "       │",
      "       │   ┌───┐",
      "       ├──○│ H │",
      "       │   └───┘",
      "       │",
      "       │   ┌───┐",
      "       ├──×│ I │",
      "┌───┐  │   └───┘",
      "│   ├──┘",
      "│   │      ┌───┐",
      "│   ├┄┄┄┄┬▶│ D │",
      "│ A │    ┆ └───┘",
      "│   ┝━━━┓┆",
      "│   │   ┃┆ ┌───┐",
      "│   │◀─┐┃└┄┤ E │",
      "└───┘  │┃  └───┘",
      "       │┃",
      "       │┃  ┌───┐",
      "       │┣━▶│ F │",
      "       │┃  └───┘",
      "       │┃",
      "       │┃  ┌───┐",
      "       │┗━━┥ G │",
      "       │   └───┘",
      "       │",
      "       │   ┌───┐",
      "       └──▶│ J │",
      "           └───┘",
      "",
      "           ┌───┐",
      "           │ K │",
      "           └───┘",
    ])
  })

  test("every edge label syntax", () => {
    const src = `flowchart TD
    A -- text one --> B
    A -. dotted text .-> C
    A == thick text ==> D
    A -->|pipe text| E
    B & C & D & E ---> F`
    expect(render(src, 100)).toEqual([
      "                ┌─────────┐",
      "                │    A    │",
      "                └──┬─┬─┰──┘",
      "                   │ ┆ ┃",
      "    ┌─────────┬────┘ ┆ ┗━━━━━━━━━━━━━━━┓",
      "    │         │      └┄┄┄┄┐            ┃",
      "text one  pipe text  dotted text  thick text",
      "    ▼         ▼           ▼            ▼",
      "  ┌───┐     ┌───┐       ┌───┐        ┌───┐",
      "  │ B │     │ E │       │ C │        │ D │",
      "  └─┬─┘     └─┬─┘       └─┬─┘        └─┬─┘",
      "    │         │           │            │",
      "    └─────────┴─────┬─────┴────────────┘",
      "                    ▼",
      "                  ┌───┐",
      "                  │ F │",
      "                  └───┘",
    ])
  })

  test("chains and & fan-out", () => {
    const src = `flowchart TD
    A & B --> C & D
    C --> E --> F
    D --> E`
    expect(render(src, 100)).toEqual([
      "┌───┐  ┌───┐",
      "│ A │  │ B │",
      "└─┬─┘  └─┬─┘",
      "  │      │",
      "  ├──────┤",
      "  ├──────┤",
      "  ▼      ▼",
      "┌───┐  ┌───┐",
      "│ C │  │ D │",
      "└─┬─┘  └─┬─┘",
      "  │      │",
      "  └──┬───┘",
      "     ▼",
      "   ┌───┐",
      "   │ E │",
      "   └─┬─┘",
      "     │",
      "     ▼",
      "   ┌───┐",
      "   │ F │",
      "   └───┘",
    ])
  })

  test("a cycle", () => {
    const src = `graph TD
    A --> B --> C --> A`
    expect(render(src, 100)).toEqual([
      "┌───────┐",
      "│   A   │",
      "└──┬────┘",
      "   │ ▲",
      "   │ │",
      "   │ └──┐",
      "   ▼    │",
      " ┌───┐  │",
      " │ B │  │",
      " └─┬─┘  │",
      "   │    │",
      "   │ ┌──┘",
      "   ▼ │",
      "┌────┴──┐",
      "│   C   │",
      "└───────┘",
    ])
  })

  test("subgraph (TD, nested)", () => {
    const src = `flowchart TD
    subgraph outer [Outer box]
      subgraph inner [Inner box]
        x1 --> x2
      end
      x2 --> y1
    end
    start --> x1
    y1 --> fin`
    expect(render(src, 100)).toEqual([
      "  ┌───────┐",
      "  │ start │",
      "  └───┬───┘",
      "      │",
      "╭╌╌╌╌╌│ Outer box ╌╌╌╌╮",
      "╎ ╭╌╌╌│ Inner box ╌╌╮ ╎",
      "╎ ╎   │             ╎ ╎",
      "╎ ╎   ▼             ╎ ╎",
      "╎ ╎ ┌────┐          ╎ ╎",
      "╎ ╎ │ x1 │          ╎ ╎",
      "╎ ╎ └─┬──┘          ╎ ╎",
      "╎ ╎   │             ╎ ╎",
      "╎ ╎   ▼             ╎ ╎",
      "╎ ╎ ┌────┐          ╎ ╎",
      "╎ ╎ │ x2 │          ╎ ╎",
      "╎ ╎ └─┬──┘          ╎ ╎",
      "╎ ╎   │             ╎ ╎",
      "╎ ╰╌╌╌│╌╌╌╌╌╌╌╌╌╌╌╌╌╯ ╎",
      "╎     │               ╎",
      "╎     ▼               ╎",
      "╎   ┌────┐            ╎",
      "╎   │ y1 │            ╎",
      "╎   └─┬──┘            ╎",
      "╎     │               ╎",
      "╰╌╌╌╌╌│╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯",
      "      │",
      "      ▼",
      "   ┌─────┐",
      "   │ fin │",
      "   └─────┘",
    ])
  })

  test("subgraph (LR) with edges in and out", () => {
    const src = `flowchart LR
    subgraph api [API layer]
      gw[Gateway] --> svc(Service)
    end
    user((User)) --> gw
    svc --> db[(DB)]`
    expect(render(src, 100)).toEqual([
      "           ╭╌ API layer ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮",
      "           ╎                             ╎    ╭────╮",
      " ╭────╮    ╎  ┌─────────┐    ╭─────────╮ ╎    ├────┤",
      "( User )─────▶│ Gateway ├───▶│ Service ├─────▶│ DB │",
      " ╰────╯    ╎  └─────────┘    ╰─────────╯ ╎    ╰────╯",
      "           ╎                             ╎",
      "           ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯",
    ])
  })

  test("CJK labels are two columns wide", () => {
    const src = `flowchart TD
    A[开始] --> B{是否登录}
    B -->|是| C[进入首页]
    B -->|否| D[跳转登录页]
    D --> B`
    expect(render(src, 100)).toEqual([
      "                 ┌──────┐",
      "                 │ 开始 │",
      "                 └──┬───┘",
      "                    │",
      "                    ▼",
      "                ╱────────╲",
      "               < 是否登录 >",
      "                ╲──┬─────╱",
      "                   │  ▲",
      "                   │  │",
      "     ┌─────────────┤  │",
      "    是            否  │",
      "     ▼             ▼  │",
      "┌──────────┐  ┌───────┴────┐",
      "│ 进入首页 │  │ 跳转登录页 │",
      "└──────────┘  └────────────┘",
    ])
  })

  test("labels with <br>, quotes and markdown strings", () => {
    const src = `flowchart LR
    A["Quoted (with parens)"] --> B["\`**Bold** text\`"]
    B --> C[two<br>lines]`
    expect(render(src, 100)).toEqual([
      "┌──────────────────────┐    ┌───────────┐    ┌───────┐",
      "│ Quoted (with parens) ├───▶│ Bold text ├───▶│  two  │",
      "└──────────────────────┘    └───────────┘    │ lines │",
      "                                             └───────┘",
    ])
  })
})
