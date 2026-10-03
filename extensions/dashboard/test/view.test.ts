import { describe, expect, test } from "bun:test"
import type { UiEvent, UiNode, UiTreeItem, ViewLine } from "@amira/api"
import { agentsOf } from "../src/source.ts"
import { dashboardView, performAction } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

type Fixture = ReturnType<typeof viewFixture>

function render(fixture: Fixture, width = 180): UiNode {
  return dashboardView.ui!(fixture.data, fixture.context(width))
}

/** Traverse rendered subtrees, including nested source tabs and tree details. */
function nodes(node: UiNode): UiNode[] {
  const children: UiNode[] = []
  if (node.type === "column" || node.type === "row") {
    children.push(...node.children.map((child) => child.node))
  } else if (node.type === "box") children.push(node.child)
  else if (node.type === "tabs") children.push(...node.tabs.map((tab) => tab.body))
  else if (node.type === "tree") {
    for (const item of treeItems(node.items)) {
      if (item.detail && !Array.isArray(item.detail)) children.push(item.detail)
    }
  }
  return [node, ...children.flatMap(nodes)]
}

function treeItems(items: UiTreeItem[]): UiTreeItem[] {
  return items.flatMap((item) => [item, ...treeItems(item.children ?? [])])
}

function widget(fixture: Fixture, id: string): UiNode {
  const found = nodes(render(fixture)).find((node) => "id" in node && node.id === fixture.widgetId(id))
  if (!found) throw new Error(`Missing widget: ${id}`)
  return found
}

function lines(fixture: Fixture, id: string): ViewLine[] {
  const node = widget(fixture, id)
  if (node.type !== "text") throw new Error(`Not a text widget: ${id}`)
  return node.lines
}

function words(fixture: Fixture, id: string): string[] {
  return lines(fixture, id).map((line) =>
    line.kind === "segments" ? line.parts.map((part) => part.text).join("") : line.text,
  )
}

function send(fixture: Fixture, event: UiEvent): void {
  if ("id" in event && event.id !== "timeline") event = { ...event, id: fixture.widgetId(event.id) }
  // The public host contract updates widget state before notifying the extension.
  if (event.type === "select" || event.type === "activate") fixture.state.selected[event.id] = event.key
  if (event.type === "tab") fixture.state.activeTabs[event.id] = event.key
  dashboardView.onEvent!(event, fixture.data, fixture.control)
}

function key(fixture: Fixture, value: string): void {
  send(fixture, { type: "key", key: value, focused: fixture.state.focused })
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
}

