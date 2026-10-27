import { expect, test } from "bun:test"
import type {
  AgentStatusState,
  UiContext,
  UiControl,
  UiNode,
  UiState,
  ViewLine,
  ViewRenderOptions,
} from "@amira/api"
import { observeAgentEvent } from "../src/activity.ts"
import type { JournalEntry, RunRecord } from "../src/journal.ts"
import { type AgentNode, agentsOf, newFlow, phaseOf } from "../src/progress.ts"
import { agentStatusState, statusBadge } from "../src/status.ts"
import {
  agentDetails,
  archivedWorkflow,
  createWorkflowView,
  type WorkflowViewData,
  type WorkflowViewRun,
  workflowRows,
} from "../src/view.ts"

function context(width = 100, focused = true): UiContext {
  return {
    width,
    height: 24,
    now: 5000,
    focused,
    state: { selected: {}, expanded: {}, activeTabs: {}, scroll: {}, inputValues: {} },
  }
}
function agent(call: number, status: AgentNode["status"] = "done"): AgentNode {
  return {
    kind: "agent",
    call,
    label: `agent ${call}`,
    status,
    startedAt: 1000,
    durationMs: 1000,
    cost: 0.01,
  }
}
function fixture() {
  const flow = newFlow("fanout", ["Explore", "Verify"])
  const nested = newFlow("nested", ["Check"])
  phaseOf(flow, "Explore").items.push(agent(1), nested)
  phaseOf(nested, "Check").items.push(agent(2))
  phaseOf(flow, "Verify").items.push(agent(3))
  const record: RunRecord = {
    id: "wf_test",
    meta: { name: "fanout", description: "Three looks", phases: ["Explore", "Verify"] },
    args: null,
    source: "inline",
    status: "done",
    startedAt: 1000,
    endedAt: 3000,
  }
  const run: WorkflowViewRun = {
    ...record,
    record,
    flow,
    logs: [{ level: "info", text: "private workflow log" }],
  }
  let stopped = 0
  let asked = 0
  let rendered = 0
  const focused: string[] = []
  const patches: Partial<UiState>[] = []
  run.stop = () => {
    stopped++
  }
  const view = createWorkflowView(
    () => run,
    async () => {
      asked++
      return true
    },
  )
  const control: UiControl = {
    close() {},
    pushPage() {},
    popPage() {},
    print() {},
    focus(id) {
      focused.push(id)
    },
    setState(patch) {
      patches.push(patch)
    },
    requestRender() {
      rendered++
    },
    prompt: async () => undefined,
    confirm: async () => true,
  }
  const data: WorkflowViewData = {}
  return {
    flow,
    run,
    view,
    control,
    data,
    focused,
    patches,
    stopped: () => stopped,
    asked: () => asked,
    rendered: () => rendered,
  }
}
function lines(node: UiNode): ViewLine[] {
  if (node.type === "text") return node.lines
  if (node.type === "bar")
    return [
      { kind: "segments", parts: [...node.left, { kind: "muted", text: " · " }, ...(node.right ?? [])] },
    ]
  if (node.type === "tree")
    return node.items.flatMap((item) => [
      { kind: "segments" as const, parts: [...(item.node ?? []), ...item.row] },
      ...(Array.isArray(item.detail) ? item.detail : []),
    ])
  if (node.type === "column" || node.type === "row")
    return node.children.flatMap((child) => lines(child.node))
  if (node.type === "box") return lines(node.child)
  return []
}
function lineText(line: ViewLine): string {
  return line.kind === "segments" ? line.parts.map((part) => part.text).join("") : line.text
}
function body(node: UiNode): UiNode {
  if (node.type === "row" && node.children[0]?.node.type === "spacer") node = node.children[1]!.node
  if (node.type !== "column") throw new Error("Expected workflow column")
  return node.children[1]!.node
}
function left(node: UiNode): ViewLine[] {
  const split = body(node)
  if (split.type !== "row" && split.type !== "column") throw new Error("Expected split")
  return lines(split.children[0]!.node)
}

