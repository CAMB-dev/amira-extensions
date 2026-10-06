import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Desktop-free source contracts, not PowerShell runtime/provider tests. Reading
// production functions avoids testing a TypeScript translation of their logic.
// A true mocked PowerShell harness would still need to execute PowerShell; this
// suite never imports desktop.test.ts, starts the helper, or invokes a process.
const source = readFileSync(new URL("../helper/uia.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n")

function code(text: string) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
}

function helperFunction(name: string) {
  // These named functions end on a brace at their declaration's indentation.
  // This is deliberately not a general PowerShell parser (nor an evaluator).
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid function name: ${name}`)
  const declarations = [...source.matchAll(new RegExp(`^([ \\t]*)function ${name}\\b[^\\n]*\\{\\n`, "gm"))]
  expect(declarations).toHaveLength(1)
  const declaration = declarations[0]!
  const start = declaration.index! + declaration[0].length
  const closing = new RegExp(`^${declaration[1]}\\}[ \\t]*$`, "m").exec(source.slice(start))
  expect(closing).not.toBeNull()
  return code(source.slice(start, start + closing!.index))
}

function ordered(text: string, ...fragments: string[]) {
  let after = 0
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, after)
    expect(index, `Expected source fragment after offset ${after}: ${fragment}`).toBeGreaterThanOrEqual(after)
    after = index + fragment.length
  }
}

describe("helper launch source contracts (not runtime behavior)", () => {
  test("journals only the Start-Process identity before discovery or provider access", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "$launcher = [System.Diagnostics.Process]::Start($startInfo)",
      "try {",
      "$null = $launcher.Handle",
      "$started = $launcher.StartTime.ToUniversalTime().Ticks",
      "if ($started -lt $began) { Deny",
      "$launcherIdentity = [pscustomobject]@{",
      "Pid = $launcher.Id; Started = $started",
      "$script:processes[$launcherIdentity.Key] = $launcherIdentity",
      "Save-OwnedState",
      "while ($clock.ElapsedMilliseconds -lt 15000)",
      "$window.Root = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)",
      "Assert-Element $window $window.Root",
      "$title = Read-Property",
    )
    expect(launch.match(/\$script:processes\[[^\n]+\] = /g)).toHaveLength(1)
    // The only other insertion is retention of previously launched current-schema records.
    expect(code(source).match(/\$script:processes\[[^\n]+\] = /g)).toHaveLength(2)
    const discovery = launch.slice(launch.indexOf("while ($clock.ElapsedMilliseconds -lt 15000)"))
    expect(discovery).not.toContain("Get-Identity")
    expect(discovery).not.toMatch(/\$script:processes\[[^\n]+\] = /)
  })

  test("rejects foreign new windows using only metadata before any provider access", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "$beforeHandles.ContainsKey($native.Handle.ToInt64().ToString())",
      "GetAncestor($native.Handle, 2) -ne $native.Handle",
      "if ($native.Pid -ne $launcherIdentity.Pid)",
      "Deny 'This app hands its window to another process, which this extension does not support.",
      "if (-not (Test-Identity $launcherIdentity))",
      "Deny 'Launched process exited or its identity changed",
      "$candidates.Add([pscustomobject]@{ Native = $native; Identity = $launcherIdentity })",
      "if ($candidates.Count -gt 1) { Deny",
      "$clock.ElapsedMilliseconds - $stableSince -ge 500",
      "ProcessKeys = @($launcherIdentity.Key)",
      "$script:windows[$windowRef] = $window",
      "Assert-Window $window",
      "AutomationElement]::FromHandle($window.Handle)",
    )
  })

  test("refuses failed identity capture, exited launchers and timeouts without adopting another process", () => {
    ordered(
      helperFunction("Start-OwnedApp"),
      "Deny 'Launched process identity is unavailable; no window was adopted.",
      "if ($launcher.HasExited)",
      "if ($null -eq $exitedSince) { $exitedSince = $clock.ElapsedMilliseconds }",
      "$clock.ElapsedMilliseconds - $exitedSince -ge 3000",
      "Deny 'Launched process exited without owning a window.",
      "Deny 'Launched process never owned a new, unambiguous window.",
    )
  })

  test("failed launches revoke the window, clean only the exact launcher and retain failed kills", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "Deny 'Launched process never owned",
      "} catch {",
      "if ($null -ne $windowRef) { $script:windows.Remove($windowRef) }",
      "if ($null -ne $launcherIdentity)",
      "Stop-ExactProcess $launcherIdentity",
      "if (Test-IdentityGone $launcherIdentity) { $script:processes.Remove($launcherIdentity.Key) }",
      "Save-OwnedState",
      "throw",
      "finally { $launcher.Dispose() }",
    )
    expect(launch.match(/Stop-ExactProcess /g)).toHaveLength(1)
    expect(launch).not.toContain(".Kill()")
  })

  test("no hand-off mappings, process sweeps, parent correlation or package preflight remain", () => {
    for (const fragment of [
      "$handoff",
      "$launchKeys",
      "$cleanupProcesses",
      "$beforeProcesses",
      "Test-AppPath",
      "GetProcesses()",
      "ParentPid",
      "NtQueryInformationProcess",
      "Get-AppxPackage",
      "WindowsApps",
      "CalculatorApp.exe",
      "notepad.exe",
      "-WithPath",
    ])
      expect(code(source)).not.toContain(fragment)
    expect(helperFunction("Get-Identity")).not.toContain("MainModule")
  })
})

test("key injection uses the Windows PowerShell 5.1 uint16 type (source contracts)", () => {
  const key = helperFunction("Send-OwnedKey")
  expect(key).not.toContain("[ushort]")
  expect(key.match(/\[uint16\]/g)).toHaveLength(4)
})

test("debug key output is absent (source contracts)", () => {
  const capture = readFileSync(new URL("./capture.ts", import.meta.url), "utf8")
  const debugMarker = ["[DEBUG", "uia-key]"].join("-")
  expect(source).not.toContain(debugMarker)
  expect(capture).not.toContain(debugMarker)
  expect(source).not.toContain("ScriptStackTrace")
})

test("bundled fixture has deterministic native controls and never starts another process", () => {
  const fixture = code(readFileSync(new URL("../helper/test-window.ps1", import.meta.url), "utf8"))
  for (const name of [
    "testWindow",
    "multilineText",
    "singlelineText",
    "changeLabelButton",
    "statusLabel",
    "testCheckbox",
    "testItems",
  ])
    expect(fixture).toContain(`.Name = '${name}'`)
  for (const name of [
    "Multiline text",
    "Single-line text",
    "Change label",
    "Enable option",
    "Choose an item",
  ])
    expect(fixture).toContain(`.AccessibleName = '${name}'`)
  expect(fixture).toContain("$multiline.Multiline = $true")
  ordered(fixture, "$button.Add_Click({", "$status.Text = 'Button clicked'")
  expect(fixture).toContain("@('Alpha', 'Beta', 'Gamma')")
  expect(fixture).toContain("[System.Windows.Forms.Application]::Run($form)")
  expect(fixture).not.toMatch(/Start-Process|Bun\.spawn|-TypeDefinition/)
})

describe("helper pointer source contracts (not runtime behavior)", () => {
  test("rechecks actual cursor coordinates and ownership after positioning and before mouse-down", () => {
    ordered(
      helperFunction("Invoke-OwnedClick"),
      "Assert-ClickPoint $window $nativePoint",
      "if (-not [OwnedUia.Native]::SetCursorPos($nativePoint.X, $nativePoint.Y))",
      "Deny 'Pointer could not be positioned.'",
      "Assert-Element $window $element",
      "IsOffscreenProperty",
      "$actualPoint = [OwnedUia.Native+POINT]::new(0, 0)",
      "if (-not [OwnedUia.Native]::GetCursorPos([ref]$actualPoint) -or",
      "$actualPoint.X -ne $nativePoint.X -or $actualPoint.Y -ne $nativePoint.Y",
      "Deny 'Pointer moved before input; click refused.'",
      "Assert-ClickPoint $window $actualPoint",
      "[OwnedUia.Native]::Mouse($false)",
      "finally { $null = [OwnedUia.Native]::Mouse($true) }",
    )
    ordered(
      helperFunction("Assert-ClickPoint"),
      "Assert-Foreground $window",
      "$hit = [OwnedUia.Native]::WindowFromPoint($point)",
      "GetAncestor($hit, 2) -ne $window.Handle",
      "WindowPid($hit) -ne $window.Identity.Pid",
      "Deny 'Clickable point is obscured or outside the owned window.'",
      "Assert-Foreground $window",
    )
  })
})

describe("helper tree source contracts (not runtime behavior)", () => {
  test("queues already-fetched siblings outside the per-node provider catch", () => {
    ordered(
      helperFunction("Get-OwnedTree"),
      "while ($stack.Count -gt 0)",
      "$item = $stack.Pop()",
      "if ($item.Sibling)",
      "$next = $item.Index + 1",
      "$stack.Push([pscustomobject]@{",
      "Element = $siblings[$next]",
      "$lineIndex = $lines.Count",
      "try {",
      "Assert-Window $window",
      "$element.GetCurrentPropertyValue(",
      "} catch {",
      "if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }",
      "$window.Refs.Remove($ref)",
      "$unreadable =",
      "if ($lines.Count -gt $lineIndex) { $lines[$lineIndex] = $unreadable }",
      "else { $lines.Add($unreadable) }",
      "$cut = $true",
    )
  })

  test("checks PID before content, verifies ancestry once per node and trusts patterns only locally", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(
      tree,
      "ProcessIdProperty, $true)",
      "if ($elementPid -isnot [int] -or $elementPid -ne $window.Identity.Pid)",
      "$cut = $true",
      "continue",
      "Assert-Element $window $element",
      "ControlTypeProperty",
      "NameProperty",
      "$window.Refs[$ref] = $element",
    )
    expect(tree.match(/Assert-Element \$window \$element/g)).toHaveLength(1)
    const patterns = tree.split("\n").filter((line) => line.includes("Get-Pattern "))
    expect(patterns).toHaveLength(3)
    for (const pattern of patterns) expect(pattern.trimEnd().endsWith(" -Verified -Clock $clock")).toBe(true)
    const properties = tree.split("\n").filter((line) => line.includes("Read-Property "))
    expect(properties).toHaveLength(5)
    for (const property of properties)
      expect(property.trimEnd().endsWith(" -Verified -Clock $clock")).toBe(true)
    expect(helperFunction("Assert-TreeBudget")).toContain("$clock.ElapsedMilliseconds -ge 20000")
    expect(helperFunction("Get-Pattern")).toContain("if (-not $Verified) { Assert-Element $window $element }")
    expect(helperFunction("Read-Property")).toContain("Assert-Element $window $element")
    expect(helperFunction("Invoke-OwnedClick")).not.toContain(" -Verified")
    expect(helperFunction("Set-OwnedText")).not.toContain(" -Verified")
  })

  test("skips out-of-scope native children before ancestry, content, refs or child traversal", () => {
    ordered(
      helperFunction("Get-OwnedTree"),
      "NativeWindowHandleProperty, $true)",
      "if ($handleValue -is [int] -and $handleValue -ne 0)",
      "GetAncestor($handle, 2) -ne $window.Handle -or",
      "WindowPid($handle) -ne $window.Identity.Pid)",
      "$cut = $true",
      "continue",
      "Assert-Element $window $element",
      "ControlTypeProperty",
      "NameProperty",
      "$window.Refs[$ref] = $element",
      "$element.FindAll(",
    )
    // Action checks still reject these nodes rather than trusting a shared PID.
    ordered(
      helperFunction("Assert-Element"),
      "GetAncestor($handle, 2) -ne $window.Handle -or",
      "WindowPid($handle) -ne $window.Identity.Pid)",
      "Deny 'Element is outside the owned window.'",
      "$cursor = $script:walker.GetParent($cursor)",
      "Deny 'Element ancestry cannot be verified.'",
    )
  })

  test("bounds traversal at 20 seconds, node/depth limits and owned children only", () => {
    const tree = helperFunction("Get-OwnedTree")
    expect(tree).toContain("Get-Integer $parameters 'depth' 8 0 30")
    expect(tree).toContain("Get-Integer $parameters 'maxNodes' 300 1 1000")
    expect(tree).toContain("$lines.Count -ge $maxNodes -or $clock.ElapsedMilliseconds -ge 20000")
    expect(tree).toContain(
      "$item.Depth -lt $depth -and $lines.Count -lt $maxNodes -and $clock.ElapsedMilliseconds -lt 20000",
    )
    ordered(tree, "Assert-TreeBudget $clock", "$window.Refs[$ref] = $element", "$lines.Add($line)")
    ordered(tree, "$element.FindAll(", "Assert-TreeBudget $clock", "if ($children.Count -gt 0)")
    expect(tree).toContain("elseif ($item.Depth -lt $depth) { $cut = $true }")
    expect(tree).toContain("$element.FindAll([System.Windows.Automation.TreeScope]::Children,")
    expect(tree).toContain("$textPattern.DocumentRange.GetText(512)")
    expect(tree).not.toContain("RootElement")
    expect(tree).not.toContain("TreeScope]::Descendants")
  })

  test("invalidates old refs before traversal and all partial refs on a fatal snapshot failure", () => {
    const tree = helperFunction("Get-OwnedTree")
    ordered(tree, "$window.Refs = @{}", "$clock = [Diagnostics.Stopwatch]::StartNew()", "$stack.Push(")
    ordered(tree, "return @{ text = $text;", "} catch {", "$window.Refs = @{}", "throw")
    ordered(helperFunction("Deny"), "throw [System.InvalidOperationException]::new('UIA_SAFE: ' + $message)")
  })
})

describe("helper stale journal source contracts (not runtime behavior)", () => {
  test("startup reaps abandoned journals before loading UIA or permitting launches", () => {
    ordered(
      code(source),
      "$script:self = Get-Identity $PID",
      "\n    Clear-StaleJournals\n",
      "$previous = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json",
      "if (-not (Test-OwnedState $previous)) { Deny",
      "Stop-ExactProcess $identity",
      "if (-not (Test-IdentityGone $identity))",
      "$script:processes[$record.Key] = $record",
      "Save-OwnedState",
      "if ($script:processes.Count -gt 0) { Deny",
      "Add-Type -AssemblyName UIAutomationClient",
    )
  })

  test("restricts journal names, skips this helper's files and validates every identity before killing", () => {
    const stale = helperFunction("Clear-StaleJournals")
    expect(stale).toContain("'amira-uia-*.json*'")
    expect(stale).toContain(
      "'^amira-uia-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json(\\.tmp)?$'",
    )
    ordered(
      stale,
      "[string]::Equals($file, $StatePath, [StringComparison]::OrdinalIgnoreCase)",
      "[string]::Equals($file, $StatePath + '.tmp', [StringComparison]::OrdinalIgnoreCase)) { continue }",
      "[IO.File]::ReadAllText($file) | ConvertFrom-Json",
      "if (-not (Test-OwnedState $state)) { continue }",
      "$helper = $state.Helper",
      "$records = $state.Processes",
      "if (-not (Test-IdentityGone $helper)) { continue }",
      "foreach ($identity in $records)",
      "Stop-ExactProcess $identity",
    )
  })

  test("current-schema journals validate every identity and reject legacy ownership rules", () => {
    ordered(
      helperFunction("Test-OwnedState"),
      "$version = Get-Argument $state 'OwnershipVersion'",
      "$version -isnot [int] -or $version -ne 2",
      "$null -eq $helper -or $records -isnot [System.Array]) { return $false }",
      "foreach ($identity in (@($helper) + @($records)))",
      "[int]::TryParse([string](Get-Argument $identity 'Pid'), [ref]$processId)",
      "$processId -le 0",
      "[long]::TryParse([string](Get-Argument $identity 'Started'), [ref]$started)",
      "$started -le 0) { return $false }",
      "return $true",
    )
    expect(helperFunction("Save-OwnedState")).toContain("OwnershipVersion = 2")
    const watchdog = code(readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8"))
    ordered(
      watchdog,
      "$state.OwnershipVersion -isnot [int] -or $state.OwnershipVersion -ne 2",
      "$state.Processes -isnot [System.Array]) { return $false }",
      "foreach ($identity in (@($state.Helper) + @($state.Processes)))",
      "[int]::TryParse([string]$identity.Pid, [ref]$processId)",
      "[long]::TryParse([string]$identity.Started, [ref]$started)",
      "return $true",
      "$state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json",
      "if (-not (Test-OwnedState $state)) { throw",
      "$helperProcess = Get-ExactProcess $state.Helper",
      "foreach ($identity in $state.Processes)",
      "$process = Get-ExactProcess $identity",
      "$process.Kill()",
      "$helperProcess.Kill()",
    )
    ordered(
      watchdog,
      "GetProcessById([int]$identity.Pid)",
      "$null = $process.Handle",
      "$process.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$identity.Started",
      "return $process",
    )
  })

  test("active or inaccessible helpers are not proof of abandonment; deletion waits for verified exit", () => {
    const gone = helperFunction("Test-IdentityGone")
    ordered(
      gone,
      "GetProcessById([int]$identity.Pid)",
      "$null = $process.Handle",
      "$process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$identity.Started",
      "catch [ArgumentException] { return $true }",
      "catch { return $false }",
      "$process.Dispose()",
    )
    ordered(
      helperFunction("Clear-StaleJournals"),
      "if (-not (Test-IdentityGone $helper)) { continue }",
      "$gone = $true",
      "Stop-ExactProcess $identity",
      "if (-not (Test-IdentityGone $identity)) { $gone = $false }",
      "if ($gone) { [IO.File]::Delete($file) }",
      "catch { }",
    )
  })

  test("window close revalidates the recorded identity, HWND, PID and UIA ancestry", () => {
    ordered(
      helperFunction("Request-WindowClose"),
      "Test-Identity $window.Identity",
      "IsWindow($window.Handle)",
      "GetAncestor($window.Handle, 2) -ne $window.Handle",
      "WindowPid($window.Handle) -ne $window.Identity.Pid",
      "Get-Pattern $window $window.Root",
      "Assert-Element $window $window.Root",
      "$pattern.Close()",
    )
    ordered(
      helperFunction("Close-OwnedWindow"),
      "$window = Get-Window $parameters",
      "Request-WindowClose $window",
      "foreach ($key in $window.ProcessKeys)",
      "$identity = $script:processes[$key]",
      "Stop-ExactProcess $identity",
    )
    expect(code(source).match(/\.Kill\(\)/g)).toHaveLength(1)
    expect(code(source).match(/\$pattern\.Close\(\)/g)).toHaveLength(1)
  })

  test("cleanup kills only through a cached handle with matching PID and start time", () => {
    const stop = helperFunction("Stop-ExactProcess")
    ordered(
      stop,
      "GetProcessById($identity.Pid)",
      "$null = $process.Handle",
      "if (-not $process.HasExited -and",
      "$process.StartTime.ToUniversalTime().Ticks -eq $identity.Started)",
      "$process.Kill()",
      "$process.Dispose()",
    )
    expect(stop).not.toContain("Stop-Process")
    expect(stop).not.toContain("GetProcessesByName")
    ordered(
      helperFunction("Save-OwnedState"),
      "$script:processes.Values",
      "@{ Pid = $_.Pid; Started = $_.Started.ToString() }",
      "Helper = @{ Pid = $script:self.Pid; Started = $script:self.Started.ToString() }",
      "[IO.File]::WriteAllText($StatePath + '.tmp', $state, $utf8)",
      "[IO.File]::Replace($StatePath + '.tmp', $StatePath, [NullString]::Value)",
    )
  })
})
