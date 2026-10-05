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
  test("journals the launcher identity before discovery or provider access", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "$launcher = Start-Process @startOptions",
      "try {",
      "$null = $launcher.Handle",
      "$started = $launcher.StartTime.ToUniversalTime().Ticks",
      "$started -lt $began -or $beforeProcesses.ContainsKey($launcher.Id)",
      "$launcherIdentity = [pscustomobject]@{",
      "$launchKeys[$launcherIdentity.Key] = $true",
      "$script:processes[$launcherIdentity.Key] = $launcherIdentity",
      "Save-OwnedState",
      "while ($clock.ElapsedMilliseconds -lt 15000)",
      "$window.Root = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)",
      "Assert-Element $window $window.Root",
      "$title = Read-Property",
    )
  })

  test("journals new handoff targets before visible-window discovery and provenance checks", () => {
    const launch = helperFunction("Start-OwnedApp")
    const discovery = launch.slice(launch.indexOf("while ($clock.ElapsedMilliseconds -lt 15000)"))
    ordered(
      discovery,
      "foreach ($process in [Diagnostics.Process]::GetProcesses())",
      "$beforeProcesses.ContainsKey($process.Id)",
      "$identity = Get-Identity $process.Id -WithPath",
      "$identity.Started -ge $began",
      "(Test-AppPath $identity.Path '' $handoff)",
      "$launchKeys[$identity.Key] = $true",
      "$script:processes[$identity.Key] = $identity",
      "Save-OwnedState",
      "foreach ($native in [OwnedUia.Native]::Windows())",
      "$identity.Key -ne $launcherIdentity.Key",
      "if (-not $launchKeys.ContainsKey($identity.Key))",
      "$script:processes[$identity.Key] = $identity",
      "Save-OwnedState",
      "if (-not $launcher.HasExited) { continue }",
    )
  })

  test("rejects stale, ambiguous, uncorrelated or wrong-parent handoffs before adoption", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "$beforeHandles.ContainsKey($native.Handle.ToInt64().ToString())",
      "$identity.Started -lt $began",
      "$beforeProcesses.ContainsKey($identity.Pid)",
      "-not (Test-AppPath $identity.Path $path $handoff)",
      "$identity.Key -ne $launcherIdentity.Key",
      "[string]::IsNullOrEmpty($handoff)",
      "-not (Test-AppPath $identity.Path '' $handoff)",
      "if (-not $launcher.HasExited) { continue }",
      "$identity.Started -lt $started",
      "$identity.Started - $started -gt [TimeSpan]::FromSeconds(3).Ticks",
      "Deny 'Hand-off cannot be correlated",
      "$parentPid = [OwnedUia.Native]::ParentPid($identity.Pid)",
      "$parentPid -ge 0 -and $parentPid -ne $launcherIdentity.Pid",
      "Deny 'Hand-off parent does not match",
      "$candidates.Add(",
      "if ($candidates.Count -gt 1) { Deny",
      "$clock.ElapsedMilliseconds - $stableSince -ge 500",
      "$script:windows[$windowRef] = $window",
    )
  })

  test("failed launches revoke the window, clean exact identities and retain failed kills", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "Deny 'No new, unambiguous owned window appeared",
      "} catch {",
      "if ($null -ne $windowRef) { $script:windows.Remove($windowRef) }",
      "if ($null -eq $launcherIdentity)",
      "if (-not $launcher.HasExited) { $launcher.Kill() }",
      "else { Stop-ExactProcess $launcherIdentity }",
      "$cleanupProcesses = [Diagnostics.Process]::GetProcesses()",
      "$identity = Get-Identity $process.Id -WithPath",
      "$identity.Started -ge $began",
      "(Test-AppPath $identity.Path '' $handoff)",
      "$script:processes[$identity.Key] = $identity",
      "Save-OwnedState",
      "foreach ($key in @($launchKeys.Keys))",
      "$identity = $script:processes[$key]",
      "Stop-ExactProcess $identity",
      "if (Test-IdentityGone $identity) { $script:processes.Remove($key) }",
      "Save-OwnedState",
      "throw",
      "finally { $launcher.Dispose() }",
    )
  })

  test("Calculator requires positive full-trust manifest evidence before Start-Process", () => {
    const launch = helperFunction("Start-OwnedApp")
    ordered(
      launch,
      "if ($handoff -eq 'calculator')",
      "$adoptable = $false",
      "if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)",
      "Get-AppxPackage -Name Microsoft.WindowsCalculator -ErrorAction Stop",
      "if ($packages.Count -eq 1)",
      "[xml]$manifest = [IO.File]::ReadAllText",
      "if ($applications.Count -eq 1)",
      "$adoptable = ($application.GetAttribute('EntryPoint') -eq 'Windows.FullTrustApplication' -and",
      "(Test-AppPath $executable '' $handoff) -and [IO.File]::Exists($executable))",
      "catch { $adoptable = $false }",
      "if (-not $adoptable)",
      "Deny 'Calculator refused before launch:",
      "$launcher = Start-Process @startOptions",
    )
  })
})

test("debug key output is absent and Calculator smoke refusal is a skip (source contracts)", () => {
  const capture = readFileSync(new URL("./capture.ts", import.meta.url), "utf8")
  const debugMarker = ["[DEBUG", "uia-key]"].join("-")
  expect(source).not.toContain(debugMarker)
  expect(capture).not.toContain(debugMarker)
  expect(source).not.toContain("ScriptStackTrace")
  const smoke = readFileSync(new URL("../scripts/smoke.ts", import.meta.url), "utf8")
  ordered(smoke, 'if (app === "calculator")', "skipped (launch refused; not a smoke failure)", "continue")
  expect(smoke).not.toContain("process.exitCode = 1")
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
      "if ($null -eq $helper -or $records -isnot [System.Array]) { continue }",
      "foreach ($identity in (@($helper) + @($records)))",
      "[int]::TryParse([string](Get-Argument $identity 'Pid'), [ref]$processId)",
      "$processId -le 0",
      "[long]::TryParse([string](Get-Argument $identity 'Started'), [ref]$started)",
      "$started -le 0) { $valid = $false; break }",
      "if (-not $valid -or -not (Test-IdentityGone $helper)) { continue }",
      "foreach ($identity in $records)",
      "Stop-ExactProcess $identity",
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
      "if (-not $valid -or -not (Test-IdentityGone $helper)) { continue }",
      "$gone = $true",
      "Stop-ExactProcess $identity",
      "if (-not (Test-IdentityGone $identity)) { $gone = $false }",
      "if ($gone) { [IO.File]::Delete($file) }",
      "catch { }",
    )
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