describe("public semantic rendering (not terminal raster snapshots)", () => {
  // Semantic snapshots complement the real host's wrapping/clipping tests.
  for (const viewport of [
    { columns: 180, rows: 52 },
    { columns: 80, rows: 24 },
  ]) {
    for (const screen of ["timeline", "agent", "stats"] as const) {
      test(`${viewport.columns}x${viewport.rows} ${screen} widget contract`, () => {
        const fixture = viewFixture()
        if (screen !== "timeline") {
          send(fixture, { type: "activate", id: "timeline", key: "agent:payments" })
        }
        if (screen === "stats") send(fixture, { type: "tab", id: "detail", key: "stats" })
        const context = fixture.context(viewport.columns, viewport.rows - 1)
        expect({
          contract: "Public UiNode tree; body height excludes the host key bar",
          viewport,
          title: dashboardView.title(fixture.data, context),
          state: context.state,
          tree: dashboardView.ui!(fixture.data, context),
        }).toMatchSnapshot()
      })
    }
  }

  test("repeated renders leave view data, source models and host state unchanged", () => {
    const fixture = viewFixture()
    const context = fixture.context()
    const before = structuredClone({
      snapshot: fixture.snapshot,
      details: fixture.details,
      state: fixture.state,
    })
    const dataBefore = { ...fixture.data }
    freeze(fixture.snapshot)
    freeze(fixture.details)
    freeze(fixture.data)
    freeze(context)
    const first = dashboardView.ui!(fixture.data, context)
    expect(dashboardView.ui!(fixture.data, context)).toEqual(first)
    expect(fixture.data).toEqual(dataBefore)
    expect({ snapshot: fixture.snapshot, details: fixture.details, state: fixture.state }).toEqual(before)
    expect(fixture.act).not.toHaveBeenCalled()
    expect(fixture.control.setState).not.toHaveBeenCalled()
    expect(fixture.control.requestRender).not.toHaveBeenCalled()
  })

  test("widget IDs stay unique as each tab becomes active at both widths and on both pages", () => {
    const fixture = viewFixture()
    const bodies = ["summary", "diff", "logs", "actions", "stats"]
    for (const width of [180, 80]) {
      for (const page of [undefined, "payments"]) {
        if (fixture.context().page) fixture.control.popPage()
        if (page) send(fixture, { type: "activate", id: "timeline", key: `agent:${page}` })
        for (const active of bodies) {
          send(fixture, { type: "tab", id: "detail", key: active })
          const all = nodes(render(fixture, width))
          const ids = all.flatMap((node) => ("id" in node && node.id ? [node.id] : []))
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids).toContain(fixture.widgetId("detail"))
          expect(ids).toContain(fixture.widgetId(active))
          for (const inactive of bodies.filter((body) => body !== active))
            expect(ids).not.toContain(fixture.widgetId(inactive))
          for (const node of all) {
            if (node.type !== "tree") continue
            const keys = treeItems(node.items).map((item) => item.key)
            expect(new Set(keys).size).toBe(keys.length)
          }
        }
      }
    }
  })

  test("timeline has one level of phase rows and selectable card headers, without group rows", () => {
    const fixture = viewFixture()
    const timeline = widget(fixture, "timeline")
    if (timeline.type !== "tree") throw new Error("Missing timeline")
    expect(timeline.items.map((item) => item.key)).toEqual([
      "phase:implementation",
      "agent:payments",
      "agent:receipts",
      "phase:review",
      "agent:audit",
    ])
    for (const item of timeline.items) {
      expect(item.children ?? []).toEqual([])
      expect(item.detail).toBeDefined()
      expect(item.row?.length).toBeGreaterThan(0)
    }
  })

  test("wide timeline supplies every card; narrow timeline supplies the selected phase's whole box", () => {
    const fixture = viewFixture()
    for (const selected of ["agent:payments", "agent:receipts", "agent:audit", "phase:review"]) {
      send(fixture, { type: "select", id: "timeline", key: selected })
      for (const width of [180, 80]) {
        const timeline = nodes(render(fixture, width)).find((node) => node.type === "tree")
        if (timeline?.type !== "tree") throw new Error("Missing timeline")
        expect(
          timeline.items.filter((item) => item.key.startsWith("phase:")).map((item) => item.key),
        ).toEqual(["phase:implementation", "phase:review"])
        const cards = timeline.items.filter((item) => item.key.startsWith("agent:"))
        expect(cards.map((item) => item.key)).toEqual(
          width === 180
            ? ["agent:payments", "agent:receipts", "agent:audit"]
            : selected === "agent:audit" || selected === "phase:review"
              ? ["agent:audit"]
              : ["agent:payments", "agent:receipts"],
        )
        expect(cards.every((item) => item.detail)).toBe(true)
      }
    }
  })

  test("card progress distinguishes unreported progress from reported zero", () => {
    const fixture = viewFixture()
    const receipts = agentsOf(fixture.snapshot).find((agent) => agent.id === "receipts")!
    for (const width of [180, 80]) {
      for (const progress of [undefined, 0]) {
        receipts.progress = progress
        const timeline = nodes(render(fixture, width)).find((node) => node.type === "tree")
        if (timeline?.type !== "tree") throw new Error("Missing timeline")
        const card = timeline.items.find((item) => item.key === "agent:receipts")!
        const indicator = card.row?.at(-1)
        expect(indicator?.text).toBe(
          `${"─".repeat(width === 180 ? 14 : 6)}  ${progress === undefined ? "—" : "0%"}`,
        )
        if (progress === undefined) expect(indicator?.kind).toBe("muted")
      }
    }
  })

  test("selected details use 6 narrow rows or 30% of wide body height clamped to 9–15 rows", () => {
    const fixture = viewFixture()
    for (const width of [80, 180]) {
      for (const [height, expected] of [
        [0, 9],
        [20, 9],
        [30, 9],
        [35, 11],
        [40, 12],
        [51, 15],
        [100, 15],
      ]) {
        const tree = dashboardView.ui!(fixture.data, fixture.context(width, height))
        if (tree.type !== "column") throw new Error("Missing layout")
        expect(
          tree.children.find(
            ({ node }) => node.type === "column" && JSON.stringify(node.children[0]).includes("≡"),
          )?.size,
        ).toBe(width === 80 ? 6 : expected)
      }
    }
  })

  test("details keep tab headers in one row and render only the active body at full width", () => {
    const fixture = viewFixture()
    for (const width of [80, 180]) {
      for (const page of [undefined, "payments"]) {
        if (fixture.context().page) fixture.control.popPage()
        if (page) send(fixture, { type: "activate", id: "timeline", key: `agent:${page}` })
        send(fixture, { type: "tab", id: "detail", key: "diff" })
        const tree = render(fixture, width)
        if (tree.type !== "column") throw new Error("Missing layout")
        const panel = tree.children.find(
          ({ node }) => node.type === "column" && JSON.stringify(node.children[0]).includes("≡"),
        )?.node
        if (panel?.type !== "column") throw new Error("Missing details panel")
        expect(panel.children[0]).toMatchObject({ size: 1, node: { type: "text" } })
        expect(JSON.stringify(panel.children[0])).toContain("≡")
        const detail = panel.children[1]?.node
        if (detail?.type !== "column") throw new Error("Missing details content")
        const header = detail.children[0]!
        expect(header.size).toBe(1)
        if (header.node.type !== "row") throw new Error("Missing details header")
        const tabs = header.node.children[0]!.node
        if (tabs.type !== "tabs") throw new Error("Missing tabs")
        expect(tabs.tabs.every((tab) => tab.body.type === "spacer")).toBe(true)
        expect(detail.children[1]).toEqual({ size: 1, node: { type: "rule" } })
        expect(detail.children[2]?.size).toBeUndefined()
        expect(detail.children[2]?.node).toMatchObject({ type: "text", id: fixture.widgetId("diff") })
        expect(detail.children).toHaveLength(3)
      }
    }
  })

  test("unselected and phase-selected details use only a handle and one placeholder row", () => {
    const fixture = viewFixture()
    fixture.data.selected = undefined
    for (const selected of [undefined, "phase:implementation", "group:implementation:workers"]) {
      fixture.state.selected = selected ? { timeline: selected } : {}
      for (const width of [80, 180]) {
        const tree = dashboardView.ui!(fixture.data, fixture.context(width, 51))
        if (tree.type !== "column") throw new Error("Missing layout")
        const panel = tree.children.find(
          ({ node }) => node.type === "column" && JSON.stringify(node.children[0]).includes("≡"),
        )
        expect(panel?.size).toBe(2)
        if (panel?.node.type !== "column") throw new Error("Missing details panel")
        expect(panel.node.children).toHaveLength(2)
        expect(panel.node.children[0]).toMatchObject({ size: 1, node: { type: "text" } })
        expect(JSON.stringify(panel.node.children[0])).toContain("≡")
        expect(panel.node.children[1]?.node).toMatchObject({ type: "text", id: "selection-hint" })
        expect(words(fixture, "selection-hint")).toHaveLength(1)
      }
    }
  })

  test("timeline defaults expanded and hints match each agent's capabilities", () => {
    const fixture = viewFixture()
    fixture.state.expanded = {}
    const tree = widget(fixture, "timeline")
    if (tree.type !== "tree") throw new Error("Missing timeline")
    expect(tree.expanded).toBe("all")
    const header = (id: string) => {
      const card = tree.items.find((item) => item.key === `agent:${id}`)!
      return [...(card.row ?? []), ...(card.aside ?? [])].map((part) => part.text).join("")
    }
    expect(header("payments")).toContain("Pause")
    expect(header("payments")).toContain("Request changes")
    expect(header("payments")).not.toContain("Resume")
    expect(header("receipts")).toContain("Resume")
    expect(header("receipts")).not.toContain("Pause")
    expect(header("receipts")).not.toContain("Request changes")
    expect(header("audit")).not.toContain("Pause")
    expect(header("audit")).not.toContain("Resume")
    expect(header("audit")).not.toContain("Request changes")
    for (const id of ["payments", "receipts", "audit"]) {
      expect(header(id)).toContain("Open diff")
      expect(header(id)).not.toContain("p Pause")
      expect(header(id)).not.toContain("p Resume")
    }
  })

  test("empty source remains a valid semantic tree", () => {
    const fixture = viewFixture()
    fixture.snapshot.phases = []
    fixture.snapshot.note = undefined
    expect(words(fixture, "empty")).toEqual([
      "No agents yet. Start a task with sub-agents, then return here.",
    ])
    expect(words(fixture, "selection-hint")).toEqual([
      "Select an agent in the timeline, then press Enter to open its page.",
    ])
  })
})

