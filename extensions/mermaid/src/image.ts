import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { HtmlToPngRequest } from "@amira/api"

/** The mermaid version bundled in vendor/, for the README and a render's cache key. */
export const MERMAID_VERSION = "12.0.0"

export type MermaidTheme = "default" | "neutral" | "dark" | "forest"

/** The page's width in CSS pixels: the diagram is scaled down to the terminal by Amira. */
const PAGE_WIDTH = 900

let script: string | undefined

/** mermaid.min.js as bundled with the extension (read once): never fetched at run time. */
export function mermaidScript(): string {
  script ??= readFileSync(new URL("../vendor/mermaid.min.js", import.meta.url), "utf8")
    // Inline in the page: nothing in it may end the <script> element early.
    .replace(/<\/(script)/gi, "<\\/$1")
  return script
}

/** A string as a JavaScript literal that is safe inside an inline <script>. */
function jsString(s: string): string {
  // Since ES2019 a string literal may hold U+2028 and U+2029; only </ must not appear.
  return JSON.stringify(s).replaceAll("<", `${String.fromCharCode(92)}u003c`)
}

/**
 * The self-contained page that draws a diagram: mermaid inline, strict security (no scripts
 * or links from the diagram, no HTML labels), on a white card the size of the diagram.
 * `window.amiraRenderDone` settles when it is drawn, and rejects with mermaid's error.
 */
export function diagramPage(source: string, theme: MermaidTheme, js = mermaidScript()): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
#diagram{display:inline-block;padding:12px;background:#fff}
</style></head><body><div id="diagram"></div>
<script>${js}</script>
<script>
window.amiraRenderDone = (async () => {
  const m = globalThis.mermaid || (globalThis.__esbuild_esm_mermaid_nm && globalThis.__esbuild_esm_mermaid_nm.mermaid.default)
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${jsString(theme)}, htmlLabels: false, flowchart: { htmlLabels: false } })
  let svg
  try {
    svg = (await m.render("amira-diagram", ${jsString(source)})).svg
  } catch (err) {
    throw new Error(${jsString(DIAGRAM_ERROR)} + (err && err.message ? err.message : String(err)))
  }
  document.getElementById("diagram").innerHTML = svg
})()
</script></body></html>`
}

/** How the page says mermaid could not draw the diagram (the diagram's fault, not the browser's). */
const DIAGRAM_ERROR = "mermaid could not draw the diagram: "

/** Whether a failed render was mermaid refusing the diagram, rather than the browser or the page failing. */
export function isDiagramError(message: string): boolean {
  return message.includes(DIAGRAM_ERROR)
}

/** Renders HTML to a PNG: the browser extension's service. */
export type RenderHtml = (req: HtmlToPngRequest) => Promise<Uint8Array>

/** PNGs kept, by the hash of what they show. */
const KEPT = 64

/**
 * Diagrams rendered to PNGs through the browser extension, each once per source and theme
 * (by their hash): the same diagram in another reply, a redraw at another width, or the
 * transcript drawn again costs nothing. A diagram mermaid cannot draw is kept as such too, so
 * it is not tried again and again.
 */
export class DiagramImages {
  private cache = new Map<string, Promise<Uint8Array>>()

  key(source: string, theme: MermaidTheme): string {
    return createHash("sha256").update(`${MERMAID_VERSION}\0${theme}\0${source}`).digest("hex")
  }

  render(source: string, theme: MermaidTheme, renderHtml: RenderHtml): Promise<Uint8Array> {
    const key = this.key(source, theme)
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const png = renderHtml({
      html: diagramPage(source, theme),
      width: PAGE_WIDTH,
      selector: "#diagram",
      timeoutMs: 20_000,
    })
    this.cache.set(key, png)
    // Only mermaid refusing the diagram is kept: a browser that failed to start, or was slow,
    // gets another chance next time.
    png.catch((err) => {
      if (!isDiagramError(err instanceof Error ? err.message : String(err)) && this.cache.get(key) === png)
        this.cache.delete(key)
    })
    for (const k of this.cache.keys()) {
      if (this.cache.size <= KEPT) break
      this.cache.delete(k)
    }
    return png
  }
}
