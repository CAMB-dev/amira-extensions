import { expect, test } from "bun:test"
import type { AgentStatusState, UiContext, UiControl, UiNode, UiState, ViewLine } from "@amira/api"
import { memberBadge, memberState } from "../src/status.ts"
import { type MemberView, type SwarmSnapshot, swarmsFromRecords } from "../src/swarm.ts"
import { READONLY_VIEW_KIND, readonlySwarmView, type SwarmViewData, swarmView } from "../src/view.ts"

const member = (name: string, extra: Partial<MemberView> = {}): MemberView => ({
  name,
  role: `${name} role`,
  status: "working",
  turns: 1,
  messagesSent: 0,
  startedAt: 1000,
  cost: 0,
  ...extra,
})
const snapshot = (extra: Partial<SwarmSnapshot> = {}): SwarmSnapshot => ({
  id: "sw1",
  goal: "Compare options",
  state: "running",
  startedAt: 1000,
  members: [member("writer"), member("reviewer", { status: "idle" })],
  board: [],
  timeline: [],
  messages: 0,
  ...extra,
})
const context = (extra: Partial<UiContext> = {}): UiContext => ({
  width: 80,
  height: 24,
  now: 11000,
  focused: true,
  state: { selected: {}, expanded: {}, activeTabs: {}, scroll: {}, inputValues: {} },
  ...extra,
})
function nodes(node: UiNode): UiNode[] {
  if (node.type === "row" || node.type === "column")
    return [node, ...node.children.flatMap((c) => nodes(c.node))]
  if (node.type === "box") return [node, ...nodes(node.child)]
  return [node]
}
const lineText = (line: ViewLine) =>
  line.kind === "segments" ? line.parts.map((p) => p.text).join("") : line.text
const text = (node: UiNode) =>
  nodes(node)
    .flatMap((n) =>
      n.type === "text"
        ? n.lines.map(lineText)
        : n.type === "bar"
          ? [[...n.left, ...(n.right ?? [])].map((p) => p.text).join("")]
          : n.type === "tree"
            ? n.items.map((i) => [...(i.node ?? []), ...i.row].map((p) => p.text).join(""))
            : [],
    )
    .join("\n")
function tree(node: UiNode, id: string) {
  const found = nodes(node).find((n) => n.type === "tree" && n.id === id)
  if (found?.type !== "tree") throw new Error(`Missing tree ${id}`)
  return found
}
const render = (s = snapshot(), ctx = context()) => swarmView.ui!({ snapshot: () => s }, ctx)
const renderDetails = (s: SwarmSnapshot) => {
  const ctx = context()
  ctx.state.focused = `details:${s.members[0]!.name}`
  return render(s, ctx)
}

for (const width of [120, 82, 80, 68, 67, 40, 20]) {
  test(`split view adapts at ${width} columns and member rows contain only badge and name`, () => {
    const node = render(snapshot(), context({ width }))
    const body = nodes(node).find(
      (n) => (n.type === "row" || n.type === "column") && n.children.some((c) => c.node.type === "box"),
    )!
    expect(body.type).toBe(width - 2 >= 80 ? "row" : "column")
    const rows = tree(node, "members").items
    expect(rows.map((i) => [...(i.node ?? []), ...i.row].map((p) => p.text).join(""))).toEqual([
      "* working writer",
      "o idle    reviewer",
    ])
    expect(rows.every((i) => i.detail === undefined && i.children === undefined)).toBe(true)
  })
}

test("host member selection changes the right pane, with a missing selection falling back safely", () => {
  const state = context().state
  state.selected.members = "reviewer"
  state.focused = "details:reviewer"
  const node = render(snapshot(), context({ state }))
  expect(text(node)).toContain("reviewer · reviewer role")
  expect(tree(node, "details:reviewer").items).toHaveLength(1)
  state.selected.members = "removed"
  expect(text(render(snapshot(), context({ state })))).toContain("writer · writer role")
})

test("one top line contains state, elapsed, known zero cost and per-state counts", () => {
  const node = render(snapshot(), context({ width: 120 }))
  const bar = nodes(node).find((n) => n.type === "bar")!
  expect(bar.type).toBe("bar")
  if (bar.type !== "bar") return
  expect(bar.left.map((p) => p.text).join("")).toBe("Swarm sw1 · * working · 10s · $0.00")
  expect(bar.right!.map((p) => p.text).join("")).toBe("working 1 · idle 1")
  expect(text(render(snapshot({ members: [member("a", { cost: undefined })] })))).not.toContain(
    "cost unknown",
  )
})

