import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { RunCommandOptions, RunCommandResult } from "@amira/api"
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Frame, Page, WebError } from "playwright-core"
import type { FoundBrowser } from "./detect.ts"
import type { UrlPolicy } from "./policy.ts"
import type { BrowserSettings } from "./settings.ts"

export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>

/** A console message, page error, dialog or refused request, as browser_console lists them. */
export interface LogEntry {
  seq: number
  /** A console type (log, info, warning, error, debug, ...), or "pageerror", "dialog", "blocked". */
  type: string
  text: string
  /** Where it came from: a script location, or the refused URL. */
  where?: string
}

/** How the log records a page left because a redirect led to a refused address. */
export const LEFT_PAGE = "left a page a redirect led to"

const MAX_LOG = 300
const MAX_ENTRY_CHARS = 2000
/** How long the browser gets to print its DevTools endpoint. */
const START_TIMEOUT_MS = 30_000
/** The browser is killed after this long even while in use; the idle timeout usually comes first. */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000

/** Browsers of this process, by pid, killed on exit should their session never end. */
const livePids = new Set<number>()
let exitHookInstalled = false
function trackPid(pid: number) {
  livePids.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Normally the session's end closes the browser first; this is the last resort (an exit
  // that does not wait for that). Synchronous, as exit handlers must be.
  process.once("exit", () => {
    for (const p of livePids) {
      try {
        // POSIX: the browser leads its own process group (runCommand starts it detached).
        process.kill(process.platform === "win32" ? p : -p, "SIGKILL")
      } catch {
        try {
          process.kill(p, "SIGKILL")
        } catch {}
      }
    }
  })
}

export interface SessionOptions {
  found: FoundBrowser
  settings: BrowserSettings
  policy: UrlPolicy
  runCommand: RunCommand
  cwd: string
  /** Called when the browser opened or closed (for the status bar), with why it closed. */
  onChange?: (reason?: string) => void
  /** For tests: where the throwaway profile goes. */
  tempDir?: string
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** A render of HTML to a PNG, checked (see renderRequest in index.ts). */
export interface RenderRequest {
  html: string
  width: number
  height?: number
  deviceScaleFactor: number
  selector?: string
  timeoutMs: number
}

function launchArgs(exe: string, profile: string, s: BrowserSettings): string[] {
  const args = [
    exe,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
  ]
  if (s.headless) args.push("--headless=new", "--hide-scrollbars")
  else args.push(`--window-size=${s.viewport.width},${s.viewport.height + 120}`)
  // Chrome refuses to run its sandbox as root, e.g. in a container.
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox")
  args.push("about:blank")
  return args
}

/**
 * One browser for one Amira session: started through the API's runCommand (so it is killed
 * with its whole process tree), driven over the DevTools protocol by Playwright. Pages live
 * in a fresh context with downloads denied and every request checked against the URL policy.
 */
export class BrowserSession {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private current: Page | undefined
  private abort: AbortController | undefined
  private run: Promise<RunCommandResult> | undefined
  private starting: Promise<void> | undefined
  private profile: string | undefined
  private pid: number | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private ended = false
  private seq = 0
  private readonly adopted = new WeakSet<Page>()
  /** Tool calls running now. */
  private busy = 0
  readonly log: LogEntry[] = []

  constructor(private readonly opts: SessionOptions) {}

  get isOpen(): boolean {
    return !!this.context && !this.ended
  }

  /** Open, or on its way: a browser_close has something to close. */
  get active(): boolean {
    return !this.ended && (!!this.context || !!this.starting)
  }

  /** Closed for good: idle, crashed, failed to start, or closed on purpose. */
  get closed(): boolean {
    return this.ended
  }

  /** The current page's URL, when a page is open. */
  get url(): string | undefined {
    try {
      return this.current && !this.current.isClosed() ? this.current.url() : undefined
    } catch {
      return undefined
    }
  }

