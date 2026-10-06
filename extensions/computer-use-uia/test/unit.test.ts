import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, OpenPipeOptions, SettingsLayer, ToolContext, ToolDefinition } from "@amira/api"
import { formatTree, UiaClient, validateKeys } from "../src/client.ts"
import { setup } from "../src/extension.ts"
import { readSettings } from "../src/settings.ts"

const WINDOW = `w${"1".padStart(32, "0")}_123`

function fake(settings: unknown = { enabled: true }, layers?: SettingsLayer[]) {
  const pipes: { options: OpenPipeOptions; closed: number[] }[] = []
  const watchdogs: { options: OpenPipeOptions; closed: number[] }[] = []
  const requests: { id: number; method: string; params: Record<string, unknown> }[] = []
  const stopped: string[] = []
  const started: string[][] = []
  const handlers = new Map<string, () => void>()
  const tools = new Map<string, ToolDefinition>()
  const notices: string[] = []
  const errors: string[] = []
  let respond = true
  let launchError: string | undefined
  let watchdogReady = true
  let text = 'e1 Window "owned" enabled=true offscreen=false\ne2 Edit "Text" enabled=true offscreen=false'
  const job = { id: "lifetime", pid: 42, status: "running" }
  const api = {
    cwd: process.cwd(),
    settings: {
      extensions: { "computer-use-uia": settings },
      layers: () =>
        layers ?? [
          { scope: "user", file: "~/.amira/settings.json", value: { "computer-use-uia": settings } },
        ],
    },
    backgroundJobs: {
      start: (options: { argv: string[] }) => {
        started.push(options.argv)
        return job
      },
      get: () => job,
      waitFor: async () => ({ reason: "match", line: 'UIA lifetime ready {"Pid":42,"Started":"1234"}' }),
      stop: async (id: string) => {
        stopped.push(id)
        // Fake watchdog observes the sentinel's host-driven unload lifetime ending.
        for (const watchdog of watchdogs) watchdog.options.onEvent({ type: "exit", code: 0 })
      },
    },
    openPipe(argv: string[], options: OpenPipeOptions) {
      const pipe = { options, closed: [] as number[] }
      if (argv.some((arg) => arg.endsWith("lifetime.ps1"))) {
        watchdogs.push(pipe)
        if (watchdogReady)
          queueMicrotask(() => options.onEvent({ type: "stdout", data: "UIA watchdog ready\n" }))
        return {
          write() {},
          close(ms: number) {
            pipe.closed.push(ms)
            queueMicrotask(() => options.onEvent({ type: "exit", code: 0 }))
          },
        }
      }
      pipes.push(pipe)
      const window = `w${String(pipes.length).padStart(32, "0")}_123`
      return {
        write(data: string) {
          const request = JSON.parse(data)
          requests.push(request)
          if (!respond) return
          const result =
            request.method === "launch"
              ? { window, pid: 17, title: "owned" }
              : request.method === "tree"
                ? { text, nodes: 2, chars: text.length, ms: 12, cut: false }
                : { path: "ValuePattern.SetValue" }
          // Exercise line framing, with both fragmented and CRLF responses.
          const response =
            request.method === "launch" && launchError
              ? { id: request.id, error: launchError }
              : { id: request.id, result }
          const line = `${JSON.stringify(response)}\r\n`
          queueMicrotask(() => {
            options.onEvent({ type: "stdout", data: line.slice(0, 15) })
            options.onEvent({ type: "stdout", data: line.slice(15) })
          })
        },
        close(ms: number) {
          pipe.closed.push(ms)
          queueMicrotask(() => options.onEvent({ type: "exit", code: 0 }))
        },
      }
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool)
      return () => {}
    },
    on(type: string, handler: () => void) {
      handlers.set(type, handler)
      return () => {}
    },
    onExit(handler: () => void) {
      handlers.set("exit", handler)
      return () => {}
    },
    notify(message: string) {
      notices.push(message)
    },
    reportError(message: string) {
      errors.push(message)
    },
  } as unknown as ExtensionAPI
  return {
    api,
    pipes,
    watchdogs,
    requests,
    started,
    stopped,
    handlers,
    tools,
    notices,
    errors,
    response(value: boolean) {
      respond = value
    },
    launchError(value: string | undefined) {
      launchError = value
    },
    watchdogReady(value: boolean) {
      watchdogReady = value
    },
    tree(value: string) {
      text = value
    },
  }
}

const ctx: ToolContext = {
  cwd: process.cwd(),
  toolCallId: "t",
  signal: new AbortController().signal,
  update() {},
}

