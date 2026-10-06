import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Static source contracts only: never start PowerShell, a helper, windows or hotkeys.
const source = readFileSync(new URL("../helper/uia.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n")
const overlay = readFileSync(new URL("../helper/overlay.ps1", import.meta.url), "utf8")
const lifetime = readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8")
const guard = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8")

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

describe("D112 any-window source contracts (not runtime/provider verification)", () => {
  test("no allowlist or launched-window reading guard remains", () => {
    expect(source).not.toContain("AppsJson")
    expect(source).not.toContain("$apps")
    expect(source).not.toContain("not obtained from this helper launch")
    const window = helperFunction("Get-Window")
    expect(window).toContain("AutomationElement]::FromHandle($handle)")
    ordered(
      window,
      "AutomationElement]::FromHandle($handle)",
      "Automation]::Compare($window.Root, $root)",
      "$window.Identity.Key -eq $identity.Key -and $sameRoot",
      "$script:windows.Remove($ref)",
      "Refs = @{}",
    )
    expect(helperFunction("Get-Windows")).toContain("OrdinalIgnoreCase")
    const info = helperFunction("Get-WindowInfo")
    for (const field of [
      "window =",
      "title =",
      "process =",
      "pid =",
      "class =",
      "bounds =",
      "minimized =",
      "foreground =",
    ])
      expect(info).toContain(field)
  })

  test("launch journals exact PID/start time before handoff discovery, never journals discovery", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "[OwnedUia.LaunchGuard]::Start($path, $argumentLine, $cwd)",
      "$started = $launcher.Started",
      "$script:processes[$launcherIdentity.Key] = $launcherIdentity",
      "Save-OwnedState",
      "$launcher.Commit()",
      "while ($clock.ElapsedMilliseconds -lt 10000)",
    )
    expect(launch.match(/\$script:processes\[[^\n]+\] = /g)).toHaveLength(1)
    expect(launch).toContain("$candidateProcess.ProcessName -ieq $executable")
    expect(launch).toContain("$beforeHandles.ContainsKey")
    expect(launch).toContain("No unambiguous new window found; use ui_windows")
    expect(launch).not.toContain("hand off to another process are not supported")
    expect(launch).not.toContain("GetProcesses()")
  })

  test("close requests WindowPattern/WM_CLOSE; kill only matching journal identity", () => {
    const close = helperFunction("Close-OwnedWindow")
    ordered(
      close,
      "Request-WindowClose $window",
      "$script:processes.ContainsKey($key)",
      "$identity.Pid -eq $window.Identity.Pid -and $identity.Started -eq $window.Identity.Started",
      "Stop-ExactProcess $identity",
    )
    const request = helperFunction("Request-WindowClose")
    expect(request).toContain("$pattern.Close()")
    expect(request).toContain("PostMessage($window.Handle, 0x0010")
    expect(request).not.toContain(".Kill()")
    expect(helperFunction("Clear-OwnedApps")).toContain("$script:processes.ContainsKey($window.Identity.Key)")
    const kill = helperFunction("Stop-ExactProcess")
    ordered(
      kill,
      "GetProcessById($identity.Pid)",
      "$null = $process.Handle",
      "$process.StartTime.ToUniversalTime().Ticks -eq $identity.Started",
      "$process.Kill()",
    )
    expect(source + lifetime + overlay).not.toMatch(/taskkill|Stop-Process\s+-Name|Kill\([^)]*ProcessName/i)
    expect(lifetime).toContain("Get-ExactProcess $identity")
    expect(lifetime).toContain("$state.Processes")
  })

  test("journal schema validates identities and retains failed cleanup", () => {
    expect(helperFunction("Save-OwnedState")).toContain("OwnershipVersion = 2")
    expect(helperFunction("Test-OwnedState")).toContain("$version -ne 2")
    expect(helperFunction("Clear-StaleJournals")).toContain("if ($gone) { [IO.File]::Delete($file) }")
    expect(lifetime).toContain("launch journal retained")
    expect(helperFunction("Get-Identity")).not.toContain("MainModule")
  })

  test("tree has no owned-only skipping, passwords never query value/text patterns", () => {
    const tree = helperFunction("Get-OwnedTree")
    expect(tree).not.toContain("foreign child provider skipped")
    expect(tree).not.toContain("$elementPid")
    expect(tree).not.toContain("WindowPid($handle)")
    expect(tree).not.toContain("Assert-Element $window $element")
    ordered(
      tree,
      "IsPasswordProperty",
      "if ($password -ne $false) { $line += ' password=true' }",
      "else {",
      "ValuePattern]::Pattern",
      "$valuePattern.Current.Value",
      "TextPattern]::Pattern",
    )
    expect(tree).toContain("$window.Refs = @{}")
    expect(tree).toContain("$clock.ElapsedMilliseconds -ge 20000")
    expect(tree).toContain("GetText(512)")
    expect(tree).toContain("$window.Refs.Remove($ref)")
    expect(tree).not.toContain("RootElement")
    expect(tree).not.toContain("TreeScope]::Descendants")
    expect(helperFunction("Assert-Element")).toContain("GetAncestor($handle, 2) -ne $window.Handle")
  })

  test("patterns never move pointer; fallback rechecks actual cursor and TARGET foreground", () => {
    const click = helperFunction("Invoke-OwnedClick")
    ordered(
      click,
      "Show-Action $window $element 'click'",
      "InvokePattern",
      "$pattern.Invoke()",
      "SetCursorPos",
      "GetCursorPos([ref]$actualPoint)",
      "Assert-ClickPoint $window $actualPoint",
      "::Click()",
    )
    expect(click.slice(0, click.indexOf("SetCursorPos"))).not.toContain("::Click()")
    expect(helperFunction("Assert-ClickPoint")).toContain("GetAncestor($hit, 2) -ne $window.Handle")
    expect(helperFunction("Assert-Foreground")).toContain("$foreground -ne $window.Handle")
    expect(helperFunction("Set-OwnedText")).toContain("Show-Action $window $element 'type'")
    expect(helperFunction("Send-OwnedKey")).toContain("Show-Action $window $window.Root 'key'")
    const glide = helperFunction("Show-Action")
    ordered(
      glide,
      "event = 'overlay'",
      "$reader.ReadLineAsync()",
      "$clock.ElapsedMilliseconds -lt 1500",
      "'overlay_ack'",
    )
    expect(source).toContain("SetThreadDpiAwarenessContext([IntPtr]::new(-4))")
  })
})

