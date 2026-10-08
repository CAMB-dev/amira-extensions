import { expect, test } from "bun:test"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
      expect(password).toMatch(/password=(?:true|unknown)/)
      expect(password).not.toMatch(/ value=| text=/)
      expect(tree.text).not.toContain("fixture-secret-never-returned")
      const edit = ref(tree, "Single-line text")
      const cursorBefore = await captured!.inspectOverlay()
      const typed = await c.call("type", { window: app.window, ref: edit, text: "héllo 你好" })
      expect(typed).toMatchObject({ path: "ValuePattern.SetValue" })
      tree = (await c.call("tree", { window: app.window })) as TreeResult
      const singleline = tree.text
        .split("\n")
        .find((line) => line.includes('name="Single-line text"') && / Edit /.test(line))!
      expect(singleline).toContain('value="héllo 你好"')
      expect(singleline).not.toContain("password=")
      const multiline = ref(tree, "Multiline text")
      await c.call("type", { window: app.window, ref: multiline, text: "first line\nsecond line" })
      tree = (await c.call("tree", { window: app.window })) as TreeResult
      const document = tree.text
        .split("\n")
        .find((line) => line.includes('name="Multiline text"') && / (?:Edit|Document) /.test(line))!
      expect(document).toMatch(/(?:value|text)="first line\\(?:r\\)?nsecond line"/)
      expect(document).not.toContain("password=")
      const stale = await captured!.raw("click", { window: app.window, ref: edit })
      expect(stale.error).toContain("Unknown element")
      const clicked = await c.call("click", { window: app.window, ref: ref(tree, "Change label") })
      expect(clicked).toMatchObject({ path: "InvokePattern" })
      const overlay = await captured!.inspectOverlay()
      expect(overlay.foreground).toBe(false)
      expect(overlay.hooks).toBe(true)
      expect(overlay.gliding).toBe(false)
      expect(overlay.kind).toBe("click")
      expect(overlay.ripple).toBe(true)
      expect([overlay.cursorX, overlay.cursorY]).toEqual([cursorBefore.cursorX, cursorBefore.cursorY])
      const action = captured!.actions.find((action) => action.id === overlay.actionId)!
      const glide = captured!.glides.find((glide) => glide.id === action.id)!
      expect(action.kind).toBe("click")
      expect(glide.at - action.at).toBeGreaterThanOrEqual(250)
      expect(glide.at - action.at).toBeLessThan(5000)
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
      await c.call("key", { window: app.window, keys: "escape" })
      await c.call("key", { window: app.window, keys: "escape" })
      expect(c.emergency.stopped).toBe(false) // Injected model keys are never a user stop.
      await c.call("key", { window: app.window, keys: "tab" })
      const chord = await captured!.inspectOverlay()
      expect(chord.kind).toBe("key")
      await c.call("key", { window: app.window, keys: "ctrl+m" })
      await minimizedState(c, app, true)
      await c.call("focus", { window: app.window })
      await minimizedState(c, app, false)
      const closed = await c.call("close", { window: app.window })
      expect(closed).toMatchObject({ closed: true, terminated: false })
      await until(() => !alive(app!.pid))
      const monitorPid = captured!.overlayPid()
      await Bun.sleep(3300)
      const idle = await captured!.inspectOverlay()
      expect(idle.visible).toBe(false)
      expect(idle.hooks).toBe(false)
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

