import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Source contracts plus an offline stub harness: never run helper startup or real UIA.
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

test.skipIf(process.platform !== "win32")(
  "rooted tree/find ancestry shares the traversal deadline (offline fake clock/providers)",
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
        fileURLToPath(new URL("./helper-budget.ps1", import.meta.url)),
        fileURLToPath(new URL("../helper/uia.ps1", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Offline ancestry budget regressions passed"),
    })
  },
  30_000,
)

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
      "$committed = $true",
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
      "$password = $metadata.Password",
      "$passwordUnknown = $password -isnot [bool]",
      "if ($password -is [bool] -and $password) { $line += ' password=true' }",
      "elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document')) { $line += ' password=unknown' }",
      "else {",
      "ValuePattern]::Pattern",
      "$valuePattern.Current.Value",
      "TextPattern]::Pattern",
    )
    expect(tree).toContain("$window.Refs = @{}")
    expect(tree).toContain("$budgetMs = 20000")
    expect(tree).toContain("$clock.ElapsedMilliseconds -ge $budgetMs")
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
      "'job_ack') { Close-JobAck $request; continue }",
      "@('overlay_ack', 'root_ack', 'writer_ack')) { continue }",
      "$id = Get-Argument",
    )
    expect(source).toContain("SetThreadDpiAwarenessContext([IntPtr]::new(-4))")
  })
})

