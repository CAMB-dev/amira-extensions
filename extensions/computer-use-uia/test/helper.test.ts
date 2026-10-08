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

  test("window results cap entries and titles and report a cut note", () => {
    const windows = helperFunction("Get-Windows")
    ordered(windows, "OrdinalIgnoreCase", "$matches.Count -ge 200", "$matches.Add($info)")
    expect(windows).toContain("cut = $cut")
    expect(windows).toContain("[cut: window list limited to 200 entries; titles limited to 120 characters]")
    const info = helperFunction("Get-WindowInfo")
    expect(info).toContain("$titleText.Length -gt 120")
    expect(info).toContain("$titleText.Substring(0, 117) + '...'")
    expect(windows).toContain("if ($info.titleCut) { $cut = $true }")
  })

  test("protected shell, overlay and Amira terminal targets remain readable but never actionable", () => {
    const protection = helperFunction("Assert-ActionWindow")
    expect(overlay).toContain("AmiraPointerOverlay")
    for (const name of [
      "Progman",
      "WorkerW",
      "Shell_TrayWnd",
      "Shell_SecondaryTrayWnd",
      "AmiraPointerOverlay",
    ])
      expect(protection).toContain(`'${name}'`)
    expect(protection).toContain(
      "$script:amiraProcesses[$window.Identity.Pid].Started -eq $window.Identity.Started",
    )
    expect(protection).toContain("GetAncestor($script:consoleWindow, 2)")
    expect(source).toContain("[int] $AmiraPid = 0")
    expect(source).toContain("[string] $Overlay = 'true'")
    expect(source).toContain("[ValidateSet('true', 'false')]")
    expect(source).toContain("$script:consoleWindow = [OwnedUia.Native]::GetConsoleWindow()")
    ordered(
      source,
      "ProcessParents()",
      "$parents = [OwnedUia.Native]::ProcessParents()",
      "$parent = Get-Identity $parents[$identity.Pid]",
    )
    expect(source).toContain("$parent.Started -gt $identity.Started")
    for (const name of [
      "Invoke-OwnedClick",
      "Set-OwnedText",
      "Send-OwnedKey",
      "Close-OwnedWindow",
      "Focus-Window",
      "Request-WindowClose",
    ])
      expect(helperFunction(name)).toContain("Assert-ActionWindow $window")
    ordered(helperFunction("Show-Action"), "Assert-ActionWindow $window", "if ($Overlay -eq 'false')")
    for (const name of ["Get-Window", "Get-Windows", "Get-OwnedTree", "Assert-Window"])
      expect(helperFunction(name)).not.toContain("Assert-ActionWindow")
  })

  test("launch journals exact PID/start time before handoff discovery, never journals discovery", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "[OwnedUia.LaunchGuard]::Start($path, $argumentLine, $cwd, $launcher)",
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

  test("close requests WindowPattern/WM_CLOSE and never kills, even after its wait", () => {
    const close = helperFunction("Close-OwnedWindow")
    ordered(
      close,
      "Assert-ActionWindow $window",
      "Request-WindowClose $window",
      "Start-Sleep",
      "closed = $closed",
    )
    expect(close).toContain("terminated = $false")
    expect(close).toContain("Test-IdentityGone $script:processes[$key]")
    expect(close).not.toContain("Stop-ExactProcess")
    expect(close).not.toContain(".Kill()")
    const request = helperFunction("Request-WindowClose")
    expect(request).toContain("Invoke-BoundedPattern $window $window.Root $pattern 'close'")
    expect(request).toContain("PostMessage($window.Handle, 0x0010")
    expect(request).not.toContain(".Kill()")
    expect(source).not.toContain("Clear-OwnedApps")
    expect(source).not.toContain("Stop-ExactProcess $previous")
    expect(lifetime).toContain("$job.StopHeadless()")
    expect(lifetime).toContain("$job.Terminate()")
    expect(source + lifetime + overlay).not.toMatch(/taskkill|Stop-Process\s+-Name|Kill\([^)]*ProcessName/i)
    expect(lifetime).toContain("$state.Processes")
  })

  test("journal restart reads only authenticated same-client records, never cleans apps", () => {
    expect(helperFunction("Save-OwnedState")).toContain("OwnershipVersion = 3")
    expect(helperFunction("Save-OwnedState")).toContain("Write-OwnedJournal $StatePath")
    expect(source).toContain("$previous = Read-OwnedJournal $StatePath")
    expect(source).not.toContain("Clear-StaleJournals")
    expect(source).not.toContain("[IO.Directory]::GetFiles")
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
      "$passwordUnknown = $password -isnot [bool]",
      "if ($password -is [bool] -and $password) { $line += ' password=true' }",
      "elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document')) { $line += ' password=unknown' }",
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
      "Invoke-BoundedPattern $window $element $pattern 'invoke'",
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
      "if ($Overlay -eq 'false') { return }",
      "event = 'overlay'",
      "$clock.ElapsedMilliseconds -lt 5000",
      "Get-PendingRead",
      "'overlay_ack'",
    )
    expect(glide).toContain("$script:queuedLines.Enqueue($line)")
    expect(glide).toContain(
      "[Console]::Error.WriteLine('Overlay glide acknowledgement timed out; skipping animation wait.')",
    )
    expect(glide).not.toContain("$script:stopping = $true")
    expect(glide).not.toContain("Stop-ExactProcess")
    expect(glide).not.toContain("ReadLineAsync()")
    expect(glide).toContain("if ($null -eq $line) { Deny 'Session input closed before the action.' }")
    expect(helperFunction("Get-PendingRead")).toContain("if ($null -eq $script:pendingRead)")
    expect(source.match(/\$reader\.ReadLineAsync\(\)/g)).toHaveLength(1)
    expect(helperFunction("Receive-PendingLine")).toContain("$script:pendingRead = $null")
    const loop = source.slice(source.indexOf("while (-not $script:stopping)"))
    ordered(
      loop,
      "Get-PendingRead",
      "Receive-PendingLine",
      "@('overlay_ack', 'job_ack', 'root_ack', 'writer_ack')) { continue }",
      "$id = Get-Argument",
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
    expect(overlay).toContain('if (kind == "click") rippleAt = idleAt')
    expect(overlay).toContain('kind == "type"')
    expect(overlay).toContain("Amira is controlling the desktop")
    expect(overlay).toContain("now - idleAt > 3000")
  })

  test("physical-only Escape stop is gated to the action window; test mode disables stop keys", () => {
    ordered(overlay, "uint modifiers = 0x4000", "if (!testMode) {", "RegisterHotKey(hwnd, 1, modifiers, key)")
    expect(overlay).not.toContain("GetAsyncKeyState(0x1B)")
    const keyboard = overlay.slice(overlay.indexOf("IntPtr Keyboard("), overlay.indexOf("IntPtr Mouse("))
    ordered(
      keyboard,
      "(key.Flags & (0x10 | 0x2)) != 0",
      "else if (!injected)",
      "key.Key == 0x1B",
      "else if (!escapeDown)",
      "!testMode && StopWindow()",
    )
    expect(keyboard).not.toContain("GetAsyncKeyState")
    expect(overlay).toContain("active || (idleAt >= 0 && clock.ElapsedMilliseconds - idleAt <= 3000)")
    expect(overlay).toContain("now - escapeAt <= 500")
    expect(overlay).toContain('ev == "simulate-stop" && testMode')
    expect(overlay).toContain("AbortOwner();")
    expect(overlay).toContain("CreationTime(handle).ToString() == ownerStarted")
    expect(overlay).toContain('Reply(new { @event = "stop" })')
    expect(overlay).toContain("UnregisterHotKey(Handle, 1)")
    expect(overlay).toContain("ExactAlive(lifetimePid, lifetimeStarted)")
    expect(overlay).toContain("ExactAlive(ownerPid, ownerStarted)")
  })

  test("hooks install only on busy, acknowledge arming, and uninstall after bounded idle cleanup", () => {
    const overlayConstructor = overlay.slice(
      overlay.indexOf("public Overlay("),
      overlay.indexOf("void Tick("),
    )
    expect(overlayConstructor).not.toContain("SetWindowsHookEx")
    expect(overlayConstructor).not.toContain("InstallHooks()")
    ordered(overlay, 'ev == "busy"', "InstallHooks();", 'Reply(new { @event = "armed", id = busyId })')
    const idle = overlay.slice(overlay.indexOf("if (!active && idleAt >= 0"), overlay.indexOf("if (gliding)"))
    ordered(
      idle,
      "now - idleAt > 3000",
      "ReleaseInputs();",
      "injectedKeys.Count == 0 && !injectedMouse",
      "now - cleanupAt >= 4000",
      "input cleanup incomplete",
      "UninstallHooks();",
    )
  })

  test("startup and shutdown failures expose real errors without a false user stop or owner kill", () => {
    expect(overlay).toContain(
      '"Stop hotkey " + hotkey + " is unavailable \\u2014 set stopHotkey or disable the overlay"',
    )
    expect(overlay).toContain("error = $failure.Message")
    const shutdown = overlay.slice(
      overlay.indexOf("void BeginShutdown()"),
      overlay.indexOf("protected override void WndProc"),
    )
    expect(shutdown).not.toContain("StopControl();")
    expect(shutdown).not.toContain("AbortOwner();")
    const dispose = overlay.slice(
      overlay.indexOf("protected override void Dispose"),
      overlay.indexOf("public static void Run"),
    )
    expect(dispose).not.toContain("AbortOwner();")
    expect(overlay).toContain("@class = windowClass.ToString()")
    expect(helperFunction("Assert-ActionWindow")).toContain("$class.ToString() -ceq $script:overlayClass")
    expect(helperFunction("Assert-ActionWindow")).toContain("$window.Identity.Pid -eq $script:overlayPid")
  })
})