describe("overlay source contracts (not rendering/hotkey verification)", () => {
  test("click-through, layered, topmost, toolwindow and no-activate; virtual desktop physical coords", () => {
    expect(overlay).toContain("0x20 | 0x80000 | 0x8 | 0x80 | 0x08000000")
    expect(overlay).toContain("ShowWithoutActivation")
    expect(overlay).toContain(
      "GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)",
    )
    expect(overlay).toContain("SetThreadDpiAwarenessContext(dpi) == IntPtr.Zero")
    expect(overlay).toContain("AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), dpi)")
    expect(overlay).toContain("pointer.X - Left")
    expect(overlay).not.toContain("SetForegroundWindow")
    expect(overlay).not.toContain("SetCursorPos")
    // SendInput in the monitor is RELEASE-ONLY for observed helper injections.
    expect(overlay).toContain("release.Data.Mouse.Flags = 4")
    expect(overlay).toContain("release.Data.Keyboard.Flags = 2u")
    expect(overlay).not.toContain("MOUSEEVENTF_LEFTDOWN")
  })

  test("bounded ease-out glide, click ripple, typing and chord labels, idle hide", () => {
    expect(overlay).toContain("/ 320.0")
    expect(overlay).toContain("1 - Math.Pow(1 - t, 3)")
    expect(overlay).toContain('Reply(new { @event = "glided", id = actionId })')
    expect(overlay).toContain('if (kind == "click") rippleAt = now')
    expect(overlay).toContain('kind == "type"')
    expect(overlay).toContain("Amira is controlling the desktop")
    expect(overlay).toContain("now - idleAt > 3000")
  })

  test("stop does not depend on rendering; production hotkeys disabled in test mode", () => {
    ordered(overlay, "uint modifiers = 0x4000", "if (!testMode) {", "RegisterHotKey(hwnd, 1, modifiers, key)")
    expect(overlay).toContain("GetAsyncKeyState(0x1B)")
    expect(overlay).toContain("now - escapeAt <= 500")
    expect(overlay).toContain('ev == "simulate-stop" && testMode')
    expect(overlay).toContain("AbortOwner();")
    expect(overlay).toContain("p.StartTime.ToUniversalTime().Ticks.ToString() == ownerStarted")
    expect(overlay).toContain('Reply(new { @event = "stop" })')
    expect(overlay).toContain("UnregisterHotKey(Handle, 1)")
    expect(overlay).toContain("ExactAlive(lifetimePid, lifetimeStarted)")
    expect(overlay).toContain("ExactAlive(ownerPid, ownerStarted)")
  })
})