describe("U1 cached tree/find source contracts (not runtime/provider verification)", () => {
  test("cache allowlist is exactly six metadata, eight availability and toggle-state properties", () => {
    const properties = helperFunction("Get-TreeProperties")
    const names = [...properties.matchAll(/::(\w+Property)\b/g)].map((match) => match[1]).sort()
    expect(names).toEqual(
      [
        "ControlTypeProperty",
        "NameProperty",
        "AutomationIdProperty",
        "IsEnabledProperty",
        "IsOffscreenProperty",
        "IsPasswordProperty",
        "IsValuePatternAvailableProperty",
        "IsTogglePatternAvailableProperty",
        "IsTextPatternAvailableProperty",
        "IsScrollItemPatternAvailableProperty",
        "IsScrollPatternAvailableProperty",
        "IsExpandCollapsePatternAvailableProperty",
        "IsInvokePatternAvailableProperty",
        "IsSelectionItemPatternAvailableProperty",
        "ToggleStateProperty",
      ].sort(),
    )
    const cache = helperFunction("New-TreeCacheRequest")
    expect(cache).toContain("AutomationElementMode]::Full")
    expect(cache).toContain("TreeScope]::Element")
    expect(cache).toContain("$cache.TreeFilter = [System.Windows.Automation.Condition]::TrueCondition")
    expect(cache).toContain("foreach ($property in $properties.Values) { $cache.Add($property) }")
    expect(source.match(/\$cache\.Add\(/g)).toHaveLength(1)
    expect(properties + cache).not.toMatch(
      /ValueProperty|IsReadOnlyProperty|TextPattern\]::Pattern|\.Add\([^)]*Pattern/,
    )
  })

  test("owns its cached root and pops each parent request even when FindAll throws", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "$properties = Get-TreeProperties",
      "$cachedRoot = $root",
      "$rootCacheReady = $false",
      "$cache = New-TreeCacheRequest $properties",
      "$root.GetUpdatedCache($cache)",
      "$rootCacheReady = $true",
      "$stack.Push",
      "-UseCache (-not $item.ContainerItem -and ($item.Depth -gt 0 -or $rootCacheReady))",
    )
    expect(tree).not.toContain("$window.Root =")
    const children = helperFunction("Get-TreeChildren")
    ordered(
      children,
      "$cache = New-TreeCacheRequest $properties",
      "$pushed = $false",
      "try {",
      "$cache.Push()",
      "$pushed = $true",
      "return ,$element.FindAll",
      "finally { if ($pushed) { $cache.Pop() } }",
      "catch {",
      "Assert-TreeBudget $clock",
      "return ,$element.FindAll",
    )
    expect(children.match(/TreeScope\]::Children/g)).toHaveLength(2)
    expect(children.match(/Condition\]::TrueCondition/g)).toHaveLength(2)
    expect(children).not.toMatch(/::(?:ControlViewCondition|ContentViewCondition)/) // Raw nodes remain included.
    expect(tree + children).not.toContain("TreeScope]::Descendants")
    expect(tree + children).not.toContain("TreeScope]::Subtree")
  })

  test("fallback is per node, budgeted, counted and fail-closed on unknown passwords", () => {
    const read = helperFunction("Read-TreeProperties")
    ordered(
      read,
      "if ($UseCache)",
      "GetCachedPropertyValue($entry.Value, $true)",
      "$metrics.cached++",
      "catch {",
      "$metrics.fallback++",
      "Read-Property $window $element $entry.Value -Verified -Clock $clock",
    )
    expect(read).toContain("Assert-TreeBudget $clock")
    expect(read).toContain("$values[$entry.Key] = $null")
    expect(read).toContain("@('Type', 'Name', 'AutomationId', 'Enabled', 'Offscreen')")
    // Password is deliberately NOT required metadata: failed reads become unknown,
    // and the shared formatter's password gate must still precede current reads.
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "$password = $metadata.Password",
      "if ($password -is [bool] -and $password)",
      "elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document'))",
      "else {",
      "ValuePattern]::Pattern",
      "Assert-TreeBudget $clock",
      "$valuePattern.Current.Value",
      "Assert-TreeBudget $clock",
      "$valuePattern.Current.IsReadOnly",
      "TextPattern]::Pattern",
      "Assert-TreeBudget $clock",
      "$range = $textPattern.DocumentRange",
      "Assert-TreeBudget $clock",
      "$range.GetText(512)",
    )
    expect(tree).not.toContain("GetCachedPattern")
    expect(tree).not.toContain(".Cached.Value")
    expect(tree).not.toContain(".Cached.IsReadOnly")
    expect(tree).toContain("$metadata.ToggleState -is [System.Windows.Automation.ToggleState]")
  })

  test("failed root refresh bypasses old cached password metadata and counts a node fallback", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "$cachedRoot = $root",
      "$rootCacheReady = $false",
      "try {",
      "$cache = New-TreeCacheRequest $properties",
      "$root.GetUpdatedCache($cache)",
      "$rootCacheReady = $true",
      "catch {",
      "Read-TreeProperties $window $element $properties $metrics $clock -UseCache (-not $item.ContainerItem -and ($item.Depth -gt 0 -or $rootCacheReady))",
    )
    const read = helperFunction("Read-TreeProperties")
    ordered(
      read,
      "if ($UseCache)",
      "GetCachedPropertyValue",
      "catch {",
      "$metrics.fallback++",
      "Read-Property",
    )
    // Static regression: even if the old root cache contains Password=false,
    // failed refresh forces current IsPassword before any current Value/Text.
    // Cached getters succeeding cannot bypass that branch.
    expect(source).toContain("[bool] $UseCache = $true")
    expect(tree).toContain("$password = $metadata.Password")
    expect(tree).toContain("elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document'))")
  })

  test("old root is resolved and revalidated before replacement, not treated as an action", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "$clock = [Diagnostics.Stopwatch]::StartNew()",
      "$rootRef = Get-Argument $parameters 'root'",
      "$window.Refs.ContainsKey($rootRef)",
      "$root = $window.Refs[$rootRef]",
      "Assert-Element $window $root -Clock $clock",
      "$window.Refs = @{}",
      "do {",
      "Assert-Element $window $root -Clock $clock",
      "$window.Refs = @{}",
    )
    expect(tree).toContain("Unknown or stale root reference; call ui_tree without root.")
    expect(tree).not.toContain("Get-Element $window") // Disabled roots are still readable.
    expect(tree).not.toContain("Assert-ActionWindow")
    const loop = source.slice(source.indexOf("while (-not $script:stopping)"))
    const preDispatch = loop.slice(0, loop.indexOf("$result = switch"))
    expect(preDispatch).not.toContain(".Refs = @{}")
    ordered(
      loop,
      "'tree' { Get-OwnedTree $parameters; break }",
      "'find' { Get-OwnedTree $parameters -Find; break }",
      "} catch {",
      "if ($method -cin @('tree', 'find')) {",
      "$script:windows[$targetRef].Refs = @{}",
      "$script:windows[$targetRef].VirtualRefs = @{}",
    )
  })

  test("ancestry checks the optional snapshot deadline between provider calls", () => {
    const ancestry = helperFunction("Assert-Element")
    ordered(
      ancestry,
      "Assert-TreeBudget $Clock",
      "Assert-Window $window",
      "for ($i = 0; $i -lt 128; $i++)",
      "Assert-TreeBudget $Clock",
      "Automation]::Compare",
      "Assert-TreeBudget $Clock",
      "Assert-Window $window",
      "return",
      "Assert-TreeBudget $Clock",
      "GetCurrentPropertyValue",
      "Assert-TreeBudget $Clock",
      "Native]::GetAncestor",
      "Assert-TreeBudget $Clock",
      "$script:walker.GetParent",
    )
    expect(source).toContain("function Assert-Element($window, $element, $Clock = $null)")
    const tree = helperFunction("Get-OwnedTree")
    expect(tree.match(/Assert-Element \$window \$root -Clock \$clock/g)).toHaveLength(2)
    expect(tree.match(/catch \[TimeoutException\]/g)).toHaveLength(2)
    expect(tree).toContain("Tree traversal budget exhausted during root validation.")
  })

  test("find shares traversal, bounded conjunctive filters, fresh matching refs and three-ancestor context", () => {
    const tree = helperFunction("Get-OwnedTree")
    expect(source).toContain(
      "function Get-OwnedTree($parameters, [switch] $Find, [switch] $Poll, $Clock = $null)",
    )
    expect(tree).toContain("if ($Find) { $depthDefault = 30 }")
    expect(tree).toContain("'depth' $depthDefault 0 30")
    expect(tree).toContain("'maxResults' 20 1 100")
    expect(tree).toContain("if ($Find) { $maxVisited = 3000; $maxLines = $maxResults }")
    expect(tree).toContain("$maxLines = $maxNodes")
    expect(tree).toContain("$lines.Count -ge $maxLines")
    expect(tree).toContain("$metrics.visited -ge $maxVisited")
    expect(tree).toContain("$budgetMs = 20000")
    expect(tree).toContain("$clock.ElapsedMilliseconds -ge $budgetMs")
    expect(tree).toContain("@('name', 'role', 'automationId')")
    expect(tree).toContain("$filter -isnot [string] -or [string]::IsNullOrWhiteSpace($filter)")
    expect(tree).toContain("$filter -notmatch '^[A-Za-z]+$'")
    expect(tree).toContain("ui_find requires at least one of name, role or automationId.")
    expect(tree).toContain("$name.IndexOf($filters.name, [StringComparison]::OrdinalIgnoreCase)")
    expect(tree).toContain(
      "[string]::Equals($typeName, $filters.role, [StringComparison]::OrdinalIgnoreCase)",
    )
    expect(tree).toContain(
      "$automationId.IndexOf($filters.automationId, [StringComparison]::OrdinalIgnoreCase) -ge 0",
    )
    ordered(
      tree,
      "$window.Refs = @{}",
      "$script:nextElement++",
      "$ref = 'e' + $script:nextElement",
      "$matches = -not $Find -or (",
      "if ($matches) {",
      "ValuePattern]::Pattern",
      "$window.Refs[$ref] = $element",
      "$lines.Add($line)",
      "Get-TreeChildren $element $properties $clock",
    )
    expect(tree.match(/\$window\.Refs\[\$ref\] = /g)).toHaveLength(1)
    expect(tree).toContain("if ($path.Count -gt 3)")
    expect(tree).toContain("$path[($path.Count - 3)..($path.Count - 1)]")
    expect(tree).toContain("[string]::Join(' > ', [string[]]$item.Path)")
    expect(tree).toContain("if (-not $Find) {") // Unreadable nodes are never find results.
  })

  test("bounded output and protocol metrics include both retry attempts without leaking refs", () => {
    const tree = helperFunction("Get-OwnedTree")
    expect(tree).toContain("$chars + $line.Length + 1 -gt 199900")
    expect(tree).toContain("$window.Refs.Remove($ref)")
    for (const field of [
      "text = $text",
      "nodes = $nodes",
      "chars = $text.Length",
      "ms = $clock.ElapsedMilliseconds",
      "cut = $cut",
      "cached = $metrics.cached",
      "fallback = $metrics.fallback",
      "retried = [bool]$retried",
      "chromiumSparse = [bool]$chromiumSparse",
      "visited = $metrics.visited",
      "density = $density",
    ])
      expect(tree).toContain(field)
    ordered(
      tree,
      "$metrics = @{ cached = 0; fallback = 0; visited = 0 }",
      "do {",
      "$window.Refs = @{}",
      "$lines = New-Object",
      "$density = 0",
      "$metrics.visited++",
    )
    expect(tree.match(/\$metrics = /g)).toHaveLength(1)
    expect(tree).not.toContain("$script:nextElement =")
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
  expect(guard).not.toMatch(/limits\.Basic\.Flags\s*(?:=|\|=)[^\n;]*0x1000u/)
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
    "$committed = $true",
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
    "Process.GetProcessById(custodyPid)",
    "CreationTime(owner.Handle) != custodyStarted",
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
  expect(lifetime).not.toContain("Launch journal missing; cleanup incomplete.")
  expect(lifetime).toContain("if ($force -and $journalGap)")
  expect(lifetime).toContain("if ($job.Members().Length -gt 0) { $cleanupIncomplete = $true }")
  expect(lifetime).toContain("try { Stop-RetainedJobs $force $state }")
})

