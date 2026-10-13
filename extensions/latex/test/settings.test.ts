import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { HtmlToPngRequest, MarkdownNode, MarkdownRenderContext, Settings } from "@amira/api"
import { loadSettings } from "../node_modules/@amira/core/src/config/load.ts"
import { EventBus } from "../node_modules/@amira/core/src/event-bus.ts"
import { ExtensionHost, type ExtensionHostOptions } from "../node_modules/@amira/core/src/extensions.ts"
import { InterceptorRegistry } from "../node_modules/@amira/core/src/interceptors.ts"
import { ToolRegistry } from "../node_modules/@amira/core/src/tool-registry.ts"
import extension from "../src/index.ts"

let root: string
let cwd: string
let home: string
let previousHome: string | undefined
let previousTerm: string | undefined
let hosts: ExtensionHost[]

beforeEach(() => {
  // All file IO stays inside extensions/latex; no access to the real Amira home.
  root = mkdtempSync(path.join(import.meta.dir, ".settings-"))
  cwd = path.join(root, "project")
  home = path.join(root, "home")
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  mkdirSync(home)
  previousHome = process.env.AMIRA_HOME
  previousTerm = process.env.TERM
  process.env.AMIRA_HOME = home
  process.env.TERM = "xterm"
  hosts = []
})

afterEach(() => {
  for (const host of hosts) host.unloadAll()
  if (previousHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = previousHome
  if (previousTerm === undefined) delete process.env.TERM
  else process.env.TERM = previousTerm
  // Only remove the temporary fixture directory created above.
  rmSync(root, { recursive: true, force: true })
})

const ctx: MarkdownRenderContext = { width: 80, images: true, maxImageRows: 20, theme: { dark: true } }
const node: MarkdownNode = { type: "math", display: true, source: "x^2" }

function makeHost(options: Partial<ExtensionHostOptions> = {}) {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
    settingsSources: { cwd, home },
    ...options,
  })
  hosts.push(host)
  return host
}

async function load(host: ExtensionHost) {
  const requests: HtmlToPngRequest[] = []
  expect(
    await host.load(
      (api) => {
        api.provideService("browser.renderHtmlToPng", async (request) => {
          requests.push(request)
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        })
      },
      "test:browser",
      "browser",
    ),
  ).toBe(true)
  expect(await host.load(extension, "package:latex", "latex")).toBe(true)
  return requests
}

test("existing user settings files keep extensions.latex keys and supply the new size default", async () => {
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      extensions: { latex: { mode: "image", maxWidth: 640 }, other: { enabled: true } },
    }),
  )
  const loaded = loadSettings({ cwd, home })
  const host = makeHost({ settings: loaded.settings, settingsLayers: loaded.layers })
  const requests = await load(host)
  const page = host.extensionSettings.get("latex")!
  expect(host.extensionSettings.list()).toHaveLength(1)
  expect(page.source).toBe("package:latex")
  expect(page.get()).toEqual({ mode: "image", maxWidth: 640, size: 16 })
  expect(await host.markdown.render(node, ctx)).toHaveProperty("image")
  expect(requests[0]!.width).toBe(640)
  expect(requests[0]!.html).toContain("font-size:16px")
  expect(page.sources.maxWidth![0]!.file).toBe(path.join(home, "settings.json"))
  expect(existsSync(path.join(home, "extension-data"))).toBe(false)
})

test("saving declared settings preserves legacy and unrelated keys and updates normal rendering", async () => {
  const original: Settings = {
    extensions: { latex: { mode: "text", maxWidth: 640 }, other: { enabled: true } },
  }
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(original))
  const loaded = loadSettings({ cwd, home })
  const host = makeHost({ settings: loaded.settings, settingsLayers: loaded.layers })
  const requests = await load(host)
  const page = host.extensionSettings.get("latex")!
  expect(await host.markdown.render(node, ctx)).toHaveProperty("lines")
  await page.save({ mode: "image", maxWidth: 640, size: 32 }, "user")
  expect(await Bun.file(path.join(home, "settings.json")).json()).toEqual({
    extensions: { latex: { mode: "image", maxWidth: 640, size: 32 }, other: { enabled: true } },
  })
  expect(await host.markdown.render(node, ctx)).toHaveProperty("image")
  expect(requests).toHaveLength(1)
  expect(requests[0]!.html).toContain("font-size:32px")
})

test("saved changes invalidate both host results and image cache while drafts invalidate neither", async () => {
  const host = makeHost()
  const requests = await load(host)
  const page = host.extensionSettings.get("latex")!
  await host.markdown.render(node, ctx)
  await host.markdown.render(node, ctx)
  expect(requests).toHaveLength(1)
  const version = host.markdown.version
  const saved = page.get()
  expect(
    await page.preview!(
      { ...saved, mode: "text", size: 48 },
      {
        ...ctx,
        signal: new AbortController().signal,
      },
    ),
  ).toHaveProperty("lines")
  expect(host.markdown.version).toBe(version)
  expect(page.get()).toBe(saved)
  expect(requests).toHaveLength(1)

  // Auto -> image keeps the same picture key: a new request proves onChange cleared it.
  host.setSettings({ extensions: { latex: { mode: "image" } } })
  expect(host.markdown.version).toBeGreaterThan(version)
  await host.markdown.render(node, ctx)
  expect(requests).toHaveLength(2)
  const changed = host.markdown.version
  host.setSettings({ extensions: { latex: { mode: "image" } } })
  expect(host.markdown.version).toBe(changed)
  await host.markdown.render(node, ctx)
  expect(requests).toHaveLength(2)

  host.setSettings({ extensions: { latex: { mode: "image", maxWidth: 320, size: 32 } } })
  await host.markdown.render(node, ctx)
  expect(requests).toHaveLength(3)
  expect(requests[2]!.width).toBe(320)
  expect(requests[2]!.html).toContain("font-size:32px")
  host.setSettings({ extensions: { latex: { mode: "text" } } })
  expect(await host.markdown.render(node, ctx)).toHaveProperty("lines")
  expect(requests).toHaveLength(3)
  expect(existsSync(path.join(home, "settings.json"))).toBe(false)
})