test("off by default; apps settings replace defaults and validate without partial enablement", () => {
  expect(readSettings(undefined).enabled).toBe(false)
  expect(readSettings(undefined).apps).toEqual({
    testWindow: {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("../helper/test-window.ps1", import.meta.url)),
      ],
    },
  })
  expect(readSettings({ enabled: true }).apps).toEqual(readSettings(undefined).apps)
  expect(readSettings({ enabled: true, apps: {} })).toEqual({ enabled: true, apps: {} })
  expect(readSettings({ apps: { demo: { command: "demo.exe", args: ["--x"] } } }).apps.demo).toEqual({
    command: "demo.exe",
    args: ["--x"],
  })
  for (const bad of [
    false,
    { enabled: "always" },
    { apps: [] },
    { apps: { demo: { command: "x", args: [1] } } },
  ])
    expect(() => readSettings(bad)).toThrow()
  const disabled = fake({})
  setup(disabled.api, "win32")
  expect(disabled.tools.size).toBe(0)
  expect(disabled.pipes.length).toBe(0)
})

test("only explicit user settings can enable tools or supply launch commands", () => {
  const malicious = { enabled: true, apps: { evil: { command: "evil.exe" } } }
  for (const scope of ["project", "project-local", "flags"] as const) {
    const h = fake(malicious, [
      { scope, file: "untrusted/settings.json", value: { "computer-use-uia": malicious } },
    ])
    expect(setup(h.api, "win32")).toBeUndefined()
    expect(h.tools.size).toBe(0)
    expect(h.started).toHaveLength(0)
  }
  const missing = fake(malicious, [])
  expect(setup(missing.api, "win32")).toBeUndefined()
  Object.assign(missing.api.settings, { layers: undefined })
  expect(setup(missing.api, "win32")).toBeUndefined()

  const user = { enabled: true, apps: { safe: { command: "safe.exe", args: ["--user"] } } }
  const h = fake(malicious, [
    { scope: "user", file: "~/.amira/settings.json", value: { "computer-use-uia": user } },
    { scope: "project", file: ".amira/settings.json", value: { "computer-use-uia": malicious } },
  ])
  const client = setup(h.api, "win32")!
  expect(client.apps).toEqual(user.apps)
  expect(h.tools.get("ui_launch")!.parameters).toMatchObject({ properties: { app: { enum: ["safe"] } } })
  expect(h.pipes).toHaveLength(0)

  const defaults = fake(malicious, [
    { scope: "user", file: "~/.amira/settings.json", value: { "computer-use-uia": { enabled: true } } },
    { scope: "project-local", file: ".amira/settings.local.json", value: { "computer-use-uia": malicious } },
  ])
  expect(Object.keys(setup(defaults.api, "win32")!.apps)).toEqual(["testWindow"])
})

test("desktop applications require an explicit allowlist entry", () => {
  expect(readSettings(undefined).apps.notepad).toBeUndefined()
  expect(readSettings(undefined).apps.calculator).toBeUndefined()
  expect(readSettings({ apps: { demo: { command: "demo.exe" } } }).apps).toEqual({
    demo: { command: "demo.exe" },
  })
})

test("non-Windows loads without tools and gives at most one notice", () => {
  const h = fake()
  setup(h.api, "linux")
  setup(h.api, "darwin")
  expect(h.tools.size).toBe(0)
  expect(h.pipes.length).toBe(0)
  expect(h.notices).toHaveLength(1)
})

test("only tree declares readOnly; normal permissions handle every action", async () => {
  const h = fake()
  const client = setup(h.api, "win32")!
  expect([...h.tools.keys()]).toEqual(["ui_launch", "ui_tree", "ui_click", "ui_type", "ui_key", "ui_close"])
  for (const [name, tool] of h.tools) {
    expect(tool.traits).toEqual(name === "ui_tree" ? { readOnly: true } : undefined)
    expect(tool.concurrency).toBe("serial")
  }
  expect(h.pipes).toHaveLength(0)
  await h.tools.get("ui_launch")!.execute({ app: "testWindow" }, ctx)
  const tree = await h.tools.get("ui_tree")!.execute({ window: WINDOW }, ctx)
  expect(tree.content).toEqual([{ type: "text", text: expect.stringContaining("12 ms; 2 nodes;") }])
  await client.stop()
})

test("allowlist and ownership refusals never send a request to the helper", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  for (const name of ["unknown", "__proto__", "constructor", "powershell.exe"])
    await expect(c.call("launch", { app: name })).rejects.toThrow("Allowed apps: testWindow")
  for (const method of ["tree", "click", "type", "key", "close"])
    await expect(c.call(method, { window: "999", ref: "e1" })).rejects.toThrow("not obtained")
  expect(h.requests).toHaveLength(0)
  expect(h.pipes).toHaveLength(0)
  await c.call("launch", { app: "testWindow", command: "evil.exe", window: "999" })
  expect(h.requests[0]?.params).toEqual({ app: "testWindow" })
  await c.stop()
})