test("launch job is guarded without breakaway and retained before execution", () => {
  ordered(guard, "new IntPtr(0x2000D)", "if (!CreateProcess(", "guard.Started = CreationTime(guard.process)")
  expect(guard).toContain("0x08080004") // suspended + atomic job-list assignment + no console
  expect(guard).toContain("limits.Basic.Flags = 0u")
  expect(guard).not.toContain("0x1000u")
  expect(guard).not.toContain("Limits(false)")
  expect(guard).not.toContain("AssignProcessToJobObject(")
  expect(guard).not.toContain("ProcessName")
  ordered(
    helperFunction("Start-OwnedApp"),
    "event = 'create-job'",
    "::FromHandle",
    "Save-OwnedState",
    "::Start",
    "Save-OwnedState",
    "$launcher.Commit()",
  )
  ordered(lifetime, "$helper.Kill()", "$helper.WaitForExit(1000)")
  ordered(
    lifetime,
    "try { Stop-CurrentWriter }",
    "$snapshot = Read-OwnedJournal $StatePath",
    "try { Stop-RetainedJobs $force $state }",
  )
})

test("launch parent and job membership are assigned together before suspended creation", () => {
  ordered(guard, "new IntPtr(0x2000D)", "new IntPtr(0x20000)", "if (!CreateProcess(")
  expect(guard).toContain("InitializeProcThreadAttributeList(IntPtr.Zero, 2")
  expect(guard).toContain("GetProcessId(parent) != ParentPid")
  expect(guard).toContain("CreationTime(parent) != ParentStarted")
  expect(guard).toContain("guard.ParentPid = owner.Id")
  ordered(
    guard,
    "Process.GetCurrentProcess()",
    "owner.Handle, target, out parentDuplicate",
    "guard.ParentHandle = parentDuplicate.ToInt64()",
  )
  expect(guard).toContain("parent = new IntPtr(parentHandle)")
  ordered(
    guard,
    "Marshal.WriteIntPtr(parentValue, guard.parent)",
    "new IntPtr(0x20000), parentValue",
    "if (!CreateProcess(",
  )
})

