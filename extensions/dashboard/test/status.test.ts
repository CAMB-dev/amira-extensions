import { expect, mock, test } from "bun:test"
import * as amira from "@amira/api"
import { phaseInfo, summary, timeline } from "../src/layout.ts"
import { agentsOf } from "../src/source.ts"
import { dashboardStatus, displayState, staticStatusBadge, statusBadge, statusMark } from "../src/status.ts"
import { traceLogLines } from "../src/trace.ts"
import { dashboardView } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

const states = Object.keys(amira.AGENT_STATUS_BADGES) as amira.AgentStatusState[]

for (const state of states) {
  test(`${state}: shared host helper receives the mapped state and padded option`, () => {
    const parts: amira.ViewSegment[] = [{ kind: "warning", text: `host ${state}` }]
    const helper = mock(() => parts)
    const source = { status: state === "working" ? ("running" as const) : state }
    expect(statusBadge(source, { statusBadge: helper })).toBe(parts)
    expect(helper).toHaveBeenCalledWith(state, { pad: true })
    expect(displayState(source)).toBe(state)
    expect(dashboardStatus(source)).toBe(state === "working" ? "running" : state)
  })

  test(`${state}: helper-less and export-less hosts use the shared static ASCII vocabulary`, () => {
    const badge = amira.AGENT_STATUS_BADGES[state]
    const expected = [{ kind: badge.role, text: `${badge.ascii} ${badge.label.padEnd(7)}` }]
    expect(statusBadge(state)).toEqual(expected)
    expect(statusBadge(state, {}, {})).toEqual(expected)
    expect(statusBadge(state, {}, { AGENT_STATUS_BADGES: amira.AGENT_STATUS_BADGES })).toEqual(expected)
    expect(staticStatusBadge(state)).toEqual(expected)
    expect(staticStatusBadge(state, {})).toEqual(expected)
  })
}

test("whole lifecycle info preserves defined notes, pauses and terminal outcomes on every host", () => {
  // Emulate both string-only mappers that throw and old mappers that silently ignore objects.
  const oldMappers = [
    {},
    {
      agentStatusState: ((value: string) => {
        if (typeof value !== "string") throw new Error("Expected a string")
        return value === "running" ? "working" : value
      }) as typeof amira.agentStatusState,
    },
    { agentStatusState: ((value: unknown) => value) as typeof amira.agentStatusState },
    amira,
  ]
  for (const api of oldMappers) {
    expect(displayState({ status: "done" }, api)).toBe("done")
    for (const note of ["", "Ended early"])
      expect(displayState({ status: "done", note }, api)).toBe("stopped")
    expect(displayState({ status: "running", paused: true }, api)).toBe("paused")
    expect(displayState({ status: "working", paused: true }, api)).toBe("paused")
    expect(displayState({ status: "error", paused: true }, api)).toBe("failed")
    expect(displayState({ end: { status: "done", note: "" } }, api)).toBe("stopped")
    expect(displayState({ startedAt: 0, paused: true }, api)).toBe("paused")
    expect(displayState("aborted", api)).toBe("stopped")
  }
})

test("phase aggregation, card, Summary and steps use shared status semantics without changing controls", () => {
  const fixture = viewFixture()
  const phase = fixture.snapshot.phases[0]!
  const agent = agentsOf(fixture.snapshot)[0]!
  Object.assign(agent, { status: "done", note: "" })
  phase.groups[0]!.agents.splice(1)
  fixture.details.payments!.steps = [
    { status: "done", text: "Finished step" },
    { status: "running", text: "Current step" },
    { status: "queued", text: "Future step" },
  ]
  const helper = mock((state: amira.AgentStatusState): amira.ViewSegment[] => [
    { kind: "warning", text: `@ ${state.padEnd(7)}` },
  ])
  const ctx = { ...fixture.context(), height: 0, statusBadge: helper }
  expect(phaseInfo(phase, ctx.now).status).toBe("stopped")
  const tree = timeline(fixture.data.source, ctx)
  if (tree.type !== "tree") throw new Error("Missing timeline")
  expect(tree.items[1]!.row).toContainEqual({ kind: "warning", text: "@ stopped" })
  expect(tree.items[1]!.aside?.map((part) => part.text).join("")).toContain("Open diff")
  const rendered = JSON.stringify(summary(fixture.data.source, agent, ctx))
  for (const state of ["stopped", "done", "working", "queued"]) expect(rendered).toContain(state)
  expect(rendered).not.toContain("✓")
  expect(agent.status).toBe("done")
  expect(statusMark(agent, ctx)).toEqual([{ kind: "warning", text: "@" }])
})

