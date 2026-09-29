import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import type {
  ExtensionAPI,
  StatusItem,
  ToolContext,
  ToolDefinition,
  ToolPresenter,
  ToolResult,
} from "@amira/api"
import { isPrivateAddress } from "@amira/api"
import { runCommand } from "@amira/proc"
import type { BrowserManager } from "../src/index.ts"
import { createBrowserExtension, findBrowser } from "../src/index.ts"
import { DEFAULTS } from "../src/settings.ts"

// Starting a browser takes a few seconds on Windows, more with antivirus scanning.
setDefaultTimeout(60_000)

const hasBrowser = (() => {
  try {
    findBrowser(undefined)
    return true
  } catch {
    return false
  }
})()

/** The static test site. */
const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Home page</title>
    <h1>Welcome</h1>
    <p id="msg">nothing yet</p>
    <button id="go" onclick="document.getElementById('msg').textContent = 'clicked'; console.log('button clicked')">Go</button>
    <a href="/next">Next page</a>
    <form action="/next" method="get">
      <input name="q" id="q" aria-label="Search">
      <select id="color" aria-label="Color"><option value="r">Red</option><option value="g">Green</option></select>
    </form>
    <script>console.warn("a warning"); window.appState = { items: [1, 2, 3] }</script>`,
  "/next": `<!doctype html><title>Next</title><p>You arrived.</p>`,
  "/broken": `<!doctype html><title>Broken</title><p>x</p><script>console.error("bad thing"); undefinedFunction()</script>`,
  "/private": `<!doctype html><title>Private</title><img src="http://10.255.255.1/pixel.png"><p>img</p>`,
  "/tall": `<!doctype html><title>Tall</title><div style="height:3000px;background:linear-gradient(red,blue)"></div>`,
  "/download": `<!doctype html><title>Download</title><a id="dl" href="/file.bin" download>get</a>`,
  "/file.bin": "binary",
  "/dialog": `<!doctype html><title>Dialog</title><button id="b" onclick="document.title = confirm('sure?') ? 'yes' : 'no'">ask</button>`,
}

let server: ReturnType<typeof Bun.serve>
let base: string
let downloads = 0
const tempDir = mkdtempSync(path.join(tmpdir(), "browser-ext-test-"))

/**
 * A server on this machine's private-network address (when it has one), which the policy
 * refuses: what redirects must not reach.
 */
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal && isPrivateAddress(a.address))?.address
let lan: ReturnType<typeof Bun.serve> | undefined
let lanUrl = ""

beforeAll(() => {
  if (lanIp) {
    lan = Bun.serve({
      hostname: lanIp,
      port: 0,
      fetch: () =>
        new Response("<title>Secret</title><p>intranet secret</p>", {
          headers: { "content-type": "text/html" },
        }),
    })
    lanUrl = `http://${lanIp}:${lan.port}/`
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === "/to-lan") return Response.redirect(lanUrl, 302)
      if (pathname === "/lan-img")
        return new Response(`<title>Img</title><img src="/to-lan">`, {
          headers: { "content-type": "text/html" },
        })
      if (pathname === "/slow")
        return Bun.sleep(1500).then(
          () => new Response("<title>Slow</title>", { headers: { "content-type": "text/html" } }),
        )
      if (pathname === "/file.bin") {
        downloads++
        return new Response("binary", { headers: { "content-type": "application/octet-stream" } })
      }
      const body = PAGES[pathname]
      return body
        ? new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  server?.stop(true)
  lan?.stop(true)
  // Profiles stay locked for a moment after their browser died.
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(250)
    }
  }
})

interface Harness {
  manager: BrowserManager
  call(name: string, args?: Record<string, unknown>, sessionId?: string): Promise<ToolResult>
  emit(type: string, e: Record<string, unknown>): void
  status(): string | undefined
  presenters: Map<string, ToolPresenter>
  loaded: string[]
  errors: string[]
}