test("lifetime polling uses a cached sentinel handle and the helper polls no faster than 250 ms", () => {
  const loop = lifetime.slice(lifetime.indexOf("try {\n    while ($true)"))
  expect(loop).toContain("$sentinelProcess.WaitForExit(0)")
  expect(loop).not.toContain("Get-ExactProcess $lifetime")
  const helperLoop = source.slice(source.indexOf("while (-not $script:stopping)"))
  expect(helperLoop).toContain("Start-Sleep -Milliseconds 250")
  expect(helperLoop).not.toContain("Start-Sleep -Milliseconds 100")
})

test("writer handoff precedes the first journal write, even before provider initialization", () => {
  ordered(
    source,
    "event = 'helper'",
    "'writer_ack'",
    "    Save-OwnedState\n",
    "Add-Type -AssemblyName UIAutomationClient",
  )
})

test("session cleanup always visits retained jobs and waits before retrying termination", () => {
  expect(lifetime).toContain("function Stop-RetainedJobs")
  expect(lifetime).toContain("$clock.ElapsedMilliseconds -lt 2000")
  expect(lifetime).toContain("$attempt -lt 2")
  expect(lifetime).toContain("Stop-RetainedJobs")
  expect(lifetime).not.toContain("elseif ($jobs.Count -gt 0)")
})

