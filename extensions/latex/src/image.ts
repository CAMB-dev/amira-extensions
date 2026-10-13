import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { HtmlToPngRequest, MarkdownRenderContext } from "@amira/api"

export const KATEX_VERSION = "0.16.22"
export type MathTheme = "light" | "dark" | MarkdownRenderContext["theme"]
export type RenderHtml = (req: HtmlToPngRequest) => Promise<Uint8Array>
export interface MathFormula {
  source: string
  display: boolean
}
type MathSource = string | readonly MathFormula[]

const formulasFor = (source: MathSource): readonly MathFormula[] =>
  typeof source === "string" ? [{ source, display: true }] : source

let assets: { js: string; css: string } | undefined

/** Browser renders are offline, including fonts. Load the bundled assets only for pictures. */
function katexAssets(): { js: string; css: string } {
  assets ??= {
    js: readFileSync(new URL("../vendor/katex.min.js", import.meta.url), "utf8").replace(
      /<\/(script)/gi,
      "<\\/$1",
    ),
    css: readFileSync(new URL("../vendor/katex.min.css", import.meta.url), "utf8"),
  }
  return assets
}

/** Compatibility fallback for hosts without a theme in their render context. */
export function terminalTheme(colorfgbg = process.env.COLORFGBG): MathTheme {
  const background = colorfgbg?.split(";").at(-1)
  return background === "7" || background === "15" ? "light" : "dark"
}

function jsValue(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function themeColors(theme: MathTheme): { foreground: string; background: string } {
  const palette = typeof theme === "string" ? { dark: theme === "dark" } : theme
  return {
    foreground: palette.foreground ?? (palette.dark ? "#eee" : "#111"),
    background: palette.background ?? (palette.dark ? "#181818" : "#fff"),
  }
}

/** A tight card, scaled to the requested width without clipping long formulae. */
export function mathPage(source: MathSource, width: number, theme: MathTheme, size = 16): string {
  const formulas = formulasFor(source)
  const { js, css } = katexAssets()
  const { foreground, background } = themeColors(theme)
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0}
#math{display:inline-block;padding:4px;box-sizing:border-box}
#formula{display:inline-block;font-size:${size}px}
.formula+.formula{margin-top:8px}
.katex{font-size:1em}
.katex-display{margin:0}
.katex-display>.katex>.katex-html>.tag{position:static;margin-left:1em}
</style></head><body><div id="math" role="img"><div id="formula"></div></div>
<script>${js}</script><script>
window.amiraRenderDone = (async () => {
  document.body.style.backgroundColor = ${jsValue(background)}
  document.body.style.color = ${jsValue(foreground)}
  const card = document.getElementById("math")
  const formula = document.getElementById("formula")
  const samples = ${jsValue(formulas)}
  const source = samples.map(sample => sample.source).join("\\n")
  card.setAttribute("aria-label", source)
  try {
    for (const sample of samples) {
      const element = document.createElement("div")
      element.className = "formula"
      formula.appendChild(element)
      katex.render(sample.source, element, { displayMode: sample.display, throwOnError: true, trust: false,
        strict: "warn", maxExpand: 1000, maxSize: 20, output: "html" })
    }
  } catch (err) {
    throw new Error("latex could not render math: " + (err && err.message ? err.message : String(err)))
  }
  await document.fonts.ready
  const box = formula.getBoundingClientRect()
  const scale = Math.min(1, (${width} - 8) / Math.max(1, box.width))
  formula.style.transformOrigin = "top left"
  formula.style.transform = "scale(" + scale + ")"
  card.style.width = Math.ceil(box.width * scale + 8) + "px"
  card.style.height = Math.ceil(box.height * scale + 8) + "px"
})()
</script></body></html>`
}

export function isMathError(message: string): boolean {
  return message.includes("latex could not render math: ")
}

/** Bounded LRU, including in-flight work and syntax failures; transient failures can retry. */
export class MathImages {
  private cache = new Map<string, Promise<Uint8Array>>()

  clear(): void {
    this.cache.clear()
  }

  key(source: MathSource, width: number, theme: MathTheme, size = 16): string {
    return createHash("sha256")
      .update(
        `${KATEX_VERSION}\0${width}\0${size}\0${JSON.stringify(themeColors(theme))}\0${JSON.stringify(formulasFor(source))}`,
      )
      .digest("hex")
  }

  render(
    source: MathSource,
    width: number,
    theme: MathTheme,
    renderHtml: RenderHtml,
    size = 16,
  ): Promise<Uint8Array> {
    const key = this.key(source, width, theme, size)
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const png = Promise.resolve().then(() =>
      renderHtml({ html: mathPage(source, width, theme, size), width, selector: "#math", timeoutMs: 10_000 }),
    )
    this.cache.set(key, png)
    png.catch((err) => {
      if (!isMathError(err instanceof Error ? err.message : String(err)) && this.cache.get(key) === png)
        this.cache.delete(key)
    })
    for (const k of this.cache.keys()) {
      if (this.cache.size <= 64) break
      this.cache.delete(k)
    }
    return png
  }
}
