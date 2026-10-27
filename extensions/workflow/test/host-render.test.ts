import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import path from "node:path"
import { createWorkflowView, type WorkflowViewData, type WorkflowViewRun } from "../src/view.ts"

// Resolve the linked checkout without baking a developer's checkout path into the tests.
const packages = path.dirname(realpathSync(path.join(import.meta.dir, "../node_modules/@amira/api")))
const load = async (name: string) => import(name)
const tui = await load(path.join(packages, "tui/src/index.ts"))
const kit = await load(path.join(packages, "tui-kit/src/index.ts"))
const hostGlyphs = await load(path.join(packages, "tui/src/glyphs.ts"))
const ascii = (await load(path.join(packages, "cli/themes/ascii.json"))).default

function fixture(): WorkflowViewRun {
  const meta = { name: "layout", description: "Layout fixtures", phases: ["Build", "Review"] }
  const record = {
    id: "wf_fixture",
    meta,
    args: null,
    source: "inline",
    status: "running" as const,
    startedAt: 0,
  }
  return {
    ...record,
    record,
    logs: [],
    stop: () => {},
    flow: {
      kind: "workflow",
      name: "layout",
      state: "running",
      phases: [
        {
          title: "Build",
          items: [
            {
              kind: "agent",
              call: 1,
              label: "grid",
              role: "coder",
              status: "working",
              startedAt: 0,
              cost: 0.42,
            },
          ],
        },
        {
          title: "Review",
          items: [
            {
              kind: "agent",
              call: 2,
              label: "motion",
              role: "reviewer",
              status: "done",
              durationMs: 5000,
              text: "FIRST\nSECOND",
              cost: 0.1,
            },
          ],
        },
      ],
    },
  }
}

for (const [width, height] of [
  [120, 36],
  [80, 24],
  [50, 20],
] as const) {
  test(`ASCII host ${width}x${height}: all chrome stays ASCII across panes, expansion, focus and summary`, () => {
    const before = { ...hostGlyphs.glyphs }
    const run = fixture()
    const viewer = new tui.ExtensionViewer(
      createWorkflowView(
        () => run,
        async () => false,
      ),
      {},
      { now: () => 10000 },
    )
    try {
      hostGlyphs.setGlyphs(ascii.glyphs)
      viewer.mount()
      const render = (): string => {
        const rows: string[] = viewer
          .render(width, { theme: kit.monoTheme, glyphs: ascii.glyphs, color: false, rows: height })
          .map(kit.stripAnsi)
        expect(rows.length).toBeLessThanOrEqual(height)
        for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
        const screen = rows.join("\n")
        expect(screen).not.toMatch(/[^\p{ASCII}]/u)
        return screen
      }
      expect(render()).toContain("up/down select")
      viewer.handleInput(kit.key("down"))
      expect(render()).toContain("FIRST SECOND")
      viewer.handleInput(kit.key("]"))
      expect(render()).toContain("enter expand")
      viewer.handleInput(kit.key("enter"))
      expect(render()).toContain("enter fold")
      viewer.handleInput(kit.key("enter"))
      expect(render()).toContain("FIRST SECOND")
      viewer.focused = false
      expect(render()).toContain("tab view")
      viewer.focused = true
      run.meta.name = "a-very-long-workflow-name-for-layout-regressions".repeat(3)
      if (width === 120) expect(render()).toContain(". . | working")
      else render()
      viewer.handleInput(kit.key("?"))
      expect(render().replace(/\s+/g, "")).toContain(run.meta.name)
      viewer.focused = false
      expect(render()).toContain("esc back")
      viewer.focused = true
      viewer.handleInput(kit.key("esc"))
      render()
      run.status = "done"
      run.endedAt = 10000
      run.readOnly = true
      expect(render()).not.toContain("x stop")
      viewer.handleInput(kit.key("?"))
      expect(render()).toContain("archived, read-only")
    } finally {
      viewer.dispose()
      hostGlyphs.setGlyphs(before)
    }
  })
}