describe("public events and host-owned navigation", () => {
  test("Enter pushes host page state; popping restores timeline selection, expansion and tabs", () => {
    const fixture = viewFixture()
    send(fixture, { type: "select", id: "timeline", key: "agent:receipts" })
    const root = structuredClone(fixture.state)
    send(fixture, { type: "activate", id: "timeline", key: "agent:receipts" })
    expect(fixture.control.pushPage).toHaveBeenCalledTimes(1)
    expect(fixture.context().page).toEqual({ depth: 1, data: "receipts" })
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("summary")
    expect(fixture.state.focused).toBe(fixture.widgetId("detail"))
    expect(nodes(render(fixture)).some((node) => node.type === "tree")).toBe(false)
    expect(words(fixture, "summary")[0]).toContain("Receipt templates")
    key(fixture, "3")
    fixture.control.popPage()
    expect(fixture.context().page).toBeUndefined()
    expect(fixture.state).toEqual(root)
    expect(widget(fixture, "timeline").type).toBe("tree")
    expect(fixture.control.close).not.toHaveBeenCalled()
  })

  test("Esc and q stay host-owned; the b workaround is removed", () => {
    const fixture = viewFixture()
    send(fixture, { type: "activate", id: "timeline", key: "agent:payments" })
    const declared = dashboardView.keys!.map((binding) => binding.key)
    expect(declared).not.toContain("escape")
    expect(declared).not.toContain("esc")
    expect(declared).not.toContain("q")
    expect(declared).not.toContain("enter")
    expect(declared).not.toContain("b")
    // Esc page-pop behavior is exercised through the real TUI in tui-render.test.ts.
    key(fixture, "escape")
    expect(fixture.context().page?.data).toBe("payments")
    expect(fixture.control.close).not.toHaveBeenCalled()
  })

  test("activating a phase or group does not open an agent page", () => {
    const fixture = viewFixture()
    for (const item of ["phase:implementation", "group:implementation:workers"]) {
      send(fixture, { type: "activate", id: "timeline", key: item })
      expect(fixture.context().page).toBeUndefined()
      expect(fixture.data.selected).toBeUndefined()
      expect(widget(fixture, "selection-hint").type).toBe("text")
    }
  })

  test("keys 1–4 select tabs; host tab events keep subsequent left/right movement in sync", () => {
    const fixture = viewFixture()
    for (const [index, tab] of ["summary", "diff", "logs", "actions"].entries()) {
      key(fixture, String(index + 1))
      expect(fixture.data.tab).toBe(tab)
      expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe(tab)
    }
    send(fixture, { type: "tab", id: "detail", key: "logs" })
    expect(fixture.data.tab).toBe("logs")
    key(fixture, "left")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("diff")
    key(fixture, "right")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("logs")
    send(fixture, { type: "tab", id: "unrelated", key: "other" })
    expect(fixture.data.tab).toBe("logs")
    // Tab/Shift-Tab focus traversal and focused-widget arrows belong to the host.
    expect(dashboardView.keys!.map((binding) => binding.key)).not.toContain("tab")
  })

  test("numeric tabs defer missing-tab repair to the host; cycling uses available tabs", () => {
    const fixture = viewFixture()
    key(fixture, "5")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("stats")
    key(fixture, "right")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("summary")
    key(fixture, "left")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("stats")
    send(fixture, { type: "activate", id: "timeline", key: "agent:receipts" })
    key(fixture, "5")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("stats")
    // A real host repairs this absent tab to Summary (covered in tui-render.test.ts).
    key(fixture, "left")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("actions")
    key(fixture, "right")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("summary")
    const tabs = widget(fixture, "detail")
    if (tabs.type !== "tabs") throw new Error("Missing tabs")
    expect(tabs.tabs.map((tab) => tab.key)).toEqual(["summary", "diff", "logs", "actions"])
  })

  test("e restores expand-all mode and a focuses actions", () => {
    const fixture = viewFixture()
    fixture.state.expanded = {}
    key(fixture, "e")
    expect(fixture.state.expanded).toEqual({})
    const tree = widget(fixture, "timeline")
    expect(tree.type === "tree" && tree.expanded).toBe("all")
    key(fixture, "a")
    expect(fixture.data.tab).toBe("actions")
    expect(fixture.state.focused).toBe("actions")
  })
})

