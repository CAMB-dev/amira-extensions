import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type {
  ExtensionAPI,
  HtmlToPngRequest,
  MarkdownNode,
  MarkdownRenderContext,
  MarkdownRendererDefinition,
} from "@amira/api"
import extension, { latexRenderer, MathImages, mathPage, readSettings, terminalTheme } from "../src/index.ts"

const SOURCE = String.raw`x^2 + \alpha \le \infty`
const TEXT = { lines: [{ text: "x² + α ≤ ∞", kind: "text" as const }] }
const node = (code = SOURCE, lang = "math"): MarkdownNode => ({ type: "code", lang, info: lang, code })
const math = (display = true, source = SOURCE): MarkdownNode => ({ type: "math", display, source })
const ctx = { width: 80, images: true, maxImageRows: 20, theme: { dark: true } }

function setup(
  o: {
    mode?: "auto" | "text" | "image"
    browser?: boolean
    fail?: string
    term?: string
    maxWidth?: number
  } = {},
) {
  const renders: HtmlToPngRequest[] = []
  const errors: string[] = []
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const service = async (req: HtmlToPngRequest) => {
    renders.push(req)
    if (o.fail) throw new Error(o.fail)
    return png
  }
  let lookups = 0
  const api = {
    settings: { extensions: { latex: { mode: o.mode, maxWidth: o.maxWidth } } },
    useService: (name: string) => {
      lookups++
      return o.browser && name === "browser.renderHtmlToPng" ? service : undefined
    },
    reportError: (e: string) => errors.push(e),
  } as unknown as ExtensionAPI
  const theme = { value: "dark" as "dark" | "light" }
  const renderer = latexRenderer(api, { theme: () => theme.value, term: () => o.term })
  return { renderer, renders, errors, png, theme, lookups: () => lookups }
}

