/**
 * Real TUI output from the linked checkout, never imported by extension runtime code.
 * UPDATE_DASHBOARD_README=1 bun test test/tui-render.test.ts refreshes the README captures.
 */
import { describe, expect, mock, test } from "bun:test"
import type { SessionControl } from "@amira/api"
import { agentsOf } from "../src/source.ts"
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
  const closed = mock(() => {})
  const viewer = new tui.ExtensionViewer(dashboardView, fixture.data, {
    now: () => fixture.context().now,
    onClose: closed,
  })
  viewer.mount()
  const ctx = { theme: kit.monoTheme, color: false, rows: height }
  const render = (): string[] => viewer.render(width, ctx).map(kit.stripAnsi)
  const press = (...names: string[]) => {
    for (const name of names) {
      viewer.handleInput(kit.key(name))
      render()
    }
  }
  const first = render()
  return { render, press, fixture, first, closed, viewer }
}

async function capture(size: string, rows: string[]) {
  if (process.env.UPDATE_DASHBOARD_README !== "1") return
  const file = Bun.file(new URL("../README.md", import.meta.url))
  const readme = await file.text()
  const start = `<!-- render:${size} -->`
  const end = `<!-- /render:${size} -->`
  const before = readme.indexOf(start)
  const after = readme.indexOf(end)
  if (before < 0 || after < before) throw new Error(`Missing README capture markers: ${size}`)
  await Bun.write(
    file,
    `${readme.slice(0, before + start.length)}\n\n\`\`\`text\n${rows.map((row) => row.trimEnd()).join("\n")}\n\`\`\`\n\n${readme.slice(after)}`,
  )
}