for (const [scenario, error] of [
  [
    "handoff refusal",
    "This app hands its window to another process, which this extension does not support. Use an app that owns its launched window.",
  ],
  [
    "launcher identity capture failed",
    "Launched process identity is unavailable; no window was adopted. Apps that hand off to another process are not supported.",
  ],
  [
    "launched process exited without own window",
    "Launched process exited without owning a window. Apps that hand off to another process are not supported.",
  ],
  [
    "timeout no own window",
    "Launched process never owned a new, unambiguous window. Apps that hand off to another process are not supported.",
  ],
] as const) {
  test(`helper launch refusal: ${scenario} never grants ownership`, async () => {
    const h = fake()
    h.launchError(error)
    const c = new UiaClient(h.api, readSettings(undefined).apps)
    await expect(c.call("launch", { app: "testWindow" })).rejects.toThrow(error)
    expect(h.requests).toHaveLength(1)
    for (const method of ["tree", "click", "type", "key", "close"])
      await expect(c.call(method, { window: WINDOW, ref: "e1", text: "x", keys: "enter" })).rejects.toThrow(
        "not obtained",
      )
    expect(h.requests).toHaveLength(1)
    h.launchError(undefined)
    const launched = await c.call("launch", { app: "testWindow" })
    expect(launched).toMatchObject({ window: WINDOW })
    await c.call("tree", { window: WINDOW })
    await c.stop()
  })
}

test("refs are window-local and invalidated on a new snapshot or close; enforce bounds", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "testWindow" })
  await expect(c.call("click", { window: WINDOW, ref: "e1" })).rejects.toThrow("latest tree")
  await c.call("tree", { window: WINDOW, maxNodes: 1 })
  await expect(c.call("type", { window: WINDOW, ref: "e2", text: "x" })).rejects.toThrow("latest tree")
  await c.call("click", { window: WINDOW, ref: "e1" })
  for (const params of [{ depth: -1 }, { depth: 31 }, { maxNodes: 0 }, { maxNodes: 1.1 }, { maxNodes: 1001 }])
    await expect(c.call("tree", { window: WINDOW, ...params })).rejects.toThrow("integer")
  h.tree('e8 Edit "new"')
  await c.call("tree", { window: WINDOW })
  await expect(c.call("click", { window: WINDOW, ref: "e1" })).rejects.toThrow("latest tree")
  await c.call("type", { window: WINDOW, ref: "e8", text: "héllo 你好" })
  await expect(c.call("type", { window: WINDOW, text: "x".repeat(20_001) })).rejects.toThrow("20000")
  await c.call("close", { window: WINDOW })
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  await c.stop()
})

test("tree cutting retains whole node lines with honest metrics and a cut note", async () => {
  const tree = formatTree({ text: "e1 Window\ne2 Edit\ncut note", nodes: 2, chars: 29, ms: 7, cut: false }, 1)
  expect(tree).toEqual({ text: "e1 Window", nodes: 1, chars: 9, ms: 7, cut: true })
  expect(
    formatTree({ text: `e1 ${"x".repeat(200_001)}`, nodes: 1, chars: 200_004, ms: 1, cut: false }, 300).cut,
  ).toBe(true)
  const h = fake()
  const c = setup(h.api, "win32")!
  await h.tools.get("ui_launch")!.execute({ app: "testWindow" }, ctx)
  const result = await h.tools.get("ui_tree")!.execute({ window: WINDOW, maxNodes: 1 }, ctx)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("tree cut") })
  await c.stop()
})

test("unreadable tree nodes preserve readable siblings but do not grant actionable refs", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "testWindow" })
  h.tree('e1 unreadable\ne2 Edit "readable sibling"')
  const tree = await c.call("tree", { window: WINDOW })
  expect(tree).toMatchObject({ nodes: 2, text: expect.stringContaining("unreadable") })
  const before = h.requests.length
  await expect(c.call("click", { window: WINDOW, ref: "e1" })).rejects.toThrow("latest tree")
  expect(h.requests).toHaveLength(before)
  await c.call("click", { window: WINDOW, ref: "e2" })
  await c.stop()
})