test("line fallback uses ASCII host glyphs for live and archived chrome without changing fixture text", () => {
  const f = fixture()
  const opts: ViewRenderOptions = {
    width: 120,
    now: 5000,
    glyphs: {
      rule: "-",
      separator: "|",
      more: "...",
      treePipe: "|",
      error: "x",
      interrupted: "o",
      statusStopped: "|",
    },
  }
  const render = () =>
    [f.view.title(f.data, opts), ...f.view.header!(f.data, opts), ...f.view.render!(f.data, opts)]
      .map((line) => (typeof line === "string" ? line : lineText(line)))
      .join("\n")
  expect(render()).not.toMatch(/[^\p{ASCII}]/u)
  expect(render()).toContain("Workflow fanout | wf_test | done")
  expect(render()).toContain("agent 1 | agent | v done")
  f.run.readOnly = true
  expect(render()).not.toMatch(/[^\p{ASCII}]/u)
  expect(render()).toContain("Archived run | read-only")
})

for (const [width, expected] of [
  [140, "row"],
  [82, "row"],
  [80, "column"],
  [79, "column"],
  [45, "column"],
] as const) {
  test(`workflow composes ${width}-column screen as ${expected}, with one top summary`, () => {
    const f = fixture()
    const node = f.view.ui!(f.data, context(width))
    expect(body(node).type).toBe(expected)
    const screen = lines(node).map(lineText)
    expect(screen[0]).toContain("done 3")
    expect(screen.filter((line) => line.includes("Workflow fanout ·")).length).toBeLessThanOrEqual(1)
    expect(screen.join("\n")).toContain("agent 1 · agent ·")
    expect(screen.join("\n")).not.toContain("private workflow log")
    const agentRows = left(node)
      .map(lineText)
      .filter((line) => line.includes("agent "))
    expect(agentRows.length).toBeGreaterThan(0)
    for (const row of agentRows) expect(row).not.toMatch(/\$|tok|\ds|role:/i)
  })
}

for (const [width, more, identityVisible] of [
  [55, "[more]", false],
  [57, "[more]", true],
  [82, "[more]".repeat(10), false],
] as const) {
  test(`header at ${width} columns protects metrics when the ${more.length}-cell marker consumes identity room`, () => {
    const f = fixture()
    f.run.meta.name = "长_workflow_identity_".repeat(12)
    f.run.status = "running"
    f.run.endedAt = undefined
    agentsOf(f.flow)[0]!.status = "working"
    const saved = structuredClone({ meta: f.run.meta, flow: f.flow })
    const ctx = {
      ...context(width),
      now: 11000,
      glyphs: {
        rule: "-",
        separator: "::",
        more,
        treePipe: "|",
        error: "x",
        interrupted: "!",
        statusStopped: "|",
      },
    }
    const node = f.view.ui!(f.data, ctx)
    if (node.type !== "row") throw new Error("Expected workflow inset")
    const column = node.children[1]!.node
    if (column.type !== "column") throw new Error("Expected workflow column")
    const header = column.children[0]!.node
    if (header.type !== "column") throw new Error("Expected workflow header")
    const bar = header.children[0]!.node
    if (bar.type !== "bar") throw new Error("Expected semantic header bar")
    const primary = bar.left.map((part) => part.text).join("")
    const counts = bar.right!.map((part) => part.text).join("")
    expect(counts).toBe("working 1 :: done 2")
    expect(primary).toContain("* working :: 10s :: $0.03")
    expect(Bun.stringWidth(primary) + 1 + Bun.stringWidth(counts)).toBeLessThanOrEqual(width - 2)
    expect(primary).toBe(`${identityVisible ? `${more} :: ` : ""}* working :: 10s :: $0.03`)
    const summary = f.view.ui!(f.data, { ...ctx, page: { depth: 1, data: "summary" } })
    expect(lines(summary).map(lineText).join("\n")).toContain(f.run.meta.name)
    expect({ meta: f.run.meta, flow: f.flow }).toEqual(saved)
  })
}

