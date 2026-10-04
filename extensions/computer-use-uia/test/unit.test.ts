import { expect, test } from "bun:test"
import type { ExtensionAPI, OpenPipeOptions, ToolContext, ToolDefinition } from "@amira/api"
import { formatTree, UiaClient, validateKeys } from "../src/client.ts"
import { setup } from "../src/extension.ts"
import { readSettings } from "../src/settings.ts"

function fake(settings: unknown = { enabled: true }) {
  const pipes: { options: OpenPipeOptions; closed: number[] }[] = []
  const requests: { id: number; method: string; params: Record<string, unknown> }[] = []
  const stopped: string[] = []
  const handlers = new Map<string, () => void>()
  const tools = new Map<string, ToolDefinition>()
  const notices: string[] = []
  const errors: string[] = []
  let respond = true
  let text = 'e1 Window "owned" enabled=true offscreen=false\ne2 Edit "Text" enabled=true offscreen=false'
  const job = { id: "lifetime", pid: 42, status: "running" }
  const api = {
    cwd: process.cwd(),
    settings: { extensions: { "computer-use-uia": settings } },
    backgroundJobs: {
      start: () => job,
      get: () => job,
      waitFor: async () => ({ reason: "match" }),
      stop: async (id: string) => { stopped.push(id) },
    },
    openPipe(_argv: string[], options: OpenPipeOptions) {
      const pipe = { options, closed: [] as number[] }
      pipes.push(pipe)
      return {
        write(data: string) {
          const request = JSON.parse(data)
          requests.push(request)
          if (!respond) return
          const result = request.method === "launch"
            ? { window: "123", pid: 17, title: "owned" }
            : request.method === "tree"
              ? { text, nodes: 2, chars: text.length, ms: 12, cut: false }
              : { path: "ValuePattern.SetValue" }
          // Exercise line framing, with both fragmented and CRLF responses.
          const line = `${JSON.stringify({ id: request.id, result })}\r\n`
          queueMicrotask(() => {
            options.onEvent({ type: "stdout", data: line.slice(0, 15) })
            options.onEvent({ type: "stdout", data: line.slice(15) })
          })
        },
        close(ms: number) { pipe.closed.push(ms) },
      }
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} },
    on(type: string, handler: () => void) { handlers.set(type, handler); return () => {} },
    onExit(handler: () => void) { handlers.set("exit", handler); return () => {} },
    notify(message: string) { notices.push(message) },
    reportError(message: string) { errors.push(message) },
  } as unknown as ExtensionAPI
  return {
    api, pipes, requests, stopped, handlers, tools, notices, errors,
    response(value: boolean) { respond = value },
    tree(value: string) { text = value },
  }
}

const ctx: ToolContext = {
  cwd: process.cwd(), toolCallId: "t", signal: new AbortController().signal, update() {},
}

test("off by default; apps settings replace defaults and validate without partial enablement", () => {
  expect(readSettings(undefined).enabled).toBe(false)
  expect(Object.keys(readSettings(undefined).apps)).toEqual(["notepad", "calculator"])
  expect(readSettings({ enabled: true, apps: {} })).toEqual({ enabled: true, apps: {} })
  expect(readSettings({ apps: { demo: { command: "demo.exe", args: ["--x"] } } }).apps.demo).toEqual({
    command: "demo.exe", args: ["--x"],
  })
  for (const bad of [false, { enabled: "always" }, { apps: [] }, { apps: { demo: { command: "x", args: [1] } } }])
    expect(() => readSettings(bad)).toThrow()
  const disabled = fake(undefined)
  setup(disabled.api, "win32")
  expect(disabled.tools.size).toBe(0)
  expect(disabled.pipes.length).toBe(0)
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
  await h.tools.get("ui_launch")!.execute({ app: "notepad" }, ctx)
  const tree = await h.tools.get("ui_tree")!.execute({ window: "123" }, ctx)
  expect(tree.content).toEqual([{ type: "text", text: expect.stringContaining("12 ms; 2 nodes;") }])
  await client.stop()
})

test("allowlist and ownership refusals never send a request to the helper", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  for (const name of ["unknown", "__proto__", "constructor", "notepad.exe"])
    await expect(c.call("launch", { app: name })).rejects.toThrow("Allowed apps: notepad, calculator")
  for (const method of ["tree", "click", "type", "key", "close"])
    await expect(c.call(method, { window: "999", ref: "e1" })).rejects.toThrow("not obtained")
  expect(h.requests).toHaveLength(0)
  expect(h.pipes).toHaveLength(0)
  await c.call("launch", { app: "notepad", command: "evil.exe", window: "999" })
  expect(h.requests[0]?.params).toEqual({ app: "notepad" })
  await c.stop()
})

