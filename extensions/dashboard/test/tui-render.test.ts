/**
 * Real TUI output from the linked checkout, never imported by extension runtime code.
 * UPDATE_DASHBOARD_README=1 bun test test/tui-render.test.ts refreshes the README captures.
 */
import { describe, expect, mock, test } from "bun:test"
import { AGENT_STATUS_BADGES, type AgentStatusState, type SessionControl, type TraceRecord } from "@amira/api"
import { agentsOf } from "../src/source.ts"
import { createTraceSource } from "../src/trace.ts"
import { dashboardView } from "../src/view.ts"
import { projectFixture } from "./project-fixture.ts"
import { viewFixture } from "./view-fixture.ts"

// Module names in variables keep the type checker out of the host's sources.
// biome-ignore lint/suspicious/noExplicitAny: the host modules are loaded dynamically and untyped
const load = async (name: string): Promise<any> => import(name).catch(() => undefined)
const tui = await load("@amira/tui")
const kit = await load("@amira/tui-kit")
const hostGlyphs = tui
  ? await load(new URL("./glyphs.ts", import.meta.resolve("@amira/tui")).href)
  : undefined
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
    test(`${width}x${height}: first frame shows a shared phase box and selected details without input`, async () => {
      const { first, viewer } = open(width, height)
      const text = first.join("\n")
      expect(text).toContain(width === 180 ? "⠋ Implementation" : "⠋ Implementatio")
      expect(text).toMatch(/09:00:30\s+⠋\s+⠋ Implementatio/)
      expect(text).toContain("├──▶ ⠋ working Payment")
      if (width === 180) expect(text).toMatch(/[▏[]TypeScript[▕\]]/)
      expect(text).toContain("≡")
      expect(text).toContain("[Summary]")
      expect(text).not.toContain("Checkout run ─")
      expect(text).toMatch(/esc close/i)
      expect(text).not.toContain("b back")
      await capture(`${width}x${height}`, first)
      viewer.dispose()
    })

    test(`${width}x${height}: every row fits the terminal on both pages`, () => {
      const { render, press, viewer } = open(width, height)
      for (const keys of [[], ["down"], ["enter"], ["5"], ["escape"]]) {
        press(...keys)
        const rows = render()
        expect(rows.length).toBeLessThanOrEqual(height)
        for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
      }
      viewer.dispose()
    })
  }

  test("audit: Tab stays in widgets and the host advertises F6 for input", () => {
    let focused: string | undefined
    const fixture = viewFixture()
    const viewer = new tui.ExtensionViewer(
      {
        ...dashboardView,
        ui(data: typeof fixture.data, ctx: ReturnType<typeof fixture.context>) {
          focused = ctx.state.focused
          return dashboardView.ui!(data, ctx)
        },
      },
      fixture.data,
    )
    const render = () => viewer.render(180, { theme: kit.monoTheme, color: false, rows: 52 })
    viewer.mount()
    render()
    try {
      expect(viewer.needsTab).toBe(true)
      const before = focused
      viewer.handleInput(kit.key("tab"))
      render()
      expect(focused).not.toBe(before)
      viewer.handleInput(kit.key("tab", { shift: true }))
      render()
      expect(focused).toBe(before)
      expect(viewer.focusHint(kit.monoTheme, 180)).toContain("f6 → input")
    } finally {
      viewer.dispose()
    }
  })

  test("audit: zero agents show an actionable empty state, not queued or a selection prompt", () => {
    const fixture = viewFixture()
    fixture.snapshot.phases = []
    delete fixture.snapshot.note
    fixture.snapshot.warning = "Older activity may be omitted."
    const viewer = new tui.ExtensionViewer(dashboardView, fixture.data)
    viewer.mount()
    try {
      const rows = viewer
        .render(120, { theme: kit.monoTheme, color: false, rows: 36 })
        .map(kit.stripAnsi)
        .join("\n")
      expect(rows).toContain("No agents yet.")
      expect(rows).toContain("ask Amira to delegate a task")
      expect(rows).not.toContain("queued")
      expect(rows).not.toContain("Select an agent")
    } finally {
      viewer.dispose()
    }
  })

  async function openTrace(records: TraceRecord[]) {
    const session = {
      info: () => ({ id: "root", title: "Root task", cwd: "/project", busy: false }),
      subagents: () => [],
      trace: async (id: string) => (id === "root" ? records : []),
    } as unknown as SessionControl
    const source = await createTraceSource(session)
    const viewer = new tui.ExtensionViewer(dashboardView, { source }, { now: () => 1000 })
    viewer.mount()
    const render = (): string[] =>
      viewer.render(60, { theme: kit.monoTheme, color: false, rows: 18 }).map(kit.stripAnsi)
    const press = (...names: string[]) => {
      for (const name of names) {
        viewer.handleInput(kit.key(name))
        render()
      }
    }
    render()
    press("enter", "3", "tab", "home")
    return { viewer, render, press }
  }

  for (const kind of ["subagent", "turn", "status"] as const) {
    test(`60 columns: ${kind} diagnostics remain fully reachable by scrolling Logs`, async () => {
      const title = "A very long historical agent or turn title ".repeat(4)
      const diagnostic = Array.from({ length: 100 }, (_, index) => `detail${index}`).join(" ")
      const record: TraceRecord =
        kind === "subagent"
          ? {
              type: "subagent",
              childSessionId: "child",
              title,
              start: 0,
              end: 10,
              durationMs: 10,
              status: "error",
              error: diagnostic,
            }
          : kind === "turn"
            ? {
                type: "turn",
                turnId: title,
                start: 0,
                end: 10,
                reason: "error",
                steps: 1,
                failure: { kind: "provider", message: diagnostic },
              }
            : { type: "status", at: 10, status: "idle", reason: diagnostic }
      const { viewer, render, press } = await openTrace([
        { type: "trace", v: 1, sessionId: "root", startedAt: 0 },
        record,
        { type: "status", at: 20, status: "idle" },
      ])
      try {
        const first = render().join("\n")
        expect(first).toContain("[Logs]")
        const frames = [first]
        for (let index = 0; index < 40; index++) {
          press("down")
          frames.push(render().join("\n"))
        }
        const visible = frames.join("\n")
        for (const word of diagnostic.split(" ")) expect(visible).toContain(word)
        expect(first).not.toContain("detail99")
        expect(frames.at(-1)).toContain("detail99")
        expect(visible).toContain("idle")
      } finally {
        viewer.dispose()
      }
    })
  }

  test("completed trace Logs do not animate a historical working transition", async () => {
    const { viewer, render } = await openTrace([
      { type: "trace", v: 1, sessionId: "root", startedAt: 0 },
      { type: "status", at: 1, status: "working" },
      { type: "status", at: 10, status: "idle" },
    ])
    try {
      expect(render().join("\n")).toContain("working")
      expect(viewer.animating).toBe(false)
      expect(viewer.refreshIntervalMs ?? 0).toBe(0)
    } finally {
      viewer.dispose()
    }
  })

  test("opened child trace Logs stay static while the underlying live dashboard is working", async () => {
    const { render, press, fixture, viewer } = open(80, 24)
    try {
      expect(viewer.animating).toBe(true)
      agentsOf(fixture.snapshot)[0]!.sessionId = "child-session"
      fixture.data.session = {
        info: () => ({ id: "root" }),
        subagents: () => [{ id: "child-session" }],
        trace: async () => [
          { type: "trace", v: 1, sessionId: "child-session", startedAt: 0 },
          { type: "status", at: 1, status: "working" },
          { type: "status", at: 10, status: "idle" },
        ],
      } as unknown as SessionControl
      press("enter", "a", "down", "down", "enter")
      await Promise.resolve()
      await Promise.resolve()
      render()
      press("right")
      expect(render().join("\n")).toContain("* working")
      expect(viewer.animating).toBe(false)
      expect(viewer.refreshIntervalMs ?? 0).toBe(0)
      press("escape", "escape")
      expect(viewer.animating).toBe(true)
    } finally {
      viewer.dispose()
    }
  })

  test("new workers expand without e, and a folded last card keeps a closed frame and count", () => {
    const { render, press, fixture, viewer } = open(180, 100)
    press("down", "left")
    expect(render().join("\n")).toMatch(/╰.*Receipt.*2 agents · 1 running.*╯/)
    press("right")
    fixture.snapshot.phases[0]!.groups[0]!.agents.push({
      id: "new-worker",
      name: "New worker",
      task: "New worker summary",
      status: "running",
      files: [],
      actions: [],
    })
    const rows = render().join("\n")
    expect(rows).toContain("├──▶ ⠋ working New worker")
    expect(rows).toContain("New worker summary")
    expect(rows).toContain("3 agents · 2 running")
    expect(rows).toContain("e expand all")
    viewer.dispose()
  })

  test.skipIf(!hostGlyphs)("badges honor the host's ASCII theme and custom glyphs", () => {
    const before = { ...hostGlyphs.glyphs }
    let viewer: ReturnType<typeof open>["viewer"]
    try {
      hostGlyphs.setGlyphs({ pointer: ">" })
      const fixture = open(180, 52)
      viewer = fixture.viewer
      const agent = agentsOf(fixture.fixture.snapshot)[0]!
      for (const state of Object.keys(AGENT_STATUS_BADGES) as AgentStatusState[]) {
        agent.status = state === "working" ? "running" : state
        const rows = fixture.render().join("\n")
        const symbol = state === "working" ? "|" : AGENT_STATUS_BADGES[state].ascii
        expect(rows).toContain(`${symbol} ${state}`)
      }
      hostGlyphs.setGlyphs({ pointer: ">", statusPaused: "P", statusStopped: "S" })
      agent.status = "paused"
      expect(fixture.render().join("\n")).toContain("P paused")
      agent.status = "done"
      agent.note = ""
      expect(fixture.render().join("\n")).toContain("S stopped")
    } finally {
      viewer?.dispose()
      hostGlyphs.setGlyphs(before)
    }
  })

  test("narrow shortcut help exposes actions omitted from compact card headers", () => {
    const { render, press, viewer } = open(80, 24)
    press("?")
    const rows = render().join("\n")
    for (const hint of ["e expand all", "p pause/resume", "r request changes", "x stop", "5 stats"])
      expect(rows).toContain(hint)
    viewer.dispose()
  })

  test("narrow Summary retains notes and metadata in its scrollable body", () => {
    const { render, press, fixture, viewer } = open(80, 24)
    fixture.details.payments!.notes = [{ kind: "text", text: "A durable agent note" }]
    fixture.snapshot.warning = "Some older files may be omitted."
    press("enter", "tab", "end")
    const rows = render().join("\n")
    expect(rows).toContain("A durable agent note")
    expect(rows).toContain("Some older files may be omitted.")
    expect(rows).toContain("$0.125")
    viewer.dispose()
  })

  test("custom tabs, transcript and trace navigate through real host pages and restore on Esc", async () => {
    const { render, press, fixture, viewer } = open(80, 24)
    agentsOf(fixture.snapshot)[0]!.sessionId = "child-session"
    fixture.data.session = {
      info: () => ({ id: "root" }),
      subagents: () => [{ id: "child-session" }],
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
    press("enter", "5", "right")
    expect(render().join("\n")).toContain("Shared board contents")
    press("tab", "right")
    expect(render().join("\n")).toContain("Member messages")
    press("a", "down", "enter")
    await Promise.resolve()
    expect(render().join("\n")).toContain("Child transcript contents")
    expect(render().join("\n")).toMatch(/esc back/i)
    press("escape")
    expect(render().join("\n")).toContain("Open transcript")
    press("down", "enter")
    await Promise.resolve()
    await Promise.resolve()
    expect(render().join("\n")).toContain("First token wait")
    press("escape", "escape")
    expect(render().join("\n")).toMatch(/esc close/i)
    viewer.dispose()
  })

  test("custom widget arrows use retained host agent selection after replacement", () => {
    const { render, press, fixture, viewer } = open(180, 52)
    fixture.details.payments!.tabs = [
      { key: "board", label: "Board", render: () => [{ kind: "text", text: "Retained board" }] },
      { key: "messages", label: "Messages", render: () => [{ kind: "text", text: "Retained messages" }] },
    ]
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
    press("enter", "5", "right", "tab", "right")
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
      subagents: () => [{ id: "child-session" }],
      trace: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    } as unknown as SessionControl
    press("enter", "a", "down", "down", "enter")
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
    press("up", "left", "e")
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
    expect(render().join("\n")).toContain("├──▶ ⠋ working Late agent")
    press("left")
    expect(render().join("\n")).not.toContain("├──▶ ⠋ working Late agent")
    press("e")
    expect(render().join("\n")).toContain("├──▶ ⠋ working Late agent")
    viewer.dispose()
  })

  test("Enter pushes an agent page; Esc restores selection, expansion, tabs and scroll before closing", () => {
    const { render, press, closed } = open(180, 52)
    press("left", "3", "end")
    const root = render()
    expect(root.join("\n")).toContain("[Logs]")
    press("enter")
    expect(render().join("\n")).toContain("[Summary]  Diff  Logs  Actions  Stats")
    expect(render().join("\n")).toMatch(/esc back/i)
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
    press("enter", "5")
    const stats = render().join("\n")
    expect(stats).toContain("First token wait")
    expect(stats).toContain("bash  2  25.00s / 12.50s / 15.00s")
    press("r")
    expect(render().join("\n")).toMatch(/Request changes from Payment validatio/)
    press("escape")
    await Promise.resolve()
    expect(fixture.act).not.toHaveBeenCalled()
    expect(render().join("\n")).toMatch(/esc back/i)
    expect(closed).not.toHaveBeenCalled()
    press("escape")
    expect(render().join("\n")).toMatch(/esc close/i)
    viewer.dispose()
  })

  test("Stats uses retained host selection after same-kind data replacement and repairs absent tabs", () => {
    const { render, press, fixture, viewer } = open(180, 52)
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
    press("enter", "p")
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

describe.skipIf(!available)("project stage cards in the real TUI viewer", () => {
  for (const [width, height] of [
    [120, 36],
    [80, 24],
  ] as const) {
    test(`${width}x${height}: stage outcome and reported rollup remain readable without placeholders`, () => {
      const fixture = projectFixture()
      const phase = fixture.snapshot.phases[0]!
      phase.id = "65fcb0f0-fcb2-438f-8128-4d4867d0169e"
      phase.status = "running"
      phase.ref = phase.id.repeat(4)
      const stage = agentsOf(fixture.snapshot)[1]!
      stage.card = {
        kind: "stage",
        label: "Implement",
        outcome: "budget stopped",
        detail: "2 batches · 3 tasks · Read-only: use /project",
        costText: "$1.20 reported",
      }
      fixture.data.selected = stage.id
      const viewer = new tui.ExtensionViewer(dashboardView, fixture.data)
      viewer.mount()
      const render = (): string[] =>
        viewer.render(width, { theme: kit.monoTheme, color: false, rows: height }).map(kit.stripAnsi)
      try {
        render()
        viewer.handleInput(kit.key("down"))
        const rows = render()
        const output = rows.join("\n")
        expect(output).not.toContain("--:--:--")
        expect(output).not.toMatch(/─{6,}\s+—|65fcb0f0|\bunknown\s*▕/)
        const header = rows.find((row) => row.includes("budget stopped"))
        expect(header).toContain("Implement")
        expect(header).toContain("$1.20 reported")
        expect(header).toMatch(/^›.*Implement/)
        expect(header).not.toContain("…")
        expect(output).toContain("2 batches · 3 tasks")
        // Host spinners use wall-clock cadence independently of the fixture's timestamps.
        expect(rows.map((row) => row.trimEnd().replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠋"))).toMatchSnapshot()
        expect(output).not.toMatch(/^\s*[›>]\s*[│ ]*$/m)
        viewer.handleInput(kit.key("up"))
        render()
        viewer.handleInput(kit.key("up"))
        expect(render().find((row) => row.startsWith("›"))).toContain("Iteration 2")
        viewer.handleInput(kit.key("down"))
        render()
        viewer.handleInput(kit.key("down"))
        for (const costText of ["not reported yet", "$0.40 reported · incomplete/unpriced"]) {
          stage.card.outcome = "awaiting review"
          stage.card.costText = costText
          const current = render().find((row) => row.startsWith("›") && row.includes("Implement"))
          expect(current).toContain("awaiting review")
          expect(current).toContain(costText)
          expect(current).not.toContain("…")
        }
        stage.card.outcome = "budget stopped"
        stage.card.costText = "$1.20 reported"
        render()
        viewer.handleInput(kit.key("enter"))
        const page = render().join("\n")
        expect(page).toContain("$1.20 reported")
        expect(page).not.toContain("Cost     unknown")
        expect(page).not.toContain("--:--:--")
        for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
      } finally {
        viewer.dispose()
      }
    })
  }
  for (const [width, height] of [
    [180, 52],
    [80, 24],
  ] as const) {
    test(`${width}x${height}: read-only content survives timeline/page navigation and clipping`, () => {
      const fixture = projectFixture()
      const viewer = new tui.ExtensionViewer(dashboardView, fixture.data)
      viewer.mount()
      const render = (): string[] =>
        viewer.render(width, { theme: kit.monoTheme, color: false, rows: height }).map(kit.stripAnsi)
      try {
        for (const key of [undefined, "enter", "2", "3", "escape"]) {
          if (key) viewer.handleInput(kit.key(key))
          const rows = render()
          const text = rows.join("\n")
          expect(rows.length).toBeLessThanOrEqual(height)
          for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
          if (key !== "2" && key !== "3") expect(text).toContain("Spec")
          expect(text).not.toMatch(
            /Stop agent|Open diff|o diff|pause\/resume|What this agent|Dashboard · Agent/,
          )
          if (key === "2") expect(text).toContain("Cached stage evidence")
          if (key === "3") expect(text).toContain("ship-plan.md")
        }
        expect(fixture.act).not.toHaveBeenCalled()
      } finally {
        viewer.dispose()
      }
    })
  }
})