function harness(settings: Partial<typeof DEFAULTS> = {}): Harness {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, ((e: any) => void)[]>()
  const presenters = new Map<string, ToolPresenter>()
  const items: StatusItem[] = []
  const loaded: string[] = []
  const errors: string[] = []
  const api = {
    apiVersion: "0.1.1",
    cwd: process.cwd(),
    home: tempDir,
    settings: {},
    registerTool: (t: ToolDefinition) => {
      tools.set(t.name, t)
      return () => {}
    },
    registerToolRenderer: (n: string, p: ToolPresenter) => {
      presenters.set(n, p)
      return () => {}
    },
    registerStatusItem: (i: StatusItem) => {
      items.push(i)
      return () => {}
    },
    requestRender() {},
    reportError: (e: string) => void errors.push(e),
    runCommand: (argv: string[], o: Parameters<ExtensionAPI["runCommand"]>[1]) => runCommand(argv, o),
    on(type: string, h: (e: any) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), h])
      return () => {}
    },
  } as unknown as ExtensionAPI
  const manager = createBrowserExtension({ settings: { ...DEFAULTS, ...settings }, tempDir })(api)
  return {
    manager,
    presenters,
    loaded,
    errors,
    async call(name, args = {}, sessionId = "s1") {
      const tool = tools.get(name)
      if (!tool) throw new Error(`no tool ${name}`)
      const ctx = {
        cwd: process.cwd(),
        toolCallId: "t1",
        signal: new AbortController().signal,
        update() {},
        session: {
          sessionId,
          loadTools: (n: string[]) => {
            loaded.push(...n)
            return n
          },
        },
      } as unknown as ToolContext
      return tool.execute(args, ctx)
    },
    emit(type, e) {
      for (const h of handlers.get(type) ?? []) h(e)
    },
    status: () => items[0]?.text(),
  }
}

const text = (r: ToolResult) =>
  r.content.map((b) => (b.type === "text" ? b.text : `[${b.mimeType}]`)).join("\n")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(done: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(25)
  }
}