  /** Starts the browser unless it runs; concurrent callers share one start. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.ended) throw new Error("this browser session was closed")
    if (this.context) return
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined
    })
    await raceSignal(this.starting, signal)
  }

  private async launch(): Promise<void> {
    const { settings, found } = this.opts
    const temp = this.opts.tempDir ?? tmpdir()
    if (!staleSwept) {
      staleSwept = true
      removeStaleProfiles(temp)
    }
    const profile = mkdtempSync(path.join(temp, PROFILE_PREFIX))
    this.profile = profile
    const abort = new AbortController()
    this.abort = abort
    let output = ""
    let onEndpoint: ((ws: string) => void) | undefined
    const endpoint = new Promise<string>((resolve, reject) => {
      onEndpoint = resolve
      const timer = setTimeout(() => {
        reject(new Error(`${found.name} did not start within ${START_TIMEOUT_MS / 1000}s`))
      }, START_TIMEOUT_MS)
      this.run = this.opts.runCommand(launchArgs(found.path, profile, settings), {
        cwd: this.opts.cwd,
        timeoutMs: MAX_LIFETIME_MS,
        signal: abort.signal,
        onChunk: (chunk) => {
          if (output.length < 20_000) output += chunk
          const m = /DevTools listening on (ws:\/\/\S+)/.exec(output)
          if (m) {
            clearTimeout(timer)
            onEndpoint?.(m[1] as string)
            onEndpoint = undefined
          }
        },
      })
      this.run.then(
        (r) => {
          clearTimeout(timer)
          const tail = output.trim().split(/\r?\n/).slice(-5).join("\n")
          reject(
            new Error(
              `${found.name} exited (code ${r.exitCode}) before it was ready${tail ? `:\n${tail}` : ""}`,
            ),
          )
          this.onBrowserGone("the browser exited")
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
          this.onBrowserGone("the browser could not be started")
        },
      )
    })
    try {
      const ws = await endpoint
      const { chromium } = await import("playwright-core")
      const browser = await chromium.connectOverCDP(ws, { timeout: START_TIMEOUT_MS })
      this.browser = browser
      browser.on("disconnected", () => this.onBrowserGone("the browser disconnected"))
      await this.findPid(browser)
      const context = await browser.newContext({
        viewport: settings.viewport,
        acceptDownloads: false,
        serviceWorkers: "block",
      })
      context.setDefaultTimeout(settings.actionTimeoutMs)
      context.setDefaultNavigationTimeout(settings.navigationTimeoutMs)
      await this.guard(context)
      context.on("page", (p) => this.adopt(p))
      context.on("console", (m) => this.onConsole(m))
      context.on("weberror", (e) => this.onWebError(e))
      this.context = context
      this.adopt(await context.newPage())
      if (this.ended) throw new Error("the browser was closed while it started")
      this.opts.onChange?.()
    } catch (err) {
      await this.shutdown()
      throw err
    }
  }

  /** The browser's pid, so an exit that skips the session's end can still kill it. */
  private async findPid(browser: Browser) {
    try {
      const cdp = await browser.newBrowserCDPSession()
      const info = (await cdp.send("SystemInfo.getProcessInfo")) as {
        processInfo: { type: string; id: number }[]
      }
      const pid = info.processInfo.find((p) => p.type === "browser")?.id
      await cdp.detach().catch(() => {})
      if (pid) {
        this.pid = pid
        trackPid(pid)
      }
    } catch {
      // Not every Chromium build has SystemInfo; the session's end still kills the tree.
    }
  }