test("settings validate mode and maxWidth", () => {
  expect(readSettings(undefined)).toEqual({ mode: "auto", maxWidth: 900 })
  expect(readSettings({ extensions: { latex: { mode: "image", maxWidth: 640 } } } as never)).toEqual({
    mode: "image",
    maxWidth: 640,
  })
  for (const maxWidth of [null, "640", 0, 15, 4097, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(readSettings({ extensions: { latex: { mode: "svg", maxWidth } } } as never)).toEqual({
      mode: "auto",
      maxWidth: 900,
    })
  }
})

test("registers math, latex and tex fences plus inline and display math; other nodes are declined", async () => {
  const renderers: MarkdownRendererDefinition[] = []
  await extension({
    settings: {},
    registerMarkdownRenderer: (r: MarkdownRendererDefinition) => renderers.push(r),
  } as unknown as ExtensionAPI)
  expect(renderers.map((r) => [r.id, r.match])).toEqual([
    ["latex", { codeLang: ["math", "latex", "tex"] }],
    ["latex-math", { math: "both" }],
  ])
  // Core strips $$…$$ / \\[…\\] and $…$ / \\(…\\) before passing these nodes.
  expect(renderers[1]!.render(math(), { ...ctx, images: false })).toEqual(TEXT)
  expect(renderers[1]!.render(math(false), ctx)).toEqual({ segments: TEXT.lines })
  const { renderer } = setup()
  for (const lang of ["math", "latex", "tex", "LaTeX"])
    expect(renderer.render(node(SOURCE, lang), ctx)).toEqual(TEXT)
  expect(renderer.render(node(SOURCE, "typescript"), ctx)).toBeUndefined()
  expect(renderer.render({ type: "image", url: "x.png", alt: "math" }, ctx)).toBeUndefined()
})

test("auto and image use the browser; source, width and theme distinguish cached pictures", async () => {
  for (const mode of ["auto", "image"] as const) {
    const s = setup({ mode, browser: true, maxWidth: 700 })
    const result = { image: { data: s.png, mimeType: "image/png" }, alt: SOURCE, fallback: TEXT.lines }
    expect(await s.renderer.render(node(), ctx)).toEqual(result)
    expect(await s.renderer.render(node(), ctx)).toEqual(result)
    expect(s.renders).toHaveLength(1)
    expect(s.renders[0]).toMatchObject({ width: 700, selector: "#math", timeoutMs: 10_000 })
    expect(s.renders[0]!.html).toContain('document.body.style.color = "#eee"')
    await s.renderer.render(node(), { ...ctx, width: 30 })
    expect(s.renders[1]!.width).toBe(300)
    await s.renderer.render(node(), { ...ctx, theme: { dark: false } })
    expect(s.renders[2]!.html).toContain('document.body.style.color = "#111"')
    await s.renderer.render(node("y^2"), ctx)
    expect(s.renders).toHaveLength(4)
  }
})

test("text mode, print mode (images:false) and TERM=dumb never look up the browser", () => {
  for (const options of [{ mode: "text" as const }, { term: "dumb" }, {}, { mode: "image" as const }]) {
    const s = setup({ ...options, browser: true })
    const images = options.mode === "text" || options.term === "dumb"
    for (const block of [node(), math()]) expect(s.renderer.render(block, { ...ctx, images })).toEqual(TEXT)
    expect(s.renderer.render(math(false), { ...ctx, images })).toEqual({ segments: TEXT.lines })
    expect(s.lookups()).toBe(0)
    expect(s.renders).toEqual([])
  }
  expect(setup().renderer.render(node(), ctx)).toEqual(TEXT)
  expect(setup().renderer.render(math(), ctx)).toEqual(TEXT)
})

test("inline math always returns synchronous, unwrapped Unicode segments without image work", () => {
  for (const mode of ["auto", "text", "image"] as const) {
    const s = setup({ mode, browser: true })
    expect(s.renderer.render(math(false), { ...ctx, width: 3 })).toEqual({ segments: TEXT.lines })
    expect(s.renderer.render(math(false, String.raw`x^2\\y_1`), ctx)).toEqual({
      segments: [{ text: "x² y₁", kind: "text" }],
    })
    expect(s.lookups()).toBe(0)
    expect(s.renders).toEqual([])
  }
})

test("display math uses pictures with source alt and width-wrapped Unicode fallback, like fences", async () => {
  const s = setup({ browser: true })
  const context = { ...ctx, width: 3 }
  const result = await s.renderer.render(math(), context)
  expect(result).toEqual({
    image: { data: s.png, mimeType: "image/png" },
    alt: SOURCE,
    fallback: [
      { text: "x² ", kind: "text" },
      { text: "+ α", kind: "text" },
      { text: " ≤ ", kind: "text" },
      { text: "∞", kind: "text" },
    ],
  })
  expect(await s.renderer.render(node(), context)).toEqual(result)
  expect(s.renders).toHaveLength(1)
  const failure = setup({ browser: true, fail: "browser unavailable" })
  expect(await failure.renderer.render(math(), ctx)).toEqual(TEXT)
})

test("very long sources stay text and never reach the browser", () => {
  const s = setup({ browser: true })
  const result = s.renderer.render(node("x+".repeat(10_001)), { ...ctx, images: true })
  expect(result).toHaveProperty("lines")
  expect(s.renders).toEqual([])
})

test("text wraps instead of losing the end of a formula", () => {
  const { renderer } = setup()
  expect(renderer.render(node("x^2 + y^2"), { ...ctx, width: 3 })).toEqual({
    lines: [
      { text: "x² ", kind: "text" },
      { text: "+ y", kind: "text" },
      { text: "²", kind: "text" },
    ],
  })
  expect(renderer.render(node(""), ctx)).toEqual({ lines: [{ text: "", kind: "text" }] })
})

test("picture failures fall back to Unicode; infrastructure errors are reported once and retry", async () => {
  const s = setup({ browser: true, fail: "browser unavailable" })
  expect(await s.renderer.render(node(), ctx)).toEqual(TEXT)
  expect(await s.renderer.render(node(), ctx)).toEqual(TEXT)
  expect(s.renders).toHaveLength(2)
  expect(s.errors).toEqual(["latex: rendering math to an image failed: browser unavailable"])
  const syntax = setup({ browser: true, fail: "the page failed: latex could not render math: bad command" })
  expect(await syntax.renderer.render(node(), ctx)).toEqual(TEXT)
  expect(await syntax.renderer.render(node(), ctx)).toEqual(TEXT)
  expect(syntax.renders).toHaveLength(1)
  expect(syntax.errors).toEqual([])
})

test("image cache shares in-flight work, bounds retained entries and catches synchronous failures", async () => {
  const images = new MathImages()
  let calls = 0
  const service = async () => {
    calls++
    return new Uint8Array([1])
  }
  const first = images.render("x", 400, "dark", service)
  expect(images.render("x", 400, "dark", service)).toBe(first)
  await first
  expect(calls).toBe(1)
  for (let n = 0; n < 64; n++) await images.render(String(n), 400, "dark", service)
  await images.render("x", 400, "dark", service)
  expect(calls).toBe(66)
  const fail = () => {
    throw new Error("sync failure")
  }
  await expect(images.render("sync", 400, "dark", fail)).rejects.toThrow("sync failure")
  await images.render("sync", 400, "dark", service)
  expect(calls).toBe(67)
})

test("context theme overrides the legacy hint; exact colors each distinguish cached pictures", async () => {
  const s = setup({ browser: true })
  s.theme.value = "light"
  await s.renderer.render(math(), ctx)
  expect(s.renders[0]!.html).toContain('document.body.style.color = "#eee"')
  expect(s.renders[0]!.html).toContain('document.body.style.backgroundColor = "#181818"')
  await s.renderer.render(math(), { ...ctx, theme: { dark: false } })
  expect(s.renders[1]!.html).toContain('document.body.style.backgroundColor = "#fff"')
  const theme = { dark: true, foreground: "#abcdef", background: "#123456" }
  await s.renderer.render(math(), { ...ctx, theme })
  expect(s.renders[2]!.html).toContain('document.body.style.color = "#abcdef"')
  expect(s.renders[2]!.html).toContain('document.body.style.backgroundColor = "#123456"')
  await s.renderer.render(math(), { ...ctx, theme: { ...theme, foreground: "#fedcba" } })
  expect(s.renders[3]!.html).toContain('document.body.style.color = "#fedcba"')
  await s.renderer.render(math(), { ...ctx, theme: { ...theme, background: "#654321" } })
  expect(s.renders[4]!.html).toContain('document.body.style.backgroundColor = "#654321"')
  await s.renderer.render(math(), { ...ctx, theme: { ...theme } })
  expect(s.renders).toHaveLength(5)
})

test("legacy fence contexts without a theme use the fallback hint", async () => {
  const s = setup({ browser: true })
  const legacy = { width: 80, images: true, maxImageRows: 20 } as MarkdownRenderContext
  await s.renderer.render(node(), legacy)
  expect(s.renders[0]!.html).toContain('document.body.style.color = "#eee"')
  s.theme.value = "light"
  await s.renderer.render(node(), legacy)
  expect(s.renders[1]!.html).toContain('document.body.style.color = "#111"')
  expect(s.renderer.render(node(), { ...legacy, images: false })).toEqual(TEXT)
})

test("legacy theme uses the terminal background hint with a dark default", () => {
  for (const hint of ["0;7", "0;15", "0;0;15"]) expect(terminalTheme(hint)).toBe("light")
  for (const hint of ["15;0", "7;8", "", "nonsense"]) expect(terminalTheme(hint)).toBe("dark")
})

test("page is offline, safely quotes source, waits for fonts and crops scaled math", () => {
  const source = String.raw`\text{</script><script>alert(1)</script>}`
  const page = mathPage(source, 500, "light")
  expect(page).not.toContain("</script><script>alert(1)")
  expect(page).toContain('card.setAttribute("aria-label", source)')
  expect(page).toContain("trust: false")
  expect(page).toContain('strict: "warn"')
  expect(page).toContain("await document.fonts.ready")
  // Tags must contribute to the measured width instead of overlapping the formula.
  expect(page).toContain(".katex-display>.katex>.katex-html>.tag{position:static;margin-left:1em}")
  expect(page).toContain("(500 - 8)")
  expect(page).toContain('formula.style.transform = "scale("')
  expect(page).toContain("data:font/woff2;base64,")
  expect(page).not.toMatch(/<script[^>]+src=|<link|url\(fonts\//)
  const css = readFileSync(new URL("../vendor/katex.min.css", import.meta.url), "utf8")
  for (const match of css.matchAll(/url\(([^)]+)\)/g)) expect(match[1]).toStartWith("data:font/woff2;base64,")
})

test("the vendored KaTeX renders real math, and rejects invalid input", () => {
  const js = readFileSync(new URL("../vendor/katex.min.js", import.meta.url), "utf8")
  const sandbox: { katex?: { version: string; renderToString: (s: string) => string } } = {}
  runInNewContext(js, sandbox)
  expect(sandbox.katex!.version).toBe("0.16.22")
  expect(sandbox.katex!.renderToString(String.raw`\frac{\alpha}{\sqrt{x^2}}`)).toContain('class="katex"')
  expect(() => sandbox.katex!.renderToString(String.raw`\notACommand`)).toThrow()
})

test("release metadata requires API 0.1.27 and matches the extension index", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  const index = await Bun.file(new URL("../../../index.json", import.meta.url)).json()
  expect(manifest.version).toBe("0.2.0")
  expect(manifest.amira.engines).toEqual({ amira: "^0.1.27" })
  expect(index.extensions.find((entry: { name: string }) => entry.name === "latex")).toMatchObject({
    version: manifest.version,
    engines: manifest.amira.engines,
  })
})

test("public exports", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toMatchInlineSnapshot(`
    [
      "KATEX_VERSION",
      "MathImages",
      "default",
      "latexRenderer",
      "latexToText",
      "mathPage",
      "readSettings",
      "terminalTheme",
    ]
  `)
})
