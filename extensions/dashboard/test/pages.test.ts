import { expect, mock, test } from "bun:test"
import type { Message, SessionControl, TraceRecord, UiNode } from "@amira/api"
import { agentsOf } from "../src/source.ts"
import { dashboardView, performAction } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

function setup() {
  const fixture = viewFixture()
  agentsOf(fixture.snapshot)[0]!.sessionId = "child-session"
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Please check this" }] },
    {
      role: "assistant",
      model: { provider: "test", model: "test" },
      content: [
        { type: "thinking", text: "Checking" },
        { type: "toolCall", id: "call", name: "read", args: { path: "a.ts" } },
        { type: "text", text: "Looks good" },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "File contents" }],
    },
  ]
  const records: TraceRecord[] = [
    { type: "trace", v: 1, sessionId: "child-session", startedAt: 0 },
    {
      type: "model",
      model: "test/test",
      start: 0,
      firstToken: 10,
      end: 30,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
    },
  ]
  const info = { id: "root" }
  const session = {
    info: () => info,
    subagentMessages: mock((_id: string): readonly Message[] | undefined => messages),
    trace: mock(async (_id?: string): Promise<TraceRecord[]> => records),
  }
  fixture.data.session = session as unknown as SessionControl
  const render = () => dashboardView.ui!(fixture.data, fixture.context())
  return { ...fixture, session, info, records, render }
}

function nodes(node: UiNode): UiNode[] {
  const children =
    node.type === "column" || node.type === "row"
      ? node.children.map((child) => child.node)
      : node.type === "box"
        ? [node.child]
        : node.type === "tabs"
          ? node.tabs.map((tab) => tab.body)
          : []
  return [node, ...children.flatMap(nodes)]
}

test("session actions are additive and target sessionId, not the source agent ID", async () => {
  const s = setup()
  expect(JSON.stringify(s.render())).toContain("Open transcript")
  expect(JSON.stringify(s.render())).toContain("Open trace")
  dashboardView.onEvent!({ type: "activate", id: "timeline", key: "agent:payments" }, s.data, s.control)
  const before = structuredClone(s.state)
  await performAction(s.data, s.control, "open-transcript", "payments")
  expect(s.session.subagentMessages).toHaveBeenCalledWith("child-session")
  expect(s.context().page?.depth).toBe(2)
  const body = JSON.stringify(s.render())
  for (const value of ["Please check this", "Checking", "read", "Looks good", "File contents"])
    expect(body).toContain(value)
  expect(s.act).not.toHaveBeenCalled()
  s.control.popPage()
  expect(s.state).toEqual(before)
  expect(s.context().page?.data).toBe("payments")
})

test("old sources without session IDs retain their original actions", async () => {
  const s = setup()
  delete agentsOf(s.snapshot)[0]!.sessionId
  expect(JSON.stringify(s.render())).not.toContain("Open transcript")
  expect(JSON.stringify(s.render())).not.toContain("Open trace")
  await performAction(s.data, s.control, "open-transcript", "payments")
  expect(s.control.pushPage).not.toHaveBeenCalled()
  expect(s.session.subagentMessages).not.toHaveBeenCalled()
  expect(s.data.flash).toContain("No child session")
})

test("trace page reuses Stats with own-session cost, timing and read-only logs", async () => {
  const s = setup()
  await performAction(s.data, s.control, "open-trace", "payments")
  expect(s.session.trace).toHaveBeenCalledWith("child-session")
  const tree = s.render()
  expect(tree.type === "tabs" && tree.tabs.map((tab) => tab.key)).toEqual(["stats", "logs"])
  const body = JSON.stringify(tree)
  expect(body).toContain("First token wait")
  expect(body).toContain("0.01s")
  expect(body).toContain("Payment validation: $0.250")
  expect(body).not.toContain("Receipt templates")
  dashboardView.onEvent!({ type: "key", key: "p", focused: "session-page:stats" }, s.data, s.control)
  expect(s.act).not.toHaveBeenCalled()
})