for (const [width, more] of [
  [55, "[more]"],
  [82, "[more]".repeat(10)],
] as const) {
  test(`host ${width}: oversized identity suffix does not clip header metrics`, () => {
    const before = { ...hostGlyphs.glyphs }
    const run = fixture()
    run.meta.name = "long_workflow_identity_".repeat(12)
    const saved = structuredClone({ meta: run.meta, flow: run.flow })
    const profile = { ...ascii.glyphs, separator: "::", more }
    const viewer = new tui.ExtensionViewer(
      createWorkflowView(
        () => run,
        async () => false,
      ),
      {},
      { now: () => 10000 },
    )
    try {
      hostGlyphs.setGlyphs(profile)
      viewer.mount()
      const rows: string[] = viewer
        .render(width, { theme: kit.monoTheme, glyphs: profile, color: false, rows: 32 })
        .map(kit.stripAnsi)
      expect(rows[0]).toContain("working :: 10s :: $0.52")
      expect(rows[0]).toContain("working 1 :: done 1")
      for (const row of rows) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
      expect({ meta: run.meta, flow: run.flow }).toEqual(saved)
    } finally {
      viewer.dispose()
      hostGlyphs.setGlyphs(before)
    }
  })
}

test("host metadata controls custom separators and multi-cell truncation markers", () => {
  const before = { ...hostGlyphs.glyphs }
  const run = fixture()
  run.meta.name = "long-workflow-name-".repeat(12)
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  const profile = { ...ascii.glyphs, separator: "::", more: "<more>" }
  try {
    hostGlyphs.setGlyphs(profile)
    viewer.mount()
    const render = (): string =>
      viewer
        .render(120, { theme: kit.monoTheme, glyphs: profile, color: false, rows: 36 })
        .map(kit.stripAnsi)
        .join("\n")
    const screen = render()
    expect(screen).not.toMatch(/[^\p{ASCII}]/u)
    expect(screen).toContain("<more> :: | working :: 10s :: $0.52")
    expect(screen).toContain("working 1 :: done 1")
    expect(screen).toContain("up/down select :: [ ] panes")
    // Separators alone do not identify an ASCII profile; the API only exposes the rule.
    hostGlyphs.setGlyphs({ ...profile, rule: "─" })
    expect(render()).toContain("↑↓ select :: [ ] panes")
  } finally {
    viewer.dispose()
    hostGlyphs.setGlyphs(before)
  }
})

test("ASCII host preserves Unicode names, phase labels, attribution, notes, events and results", () => {
  const before = { ...hostGlyphs.glyphs }
  const run = fixture()
  const content = "正文 العربية café · ↑↓ …"
  run.meta.name = content
  run.record.startedBy = { label: content, sessionId: "child" }
  run.flow.phases[0]!.title = content
  const agent = run.flow.phases[0]!.items[0]!
  if (agent.kind !== "agent") throw new Error("Expected fixture agent")
  agent.label = content
  agent.role = content
  agent.lastAction = content
  agent.note = content
  agent.worktreeNote = content
  agent.events = [{ ts: 0, text: content }]
  agent.text = content
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  try {
    hostGlyphs.setGlyphs(ascii.glyphs)
    viewer.mount()
    const render = (): string =>
      viewer
        .render(160, { theme: kit.monoTheme, glyphs: ascii.glyphs, color: false, rows: 48 })
        .map(kit.stripAnsi)
        .join("\n")
    const folded = render()
    for (const label of ["Workflow", "Worktree:", "Note:", "Last action:", "Result:"])
      expect(folded).toContain(`${label} ${content}`)
    expect(folded).toContain(`${content} . ${content}`)
    expect(folded.split(content).length).toBeGreaterThanOrEqual(9)
    viewer.handleInput(kit.key("]"))
    render()
    viewer.handleInput(kit.key("enter"))
    expect(render().split(content).length).toBeGreaterThanOrEqual(9)
    viewer.handleInput(kit.key("?"))
    const summary = render()
    expect(summary).toContain(`Workflow ${content}`)
    expect(summary).toContain(`Started by: ${content} (child)`)
  } finally {
    viewer.dispose()
    hostGlyphs.setGlyphs(before)
  }
})

