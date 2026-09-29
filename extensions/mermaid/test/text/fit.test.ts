import { describe, expect, test } from "bun:test"
import { renderFlowchart } from "../../src/text/flowchart/index.ts"
import { renderMermaidText } from "../../src/text/index.ts"
import { renderSequence } from "../../src/text/sequence/index.ts"

const widthOf = (lines: string[]) => Math.max(0, ...lines.map((l) => Bun.stringWidth(l)))

const DECISION = `flowchart LR
    A[Start the whole process] --> B{Is everything ok?}
    B -->|Yes, carry on| C[Keep going until the end]
    B -->|No| D[Rethink the approach]
    D --> A
    C --> E((Done))`

const SEQUENCE = `sequenceDiagram
    participant Browser
    participant Server
    participant Database
    Browser->>Server: POST /login with the user's credentials
    Server->>Database: SELECT the user by name
    Database-->>Server: the row
    alt valid password
      Server-->>Browser: 200 OK and a session cookie
    else wrong password
      Server-->>Browser: 401 Unauthorized
    end
    Note over Browser,Server: The session lasts one hour`

describe("fitting the width", () => {
  test("a flowchart at 120, 60, 30 and 12 columns", () => {
    const wide = renderFlowchart(DECISION, 120)!
    expect(wide.compact).toBe(false)
    expect(widthOf(wide.lines)).toBeLessThanOrEqual(120)
    // At 120 the LR layout fits as is: the last two boxes sit side by side on one row.
    expect(wide.lines.some((l) => /Keep going until the end.*Done/.test(l))).toBe(true)
    expect(wide.lines.length).toBeLessThan(12)

    // At 60 labels wrap and / or the layout turns top-down, but it is still a drawing.
    const mid = renderFlowchart(DECISION, 60)!
    expect(mid.compact).toBe(false)
    expect(widthOf(mid.lines)).toBeLessThanOrEqual(60)

    // At 30 the labels wrap narrower and the LR layout turns top-down.
    const narrow = renderFlowchart(DECISION, 30)!
    expect(narrow.compact).toBe(false)
    expect(narrow.lines).toEqual([
      "  ┌───────────┐",
      "  │ Start the │",
      "  │   whole   │",
      "  │  process  │",
      "  └───┬───────┘",
      "      │   ▲",
      "      │   │",
      "      │   └─────┐",
      "      ▼         │",
      " ╱──────────╲   │",
      "╱     Is     ╲  │",
      "< everything >  │",
      "╲    ok?     ╱  │",
      " ╲────┬─────╱   │",
      "      │         │",
      "      │         └──────┐",
      "      ├─────────────┐  │",
      "    Yes,            │  │",
      "  carry on         No  │",
      "      ▼             ▼  │",
      "┌────────────┐  ┌──────┴───┐",
      "│ Keep going │  │ Rethink  │",
      "│ until the  │  │   the    │",
      "│    end     │  │ approach │",
      "└─────┬──────┘  └──────────┘",
      "      │",
      "      ▼",
      "    ╭────╮",
      "   ( Done )",
      "    ╰────╯",
    ])

    // At 20 only the compact list fits.
    const list = renderFlowchart(DECISION, 20)!
    expect(list.compact).toBe(true)
    expect(list.lines).toEqual([
      "[Start the whole",
      " process]",
      "  └──▶ Is everything",
      "      ok?",
      "{Is everything ok?}",
      "  ├── Yes, carry on",
      "  │   ─▶ Keep going",
      "  │   until the end",
      "  └── No ─▶ Rethink",
      "      the approach",
      "[Keep going until",
      " the end]",
      "  └──▶ Done",
      "[Rethink the",
      " approach]",
      "  └──▶ Start the",
      "      whole process",
      "((Done))",
    ])

    const tiny = renderFlowchart(DECISION, 12)!
    expect(tiny.compact).toBe(true)
    expect(widthOf(tiny.lines)).toBeLessThanOrEqual(12)
  })

  test("LR falls back to top-down before the compact list", () => {
    const src = "flowchart LR\n  A[first step] --> B[second step] --> C[third step] --> D[fourth step]"
    const lr = renderFlowchart(src, 100)!
    expect(lr.lines.length).toBe(3)
    const td = renderFlowchart(src, 30)!
    expect(td.compact).toBe(false)
    expect(td.lines.length).toBeGreaterThan(10)
    expect(widthOf(td.lines)).toBeLessThanOrEqual(30)
  })

  test("a sequence diagram at 120, 60, 30 and 12 columns", () => {
    const wide = renderSequence(SEQUENCE, 120)!
    expect(wide.compact).toBe(false)
    expect(widthOf(wide.lines)).toBeLessThanOrEqual(120)

    const mid = renderSequence(SEQUENCE, 60)!
    expect(mid.compact).toBe(false)
    expect(widthOf(mid.lines)).toBeLessThanOrEqual(60)
    // Long message labels wrapped onto several lines.
    expect(mid.lines.length).toBeGreaterThan(wide.lines.length)

    const narrow = renderSequence(SEQUENCE, 30)!
    expect(narrow.compact).toBe(true)
    expect(narrow.lines).toEqual([
      "Browser ─▶ Server: POST /login",
      "  with the user's credentials",
      "Server ─▶ Database: SELECT the",
      "  user by name",
      "Database ┄▶ Server: the row",
      "┌ alt valid password",
      "│ Server ┄▶ Browser: 200 OK",
      "│   and a session cookie",
      "├ else wrong password",
      "│ Server ┄▶ Browser: 401",
      "│   Unauthorized",
      "└",
      "note over Browser,Server: The",
      "  session lasts one hour",
    ])

    const tiny = renderSequence(SEQUENCE, 12)!
    expect(tiny.compact).toBe(true)
    expect(widthOf(tiny.lines)).toBeLessThanOrEqual(12)
  })

  test("CJK text is measured in columns", () => {
    const flow = "flowchart TD\n  A[开始处理用户的请求] --> B{是否已经登录系统}\n  B -->|是的| C[进入首页并显示欢迎信息]\n  B -->|没有| D[跳转到登录页面]"
    const seq = "sequenceDiagram\n  用户->>服务器: 发送登录请求并附带用户名和密码\n  服务器-->>用户: 返回访问令牌"
    for (const src of [flow, seq])
      for (const w of [120, 80, 50, 30, 20, 12]) {
        const out = renderMermaidText(src, w)!
        expect(out).toBeDefined()
        for (const l of out) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(w)
      }
    // The box around a CJK label is as wide as the label's columns.
    const lines = renderMermaidText("flowchart TD\n  A[开始]", 40)!.map((l) => l.text)
    expect(lines).toEqual(["┌──────┐", "│ 开始 │", "└──────┘"])
  })
})

