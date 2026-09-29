import { expect, test } from "bun:test"
import type { ExtensionAPI, HtmlToPngRequest, MarkdownNode, MarkdownRendererDefinition } from "@amira/api"
import { mermaidScript } from "../src/image.ts"
import extension, { DiagramImages, diagramPage, mermaidRenderer, readSettings } from "../src/index.ts"

const FLOW = "flowchart LR\n  A[Start] --> B[End]"
const PIE = 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85'
const node = (code: string): MarkdownNode => ({ type: "code", lang: "mermaid", info: "mermaid", code })

function setup(o: { mode?: "auto" | "text" | "image"; browser?: boolean; fail?: string } = {}) {
  const renders: HtmlToPngRequest[] = []
  const errors: string[] = []
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const service = async (req: HtmlToPngRequest) => {
    renders.push(req)
    if (o.fail) throw new Error(o.fail)
    return png
  }
  const api = {
    settings: { extensions: { mermaid: { mode: o.mode ?? "auto" } } },
    useService: (name: string) => (o.browser && name === "browser.renderHtmlToPng" ? service : undefined),
    reportError: (e: string) => errors.push(e),
  } as unknown as ExtensionAPI
  const r = mermaidRenderer(api)
  const render = (code: string, images: boolean, width = 60) =>
    r.render(node(code), { width, images, maxImageRows: 20 })
  return { r, render, renders, errors, png }
}

test("settings: mode and theme, defaults for anything else", () => {
  expect(readSettings(undefined)).toEqual({ mode: "auto", theme: "default" })
  expect(readSettings({ extensions: { mermaid: { mode: "image", theme: "dark" } } } as never)).toEqual({
    mode: "image",
    theme: "dark",
  })
  expect(readSettings({ extensions: { mermaid: { mode: "svg", theme: "pink" } } } as never)).toEqual({
    mode: "auto",
    theme: "default",
  })
})

test("auto: flowcharts and sequence diagrams as text; other types as an image when it can be drawn", async () => {
  const s = setup({ browser: true })
  const flow = s.render(FLOW, true) as { lines: { text: string }[] }
  expect(flow.lines.length).toBeGreaterThan(0)
  expect(flow.lines.map((l) => l.text).join("\n")).toContain("Start")
  expect(s.renders).toEqual([])
  expect(await s.render(PIE, true)).toEqual({ image: { data: s.png } })
  expect(s.renders).toHaveLength(1)
  expect(s.renders[0]).toMatchObject({ width: 900, selector: "#diagram" })
  // Where images are not drawn (no images extension, or a terminal without graphics): code.
  expect(s.render(PIE, false)).toBeUndefined()
  // No browser extension: code too.
  expect(setup({ browser: false }).render(PIE, true)).toBeUndefined()
  expect(s.render("", true)).toBeUndefined()
})

test("image: everything as an image where it can be; text: never an image", async () => {
  const image = setup({ mode: "image", browser: true })
  expect(await image.render(FLOW, true)).toEqual({ image: { data: image.png } })
  // Where it cannot be drawn, the text layout still serves.
  expect((image.render(FLOW, false) as { lines: unknown[] }).lines.length).toBeGreaterThan(0)
  const text = setup({ mode: "text", browser: true })
  expect(text.render(PIE, true)).toBeUndefined()
  expect((text.render(FLOW, true) as { lines: unknown[] }).lines.length).toBeGreaterThan(0)
  expect(text.renders).toEqual([])
})

test("renders are cached by the diagram's hash; a failed image falls back, and a broken browser is reported once", async () => {
  const s = setup({ browser: true })
  await s.render(PIE, true)
  await s.render(PIE, true)
  await s.render(`${PIE}\n`, true)
  expect(s.renders).toHaveLength(2)
  const bad = setup({ mode: "image", browser: true, fail: "Chrome did not start within 30s" })
  const out = (await bad.render(FLOW, true)) as { lines: unknown[] }
  expect(out.lines.length).toBeGreaterThan(0)
  expect(await bad.render(PIE, true)).toBeUndefined()
  expect(bad.errors).toEqual([
    "mermaid: rendering a diagram to an image failed: Chrome did not start within 30s",
  ])
  // Mermaid failing on the diagram is the diagram's problem: code, and nothing reported.
  const syntax = setup({ browser: true, fail: "the page failed: Parsing failed" })
  expect(await syntax.render(PIE, true)).toBeUndefined()
  expect(syntax.errors).toEqual([])
  expect(new DiagramImages().key(PIE, "default")).not.toBe(new DiagramImages().key(PIE, "dark"))
})

test("the page: mermaid bundled inline, the source as a safe literal, strict security, no network", () => {
  const js = mermaidScript()
  expect(js.length).toBeGreaterThan(1_000_000)
  expect(js).not.toMatch(/<\/script/i)
  const page = diagramPage('graph TD\n  A["</script><script>alert(1)</script>"]', "dark", "/*mermaid*/")
  expect(page).not.toContain("</script><script>alert(1)")
  expect(page).toContain('securityLevel: "strict"')
  expect(page).toContain('theme: "dark"')
  expect(page).not.toMatch(/<script[^>]+src=|<link|https?:\/\/(?!www\.w3\.org)/)
})

test("the extension registers its renderer for ```mermaid", async () => {
  const renderers: MarkdownRendererDefinition[] = []
  await extension({
    settings: {},
    registerMarkdownRenderer: (r: MarkdownRendererDefinition) => renderers.push(r),
  } as unknown as ExtensionAPI)
  expect(renderers.map((r) => [r.id, r.match])).toEqual([["mermaid", { codeLang: ["mermaid"] }]])
})
