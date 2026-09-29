import { defineTool, type ToolContext, type ToolDefinition, type ToolResult, textResult } from "@amira/api"
import type { Locator, Page } from "playwright-core"
import { type BrowserSession, type LogEntry, NoPageError, raceSignal } from "./browser.ts"
import type { UrlPolicy } from "./policy.ts"
import type { BrowserSettings } from "./settings.ts"

/** What tools need from the extension: the session's browser and the settings. */
export interface ToolEnv {
  /** The browser of the calling session, created (not started) when it has none. */
  session(ctx: ToolContext): BrowserSession
  /** The calling session's browser if it has one, without creating it. */
  existing(ctx: ToolContext): BrowserSession | undefined
  settings: BrowserSettings
  policy: UrlPolicy
}

/** Result details for presenters; never sent to the model. */
export interface BrowserDetails {
  url?: string
  title?: string
  status?: number
  image?: { width: number; height: number; bytes: number; mimeType: string }
  /** Console errors and refused requests the action caused. */
  errors?: number
  matches?: number
}

export const OPEN_TOOL = "browser_open"
export const TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_eval",
  "browser_console",
  "browser_close",
] as const

const PAGE_TEXT_CHARS = 1500
const SNAPSHOT_TEXT_CHARS = 12_000
/** Taller full-page screenshots are cut here; models scale large images down anyway. */
const MAX_SCREENSHOT_HEIGHT = 8000
/** Past this a PNG is taken again as JPEG. */
const MAX_PNG_BYTES = 3_000_000

const str = (v: unknown) => (typeof v === "string" ? v : "")
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** Colour codes in Playwright's messages. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const cap = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s

/** Playwright's messages carry a call log after a blank line; the first part says what went wrong. */
function shortError(err: unknown): string {
  const m = message(err)
    .replace(ANSI, "")
    .split(/\n\s*\n|\nCall log:/)[0] as string
  return m.replace(/^\w+\.\w+: /, "").trim()
}

async function pageState(page: Page): Promise<{ url: string; title: string }> {
  const title = await page.title().catch(() => "")
  return { url: page.url(), title }
}

const describe = (s: { url: string; title: string }) => `${s.url}${s.title ? ` — ${s.title}` : ""}`

function problemsSince(session: BrowserSession, mark: number): LogEntry[] {
  return session.log.filter(
    (e) => e.seq > mark && (e.type === "error" || e.type === "pageerror" || e.type === "blocked"),
  )
}

function problemLines(problems: LogEntry[]): string[] {
  if (!problems.length) return []
  const shown = problems.slice(-5).map((e) => `  [${e.type}] ${cap(e.text.split("\n")[0] as string, 300)}`)
  const more = problems.length > 5 ? [`  … and ${problems.length - 5} more (browser_console lists them)`] : []
  return [
    `${problems.length} new console error${problems.length === 1 ? "" : "s"} or refused request${problems.length === 1 ? "" : "s"}:`,
    ...shown,
    ...more,
  ]
}

/** Resolves a selector to one element; several matches use the first and say so. */
async function target(
  page: Page,
  selector: string,
): Promise<{ locator: Locator; note: string; matches: number }> {
  const all = page.locator(selector)
  const matches = await all.count()
  const note = matches > 1 ? ` (${matches} elements match; used the first)` : ""
  return { locator: all.first(), note, matches }
}

/** After an action: let a navigation it started get going, then report where the page is. */
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
}

type Run<P> = (p: P, session: BrowserSession, ctx: ToolContext) => Promise<ToolResult>

/**
 * Wraps a tool body: needs an open page (except where `start` is set), keeps the browser from
 * idling out while it works, and turns failures into error results the model can act on.
 */
function tool<P>(
  env: ToolEnv,
  def: Omit<ToolDefinition<P>, "execute">,
  run: Run<P>,
  opts: { start?: boolean } = {},
): ToolDefinition<P> {
  return defineTool<P>({
    ...def,
    async execute(p, ctx) {
      let session: BrowserSession | undefined
      try {
        session = opts.start ? env.session(ctx) : env.existing(ctx)
      } catch (err) {
        return textResult(message(err), true)
      }
      if (!session || (!opts.start && !session.isOpen)) return textResult(new NoPageError().message, true)
      session.touch()
      try {
        return await raceSignal(run(p ?? ({} as P), session, ctx), ctx.signal)
      } catch (err) {
        if (ctx.signal.aborted) throw err
        return textResult(shortError(err), true)
      } finally {
        session.touch()
      }
    },
  })
}

const selectorParam = {
  type: "string",
  description:
    'A Playwright selector: CSS ("#submit", "form input[name=email]"), text ("text=Sign in"), or role ("role=button[name=\\"Save\\"]"). Take names from browser_snapshot.',
}

