/** Explicit owned-app smoke run: bun scripts/smoke.ts (never attaches to existing apps). */
import type { ExtensionAPI } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import type { LaunchResult, TreeResult, UiaClient } from "../src/client.ts"
import { setup } from "../src/extension.ts"

if (process.platform !== "win32") {
  console.log("computer-use-uia smoke: skipped (Windows only)")
  process.exit(0)
}

const settings = { enabled: true }
const host = new ExtensionHost({
  bus: new EventBus(),
  tools: new ToolRegistry(),
  interceptors: new InterceptorRegistry(),
  settings: { extensions: { "computer-use-uia": settings } },
  settingsLayers: {
    extensions: [{ scope: "user", file: "smoke:explicit-opt-in", value: { "computer-use-uia": settings } }],
  },
  cwd: process.cwd(),
})
let client: UiaClient | undefined
let api: ExtensionAPI | undefined
await host.load((value) => {
  api = value
  client = setup(value)
}, "smoke:uia")
try {
  const probe = await api!.runCommand(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      `${import.meta.dir}/../helper/uia.ps1`,
      "-AppsJson",
      "{}",
    ],
    {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: AbortSignal.timeout(35_000),
      stdoutOnly: true,
      stdin: JSON.stringify({ id: 1, method: "desktop", params: {} }),
    },
  )
  const desktop = JSON.parse(probe.output.trim()) as { result?: { interactive: boolean }; error?: string }
  if (desktop.error || probe.exitCode !== 0) throw new Error(desktop.error ?? "Desktop probe failed")
  if (!desktop.result?.interactive) {
    console.log("computer-use-uia smoke: skipped (no active, unlocked interactive desktop)")
  } else {
    const apps: LaunchResult[] = []
    for (const app of Object.keys(client!.apps)) {
      const launched = (await client!.call("launch", { app })) as LaunchResult
      apps.push(launched)
      const tree = (await client!.call("tree", { window: launched.window })) as TreeResult
      console.log(`${app}: ${tree.nodes} nodes, ${tree.chars} chars, ${tree.ms} ms`)
      const edits = tree.text.split("\n").filter((line) => line.includes(' Edit name="Multiline text" '))
      const ref = edits.length === 1 && /^\s*(e\d+)\s/.exec(edits[0]!)?.[1]
      if (!ref) throw new Error("Expected one named multiline Edit control in the launched testWindow")
      const text = "Amira owned-window smoke — héllo 你好"
      const typed = await client!.call("type", { window: launched.window, ref, text })
      const read = (await client!.call("tree", { window: launched.window })) as TreeResult
      if (!read.text.includes(text)) throw new Error("Owned testWindow read-back did not match")
      console.log(`testWindow type + read-back: matched; ${JSON.stringify(typed)}`)
    }
    for (const app of apps) {
      const closed = (await client!.call("close", { window: app.window })) as { closed: boolean }
      if (!closed.closed) throw new Error("Owned app did not close")
      console.log(`closed owned PID ${app.pid}`)
    }
  }
} finally {
  await client?.stop()
  host.unload("smoke:uia")
}
