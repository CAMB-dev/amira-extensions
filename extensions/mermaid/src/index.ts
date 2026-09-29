import { createHash } from "node:crypto"
import {
  defineExtension,
  type ExtensionAPI,
  type MarkdownRenderContext,
  type MarkdownRendererDefinition,
  type MarkdownRenderResult,
  type Settings,
} from "@amira/api"
import { DiagramImages, type MermaidTheme, type RenderHtml } from "./image.ts"
import { type DiagramLine, diagramType, renderMermaidText } from "./text/index.ts"

export { DiagramImages, diagramPage, MERMAID_VERSION } from "./image.ts"
export { diagramType, renderMermaidText } from "./text/index.ts"

/**
 * How diagrams are drawn: "text" as Unicode diagrams only (other types stay code), "image" as
 * pictures wherever they can be, "auto" (the default) text for the types it lays out and
 * pictures for the others.
 */
export type MermaidMode = "auto" | "text" | "image"

export interface MermaidSettings {
  mode: MermaidMode
  theme: MermaidTheme
}

const THEMES: readonly MermaidTheme[] = ["default", "neutral", "dark", "forest"]

/** The `extensions.mermaid` settings, with defaults for what is missing or not understood. */
export function readSettings(settings: Readonly<Settings> | undefined): MermaidSettings {
  const s = (settings?.extensions as Record<string, unknown> | undefined)?.mermaid as
    | Record<string, unknown>
    | undefined
  const mode = s?.mode === "text" || s?.mode === "image" ? s.mode : "auto"
  const theme = THEMES.includes(s?.theme as MermaidTheme) ? (s!.theme as MermaidTheme) : "default"
  return { mode, theme }
}

/** Types there is a text layout for. */
const TEXT_TYPES = new Set(["flowchart", "sequence"])

export interface MermaidOptions {
  settings?: MermaidSettings
  /** The browser's render service; by default looked up when a diagram needs it. */
  renderHtml?: () => RenderHtml | undefined
  images?: DiagramImages
}

/**
 * The renderer of ```mermaid blocks: flowcharts and sequence diagrams as Unicode diagrams that
 * fit the width; other types (and all of them in "image" mode) as a PNG the browser extension
 * renders, when the images extension can draw it here; else the block stays code.
 */
export function mermaidRenderer(api: ExtensionAPI, opts: MermaidOptions = {}): MarkdownRendererDefinition {
  const settings = opts.settings ?? readSettings(api.settings)
  const images = opts.images ?? new DiagramImages()
  const renderHtml = opts.renderHtml ?? (() => api.useService("browser.renderHtmlToPng"))
  let reported = false
  /** Text layouts by the hash of their source, and the width. */
  const layouts = new Map<string, DiagramLine[] | undefined>()
  const text = (source: string, width: number): MarkdownRenderResult | undefined => {
    const key = `${createHash("sha256").update(source).digest("hex")}:${width}`
    let lines = layouts.get(key)
    if (lines === undefined && !layouts.has(key)) {
      lines = renderMermaidText(source, width)
      layouts.set(key, lines)
      for (const k of layouts.keys()) {
        if (layouts.size <= 256) break
        layouts.delete(k)
      }
    }
    return lines ? { lines } : undefined
  }
  const picture = async (source: string, render: RenderHtml): Promise<MarkdownRenderResult | undefined> => {
    try {
      return { image: { data: await images.render(source, settings.theme, render) } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A diagram mermaid cannot parse is the model's; the browser failing is worth saying once.
      if (!/the page failed/.test(message) && !reported) {
        reported = true
        api.reportError(`mermaid: rendering a diagram to an image failed: ${message}`)
      }
      return undefined
    }
  }
  return {
    id: "mermaid",
    match: { codeLang: ["mermaid"] },
    // The first picture starts a browser: a few seconds.
    waitMs: 12_000,
    render(node, ctx: MarkdownRenderContext) {
      if (node.type !== "code") return undefined
      const type = diagramType(node.code)
      if (!type) return undefined
      const textual = TEXT_TYPES.has(type)
      const render = settings.mode !== "text" && ctx.images ? renderHtml() : undefined
      const wantPicture = render && (settings.mode === "image" || !textual)
      if (wantPicture) {
        return picture(node.code, render).then((r) => r ?? (textual ? text(node.code, ctx.width) : undefined))
      }
      return textual ? text(node.code, ctx.width) : undefined
    },
  }
}

export default defineExtension((api) => {
  api.registerMarkdownRenderer(mermaidRenderer(api))
})
