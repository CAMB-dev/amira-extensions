import {
  defineExtension,
  type ExtensionAPI,
  type ExtensionSettingsField,
  type ExtensionSettingsValues,
  type MarkdownRenderContext,
  type MarkdownRendererDefinition,
  type MarkdownRenderResult,
  type ToolLine,
} from "@amira/api"
import {
  isMathError,
  type MathFormula,
  MathImages,
  type MathTheme,
  type RenderHtml,
  terminalTheme,
} from "./image.ts"
import { latexToText } from "./text.ts"

export { KATEX_VERSION, MathImages, mathPage, terminalTheme } from "./image.ts"
export { latexToText } from "./text.ts"

export const latexFields = [
  {
    key: "mode",
    type: "choice",
    label: "Rendering mode",
    description:
      "Auto and image try pictures for blocks when supported, with text fallback. Inline math stays text.",
    default: "auto",
    options: ["auto", "text", "image"],
  },
  {
    key: "maxWidth",
    type: "number",
    label: "Maximum image width",
    description: "Maximum width in CSS pixels. Pictures also shrink to fit the terminal.",
    default: 900,
    min: 16,
    max: 4096,
    step: 1,
  },
  {
    key: "size",
    type: "number",
    label: "Image font size",
    description: "Font size in CSS pixels. Text mode and inline math ignore this setting.",
    default: 16,
    min: 8,
    max: 64,
    step: 1,
  },
] as const satisfies readonly ExtensionSettingsField[]

export type LatexSettings = ExtensionSettingsValues<typeof latexFields>

export interface LatexOptions {
  renderHtml?: () => RenderHtml | undefined
  images?: MathImages
  theme?: () => MathTheme
  term?: () => string | undefined
}

const LANGUAGES = ["math", "latex", "tex"]
const SAMPLES: readonly MathFormula[] = [
  { source: String.raw`e^{i\pi} + 1 = 0`, display: false },
  { source: String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}`, display: true },
]
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

/** Explicit values and cache ownership keep previews separate from saved rendering. */
function renderMath(
  formulas: readonly MathFormula[],
  ctx: MarkdownRenderContext,
  settings: LatexSettings,
  images: MathImages,
  renderHtml: () => RenderHtml | undefined,
  theme: () => MathTheme,
  term: () => string | undefined,
  reportError: (message: string) => void,
): MarkdownRenderResult | Promise<MarkdownRenderResult> {
  const first = formulas[0]!
  if (formulas.length === 1 && !first.display) {
    return { segments: [{ text: latexToText(first.source).replace(/\r?\n/g, " "), kind: "text" }] }
  }
  const source = formulas.map((formula) => formula.source).join("\n")
  const text = () => ({ lines: formulas.flatMap((formula) => textResult(formula.source, ctx.width).lines) })
  const pictures =
    settings.mode !== "text" && source.length <= MAX_PICTURE_SOURCE && ctx.images && term() !== "dumb"
  const render = pictures ? renderHtml() : undefined
  if (!render) return text()
  // Core fits down (never up) using real cell pixels, so a tightly cropped PNG preserves font size.
  const width = Math.max(16, Math.min(settings.maxWidth, Math.floor(ctx.width * 10)))
  return images.render(formulas, width, ctx.theme ?? theme(), render, settings.size).then(
    (data) => ({ image: { data, mimeType: "image/png" }, alt: source, fallback: text().lines }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!isMathError(message)) reportError(message)
      return text()
    },
  )
}

/** Core calls this only for complete fences or math; streaming source is left to Markdown. */
export function latexRenderer(api: ExtensionAPI, opts: LatexOptions = {}): MarkdownRendererDefinition {
  const images = opts.images ?? new MathImages()
  const renderHtml = opts.renderHtml ?? (() => api.useService("browser.renderHtmlToPng"))
  const theme = opts.theme ?? terminalTheme
  const term = opts.term ?? (() => process.env.TERM)
  let reported = false
  const settings = api.settings.declare({
    fields: latexFields,
    preview: async (draft, ctx) => {
      ctx.signal.throwIfAborted()
      // Do not populate normal caches or change normal error-reporting state with an unsaved draft.
      const result = await renderMath(
        SAMPLES,
        ctx,
        draft,
        new MathImages(),
        renderHtml,
        theme,
        term,
        () => {},
      )
      ctx.signal.throwIfAborted()
      return result
    },
  })
  settings.onChange(() => {
    images.clear()
    api.requestRender()
  })
  return {
    id: "latex",
    match: { codeLang: LANGUAGES },
    waitMs: 12_000,
    render(node, ctx) {
      if (node.type !== "math" && (node.type !== "code" || !LANGUAGES.includes(node.lang.toLowerCase())))
        return undefined
      const formula = {
        source: node.type === "math" ? node.source : node.code,
        display: node.type === "math" ? node.display : true,
      }
      return renderMath([formula], ctx, settings.get(), images, renderHtml, theme, term, (message) => {
        if (!reported) {
          reported = true
          api.reportError(`latex: rendering math to an image failed: ${message}`)
        }
      })
    },
  }
}

export default defineExtension((api) => {
  const renderer = latexRenderer(api)
  api.registerMarkdownRenderer(renderer)
  api.registerMarkdownRenderer({ ...renderer, id: "latex-math", match: { math: "both" } })
})
