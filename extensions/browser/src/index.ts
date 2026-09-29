import { defineExtension, type ExtensionAPI, type HtmlToPngRequest, type ToolContext } from "@amira/api"
import { BrowserSession, type RenderRequest } from "./browser.ts"
import { type DetectEnv, type FoundBrowser, findBrowser } from "./detect.ts"
import { type Resolver, UrlPolicy } from "./policy.ts"
import { browserPresenters } from "./presenters.ts"
import { type BrowserSettings, ignoredProjectKeys, readSettings, readUserSection } from "./settings.ts"
import { browserTools } from "./tools.ts"

export { BrowserSession } from "./browser.ts"
export { findBrowser, installHint } from "./detect.ts"
export { isLoopback, UrlPolicy } from "./policy.ts"
export { readSettings } from "./settings.ts"
export { imageSize, TOOL_NAMES } from "./tools.ts"

export interface BrowserExtensionOptions {
  /** For tests: settings instead of the files, where browsers are looked for, and DNS. */
  settings?: BrowserSettings
  detect?: DetectEnv
  resolve?: Resolver
  tempDir?: string
}

/** Keeps one browser per session and closes it when the session ends. */
export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private found: FoundBrowser | undefined

  constructor(
    private readonly api: ExtensionAPI,
    readonly settings: BrowserSettings,
    readonly policy: UrlPolicy,
    private readonly opts: BrowserExtensionOptions = {},
  ) {}

  private key(ctx: ToolContext) {
    return ctx.session?.sessionId ?? "default"
  }

  existing(ctx: ToolContext): BrowserSession | undefined {
    return this.sessions.get(this.key(ctx))
  }

  /** The session's browser; a closed one (idle, crashed, closed by the model) is replaced. */
  session(ctx: ToolContext): BrowserSession {
    const key = this.key(ctx)
    const had = this.sessions.get(key)
    if (had && !had.closed) return had
    this.found ??= findBrowser(this.settings.executablePath, this.opts.detect)
    const session = new BrowserSession({
      found: this.found,
      settings: this.settings,
      policy: this.policy,
      runCommand: (argv, o) => this.api.runCommand(argv, o),
      cwd: this.api.cwd,
      onChange: () => this.api.requestRender(),
      ...(this.opts.tempDir ? { tempDir: this.opts.tempDir } : {}),
    })
    this.sessions.set(key, session)
    return session
  }

  /**
   * Renders HTML to a PNG for another extension (the browser.renderHtmlToPng service): in the
   * browser of a session that has one open, else in one kept for renders, which idles out
   * like the others.
   */
  async renderHtmlToPng(raw: HtmlToPngRequest): Promise<Uint8Array> {
    const req = renderRequest(raw)
    let session = this.open()[0]
    if (!session) {
      const had = this.sessions.get(RENDER_SESSION)
      if (had && !had.closed) session = had
      else session = this.session({ session: { sessionId: RENDER_SESSION } } as unknown as ToolContext)
    }
    return session.renderHtml(req, AbortSignal.timeout(req.timeoutMs + 30_000))
  }

  /** Browsers open right now. */
  open(): BrowserSession[] {
    return [...this.sessions.values()].filter((s) => s.isOpen)
  }

  async close(sessionId: string, reason: string) {
    const s = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    await s?.close(reason)
  }

  async closeAll(reason: string) {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, reason)))
  }
}

/** The browser kept for renders when no session has one open. */
const RENDER_SESSION = "\0render"

/** A render request as the service takes it, checked: sizes in range, a string of HTML. */
export function renderRequest(raw: HtmlToPngRequest): RenderRequest {
  const r = (raw ?? {}) as Partial<HtmlToPngRequest>
  if (typeof r.html !== "string") throw new Error("renderHtmlToPng: html must be a string")
  if (r.html.length > 32 * 1024 * 1024) throw new Error("renderHtmlToPng: html is over 32 MB")
  const int = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`renderHtmlToPng: ${name} must be a number from ${min} to ${max}`)
    return Math.round(v)
  }
  const req: RenderRequest = {
    html: r.html,
    width: int(r.width, "width", 16, 4096),
    deviceScaleFactor:
      r.deviceScaleFactor === undefined ? 1 : Math.min(4, Math.max(0.25, Number(r.deviceScaleFactor) || 1)),
    timeoutMs: r.timeoutMs === undefined ? 15_000 : int(r.timeoutMs, "timeoutMs", 100, 120_000),
  }
  if (r.height !== undefined) req.height = int(r.height, "height", 16, 16_384)
  if (r.selector !== undefined) {
    if (typeof r.selector !== "string" || !r.selector.trim() || r.selector.length > 1000)
      throw new Error("renderHtmlToPng: selector must be a CSS selector")
    req.selector = r.selector
  }
  return req
}

function statusText(open: BrowserSession[]): string | undefined {
  if (!open.length) return undefined
  if (open.length > 1) return `browser ×${open.length}`
  const url = open[0]?.url
  let where = ""
  try {
    const u = url ? new URL(url) : undefined
    where = u && (u.protocol === "http:" || u.protocol === "https:") ? ` ${u.host}` : ""
  } catch {}
  return `browser${where}`
}

export function createBrowserExtension(opts: BrowserExtensionOptions = {}) {
  return (api: ExtensionAPI) => {
    let settings = opts.settings
    if (!settings) {
      const user = readUserSection(api.home)
      settings = readSettings(api.settings, user)
      const ignored = ignoredProjectKeys(api.settings, user)
      if (ignored.length)
        api.reportError(
          `browser: ${ignored.map((k) => `extensions.browser.${k}`).join(", ")} ignored outside ~/.amira/settings.json; a project file cannot choose what the browser runs or reaches`,
        )
    }
    const policy = new UrlPolicy({
      allowFileUrls: settings.allowFileUrls,
      allowPrivateNetwork: settings.allowPrivateNetwork,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    })
    const manager = new BrowserManager(api, settings, policy, opts)
    for (const tool of browserTools(toolEnv(manager))) api.registerTool(tool)
    for (const [name, presenter] of Object.entries(browserPresenters))
      api.registerToolRenderer(name, presenter)
    api.registerStatusItem({
      id: "browser",
      align: "right",
      order: 5,
      tone: "accent",
      text: () => statusText(manager.open()),
    })

    // For other extensions (D88), where Amira offers services (API 0.1.3): e.g. mermaid
    // diagrams rendered to an image.
    if (typeof api.provideService === "function")
      api.provideService("browser.renderHtmlToPng", (req) => manager.renderHtmlToPng(req))

    const report = (err: unknown) =>
      api.reportError(`browser: ${err instanceof Error ? err.message : String(err)}`)
    // The browser must not outlive its session: close it when the session or sub-agent ends,
    // and when a new conversation replaces the old one.
    api.on("session.end", (e) => void manager.close(e.sessionId, "the session ended").catch(report))
    api.on(
      "subagent.end",
      (e) => void manager.close(e.data.childSessionId, "the sub-agent ended").catch(report),
    )
    api.on("session.start", (e) => {
      if (e.parentSessionId || e.data.reason === "startup") return
      void manager.closeAll("a new conversation started").catch(report)
    })
    return manager
  }
}

function toolEnv(manager: BrowserManager) {
  return {
    session: (ctx: ToolContext) => manager.session(ctx),
    existing: (ctx: ToolContext) => manager.existing(ctx),
    settings: manager.settings,
    policy: manager.policy,
  }
}

export default defineExtension((api) => {
  createBrowserExtension()(api)
})
