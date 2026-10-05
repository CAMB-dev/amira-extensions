import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import type { LaunchResult, TreeResult, UiaClient } from "../src/client.ts"
import { setup } from "../src/extension.ts"
import { captureHelper } from "./capture.ts"

const helper = `${import.meta.dir}/../helper/uia.ps1`

// Probe the input desktop, not its windows. Session 0 and locked/noninteractive desktops skip.
const interactive =
  process.platform === "win32" &&
  (await (async () => {
    const process = Bun.spawn(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        "-AppsJson",
        "{}",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    process.stdin.write(`${JSON.stringify({ id: 1, method: "desktop", params: {} })}\n`)
    process.stdin.end()
    const timer = setTimeout(() => process.kill(), 30_000)
    try {
      const [output, errors] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      const code = await process.exited
      if (code !== 0) throw new Error(`UIA desktop probe failed (${code}): ${errors}`)
      const response = JSON.parse(output.trim())
      if (response.error) throw new Error(response.error)
      return response.result.interactive === true
    } finally {
      clearTimeout(timer)
    }
  })())

function host() {
  const bus = new EventBus()
  const instance = new ExtensionHost({
    bus,
    tools: new ToolRegistry(),
    interceptors: new InterceptorRegistry(),
    settings: { extensions: { "computer-use-uia": { enabled: true } } },
    settingsLayers: {
      extensions: [
        { scope: "user", file: "test:user-settings", value: { "computer-use-uia": { enabled: true } } },
      ],
    },
    cwd: process.cwd(),
  })
  return { instance, bus }
}

function editRef(tree: TreeResult): string {
  const lines = tree.text.split("\n")
  const line =
    lines.find((line) => /\b(?:Edit|Document)\b/.test(line) && /readonly=false/.test(line)) ??
    lines.find((line) => /\bDocument\b/.test(line) && /text="/.test(line))
  const ref = line && /^\s*(e\d+)\s/.exec(line)?.[1]
  if (!ref) throw new Error(`No Edit element in the owned Notepad tree:\n${tree.text}`)
  return ref
}

async function until(done: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out awaiting owned process cleanup")
    await Bun.sleep(100)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(!interactive)(
  "real helper: owned Notepad Unicode round trip using the available pattern, guards, close",
  async () => {
    const { instance } = host()
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia")
    expect(client).toBeDefined()
    const c = client!
    const launched: LaunchResult[] = []
    try {
      await expect(c.call("tree", { window: "1" })).rejects.toThrow("not obtained")
      const notepad = (await c.call("launch", { app: "notepad" })) as LaunchResult
      launched.push(notepad)
      let tree = (await c.call("tree", { window: notepad.window })) as TreeResult
      console.log(`UIA manual measurement: notepad ${tree.nodes} nodes, ${tree.chars} chars, ${tree.ms} ms`)
      const message = "Amira UIA owned-window test — héllo 你好"
      const oldRef = editRef(tree)
      const editor = tree.text.split("\n").find((line) => line.trimStart().startsWith(`${oldRef} `))!
      const expectedPath = editor.includes('value="') ? "ValuePattern.SetValue" : "SendInput"
      const typed = await c.call("type", { window: notepad.window, ref: oldRef, text: message })
      expect(typed).toMatchObject({ path: expectedPath })
      if (expectedPath !== "ValuePattern.SetValue")
        console.log(
          "Notepad exposes TextPattern only: native ValuePattern not verified; exercising Unicode fallback",
        )
      tree = (await c.call("tree", { window: notepad.window })) as TreeResult
      expect(tree.text).toContain(message)
      expect(editRef(tree)).not.toBe(oldRef)
      const stale = await captured!.raw("click", { window: notepad.window, ref: oldRef })
      expect(stale.error).toContain("Unknown element")
      for (const keys of ["ALT+F4", "shift+alt+f4", "alt+tab", "ctrl+escape"]) {
        const refused = await captured!.raw("key", { window: notepad.window, keys })
        expect(refused.error).toContain("not permitted")
      }
      const key = await c.call("key", { window: notepad.window, keys: "ctrl+a" })
      expect(key).toMatchObject({ path: "SendInput" })
      console.log(`UIA round trip: ${expectedPath} + tree read-back matched Unicode text`)
      for (const app of launched) {
        await c.call("close", { window: app.window })
        await until(() => !alive(app.pid))
      }
      console.log("UIA close: owned Notepad PID exited")
    } finally {
      await c.stop()
      instance.unload("test:uia")
    }
  },
  180_000,
)

test.skipIf(!interactive)(
  "real host unload stops sentinel; helper closes only its launched Notepad",
  async () => {
    const { instance } = host()
    let client: UiaClient | undefined
    let api: ExtensionAPI | undefined
    await instance.load((value) => {
      api = value
      client = setup(value)
    }, "test:uia-unload")
    let launched: LaunchResult | undefined
    try {
      launched = (await client!.call("launch", { app: "notepad" })) as LaunchResult
      const jobs = api!.backgroundJobs.running()
      expect(jobs).toHaveLength(1)
      expect(instance.unload("test:uia-unload")).toBe(true)
      await until(() => !alive(launched!.pid))
      await until(() => jobs.every((job) => !job.pid || !alive(job.pid)))
    } finally {
      await client?.stop()
      instance.unload("test:uia-unload")
    }
  },
  120_000,
)

test.skipIf(!interactive)(
  "watchdog reaps owned app after helper death and restart invalidates handles",
  async () => {
    const { instance } = host()
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia-crash")
    try {
      const original = (await client!.call("launch", { app: "notepad" })) as LaunchResult
      const helperPid = captured!.pid()
      expect(helperPid).toBeGreaterThan(0)
      // Only the helper this test started, never an image-name or desktop-process search.
      process.kill(helperPid)
      await until(() => captured!.pid() === 0 && !alive(original.pid))
      await expect(client!.call("tree", { window: original.window })).rejects.toThrow("not obtained")
      const replacement = (await client!.call("launch", { app: "notepad" })) as LaunchResult
      expect(replacement.window).not.toBe(original.window)
      await client!.call("close", { window: replacement.window })
      await until(() => !alive(replacement.pid))
    } finally {
      await client?.stop()
      instance.unload("test:uia-crash")
    }
  },
  180_000,
)

// A fabricated HWND is refused in the helper too, before any AutomationElement lookup.
test.skipIf(process.platform !== "win32")(
  "helper independently refuses unknown apps/windows without desktop access",
  async () => {
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        "-AppsJson",
        JSON.stringify({ notepad: { command: "notepad.exe" } }),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    const requests = [
      { method: "launch", params: { app: "unknown" } },
      ...["tree", "click", "type", "key", "close"].map((method) => ({
        method,
        params: { window: "1", ref: "e1", text: "x", keys: "alt+f4" },
      })),
    ]
    for (const [i, request] of requests.entries())
      child.stdin.write(`${JSON.stringify({ id: i + 1, ...request })}\n`)
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const output = await new Response(child.stdout).text()
      const errors = await new Response(child.stderr).text()
      expect(await child.exited, errors).toBe(0)
      const responses = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(responses).toHaveLength(requests.length)
      expect(responses[0].error).toContain("notepad")
      for (const response of responses.slice(1))
        expect(response.error).toMatch(/Refused|not owned|not obtained/i)
    } finally {
      clearTimeout(timer)
    }
  },
  60_000,
)