test("only visible elapsed content requests a one-second refresh; badges own spinner cadence", () => {
  const fixture = viewFixture()
  const refresh = mock(() => {})
  const helper = mock((state: amira.AgentStatusState): amira.ViewSegment[] => [{ kind: "text", text: state }])
  const ctx = { ...fixture.context(), requestRefresh: refresh, statusBadge: helper }
  statusBadge("working", ctx)
  expect(refresh).not.toHaveBeenCalled()
  dashboardView.ui!(fixture.data, ctx)
  expect(refresh).toHaveBeenCalledWith(1000)
  refresh.mockClear()
  // Agent page: the timeline is absent, and a static tab must not build an animated Summary.
  ctx.page = { depth: 1, data: "payments" }
  const id = JSON.stringify(["agent-page", "payments", "detail"])
  ctx.state.activeTabs[id] = "logs"
  helper.mockClear()
  dashboardView.ui!(fixture.data, ctx)
  expect(refresh).not.toHaveBeenCalled()
  expect(helper).not.toHaveBeenCalled()
  ctx.state.activeTabs[id] = "summary"
  dashboardView.ui!(fixture.data, ctx)
  expect(refresh).toHaveBeenCalledWith(1000)
  refresh.mockClear()
  for (const agent of agentsOf(fixture.snapshot)) {
    agent.status = "done"
    agent.durationMs = 1000
  }
  dashboardView.ui!(fixture.data, { ...ctx, page: undefined })
  expect(refresh).not.toHaveBeenCalled()
})

test("trace status and subagent rows use shared unpadded static badges, including early-end notes", () => {
  expect(traceLogLines({ type: "status", at: 0, status: "blocked" })).toEqual([
    { kind: "segments", parts: staticStatusBadge("paused", undefined, false) },
  ])
  const record = {
    type: "subagent" as const,
    childSessionId: "child",
    start: 0,
    end: 10,
    durationMs: 10,
    status: "done",
    note: "",
  }
  expect(JSON.stringify(traceLogLines(record))).toContain("| stopped")
  expect(traceLogLines(record)[0]).toMatchObject({
    kind: "segments",
    parts: expect.arrayContaining(staticStatusBadge("stopped", undefined, false)),
  })
  expect(
    traceLogLines({ type: "turn", turnId: "turn", start: 0, end: 10, reason: "error", steps: 1 })[0],
  ).toMatchObject({
    kind: "segments",
    parts: expect.arrayContaining(staticStatusBadge("failed", undefined, false)),
  })
})

test("compatible mappers receive the complete original agent, not only its status string", () => {
  const source = { status: "done" as const, note: "", id: "original" }
  const mapper = mock(amira.agentStatusState)
  expect(displayState(source, { agentStatusState: mapper })).toBe("stopped")
  expect(mapper.mock.calls.at(-1)?.[0]).toBe(source)
})

test("a table from before paused was added falls back per state", () => {
  const table = {
    ...amira.AGENT_STATUS_BADGES,
    paused: undefined,
  } as unknown as typeof amira.AGENT_STATUS_BADGES
  expect(statusBadge("paused", {}, { AGENT_STATUS_BADGES: table })).toEqual([
    { kind: "warning", text: "| paused " },
  ])
})

test("paused and idle Summary runtimes stay idle, as do fixed durations and undated work", () => {
  const fixture = viewFixture()
  const agent = agentsOf(fixture.snapshot)[0]!
  const refresh = mock(() => {})
  const ctx = { ...fixture.context(), requestRefresh: refresh }
  for (const status of ["paused", "idle"] as const) {
    agent.status = status
    summary(fixture.data.source, agent, ctx)
    expect(refresh).not.toHaveBeenCalled()
    refresh.mockClear()
  }
  agent.durationMs = 1000
  summary(fixture.data.source, agent, ctx)
  expect(refresh).not.toHaveBeenCalled()
  agent.durationMs = undefined
  agent.startedAt = undefined
  agent.status = "running"
  summary(fixture.data.source, agent, ctx)
  expect(refresh).not.toHaveBeenCalled()
})

test("whole-info pause agrees across badges, totals, Actions and the p shortcut", async () => {
  const fixture = viewFixture()
  const agent = agentsOf(fixture.snapshot)[0]!
  agent.status = "running"
  agent.paused = true
  agent.actions = ["resume", "stop"]
  dashboardView.onEvent!({ type: "key", key: "p" }, fixture.data, fixture.control)
  const rendered = JSON.stringify(dashboardView.ui!(fixture.data, fixture.context()))
  expect(rendered).toContain("running: 0/3")
  expect(rendered).toContain("Resume")
  expect(rendered).not.toContain('"text":"Pause"')
  dashboardView.onEvent!(
    { type: "activate", id: "actions", key: JSON.stringify([agent.id, "resume"]) },
    fixture.data,
    fixture.control,
  )
  await Promise.resolve()
  expect(fixture.act).toHaveBeenCalledWith(agent.id, "resume", undefined)
  expect(agent.status).toBe("running")

  // The same shortcut on an opened agent page performs the available Resume action directly.
  dashboardView.onEvent!(
    { type: "activate", id: "timeline", key: `agent:${agent.id}` },
    fixture.data,
    fixture.control,
  )
  dashboardView.ui!(fixture.data, fixture.context())
  dashboardView.onEvent!(
    { type: "key", key: "p", focused: fixture.state.focused },
    fixture.data,
    fixture.control,
  )
  await Promise.resolve()
  expect(fixture.act.mock.calls.filter((call) => call[1] === "resume")).toHaveLength(2)
})
