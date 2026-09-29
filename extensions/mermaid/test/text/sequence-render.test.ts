// Generated from the renderer's output and reviewed by eye: each array is the diagram.
import { describe, expect, test } from "bun:test"
import { renderMermaidText } from "../../src/text/index.ts"

const render = (src: string, width: number) => renderMermaidText(src, width)?.map((l) => l.text)

describe("sequence rendering", () => {
  test("participants, an actor, aliases and every arrow type", () => {
    const src = `sequenceDiagram
    participant A as Alice
    actor B as Bob
    A->>B: Hello Bob, how are you?
    B-->>A: Great!
    A-)B: async
    B--)A: async dotted
    A-xB: cross
    B--xA: dotted cross
    A->B: open
    B-->A: dotted open
    A->>A: think
    A<<->>B: both ways`
    expect(render(src, 100)).toEqual([
      "                               ○",
      "┌───────┐                     ╶┼╴",
      "│ Alice │                     ╱ ╲",
      "└───┬───┘                     Bob",
      "    │                          │",
      "    │ Hello Bob, how are you?  │",
      "    ├─────────────────────────▶│",
      "    │         Great!           │",
      "    │◀┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤",
      "    │          async           │",
      "    ├─────────────────────────▷│",
      "    │      async dotted        │",
      "    │◁┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤",
      "    │          cross           │",
      "    ├─────────────────────────×│",
      "    │      dotted cross        │",
      "    │×┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤",
      "    │          open            │",
      "    ├──────────────────────────┤",
      "    │       dotted open        │",
      "    ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤",
      "    ├──┐ think                 │",
      "    │◀─┘                       │",
      "    │        both ways         │",
      "    │◀────────────────────────▶│",
      "    │                          │",
    ])
  })

  test("implicit participants, autonumber, loop, alt/else, opt and notes", () => {
    const src = `sequenceDiagram
    autonumber
    Alice->>John: Hello John
    loop Every minute
        John-->>Alice: Great!
    end
    alt is sick
        Bob->>Alice: Not so good :(
    else is well
        Bob->>Alice: Feeling fresh like a daisy
    end
    opt Extra response
        Bob->>Alice: Thanks for asking
    end
    Note right of John: Rational thoughts<br/>prevail!
    Note left of Alice: left note
    Note over Alice: over one
    Note over Alice,John: spanning note`
    expect(render(src, 100)).toEqual([
      "          ┌───────┐        ┌──────┐                 ┌─────┐",
      "          │ Alice │        │ John │                 │ Bob │",
      "          └───┬───┘        └───┬──┘                 └──┬──┘",
      "              │                │                       │",
      "              │ 1. Hello John  │                       │",
      "              ├───────────────▶│                       │",
      "            ┌─ loop [Every minute] ─┐                  │",
      "            │ │   2. Great!    │    │                  │",
      "            │ │◀┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤    │                  │",
      "            └─┼────────────────┼────┘                  │",
      "            ┌─ alt [is sick] ──┼───────────────────────┼─┐",
      "            │ │           3. Not so good :(            │ │",
      "            │ │◀───────────────┼───────────────────────┤ │",
      "            ├┄ else [is well] ┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┼┄┤",
      "            │ │     4. Feeling fresh like a daisy      │ │",
      "            │ │◀───────────────┼───────────────────────┤ │",
      "            └─┼────────────────┼───────────────────────┼─┘",
      "            ┌─ opt [Extra response] ───────────────────┼─┐",
      "            │ │         5. Thanks for asking           │ │",
      "            │ │◀───────────────┼───────────────────────┤ │",
      "            └─┼────────────────┼───────────────────────┼─┘",
      "              │                │ ┌───────────────────┐ │",
      "              │                │ │ Rational thoughts │ │",
      "              │                │ │     prevail!      │ │",
      "              │                │ └───────────────────┘ │",
      "┌───────────┐ │                │                       │",
      "│ left note │ │                │                       │",
      "└───────────┘ │                │                       │",
      "        ┌──────────┐           │                       │",
      "        │ over one │           │                       │",
      "        └──────────┘           │                       │",
      "           ┌────────────────────┐                      │",
      "           │   spanning note    │                      │",
      "           └────────────────────┘                      │",
      "              │                │                       │",
    ])
  })

  test("par/and with a nested loop, critical/option and break", () => {
    const src = `sequenceDiagram
    participant C as Client
    participant S as Server
    participant D as DB
    par Fetch
      C->>S: GET /a
      loop retries
        S->>D: query
        D-->>S: rows
      end
    and Log
      S-)D: write log
    end
    critical Connect
      S->>D: connect
    option Timeout
      S->>S: retry
    end
    break when done
      S-->>C: 200 OK
    end`
    expect(render(src, 100)).toEqual([
      "┌────────┐   ┌────────┐     ┌────┐",
      "│ Client │   │ Server │     │ DB │",
      "└────┬───┘   └────┬───┘     └──┬─┘",
      "     │            │            │",
      "   ┌─ par [Fetch] ┼────────────┼─────┐",
      "   │ │  GET /a    │            │     │",
      "   │ ├───────────▶│            │     │",
      "   │ │          ┌─ loop [retries] ─┐ │",
      "   │ │          │ │   query    │   │ │",
      "   │ │          │ ├───────────▶│   │ │",
      "   │ │          │ │   rows     │   │ │",
      "   │ │          │ │◀┄┄┄┄┄┄┄┄┄┄┄┤   │ │",
      "   │ │          └─┼────────────┼───┘ │",
      "   ├┄ and [Log] ┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┼┄┄┄┄┄┤",
      "   │ │            │ write log  │     │",
      "   │ │            ├───────────▷│     │",
      "   └─┼────────────┼────────────┼─────┘",
      "     │          ┌─ critical [Connect] ─┐",
      "     │          │ │  connect   │       │",
      "     │          │ ├───────────▶│       │",
      "     │          ├┄ option [Timeout] ┄┄┄┤",
      "     │          │ ├──┐ retry   │       │",
      "     │          │ │◀─┘         │       │",
      "     │          └─┼────────────┼───────┘",
      "   ┌─ break [when done] ─┐     │",
      "   │ │  200 OK    │      │     │",
      "   │ │◀┄┄┄┄┄┄┄┄┄┄┄┤      │     │",
      "   └─┼────────────┼──────┘     │",
      "     │            │            │",
    ])
  })

  test("CJK participants and messages", () => {
    const src = `sequenceDiagram
    participant 用户
    participant 服务器
    用户->>服务器: 登录请求
    服务器-->>用户: 返回令牌`
    expect(render(src, 100)).toEqual([
      "┌──────┐   ┌────────┐",
      "│ 用户 │   │ 服务器 │",
      "└───┬──┘   └────┬───┘",
      "    │           │",
      "    │ 登录请求  │",
      "    ├──────────▶│",
      "    │ 返回令牌  │",
      "    │◀┄┄┄┄┄┄┄┄┄┄┤",
      "    │           │",
    ])
  })
})