for (const [width, height] of [
  [120, 30],
  [60, 28],
] as const) {
  test(`host ${width}x${height}: arrows skip headings; list Enter focuses details and detail Enter expands/folds`, () => {
    const run = fixture()
    const data: WorkflowViewData = {}
    const viewer = new tui.ExtensionViewer(
      createWorkflowView(
        () => run,
        async () => false,
      ),
      data,
      { now: () => 10000 },
    )
    viewer.mount()
    const render = (): string[] =>
      viewer.render(width, { theme: kit.monoTheme, color: false, rows: height }).map(kit.stripAnsi)
    const first = render()
    expect(first.join("\n")).toContain("Build")
    expect(first.join("\n")).toContain("Review")
    for (const row of first) expect(kit.visibleWidth(row)).toBeLessThanOrEqual(width)
    expect(first.length).toBeLessThanOrEqual(height)
    viewer.handleInput(kit.key("down"))
    expect(render().join("\n")).toContain("FIRST SECOND")
    expect(data.selectedCall).toBe(2)
    viewer.handleInput(kit.key("enter"))
    expect(render().join("\n")).toContain("FIRST SECOND")
    expect(data.expandedCalls).toBeUndefined()
    viewer.handleInput(kit.key("enter"))
    expect(render().join("\n")).not.toContain("FIRST SECOND")
    expect(render().join("\n")).toContain("SECOND")
    viewer.handleInput(kit.key("enter"))
    expect(render().join("\n")).toContain("FIRST SECOND")
    viewer.handleInput(kit.key("["))
    render()
    viewer.handleInput(kit.key("up"))
    render()
    expect(data.selectedCall).toBe(1)
    viewer.dispose()
  })
}

for (const [width, detailsKey, listKey] of [
  [120, "]", "["],
  [60, "]", "["],
  [120, "d", "d"],
  [60, "d", "d"],
] as const) {
  test(`host ${width}: ${detailsKey}/${listKey} and Enter expand/fold details and retain expansion across panes`, () => {
    const run = fixture()
    const data: WorkflowViewData = {}
    const viewer = new tui.ExtensionViewer(
      createWorkflowView(
        () => run,
        async () => false,
      ),
      data,
      { now: () => 10000 },
    )
    viewer.mount()
    const render = () =>
      viewer.render(width, { theme: kit.monoTheme, color: false, rows: 30 }).map(kit.stripAnsi).join("\n")
    render()
    viewer.handleInput(kit.key("down"))
    expect(render()).toContain("FIRST SECOND")
    viewer.handleInput(kit.key(detailsKey))
    render()
    viewer.handleInput(kit.key("enter"))
    expect(render()).not.toContain("FIRST SECOND")
    expect(render()).toContain("SECOND")
    expect(data.expandedCalls).toEqual([2])
    viewer.handleInput(kit.key("enter"))
    expect(render()).toContain("FIRST SECOND")
    expect(data.expandedCalls).toEqual([])
    viewer.handleInput(kit.key("enter"))
    render()
    viewer.handleInput(kit.key(listKey))
    expect(render()).toContain("SECOND")
    viewer.handleInput(kit.key("up"))
    render()
    viewer.handleInput(kit.key("down"))
    expect(render()).not.toContain("FIRST SECOND")
    expect(data.selectedCall).toBe(2)
    viewer.handleInput(kit.key("up"))
    render()
    viewer.handleInput(kit.key("left"))
    render()
    viewer.handleInput(kit.key("down"))
    render()
    viewer.handleInput(kit.key(detailsKey))
    expect(render()).toContain("SECOND")
    expect(render()).not.toContain("FIRST SECOND")
    viewer.dispose()
  })
}

test("default-theme selected row keeps its badge colour under the accent cursor", () => {
  const run = fixture()
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const theme = kit.defaultTheme
  const [accent] = theme.accent("\0").split("\0")
  const [success] = theme.success("\0").split("\0")
  const render = (): string[] => viewer.render(120, { theme, color: true, rows: 32 })
  render()
  expect(viewer.animating).toBe(true)
  viewer.handleInput(kit.key("down"))
  const selected = render().find((row) => kit.stripAnsi(row).includes(`${hostGlyphs.glyphs.pointer} ✓ done`))!
  expect(selected).toBeDefined()
  expect(selected).toContain(`${success}✓`)
  expect(selected).toContain(`${success}done`)
  expect(selected).toContain(`${accent} motion`)
  viewer.dispose()
})

test("wide header matches swarm: identity left, protected counts right, one summary row", () => {
  const run = fixture()
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const rows: string[] = viewer
    .render(120, { theme: kit.monoTheme, color: false, rows: 32 })
    .map(kit.stripAnsi)
  expect(rows[0]!.indexOf("Workflow")).toBeLessThan(rows[0]!.indexOf("working 1"))
  expect(rows[0]).toContain("done 1")
  expect(rows[1]!.trim()).toBe("")
  viewer.dispose()
})

