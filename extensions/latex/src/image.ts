import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { HtmlToPngRequest } from "@amira/api"

export const KATEX_VERSION = "0.16.22"
export type MathTheme = "light" | "dark"
export type RenderHtml = (req: HtmlToPngRequest) => Promise<Uint8Array>

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

/** The API does not expose the terminal palette; use its conventional background hint. */
export function terminalTheme(colorfgbg = process.env.COLORFGBG): MathTheme {
  const background = colorfgbg?.split(";").at(-1)
  return background === "7" || background === "15" ? "light" : "dark"
}

function jsString(s: string): string {
  return JSON.stringify(s).replaceAll("<", "\\u003c")
}

/** A tight card, scaled to the requested width without clipping long formulae. */
export function mathPage(source: string, width: number, theme: MathTheme): string {
  const { js, css } = katexAssets()
  const foreground = theme === "light" ? "#111" : "#eee"
  const background = theme === "light" ? "#fff" : "#181818"
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;background:${background};color:${foreground}}
#math{display:inline-block;padding:4px;box-sizing:border-box}
#formula{display:inline-block;font-size:24px}
.katex-display{margin:0}
.katex-display>.katex>.katex-html>.tag{position:static;margin-left:1em}
</style></head><body><div id="math" role="img"><div id="formula"></div></div>
<script>${js}</script><script>
window.amiraRenderDone = (async () => {
  const card = document.getElementById("math")
  const formula = document.getElementById("formula")
  const source = ${jsString(source)}
  card.setAttribute("aria-label", source)
  try {
    katex.render(source, formula, { displayMode: true, throwOnError: true, trust: false,
      strict: "warn", maxExpand: 1000, maxSize: 20, output: "html" })
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

  key(source: string, width: number, theme: MathTheme): string {
    return createHash("sha256").update(`${KATEX_VERSION}\0${width}\0${theme}\0${source}`).digest("hex")
  }

  render(source: string, width: number, theme: MathTheme, renderHtml: RenderHtml): Promise<Uint8Array> {
    const key = this.key(source, width, theme)
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const png = Promise.resolve().then(() =>
      renderHtml({ html: mathPage(source, width, theme), width, selector: "#math", timeoutMs: 10_000 }),
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