test("failed/rootless jobs are drained before disposal and only real launch grace says still starting", () => {
  ordered(
    lifetime,
    "function Remove-LaunchJob",
    "$job.Terminate()",
    "$job.Members().Length -gt 0",
    "$job.Dispose()",
    "$jobs.Remove($name)",
  )
  expect(lifetime).toContain("$message.event -ceq 'launch-finished'")
  expect(lifetime).toContain("-not $jobs[$message.job].HasRoot")
  const rootless = lifetime.slice(
    lifetime.indexOf("function Remove-RootlessJobs"),
    lifetime.indexOf("function Stop-CurrentWriter"),
  )
  ordered(
    rootless,
    "foreach",
    "try { Remove-LaunchJob $name }",
    "catch { $failed = $true",
    "if ($failed) { throw",
  )
  const register = guard.slice(guard.indexOf("public void SetRoot"), guard.indexOf("public string Name"))
  ordered(
    register,
    "CreationTime(root.Handle) != started",
    "IsProcessInJob(root.Handle, job",
    "OpenThread(0x0802u",
    "GetProcessIdOfThread(primary) != pid",
    "ResumeThread(primary)",
    "rootPid = pid; rootStarted = started;",
  )
  expect(guard).not.toContain("public void Commit()")
  expect(lifetime).toContain("Remove-RootlessJobs")
  expect(helperFunction("Start-OwnedApp")).toContain("failed = (-not $committed)")
  expect(guard).toContain("Launch root registration pending;")
  expect(guard).toContain("still starting (3 s grace)")
})

