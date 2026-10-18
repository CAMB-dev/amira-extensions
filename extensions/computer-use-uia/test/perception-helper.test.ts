import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// D113 source contracts only: do not evaluate PowerShell or touch UIA/the desktop.
const source = readFileSync(new URL("../helper/uia.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n")

function helperFunction(name: string) {
  const declaration = new RegExp(`^([ \\t]*)function ${name}\\b[^\\n]*\\{\\n`, "m").exec(source)
  expect(declaration).not.toBeNull()
  const start = declaration!.index + declaration![0].length
  const closing = new RegExp(`^${declaration![1]}\\}[ \\t]*$`, "m").exec(source.slice(start))
  expect(closing).not.toBeNull()
  return source.slice(start, start + closing!.index)
}

function ordered(text: string, ...fragments: string[]) {
  let after = 0
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, after)
    expect(index, fragment).toBeGreaterThanOrEqual(after)
    after = index + fragment.length
  }
}

describe("D113 helper perception contracts (not runtime capture/input verification)", () => {
  test("overlay hides rendering before capture acknowledgement without disabling stop monitoring", () => {
    const overlay = readFileSync(new URL("../helper/overlay.ps1", import.meta.url), "utf8")
    const observe = overlay.slice(overlay.indexOf('ev == "observe"'), overlay.indexOf('ev == "inspect"'))
    ordered(observe, "if (active)", "Hide();", "DwmFlush()", '@event = "hidden"')
    expect(observe).not.toContain("UninstallHooks")
    expect(observe).not.toContain("UnregisterHotKey")
    expect(observe).not.toContain("StopControl()")
  })
  test("tree invalidates tokens and captures before any traversal without focusing", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "$window.Screenshot = $null",
      "'screenshot' $false",
      "'screenshotMaxEdge' 1280 128 4096",
      "Get-TargetScreenshot",
      "$stack.Push",
      "while ($stack.Count",
    )
    expect(tree).toContain("$result.screenshot = $screenshot")
    expect(tree).not.toContain("Focus-Window")
    expect(tree).not.toContain("Show-Action")
    const capture = helperFunction("Get-TargetScreenshot")
    expect(capture).toContain("[Guid]::NewGuid().ToString('N')")
    for (const field of [
      "data =",
      "mimeType = 'image/png'",
      "width =",
      "height =",
      "bounds =",
      "scaleX =",
      "scaleY =",
      "dpi =",
      "id =",
    ])
      expect(capture).toContain(field)
    expect(capture).not.toContain("Focus-Window")
  })

  test("native capture is physical, target-bounded, disposable PNG with no upscaling", () => {
    expect(source).toContain("GetDpiForWindow(window)")
    expect(source).toContain("AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))")
    expect(source).toContain("GetWindowRect(window, out nativeRect)")
    expect(source).toContain("Math.Min(1.0, (double)maxEdge / Math.Max(bounds.Width, bounds.Height))")
    expect(source).toContain("graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bitmap.Size")
    expect(source).toContain("System.Drawing.Imaging.ImageFormat.Png")
    expect(source).toContain("using (var bitmap = new System.Drawing.Bitmap(bounds.Width, bounds.Height))")
    expect(source).not.toContain("PrintWindow")
    expect(source).toContain("Cannot perfectly prevent races")
  })

  test("capture refuses minimized, hidden, cloaked, offscreen and overlapping windows", () => {
    for (const fragment of [
      "IsIconic(window)",
      "!IsWindowVisible(window)",
      "DwmGetWindowAttribute(window, 14",
      "GetWindowLong(window, -20) & (0x80000 | 0x20)",
      "EnumDisplayMonitors",
      "uncovered.Exclude",
      "uncovered.IsEmpty",
      "GetWindow(window, 3)",
      "GetWindow(above, 3)",
      "IntersectsWith(bounds)",
      "AssertCaptureClear(window, bounds)",
    ])
      expect(source).toContain(fragment)
    ordered(
      source.slice(source.indexOf("public static CapturedImage Capture")),
      "AssertCaptureClear(window, bounds)",
      "CopyFromScreen",
      "AssertCaptureClear(window, bounds)",
      "ImageFormat.Png",
    )
  })

  test("visible DWM frame excludes invisible maximized borders; shape holes and corner pixels are excluded", () => {
    const capture = source.slice(
      source.indexOf("public static CaptureBounds GetCaptureBounds"),
      source.indexOf("static void AssertCaptureClear"),
    )
    ordered(
      capture,
      "GetWindowRect(window, out nativeRect)",
      "DwmGetWindowAttribute(window, 9, out rect, 16)",
      "GetWindowRgn(window, region)",
      "shape == 1 || shape == 3",
      "var bounds = new System.Drawing.Rectangle(rect.Left, rect.Top",
    )
    expect(capture).toContain("GetRgnBox(region, out area)")
    expect(capture).toContain("finally { DeleteObject(region); }")
    const exportImage = source.slice(source.indexOf("public static CapturedImage Capture"))
    ordered(
      exportImage,
      "CopyFromScreen",
      "mask.FillRectangle",
      "graphics.DrawImage(bitmap",
      "ImageFormat.Png",
    )
    expect(exportImage.match(/mask.FillRectangle/g)).toHaveLength(4)
  })

  test("physical corner coverage uses monitor scale, including DPI-unaware targets at 300 percent", () => {
    const captureBounds = source.slice(
      source.indexOf("public static CaptureBounds GetCaptureBounds"),
      source.indexOf("static void AssertCaptureClear"),
    )
    ordered(
      captureBounds,
      "monitorBounds.IntersectsWith(bounds)",
      "GetScaleFactorForMonitor(monitor, out monitorScale)",
      "maxScale = Math.Max(maxScale, monitorScale)",
      "ScalePercent = maxScale",
    )
    expect(captureBounds).toContain("monitorScale < 100 || monitorScale > 1000")
    expect(captureBounds).toContain("Dpi = (uint)Math.Ceiling(96.0 * maxScale / 100.0)")
    const expression = /int corner = \(int\)Math.Ceiling\(([^;]+)\);/.exec(source)?.[1]
    expect(expression).toBe("16.0 * before.ScalePercent / 100.0")
    // Evaluate the production arithmetic with injected monitor metadata, never native APIs.
    const corner = new Function("before", `return Math.ceil(${expression})`) as (before: {
      ScalePercent: number
      Dpi: number
    }) => number
    expect(corner({ ScalePercent: 100, Dpi: 96 })).toBe(16)
    expect(corner({ ScalePercent: 300, Dpi: 96 })).toBe(48)
    expect(corner({ ScalePercent: 350, Dpi: 96 })).toBe(56)
    expect(corner({ ScalePercent: 140, Dpi: 96 })).toBe(23)
    expect(source).toContain("first.ScalePercent == second.ScalePercent")
  })

  test("coordinate tokens are root-local and map integer screenshot pixels in the helper", () => {
    expect(helperFunction("Get-Window")).toContain("Screenshot = $null")
    const point = helperFunction("Get-ScreenshotPoint")
    ordered(
      point,
      "Assert-Screenshot $window $parameters",
      "'x' -1 0",
      "'y' -1 0",
      "[Math]::Floor($x / $shot.scaleX)",
      "[Math]::Floor($y / $shot.scaleY)",
    )
    const validate = helperFunction("Assert-Screenshot")
    for (const fragment of [
      "-cne $shot.id",
      "GetCaptureBounds",
      "$current.X",
      "$current.Y",
      "$current.Width",
      "$current.Height",
      "$current.Dpi",
      "$window.Screenshot = $null",
    ])
      expect(validate).toContain(fragment)
  })

  test("coordinate actions use protected targeting, no restore, overlay point and last-second cursor guards", () => {
    const click = helperFunction("Invoke-OwnedClick")
    ordered(
      click,
      "Assert-ActionWindow $window",
      "Invoke-CoordinateInput $window $parameters 'click'",
      "Get-Element $window $parameters",
    )
    const input = helperFunction("Invoke-CoordinateInput")
    ordered(
      input,
      "Assert-ActionWindow $window",
      "Get-ScreenshotPoint",
      "Show-Action $window $window.Root $kind $kind $nativePoint",
      "Focus-Window $window -NoRestore",
      "Assert-NoHeldModifiers",
      "Assert-ClickPoint $window $nativePoint",
      "SetCursorPos",
      "Assert-Screenshot $window $parameters",
      "GetCursorPos([ref]$actualPoint)",
      "Assert-ClickPoint $window $actualPoint",
      "Assert-NoHeldModifiers",
      "::Wheel($delta)",
      "::Click()",
    )
    expect(helperFunction("Show-Action")).toContain("$point = $ExplicitPoint")
    expect(helperFunction("Focus-Window")).toContain("if ($NoRestore)")
  })

  test("request loop invalidates stale coordinates on new trees and all target failures", () => {
    const loop = source.slice(source.indexOf("while (-not $script:stopping)"))
    ordered(
      loop,
      "$targetRef = $null",
      "$targetRef = Get-Argument $parameters 'window'",
      "$method -ceq 'tree'",
      "$script:windows[$targetRef].Screenshot = $null",
      "$result = switch",
      "} catch {",
      "$script:windows[$targetRef].Screenshot = $null",
    )
    const tree = helperFunction("Get-OwnedTree")
    expect(tree).toContain("$includeScreenshot -isnot [bool]")
    expect(source).toContain("maxEdge < 128 || maxEdge > 4096")
    expect(source).toContain("width * height > 67108864")
    expect(source).toContain("if (!SameBounds(before, GetCaptureBounds(window)))")
  })

  test("scroll validates notches and emits tagged native wheel input, dispatch and done events", () => {
    const input = helperFunction("Invoke-CoordinateInput")
    expect(input).toContain("'delta' 0 -10 10")
    expect(input).toContain("if ($delta -eq 0)")
    expect(source).toContain("input.Data.Mouse.Flags = 0x0800")
    expect(source).toContain("unchecked((uint)(delta * 120))")
    expect(source).toContain("input.Data.Mouse.Extra = InputTag")
    expect(source).toContain("'scroll' { Invoke-OwnedScroll $parameters; break }")
    expect(source.match(/@\('launch', 'click', 'scroll', 'type', 'key', 'focus', 'close'\)/g)).toHaveLength(2)
  })
})
