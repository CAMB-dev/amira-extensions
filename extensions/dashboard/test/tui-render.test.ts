/**
 * Renders the dashboard through the real TUI ExtensionViewer, as plain text. It runs only when
 * the linked Amira checkout provides @amira/tui and @amira/tui-kit (`bun run link-amira <checkout>`
 * links them when present); otherwise the tests are skipped. Extension runtime code never imports them.
 */
import { describe, expect, test } from "bun:test"
import { dashboardView } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

// Module names in variables keep the type checker out of the host's sources.
// biome-ignore lint/suspicious/noExplicitAny: the host modules are loaded dynamically and untyped
const load = async (name: string): Promise<any> => import(name).catch(() => undefined)
const tui = await load("@amira/tui")
const kit = await load("@amira/tui-kit")
const available = Boolean(tui && kit)

function open(width: number, height: number) {
  const fixture = viewFixture()
  const viewer = new tui.ExtensionViewer(dashboardView, fixture.data, { now: () => fixture.context().now })
  const ctx = { theme: kit.monoTheme, color: false, rows: height }
  const render = (): string[] => viewer.render(width, ctx).map(kit.stripAnsi)
  const press = (...names: string[]) => {
    for (const name of names) viewer.handleInput(kit.key(name))
  }
  render()
  return { render, press, fixture }
}

describe.skipIf(!available)("dashboard in the real TUI viewer", () => {
  for (const [width, height] of [
    [180, 52],
    [80, 24],
  ] as const) {
    test(`${width}x${height}: every row fits the terminal`, () => {
      const { render, press } = open(width, height)
      for (const keys of [[], ["e"], ["e", "down", "down"], ["e", "down", "down", "enter"]]) {
        press(...keys)
        const rows = render()
        expect(rows.length).toBeLessThanOrEqual(height)
        for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    })
  }

  test("180x52 expanded timeline matches the mockup: top bar, time column, nodes, cards, details", () => {
    const { render, press } = open(180, 52)
    press("e")
    const text = render().join("\n")
    expect(text).toContain("amira · acme/checkout")
    expect(text).toContain("1/3 running")
    expect(text).toMatch(/09:00:30\s+●\s+└─◉ Checkout workers ×2/)
    expect(text).toContain("◉ Implementation")
    expect(text).toMatch(/─{20}/) // underlines after phase and group rows
    expect(text).toContain("╭ ● Payment validation  [TypeScript]")
    expect(text).toMatch(/━+─+ 60%/)
    expect(text).toContain("o Open diff · p Pause · r Request changes · x Stop · a ⋮ Actions")
    expect(text).toContain("╭ Details")
  })

  test("an opened agent page shows the detail tabs and the Stats tab on 5", () => {
    const { render, press } = open(80, 24)
    press("e", "down", "down", "enter")
    expect(render().join("\n")).toContain("[Summary]  Diff  Logs  Actions  Stats")
    press("5")
    const stats = render().join("\n")
    expect(stats).toContain("First token wait")
    expect(stats).toContain("bash  2  25.00s / 12.50s / 15.00s")
  })
})