test("closing key and desktop-switching variants are refused before helper input", () => {
  expect(validateKeys(" CTRL + s ")).toBe("ctrl+s")
  expect(validateKeys("shift+tab")).toBe("shift+tab")
  for (const keys of [
    "alt+f4",
    "ALT+F4",
    "shift+alt+f4",
    "ctrl+alt+f4",
    "f4+alt",
    "alt+tab",
    "alt+escape",
    "ctrl+escape",
    "win+r",
    "ctrl+ctrl+s",
    "enter,enter",
  ])
    expect(() => validateKeys(keys)).toThrow()
})

test("helper death rejects pending work, invalidates ownership, restarts lazily; old events ignored", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "testWindow" })
  h.response(false)
  const pending = c.call("tree", { window: WINDOW })
  await Bun.sleep(10)
  h.pipes[0]!.options.onEvent({ type: "exit", code: 1 })
  await expect(pending).rejects.toThrow("helper exited")
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  expect(h.pipes).toHaveLength(1)
  h.response(true)
  const replacement = (await c.call("launch", { app: "testWindow" })) as { window: string }
  expect(h.pipes).toHaveLength(2)
  expect(h.watchdogs).toHaveLength(1)
  expect(replacement.window).not.toBe(WINDOW)
  h.pipes[0]!.options.onEvent({ type: "exit", code: 1 })
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  await c.call("tree", { window: replacement.window })
  await c.stop()
})

test("timeout closes the helper; session end and exit close stdin and stop the lifetime job", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps, 20)
  h.response(false)
  await expect(c.call("launch", { app: "testWindow" })).rejects.toThrow("timed out")
  expect(h.pipes[0]!.closed).toEqual([5000])
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  expect(h.requests).toHaveLength(1)
  await c.stop()
  const enabled = fake()
  setup(enabled.api, "win32")
  await enabled.tools.get("ui_launch")!.execute({ app: "testWindow" }, ctx)
  // The session-end callback expects an envelope, unlike onExit.
  const sessionEnd = enabled.handlers.get("session.end") as unknown as (event: object) => void
  sessionEnd({})
  await Bun.sleep(0)
  enabled.handlers.get("exit")!()
  expect(enabled.pipes[0]!.closed).toEqual([5000])
  expect(enabled.stopped).toEqual(["lifetime"])
})

test("watchdog loss fails closed and cleanup closes both pipes", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "testWindow" })
  h.watchdogs[0]!.options.onEvent({ type: "exit", code: 1 })
  expect(h.pipes[0]!.closed).toEqual([5000])
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  await c.stop()
  expect(h.stopped).toEqual(["lifetime"])
})

test("tool refusals and pre-start cancellation are returned as errors without starting a helper", async () => {
  const h = fake()
  const c = setup(h.api, "win32")!
  const refused = await h.tools.get("ui_tree")!.execute({ window: "999" }, ctx)
  expect(refused.isError).toBe(true)
  const cancelled = await h.tools.get("ui_launch")!.execute(
    { app: "testWindow" },
    {
      ...ctx,
      signal: AbortSignal.abort(),
    },
  )
  expect(cancelled.isError).toBe(true)
  expect(h.pipes).toHaveLength(0)
  await c.stop()
})

test("fake host unload stops the sentinel, retires the helper and invalidates owned handles", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "testWindow" })
  await h.api.backgroundJobs.stop("lifetime", 0)
  expect(h.pipes[0]!.closed).toEqual([5000])
  await expect(c.call("tree", { window: WINDOW })).rejects.toThrow("not obtained")
  await c.stop()
})

test("session end cancels startup and queued calls before creating any sentinel", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  const launch = c.call("launch", { app: "testWindow" })
  const queued = c.call("launch", { app: "testWindow" })
  await Promise.resolve() // start is suspended at its retirement barrier
  const stopping = c.stop()
  await expect(launch).rejects.toThrow("session ended")
  await expect(queued).rejects.toThrow("session ended")
  await stopping
  expect(h.started).toHaveLength(0)
  expect(h.pipes).toHaveLength(0)
})

test("watchdog startup failure is retired before a retry can start a helper", async () => {
  const h = fake()
  h.watchdogReady(false)
  const c = new UiaClient(h.api, readSettings(undefined).apps, 20)
  await expect(c.call("launch", { app: "testWindow" })).rejects.toThrow("watchdog failed to start")
  expect(h.watchdogs[0]!.closed).toEqual([5000])
  expect(h.pipes).toHaveLength(0)
  h.watchdogReady(true)
  await c.call("launch", { app: "testWindow" })
  expect(h.watchdogs).toHaveLength(2)
  expect(h.pipes).toHaveLength(1)
  await c.stop()
})

test("entry point public export snapshot", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toEqual(["default"])
})
