import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import path from "node:path"
import type { SwarmSnapshot } from "../src/swarm.ts"
import { readonlySwarmView, type SwarmViewData, swarmView } from "../src/view.ts"

const packages = path.dirname(realpathSync(path.join(import.meta.dir, "../node_modules/@amira/api")))
const load = async (name: string) => import(name)
const tui = await load(path.join(packages, "tui/src/index.ts"))
const kit = await load(path.join(packages, "tui-kit/src/index.ts"))
const strip = (row: string): string => kit.stripAnsi(row)

function fixture(): SwarmViewData {
  const snapshot: SwarmSnapshot = {
    id: "sw_fixture",
    goal: "Layout fixtures",
    state: "running",
    startedAt: 0,
    members: [
      { name: "grid", role: "coder", status: "working", startedAt: 0, cost: 0.42, turns: 1, messagesSent: 0 },
      {
        name: "motion",
        role: "reviewer",
        status: "ended",
        outcome: "done",
        durationMs: 5000,
        cost: 0.1,
        result: "FIRST\nSECOND",
        turns: 1,
        messagesSent: 0,
      },
    ],
    messages: 0,
    board: [],
    timeline: [],
  }
  return { snapshot: () => snapshot }
}

for (const [width, height] of [
  [120, 32],
  [60, 28],
] as const) {
  test(`host ${width}x${height}: selection, result expansion and read-only hints work`, () => {
    const viewer = new tui.ExtensionViewer(readonlySwarmView, fixture(), { now: () => 10000 })
    viewer.mount()
    const render = (): string[] =>
      viewer.render(width, { theme: kit.monoTheme, color: false, rows: height }).map(strip)
    const first = render()
    for (const row of first) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
    expect(first.length).toBeLessThanOrEqual(height)
    expect(first.join("\n")).not.toContain("stop member")
    expect(first.join("\n")).not.toContain("pause/resume")
    viewer.handleInput(kit.key("down"))
    expect(render().join("\n")).toContain("FIRST SECOND")
    expect(render().some((row) => row.includes("SECOND") && !row.includes("FIRST"))).toBe(false)
    viewer.handleInput(kit.key("enter"))
    render()
    viewer.handleInput(kit.key("enter"))
    expect(render().some((row) => row.includes("SECOND") && !row.includes("FIRST"))).toBe(true)
    viewer.dispose()
  })
}

for (const [width, height] of [
  [120, 32],
  [60, 28],
] as const) {
  test(`host ${width}x${height}: visible counts survive a long identity and full summary is reachable`, () => {
    const data = fixture()
    const s = data.snapshot()!
    s.id = `sw_${"long_identity_".repeat(10)}`
    s.goal = "Every part of this goal remains available in the summary"
    const viewer = new tui.ExtensionViewer(readonlySwarmView, data, { now: () => 10000 })
    viewer.mount()
    const render = (): string[] =>
      viewer.render(width, { theme: kit.monoTheme, color: false, rows: height }).map(strip)
    const rows = render()
    expect(rows[0]).toContain("working 1")
    expect(rows[0]).toContain("done 1")
    expect(rows[0]!.startsWith(width >= 82 ? "  Swarm" : "  ")).toBe(true)
    expect(rows[0]).toContain("10s")
    expect(rows.join("\n")).toContain("? summary")
    expect(rows.join("\n")).toContain("Tab input")
    expect(rows.join("\n")).toContain("Esc close")
    expect(rows.join("\n")).not.toContain("scroll")
    viewer.handleInput(kit.key("?"))
    const full = render().join("\n")
    expect(full.replace(/\s/g, "")).toContain(s.id)
    expect(full).toContain(s.goal)
    expect(full).toContain("$0.52")
    viewer.handleInput(kit.key("escape"))
    expect(render()[0]).toContain("working 1")
    viewer.dispose()
  })
}

test("narrow host keeps all six member-state counts visible before identity or metrics", () => {
  const data = fixture()
  const s = data.snapshot()!
  s.members = [
    { ...s.members[0]!, name: "queued", status: "queued" },
    { ...s.members[0]!, name: "working", status: "working" },
    { ...s.members[0]!, name: "idle", status: "idle" },
    { ...s.members[0]!, name: "paused", status: "paused" },
    { ...s.members[0]!, name: "done", status: "ended", outcome: "done" },
    { ...s.members[0]!, name: "failed", status: "ended", outcome: "error" },
  ]
  const viewer = new tui.ExtensionViewer(readonlySwarmView, data, { now: () => 10000 })
  viewer.mount()
  const rows: string[] = viewer.render(60, { theme: kit.monoTheme, color: false, rows: 28 }).map(strip)
  const header = rows.slice(0, 3).join("\n")
  for (const state of ["queued", "working", "idle", "paused", "done", "failed"])
    expect(header).toContain(`${state} 1`)
  for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(60)
  viewer.dispose()
})

