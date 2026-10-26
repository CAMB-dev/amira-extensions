import { expect, test } from "bun:test"
import { AGENT_STATUS_BADGES, type UiContext } from "@amira/api"
import { chrome } from "../src/chrome.ts"
import { timeline } from "../src/layout.ts"
import { dashboardView } from "../src/view.ts"
import { viewFixture } from "./view-fixture.ts"

const glyphs = {
  rule: "-",
  treePipe: "|",
  separator: ".",
  more: ".",
  error: "x",
  interrupted: "o",
  statusStopped: "|",
}
const statusBadge: UiContext["statusBadge"] = (state) => {
  const badge = AGENT_STATUS_BADGES[state]
  return [{ kind: badge.role, text: `${badge.ascii} ${badge.label.padEnd(7)}` }]
}

for (const [width, height] of [
  [180, 100],
  [80, 24],
  [50, 20],
] as const) {
  test(`audit: strict ASCII extension output on both pages at ${width}x${height}`, () => {
    const fixture = viewFixture()
    const ctx = () => ({ ...fixture.context(width, height), glyphs, statusBadge })
    // Test the complete production node tree before host wrapping/clipping.
    // ASCII fixture content is unchanged; even hidden tabs and expanded bodies are checked.
    for (const page of [false, true]) {
      if (page) fixture.control.pushPage({ data: "payments" })
      for (const tab of ["summary", "diff", "logs", "actions", "stats"]) {
        fixture.state.activeTabs[fixture.widgetId("detail")] = tab
        expect(JSON.stringify(dashboardView.ui!(fixture.data, ctx()))).not.toMatch(/[^\p{ASCII}]/u)
        expect(JSON.stringify(dashboardView.title!(fixture.data, ctx()))).not.toMatch(/[^\p{ASCII}]/u)
      }
    }
  })
}

test("ASCII chrome never rewrites interpolated content or source-provided lines", () => {
  const content = "用户 · ╭─▶ résumé…"
  expect(chrome({ glyphs })`╭─ ${content} · …`).toBe(`+- ${content} . ...`)
  const fixture = viewFixture()
  fixture.details.payments!.summary = [{ kind: "text", text: content }]
  fixture.details.payments!.logs = [{ kind: "text", text: content }]
  fixture.details.payments!.notes = [{ kind: "text", text: content }]
  const ctx = { ...fixture.context(), glyphs, statusBadge }
  expect(JSON.stringify(dashboardView.ui!(fixture.data, ctx))).toContain(content)
})

test("multi-cell host rules fit frame, progress and panel cell budgets", () => {
  const fixture = viewFixture()
  const ctx = { ...fixture.context(120, 100), glyphs: { ...glyphs, rule: "--" }, statusBadge }
  const tree = timeline(fixture.data.source, { ...ctx, height: 0 })
  if (tree.type !== "tree") throw new Error("Expected timeline tree")
  const frame = tree.items[0]!.detail
  if (!frame || Array.isArray(frame) || frame.type !== "text") throw new Error("Expected frame")
  const line = frame.lines[0]!
  if (line.kind !== "segments") throw new Error("Expected semantic frame")
  expect(Bun.stringWidth(line.parts.map((part) => part.text).join(""))).toBe(ctx.width - 17)
  const progress = tree.items[1]!.row.find((part) => part.text.includes("60%"))!.text
  expect(Bun.stringWidth(progress.match(/^[=-]+/)![0])).toBe(14)
  const ui = dashboardView.ui!(fixture.data, ctx)
  if (ui.type !== "column") throw new Error("Expected dashboard column")
  const panel = ui.children.find((child) => child.size === 15)!.node
  if (panel.type !== "column") throw new Error("Expected detail panel")
  const handle = panel.children[0]!.node
  if (handle.type !== "text" || handle.lines[0]!.kind !== "segments") throw new Error("Expected handle")
  expect(Bun.stringWidth(handle.lines[0]!.parts.map((part) => part.text).join(""))).toBe(ctx.width)
})

test("host glyph overrides are used for authored separators, rails, rules and truncation", () => {
  const custom = { ...glyphs, rule: "≈", treePipe: "¦", separator: "/", more: ":" }
  expect(chrome({ glyphs: custom })`─│·…`).toBe("≈¦/:")
  // ASCII mode cuts text like the host's views: three periods, not the theme's one-cell ".".
  expect(chrome({ glyphs: { ...glyphs, rule: "~", treePipe: "!", separator: "/", more: ":" } })`─│·…`).toBe(
    "~!/...",
  )
})

test("ASCII truncation ends cut fields with the host's view ellipsis", () => {
  const fixture = viewFixture()
  fixture.data.source.snapshot().phases[0]!.name = "An extremely long phase name"
  const ctx = { ...fixture.context(180, 60), glyphs, statusBadge }
  const tree = timeline(fixture.data.source, { ...ctx, height: 0 })
  if (tree.type !== "tree") throw new Error("Expected timeline tree")
  expect(JSON.stringify(tree)).toMatch(/\.\.\./)
  expect(JSON.stringify(tree)).not.toMatch(/[^\p{ASCII}]/u)
})
