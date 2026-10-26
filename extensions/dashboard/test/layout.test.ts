import { expect, test } from "bun:test"
import { clock, phaseInfo, summary, timeline } from "../src/layout.ts"
import { viewFixture } from "./view-fixture.ts"

test("the timeline clock shows local wall-clock time in a fixed slot", () => {
  expect(clock(new Date(2026, 9, 26, 14, 38, 4).getTime())).toBe("14:38:04")
  expect(clock(new Date(2026, 9, 26, 9, 5, 0).getTime())).toBe("09:05:00")
  expect(clock()).toBe("--:--:--")
})

test("a truncated phase name keeps a gap before its description", () => {
  const fixture = viewFixture()
  const tree = timeline(fixture.data.source, { ...fixture.context(), height: 0 })
  if (tree.type !== "tree") throw new Error("Missing timeline")
  const name = tree.items[0]!.row[0]!.text
  expect(name.endsWith(" ")).toBe(true)
  expect(Bun.stringWidth(name)).toBe(16)
})

test("phase status includes empty groups that still have running or queued work", () => {
  const fixture = viewFixture()
  const phase = fixture.snapshot.phases[0]!
  for (const agent of phase.groups[0]!.agents) agent.status = "done"
  phase.groups.push({ id: "pending", name: "Pending", status: "running", agents: [] })
  expect(phaseInfo(phase, fixture.context().now).status).toBe("running")
  phase.groups[1]!.status = "queued"
  expect(phaseInfo(phase, fixture.context().now).status).toBe("queued")
  phase.status = "failed"
  expect(phaseInfo(phase, fixture.context().now).status).toBe("failed")
})

test("single-group metadata is a fallback, without manufacturing times or step counts", () => {
  const phase = {
    id: "plan",
    name: "Plan",
    groups: [
      {
        id: "planner",
        name: "Planner",
        status: "done" as const,
        startedAt: 0,
        durationMs: 21000,
        stepCount: 3,
        ref: "plan-ref",
        agents: [],
      },
    ],
  }
  expect(phaseInfo(phase, 30000)).toMatchObject({
    status: "done",
    startedAt: 0,
    durationMs: 21000,
    description: "3 steps · 0 agents · 21s",
    ref: "plan-ref",
  })
  expect(phaseInfo({ id: "queued", name: "Queued", groups: [] }, 30000)).toMatchObject({
    startedAt: undefined,
    durationMs: undefined,
    description: "queued",
  })
})

test("empty source explains unregistration instead of suggesting a new task", () => {
  const fixture = viewFixture()
  fixture.snapshot.phases = []
  fixture.snapshot.note = "This dashboard source was unregistered. Reopen /dashboard."
  const rendered = JSON.stringify(timeline(fixture.data.source, fixture.context()))
  expect(rendered).toContain("source was unregistered")
  expect(rendered).not.toContain("No agents yet")
})

test("stage Summary preserves detailed approval and historical evidence without repeating its heading", () => {
  const fixture = viewFixture()
  const agent = fixture.snapshot.phases[0]!.groups[0]!.agents[0]!
  agent.card = {
    kind: "stage",
    label: "Acceptance",
    outcome: "awaiting review",
    detail: "Batch B2",
    costText: "$1.20 reported",
  }
  agent.task = "awaiting review"
  fixture.details.payments!.summary = [
    { kind: "text", text: "awaiting review" },
    { kind: "text", text: "Approved batch B2 [plan current-plan]" },
    { kind: "text", text: "Historical B1 accepted; B2 is not reviewed" },
  ]
  for (const width of [80, 120]) {
    const rendered = JSON.stringify(summary(fixture.data.source, agent, fixture.context(width)))
    expect(rendered).toContain("Approved batch B2 [plan current-plan]")
    expect(rendered).toContain("Historical B1 accepted; B2 is not reviewed")
    expect(rendered.match(/awaiting review/g)).toHaveLength(1)
    expect(rendered.match(/\$1\.20 reported/g)).toHaveLength(1)
  }
})

test("narrow Summary keeps all metadata, notes and warnings reachable by scrolling", () => {
  const fixture = viewFixture()
  const agent = fixture.snapshot.phases[0]!.groups[0]!.agents[0]!
  fixture.details.payments!.notes = [{ kind: "text", text: "Keep this note" }]
  fixture.snapshot.warning = "Earlier files may be missing."
  const rendered = JSON.stringify(summary(fixture.data.source, agent, fixture.context(80)))
  for (const value of [
    "Keep this note",
    "Earlier files may be missing.",
    "TypeScript",
    "09:00:30",
    "$0.125",
    "src/payments.ts",
  ])
    expect(rendered).toContain(value)
  expect(rendered).not.toContain("Own reported usage")
})