test("refs are window-local and invalidated on a new snapshot or close; enforce bounds", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "notepad" })
  await expect(c.call("click", { window: "123", ref: "e1" })).rejects.toThrow("latest tree")
  await c.call("tree", { window: "123", maxNodes: 1 })
  await expect(c.call("type", { window: "123", ref: "e2", text: "x" })).rejects.toThrow("latest tree")
  await c.call("click", { window: "123", ref: "e1" })
  for (const params of [{ depth: -1 }, { depth: 31 }, { maxNodes: 0 }, { maxNodes: 1.1 }, { maxNodes: 1001 }])
    await expect(c.call("tree", { window: "123", ...params })).rejects.toThrow("integer")
  h.tree('e8 Edit "new"')
  await c.call("tree", { window: "123" })
  await expect(c.call("click", { window: "123", ref: "e1" })).rejects.toThrow("latest tree")
  await c.call("type", { window: "123", ref: "e8", text: "héllo 你好" })
  await expect(c.call("type", { window: "123", text: "x".repeat(20_001) })).rejects.toThrow("20000")
  await c.call("close", { window: "123" })
  await expect(c.call("tree", { window: "123" })).rejects.toThrow("not obtained")
  await c.stop()
})

test("tree cutting retains whole node lines with honest metrics and a cut note", async () => {
  const tree = formatTree({ text: "e1 Window\ne2 Edit\ncut note", nodes: 2, chars: 29, ms: 7, cut: false }, 1)
  expect(tree).toEqual({ text: "e1 Window", nodes: 1, chars: 9, ms: 7, cut: true })
  expect(formatTree({ text: `e1 ${"x".repeat(200_001)}`, nodes: 1, chars: 200_004, ms: 1, cut: false }, 300).cut).toBe(true)
  const h = fake()
  const c = setup(h.api, "win32")!
  await h.tools.get("ui_launch")!.execute({ app: "notepad" }, ctx)
  const result = await h.tools.get("ui_tree")!.execute({ window: "123", maxNodes: 1 }, ctx)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("tree cut") })
  await c.stop()
})

test("closing key and desktop-switching variants are refused before helper input", () => {
  expect(validateKeys(" CTRL + s ")).toBe("ctrl+s")
  expect(validateKeys("shift+tab")).toBe("shift+tab")
  for (const keys of ["alt+f4", "ALT+F4", "shift+alt+f4", "ctrl+alt+f4", "f4+alt", "alt+tab", "alt+escape", "ctrl+escape", "win+r", "ctrl+ctrl+s", "enter,enter"])
    expect(() => validateKeys(keys)).toThrow()
})

test("helper death rejects pending work, invalidates ownership, restarts lazily; old events ignored", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps)
  await c.call("launch", { app: "notepad" })
  h.response(false)
  const pending = c.call("tree", { window: "123" })
  await Bun.sleep(10)
  h.pipes[0]!.options.onEvent({ type: "exit", code: 1 })
  await expect(pending).rejects.toThrow("helper exited")
  await expect(c.call("tree", { window: "123" })).rejects.toThrow("not obtained")
  expect(h.pipes).toHaveLength(1)
  h.response(true)
  await c.call("launch", { app: "calculator" })
  expect(h.pipes).toHaveLength(2)
  h.pipes[0]!.options.onEvent({ type: "exit", code: 1 })
  await c.call("tree", { window: "123" })
  await c.stop()
})

test("timeout closes the helper; session end and exit close stdin and stop the lifetime job", async () => {
  const h = fake()
  const c = new UiaClient(h.api, readSettings(undefined).apps, 20)
  h.response(false)
  await expect(c.call("launch", { app: "notepad" })).rejects.toThrow("timed out")
  expect(h.pipes[0]!.closed).toEqual([5000])
  await c.stop()
  const enabled = fake()
  setup(enabled.api, "win32")
  await enabled.tools.get("ui_launch")!.execute({ app: "notepad" }, ctx)
  // The session-end callback expects an envelope, unlike onExit.
  const sessionEnd = enabled.handlers.get("session.end") as unknown as (event: object) => void
  sessionEnd({})
  await Bun.sleep(0)
  enabled.handlers.get("exit")!()
  expect(enabled.pipes[0]!.closed).toEqual([5000])
  expect(enabled.stopped).toEqual(["lifetime"])
})

test("entry point public export snapshot", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toEqual(["default"])
})
