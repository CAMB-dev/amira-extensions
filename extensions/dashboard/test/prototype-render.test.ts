/** Compare the approved variant D and the dashboard using equivalent DashboardSource data. */
import { describe, expect, test } from "bun:test"
import { dashboardView } from "../src/view.ts"
import { prototypeFixture } from "./prototype-fixture.ts"

// Host-only test dependencies; runtime modules import only @amira/api and local files.
// biome-ignore lint/suspicious/noExplicitAny: dynamically loaded host is not an extension dependency
const load = async (name: string): Promise<any> => import(name).catch(() => undefined)
const tui = await load("@amira/tui")
const kit = await load("@amira/tui-kit")
const target = (await Bun.file(new URL("./fixtures/dashboard-target-180x52.txt", import.meta.url)).text())
  .split("\n")
  .slice(0, 52)

function structure(line: string): string {
  if (line.includes("workspace:")) return "top bar"
  if (line.includes("≡")) return "details handle"
  if (/Summary.*Diff.*Logs.*Actions/.test(line)) return "tabs"
  if (/[├└]──▶/.test(line)) return "card head"
  if (/\d\d:\d\d:\d\d|--:--:--/.test(line)) return "phase"
  if (line.includes("╭")) return "frame top"
  if (line.includes("╰")) return "frame bottom"
  if (line.includes("─")) return "rule"
  if (/Changed files/.test(line)) return "files heading"
  if (/\+\d+\s+-\d+/.test(line)) return "file"
  if (/done in/.test(line)) return "duration"
  if (/Add worker|\d agents ·/.test(line)) return "box footer"
  if (line.replace(/[│\s]/g, "") === "") return "space"
  return "content"
}

describe.skipIf(!tui || !kit)("approved prototype fidelity", () => {
  test("80x24: selected phase only, compact details, and bounded lines", () => {
    const fixture = prototypeFixture()
    const viewer = new tui.ExtensionViewer(dashboardView, fixture.data, {
      now: () => fixture.now,
      onClose() {},
    })
    viewer.mount()
    try {
      const rows: string[] = viewer
        .render(80, { theme: kit.monoTheme, color: false, rows: 24 })
        .map(kit.stripAnsi)
      expect(rows).toHaveLength(24)
      expect(rows.join("\n")).toContain("├──▶ ⠋ working worker-1")
      expect(rows.join("\n")).not.toContain("▶ ✓ done    planner")
      expect(rows.join("\n")).toContain("[Summary]")
      for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(80)
      expect(rows.map((row) => row.trimEnd())).toMatchSnapshot()
    } finally {
      viewer.dispose()
    }
  })

  test("180x52: equivalent scenario matches the target's timeline line by line", async () => {
    const fixture = prototypeFixture()
    // Match the approved prototype's expansion state; normal live views default to expand-all.
    const view: typeof dashboardView = {
      ...dashboardView,
      onOpen(data, control) {
        dashboardView.onOpen?.(data, control)
        control.setState({
          expanded: { timeline: ["phase:code", "agent:worker-1", "agent:worker-2", "agent:worker-3"] },
        })
      },
    }
    const viewer = new tui.ExtensionViewer(view, fixture.data, { now: () => fixture.now, onClose() {} })
    viewer.mount()
    try {
      const rows: string[] = viewer
        .render(180, { theme: kit.monoTheme, color: false, rows: 52 })
        .map(kit.stripAnsi)
      const sideBySide = rows
        .map((row, index) => `${String(index + 1).padStart(2)} ${row.padEnd(180)} │ ${target[index] ?? ""}`)
        .join("\n")
      if (process.env.DASHBOARD_COMPARE) await Bun.write(process.env.DASHBOARD_COMPARE, sideBySide)
      expect(rows.slice(0, 33).map(structure), sideBySide).toEqual(target.slice(0, 33).map(structure))
      expect(rows.map((row) => row.trimEnd())).toMatchSnapshot()
      expect(rows[8]).toMatch(
        /worker-1.*task-auth-middleware.*TypeScript.*70%.*3 files changed.*Open diff.*Pause.*Request changes/,
      )
      expect(rows.slice(0, 33).filter((row) => row.includes("worker-1"))).toHaveLength(1)
      // The prototype's own input box is gone (D139): the host composer takes input, and the
      // timeline gets its three rows, plus the hidden host key bar's row (hostKeys "none").
      expect(rows[37]).toContain("≡")
      expect(rows[38]).toMatch(/Summary.*Diff.*Logs.*Actions/)
      expect(rows[38]).toContain("worker-1  task-auth-middleware")
      expect(rows[40]).toContain("What this agent is doing")
      expect(rows[40]).toContain("Changed files")
      expect(rows.join("\n")).not.toContain("Press F6")
      expect(rows[0]).not.toContain("│")
      // hostKeys "none": the header names the keys, no host key bar repeats them below.
      expect(rows[0]).toContain("? shortcuts · q quit")
      expect(rows.join("\n")).not.toMatch(/esc close/i)
      for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(180)
    } finally {
      viewer.dispose()
    }
  })
})