test("default-theme animated badge keeps the entire selected badge/name inverse", () => {
  const viewer = new tui.ExtensionViewer(readonlySwarmView, fixture(), { now: () => 10000 })
  viewer.mount()
  const rows: string[] = viewer.render(120, { theme: kit.defaultTheme, color: true, rows: 32 })
  const selected = rows.find((row) => row.includes("\u001b[7m") && row.includes("grid"))!
  expect(selected).toBeDefined()
  expect(selected.slice(0, selected.indexOf("grid") + 4)).not.toContain("\u001b[0m")
  expect(viewer.animating).toBe(true)
  viewer.dispose()
})

test("narrow live host keeps every action hint visible and badge/name separated", () => {
  const data = fixture()
  data.control = {
    tell: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    stopMember: () => undefined,
    stop: () => {},
  }
  const viewer = new tui.ExtensionViewer(swarmView, data, { now: () => 10000 })
  viewer.mount()
  const rows: string[] = viewer.render(60, { theme: kit.monoTheme, color: false, rows: 28 }).map(strip)
  for (const hint of ["m msg", "p pause/resume", "x member", "s stop", "Tab", "Esc", "?"])
    expect(rows.join("\n")).toContain(hint)
  expect(rows.join("\n")).toContain("working grid")
  expect(rows.join("\n")).not.toContain("Up/Down")
  expect(rows.filter((row) => /m msg|Tab/.test(row))).toHaveLength(1)
  const wide: string[] = viewer.render(120, { theme: kit.monoTheme, color: false, rows: 32 }).map(strip)
  expect(wide.filter((row) => /m message|Tab/.test(row))).toHaveLength(1)
  viewer.handleInput(kit.key("m"))
  const prompt: string[] = viewer.render(60, { theme: kit.monoTheme, color: false, rows: 28 }).map(strip)
  expect(prompt.join("\n")).toContain("Message a member")
  viewer.handleInput(kit.key("escape"))
  data.snapshot()!.state = "ending"
  const ending: string[] = viewer.render(60, { theme: kit.monoTheme, color: false, rows: 28 }).map(strip)
  for (const hint of ["m msg", "p pause/resume", "x member", "s stop"])
    expect(ending.join("\n")).not.toContain(hint)
  viewer.dispose()
})

for (const [width, height] of [
  [120, 32],
  [60, 28],
] as const) {
  test(`host ${width}x${height}: only the active pane has a selection bar and expansions survive navigation`, () => {
    const viewer = new tui.ExtensionViewer(readonlySwarmView, fixture(), { now: () => 10000 })
    viewer.mount()
    const theme = { ...kit.monoTheme, selection: kit.inverse }
    const render = (): string[] => viewer.render(width, { theme, color: true, rows: height })
    const selectedRows = (rows: string[]) => rows.filter((row) => row.includes("\u001b[7m"))
    expect(selectedRows(render())).toHaveLength(1)
    viewer.handleInput(kit.key("down"))
    expect(selectedRows(render()).map(strip).join("\n")).toContain("motion")
    viewer.handleInput(kit.key("enter"))
    expect(selectedRows(render()).map(strip).join("\n")).toContain("Result: FIRST SECOND")
    viewer.handleInput(kit.key("enter"))
    expect(
      render()
        .map(strip)
        .some((row) => row.includes("SECOND") && !row.includes("FIRST")),
    ).toBe(true)
    viewer.handleInput(kit.key("["))
    const inactiveDetails = render()
    expect(selectedRows(inactiveDetails)).toHaveLength(1)
    expect(selectedRows(inactiveDetails).map(strip).join("\n")).toContain("motion")
    expect(inactiveDetails.map(strip).some((row) => row.includes("SECOND") && !row.includes("FIRST"))).toBe(
      true,
    )
    viewer.handleInput(kit.key("]"))
    expect(selectedRows(render()).map(strip).join("\n")).toContain("Result:")
    viewer.focused = false
    expect(selectedRows(render())).toHaveLength(0)
    viewer.focused = true
    expect(selectedRows(render())).toHaveLength(1)
    viewer.dispose()
  })
}

test("host wide details keep role, state, elapsed and known cost in one summary row", () => {
  const viewer = new tui.ExtensionViewer(readonlySwarmView, fixture(), { now: () => 10000 })
  viewer.mount()
  const rows: string[] = viewer.render(120, { theme: kit.monoTheme, color: false, rows: 30 }).map(strip)
  expect(
    rows.some(
      (row) =>
        row.includes("coder") && row.includes("working") && row.includes("10s") && row.includes("$0.42"),
    ),
  ).toBe(true)
  viewer.dispose()
})
