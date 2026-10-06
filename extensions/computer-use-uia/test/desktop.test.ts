import { expect, test } from "bun:test"
import type { ExtensionAPI, PipeProcess } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import type { LaunchResult, TreeResult, UiaClient, WindowResult } from "../src/client.ts"
import { setup } from "../src/extension.ts"
import { captureHelper } from "./capture.ts"

// Explicit opt-in only. Importing/skipping this file NEVER starts a process or registers hotkeys.
// Do not run on a machine someone is using. All reads/actions below target our unique fixture.
const enabled = process.platform === "win32" && process.env.AMIRA_UIA_DESKTOP_TESTS === "1"

function host(overlay = true) {
  const settings = { enabled: true, overlay }
  return new ExtensionHost({
    bus: new EventBus(),
    tools: new ToolRegistry(),
    interceptors: new InterceptorRegistry(),
    settings: { extensions: { "computer-use-uia": settings } },
    settingsLayers: {
      extensions: [{ scope: "user", file: "test:user", value: { "computer-use-uia": settings } }],
    },
    cwd: process.cwd(),
  })
}

function ref(tree: TreeResult, name: string): string {
  const lines = tree.text
    .split("\n")
    .filter(
      (line) =>
        line.includes(` name="${name}" `) && / (?:Edit|Document|Button|CheckBox|ComboBox) name=/.test(line),
    )
  const found = lines.length === 1 && /^\s*(e\d+)\s/.exec(lines[0]!)?.[1]
  if (!found) throw new Error(`Expected one fixture control named ${name}`)
  return found
}

async function until(done: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out awaiting test-owned process cleanup")
    await Bun.sleep(50)
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

async function fixture(c: UiaClient, track: (pid: number) => void, position: string[] = []) {
  const title = `Amira-UIA-test-${crypto.randomUUID()}`
  const launched = (await c.call("launch", {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      `${import.meta.dir}/../helper/test-window.ps1`,
      "-Title",
      title,
      ...position,
    ],
  })) as LaunchResult
  track(launched.pid) // Retain cleanup identity even if discovery/assertions below fail.
  // Filter BEFORE returning/acting. Never print or inspect the list of unrelated window titles.
  const result = (await c.call("windows", { filter: title })) as { windows: WindowResult[] }
  const own = result.windows.filter((window) => window.pid === launched.pid && window.title === title)
  if (own.length !== 1) throw new Error("Expected one newly launched fixture window")
  return { window: own[0]!.window, pid: launched.pid, title }
}

async function minimizedState(c: UiaClient, app: Awaited<ReturnType<typeof fixture>>, minimized: boolean) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = (await c.call("windows", { filter: app.title })) as { windows: WindowResult[] }
    if (result.windows.find((window) => window.pid === app.pid)?.minimized === minimized) return
    await Bun.sleep(50)
  }
  throw new Error("Fixture did not reach expected minimized/restored state")
}