test("Up/Down skips every phase and nested workflow heading, preserving agent selection on resize", () => {
  const f = fixture()
  expect(workflowRows(f.flow).filter((row) => "header" in row)).toHaveLength(4)
  for (const call of [2, 3, 3]) {
    f.view.onEvent!({ type: "select", id: "workflow-agents:wf_test", key: String(call) }, f.data, f.control)
    expect(f.data.selectedCall).toBe(call)
  }
  f.view.onEvent!({ type: "select", id: "workflow-agents:wf_test", key: "2" }, f.data, f.control)
  expect(f.data.selectedCall).toBe(2)
  for (const width of [140, 45]) {
    const screen = lines(f.view.ui!(f.data, context(width))).map(lineText)
    expect(screen.some((line) => line.startsWith("agent 2 · "))).toBe(true)
  }
  expect(f.rendered()).toBe(4)
})

test("long grouped lists have only agent rows in the host navigation index", () => {
  const f = fixture()
  phaseOf(f.flow, "Verify").items.push(...Array.from({ length: 30 }, (_, index) => agent(4 + index)))
  f.view.onEvent!({ type: "select", id: "workflow-agents:wf_test", key: "26" }, f.data, f.control)
  expect(f.data.selectedCall).toBe(26)
  expect(
    left(f.view.ui!(f.data, context(45)))
      .map(lineText)
      .some((line) => line.includes("v done    agent 26")),
  ).toBe(true)
})

test("events and results fold to one semantic row each; Enter expands and folds only the selected agent", () => {
  const f = fixture()
  const first = agentsOf(f.flow)[0]!
  first.events = [
    { ts: 1200, text: "Started read\nwith arguments" },
    { ts: 1300, text: "Finished read" },
  ]
  first.text = "result first line\nresult second line"
  const folded = agentDetails(first, context(45), false)
  expect(folded.filter((line) => line.kind === "segments").map(lineText)).toContain(
    "Result: result first line result second line",
  )
  expect(folded.map(lineText).at(-1)).toBe("Result: result first line result second line")
  expect(folded.map(lineText).indexOf("0s: Started read with arguments")).toBeLessThan(
    folded.map(lineText).indexOf("0s: Finished read"),
  )
  f.view.onEvent!({ type: "activate", id: "workflow-agents:wf_test", key: "1" }, f.data, f.control)
  expect(f.focused).toEqual(["workflow-details:wf_test:1"])
  expect(f.data.expandedCalls).toBeUndefined()
  expect(f.patches).toEqual([])
  f.view.onEvent!({ type: "activate", id: "workflow-details:wf_test:1", key: "1" }, f.data, f.control)
  const expanded = lines(f.view.ui!(f.data, context())).map(lineText)
  expect(expanded).toContain("with arguments")
  expect(expanded.at(-2)).toBe("result second line")
  f.view.onEvent!({ type: "select", id: "workflow-agents:wf_test", key: "2" }, f.data, f.control)
  expect(lines(f.view.ui!(f.data, context())).map(lineText).join("\n")).not.toContain("result second line")
  f.view.onEvent!({ type: "select", id: "workflow-agents:wf_test", key: "1" }, f.data, f.control)
  f.view.onEvent!({ type: "activate", id: "workflow-agents:wf_test", key: "1" }, f.data, f.control)
  expect(f.data.expandedCalls).toEqual([1])
  f.view.onEvent!({ type: "activate", id: "workflow-details:wf_test:1", key: "1" }, f.data, f.control)
  expect(f.data.expandedCalls).toEqual([])
})

test("brackets target panes directly; d remains a silent one-release toggle alias", () => {
  const f = fixture()
  const list = "workflow-agents:wf_test"
  const detail = "workflow-details:wf_test:2"
  expect(f.view.keys!.map((key) => key.key)).toEqual(["[", "]", "d", "?", "x"])
  expect(f.view.keys!.find((key) => key.key === "d")!.label).toBe("")
  f.view.onEvent!({ type: "key", key: "]", focused: list }, f.data, f.control)
  expect(f.focused.at(-1)).toBe("workflow-details:wf_test:1")
  f.view.onEvent!({ type: "select", id: list, key: "2" }, f.data, f.control)
  for (const focused of [list, detail]) {
    f.view.onEvent!({ type: "key", key: "]", focused }, f.data, f.control)
    f.view.onEvent!({ type: "key", key: "[", focused }, f.data, f.control)
  }
  expect(f.focused.slice(-4)).toEqual([detail, list, detail, list])
  f.view.onEvent!({ type: "key", key: "d", focused: list }, f.data, f.control)
  f.view.onEvent!({ type: "key", key: "d", focused: detail }, f.data, f.control)
  expect(f.focused.slice(-2)).toEqual([detail, list])
  expect(f.data.selectedCall).toBe(2)
  expect(f.data.expandedCalls).toBeUndefined()
})