// A small deterministic generator of messy diagrams.
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function randomFlowchart(r: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const words = ["go", "check status", "登录", "retry later please", "ok", "a very long label that wraps around", "数据库连接"]
  const shapes = ["[%]", "(%)", "([%])", "[[%]]", "[(%)]", "((%))", ">%]", "{%}", "{{%}}", "[/%/]", "[\\%\\]", "[/%\\]", "[\\%/]", "(((%)))"]
  const links = ["-->", "---", "-.->", "-.-", "==>", "===", "--o", "--x", "<-->", "~~~", "-->|%|", "-- % -->"]
  const n = 2 + Math.floor(r() * 9)
  const lines = [`flowchart ${pick(["TD", "LR", "BT", "RL"])}`]
  for (let i = 0; i < n; i++) lines.push(`  n${i}${pick(shapes).replace("%", pick(words))}`)
  let open = 0
  for (let i = 0; i < n * 2; i++) {
    if (r() < 0.1 && open < 2) {
      lines.push(`  subgraph s${i} [${pick(words)}]`)
      open++
    }
    lines.push(`  n${Math.floor(r() * n)} ${pick(links).replace("%", pick(words))} n${Math.floor(r() * n)}`)
    if (open && r() < 0.3) {
      lines.push("  end")
      open--
    }
  }
  while (open--) lines.push("  end")
  return lines.join("\n")
}

function randomSequence(r: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const words = ["hi", "check status", "登录", "retry later please", "a very long message that wraps around"]
  const ps = ["Alice", "Bob", "服务器", "C", "Database"].slice(0, 2 + Math.floor(r() * 4))
  const lines = ["sequenceDiagram"]
  if (r() < 0.5) lines.push("  autonumber")
  if (r() < 0.5) lines.push(`  actor ${ps[0]}`)
  lines.push(`  ${ps[0]}->>${ps[1]}: ${pick(words)}`)
  let depth = 0
  for (let i = 0; i < 14; i++) {
    const x = r()
    const a = pick(ps)
    const b = pick(ps)
    if (x < 0.1 && depth < 3) {
      lines.push(`  ${pick(["loop", "alt", "opt", "par", "critical", "break"])} ${pick(words)}`)
      depth++
    } else if (x < 0.15 && depth) lines.push(`  ${pick(["else", "and", "option"])} ${pick(words)}`)
    else if (x < 0.22 && depth) {
      lines.push("  end")
      depth--
    } else if (x < 0.32) lines.push(`  Note ${pick(["left of", "right of", "over"])} ${a}${r() < 0.3 ? `,${b}` : ""}: ${pick(words)}`)
    else lines.push(`  ${a}${pick(["->>", "-->>", "->", "-->", "-x", "--x", "-)", "--)", "<<->>"])}${b}: ${pick(words)}`)
  }
  while (depth--) lines.push("  end")
  return lines.join("\n")
}

describe("property: never wider than the width, never throws", () => {
  const r = rng(20260929)
  const sources = Array.from({ length: 40 }, (_, i) => (i % 2 ? randomSequence(r) : randomFlowchart(r)))
  sources.forEach((src, i) => {
    test(`random diagram #${i}`, () => {
      for (let w = 20; w <= 140; w += 8) {
        const out = renderMermaidText(src, w)
        expect(out).toBeDefined()
        for (const l of out!) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(w)
      }
      for (const w of [1, 2, 5, 8, 11]) {
        const out = renderMermaidText(src, w)
        for (const l of out ?? []) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(w)
      }
    })
  })
})