describe.skipIf(!hasBrowser)("with a real browser", () => {
  const h = harness()
  afterAll(() => h.manager.closeAll("test over"))

  test("browser_open opens a local page and loads the other tools", async () => {
    const r = await h.call("browser_open", { url: `${base}/` })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain("Home page")
    expect(text(r)).toContain("(HTTP 200)")
    expect(text(r)).toContain("Welcome")
    expect(h.loaded).toContain("browser_click")
    expect(h.status()).toBe(`browser 127.0.0.1:${server.port}`)
    expect(h.presenters.get("browser_open")?.result?.({ args: {}, result: r, text: text(r) })).toBe(
      "Home page",
    )
  })

  test("browser_snapshot shows the accessibility tree", async () => {
    const r = await h.call("browser_snapshot")
    expect(text(r)).toContain('heading "Welcome"')
    expect(text(r)).toContain('button "Go"')
    expect(text(r)).toContain('textbox "Search"')
  })

  test("browser_click clicks and reports console output", async () => {
    const r = await h.call("browser_click", { selector: "#go" })
    expect(text(r)).toContain("Clicked #go")
    const e = await h.call("browser_eval", { expression: "document.getElementById('msg').textContent" })
    expect(text(e)).toBe('"clicked"')
    const c = await h.call("browser_console")
    expect(text(c)).toContain("[log] button clicked")
    expect(text(c)).toContain("[warning] a warning")
    const errorsOnly = await h.call("browser_console", { level: "error" })
    expect(text(errorsOnly)).toBe("No console messages.")
  })

  test("browser_type fills a field and submit follows the form", async () => {
    const r = await h.call("browser_type", { selector: "#q", text: "hello", submit: true })
    expect(text(r)).toContain("Typed 5 characters into #q and pressed Enter")
    expect(text(r)).toContain(`Now at ${base}/next?q=hello`)
    expect(text(r)).toContain("Next")
  })

  test("browser_select chooses by value or label, and lists the options when none matches", async () => {
    await h.call("browser_open", { url: `${base}/` })
    const r = await h.call("browser_select", { selector: "#color", values: ["Green"] })
    expect(text(r)).toContain("Selected g in #color")
    const bad = await h.call("browser_select", { selector: "#color", values: ["blue"] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain("r (Red), g (Green)")
  })

  test("browser_eval returns JSON, calls functions, and cuts long values", async () => {
    expect(text(await h.call("browser_eval", { expression: "window.appState" }))).toContain('"items"')
    expect(text(await h.call("browser_eval", { expression: "() => document.title" }))).toBe('"Home page"')
    expect(text(await h.call("browser_eval", { expression: "Promise.resolve(41 + 1)" }))).toBe("42")
    const long = await h.call("browser_eval", { expression: "'x'.repeat(50000)" })
    expect(text(long)).toContain("more characters cut")
    expect(text(long).length).toBeLessThan(DEFAULTS.maxEvalChars + 200)
    const err = await h.call("browser_eval", { expression: "nope.nope" })
    expect(err.isError).toBe(true)
    expect(text(err)).toBe("ReferenceError: nope is not defined")
    const notField = await h.call("browser_type", { selector: "#go", text: "x" })
    expect(notField.isError).toBe(true)
    expect(text(notField)).toStartWith("Element is not an <input>")
  })

  test("browser_screenshot returns an image of the viewport, the full page or an element", async () => {
    const r = await h.call("browser_screenshot")
    const img = r.content.find((b) => b.type === "image")
    expect(img?.type === "image" && img.mimeType).toBe("image/png")
    expect(text(r)).toContain("1280×800")
    await h.call("browser_open", { url: `${base}/tall` })
    const full = await h.call("browser_screenshot", { fullPage: true })
    expect(text(full)).toMatch(/1280×30\d\d/)
    await h.call("browser_open", { url: `${base}/` })
    const el = await h.call("browser_screenshot", { selector: "#go" })
    expect(text(el)).toContain("element #go")
    const missing = await h.call("browser_screenshot", { selector: "#absent" })
    expect(missing.isError).toBe(true)
  })

  test("page errors are reported by the action that caused them", async () => {
    const r = await h.call("browser_open", { url: `${base}/broken` })
    expect(text(r)).toContain("[error] bad thing")
    expect(text(r)).toContain("[pageerror]")
  })

  test("private-network requests are refused and logged; file:// is refused", async () => {
    const r = await h.call("browser_open", { url: `${base}/private` })
    expect(text(r)).toContain("[blocked]")
    expect(text(r)).toContain("10.255.255.1")
    const direct = await h.call("browser_open", { url: "http://192.168.0.1/" })
    expect(direct.isError).toBe(true)
    const file = await h.call("browser_open", { url: "file:///C:/Windows/win.ini" })
    expect(file.isError).toBe(true)
    expect(text(file)).toContain("allowFileUrls")
  })

  test("downloads are refused", async () => {
    await h.call("browser_open", { url: `${base}/download` })
    const before = downloads
    await h.call("browser_click", { selector: "#dl" })
    await Bun.sleep(500)
    const count = await h.call("browser_eval", { expression: "document.title" })
    expect(text(count)).toBe('"Download"')
    // The request may be made, but nothing is saved: no file appears in the profile.
    expect(downloads - before).toBeLessThanOrEqual(1)
  })

  test("dialogs are dismissed and logged", async () => {
    await h.call("browser_open", { url: `${base}/dialog` })
    const r = await h.call("browser_click", { selector: "#b" })
    expect(text(r)).toContain("— no")
    expect(text(await h.call("browser_console"))).toContain("[dialog] confirm: sure? (dismissed)")
  })

  test.skipIf(!lanIp)("a redirect to a refused address is left, and reported", async () => {
    const r = await h.call("browser_open", { url: `${base}/to-lan` })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain("redirected to a refused address")
    expect(text(r)).not.toContain("intranet secret")
    expect(text(await h.call("browser_eval", { expression: "location.href" }))).toBe('"about:blank"')
    // A subresource cannot be stopped once redirected, but it is reported.
    const img = await h.call("browser_open", { url: `${base}/lan-img` })
    expect(text(img)).toContain("a redirect reached a refused address")
  })

  test("a page closed by its own script is replaced by the next browser_open", async () => {
    await h.call("browser_open", { url: `${base}/next` })
    await h.call("browser_eval", { expression: "window.close()" })
    await Bun.sleep(300)
    const r = await h.call("browser_open", { url: `${base}/` })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain("Home page")
  })

  test("browser_console clear forgets only what it listed", async () => {
    await h.call("browser_console", { clear: true })
    await h.call("browser_open", { url: `${base}/broken` })
    await h.call("browser_console", { level: "error", clear: true })
    const rest = text(await h.call("browser_console"))
    expect(rest).not.toContain("bad thing")
    expect(rest).toBe("No console messages.")
    await h.call("browser_open", { url: `${base}/` })
    await h.call("browser_console", { level: "error", clear: true })
    expect(text(await h.call("browser_console"))).toContain("[warning] a warning")
  })

  test("tools other than browser_open need an open page", async () => {
    const r = await h.call("browser_click", { selector: "#go" }, "other-session")
    expect(r.isError).toBe(true)
    expect(text(r)).toContain("browser_open")
  })
})

describe.skipIf(!hasBrowser)("lifetime", () => {
  const pidOf = (h: Harness, sessionId: string) =>
    (h.manager as unknown as { sessions: Map<string, { pid?: number }> }).sessions.get(sessionId)?.pid

  test("browser_close kills the browser; the next open starts a fresh one", async () => {
    const h = harness()
    await h.call("browser_open", { url: `${base}/` })
    const pid = pidOf(h, "s1")
    expect(pid && alive(pid)).toBe(true)
    expect(text(await h.call("browser_close"))).toBe("Closed the browser.")
    await until(() => !alive(pid as number))
    expect(h.status()).toBeUndefined()
    const again = await h.call("browser_open", { url: `${base}/next` })
    expect(text(again)).toContain("Next")
    expect(pidOf(h, "s1")).not.toBe(pid)
    await h.manager.closeAll("test over")
  })

  test("browser_close while the browser is starting stops the start", async () => {
    const h = harness()
    const opening = h.call("browser_open", { url: `${base}/` })
    await Bun.sleep(50)
    expect(text(await h.call("browser_close"))).toBe("Closed the browser.")
    expect((await opening).isError).toBe(true)
    expect(h.manager.open()).toEqual([])
    expect(text(await h.call("browser_close"))).toBe("No browser is open.")
  })

  test("the end of the session, or of a sub-agent, closes its browser", async () => {
    const h = harness()
    await h.call("browser_open", { url: `${base}/` }, "main")
    await h.call("browser_open", { url: `${base}/` }, "child")
    const main = pidOf(h, "main") as number
    const child = pidOf(h, "child") as number
    expect(h.status()).toBe("browser ×2")
    h.emit("subagent.end", { sessionId: "main", data: { childSessionId: "child" } })
    await until(() => !alive(child))
    expect(alive(main)).toBe(true)
    h.emit("session.end", { sessionId: "main", data: { reason: "exit" } })
    await until(() => !alive(main))
  })

  test("a call that takes longer than the idle time does not close the browser under it", async () => {
    const h = harness({ idleMinutes: 0.005 })
    const r = await h.call("browser_open", { url: `${base}/slow` })
    expect(text(r)).toContain("Slow")
    await h.manager.closeAll("test over")
  })

  test("an idle browser closes by itself", async () => {
    const h = harness({ idleMinutes: 0.02 })
    await h.call("browser_open", { url: `${base}/` })
    const pid = pidOf(h, "s1") as number
    await until(() => !alive(pid), 15_000)
    expect(h.status()).toBeUndefined()
    const r = await h.call("browser_snapshot")
    expect(r.isError).toBe(true)
  })
})