for (const width of [180, 60, 40, 20]) {
  test(`workflow hints at ${width} columns keep complete shared navigation and applicable actions`, () => {
    const f = fixture()
    f.run.status = "running"
    const opts = context(width)
    const hints = () => {
      const root = f.view.ui!(f.data, opts)
      if (root.type !== "row") throw new Error("Expected inset")
      const column = root.children[1]!.node
      if (column.type !== "column") throw new Error("Expected screen")
      return lines(column.children.at(-1)!.node).map(lineText)
    }
    for (const [focused, enter] of [
      ["workflow-agents:wf_test", "enter details"],
      ["workflow-details:wf_test:1", "enter expand"],
    ] as const) {
      opts.state.focused = focused
      const rows = hints()
      for (const hint of ["↑↓ select", "[ ] panes", enter, "? summary", "x stop", "tab input", "esc close"])
        expect(rows.join(" · ")).toContain(hint)
      expect(rows.join(" · ")).not.toMatch(/(^| · )d( panes)?( · |$)/)
      for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width - 2)
      if (width === 180) expect(rows).toHaveLength(1)
      else expect(rows.length).toBeGreaterThan(1)
    }
    f.data.expandedCalls = [1]
    expect(hints().join(" · ")).toContain("enter fold")
    for (const status of ["done", "stopped", "error"] as const) {
      f.run.status = status
      expect(hints().join(" · ")).not.toContain("x stop")
    }
    f.run.status = "running"
    f.run.readOnly = true
    expect(hints().join(" · ")).not.toContain("x stop")
    opts.focused = false
    expect(hints()).toEqual(["tab view · esc close"])
  })
}

for (const [source, expected] of [
  [{ status: "queued" }, "queued"],
  [{ status: "working" }, "working"],
  [{ status: "done" }, "done"],
  [{ status: "cached" }, "done"],
  [{ status: "error" }, "failed"],
  [{ status: "aborted" }, "stopped"],
  [{ status: "done", note: "ended early" }, "stopped"],
  [{ status: "done", note: "" }, "stopped"],
  [{ status: "working", paused: true }, "paused"],
  [{ status: "working", idle: true }, "idle"],
] satisfies [Parameters<typeof agentStatusState>[0], AgentStatusState][]) {
  test(`shared status maps ${JSON.stringify(source)} to ${expected}, with padded host badge and ASCII fallback`, () => {
    expect(agentStatusState(source)).toBe(expected)
    const called: unknown[] = []
    expect(
      statusBadge(source, {
        ...context(),
        statusBadge: (state, options) => {
          called.push(state, options)
          return [{ kind: "text", text: "host" }]
        },
      }),
    ).toEqual([{ kind: "text", text: "host" }])
    expect(called).toEqual([expected, { pad: true }])
    const fallback = statusBadge(source, context())
    expect(fallback.map((part) => part.text).join("")).toMatch(new RegExp(`^[.\u007c*ovx] ${expected} *$`))
    expect(fallback[0]?.kind).toBe(
      (
        {
          queued: "dim",
          working: "accent",
          idle: "muted",
          paused: "warning",
          done: "success",
          failed: "error",
          stopped: "warning",
        } as const
      )[expected],
    )
  })
}

