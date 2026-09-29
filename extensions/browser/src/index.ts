import { defineExtension, type ExtensionAPI, type ToolContext } from "@amira/api"
import { BrowserSession } from "./browser.ts"
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