export function browserTools(env: ToolEnv): ToolDefinition[] {
  const { settings } = env

  const open = tool<{ url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" }>(
    env,
    {
      name: OPEN_TOOL,
      description: [
        "Opens a URL in a browser (a real Chromium: JavaScript runs, like for a user) and returns the page's title, status and the start of its text.",
        "Use it to check a web app you are working on, e.g. a dev server on http://localhost:<port>, or to read a page that needs JavaScript. Localhost is allowed.",
        "The session keeps one browser with one current page; later calls navigate it. After opening, use browser_snapshot to see its structure, browser_screenshot to look at it, browser_click/browser_type/browser_select to interact, browser_eval to read state, browser_console for errors. The browser closes after a while without use, or with browser_close.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL, with its scheme, e.g. http://localhost:5173/." },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle"],
            description: 'When the page counts as opened. Default "load".',
          },
        },
        required: ["url"],
      },
    },
    async (p, session, ctx) => {
      const checked = env.policy.checkOpen(str(p.url))
      if ("refusal" in checked) return textResult(checked.refusal, true)
      const refusal = await env.policy.checkRequest(checked.url)
      if (refusal) return textResult(refusal, true)
      await session.start(ctx.signal)
      ctx.session?.loadTools(TOOL_NAMES.filter((n) => n !== OPEN_TOOL))
      const page = session.page()
      const mark = session.mark
      const waitUntil = ["load", "domcontentloaded", "networkidle"].includes(str(p.waitUntil))
        ? (p.waitUntil as "load")
        : "load"
      const response = await page.goto(checked.url, { waitUntil })
      const state = await pageState(page)
      const status = response?.status()
      const text = await page
        .evaluate(() => ((globalThis as any).document?.body?.innerText as string | undefined) ?? "")
        .catch(() => "")
      const lines = [
        `Opened ${describe(state)}${status ? ` (HTTP ${status})` : ""}`,
        ...problemLines(problemsSince(session, mark)),
        "",
        text.trim() ? `Text:\n${cap(text.trim(), PAGE_TEXT_CHARS)}` : "The page has no text.",
      ]
      const details: BrowserDetails = { ...state, errors: problemsSince(session, mark).length }
      if (status !== undefined) details.status = status
      return { content: [{ type: "text", text: lines.join("\n") }], details }
    },
    { start: true },
  )

  const snapshot = tool<{ selector?: string }>(
    env,
    {
      name: "browser_snapshot",
      description:
        'Returns the current page\'s accessibility tree as YAML: headings, links, buttons, form fields with their names and values. The cheapest way to see what is on the page and which selectors to use (e.g. role=button[name="Save"]). Pass a selector to see only part of the page.',
      parameters: {
        type: "object",
        properties: {
          selector: {
            ...selectorParam,
            description: "Only this element and what it contains. Default: the whole page.",
          },
        },
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const sel = str(p.selector).trim()
      const { locator, note } = sel ? await target(page, sel) : { locator: page.locator("body"), note: "" }
      const yaml = await locator.ariaSnapshot()
      const state = await pageState(page)
      return {
        content: [{ type: "text", text: `${describe(state)}${note}\n\n${cap(yaml, SNAPSHOT_TEXT_CHARS)}` }],
        details: state satisfies BrowserDetails,
      }
    },
  )

  const screenshot = tool<{ selector?: string; fullPage?: boolean }>(
    env,
    {
      name: "browser_screenshot",
      description: [
        "Takes a screenshot of the current page and returns it as an image: the visible viewport by default, the whole page with fullPage, or one element with a selector.",
        "Use it to check layout and styling. For text and structure, browser_snapshot is cheaper.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          selector: { ...selectorParam, description: "Only this element. Default: the viewport." },
          fullPage: {
            type: "boolean",
            description: `The whole scrollable page instead of the viewport (cut at ${MAX_SCREENSHOT_HEIGHT}px). Ignored with a selector.`,
          },
        },
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const sel = str(p.selector).trim()
      let note = ""
      const shoot = async (type: "png" | "jpeg"): Promise<Buffer> => {
        const opts = type === "jpeg" ? { type, quality: 75 } : { type }
        if (sel) {
          const t = await target(page, sel)
          note = t.note
          return t.locator.screenshot(opts)
        }
        if (!p.fullPage) return page.screenshot(opts)
        const size = await page.evaluate(() => {
          const root = (globalThis as any).document.documentElement
          return { w: root.scrollWidth as number, h: root.scrollHeight as number }
        })
        if (size.h > MAX_SCREENSHOT_HEIGHT)
          note = ` (the page is ${size.h}px tall; cut at ${MAX_SCREENSHOT_HEIGHT}px)`
        return page.screenshot({
          ...opts,
          fullPage: true,
          clip: { x: 0, y: 0, width: Math.max(1, size.w), height: Math.min(size.h, MAX_SCREENSHOT_HEIGHT) },
        })
      }
      let mimeType = "image/png"
      let data = await shoot("png")
      if (data.length > MAX_PNG_BYTES) {
        data = await shoot("jpeg")
        mimeType = "image/jpeg"
      }
      const { width, height } = imageSize(data)
      const state = await pageState(page)
      const what = sel ? `element ${sel}` : p.fullPage ? "full page" : "viewport"
      const details: BrowserDetails = { ...state, image: { width, height, bytes: data.length, mimeType } }
      return {
        content: [
          {
            type: "text",
            text: `Screenshot of the ${what} of ${describe(state)}: ${width}×${height}${note}`,
          },
          { type: "image", mimeType, data: data.toString("base64") },
        ],
        details,
      }
    },
  )

  const action = async (
    session: BrowserSession,
    page: Page,
    mark: number,
    done: string,
  ): Promise<ToolResult> => {
    await settle(page)
    const now = session.page()
    const state = await pageState(now)
    const problems = problemsSince(session, mark)
    const lines = [done, `Now at ${describe(state)}`, ...problemLines(problems)]
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { ...state, errors: problems.length } satisfies BrowserDetails,
    }
  }

  const click = tool<{ selector: string; button?: "left" | "right" | "middle"; doubleClick?: boolean }>(
    env,
    {
      name: "browser_click",
      description:
        "Clicks an element on the current page (waiting for it to be visible and enabled), then reports where the page is and any new console errors.",
      parameters: {
        type: "object",
        properties: {
          selector: selectorParam,
          button: { type: "string", enum: ["left", "right", "middle"], description: 'Default "left".' },
          doubleClick: { type: "boolean", description: "Double-click instead." },
        },
        required: ["selector"],
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const mark = session.mark
      const { locator, note } = await target(page, str(p.selector))
      const button = p.button === "right" || p.button === "middle" ? p.button : "left"
      if (p.doubleClick) await locator.dblclick({ button })
      else await locator.click({ button })
      return action(session, page, mark, `Clicked ${str(p.selector)}${note}`)
    },
  )

  const type = tool<{ selector: string; text: string; append?: boolean; submit?: boolean }>(
    env,
    {
      name: "browser_type",
      description:
        "Types text into an input, textarea or contenteditable element on the current page. It replaces what the field holds unless append is set; submit presses Enter afterwards.",
      parameters: {
        type: "object",
        properties: {
          selector: selectorParam,
          text: { type: "string" },
          append: {
            type: "boolean",
            description: "Type after the current content, key by key, instead of replacing it.",
          },
          submit: { type: "boolean", description: "Press Enter afterwards, e.g. to submit a form." },
        },
        required: ["selector", "text"],
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const mark = session.mark
      const { locator, note } = await target(page, str(p.selector))
      const text = str(p.text)
      if (p.append) await locator.pressSequentially(text)
      else await locator.fill(text)
      if (p.submit) await locator.press("Enter")
      const done = `Typed ${text.length} character${text.length === 1 ? "" : "s"} into ${str(p.selector)}${note}${p.submit ? " and pressed Enter" : ""}`
      return action(session, page, mark, done)
    },
  )

  const select = tool<{ selector: string; values: string[] | string }>(
    env,
    {
      name: "browser_select",
      description:
        "Chooses options of a <select> element on the current page, by value or by visible label. Pass several for a multiple select.",
      parameters: {
        type: "object",
        properties: {
          selector: selectorParam,
          values: { type: "array", items: { type: "string" }, description: "Option values or labels." },
        },
        required: ["selector", "values"],
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const mark = session.mark
      const wanted = (Array.isArray(p.values) ? p.values : [p.values]).filter((v) => typeof v === "string")
      if (!wanted.length) return textResult("values must list at least one option", true)
      const { locator, note } = await target(page, str(p.selector))
      // By value first; options matched by label otherwise.
      // Page-side functions: typed loosely, the DOM types are not part of this program.
      const options = await locator.evaluate((el: any, want: string[]) => {
        if (el?.tagName !== "SELECT") return null
        const all: { value: string; label: string }[] = [...el.options]
        return want.map((w) => {
          const o = all.find((x) => x.value === w) ?? all.find((x) => x.label.trim() === w.trim())
          return o ? o.value : null
        })
      }, wanted)
      if (options === null) return textResult(`${str(p.selector)} is not a <select> element`, true)
      const missing = wanted.filter((_, i) => options[i] === null)
      if (missing.length) {
        const all = await locator.evaluate((el: any) =>
          ([...el.options] as { value: string; label: string }[]).map((o) =>
            o.label === o.value ? o.value : `${o.value} (${o.label})`,
          ),
        )
        return textResult(
          `No option matches ${missing.map((m) => JSON.stringify(m)).join(", ")}. Options: ${all.join(", ")}`,
          true,
        )
      }
      const chosen = await locator.selectOption(options as string[])
      return action(session, page, mark, `Selected ${chosen.join(", ")} in ${str(p.selector)}${note}`)
    },
  )

  const evaluate = tool<{ expression: string }>(
    env,
    {
      name: "browser_eval",
      description: [
        "Evaluates a JavaScript expression in the current page and returns its value as JSON (awaited if it is a promise; a function is called with no arguments).",
        "For reading state: element counts, computed styles, localStorage, app state. Do not change the page with it; use browser_click, browser_type and browser_select, which act like a user.",
        `The result is cut at ${settings.maxEvalChars} characters; return only what you need. DOM nodes are not returned: map them to strings or plain objects.`,
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              'E.g. "document.querySelectorAll(\'li\').length" or "() => [...document.links].map(a => a.href)".',
          },
        },
        required: ["expression"],
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const page = session.page()
      const expression = str(p.expression)
      if (!expression.trim()) return textResult("expression is empty", true)
      // Through a handle: a function value is then called instead of coming back as undefined.
      const evaluated = (async () => {
        const handle = await page.evaluateHandle(expression)
        try {
          return await handle.evaluate((v: unknown) => (typeof v === "function" ? v() : v))
        } finally {
          await handle.dispose().catch(() => {})
        }
      })()
      let timer: ReturnType<typeof setTimeout> | undefined
      const value = await Promise.race([
        evaluated,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`the expression did not finish within ${settings.actionTimeoutMs / 1000}s`)),
            settings.actionTimeoutMs,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      let json: string
      try {
        json = value === undefined ? "undefined" : (JSON.stringify(value, null, 2) ?? String(value))
      } catch (err) {
        return textResult(`the value cannot be turned into JSON: ${message(err)}`, true)
      }
      return {
        content: [{ type: "text", text: cap(json, settings.maxEvalChars) }],
        details: { url: page.url() } satisfies BrowserDetails,
      }
    },
  )

  const consoleTool = tool<{ level?: "all" | "warning" | "error"; limit?: number; clear?: boolean }>(
    env,
    {
      name: "browser_console",
      description:
        "Lists the browser's recent console messages, uncaught page errors, dialogs (dismissed automatically) and requests refused by the browser settings, oldest first.",
      parameters: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: ["all", "warning", "error"],
            description:
              '"error": errors, page errors and refused requests; "warning": those and warnings. Default "all".',
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "The most recent this many. Default 50.",
          },
          clear: { type: "boolean", description: "Forget the listed messages afterwards." },
        },
      },
      exposure: "deferred",
    },
    async (p, session) => {
      const errors = new Set(["error", "pageerror", "blocked"])
      const keep = (e: LogEntry) =>
        p.level === "error"
          ? errors.has(e.type)
          : p.level === "warning"
            ? errors.has(e.type) || e.type === "warning"
            : true
      const limit = Number.isInteger(p.limit) ? Math.min(300, Math.max(1, p.limit as number)) : 50
      const matching = session.log.filter(keep)
      const shown = matching.slice(-limit)
      if (p.clear) session.log.splice(0, session.log.length)
      if (!shown.length) return textResult("No console messages.")
      const lines = shown.map((e) => `[${e.type}] ${e.text}${e.where ? `  (${e.where})` : ""}`)
      const head = matching.length > shown.length ? `Last ${shown.length} of ${matching.length}:\n` : ""
      return {
        content: [{ type: "text", text: head + lines.join("\n") }],
        details: { matches: shown.length } satisfies BrowserDetails,
      }
    },
  )

  const close = defineTool<Record<string, never>>({
    name: "browser_close",
    description: "Closes the browser. The next browser_open starts a fresh one (no cookies or storage kept).",
    parameters: { type: "object", properties: {} },
    exposure: "deferred",
    async execute(_p, ctx) {
      const session = env.existing(ctx)
      if (!session?.isOpen) return textResult("No browser is open.")
      await session.close("closed by the model")
      return textResult("Closed the browser.")
    },
  })

  return [open, snapshot, screenshot, click, type, select, evaluate, consoleTool, close] as ToolDefinition[]
}

/** Width and height from a PNG or JPEG header. */
export function imageSize(buf: Uint8Array): { width: number; height: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf[0] === 0x89 && buf[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) }
  // JPEG: walk the segments to a start-of-frame marker.
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) break
    const marker = buf[i + 1] as number
    const len = v.getUint16(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) }
    i += 2 + len
  }
  return { width: 0, height: 0 }
}

export { NoPageError }
