import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import type { LaunchResult, TreeResult, UiaClient } from "../src/client.ts"
import { setup } from "../src/extension.ts"

const helper = `${import.meta.dir}/../helper/uia.ps1`

// Probe the input desktop, not its windows. Session 0 and locked/noninteractive desktops skip.
const interactive = process.platform === "win32" && await (async () => {
  const process = Bun.spawn([
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", helper, "-AppsJson", "{}",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  process.stdin.write(`${JSON.stringify({ id: 1, method: "desktop", params: {} })}\n`)
  process.stdin.end()
  const timer = setTimeout(() => process.kill(), 30_000)
  try {
    const [output, errors] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()])
    const code = await process.exited
    if (code !== 0) throw new Error(`UIA desktop probe failed (${code}): ${errors}`)
    const response = JSON.parse(output.trim())
    if (response.error) throw new Error(response.error)
    return response.result.interactive === true
  } finally {
    clearTimeout(timer)
  }
})()

function host() {
  const bus = new EventBus()
  const instance = new ExtensionHost({
    bus,
    tools: new ToolRegistry(),
    interceptors: new InterceptorRegistry(),
    settings: { extensions: { "computer-use-uia": { enabled: true } } },
    cwd: process.cwd(),
  })
  return { instance, bus }
}

function editRef(tree: TreeResult): string {
  const line = tree.text.split("\n").find((line) => /\bEdit\b/.test(line))
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
  try { process.kill(pid, 0); return true } catch { return false }
}

test.skipIf(!interactive)("real helper: only owned Notepad, ValuePattern round trip, calculator measurement, close", async () => {
  const { instance } = host()
  let client: UiaClient | undefined
  await instance.load((api) => { client = setup(api) }, "test:uia")
  expect(client).toBeDefined()
  const c = client!
  const launched: LaunchResult[] = []
  try {
    await expect(c.call("tree", { window: "1" })).rejects.toThrow("not obtained")
    const notepad = await c.call("launch", { app: "notepad" }) as LaunchResult
    launched.push(notepad)
    let tree = await c.call("tree", { window: notepad.window }) as TreeResult
    console.log(`UIA manual measurement: notepad ${tree.nodes} nodes, ${tree.chars} chars, ${tree.ms} ms`)
    const message = "Amira UIA owned-window test — héllo 你好"
    const typed = await c.call("type", { window: notepad.window, ref: editRef(tree), text: message })
    expect(typed).toMatchObject({ path: "ValuePattern.SetValue" })
    tree = await c.call("tree", { window: notepad.window }) as TreeResult
    expect(tree.text).toContain(message)
    console.log("UIA manual round trip: ValuePattern.SetValue + tree read-back matched Unicode text")
    const calculator = await c.call("launch", { app: "calculator" }) as LaunchResult
    launched.push(calculator)
    const calcTree = await c.call("tree", { window: calculator.window }) as TreeResult
    console.log(`UIA manual measurement: calculator ${calcTree.nodes} nodes, ${calcTree.chars} chars, ${calcTree.ms} ms`)
    for (const app of launched) {
      await c.call("close", { window: app.window })
      await until(() => !alive(app.pid))
    }
    console.log("UIA manual close: both owned app PIDs exited")
  } finally {
    await c.stop()
    instance.unload("test:uia")
  }
}, 180_000)

test.skipIf(!interactive)("real host unload stops sentinel; helper closes only its launched Notepad", async () => {
  const { instance } = host()
  let client: UiaClient | undefined
  let api: ExtensionAPI | undefined
  await instance.load((value) => { api = value; client = setup(value) }, "test:uia-unload")
  let launched: LaunchResult | undefined
  try {
    launched = await client!.call("launch", { app: "notepad" }) as LaunchResult
    const jobs = api!.backgroundJobs.running()
    expect(jobs).toHaveLength(1)
    expect(instance.unload("test:uia-unload")).toBe(true)
    await until(() => !alive(launched!.pid))
    await until(() => jobs.every((job) => !job.pid || !alive(job.pid)))
  } finally {
    await client?.stop()
    instance.unload("test:uia-unload")
  }
}, 120_000)

// A fabricated HWND is refused in the helper too, before any AutomationElement lookup.
test.skipIf(process.platform !== "win32")("helper independently refuses unknown apps/windows and closing chords", async () => {
  const child = Bun.spawn([
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", helper, "-AppsJson", JSON.stringify({ notepad: { command: "notepad.exe" } }),
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const requests = [
    { method: "launch", params: { app: "unknown" } },
    ...["tree", "click", "type", "key", "close"].map((method) => ({ method, params: { window: "1", ref: "e1", text: "x", keys: "alt+f4" } })),
  ]
  for (const [i, request] of requests.entries()) child.stdin.write(`${JSON.stringify({ id: i + 1, ...request })}\n`)
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    expect(await child.exited, errors).toBe(0)
    const responses = output.trim().split("\n").map((line) => JSON.parse(line))
    expect(responses).toHaveLength(requests.length)
    expect(responses[0].error).toContain("notepad")
    for (const response of responses.slice(1)) expect(response.error).toMatch(/Refused|not owned|not obtained/i)
  } finally {
    clearTimeout(timer)
  }
}, 60_000)