test("selected member detail shows role, state, elapsed, cost and tool or last action", () => {
  const s = snapshot({
    members: [member("writer", { currentTools: [{ id: "t1", name: "read" }], lastAction: "Started read" })],
  })
  expect(text(render(s))).toContain("writer · writer role · * working · 10s · $0.00\nTool: read")
  s.members[0]!.currentTools = []
  expect(text(render(s))).toContain("Last action: Started read")
})

test("long text is folded in single rows with complete multiline details and own board only", () => {
  const long = `first line\n${"long ".repeat(200)}last line`
  const s = snapshot({
    members: [member("writer", { result: long, lastMessage: long, brief: long })],
    board: [
      { key: "own", by: "writer", at: 1, value: long, writes: 1 },
      { key: "other", by: "reviewer", at: 2, value: "not mine", writes: 1 },
    ],
  })
  const items = tree(renderDetails(s), "details:writer").items
  for (const key of ["brief", "reply", "result", "board:own"]) {
    const item = items.find((i) => i.key === key)!
    expect(item.expandable).toBe(true)
    expect(item.row.map((p) => p.text).join("")).not.toContain("\n")
    expect(Array.isArray(item.detail)).toBe(true)
    expect((item.detail as ViewLine[]).map(lineText).join("\n")).toBe(long)
  }
  expect(items.some((i) => i.key === "board:other")).toBe(false)
})

test("recent events and messages are own-only, bounded and newest last, including broadcasts", () => {
  const s = snapshot({
    members: [member("writer", { events: [{ seq: 1, at: 2000, text: "Started read" }] })],
    timeline: [
      { seq: 1, at: 1000, kind: "message", from: "reviewer", to: "writer", text: "oldest" },
      { seq: 2, at: 3000, kind: "message", from: "user", to: "all", text: "newest" },
      { seq: 3, at: 4000, kind: "message", from: "other", to: "reviewer", text: "unrelated" },
    ],
  })
  expect(tree(renderDetails(s), "details:writer").items.map((i) => i.key)).toEqual([
    "timeline:1",
    "event:1",
    "timeline:2",
  ])
  expect(text(render(s))).not.toContain("unrelated")
  s.members[0]!.events = Array.from({ length: 80 }, (_, i) => ({ seq: i, at: 5000 + i, text: `own ${i}` }))
  const items = tree(renderDetails(s), "details:writer").items
  expect(items).toHaveLength(40)
  expect(items[0]!.key).toBe("event:40")
  expect(items.at(-1)!.key).toBe("event:79")
})

const states: [Partial<MemberView>, AgentStatusState][] = [
  [{ status: "queued" }, "queued"],
  [{ status: "working" }, "working"],
  [{ status: "idle" }, "idle"],
  [{ status: "paused" }, "paused"],
  [{ status: "ended" }, "stopped"],
  [{ status: "ended", error: "Session interrupted" }, "failed"],
  [{ status: "ended", outcome: "done" }, "done"],
  [{ status: "ended", outcome: "done", note: "" }, "stopped"],
  [{ status: "ended", outcome: "done", note: "limit reached" }, "stopped"],
  [{ status: "ended", outcome: "done", stopReason: "" }, "stopped"],
  [{ status: "ended", outcome: "error", note: "" }, "failed"],
  [{ status: "ended", outcome: "aborted" }, "stopped"],
]
for (const [extra, expected] of states) {
  test(`member state ${JSON.stringify(extra)} maps to ${expected} with new, old and absent mapper`, () => {
    const m = member("writer", extra)
    expect(memberState(m)).toBe(expected)
    expect(memberState(m, {})).toBe(expected)
    expect(memberState(m, { agentStatusState: () => "done" })).toBe(expected)
    expect(
      memberState(m, {
        agentStatusState: () => {
          throw new Error("old host")
        },
      }),
    ).toBe(expected)
  })
}

test("interrupted session-back members never infer a successful completion", () => {
  const s = swarmsFromRecords([
    {
      type: "start",
      swarm: "interrupted",
      goal: "Not finished",
      at: 1000,
      members: [{ name: "writer", role: "coder", brief: "Work" }],
    },
  ])[0]!
  expect(memberState(s.members[0]!)).toBe("stopped")
  expect(text(render(s))).toContain("stopped")
  expect(text(render(s))).not.toContain("done")
})

test("mapper receives complete adapted member information, not a bare state", () => {
  const m = member("writer", { status: "ended", outcome: "done", note: "", result: "report" })
  const inputs: unknown[] = []
  expect(
    memberState(m, {
      agentStatusState: (source) => {
        inputs.push(source)
        return "stopped"
      },
    }),
  ).toBe("stopped")
  expect(inputs[1]).toMatchObject({
    name: "writer",
    role: "writer role",
    status: "done",
    note: "",
    result: "report",
    outcome: "done",
  })
})