describe("agent actions", () => {
  test("timeline action targets come from reconciled widget rows, not stale event selection", async () => {
    const fixture = viewFixture()
    // The host repaired its selection without emitting select (same-kind replacement
    // or disappearing/hidden data). The cached event selection still says payments.
    fixture.state.selected.timeline = "agent:receipts"
    key(fixture, "p")
    expect(fixture.act).not.toHaveBeenCalled()
    expect(fixture.state.focused).toBe("actions")
    const actions = widget(fixture, "actions")
    if (actions.type !== "table") throw new Error("Missing action table")
    expect(actions.rows).toHaveLength(1)
    expect(actions.rows[0]!.key).toBe(JSON.stringify(["receipts", "resume"]))
    send(fixture, { type: "activate", id: "actions", key: actions.rows[0]!.key })
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("receipts", "resume", undefined)
    fixture.state.selected.timeline = "phase:implementation"
    key(fixture, "p")
    expect(widget(fixture, "selection-hint").type).toBe("text")
    expect(fixture.act).toHaveBeenCalledTimes(1)
  })

  test("Open diff works from the shortcut and action table, showing real lines or an honest missing note", () => {
    const fixture = viewFixture()
    key(fixture, "o")
    expect(fixture.state.activeTabs[fixture.widgetId("detail")]).toBe("diff")
    expect(fixture.state.focused).toBe("detail")
    expect(lines(fixture, "diff")).toEqual([
      { kind: "accent", text: "src/payments.ts" },
      ...agentsOf(fixture.snapshot)[0]!.files[0]!.diff!,
      { kind: "accent", text: "test/payments.test.ts" },
      { kind: "muted", text: "No diff available for this file (only its path was reported)." },
    ])
    send(fixture, { type: "activate", id: "timeline", key: "agent:receipts" })
    send(fixture, { type: "tab", id: "detail", key: "actions" })
    expect(widget(fixture, "actions").type).toBe("table")
    send(fixture, { type: "activate", id: "actions", key: JSON.stringify(["receipts", "open-diff"]) })
    expect(words(fixture, "diff")).toEqual([
      "templates/receipt.html",
      "No diff available for this file (only its path was reported).",
    ])
    send(fixture, { type: "activate", id: "timeline", key: "agent:audit" })
    key(fixture, "o")
    expect(words(fixture, "diff")).toEqual(["No diff available."])
    expect(fixture.act).not.toHaveBeenCalled()
  })

  test("p on a page chooses pause or resume from current status and reports the source result", async () => {
    const fixture = viewFixture()
    send(fixture, { type: "activate", id: "timeline", key: "agent:payments" })
    key(fixture, "p")
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("payments", "pause", undefined)
    expect(fixture.data.flash).toBe("Accepted pause.")
    expect(fixture.data.busy).toBe(false)
    send(fixture, { type: "activate", id: "timeline", key: "agent:receipts" })
    key(fixture, "p")
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("receipts", "resume", undefined)
    expect(fixture.data.flash).toBe("Accepted resume.")
  })

  test("action table activation and page r/x shortcuts dispatch the same guarded operations", async () => {
    const fixture = viewFixture()
    send(fixture, { type: "activate", id: "timeline", key: "agent:payments" })
    send(fixture, { type: "tab", id: "detail", key: "actions" })
    expect(widget(fixture, "actions").type).toBe("table")
    send(fixture, { type: "activate", id: "actions", key: JSON.stringify(["payments", "pause"]) })
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith("payments", "pause", undefined)
    key(fixture, "r")
    // Prompt and source action each introduce a microtask; no timers or host internals.
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.act).toHaveBeenLastCalledWith(
      "payments",
      "request-changes",
      "Please cover negative refunds.",
    )
    key(fixture, "x")
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.control.confirm).toHaveBeenCalledTimes(1)
    expect(fixture.act).toHaveBeenLastCalledWith("payments", "stop", undefined)
    expect(fixture.data.busy).toBe(false)
  })

  test("Stop requires confirmation; cancellation does not invoke the source", async () => {
    const fixture = viewFixture()
    fixture.control.confirm.mockResolvedValueOnce(false)
    await performAction(fixture.data, fixture.control, "stop")
    expect(fixture.control.confirm).toHaveBeenCalledWith("Stop Payment validation?", {
      yes: "stops the agent",
      no: "keeps it running",
    })
    expect(fixture.act).not.toHaveBeenCalled()
    expect(fixture.data.flash).toBe("Not stopped.")
    expect(fixture.data.busy).toBe(false)
    await performAction(fixture.data, fixture.control, "stop")
    expect(fixture.act).toHaveBeenCalledWith("payments", "stop", undefined)
    expect(fixture.data.flash).toBe("Accepted stop.")
  })

  test("Request changes prompts for text and sends it to the selected agent", async () => {
    const fixture = viewFixture()
    await performAction(fixture.data, fixture.control, "request-changes")
    expect(fixture.control.prompt).toHaveBeenCalledWith("Request changes from Payment validation")
    expect(fixture.act).toHaveBeenCalledWith("payments", "request-changes", "Please cover negative refunds.")
    expect(fixture.data.flash).toBe("Accepted request-changes.")
    expect(fixture.data.busy).toBe(false)
    expect(fixture.control.requestRender).toHaveBeenCalled()
  })

  for (const answer of [undefined, ""]) {
    test(`Request changes cancellation (${String(answer)}) releases busy without sending`, async () => {
      const fixture = viewFixture()
      fixture.control.prompt.mockResolvedValueOnce(answer)
      await performAction(fixture.data, fixture.control, "request-changes")
      expect(fixture.act).not.toHaveBeenCalled()
      expect(fixture.data.flash).toBeUndefined()
      expect(fixture.data.busy).toBe(false)
      expect(fixture.control.requestRender).toHaveBeenCalledTimes(1)
    })
  }

  test("both advertised capability and an act implementation are required", async () => {
    for (const unavailable of ["capability", "implementation"]) {
      const fixture = viewFixture()
      if (unavailable === "capability") agentsOf(fixture.snapshot)[0]!.actions = []
      else fixture.data.source.act = undefined
      await performAction(fixture.data, fixture.control, "request-changes")
      expect(fixture.data.flash).toBe("Not sent: messaging this agent is unavailable from this source.")
      expect(fixture.act).not.toHaveBeenCalled()
      for (const [action, label] of [
        ["pause", "Pause"],
        ["resume", "Resume"],
        ["stop", "Stop"],
      ]) {
        await performAction(fixture.data, fixture.control, action!)
        expect(fixture.data.flash).toBe(`${label} is unavailable from this source.`)
      }
      expect(fixture.control.confirm).not.toHaveBeenCalled()
      expect(fixture.act).not.toHaveBeenCalled()
      expect(fixture.data.busy).toBe(false)
    }
  })

  test("missing selection cannot perform an action", async () => {
    const fixture = viewFixture()
    fixture.data.selected = undefined
    await performAction(fixture.data, fixture.control, "pause")
    expect(fixture.data.flash).toBe("Select an agent first.")
    expect(fixture.act).not.toHaveBeenCalled()
    expect(fixture.control.requestRender).toHaveBeenCalledTimes(1)
  })

  test("a pending action blocks duplicate mutations and always clears busy after resolution", async () => {
    const fixture = viewFixture()
    let finish!: (message: string) => void
    fixture.act.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const pending = performAction(fixture.data, fixture.control, "pause")
    expect(fixture.data.busy).toBe(true)
    await performAction(fixture.data, fixture.control, "stop")
    expect(fixture.act).toHaveBeenCalledTimes(1)
    expect(fixture.control.confirm).not.toHaveBeenCalled()
    finish("Paused at the next safe point.")
    await pending
    expect(fixture.data.flash).toBe("Paused at the next safe point.")
    expect(fixture.data.busy).toBe(false)
  })

  test("rejected source actions, prompts and confirmations become feedback rather than unhandled errors", async () => {
    for (const failure of ["source", "prompt", "confirm"]) {
      const fixture = viewFixture()
      if (failure === "source")
        fixture.act.mockImplementationOnce(() => Promise.reject(new Error("Source disconnected")))
      if (failure === "prompt") fixture.control.prompt.mockRejectedValueOnce(new Error("Source disconnected"))
      if (failure === "confirm")
        fixture.control.confirm.mockRejectedValueOnce(new Error("Source disconnected"))
      const action = failure === "prompt" ? "request-changes" : failure === "confirm" ? "stop" : "pause"
      await performAction(fixture.data, fixture.control, action)
      expect(fixture.data.flash).toBe("Action failed: Source disconnected")
      expect(fixture.data.busy).toBe(false)
      expect(fixture.control.requestRender).toHaveBeenCalledTimes(1)
      if (failure !== "source") expect(fixture.act).not.toHaveBeenCalled()
    }
  })

  test("non-Error rejections are also reported and a subsequent action can succeed", async () => {
    const fixture = viewFixture()
    fixture.act.mockImplementationOnce(() => Promise.reject("Connection lost"))
    await performAction(fixture.data, fixture.control, "pause")
    expect(fixture.data.flash).toBe("Action failed: Connection lost")
    await performAction(fixture.data, fixture.control, "pause")
    expect(fixture.data.flash).toBe("Accepted pause.")
    expect(fixture.data.busy).toBe(false)
  })
})

test("supplied stats retain time attribution, per-tool outcomes, failures and own per-agent costs", () => {
  const fixture = viewFixture()
  key(fixture, "5")
  const stats = words(fixture, "stats").join("\n")
  expect(stats).toContain("Time split · wall 90.00s")
  for (const label of [
    "First token wait",
    "Streaming",
    "Model time (unclassified)",
    "Tools (interval union)",
    "Approval wait",
    "Idle",
  ])
    expect(stats).toContain(label)
  expect(stats).toContain("Intervals may overlap; these metrics do not add up to wall time.")
  expect(stats).toContain("bash  2  25.00s / 12.50s / 15.00s  ok:1 error:1")
  expect(stats).toContain("09:01:40 bash: error Refund regression failed before the fix.")
  expect(stats).toContain("Cost per agent · own usage only, no recursive totals")
  expect(stats).toContain("Payment validation: $0.125")
  expect(stats).toContain("Receipt templates: cost unknown")
  expect(stats).toContain("Refund audit: $0.040")
})