test("forced launch interruption is kernel-guarded before durable identity publication", () => {
  ordered(
    guard,
    "guard.Limits(true)",
    "new IntPtr(0x2000D)",
    "if (!CreateProcess(",
    "GetProcessTimes(guard.process",
    "guard.Started =",
  )
  expect(guard).toContain("0x08080004") // suspended + atomic job-list assignment + no console
  expect(guard).toContain("limits.Basic.Flags = 0x1000u | (guarded ? 0x2000u : 0u)")
  expect(guard).not.toContain("AssignProcessToJobObject(")
  expect(guard).not.toContain("GetProcessById")
  expect(guard).not.toContain("ProcessName")
  ordered(
    source,
    "Stop-ExactProcess $previous.Helper",
    "Test-IdentityGone $previous.Helper",
    "$previous = [IO.File]::ReadAllText($StatePath)",
    "foreach ($identity in $previous.Processes)",
    "Save-OwnedState",
  )
  ordered(helperFunction("Start-OwnedApp"), "Save-OwnedState", "$launcher.Commit()")
  ordered(
    lifetime,
    "$helperProcess.Kill()",
    "$helperProcess.WaitForExit(1000)",
    "$state = [IO.File]::ReadAllText($StatePath)",
    "foreach ($identity in $state.Processes)",
  )
})

test("input batches and independent release ledger survive helper termination", () => {
  expect(source).toContain("SendInput((uint)inputs.Count, inputs.ToArray()")
  expect(source).toContain("SendInput(2, inputs")
  expect(source).toContain("InputTag")
  expect(helperFunction("Send-OwnedKey")).not.toContain("::Key(")
  expect(helperFunction("Invoke-OwnedClick")).not.toContain("::Mouse(")
  ordered(
    overlay,
    "void StopControl()",
    "AbortOwner();",
    "ReleaseInputs();",
    'Reply(new { @event = "stop" })',
  )
  expect(overlay).toContain("OurInput(key.Extra)")
  expect(overlay).toContain("if (physicalKeys.Contains(vk)) continue")
  expect(overlay).toContain("injectedMouse && !physicalMouse")
  expect(overlay).toContain("if (stopped && !up) return new IntPtr(1)")
  expect(overlay).toContain("UnhookWindowsHookEx(keyboardHook)")
  expect(overlay).toContain("UnhookWindowsHookEx(mouseHook)")
  expect(overlay).toContain("if (eof) BeginShutdown()")
  ordered(
    overlay,
    "if (shutdownAt >= 0)",
    "ReleaseInputs();",
    "injectedKeys.Count == 0 && !injectedMouse",
    "now - shutdownAt >= 4000",
  )
  expect(overlay).toContain("input cleanup incomplete")
})

test("desktop test module has no import-time probes; fixture is isolated", () => {
  const desktop = readFileSync(new URL("./desktop.test.ts", import.meta.url), "utf8")
  expect(desktop).toContain('process.env.AMIRA_UIA_DESKTOP_TESTS === "1"')
  expect(desktop).toContain("filter: title")
  const capture = readFileSync(new URL("./capture.ts", import.meta.url), "utf8")
  expect(capture).toContain('[...argv, "-TestMode"]')
  expect(source).toContain("if (-not $TestMode) { Clear-StaleJournals }")
  expect(desktop).not.toContain("console.log")
  const fixture = readFileSync(new URL("../helper/test-window.ps1", import.meta.url), "utf8")
  expect(fixture).toContain("$password.UseSystemPasswordChar = $true")
  expect(fixture).toContain("$form.Dispose()")
  expect(fixture).not.toMatch(/Start-Process|Bun\.spawn/)
})