test("host badge receives padded state and ASCII fallback retains semantic styles", () => {
  const calls: unknown[] = []
  const parts = [{ kind: "accent" as const, text: "custom badge " }]
  expect(
    memberBadge(
      member("writer"),
      context({
        statusBadge: (state, opts) => {
          calls.push([state, opts])
          return parts
        },
      }),
    ),
  ).toBe(parts)
  expect(calls).toEqual([["working", { pad: true }]])
  expect(memberBadge(member("writer", { status: "paused" }), context())).toEqual([
    { kind: "warning", text: "| paused " },
  ])
  expect(memberBadge(member("writer", { status: "ended", outcome: "error" }), context())[0]!.kind).toBe(
    "error",
  )
})

test("input-focused selection is dim but its member and detail stay selected", () => {
  const active = tree(render(), "members").items[0]!
  const inactive = tree(render(snapshot(), context({ focused: false })), "members").items[0]!
  expect([...(active.node ?? []), ...active.row].every((p) => p.kind === "text")).toBe(true)
  expect([...(inactive.node ?? []), ...inactive.row].every((p) => p.kind === "dim")).toBe(true)
  expect(tree(render(), "members").items[1]!.node![0]!.kind).toBe("muted")
  expect(active.gap).toBe(0)
  expect(text(render(snapshot(), context({ focused: false })))).toContain("writer · writer role")
})

test("only actively working snapshots request a one-second elapsed refresh", () => {
  const calls: number[] = []
  const ctx = context({ requestRefresh: (ms) => calls.push(ms) })
  render(snapshot(), ctx)
  expect(calls).toEqual([1000])
  calls.length = 0
  for (const status of ["queued", "idle", "paused", "ended"] as const)
    render(snapshot({ members: [member("writer", { status })] }), ctx)
  render(snapshot({ state: "paused" }), ctx)
  render(snapshot({ state: "ended", endedAt: 5000 }), ctx)
  expect(calls).toEqual([])
})

function uiControl() {
  const focused: string[] = []
  const patches: Partial<UiState>[] = []
  const view: UiControl = {
    close() {},
    pushPage() {},
    popPage() {},
    requestRender() {},
    print() {},
    prompt: async () => undefined,
    confirm: async () => false,
    focus: (id) => {
      focused.push(id)
    },
    setState: (patch) => {
      patches.push(patch)
    },
  }
  return { view, focused, patches }
}

test("brackets focus each pane directly without changing selection or expansion", () => {
  for (const definition of [swarmView, readonlySwarmView]) {
    const data: SwarmViewData = { snapshot: () => snapshot() }
    const { view, focused, patches } = uiControl()
    definition.onEvent!({ type: "key", key: "]" }, data, view)
    expect(focused).toEqual(["details:writer"])
    definition.onEvent!({ type: "select", id: "members", key: "reviewer" }, data, view)
    for (const id of ["members", "details:reviewer"]) {
      definition.onEvent!({ type: "key", key: "]", focused: id }, data, view)
      definition.onEvent!({ type: "key", key: "[", focused: id }, data, view)
    }
    expect(focused.slice(-4)).toEqual(["details:reviewer", "members", "details:reviewer", "members"])
    expect(patches).toEqual([])
  }
})

test("Enter opens selected member details, folds full text and preserves expansion by member", () => {
  const data: SwarmViewData = { snapshot: () => snapshot() }
  const { view, focused, patches } = uiControl()
  swarmView.onEvent!({ type: "select", id: "members", key: "reviewer" }, data, view)
  swarmView.onEvent!({ type: "activate", id: "members", key: "reviewer" }, data, view)
  expect(focused).toEqual(["details:reviewer"])
  expect(patches).toEqual([])
  swarmView.onEvent!({ type: "activate", id: "details:reviewer", key: "result" }, data, view)
  expect(patches.at(-1)).toEqual({ expanded: { "details:reviewer": ["result"] } })
  swarmView.onEvent!({ type: "activate", id: "details:writer", key: "reply" }, data, view)
  swarmView.onEvent!({ type: "activate", id: "details:reviewer", key: "result" }, data, view)
  expect(patches.at(-1)).toEqual({ expanded: { "details:reviewer": [], "details:writer": ["reply"] } })
  swarmView.onEvent!({ type: "key", key: "[" }, data, view)
  swarmView.onEvent!({ type: "key", key: "]" }, data, view)
  expect(focused.slice(-2)).toEqual(["members", "details:reviewer"])
})