test("counts use shared outcomes and informational worktree notes do not mean stopped", () => {
  const f = fixture()
  const [first, second, third] = agentsOf(f.flow)
  first!.worktreeNote = "Changes merged"
  second!.note = ""
  third!.status = "cached"
  expect(agentStatusState(first!)).toBe("done")
  expect(lines(f.view.ui!(f.data, context())).map(lineText)[0]).toBe(
    "Workflow fanout · v done · 2s · $0.03 · done 2 · stopped 1",
  )
})

test("host input focus dims selection, but keeps the selection marker and state meaning", () => {
  const f = fixture()
  // Focused, the host accents the name and the badge keeps its colour; unfocused, all dims.
  for (const [focused, kind, badge] of [
    [true, "text", "success"],
    [false, "dim", "dim"],
  ] as const) {
    const row = left(f.view.ui!(f.data, context(100, focused))).find((line) =>
      lineText(line).includes("v done    agent 1"),
    )!
    if (row.kind !== "segments") throw new Error("Expected semantic selected row")
    expect(row.parts.at(-1)?.kind).toBe(kind)
    expect(row.parts.slice(0, -1).every((part) => part.kind === badge)).toBe(true)
  }
  expect(f.view.needsTab).toBeUndefined()
  expect(f.view.keys!.map((key) => key.key)).not.toContain("tab")
  expect(f.view.keys!.map((key) => key.key)).not.toContain("/")
  expect(f.view.keys!.map((key) => key.key)).not.toContain("i")
})

test("only active live runs/agents request one-second elapsed redraws", () => {
  const f = fixture()
  const requests: number[] = []
  const opts = { ...context(), requestRefresh: (ms: number) => requests.push(ms) }
  f.view.ui!(f.data, opts)
  expect(requests).toEqual([])
  f.run.status = "running"
  f.run.endedAt = undefined
  f.view.ui!(f.data, opts)
  expect(requests.splice(0)).toEqual([1000])
  f.run.status = "done"
  agentsOf(f.flow)[0]!.status = "working"
  f.view.ui!(f.data, opts)
  expect(requests.splice(0)).toEqual([1000])
  f.run.readOnly = true
  f.view.ui!(f.data, opts)
  expect(requests).toEqual([])
})

test("archived/finished runs omit action hints and refuse x, but live x still asks and stops", async () => {
  const f = fixture()
  f.run.status = "running"
  expect(lines(f.view.ui!(f.data, context())).map(lineText).join("\n")).toContain("x stop")
  f.run.readOnly = true
  expect(lines(f.view.ui!(f.data, context())).map(lineText).join("\n")).not.toContain("x stop")
  expect(f.view.keys!.every((key) => key.label === "")).toBe(true)
  f.view.onEvent!({ type: "key", key: "x" }, f.data, f.control)
  expect(f.asked()).toBe(0)
  f.run.readOnly = false
  f.run.status = "done"
  f.view.onEvent!({ type: "key", key: "x" }, f.data, f.control)
  expect(f.asked()).toBe(0)
  f.run.status = "running"
  f.view.onEvent!({ type: "key", key: "x" }, f.data, f.control)
  await Promise.resolve()
  expect(f.asked()).toBe(1)
  expect(f.stopped()).toBe(1)
})

test("selected-agent activity tracks concurrent tools, excludes descendants and bounds its own event history", () => {
  const node = { ...agent(1, "working"), childId: "child" }
  const start = (sessionId: string, toolCallId: string) =>
    observeAgentEvent(node, {
      seq: 1,
      type: "tool.execute.start",
      sessionId,
      ts: 1200,
      data: { name: "read", toolCallId, args: {} },
    })
  expect(start("descendant", "other")).toBe(false)
  start("child", "one")
  start("child", "two")
  expect(node.currentTools).toHaveLength(2)
  expect(agentDetails(node, context(), false).map(lineText)).toContain("Current tool: read, read")
  observeAgentEvent(node, {
    seq: 1,
    type: "tool.execute.end",
    sessionId: "child",
    ts: 1300,
    data: {
      name: "read",
      toolCallId: "one",
      durationMs: 100,
      result: { content: [{ type: "text", text: "file contents\nnext line" }] },
    },
  })
  expect(node.currentTools).toEqual([{ id: "two", name: "read" }])
  expect(node.lastAction).toBe("read: done · file contents next line")
  for (let i = 0; i < 55; i++) start("child", `extra${i}`)
  expect(node.events).toHaveLength(50)
  expect(node.events!.some((event) => event.text.includes("descendant"))).toBe(false)
})

