import {
  defineExtension,
  type ExtensionAPI,
  type MarkdownRendererDefinition,
  type Settings,
  type ToolLine,
} from "@amira/api"
import { isMathError, MathImages, type MathTheme, type RenderHtml, terminalTheme } from "./image.ts"
import { latexToText } from "./text.ts"

export { KATEX_VERSION, MathImages, mathPage, terminalTheme } from "./image.ts"
export { latexToText } from "./text.ts"

export interface LatexSettings {
  mode: "auto" | "text" | "image"
  /** Maximum picture width in CSS pixels (16–4096). */
  maxWidth: number
}

export function readSettings(settings: Readonly<Settings> | undefined): LatexSettings {
  const s = (settings?.extensions as Record<string, unknown> | undefined)?.latex as
    | Record<string, unknown>
    | undefined
  const mode = s?.mode === "text" || s?.mode === "image" ? s.mode : "auto"
  const maxWidth =
    typeof s?.maxWidth === "number" && Number.isFinite(s.maxWidth) && s.maxWidth >= 16 && s.maxWidth <= 4096
      ? Math.round(s.maxWidth)
      : 900
  return { mode, maxWidth }
}

export interface LatexOptions {
  settings?: LatexSettings
  renderHtml?: () => RenderHtml | undefined
  images?: MathImages
  theme?: () => MathTheme
  term?: () => string | undefined
}

const LANGUAGES = ["math", "latex", "tex"]
/** Longer sources stay text: the browser would be asked to typeset a page-sized formula. */
const MAX_PICTURE_SOURCE = 20_000
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Wrap rather than let core cut the end of a formula. Never split a grapheme. */
function textResult(source: string, width: number): { lines: ToolLine[] } {
  const lines: ToolLine[] = []
  for (const line of latexToText(source).split("\n")) {
    let row = ""
    let columns = 0
    for (const { segment } of segmenter.segment(line)) {
      const size = Bun.stringWidth(segment)
      if (columns + size > Math.max(1, width) && row) {
        lines.push({ text: row, kind: "text" })
        row = ""
        columns = 0
      }
      row += segment
      columns += size
    }
    lines.push({ text: row, kind: "text" })
  }
  return { lines }
}

/** Core calls this only for complete fences or math; streaming source is left to Markdown. */
export function latexRenderer(api: ExtensionAPI, opts: LatexOptions = {}): MarkdownRendererDefinition {
  const settings = opts.settings ?? readSettings(api.settings)
  const images = opts.images ?? new MathImages()
  const renderHtml = opts.renderHtml ?? (() => api.useService("browser.renderHtmlToPng"))
  const theme = opts.theme ?? terminalTheme
  const term = opts.term ?? (() => process.env.TERM)
  let reported = false
  return {
    id: "latex",
    match: { codeLang: LANGUAGES },
    waitMs: 12_000,
    render(node, ctx) {
      if (node.type === "math" && !node.display) {
        return { segments: [{ text: latexToText(node.source).replace(/\r?\n/g, " "), kind: "text" }] }
      }
      if (node.type !== "math" && (node.type !== "code" || !LANGUAGES.includes(node.lang.toLowerCase())))
        return undefined
      const source = node.type === "math" ? node.source : node.code
      const text = () => textResult(source, ctx.width)
      const pictures =
        settings.mode !== "text" && source.length <= MAX_PICTURE_SOURCE && ctx.images && term() !== "dumb"
      const render = pictures ? renderHtml() : undefined
      if (!render) return text()
      // Pixel cell sizes are not exposed by the API; core fits the resulting PNG to the terminal.
      const width = Math.max(16, Math.min(settings.maxWidth, Math.floor(ctx.width * 10)))
      return images.render(source, width, ctx.theme ?? theme(), render).then(
        (data) => ({ image: { data, mimeType: "image/png" }, alt: source, fallback: text().lines }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (!isMathError(message) && !reported) {
            reported = true
            api.reportError(`latex: rendering math to an image failed: ${message}`)
          }
          return text()
        },
      )
    },
  }
}

export default defineExtension((api) => {
  const renderer = latexRenderer(api)
  api.registerMarkdownRenderer(renderer)
  api.registerMarkdownRenderer({ ...renderer, id: "latex-math", match: { math: "both" } })
})