for (const width of [180, 60, 40, 20]) {
  test(`swarm hints at ${width} columns keep complete shared navigation and applicable actions`, () => {
    const s = snapshot()
    const data: SwarmViewData = {
      snapshot: () => s,
      control: {
        tell: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        stopMember: () => undefined,
        stop: () => {},
      },
    }
    const ctx = context({ width })
    const hints = (definition = swarmView) => {
      const root = definition.ui!(data, ctx)
      if (root.type !== "row") throw new Error("Expected inset")
      const column = root.children[1]!.node
      if (column.type !== "column") throw new Error("Expected screen")
      const footer = column.children.at(-1)!.node
      if (footer.type !== "text") throw new Error("Expected hints")
      return footer.lines.map(lineText)
    }
    for (const [focused, enter] of [
      ["members", "enter details"],
      ["details:writer", "enter expand"],
    ] as const) {
      ctx.state.focused = focused
      const rows = hints()
      for (const hint of [
        "↑↓ select",
        "[ ] panes",
        enter,
        "? summary",
        "m message/all",
        "p pause/resume",
        "x stop member",
        "s stop",
        "tab input",
        "esc close",
      ])
        expect(rows.join(" · ")).toContain(hint)
      for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width - 2)
      if (width === 180) expect(rows).toHaveLength(1)
      else expect(rows.length).toBeGreaterThan(1)
    }
    ctx.state.selected["details:writer"] = "result"
    ctx.state.expanded["details:writer"] = ["result"]
    expect(hints().join(" · ")).toContain("enter fold")
    for (const state of ["ending", "ended"] as const) {
      s.state = state
      expect(hints().join(" · ")).not.toMatch(/m message|p pause|x stop|s stop/)
    }
    s.state = "running"
    expect(hints(readonlySwarmView).join(" · ")).not.toMatch(/m message|p pause|x stop|s stop/)
    ctx.focused = false
    expect(hints()).toEqual(["tab view · esc close"])
  })
}

test("read-only view has no action keys or hints and leaves Tab and /i to the host", () => {
  expect(readonlySwarmView.kind).toBe(READONLY_VIEW_KIND)
  expect(readonlySwarmView.keys!.map((k) => k.key)).toEqual(["[", "]", "?"])
  expect(readonlySwarmView.hostKeys).toBe("none")
  expect(swarmView.hostKeys).toBe("none")
  for (const key of ["m", "p", "x", "s", "tab", "shift-tab", "i", "/"])
    expect(readonlySwarmView.keys!.some((k) => k.key === key)).toBe(false)
  for (const key of ["tab", "shift-tab", "i", "/"])
    expect(swarmView.keys!.some((k) => k.key === key)).toBe(false)
  const data: SwarmViewData = { snapshot: () => snapshot() }
  const { view, patches, focused } = uiControl()
  for (const key of ["m", "p", "x", "s"]) readonlySwarmView.onEvent!({ type: "key", key }, data, view)
  expect(data.flash).toBeUndefined()
  expect(patches).toEqual([])
  expect(focused).toEqual([])
})

test("live declarative events still deliver message-all, pause/resume and stop-member actions", async () => {
  const calls: string[] = []
  const s = snapshot()
  const data: SwarmViewData = {
    snapshot: () => s,
    control: {
      tell: (name, value) => {
        calls.push(`tell ${name} ${value}`)
        return undefined
      },
      tellAll: (value) => {
        calls.push(`all ${value}`)
        return 2
      },
      pause: (name) => {
        calls.push(`pause ${name ?? "all"}`)
        return undefined
      },
      resume: (name) => {
        calls.push(`resume ${name ?? "all"}`)
        return undefined
      },
      stopMember: (name) => {
        calls.push(`stop ${name}`)
        return undefined
      },
      stop() {},
    },
  }
  const { view } = uiControl()
  const answers = ["all: Check this", "writer", "writer", "writer"]
  view.prompt = async () => answers.shift()
  swarmView.onEvent!({ type: "key", key: "m" }, data, view)
  await Bun.sleep(1)
  swarmView.onEvent!({ type: "key", key: "p" }, data, view)
  await Bun.sleep(1)
  s.members[0]!.status = "paused"
  swarmView.onEvent!({ type: "key", key: "p" }, data, view)
  await Bun.sleep(1)
  swarmView.onEvent!({ type: "key", key: "x" }, data, view)
  await Bun.sleep(1)
  expect(calls).toEqual(["all Check this", "pause writer", "resume writer", "stop writer"])
})

test("gone and empty swarms render without actions or undefined details", () => {
  expect(text(swarmView.ui!({ snapshot: () => undefined }, context()))).toBe("This swarm is gone.")
  expect(text(render(snapshot({ members: [] })))).toContain("No members.")
})