test("narrow host keeps stop and navigation hints visible", () => {
  const run = fixture()
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const rows: string[] = viewer
    .render(60, { theme: kit.monoTheme, color: false, rows: 28 })
    .map(kit.stripAnsi)
  for (const hint of [
    "↑↓ select",
    "[ ] panes",
    "enter details",
    "? summary",
    "x stop",
    "tab input",
    "esc close",
  ])
    expect(rows.join("\n")).toContain(hint)
  viewer.dispose()
})

test("60 columns prioritizes counts, wrapped navigation hints, and inspectable full summary", () => {
  const run = fixture()
  run.meta.name = "a-very-long-workflow-name-for-layout-regressions"
  run.flow.phases[1]!.items.push(
    { kind: "agent", call: 3, label: "queued", status: "queued" },
    { kind: "agent", call: 4, label: "done", status: "done" },
  )
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const render = () => viewer.render(60, { theme: kit.monoTheme, color: false, rows: 30 }).map(kit.stripAnsi)
  const rows = render()
  expect(rows[0]).toContain("queued 1 · working 1 · done 2")
  const hints = rows.filter((row: string) => /↑↓ select|tab input|esc close/.test(row))
  expect(hints).toHaveLength(2)
  for (const hint of [
    "↑↓ select",
    "[ ] panes",
    "enter details",
    "? summary",
    "x stop",
    "tab input",
    "esc close",
  ])
    expect(hints.join("\n")).toContain(hint)
  expect(rows.join("\n")).not.toContain("d panes")
  viewer.handleInput(kit.key("?"))
  expect(render().join("\n")).toContain("a-very-long-workflow-name-for-layout-regressions")
  expect(render().join("\n")).toContain("queued 1 · working 1 · done 2")
  viewer.dispose()
})

test("only active native pane highlights selection and pointer touches the badge symbol", () => {
  const run = fixture()
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  // A distinct accent marks the host's bold accent selection apart from mono's bold text.
  const theme = { ...kit.monoTheme, accent: (s: string) => `\u001b[35m${s}\u001b[39m` }
  const mark = "\u001b[1m\u001b[35m"
  const render = (): string[] => viewer.render(120, { theme, color: true, rows: 30 })
  const rows = render()
  const selected = rows.find((row) => row.includes(mark))!
  expect(kit.stripAnsi(selected)).toMatch(/^ {2}› \S working grid/)
  expect(rows.filter((row) => row.includes(mark))).toHaveLength(1)
  expect(rows.some((row) => kit.stripAnsi(row).includes("│"))).toBe(true)
  viewer.handleInput(kit.key("]"))
  const detailRows = render()
  const listRow = detailRows.find((row) => kit.stripAnsi(row).includes("working grid"))!
  expect(listRow).not.toContain(mark)
  expect(detailRows.filter((row) => row.includes(mark))).toHaveLength(1)
  expect(detailRows.find((row) => row.includes(mark))).toContain("Events / result")
  viewer.dispose()
})

test("inactive narrow list keeps the final selected agent visible", () => {
  const run = fixture()
  run.flow.phases[1]!.items.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      kind: "agent" as const,
      call: index + 3,
      label: `extra ${index}`,
      status: "done" as const,
    })),
  )
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const render = () =>
    viewer.render(60, { theme: kit.monoTheme, color: false, rows: 28 }).map(kit.stripAnsi).join("\n")
  render()
  for (let index = 0; index < 21; index++) {
    viewer.handleInput(kit.key("down"))
    render()
  }
  viewer.handleInput(kit.key("]"))
  expect(render()).toContain("> ✓ done    extra 19")
  viewer.dispose()
})

test("host wide details keep role, state, elapsed and known cost in one summary row", () => {
  const run = fixture()
  const viewer = new tui.ExtensionViewer(
    createWorkflowView(
      () => run,
      async () => false,
    ),
    {},
    { now: () => 10000 },
  )
  viewer.mount()
  const rows: string[] = viewer
    .render(120, { theme: kit.monoTheme, color: false, rows: 30 })
    .map(kit.stripAnsi)
  expect(
    rows.some(
      (row) =>
        row.includes("coder") && row.includes("working") && row.includes("10s") && row.includes("$0.42"),
    ),
  ).toBe(true)
  viewer.dispose()
})