describe.skipIf(!available)("dashboard in the real TUI viewer", () => {
  for (const [width, height] of [
    [180, 52],
    [80, 24],
  ] as const) {
    test(`${width}x${height}: first frame shows expanded cards without input`, async () => {
      const { first, viewer } = open(width, height)
      const text = first.join("\n")
      expect(text).toContain("◉ Implementation")
      expect(text).toMatch(/09:00:30\s+●\s+└─◉ Checkout workers ×2/)
      expect(text).toContain("╭ ● Payment validation  [TypeScript]")
      expect(text).toContain("╭ Details")
      expect(text).toContain("Esc close")
      expect(text).not.toContain("b back")
      await capture(`${width}x${height}`, first)
      viewer.dispose()
    })

    test(`${width}x${height}: every row fits the terminal on both pages`, () => {
      const { render, press, viewer } = open(width, height)
      for (const keys of [[], ["down", "down"], ["enter"], ["5"], ["escape"]]) {
        press(...keys)
        const rows = render()
        expect(rows.length).toBeLessThanOrEqual(height)
        for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
      }
      viewer.dispose()
    })
  }

  test("custom tabs, transcript and trace navigate through real host pages and restore on Esc", async () => {
    const { render, press, fixture, viewer } = open(80, 24)
    agentsOf(fixture.snapshot)[0]!.sessionId = "child-session"
    fixture.data.session = {
      info: () => ({ id: "root" }),
      subagentMessages: (id: string) => {
        expect(id).toBe("child-session")
        return [{ role: "user", content: [{ type: "text", text: "Child transcript contents" }] }]
      },
      trace: async (id: string) => {
        expect(id).toBe("child-session")
        return [{ type: "trace", v: 1, sessionId: id, startedAt: 0 }]
      },
    } as unknown as SessionControl
    fixture.details.payments!.tabs = [
      { key: "board", label: "Board", render: () => [{ kind: "text", text: "Shared board contents" }] },
      {
        key: "messages",
        label: "Messages",
        render: () => ({
          type: "box",
          child: { type: "text", id: "messages", lines: [{ kind: "text", text: "Member messages" }] },
        }),
      },
    ]
    press("down", "down", "enter", "5", "right")
    expect(render().join("\n")).toContain("Shared board contents")
    press("tab", "right")
    expect(render().join("\n")).toContain("Member messages")
    press("a", "down", "enter")
    await Promise.resolve()
    expect(render().join("\n")).toContain("Child transcript contents")
    expect(render().join("\n")).toContain("Esc back")
    press("escape")
    expect(render().join("\n")).toContain("Open transcript")
    press("down", "enter")
    await Promise.resolve()
    await Promise.resolve()
    expect(render().join("\n")).toContain("First token wait")
    press("escape", "escape")
    expect(render().join("\n")).toContain("Esc close")
    viewer.dispose()
  })

  test("custom widget arrows use retained host agent selection after replacement", () => {
    const { render, press, fixture, viewer } = open(180, 52)
    fixture.details.payments!.tabs = [
      { key: "board", label: "Board", render: () => [{ kind: "text", text: "Retained board" }] },
      { key: "messages", label: "Messages", render: () => [{ kind: "text", text: "Retained messages" }] },
    ]
    press("down", "down")
    viewer.show({ source: fixture.data.source })
    render()
    // Select Board in the tab bar, then focus its text before cycling.
    press("tab", "5", "right", "tab")
    expect(render().join("\n")).toContain("Retained board")
    press("right")
    expect(render().join("\n")).toContain("Retained messages")
    viewer.dispose()
  })

  test("dashboard shortcuts preserve nested source tab selections", () => {
    const { render, press, fixture, viewer } = open(180, 52)
    fixture.details.payments!.tabs = [
      {
        key: "board",
        label: "Board",
        render: () => ({
          type: "tabs",
          id: "inner",
          tabs: [
            {
              key: "first",
              label: "First",
              body: { type: "text", id: "first", lines: [{ kind: "text", text: "First inner body" }] },
            },
            {
              key: "second",
              label: "Second",
              body: { type: "text", id: "second", lines: [{ kind: "text", text: "Second inner body" }] },
            },
          ],
        }),
      },
    ]
    press("down", "down", "enter", "5", "right", "tab", "right")
    expect(render().join("\n")).toContain("Second inner body")
    press("1", "5", "right")
    expect(render().join("\n")).toContain("Second inner body")
    viewer.dispose()
  })

  test("source replacement invalidates a pending session page even after its read completes", async () => {
    const { render, press, fixture, viewer } = open(180, 52)
    let finish!: (records: []) => void
    agentsOf(fixture.snapshot)[0]!.sessionId = "child-session"
    fixture.data.session = {
      info: () => ({ id: "root" }),
      trace: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    } as unknown as SessionControl
    press("down", "down", "enter", "a", "down", "down", "enter")
    expect(render().join("\n")).toContain("Loading")
    viewer.show({ source: { ...fixture.data.source, id: "other" }, session: fixture.data.session })
    expect(render().join("\n")).toContain("Dashboard source or session changed")
    finish([])
    await Promise.resolve()
    await Promise.resolve()
    expect(render().join("\n")).toContain("Dashboard source or session changed")
    expect(render().join("\n")).not.toContain("No trace statistics")
    viewer.dispose()
  })

  test("expand-all mode also expands agents and groups arriving after e", () => {
    const { render, press, fixture, viewer } = open(180, 100)
    press("left", "e")
    fixture.snapshot.phases[0]!.groups.push({
      id: "late",
      name: "Late workers",
      agents: [
        {
          id: "late",
          name: "Late agent",
          task: "Newly arrived task",
          status: "running",
          files: [],
          actions: [],
        },
      ],
    })
    expect(render().join("\n")).toContain("╭ ● Late agent")
    press("left")
    expect(render().join("\n")).not.toContain("╭ ● Late agent")
    press("e")
    expect(render().join("\n")).toContain("╭ ● Late agent")
    viewer.dispose()
  })

  test("Enter pushes an agent page; Esc restores selection, expansion, tabs and scroll before closing", () => {
    const { render, press, closed } = open(180, 52)
    press("down", "down", "left", "3", "end")
    const root = render()
    expect(root.join("\n")).toContain("[Logs]")
    press("enter")
    expect(render().join("\n")).toContain("[Summary]  Diff  Logs  Actions  Stats")
    expect(render().join("\n")).toContain("Esc back")
    press("5")
    expect(render().join("\n")).toContain("First token wait")
    press("escape")
    expect(closed).not.toHaveBeenCalled()
    expect(render()).toEqual(root)
    press("escape")
    expect(closed).toHaveBeenCalledTimes(1)
  })

  test("an opened agent page shows Stats on 5 and prompts cancel before Esc goes back", async () => {
    const { render, press, fixture, viewer, closed } = open(80, 24)
    press("down", "down", "enter", "5")
    const stats = render().join("\n")
    expect(stats).toContain("First token wait")
    expect(stats).toContain("bash  2  25.00s / 12.50s / 15.00s")
    press("r")
    expect(render().join("\n")).toContain("Request changes from Payment validation")
    press("escape")
    await Promise.resolve()
    expect(fixture.act).not.toHaveBeenCalled()
    expect(render().join("\n")).toContain("Esc back")
    expect(closed).not.toHaveBeenCalled()
    press("escape")
    expect(render().join("\n")).toContain("Esc close")
    viewer.dispose()
  })

  test("Stats uses retained host selection after same-kind data replacement and repairs absent tabs", () => {
    const { render, press, fixture, viewer } = open(180, 52)
    press("down", "down")
    viewer.show({ source: fixture.data.source })
    render()
    press("5")
    expect(render().join("\n")).toContain("[Stats]")
    expect(render().join("\n")).toContain("First token wait")
    press("down", "5")
    expect(render().join("\n")).toContain("[Summary]  Diff  Logs  Actions")
    expect(render().join("\n")).not.toContain("[Stats]")
    viewer.dispose()
  })

  test("page shortcuts do not retain an agent target after Esc returns to the timeline", async () => {
    const { render, press, fixture, viewer } = open(180, 52)
    press("down", "down", "enter", "p")
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("payments", "pause", undefined)
    press("escape", "down", "p")
    expect(fixture.act).toHaveBeenCalledTimes(1)
    expect(render().join("\n")).toContain("Resume · Receipt templates")
    press("enter")
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("receipts", "resume", undefined)
    viewer.dispose()
  })
})