test.skipIf(!enabled)(
  "launched IgnoreClose fixture survives ui_close; exact cleanup kills it with overlay off",
  async () => {
    const instance = host(false)
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    let launchedPid = 0
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia-polite-close")
    try {
      const app = await fixture(
        client!,
        (pid) => {
          launchedPid = pid
        },
        ["-IgnoreClose"],
      )
      const tree = (await client!.call("tree", { window: app.window })) as TreeResult
      await client!.call("type", { window: app.window, ref: ref(tree, "Single-line text"), text: "retained" })
      await client!.call("click", { window: app.window, ref: ref(tree, "Change label") })
      await client!.call("key", { window: app.window, keys: "tab" })
      await client!.call("focus", { window: app.window })
      expect(await client!.call("close", { window: app.window })).toMatchObject({
        closed: false,
        terminated: false,
      })
      expect(alive(app.pid)).toBe(true)
      expect(captured!.overlayPid()).toBe(0) // Explicit opt-out: no pointer, hooks or stop monitor.
      expect(captured!.actions).toHaveLength(0) // No animation events/ack waits when rendering is off.
      expect(client!.emergency.stopped).toBe(false)
      expect(((await client!.call("tree", { window: app.window })) as TreeResult).text).toContain(
        'value="retained"',
      )
      await client!.stop()
      await until(() => !alive(app.pid))
    } finally {
      try {
        await client?.stop()
      } finally {
        instance.unload("test:uia-polite-close")
        if (launchedPid) await until(() => !alive(launchedPid))
      }
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "overlay acknowledgement timeout keeps helper alive and consumes a late acknowledgement",
  async () => {
    const instance = host()
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    let launchedPid = 0
    let delayNextAck = false
    let lateAck: ReturnType<typeof setTimeout> | undefined
    await instance.load((api) => {
      captured = captureHelper({
        ...api,
        openPipe(argv, options) {
          const pipe = api.openPipe(argv, options)
          if (!argv.some((arg) => arg.endsWith("uia.ps1"))) return pipe
          return {
            ...pipe,
            write(line) {
              if (delayNextAck && line.includes('"method":"overlay_ack"')) {
                delayNextAck = false
                lateAck = setTimeout(() => {
                  pipe.write(line)
                }, 5500)
                return
              }
              return pipe.write(line)
            },
          }
        },
      })
      client = setup(captured.api)
    }, "test:uia-late-ack")
    try {
      const app = await fixture(client!, (pid) => {
        launchedPid = pid
      })
      const tree = (await client!.call("tree", { window: app.window })) as TreeResult
      const helperPid = captured!.pid()
      delayNextAck = true
      const began = Date.now()
      expect(
        await client!.call("type", {
          window: app.window,
          ref: ref(tree, "Single-line text"),
          text: "after timeout",
        }),
      ).toMatchObject({ path: "ValuePattern.SetValue" })
      expect(Date.now() - began).toBeGreaterThanOrEqual(4900)
      expect(alive(helperPid)).toBe(true)
      expect(client!.emergency.stopped).toBe(false)
      expect(((await client!.call("tree", { window: app.window })) as TreeResult).text).toContain(
        'value="after timeout"',
      )
      await Bun.sleep(1000) // Let the pending shared read receive the late ack.
      await client!.call("key", { window: app.window, keys: "tab" })
      expect(client!.emergency.stopped).toBe(false)
    } finally {
      if (lateAck) clearTimeout(lateAck)
      try {
        await client?.stop()
      } finally {
        instance.unload("test:uia-late-ack")
        if (launchedPid) await until(() => !alive(launchedPid))
      }
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "test-owned AmiraPid target is readable but focus/close/click/type/key are refused",
  async () => {
    const instance = host(false)
    let api: ExtensionAPI | undefined
    let client: UiaClient | undefined
    let fixturePipe: PipeProcess | undefined
    let pid = 0
    let exited = false
    const title = `Amira-UIA-test-${crypto.randomUUID()}`
    await instance.load((hostApi) => {
      api = hostApi
    }, "test:uia-protected")
    try {
      // Substitute only this test's isolated fixture for AmiraPid: never target the actual terminal.
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
      const captured = captureHelper({
        ...api!,
        openPipe(argv, options) {
          if (!argv.some((arg) => arg.endsWith("uia.ps1"))) return api!.openPipe(argv, options)
          const args = [...argv]
          const index = args.indexOf("-AmiraPid")
          if (index >= 0) args[index + 1] = String(pid)
          else args.push("-AmiraPid", String(pid))
          return api!.openPipe(args, options)
        },
      })
      client = setup(captured.api)!
      let window: string | undefined
      const deadline = Date.now() + 20_000
      while (!window && Date.now() < deadline) {
        const result = (await client.call("windows", { filter: title })) as { windows: WindowResult[] }
        window = result.windows.find((entry) => entry.pid === pid && entry.title === title)?.window
        if (!window) await Bun.sleep(100)
      }
      if (!window) throw new Error("Protected test-owned fixture unavailable")
      const tree = (await client.call("tree", { window })) as TreeResult
      expect(tree.text).toContain('name="Single-line text"')
      for (const [method, params] of [
        ["focus", {}],
        ["close", {}],
        ["click", { ref: ref(tree, "Change label") }],
        ["type", { ref: ref(tree, "Single-line text"), text: "must not be entered" }],
        ["key", { keys: "tab" }],
      ] as const) {
        await expect(client.call(method, { window, ...params })).rejects.toThrow("Amira terminal")
      }
      expect(alive(pid)).toBe(true)
      expect(client.emergency.stopped).toBe(false)
      expect(((await client.call("tree", { window })) as TreeResult).text).not.toContain(
        "must not be entered",
      )
      await client.stop()
      expect(alive(pid)).toBe(true)
    } finally {
      try {
        await client?.stop()
      } finally {
        fixturePipe?.close(0)
        instance.unload("test:uia-protected")
        if (fixturePipe) await until(() => exited)
      }
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "long fixture titles are capped at 120 characters with a cut note",
  async () => {
    const instance = host(false)
    let client: UiaClient | undefined
    let launchedPid = 0
    await instance.load((api) => {
      client = setup(captureHelper(api).api)
    }, "test:uia-title-cap")
    const prefix = `Amira-UIA-test-${crypto.randomUUID()}`
    const title = prefix + "x".repeat(180)
    try {
      const launch = (await client!.call("launch", {
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
        ],
      })) as LaunchResult
      launchedPid = launch.pid
      const result = (await client!.call("windows", { filter: prefix })) as {
        windows: WindowResult[]
        cut: boolean
        note?: string
      }
      const own = result.windows.filter((window) => window.pid === launchedPid)
      expect(own).toHaveLength(1)
      expect(own[0]!.title).toBe(`${title.slice(0, 117)}...`)
      expect(result.windows.length).toBeLessThanOrEqual(200)
      expect(result.cut).toBe(true)
      expect(result.note).toContain("120 characters")
    } finally {
      try {
        await client?.stop()
      } finally {
        instance.unload("test:uia-title-cap")
        if (launchedPid) await until(() => !alive(launchedPid))
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
      await until(() => client!.emergency.stopped && !alive(monitorPid))
      expect(alive(launchedPid)).toBe(true) // Helper crash is not session cleanup.
      client!.resume()
      await client!.call("tree", { window: app.window })
      expect(alive(launchedPid)).toBe(true)
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

// overlay=false has no monitor; its explicit opt-out is covered by polite-close above.
for (const overlay of [true]) {
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
        await until(() => !alive(helperPid) && !alive(overlayPid))
        expect(alive(app!.pid)).toBe(true) // Visible apps survive emergency stop.
        client!.resume()
        await client!.call("tree", { window: app!.window })
        expect(alive(app!.pid)).toBe(true)
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

test.skipIf(!enabled)(
  "modal Invoke returns within a bounded wait and the same helper can find/close the dialog",
  async () => {
    const instance = host(false)
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    let launchedPid = 0
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia-modal")
    try {
      const app = await fixture(
        client!,
        (pid) => {
          launchedPid = pid
        },
        ["-ModalOnClick"],
      )
      const tree = (await client!.call("tree", { window: app.window })) as TreeResult
      const helperPid = captured!.pid()
      const began = Date.now()
      const clicked = (await client!.call("click", {
        window: app.window,
        ref: ref(tree, "Change label"),
      })) as { instruction?: string }
      if (clicked.instruction) expect(clicked.instruction).toContain("action timed out")
      expect(Date.now() - began).toBeLessThan(15_000)
      const windows = (await client!.call("windows", { filter: `${app.title}-modal` })) as {
        windows: WindowResult[]
      }
      expect(captured!.pid()).toBe(helperPid)
      const modal = windows.windows.find(
        (window) => window.pid === app.pid && window.title === `${app.title}-modal`,
      )
      expect(modal).toBeDefined()
      await client!.call("close", { window: modal!.window })
      expect(alive(app.pid)).toBe(true)
    } finally {
      await client?.stop()
      instance.unload("test:uia-modal")
      if (launchedPid) await until(() => !alive(launchedPid))
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "stop preserves a windowed launch's headless child; session end removes the tree and journal",
  async () => {
    const instance = host(false)
    let client: UiaClient | undefined
    let statePath = ""
    const pidPath = join(tmpdir(), `amira-uia-test-window-child-${crypto.randomUUID()}.txt`)
    const title = `Amira-UIA-test-${crypto.randomUUID()}`
    let rootPid = 0
    let childPid = 0
    await instance.load((api) => {
      client = setup({
        ...api,
        openPipe(argv, options) {
          if (argv.some((arg) => arg.endsWith("uia.ps1"))) statePath = argv[argv.indexOf("-StatePath") + 1]!
          return api.openPipe(argv, options)
        },
      })
    }, "test:uia-window-child")
    try {
      const child = `[IO.File]::WriteAllText('${pidPath.replaceAll("'", "''")}', [string]$PID); Start-Sleep -Seconds 600`
      const encoded = Buffer.from(child, "utf16le").toString("base64")
      const fixturePath = `${import.meta.dir}/../helper/test-window.ps1`.replaceAll("'", "''")
      const script = `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -EncodedCommand ${encoded}'; & '${fixturePath}' -Title '${title}'`
      const launched = (await client!.call("launch", {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
      })) as LaunchResult
      rootPid = launched.pid
      await until(() => existsSync(pidPath))
      childPid = Number(readFileSync(pidPath, "utf8"))
      expect(childPid).toBeGreaterThan(0)
      // Past the launch grace: survival must be due to the visible-window ancestor.
      await Bun.sleep(3100)
      client!.emergencyStop()
      await client!.call("windows", { filter: title }) // Wait for stop cleanup acknowledgement.
      expect(alive(rootPid)).toBe(true)
      expect(alive(childPid)).toBe(true)
      await client!.stop()
      await until(() => !alive(rootPid) && !alive(childPid))
      await until(() => !existsSync(statePath) && !existsSync(`${statePath}.tmp`))
    } finally {
      await client?.stop()
      instance.unload("test:uia-window-child")
      if (childPid) await until(() => !alive(childPid))
      if (rootPid) await until(() => !alive(rootPid))
      if (existsSync(pidPath)) unlinkSync(pidPath)
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  "cmd start headless descendant survives helper restart, dies on stop; session cleanup kills the whole tree",
  async () => {
    const instance = host(false)
    let client: UiaClient | undefined
    let captured: ReturnType<typeof captureHelper> | undefined
    const pidPath = join(tmpdir(), `amira-uia-test-child-${crypto.randomUUID()}.txt`)
    let childPid = 0
    await instance.load((api) => {
      captured = captureHelper(api)
      client = setup(captured.api)
    }, "test:uia-descendant")
    try {
      const script = `[IO.File]::WriteAllText('${pidPath.replaceAll("'", "''")}', [string]$PID); Start-Sleep -Seconds 600`
      const launch = () =>
        client!.call("launch", {
          command: "cmd.exe",
          args: ["/c", "start", "", "/wait", "/b", "powershell.exe", "-NoProfile", "-Command", script],
        })
      await launch()
      await until(() => existsSync(pidPath))
      childPid = Number(readFileSync(pidPath, "utf8"))
      expect(childPid).toBeGreaterThan(0)
      captured!.crashHelper()
      await until(() => client!.emergency.stopped)
      client!.resume()
      await client!.call("windows", { filter: "Amira-UIA-no-such-fixture" })
      expect(alive(childPid)).toBe(true)
      client!.emergencyStop()
      await until(() => !alive(childPid))
      unlinkSync(pidPath)
      client!.resume()
      await launch()
      await until(() => existsSync(pidPath))
      childPid = Number(readFileSync(pidPath, "utf8"))
      await client!.stop()
      await until(() => !alive(childPid))
    } finally {
      await client?.stop()
      instance.unload("test:uia-descendant")
      if (childPid) await until(() => !alive(childPid))
      if (existsSync(pidPath)) unlinkSync(pidPath)
    }
  },
  180_000,
)
