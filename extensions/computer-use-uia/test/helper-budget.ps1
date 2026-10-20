# Offline regression only. Parse the helper; NEVER dot-source or run its startup.
param([Parameter(Mandatory = $true)][string] $HelperPath)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Assert-NoUiaAssembly {
    if ([AppDomain]::CurrentDomain.GetAssemblies().GetName().Name -contains 'UIAutomationClient') {
        throw 'The offline harness must never load UIAutomationClient.'
    }
}
Assert-NoUiaAssembly
# These are inert stand-ins, not UIA types or native interop. All calls use fake time.
Add-Type -TypeDefinition @'
using System;
using System.Text;
namespace System.Windows.Automation {
    public static class Automation {
        public static Action<string> Call;
        public static bool Compare(object a, object b) {
            Call("compare"); return Object.ReferenceEquals(a, b);
        }
    }
    public static class AutomationElement {
        public static readonly object NativeWindowHandleProperty = new object();
        public static readonly object NotSupported = new object();
    }
    public class ControlType { public string ProgrammaticName = "ControlType.Pane"; }
}
namespace OwnedUia {
    public static class Native {
        public static IntPtr GetAncestor(IntPtr handle, int flag) {
            System.Windows.Automation.Automation.Call("native ancestor"); return handle;
        }
        public static int GetClassName(IntPtr handle, StringBuilder text, int size) {
            text.Append("Chrome_WidgetWin_fake"); return text.Length;
        }
    }
}
'@
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($name in @('Deny', 'Get-Argument', 'Get-Integer', 'Escape-Field', 'Assert-TreeBudget', 'Assert-Element', 'Get-OwnedTree')) {
    $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing helper function: $name" }
    # The only replaced production operation is stopwatch creation; provider
    # dependencies below are stubs. Ancestry and traversal control flow are real.
    $body = $definition.Extent.Text.Replace('[Diagnostics.Stopwatch]::StartNew()', '(Start-FakeClock)')
    . ([scriptblock]::Create($body))
}
function Start-FakeClock {
    $clock = [pscustomobject]@{ StartMs = $script:now; PausedMs = 0; PausedAt = $null }
    $clock | Add-Member ScriptProperty ElapsedMilliseconds {
        $end = $script:now
        if ($null -ne $this.PausedAt) { $end = $this.PausedAt }
        return $end - $this.StartMs - $this.PausedMs
    }
    $clock | Add-Member ScriptMethod Stop { $this.PausedAt = $script:now }
    $clock | Add-Member ScriptMethod Start {
        $this.PausedMs += $script:now - $this.PausedAt
        $this.PausedAt = $null
    }
    $script:clock = $clock
    return $clock
}
function Invoke-FakeCall([string] $kind) {
    $script:calls.Add([pscustomobject]@{ kind = $kind; ms = $script:now })
    if ($script:scenario -eq 'slow') { $script:now += 1000 }
    elseif ($script:scenario -eq ('retry-' + $kind) -and $script:now -ge 19900) { $script:now += 200 }
}
[System.Windows.Automation.Automation]::Call = { param($kind) Invoke-FakeCall $kind }
function New-FakeElement($parent, [int] $handle = 0) {
    $element = [pscustomobject]@{ Parent = $parent; Handle = $handle }
    $element | Add-Member ScriptMethod GetCurrentPropertyValue {
        param($property, $ignoreDefault)
        Invoke-FakeCall 'property'
        return $this.Handle
    }
    $element | Add-Member ScriptMethod GetUpdatedCache { param($cache) return $this }
    return $element
}
$script:walker = New-Object PSObject
$script:walker | Add-Member ScriptMethod GetParent {
    param($element)
    Invoke-FakeCall 'parent'
    return $element.Parent
}
function Assert-Window($window) { }
function Get-Window($parameters) { return $script:window }
function Get-TreeProperties { return @{} }
function New-TreeCacheRequest($properties) { return New-Object PSObject }
function Get-TreeChildren($element, $properties, $clock) { return ,@() }
function Read-TreeProperties($window, $element, $properties, $metrics, $clock, $UseCache) {
    if ($script:scenario -like 'retry-*') { $script:now = 19400 }
    $metrics.cached++
    return @{ Type = (New-Object System.Windows.Automation.ControlType); Name = 'fake'; AutomationId = ''
        Enabled = $true; Offscreen = $false; Password = $true; ToggleAvailable = $false }
}
function Start-Sleep([int] $Milliseconds) { $script:now += $Milliseconds }
function Get-TargetScreenshot($window, $maxEdge) { $script:now += 60000; return @{ id = 'fake' } }
function Reset-Scenario([string] $name, [int] $depth = 1, [int] $handle = 0) {
    $script:scenario = $name
    $script:now = 0L
    $script:clock = $null
    $script:calls = New-Object 'System.Collections.Generic.List[object]'
    $script:nextElement = 1
    $top = New-FakeElement $null
    $root = $top
    for ($i = 0; $i -lt $depth; $i++) { $root = New-FakeElement $root $handle }
    $script:window = [pscustomobject]@{ Root = $top; Handle = [IntPtr]::new(123); Refs = @{ e1 = $root }; Screenshot = $null }
}
function Invoke-RootedRead([switch] $Find) {
    $failure = $null
    try { $null = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'fake'; screenshot = $false }) -Find:$Find }
    catch { $failure = $_.Exception.Message }
    if (@($script:calls | Where-Object { $_.ms -ge 20000 }).Count -gt 0) {
        throw "$script:scenario ancestry issued additional provider calls after the shared 20-second deadline (elapsed=$script:now)."
    }
    if ($failure -notlike '*budget exhausted during root validation*') {
        throw "$script:scenario ancestry should fail closed with a budget error, not: $failure"
    }
    if ($script:window.Refs.Count -ne 0) { throw 'Failed root validation retained old refs.' }
    return $failure
}
foreach ($find in @($false, $true)) {
    Reset-Scenario slow 4
    $null = Invoke-RootedRead -Find:$find
    if ($script:now -ne 20000 -or $script:clock.StartMs -ne 0) { throw 'Initial ancestry must consume the same traversal budget.' }
    foreach ($kind in @('compare', 'property', 'parent', 'native ancestor')) {
        Reset-Scenario ('retry-' + $kind) 1 123
        $null = Invoke-RootedRead -Find:$find
        if ($script:now -ne 20100) { throw 'Retry should allow only the one call started before the deadline.' }
    }
    # No clock is supplied to action callers; ancestry must still fail closed.
    Reset-Scenario foreign 1 456
    $failure = $null
    try { Assert-Element $script:window $script:window.Refs.e1 } catch { $failure = $_.Exception.Message }
    if ($failure -notlike '*outside the target window*') { throw 'Foreign ancestry was not refused.' }
    Reset-Scenario missing 1
    $script:window.Refs.e1.Parent = $null
    $failure = $null
    try { Assert-Element $script:window $script:window.Refs.e1 } catch { $failure = $_.Exception.Message }
    if ($failure -notlike '*ancestry cannot be verified*') { throw 'Unverifiable ancestry was not refused.' }
}
# Captures remain outside the UIA deadline, but may not reset ancestry time.
Reset-Scenario screenshot
$result = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; screenshot = $true; treeDensityThreshold = 0 })
if ($script:now -ne 60000 -or $script:clock.ElapsedMilliseconds -ne 0 -or $result.screenshot.id -ne 'fake') {
    throw 'Screenshot overhead must be paused, not reset or charged to UIA time.'
}
Reset-Scenario expired
$null = Start-FakeClock
$script:now = 20000
$failure = $null
try { Assert-Element $script:window $script:window.Refs.e1 -Clock $script:clock }
catch { $failure = $_.Exception.Message }
if ($failure -notlike '*budget exhausted*' -or $script:calls.Count -ne 0) { throw 'Expired ancestry must not start any calls.' }
Assert-NoUiaAssembly
'Offline ancestry budget regressions passed (tree/find, slow ancestry, retry and fail-closed checks).'