test("long activity text is retained in full while lastAction and event count remain bounded", () => {
  const node = { ...agent(1, "working"), childId: "child" }
  const full = `${"x".repeat(5000)}\nSENTINEL`
  observeAgentEvent(node, {
    seq: 1,
    type: "tool.execute.end",
    sessionId: "child",
    ts: 1300,
    data: {
      name: "read",
      toolCallId: "one",
      durationMs: 100,
      result: { content: [{ type: "text", text: full }] },
    },
  })
  expect(node.lastAction!.length).toBe(160)
  expect(node.events).toEqual([{ ts: 1300, text: `read: done · ${full}` }])
  expect(agentDetails(node, context(), true).map(lineText)).toContain("SENTINEL")
})

test("archive reconstruction retains the final attempt, nested groups, roles, events and empty early-end notes", () => {
  const f = fixture()
  const archive = archivedWorkflow({ ...f.run.record, resumes: 1 }, [
    { key: "old", attempt: 0, call: 0, label: "old attempt", text: "old", durationMs: 100 },
    {
      key: "one",
      attempt: 1,
      call: 1,
      label: "root",
      text: "root result",
      role: "coder",
      phase: "Explore",
      note: "",
      durationMs: 100,
    },
    {
      key: "nested",
      attempt: 1,
      call: 2,
      label: "nested",
      text: "nested result",
      nest: "child#1",
      nestPath: [{ nest: "child#1", parentPhase: "Explore" }],
      phase: "Check",
      durationMs: 100,
      events: [{ ts: 1500, text: "own event" }],
    },
  ])
  expect(archive.readOnly).toBe(true)
  expect(archive.stop).toBeUndefined()
  const agents = agentsOf(archive.flow)
  expect(agents.map((node) => node.label)).toEqual(["root", "nested"])
  expect(agents[0]!.role).toBe("coder")
  expect(agentStatusState(agents[0]!)).toBe("stopped")
  expect(agents[1]!.events?.[0]?.text).toBe("own event")
  expect(workflowRows(archive.flow).some((row) => "header" in row && row.header === "Workflow child#1")).toBe(
    true,
  )
})

for (const rootAgent of [true, false]) {
  test(`legacy nested parent phases stay explicitly unknown with root agent=${rootAgent}`, () => {
    const entries: JournalEntry[] = rootAgent
      ? [{ key: "root", call: 1, label: "root", phase: "Explore", text: "root", durationMs: 100 }]
      : []
    entries.push({
      key: "nested",
      call: 2,
      label: "nested",
      nest: "child#1",
      phase: "Check",
      text: "child",
      durationMs: 100,
    })
    const archive = archivedWorkflow(fixture().run.record, entries)
    expect(archive.flow.phases.find((phase) => phase.title === "Explore")!.items).toHaveLength(
      rootAgent ? 1 : 0,
    )
    expect(archive.flow.phases.find((phase) => phase.title === "Verify")!.items).toHaveLength(0)
    expect(
      archive.flow.phases.find((phase) => phase.title === "Unknown parent phase")!.items[0],
    ).toMatchObject({ kind: "workflow", name: "child#1" })
  })
}

test("recorded ancestry reconstructs deep nests even when only the deepest flow has an agent", () => {
  const archive = archivedWorkflow(fixture().run.record, [
    {
      key: "deep",
      call: 3,
      label: "deep agent",
      nest: "grandchild#2",
      phase: "Test",
      text: "deep",
      durationMs: 100,
      nestPath: [
        { nest: "child#1", parentPhase: "Verify" },
        { nest: "grandchild#2", parentPhase: "Check" },
      ],
    },
  ])
  expect(workflowRows(archive.flow)).toEqual([
    { header: "Explore", depth: 0 },
    { header: "Verify", depth: 0 },
    { header: "Workflow child#1", depth: 1 },
    { header: "Check", depth: 2 },
    { header: "Workflow grandchild#2", depth: 3 },
    { header: "Test", depth: 4 },
    { agent: agentsOf(archive.flow)[0]!, depth: 5 },
  ])
})