test("transferred handles have least privilege and late/rejected acks close both exactly once", () => {
  expect(guard).toContain("0x0001u, false, 0)")
  expect(guard).not.toContain("0x0008u")
  const close = helperFunction("Close-JobAck")
  expect(close).toContain("@('handle', 'parentHandle')")
  expect(close).toContain("receivedJobAcks.ContainsKey($job)")
  expect(source).toContain("$script:requestedJobs = [Collections.Hashtable]::new([StringComparer]::Ordinal)")
  ordered(close, "-not $script:requestedJobs.ContainsKey($job)", "::CloseTransferredHandle([long]$handle)")
  ordered(
    helperFunction("Start-OwnedApp"),
    "event = 'create-job'",
    "$script:requestedJobs[$jobId] = $true",
    "Get-PendingRead",
  )
  expect(close).toContain("::CloseTransferredHandle([long]$handle)")
  const launch = helperFunction("Start-OwnedApp")
  expect(launch).toContain("Get-Argument $ack 'rejected'")
  expect(launch).toContain("finally { if (-not $transferred) { Close-JobAck $ack } }")
  ordered(launch, "[long]::TryParse", "$transferred = $true", "::FromHandle")
  expect(source).toContain("'job_ack') { Close-JobAck $request; continue }")
})

test("launch parent identity failure is not misreported as unsupported nested jobs", () => {
  const launch = helperFunction("Start-OwnedApp")
  ordered(
    launch,
    "::Start",
    "$exception.InnerException",
    "Launch parent identity changed or exited.",
    "Launch refused: launch parent identity changed or exited.",
    "nested jobs may be unsupported",
  )
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

test.skipIf(process.platform !== "win32")(
  "U2 offline helper regressions",
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
        fileURLToPath(new URL("./helper-u2.ps1", import.meta.url)),
        fileURLToPath(new URL("../helper/uia.ps1", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Offline U2 regressions passed"),
    })
  },
  30_000,
)

for (const regression of [
  "placeholder-observation",
  "placeholder-action",
  "placeholder-identity",
  "placeholder-replacement",
  "title-suffix",
  "shared-failed-budget",
  "display-truncation",
  "exact-property-unavailable",
  "bounded-vertical-getter",
])
  test.skipIf(process.platform !== "win32")(
    `U2 reviewer regression: ${regression}`,
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
          fileURLToPath(new URL("./helper-u2.ps1", import.meta.url)),
          fileURLToPath(new URL("../helper/uia.ps1", import.meta.url)),
          "-Case",
          regression,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr, stdout }).toEqual({
        code: 0,
        stderr: "",
        stdout: expect.stringContaining(`Offline reviewer regression passed: ${regression}`),
      })
    },
    30_000,
  )

test("U2 helper test source uses LF line endings", () => {
  expect(readFileSync(new URL("./helper.test.ts", import.meta.url), "utf8")).not.toContain("\r")
})

test("U2 pattern actions use the existing bounded worker, including the whole scroll batch", () => {
  const worker = source.slice(
    source.indexOf("public sealed class PatternCall"),
    source.indexOf("public static class Native"),
  )
  expect(worker).toContain("worker.Join(5000)")
  for (const action of ["scroll", "realize", "scrollIntoView"]) expect(worker).toContain(`case "${action}":`)
  expect(worker).toContain("ScrollAmount.SmallDecrement")
  expect(worker).toContain("ScrollAmount.SmallIncrement")
  expect(worker).toContain("ScrollAmount.NoAmount")
  expect(worker).toContain("VerticallyScrollable")
  expect(worker).toContain("VerticalScrollPercent")
  expect(worker.indexOf("CompareExchange(ref result.dispatchState, 1, 0)")).toBeLessThan(
    worker.indexOf('case "scroll":'),
  )
  expect(source).toContain("'wait_poll' { Get-WaitPoll $parameters; break }")
})