test.skipIf(!enabled)(
  "fixture list/filter/tree/type/click/key/focus/close; overlay never gets foreground",
  async () => {
    const instance = host()
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia")
    const c = client!
    let app: Awaited<ReturnType<typeof fixture>> | undefined
    let launchedPid = 0
    try {
      app = await fixture(c, (pid) => {
        launchedPid = pid
      })
      await c.call("focus", { window: app.window })
      let tree = (await c.call("tree", { window: app.window })) as TreeResult
      const password = tree.text.split("\n").find((line) => line.includes('name="Password"'))!
      expect(password).toContain("password=true")
      expect(password).not.toMatch(/ value=| text=/)
      expect(tree.text).not.toContain("fixture-secret-never-returned")
      const edit = ref(tree, "Single-line text")
      const cursorBefore = await captured!.inspectOverlay()
      const typed = await c.call("type", { window: app.window, ref: edit, text: "héllo 你好" })
      expect(typed).toMatchObject({ path: "ValuePattern.SetValue" })
      tree = (await c.call("tree", { window: app.window })) as TreeResult
      expect(tree.text).toContain("héllo 你好")
      const stale = await captured!.raw("click", { window: app.window, ref: edit })
      expect(stale.error).toContain("Unknown element")
      const clicked = await c.call("click", { window: app.window, ref: ref(tree, "Change label") })
      expect(clicked).toMatchObject({ path: "InvokePattern" })
      const overlay = await captured!.inspectOverlay()
      expect(overlay.foreground).toBe(false)
      expect(overlay.gliding).toBe(false)
      expect(overlay.kind).toBe("click")
      expect(overlay.ripple).toBe(true)
      expect([overlay.cursorX, overlay.cursorY]).toEqual([cursorBefore.cursorX, cursorBefore.cursorY])
      const action = captured!.actions.find((action) => action.id === overlay.actionId)!
      const glide = captured!.glides.find((glide) => glide.id === action.id)!
      expect(action.kind).toBe("click")
      expect(glide.at - action.at).toBeGreaterThanOrEqual(250)
      expect(glide.at - action.at).toBeLessThan(1500)
      expect([overlay.x, overlay.y]).toEqual([overlay.targetX, overlay.targetY])
      expect(overlay.hitRoot).toBe(app.window)
      const requiredStyles = 0x20 | 0x80000 | 0x8 | 0x80 | 0x08000000
      expect((overlay.styles as number) & requiredStyles).toBe(requiredStyles)
      expect(captured!.overlayEvents).toContain("glided")
      const filtered = (await c.call("windows", { filter: app.title })) as { windows: WindowResult[] }
      expect(
        filtered.windows.filter((window) => window.pid === app!.pid).every((window) => window.foreground),
      ).toBe(true)
      tree = (await c.call("tree", { window: app.window })) as TreeResult
      expect(tree.text).toContain('name="Button clicked"')
      await c.call("click", { window: app.window, ref: ref(tree, "Enable option") })
      await c.call("key", { window: app.window, keys: "tab" })
      const chord = await captured!.inspectOverlay()
      expect(chord.kind).toBe("key")
      await c.call("key", { window: app.window, keys: "ctrl+m" })
      await minimizedState(c, app, true)
      await c.call("focus", { window: app.window })
      await minimizedState(c, app, false)
      const closed = await c.call("close", { window: app.window })
      expect(closed).toMatchObject({ closed: true })
      await until(() => !alive(app!.pid))
      const monitorPid = captured!.overlayPid()
      await Bun.sleep(3300)
      expect((await captured!.inspectOverlay()).visible).toBe(false)
      await c.stop()
      await until(() => !alive(monitorPid))
    } finally {
      try {
        await c.stop()
      } finally {
        // Exact journal also covers fixture discovery failures.
        instance.unload("test:uia")
        if (launchedPid) await until(() => !alive(launchedPid))
      }
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "unlaunched-to-extension fixture is actionable but never kill-eligible",
  async () => {
    const instance = host()
    let api: ExtensionAPI | undefined
    let client: UiaClient | undefined
    let fixturePipe: PipeProcess | undefined
    let pid = 0
    let exited = false
    const title = `Amira-UIA-test-${crypto.randomUUID()}`
    await instance.load((hostApi) => {
      api = captureHelper(hostApi).api
      client = setup(api)
    }, "test:uia-foreign")
    try {
      // The TEST launches this fixture directly; ui_launch never owns/journals it.
      fixturePipe = api!.openPipe(
        [
          "powershell.exe",
          "-NoProfile",
          "-STA",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          `${import.meta.dir}/../helper/test-window.ps1`,
          "-Title",
          title,
          "-IgnoreClose",
        ],
        {
          cwd: process.cwd(),
          onEvent(event) {
            if (event.type === "spawned") pid = event.pid
            if (event.type === "exit") exited = true
          },
        },
      )
      await until(() => pid > 0)
      let window: string | undefined
      const deadline = Date.now() + 20_000
      while (!window && Date.now() < deadline) {
        const result = (await client!.call("windows", { filter: title })) as { windows: WindowResult[] }
        window = result.windows.find((entry) => entry.pid === pid && entry.title === title)?.window
        if (!window) await Bun.sleep(100)
      }
      if (!window) throw new Error("Test-started external fixture window unavailable")
      const tree = (await client!.call("tree", { window })) as TreeResult
      await client!.call("type", { window, ref: ref(tree, "Single-line text"), text: "external fixture" })
      await client!.call("click", { window, ref: ref(tree, "Change label") })
      await client!.call("key", { window, keys: "tab" })
      await client!.call("focus", { window })
      expect(await client!.call("close", { window })).toMatchObject({ closed: false, terminated: false })
      await client!.stop()
      expect(alive(pid)).toBe(true) // IgnoreClose: neither close nor session cleanup may kill it.
    } finally {
      try {
        await client?.stop()
      } finally {
        fixturePipe?.close(0) // Host-owned handle of THIS test's process, not an image name.
        instance.unload("test:uia-foreign")
        if (fixturePipe) await until(() => exited)
      }
    }
  },
  180_000,
)

// Dedicated mixed-DPI desktop: set coordinates on a negative-coordinate secondary monitor.
// Never infer a location from unrelated windows, and do not run this on an occupied desktop.
const negativePosition = process.env.AMIRA_UIA_TEST_LEFT && process.env.AMIRA_UIA_TEST_TOP

test.skipIf(!enabled || !negativePosition)(
  "physical pointer point on a mixed-DPI negative monitor",
  async () => {
    const instance = host()
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    let launchedPid = 0
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia-dpi")
    try {
      const app = await fixture(
        client!,
        (pid) => {
          launchedPid = pid
        },
        ["-Left", process.env.AMIRA_UIA_TEST_LEFT!, "-Top", process.env.AMIRA_UIA_TEST_TOP!],
      )
      await client!.call("focus", { window: app.window })
      const tree = (await client!.call("tree", { window: app.window })) as TreeResult
      await client!.call("click", { window: app.window, ref: ref(tree, "Change label") })
      const pointer = await captured!.inspectOverlay()
      expect((pointer.x as number) < 0 || (pointer.y as number) < 0).toBe(true)
      expect([pointer.x, pointer.y]).toEqual([pointer.targetX, pointer.targetY])
      expect(pointer.hitRoot).toBe(app.window)
      expect(pointer.foreground).toBe(false)
      const monitorPid = captured!.overlayPid()
      captured!.crashHelper()
      await until(() => client!.emergency.stopped && !alive(monitorPid) && !alive(launchedPid))
    } finally {
      try {
        await client?.stop()
      } finally {
        instance.unload("test:uia-dpi")
        if (launchedPid) await until(() => !alive(launchedPid))
      }
    }
  },
  180_000,
)

for (const overlay of [true, false]) {
  test.skipIf(!enabled)(
    `simulated stop with rendering ${overlay}; no test hotkeys, helper and overlay exit`,
    async () => {
      const instance = host(overlay)
      let client: UiaClient | undefined
      let captured: ReturnType<typeof captureHelper> | undefined
      await instance.load((api) => {
        captured = captureHelper(api)
        client = setup(captured.api)
      }, `test:uia-stop-${overlay}`)
      let app: Awaited<ReturnType<typeof fixture>> | undefined
      let launchedPid = 0
      try {
        app = await fixture(client!, (pid) => {
          launchedPid = pid
        })
        await client!.call("tree", { window: app.window })
        const helperPid = captured!.pid()
        const overlayPid = captured!.overlayPid()
        captured!.simulateStop()
        await until(() => client!.emergency.stopped)
        await expect(client!.call("focus", { window: app.window })).rejects.toThrow(
          "the user stopped desktop control",
        )
        await until(() => !alive(helperPid) && !alive(overlayPid) && !alive(app!.pid))
      } finally {
        try {
          await client?.stop()
        } finally {
          instance.unload(`test:uia-stop-${overlay}`)
          if (launchedPid) await until(() => !alive(launchedPid))
        }
      }
    },
    120_000,
  )
}