test("empty transcript and trace show unavailable data, not fabricated statistics", async () => {
  const s = setup()
  s.session.subagentMessages.mockReturnValueOnce(undefined)
  await performAction(s.data, s.control, "open-transcript", "payments")
  expect(JSON.stringify(s.render())).toContain("No transcript messages")
  s.control.popPage()
  s.session.trace.mockResolvedValueOnce([])
  await performAction(s.data, s.control, "open-trace", "payments")
  expect(JSON.stringify(s.render())).toContain("No trace statistics")
  expect(JSON.stringify(s.render())).not.toContain("First token wait")
})

test("trace completion after Esc never pushes a late page", async () => {
  const s = setup()
  let finish!: (records: TraceRecord[]) => void
  s.session.trace.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = performAction(s.data, s.control, "open-trace", "payments")
  expect(JSON.stringify(s.render())).toContain("Loading")
  s.control.popPage()
  await performAction(s.data, s.control, "pause", "payments")
  expect(s.act).toHaveBeenCalledWith("payments", "pause", undefined)
  finish(s.records)
  await pending
  expect(s.control.pushPage).toHaveBeenCalledTimes(1)
  expect(s.context().page).toBeUndefined()
  expect(s.data.busy).not.toBe(true)
})

test("failed or wrong-session trace reads stay on an honest error page", async () => {
  for (const failure of ["reject", "switch", "wrong-id"]) {
    const s = setup()
    s.session.trace.mockImplementationOnce(async () => {
      if (failure === "reject") throw new Error("Disconnected")
      if (failure === "switch") s.info.id = "other"
      return [{ type: "trace", v: 1, sessionId: "wrong-id", startedAt: 0 }]
    })
    await performAction(s.data, s.control, "open-trace", "payments")
    expect(JSON.stringify(s.render())).toContain(
      failure === "switch" ? "Dashboard source or session changed" : "Could not open trace",
    )
    expect(JSON.stringify(s.render())).not.toContain("First token wait")
    expect(s.data.busy).not.toBe(true)
  }
})

test("custom line and nested widget tabs are namespaced, navigable and backward compatible", () => {
  const s = setup()
  s.details.payments!.tabs = [
    { key: "board", label: "Board", render: () => [{ kind: "text", text: "Board contents" }] },
    {
      key: "messages",
      label: "Messages",
      render: () => ({
        type: "box",
        child: {
          type: "column",
          children: [
            { node: { type: "text", id: "summary", lines: [{ kind: "text", text: "Message contents" }] } },
          ],
        },
      }),
    },
    { key: "summary", label: "Invalid override", render: () => [] },
    { key: "board", label: "Duplicate", render: () => [] },
  ]
  dashboardView.onEvent!({ type: "activate", id: "timeline", key: "agent:payments" }, s.data, s.control)
  const tree = s.render()
  const tabs = nodes(tree).find((node) => node.type === "tabs")
  expect(tabs?.type === "tabs" && tabs.tabs.map((tab) => tab.key)).toEqual([
    "summary",
    "diff",
    "logs",
    "actions",
    "stats",
    "board",
    "messages",
  ])
  const ids = nodes(tree).flatMap((node) => ("id" in node && node.id ? [node.id] : []))
  expect(new Set(ids).size).toBe(ids.length)
  const board = JSON.stringify([
    "agent-page",
    "payments",
    JSON.stringify(["source-tab", "board", "body", "payments"]),
  ])
  expect(ids).toContain(board)
  dashboardView.onEvent!({ type: "key", key: "right", focused: board }, s.data, s.control)
  expect(s.state.activeTabs[s.widgetId("detail")]).toBe("messages")
  expect(JSON.stringify(tree)).toContain("Board contents")
  expect(JSON.stringify(tree)).toContain("Message contents")
  expect(JSON.stringify(tree)).not.toContain("Invalid override")
})