  /** Checks every request and WebSocket against the policy. */
  private async guard(context: BrowserContext) {
    const policy = this.opts.policy
    await context.route("**/*", async (route) => {
      const url = route.request().url()
      const refusal = await policy.checkRequest(url)
      if (!refusal) return route.continue().catch(() => {})
      this.push("blocked", refusal, url)
      return route.abort("blockedbyclient").catch(() => {})
    })
    await context.routeWebSocket(/.*/, async (ws) => {
      const refusal = await policy.checkRequest(ws.url())
      if (!refusal) return ws.connectToServer()
      this.push("blocked", refusal, ws.url())
      await ws.close({ code: 1008, reason: "refused by Amira's browser settings" })
    })
    // Playwright continues redirects without asking the route, so a redirect can reach a
    // refused address. A subresource that did is already loaded: say so at least.
    context.on("request", (req) => {
      if (!req.redirectedFrom()) return
      void policy.checkRequest(req.url()).then((refusal) => {
        if (refusal)
          this.push("blocked", `a redirect reached a refused address and was loaded: ${refusal}`, req.url())
      })
    })
  }

  /**
   * Leaves a document the policy refuses, which only a redirect can have loaded: the page goes
   * to about:blank. Returns the refusal, if any.
   */
  async leaveRefused(page: Page, frame: Frame = page.mainFrame()): Promise<string | undefined> {
    const url = frame.url()
    const refusal = await this.opts.policy.checkRequest(url)
    if (!refusal) return undefined
    this.push("blocked", `${LEFT_PAGE}: ${refusal}`, url)
    if (frame === page.mainFrame()) await page.goto("about:blank").catch(() => {})
    else await frame.evaluate(() => (globalThis as any).location.replace("about:blank")).catch(() => {})
    return refusal
  }

  private adopt(page: Page) {
    this.current = page
    // A page arrives both from newPage() and from the context's "page" event.
    if (this.adopted.has(page)) return
    this.adopted.add(page)
    page.on("framenavigated", (frame) => void this.leaveRefused(page, frame))
    page.on("dialog", (d) => this.onDialog(d))
    page.on("close", () => {
      if (this.current !== page) return
      this.current = this.context?.pages().at(-1)
    })
  }

  private onDialog(d: Dialog) {
    this.push("dialog", `${d.type()}: ${d.message()} (dismissed)`)
    d.dismiss().catch(() => {})
  }

  private onConsole(m: ConsoleMessage) {
    const loc = m.location()
    this.push(m.type(), m.text(), loc.url ? `${loc.url}:${loc.lineNumber + 1}` : undefined)
  }

  private onWebError(e: WebError) {
    const err = e.error()
    this.push("pageerror", err.stack || err.message)
  }

  push(type: string, text: string, where?: string) {
    this.log.push({ seq: ++this.seq, type, text: cap(text, MAX_ENTRY_CHARS), ...(where ? { where } : {}) })
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
  }

  /** The last log sequence number, to count what a later action added. */
  get mark(): number {
    return this.seq
  }

  /** The page tools act on; throws when none is open. */
  page(): Page {
    const p = this.current
    if (!this.context || !p || p.isClosed()) throw new NoPageError()
    return p
  }

  /** The current page, or a new one when the last was closed (e.g. by window.close()). */
  async ensurePage(): Promise<Page> {
    const p = this.current
    if (p && !p.isClosed()) return p
    if (!this.context) throw new NoPageError()
    const page = await this.context.newPage()
    this.adopt(page)
    return page
  }

