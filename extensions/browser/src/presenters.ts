import type { ToolCallView, ToolLine, ToolPresenter } from "@amira/api"
import type { BrowserDetails } from "./tools.ts"

/** How the browser tools' calls are shown (D1): the argument that matters, then the outcome. */

const str = (v: unknown) => (typeof v === "string" ? v : "")
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function details(call: ToolCallView<any, unknown>): BrowserDetails {
  const d = call.result.details
  return d && typeof d === "object" ? (d as BrowserDetails) : {}
}

const textLines = (text: string): ToolLine[] => text.split("\n").map((t) => ({ kind: "code", text: t }))

/** "· 2 errors" when the action logged console errors or refused requests. */
const errors = (d: BrowserDetails) => (d.errors ? ` · ${d.errors} error${d.errors === 1 ? "" : "s"}` : "")

const title = (d: BrowserDetails) => (d.title ? clip(d.title, 50) : d.url ? clip(d.url) : undefined)

/** Where the page ended up, for actions: its title (or URL), and console errors. */
function landed(call: ToolCallView<any, unknown>): string | undefined {
  if (call.result.isError) return undefined
  const d = details(call)
  const t = title(d)
  return t ? `${t}${errors(d)}` : undefined
}

const fullText: ToolPresenter["body"] = (call, { detail }) =>
  detail === "full" && !call.result.isError ? textLines(call.text) : []

export const browserPresenters: Record<string, ToolPresenter<any, any>> = {
  browser_open: {
    summary: (a) => str(a.url),
    result(call) {
      if (call.result.isError) return undefined
      const d = details(call)
      const status = d.status && (d.status < 200 || d.status >= 300) ? ` · HTTP ${d.status}` : ""
      return `${title(d) ?? "opened"}${status}${errors(d)}`
    },
    body: fullText,
  },
  browser_snapshot: {
    summary: (a) => str(a.selector),
    result: (call) => (call.result.isError ? undefined : `${call.text.split("\n").length} lines`),
    body: fullText,
  },
  browser_screenshot: {
    summary: (a) => [str(a.selector), a.fullPage ? "full page" : ""].filter(Boolean).join(" · "),
    result(call) {
      if (call.result.isError) return undefined
      const img = details(call).image
      if (!img) return undefined
      const kb = Math.max(1, Math.round(img.bytes / 1024))
      return `${img.width}×${img.height} ${img.mimeType.replace("image/", "")} · ${kb} KB`
    },
  },
  browser_click: { summary: (a) => clip(str(a.selector)), result: landed },
  browser_type: {
    summary: (a) => `${clip(str(a.selector), 40)} ← "${clip(str(a.text), 30)}"${a.submit ? " ⏎" : ""}`,
    result: landed,
  },
  browser_select: {
    summary: (a) =>
      `${clip(str(a.selector), 40)} ← ${(Array.isArray(a.values) ? a.values : [a.values]).map(str).join(", ")}`,
    result: landed,
  },
  browser_eval: {
    summary: (a) => clip(str(a.expression).replace(/\s+/g, " "), 70),
    result: (call) => (call.result.isError ? undefined : clip(call.text.replace(/\s+/g, " "), 70)),
    body: fullText,
  },
  browser_console: {
    summary: (a) => (a.level && a.level !== "all" ? str(a.level) : ""),
    result(call) {
      if (call.result.isError) return undefined
      const n = details(call).matches ?? 0
      return n ? `${n} message${n === 1 ? "" : "s"}` : "no messages"
    },
    body: fullText,
  },
  browser_close: {},
}