test("concurrent helper exit is confirmed in the catch and retirement failure is acknowledged", () => {
  const retirement = lifetime.slice(
    lifetime.indexOf("function Stop-HelperIdentity"),
    lifetime.indexOf("# Headless fallback"),
  )
  ordered(retirement, "$helper.Kill()", "} catch {", "Test-IdentityGone $identity", "} finally")
  expect(lifetime).toContain("event = 'retired'")
  expect(lifetime).toContain("failed = $failed")
  expect(lifetime).toContain("Launch journal missing; cleanup incomplete.")
  expect(lifetime).toContain("try { Stop-RetainedJobs $force $state }")
})

test("pattern timeout cancels preflight and startup failure releases the busy slot", () => {
  ordered(source, "CompareExchange(ref result.dispatchState, 1, 0)", "switch (action)")
  expect(source).toContain("CompareExchange(ref result.dispatchState, 2, 0)")
  expect(source).toContain("if (!workerStarted)")
  expect(helperFunction("Focus-Element")).toContain("Invoke-BoundedPattern")
  expect(source).toContain(".InnerException")
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
    "if (stopped || shutdownAt >= 0)",
    "ReleaseInputs();",
    "injectedKeys.Count == 0 && !injectedMouse",
    "now - cleanupAt >= 4000",
  )
  expect(overlay).toContain("input cleanup incomplete")
})

test("desktop test module has no import-time probes; fixture is isolated", () => {
  const desktop = readFileSync(new URL("./desktop.test.ts", import.meta.url), "utf8")
  expect(desktop).toContain('process.env.AMIRA_UIA_DESKTOP_TESTS === "1"')
  expect(desktop).toContain("filter: title")
  const capture = readFileSync(new URL("./capture.ts", import.meta.url), "utf8")
  expect(capture).toContain('[...argv, "-TestMode"]')
  expect(source).not.toContain("Clear-StaleJournals")
  expect(desktop).not.toContain("console.log")
  const fixture = readFileSync(new URL("../helper/test-window.ps1", import.meta.url), "utf8")
  expect(fixture).toContain("$password.UseSystemPasswordChar = $true")
  expect(fixture).toContain("$form.Dispose()")
  expect(fixture).not.toMatch(/Start-Process|Bun\.spawn/)
})