  /**
   * Renders a self-contained HTML page to a PNG (the browser.renderHtmlToPng service): in a
   * throwaway context of this browser, with no network at all (every request refused, offline,
   * no WebSockets, no service workers), JavaScript on, dialogs dismissed. The page is shot once
   * it loaded and `window.amiraRenderDone` (when it sets one) settled; only `selector`'s element
   * when given, else the viewport, or the whole page when no height is given.
   */
  async renderHtml(req: RenderRequest, signal: AbortSignal): Promise<Uint8Array> {
    await this.start(signal)
    const browser = this.browser
    if (!browser || this.ended) throw new Error("the browser closed")
    const end = this.begin()
    let context: BrowserContext | undefined
    try {
      context = await browser.newContext({
        viewport: { width: req.width, height: req.height ?? 600 },
        deviceScaleFactor: req.deviceScaleFactor,
        offline: true,
        acceptDownloads: false,
        serviceWorkers: "block",
        javaScriptEnabled: true,
      })
      // Nothing leaves the page: what it needs must be in it.
      await context.route("**/*", (route) => {
        const url = route.request().url()
        if (url.startsWith("data:") || url === "about:blank") return route.continue().catch(() => {})
        return route.abort("blockedbyclient").catch(() => {})
      })
      await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "no network for renders" }))
      const ctx = context
      const shot = async () => {
        const page = await ctx.newPage()
        page.on("dialog", (d) => void d.dismiss().catch(() => {}))
        await page.setContent(req.html, { waitUntil: "load", timeout: req.timeoutMs })
        // A rejection comes back as its message: the error itself may not be serializable.
        const failed = await page.evaluate(async () => {
          const done = (globalThis as { amiraRenderDone?: unknown }).amiraRenderDone
          if (!done || typeof (done as Promise<unknown>).then !== "function") return null
          try {
            await done
            return null
          } catch (err) {
            const message = (err as { message?: unknown } | null)?.message
            return String(typeof message === "string" ? message : err).slice(0, 2000)
          }
        })
        if (failed !== null) throw new Error(`the page failed: ${failed}`)
        const png = req.selector
          ? await page.locator(req.selector).first().screenshot({ type: "png", timeout: req.timeoutMs })
          : await page.screenshot({ type: "png", fullPage: req.height === undefined, timeout: req.timeoutMs })
        return new Uint8Array(png)
      }
      return await raceSignal(shot(), AbortSignal.any([signal, AbortSignal.timeout(req.timeoutMs)]))
    } finally {
      await context?.close().catch(() => {})
      end()
    }
  }

  /**
   * Marks a tool call as running: the browser does not idle out meanwhile, however long the
   * call takes. The returned function ends it and restarts the idle countdown.
   */
  begin(): () => void {
    this.busy++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    let done = false
    return () => {
      if (done) return
      done = true
      this.busy--
      this.touch()
    }
  }

  /** Restarts the idle countdown, unless a call is running. */
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.ended || this.busy > 0) return
    const ms = this.opts.settings.idleMinutes * 60_000
    this.idleTimer = setTimeout(() => void this.close(`idle for ${this.opts.settings.idleMinutes} min`), ms)
    this.idleTimer.unref?.()
  }

  private onBrowserGone(reason: string) {
    if (this.ended) return
    void this.close(reason)
  }

  /** Closes the browser for good and kills its process tree. */
  async close(reason = "closed"): Promise<void> {
    if (this.ended) return
    this.ended = true
    await this.shutdown()
    this.opts.onChange?.(reason)
  }

  private async shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const browser = this.browser
    this.browser = undefined
    this.context = undefined
    this.current = undefined
    // Disconnect (a browser we connected to is not closed by this), then kill the tree.
    if (browser) await Promise.race([browser.close().catch(() => {}), Bun.sleep(2000)])
    this.abort?.abort()
    if (this.run) await Promise.race([this.run.catch(() => undefined), Bun.sleep(5000)])
    if (this.pid) livePids.delete(this.pid)
    if (this.profile) removeLater(this.profile)
    this.profile = undefined
  }
}

export class NoPageError extends Error {
  constructor() {
    super("No page is open; call browser_open first.")
  }
}

/** The profile stays locked for a moment after the browser dies on Windows. */
function removeLater(dir: string, tries = 5) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    if (tries > 0) setTimeout(() => removeLater(dir, tries - 1), 1000).unref?.()
  }
}

const PROFILE_PREFIX = "amira-browser-"
let staleSwept = false

/**
 * Removes profiles left behind by browsers that ended with Amira (an exit does not wait for
 * the removal). Only ones untouched for longer than a browser may live, so a profile another
 * Amira is using is never removed.
 */
export function removeStaleProfiles(dir: string, now = Date.now()) {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue
    const full = path.join(dir, name)
    try {
      if (now - statSync(full).mtimeMs > MAX_LIFETIME_MS + 60 * 60 * 1000)
        rmSync(full, { recursive: true, force: true })
    } catch {}
  }
}

export function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}