test("recorded unphased nested invocation is distinct from unknown legacy ancestry", () => {
  const archive = archivedWorkflow(fixture().run.record, [
    {
      key: "nested",
      call: 1,
      label: "first",
      nest: "child#1",
      phase: "Check",
      text: "first",
      durationMs: 100,
      nestPath: [{ nest: "child#1" }],
    },
  ])
  expect(archive.flow.phases[0]!.title).toBe("")
  expect(archive.flow.phases[0]!.items[0]).toMatchObject({ kind: "workflow", name: "child#1" })
  expect(archive.flow.phases.some((phase) => phase.title === "Unknown parent phase")).toBe(false)
})

test("an unclosed cold archive is stopped without a working badge or live clock", () => {
  const record = { ...fixture().run.record, status: "running" as const, endedAt: undefined }
  const archive = archivedWorkflow(record, [])
  expect(archive.status).toBe("stopped")
  expect(record.status).toBe("running")
  const states: AgentStatusState[] = []
  const refreshes: number[] = []
  const opts = {
    ...context(),
    statusBadge: (state: AgentStatusState) => {
      states.push(state)
      return [{ kind: "text" as const, text: state }]
    },
    requestRefresh: (ms: number) => refreshes.push(ms),
  }
  createWorkflowView(
    () => archive,
    async () => false,
  ).header!({}, opts)
  expect(states).not.toContain("working")
  expect(states).toContain("stopped")
  expect(refreshes).toEqual([])
})

test("selected summary omits unknown cost rather than adding noise", () => {
  const selected = { ...agent(1), cost: undefined }
  expect(agentDetails(selected, context(), false).map(lineText).join("\n")).not.toContain("cost unknown")
})

test("top and selected summaries delegate every state to the shared badge renderer", () => {
  const f = fixture()
  const states: AgentStatusState[] = []
  const opts = {
    ...context(),
    statusBadge: (state: AgentStatusState) => {
      states.push(state)
      return [{ kind: "text" as const, text: `[${state}]` }]
    },
  }
  const top = lines(f.view.ui!(f.data, opts))[0]!
  expect(top.kind).toBe("segments")
  expect(lineText(top)).toBe("Workflow fanout · [done] · 2s · $0.03 · done 3")
  expect(agentDetails(agentsOf(f.flow)[0], opts, false).map(lineText)).toContain(
    "agent 1 · agent · [done] · 1s · $0.01",
  )
  expect(states.filter((state) => state === "done").length).toBeGreaterThanOrEqual(6)
  expect(f.view.header!(f.data, opts)[0]!.kind).toBe("segments")
})

test("summary counts use plain shared labels before counts and normalize the workflow lifecycle", () => {
  const f = fixture()
  const inputs: Partial<AgentNode>[] = [
    { status: "queued" },
    { status: "working" },
    { status: "working", idle: true },
    { status: "working", paused: true },
    { status: "cached" },
    { status: "error" },
    { status: "aborted" },
  ]
  f.flow.phases = [{ title: "States", items: inputs.map((input, index) => ({ ...agent(index), ...input })) }]
  const states: AgentStatusState[] = []
  const opts = {
    ...context(),
    statusBadge: (state: AgentStatusState) => {
      states.push(state)
      return [{ kind: "text" as const, text: `[${state}]` }]
    },
  }
  for (const [status, expected] of [
    ["running", "working"],
    ["done", "done"],
    ["error", "failed"],
    ["stopped", "stopped"],
  ] as const) {
    f.run.status = status
    states.length = 0
    const top = f.view.header!(f.data, opts)[0]!
    expect(states).toEqual([expected])
    expect(lineText(top)).toContain(`Workflow fanout · [${expected}]`)
    expect(lineText(top)).toStartWith(
      "queued 1 · working 1 · idle 1 · paused 1 · done 1 · failed 1 · stopped 1",
    )
  }
})
