# Offline only: parse individual helper functions, never run startup or load UIA.
param([Parameter(Mandatory = $true)][string] $HelperPath, [string] $Case = 'baseline')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.ScriptStackTrace); throw $_ }
function Assert-NoUia {
    if ([AppDomain]::CurrentDomain.GetAssemblies().GetName().Name -contains 'UIAutomationClient') {
        throw 'Offline harness loaded UIAutomationClient.'
    }
}
Assert-NoUia
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$source = [IO.File]::ReadAllText($HelperPath)
$workerStart = $source.IndexOf('    public sealed class PatternCall {')
$workerEnd = $source.IndexOf('    public static class Native {', $workerStart)
$worker = $source.Substring($workerStart, $workerEnd - $workerStart)
# These are in-memory stand-ins, not real UIA types. Production worker code is
# compiled unchanged against them, with only fake Native/Automation calls.
$fakes = @'
using System;
using System.Collections.Generic;
namespace System.Windows.Automation {
    public static class Automation {
        public static bool Compare(object a, object b) { return Object.ReferenceEquals(a, b); }
    }
    public class ElementNotAvailableException : Exception { }
    public class ControlType { public string ProgrammaticName; public ControlType(string name) { ProgrammaticName = "ControlType." + name; } }
    public enum ToggleState { Off, On }
    public enum ScrollAmount { NoAmount, SmallDecrement, SmallIncrement }
    public class AutomationElement {
        public static readonly object NotSupported = new object();
        public static readonly object NativeWindowHandleProperty = "Handle";
        public static readonly object NameProperty = "Name";
        public static readonly object ControlTypeProperty = "Type";
        public static readonly object AutomationIdProperty = "AutomationId";
        public static AutomationElement Root;
        public AutomationElement Parent;
        public AutomationElement[] Children = new AutomationElement[0];
        public Dictionary<object, object> Properties = new Dictionary<object, object>();
        public Dictionary<object, object> Patterns = new Dictionary<object, object>();
        public bool Broken;
        public HashSet<object> Unavailable = new HashSet<object>();
        public int[] RuntimeId;
        public int[] GetRuntimeId() { if (Broken || RuntimeId == null) throw new ElementNotAvailableException(); return RuntimeId; }
        public AutomationElement Copy() {
            return new AutomationElement { Parent = Parent, Children = Children,
                Properties = new Dictionary<object, object>(Properties), Patterns = new Dictionary<object, object>(Patterns),
                Unavailable = new HashSet<object>(Unavailable), RuntimeId = RuntimeId };
        }
        public object GetCurrentPropertyValue(object key, bool ignore) {
            if (Broken || Unavailable.Contains(key) || !Properties.ContainsKey(key)) throw new ElementNotAvailableException();
            return Unwrap(Properties[key]);
        }
        static object Unwrap(object value) {
            // PowerShell can box object-valued fake dictionary entries in PSObject;
            // real UIA's typed TryGetCurrentPattern returns the underlying pattern.
            while (value != null && value.GetType().FullName == "System.Management.Automation.PSObject")
                value = value.GetType().GetProperty("BaseObject").GetValue(value, null);
            return value;
        }
        public bool TryGetCurrentPattern(object key, out object pattern) {
            if (Broken) throw new ElementNotAvailableException();
            bool found = Patterns.TryGetValue(key, out pattern);
            pattern = Unwrap(pattern);
            return found;
        }
        public AutomationElement GetUpdatedCache(object cache) { return this; }
        public static AutomationElement FromHandle(IntPtr handle) { return Root; }
        public void SetFocus() { throw new InvalidOperationException("Unexpected focus"); }
    }
    public class TreeWalker {
        public static TreeWalker RawViewWalker = new TreeWalker();
        public AutomationElement GetParent(AutomationElement element) {
            if (!element.Properties.ContainsKey("Handle")) throw new ElementNotAvailableException();
            return element.Parent;
        }
    }
    public class ScrollPattern {
        public static readonly object Pattern = "scroll";
        public ScrollPattern Current { get { return this; } }
        public static int CallerThread;
        public static System.Threading.ManualResetEvent Release = new System.Threading.ManualResetEvent(false);
        public bool Vertical = true;
        public bool GuardCaller, BlockGetter;
        public bool VerticallyScrollable {
            get {
                if (GuardCaller && System.Threading.Thread.CurrentThread.ManagedThreadId == CallerThread)
                    throw new InvalidOperationException("Unbounded vertical getter");
                if (BlockGetter) Release.WaitOne(10000);
                return Vertical;
            }
            set { Vertical = value; }
        }
        public double VerticalScrollPercent = 50;
        public List<string> Calls = new List<string>();
        public void Scroll(ScrollAmount horizontal, ScrollAmount vertical) {
            if (horizontal != ScrollAmount.NoAmount) throw new InvalidOperationException();
            Calls.Add(vertical.ToString());
            VerticalScrollPercent += vertical == ScrollAmount.SmallDecrement ? -1 : 1;
        }
    }
    public class VirtualizedItemPattern {
        public static readonly object Pattern = "realize";
        public static List<string> Calls = new List<string>();
        public AutomationElement Element;
        public bool MoveAfter;
        public AutomationElement ParentAfter;
        public void Realize() {
            if (Element != null && Element.Broken) throw new ElementNotAvailableException();
            Calls.Add("realize");
            if (Element != null) {
                Element.Properties["Handle"] = 0;
                if (MoveAfter) Element.Parent = ParentAfter;
            }
        }
    }
    public class ScrollItemPattern {
        public static readonly object Pattern = "scrollIntoView";
        public void ScrollIntoView() { VirtualizedItemPattern.Calls.Add("scrollIntoView"); }
    }
    public class ItemContainerPattern {
        public static readonly object Pattern = "container";
        public AutomationElement[] Items = new AutomationElement[0];
        public List<AutomationElement> Starts = new List<AutomationElement>();
        public object Property;
        public object Value;
        public bool Ephemeral;
        public AutomationElement Last;
        int lastIndex = -1;
        public AutomationElement FindItemByProperty(AutomationElement after, object property, object value) {
            Starts.Add(after); Property = property; Value = value;
            int start = after == null ? 0 : (Object.ReferenceEquals(after, Last) ? lastIndex : Array.IndexOf(Items, after)) + 1;
            if (Ephemeral && Last != null) Last.Broken = true;
            for (int i = start; i < Items.Length; i++) {
                if (Items[i].Properties.ContainsKey(property) && Object.Equals(Items[i].Properties[property], value)) {
                    lastIndex = i;
                    Last = Ephemeral ? Items[i].Copy() : Items[i];
                    if (Ephemeral) {
                        var realize = new VirtualizedItemPattern { Element = Last };
                        Last.Patterns[VirtualizedItemPattern.Pattern] = realize;
                    }
                    return Last;
                }
            }
            return null;
        }
    }
    public class InvokePattern { public void Invoke() { throw new InvalidOperationException(); } }
    public class TogglePattern { public void Toggle() { throw new InvalidOperationException(); } }
    public class SelectionItemPattern { public void Select() { throw new InvalidOperationException(); } }
    public class ExpandCollapsePattern { public void Expand() { throw new InvalidOperationException(); } public void Collapse() { throw new InvalidOperationException(); } }
    public class ValuePattern { public static object Pattern = "value"; public void SetValue(string text) { throw new InvalidOperationException(); } }
    public class TextPattern { public static object Pattern = "text"; }
    public class WindowPattern { public void Close() { throw new InvalidOperationException(); } }
}
namespace OwnedUia {
    public static class Native {
        public sealed class FakeWindow { public bool Visible = true; public IntPtr Handle = new IntPtr(123); public string Title; }
        public static FakeWindow[] Listing = new FakeWindow[0];
        public static FakeWindow[] Windows() { return Listing; }
        public static int GetWindowText(IntPtr handle, System.Text.StringBuilder title, int capacity) {
            foreach (var window in Listing) if (window.Handle == handle) { title.Append(window.Title.Substring(0, Math.Min(window.Title.Length, capacity - 1))); break; }
            return title.Length;
        }
        public static bool Exists = true;
        public static int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        public static long CreationTime(IntPtr handle) { return 1; }
        public static bool IsWindow(IntPtr handle) { return Exists; }
        public static int WindowPid(IntPtr handle) { return Pid; }
        public static IntPtr GetAncestor(IntPtr handle, int flag) { return handle; }
        public static int GetClassName(IntPtr handle, System.Text.StringBuilder text, int size) { text.Append("Chrome_WidgetWin_fake"); return text.Length; }
    }
}
'@
Add-Type -TypeDefinition ($fakes + "`nnamespace OwnedUia {`n" + $worker + "`n}")
foreach ($name in @('Deny', 'Get-Argument', 'Get-Integer', 'Escape-Field', 'Assert-TreeBudget', 'Assert-Element',
    'Get-Windows', 'Get-ScrollPattern', 'Invoke-OwnedScroll', 'Get-ContainerLookup', 'Read-VirtualMetadata', 'Get-OwnedTree', 'Get-WaitPoll', 'Invoke-BoundedPattern')) {
    $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing helper function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text.Replace('[Diagnostics.Stopwatch]::StartNew()', '(Start-FakeClock)')))
}
$realGetWindows = (Get-Command Get-Windows).ScriptBlock
function Check($condition, [string] $message) { if (-not $condition) { throw $message } }
function Refused([scriptblock] $operation, [string] $message) {
    $failure = $null
    try { $null = & $operation } catch { $failure = $_.Exception.Message }
    Check ($null -ne $failure -and $failure.Contains('UIA_SAFE: ')) $message
}
function Start-FakeClock {
    $clock = [pscustomobject]@{ Started = $script:now }
    $clock | Add-Member ScriptProperty ElapsedMilliseconds { return $script:now - $this.Started }
    return $clock
}
function Assert-Lifetime { }
function Assert-Window($window) { }
function Assert-ActionWindow($window) { $script:actionChecks++ }
function Show-Action($window, $element, $kind, $label) { $script:shown++ }
function Start-Sleep { throw 'Helper polls must never sleep.' }
function Get-TargetScreenshot { throw 'Unexpected capture.' }
function Focus-Window { throw 'Unexpected focus.' }
function Invoke-CoordinateInput($window, $parameters, $kind) { $script:mouse++; return @{ path = 'fake-coordinate' } }
function Get-Window($parameters, $Clock = $null) {
    Assert-TreeBudget $Clock
    if ($script:failWindow) { Deny 'Target window is no longer valid.' }
    $ref = Get-Argument $parameters 'window' ''
    if ($script:windowMap.ContainsKey($ref)) { return $script:windowMap[$ref] }
    return $script:window
}
function Get-Pattern($window, $element, $patternId, [switch] $Verified, $Clock = $null) {
    Assert-TreeBudget $Clock
    if (-not $Verified) { Assert-Element $window $element }
    $script:patternReads.Add([string]$patternId)
    if ($element.Broken) { throw [System.Windows.Automation.ElementNotAvailableException]::new() }
    if ($element.Patterns.ContainsKey($patternId)) { return $element.Patterns[$patternId] }
    return $null
}
function Get-TreeProperties {
    $properties = [ordered]@{}
    foreach ($key in @('Type', 'Name', 'AutomationId', 'Enabled', 'Offscreen', 'Password', 'ValueAvailable', 'TextAvailable', 'ToggleAvailable')) {
        $properties[$key] = $key
    }
    return $properties
}
function New-TreeCacheRequest($properties) { return [pscustomobject]@{ Properties = $properties } }
function Read-TreeProperties($window, $element, $properties, $metrics, $clock, [bool] $UseCache = $true) {
    Assert-TreeBudget $clock
    $script:now += $script:readMs
    $script:metadataReads++
    if ($script:metadataReads -eq $script:failAfterReads -and $window.Ref -eq '123') { Deny 'Window disappeared.' }
    if ($element.Broken) { throw 'Fake provider unavailable.' }
    $metadata = @{}
    foreach ($key in $properties.Keys) { $metadata[$key] = $element.Properties[$key] }
    $metrics.cached++
    return $metadata
}
function Get-TreeChildren($element, $properties, $clock) {
    Assert-TreeBudget $clock
    return ,$element.Children
}
function Get-WindowInfo($native) {
    return @{ window = $native.Handle.ToInt64().ToString(); title = $native.Title.Substring(0, [Math]::Min(120, $native.Title.Length));
        titleCut = $native.Title.Length -gt 120; process = 'fake'; pid = 1; class = 'fake' }
}
function Get-Windows($parameters, $Clock = $null) {
    if ($script:realListing) { return & $realGetWindows $parameters -Clock $Clock }
    $script:now += $script:listMs
    Check ($parameters.filter -ceq 'fake TITLE') 'Title poll did not pass the ui_windows filter unchanged.'
    Assert-TreeBudget $Clock
    return @{ windows = $script:listing; cut = $script:listingCut; incomplete = $script:listingCut }
}
function New-Element([string] $name = 'item', [string] $role = 'ListItem', $parent = $null) {
    $element = New-Object System.Windows.Automation.AutomationElement
    $element.Parent = $parent
    $element.Properties['Handle'] = 0
    $element.Properties['Name'] = $name
    $element.Properties['Type'] = New-Object System.Windows.Automation.ControlType $role
    $element.Properties['AutomationId'] = 'id-' + $name
    $element.Properties['Enabled'] = $true
    $element.Properties['Offscreen'] = $false
    $element.Properties['Password'] = $true
    $element.Properties['ValueAvailable'] = $false
    $element.Properties['TextAvailable'] = $false
    $element.Properties['ToggleAvailable'] = $false
    return $element
}
function Reset {
    $script:now = 0L; $script:readMs = 0; $script:shown = 0; $script:mouse = 0; $script:actionChecks = 0
    $script:failWindow = $false; $script:listMs = 0
    $script:realListing = $false; $script:metadataReads = 0; $script:failAfterReads = -1
    [System.Windows.Automation.ScrollPattern]::CallerThread = [Threading.Thread]::CurrentThread.ManagedThreadId
    [System.Windows.Automation.ScrollPattern]::Release.Reset() | Out-Null
    $script:patternReads = New-Object 'System.Collections.Generic.List[string]'
    $script:walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    [OwnedUia.Native]::Exists = $true
    [System.Windows.Automation.VirtualizedItemPattern]::Calls.Clear()
    $root = New-Element root Window
    [System.Windows.Automation.AutomationElement]::Root = $root
    $script:window = [pscustomobject]@{ Ref = '123'; Handle = [IntPtr]::new(123); Root = $root; Refs = @{ e1 = $root };
        Screenshot = @{ id = 'old-image' }; Identity = @{ Pid = $PID; Started = 1L } }
    $script:nextElement = 1
    $script:windowMap = @{}
    $script:listing = @(@{ window = '123' }); $script:listingCut = $false
}
# Each reviewer regression runs independently against production functions and the typed worker.
if ($Case -ne 'baseline') {
    Reset
    switch ($Case) {
        'placeholder-observation' {
            $item = New-Element Needle ListItem $window.Root
            $container = New-Object System.Windows.Automation.ItemContainerPattern
            $container.Items = @($item); $container.Ephemeral = $true
            $window.Root.Patterns['container'] = $container
            $result = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; treeDensityThreshold = 0 }) -Find
            Check ($container.Starts.Count -eq 2 -and $result.nodes -eq 1) 'Finding 1: consume a placeholder before the next lookup invalidates it.'
            Check ($result.text.Contains('virtualized=true')) 'Finding 1: preserve virtualized metadata before advancing.'
        }
        'placeholder-action' {
            $item = New-Element Needle ListItem $window.Root
            $item.RuntimeId = @(1)
            $container = New-Object System.Windows.Automation.ItemContainerPattern
            $container.Items = @($item); $container.Ephemeral = $true
            $window.Root.Patterns['container'] = $container
            $found = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; maxResults = 1; treeDensityThreshold = 0 }) -Find
            $ref = [regex]::Match($found.text, 'e\d+').Value
            $old = $window.Refs[$ref]
            $result = Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true })
            Check ($old.Broken -and $result.steps[0] -eq 'VirtualizedItemPattern.Realize') 'Finding 1: realize a newly reacquired placeholder, never the invalidated original.'
        }
        'placeholder-identity' {
            $first = New-Element Needle ListItem $window.Root
            $second = New-Element Needle ListItem $window.Root
            $first.RuntimeId = @(11); $second.RuntimeId = @(22)
            $container = New-Object System.Windows.Automation.ItemContainerPattern
            $container.Items = @($first, $second); $container.Ephemeral = $true
            $window.Root.Patterns['container'] = $container
            $found = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; treeDensityThreshold = 0 }) -Find
            $refs = @([regex]::Matches($found.text, 'e\d+') | ForEach-Object { $_.Value })
            Check ($refs.Count -eq 2) 'Finding 1: all ephemeral observations must survive enumeration.'
            $result = Invoke-OwnedScroll ([pscustomobject]@{ ref = $refs[1]; into = $true })
            Check ($window.Refs[$refs[1]].RuntimeId[0] -eq 22) 'Finding 1: reacquisition must realize the intended runtime ID, not the first name match.'
            [System.Windows.Automation.VirtualizedItemPattern]::Calls.Clear()
            $first.RuntimeId = $null; $second.RuntimeId = $null
            $window.Refs.e1 = $window.Root
            $found = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; treeDensityThreshold = 0 }) -Find
            $ref = [regex]::Match($found.text, 'e\d+').Value
            Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } 'Finding 1: opaque duplicate matches must fail closed.'
            Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'Finding 1: ambiguous reacquisition dispatched Realize.'
        }
        'placeholder-replacement' {
            foreach ($key in @('name', 'automationId')) {
                Reset
                $observed = New-Element Needle ListItem $window.Root
                $container = New-Object System.Windows.Automation.ItemContainerPattern
                $observed.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
                $container.Items = @($observed)
                $window.Root.Patterns['container'] = $container
                $query = @{ root = 'e1'; maxResults = 1; treeDensityThreshold = 0 }
                $query[$key] = 'Needle'
                if ($key -eq 'automationId') { $query[$key] = 'id-Needle' }
                $found = Get-OwnedTree ([pscustomobject]$query) -Find
                $ref = [regex]::Match($found.text, 'e\d+').Value
                $replacement = New-Element Needle ListItem $window.Root
                $pattern = New-Object System.Windows.Automation.VirtualizedItemPattern
                $pattern.Element = $replacement
                $replacement.Patterns['realize'] = $pattern
                $observed.Broken = $true
                $container.Items = @($replacement)
                $lookups = $container.Starts.Count
                $failure = $null
                try { $null = Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) }
                catch { $failure = $_.Exception.Message }
                Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'A unique replacement with the same property must never be realized.'
                Check ([object]::ReferenceEquals($window.Refs[$ref], $observed)) 'An opaque ref must never be rebound to a replacement.'
                Check ($container.Starts.Count -eq $lookups) 'An opaque ref must not perform property-based reacquisition.'
                Check ($null -ne $failure -and $failure.Contains('ui_find') -and $failure.Contains('fresh ref')) 'Refusal must tell the model to run ui_find again and act on the fresh ref.'
                # The typed worker must also fail closed if its caller bypasses the early refusal.
                $identity = New-Object 'OwnedUia.PatternCall+ItemReference'
                $identity.Container = $window.Root; $identity.Property = $key; $identity.Value = $query[$key]
                $call = [OwnedUia.PatternCall]::Run($null, 'realize', '', $observed, $window.Root,
                    $window.Handle, $PID, 1L, $identity)
                Check ($call.Completed -and $call.Failed -and $container.Starts.Count -eq $lookups) 'The worker must reject missing runtime IDs before any property lookup.'
                Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'The worker must never realize a replacement for an opaque ref.'
            }
        }
        'title-suffix' {
            $script:realListing = $true
            $native = New-Object OwnedUia.Native+FakeWindow
            $native.Title = ('x' * 140) + 'Needle'
            [OwnedUia.Native]::Listing = @($native)
            $listing = Get-Windows ([pscustomobject]@{ filter = 'Needle' })
            Check ($listing.windows.Count -eq 1 -and $listing.cut -and -not $listing.incomplete) 'Title matching must include a suffix after display character 120.'
            Check (-not $listing.windows[0].title.Contains('Needle')) 'The matching suffix should be outside the displayed title.'
            $result = Get-WaitPoll ([pscustomobject]@{ title = 'Needle' })
            Check ($result.found -and $result.window -eq '123') 'Window existence polling must find a title suffix after character 120.'
            $result = Get-WaitPoll ([pscustomobject]@{ title = 'Needle'; name = 'Loading'; publish = $false })
            Check (-not $result.found -and -not $result.cut) 'Suffix-targeted element absence must remain provable despite display truncation.'
        }
        'shared-failed-budget' {
            $children = @(); for ($i = 0; $i -lt 700; $i++) { $children += New-Element other Button $window.Root }
            $window.Root.Children = $children
            $second = $window.PSObject.Copy(); $second.Ref = '124'; $second.Handle = [IntPtr]::new(124)
            $second.Root = New-Element root Window
            $second.Root.Children = @(); for ($i = 0; $i -lt 1100; $i++) { $second.Root.Children += New-Element other Button $second.Root }
            $script:windowMap['124'] = $second
            $script:listing = @(@{ window = '123' }, @{ window = '124' })
            $script:failAfterReads = 600
            $result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE'; name = 'missing'; maxVisited = 1000 })
            Check ($script:metadataReads -eq 1000 -and $result.cut -and -not $result.found) ('Finding 3: failed candidates must share node consumption; reads=' + $script:metadataReads)
        }
        'display-truncation' {
            $script:realListing = $true
            $native = New-Object OwnedUia.Native+FakeWindow
            $native.Title = 'fake TITLE ' + ('long ' * 40)
            [OwnedUia.Native]::Listing = @($native)
            $listing = Get-Windows ([pscustomobject]@{ filter = 'fake TITLE' })
            Check $listing.cut 'Finding 4: ui_windows must still report display truncation.'
            $result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE'; name = 'Loading'; publish = $false })
            Check (-not $result.found -and -not $result.cut) 'Finding 4: shortened titles must not prevent proving complete element absence.'
            $natives = @()
            for ($i = 0; $i -lt 201; $i++) {
                $native = New-Object OwnedUia.Native+FakeWindow
                $native.Handle = [IntPtr]::new(123 + $i); $native.Title = 'fake TITLE'
                $natives += $native
            }
            [OwnedUia.Native]::Listing = $natives
            $listing = Get-Windows ([pscustomobject]@{ filter = 'fake TITLE' })
            Check ($listing.incomplete -and $listing.cut -and $listing.windows.Count -eq 200) 'Finding 4: enumeration caps must remain incomplete, unlike display truncation.'
            $native = New-Object OwnedUia.Native+FakeWindow
            $native.Title = ('x' * 4095) + 'Needle'
            [OwnedUia.Native]::Listing = @($native)
            $result = Get-WaitPoll ([pscustomobject]@{ title = 'Needle'; publish = $false })
            Check (-not $result.found -and $result.cut) 'Finding 4: native filter-buffer truncation cannot prove a title is gone.'
        }
        'exact-property-unavailable' {
            foreach ($key in @('Name', 'AutomationId')) {
                Reset
                $item = New-Element Needle ListItem $window.Root
                $item.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
                # The provider's lookup knows its own data even when the getter is unavailable.
                $container = New-Object System.Windows.Automation.ItemContainerPattern
                $container.Items = @($item)
                $window.Root.Patterns['container'] = $container
                $null = $item.Unavailable.Add($key)
                $query = @{ root = 'e1'; treeDensityThreshold = 0 }
                $queryKey = 'name'; $value = 'Needle'
                if ($key -eq 'AutomationId') { $queryKey = 'automationId'; $value = 'id-Needle' }
                $query[$queryKey] = $value
                $result = Get-OwnedTree ([pscustomobject]$query) -Find
                Check ($result.nodes -eq 1) ('Finding 5: exact lookup proves its selected predicate despite an unavailable ' + $key + ' getter.')
                if ($key -eq 'Name') {
                    $window.Refs.e1 = $window.Root
                    $query.automationId = 'id-Needle'
                    $result = Get-OwnedTree ([pscustomobject]$query) -Find
                    Check ($result.nodes -eq 0) 'Finding 5: an additional unreadable Name filter must not be inferred from an AutomationId lookup.'
                    $null = $query.Remove('automationId')
                    $null = $item.Unavailable.Add('Type')
                    foreach ($role in @('ListItem', 'Unknown')) {
                        $window.Refs.e1 = $window.Root; $query.role = $role
                        $result = Get-OwnedTree ([pscustomobject]$query) -Find
                        Check ($result.nodes -eq 0) 'Finding 5: an unknown additional role must fail closed, including Unknown.'
                    }
                }
            }
        }
        'bounded-vertical-getter' {
            $scroll = New-Object System.Windows.Automation.ScrollPattern
            $scroll.GuardCaller = $true
            $window.Root.Patterns['scroll'] = $scroll
            $result = Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e1'; delta = 1 })
            Check ($scroll.Calls.Count -eq 1) 'Vertical getter must run only on the bounded worker.'
            $scroll.BlockGetter = $true
            $watch = [Diagnostics.Stopwatch]::StartNew()
            try {
                $result = Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e1'; delta = 1 })
                Check ($result.ContainsKey('instruction') -and $watch.ElapsedMilliseconds -lt 7000) 'A blocked vertical getter must respect the five-second action wait.'
            } finally { [System.Windows.Automation.ScrollPattern]::Release.Set() | Out-Null }
            [Threading.Thread]::Sleep(30)
            Check ($scroll.Calls.Count -eq 1) 'Timed-out preflight must not scroll after the getter unblocks.'
        }
        default { throw ('Unknown regression: ' + $Case) }
    }
    Assert-NoUia
    'Offline reviewer regression passed: ' + $Case
    return
}
# The unchanged typed PatternCall dispatches against fakes only, with real ancestry
# control flow and a real background worker. No native/UIA methods are loaded.
Reset
$scroll = New-Object System.Windows.Automation.ScrollPattern
$window.Root.Patterns['scroll'] = $scroll
$result = Invoke-OwnedScroll ([pscustomobject]@{ window = '123'; ref = 'e1'; delta = 3 })
Check ($result.path -eq 'scrollpattern' -and $result.verticalPercent -eq 47 -and $result.ancestor -eq 0) 'Scroll result must report pattern path, ancestor and percent.'
Check (($scroll.Calls -join ',') -eq 'SmallDecrement,SmallDecrement,SmallDecrement') 'Positive delta must repeat small decrements.'
$result = Invoke-OwnedScroll ([pscustomobject]@{ window = '123'; ref = 'e1'; delta = -2 })
Check ($result.verticalPercent -eq 49 -and $scroll.Calls[3] -eq 'SmallIncrement') 'Negative delta must increment.'
Check ($script:mouse -eq 0) 'Pattern scroll used the mouse.'
# Exactly five ancestor edges may be searched; root must never be escaped.
Reset
$parent = $window.Root
for ($i = 0; $i -lt 5; $i++) { $parent = New-Element child ListItem $parent }
$window.Refs.e1 = $parent
$window.Root.Patterns['scroll'] = New-Object System.Windows.Automation.ScrollPattern
$target = Get-ScrollPattern $window $parent
Check ($target.Ancestor -eq 5) 'Fifth parent must be allowed.'
$window.Refs.e1 = New-Element child ListItem $parent
Refused { Get-ScrollPattern $window $window.Refs.e1 } 'Sixth parent must not be searched.'
$window.Root.Patterns['scroll'].VerticallyScrollable = $false
Refused { Invoke-BoundedPattern $window $parent $window.Root.Patterns['scroll'] 'scroll' 'scrollpattern' '1' } 'Non-vertically-scrollable patterns must not be used.'
$foreign = New-Element foreign
$foreign.Patterns['scroll'] = New-Object System.Windows.Automation.ScrollPattern
$window.Root.Parent = $foreign
$window.Root.Patterns.Clear()
Refused { Get-ScrollPattern $window $window.Root } 'Search must stop at target root, even if a foreign parent scrolls.'
Reset
$inner = New-Element inner ListItem $window.Root
$inner.Patterns['scroll'] = New-Object System.Windows.Automation.ScrollPattern
$inner.Patterns['scroll'].VerticallyScrollable = $false
$window.Root.Patterns['scroll'] = New-Object System.Windows.Automation.ScrollPattern
$window.Refs.e2 = $inner
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e2'; delta = 1 }) } 'Horizontal-only nearest container must not scroll an outer vertical container.'
Check ($window.Root.Patterns['scroll'].Calls.Count -eq 0) 'Outer container received input.'
# Invalid/mixed/null forms are rejected before any input.
Reset
foreach ($json in @(
    '{"ref":"e1","delta":1,"x":1}', '{"ref":"e1","into":true,"delta":1}',
    '{"ref":"e1","into":false}', '{"ref":"e1","into":"true"}', '{"ref":"e1"}',
    '{"ref":null,"delta":1}', '{"ref":"e1","delta":0}', '{"ref":"e1","delta":11}',
    '{"ref":"e1","delta":1.5}', '{"ref":"e1","delta":null}', '{"delta":1}',
    '{"screenshot":"id","x":1,"y":1,"delta":1,"into":true}'
)) { Refused { Invoke-OwnedScroll ($json | ConvertFrom-Json) } ('Invalid scroll form accepted: ' + $json) }
Check ($script:shown -eq 0 -and $script:mouse -eq 0) 'Invalid scroll forms dispatched input.'
$result = Invoke-OwnedScroll ([pscustomobject]@{ screenshot = 'id'; x = 1; y = 1; delta = 1 })
Check ($result.path -eq 'fake-coordinate' -and $script:mouse -eq 1) 'Coordinate form must retain its guarded input path.'
Reset
$window.Root.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
$window.Root.Patterns['scrollIntoView'] = New-Object System.Windows.Automation.ScrollItemPattern
$result = Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e1'; into = $true })
Check (([System.Windows.Automation.VirtualizedItemPattern]::Calls -join ',') -eq 'realize,scrollIntoView') 'Realize must precede ScrollIntoView.'
Check (($result.steps -join ',') -eq 'VirtualizedItemPattern.Realize,ScrollItemPattern.ScrollIntoView') 'Into result omitted its steps.'
Check ($script:mouse -eq 0 -and $result.path -eq 'scrollitem') 'Into used the mouse or omitted its scrollitem path.'
$window.Root.Patterns.Clear()
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e1'; into = $true }) } 'Unsupported into must fail, not use mouse.'
# Exact ItemContainer lookup must advance startAfter and preserve provider ordering;
# raw substring search still runs, filters still AND, duplicates get no second ref.
Reset
$a = New-Element Needle ListItem $window.Root
$b = New-Element Needle Button $window.Root
$c = New-Element Needle ListItem $window.Root
$d = New-Element 'prefix Needle suffix' ListItem $window.Root
$a.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
$container = New-Object System.Windows.Automation.ItemContainerPattern
$container.Items = @($a, $b, $c)
$window.Root.Patterns['container'] = $container
$window.Root.Children = @($a, $b, $c, $d)
$result = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; role = 'ListItem'; maxResults = 10; treeDensityThreshold = 0 }) -Find
Check ($result.nodes -eq 3 -and $window.Refs.Count -eq 3 -and -not $window.Refs.ContainsKey('e1')) ('Find did not replace generation or apply AND/deduplication: ' + ($result | ConvertTo-Json -Compress))
$rows = @($result.text -split "`n" | Where-Object { $_ -match '^\s*e\d+ ' })
Check ($rows[0].Contains('virtualized=true') -and -not $rows[1].Contains('virtualized=true') -and -not $rows[2].Contains('virtualized=true')) 'Only items supporting VirtualizedItemPattern may be flagged virtualized.'
$firstRef = [regex]::Match($rows[0], 'e\d+').Value
$secondRef = [regex]::Match($rows[1], 'e\d+').Value
Check ([object]::ReferenceEquals($window.Refs[$firstRef], $a) -and [object]::ReferenceEquals($window.Refs[$secondRef], $c)) 'Container provider order changed.'
Check ($container.Starts.Count -eq 4 -and $null -eq $container.Starts[0] -and [object]::ReferenceEquals($container.Starts[1], $a)) 'startAfter was not advanced.'
Check ($container.Property -eq 'Name' -and $container.Value -ceq 'Needle') 'Container lookup must use exact Name.'
Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0 -and $script:shown -eq 0) 'Find dispatched an action.'
Reset
$placeholder = New-Element Needle ListItem $window.Root
$placeholder.RuntimeId = @(1)
$placeholder.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
foreach ($key in @('Type', 'Enabled', 'Offscreen', 'Password')) { $null = $placeholder.Properties.Remove($key) }
$container = New-Object System.Windows.Automation.ItemContainerPattern
$container.Items = @($placeholder)
$window.Root.Patterns['container'] = $container
$result = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; automationId = 'id-Needle'; maxResults = 1; treeDensityThreshold = 0 }) -Find
Check ($result.nodes -eq 1 -and $result.text.Contains('virtualized=true')) 'Placeholder must survive unavailable optional metadata.'
Check ($container.Property -eq 'AutomationId' -and $container.Starts.Count -eq 1) 'Exact AutomationId lookup must respect maxResults.'
# A genuine placeholder can reject identity properties until Realize. Only a
# same-generation ItemContainer result gets its verified source-container anchor.
$ref = [regex]::Match($result.text, 'e\d+').Value
$null = $placeholder.Properties.Remove('Handle')
$virtual = New-Object System.Windows.Automation.VirtualizedItemPattern
$virtual.Element = $placeholder
$placeholder.Patterns['realize'] = $virtual
$placeholder.Patterns['scrollIntoView'] = New-Object System.Windows.Automation.ScrollItemPattern
$result = Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true })
Check (($result.steps -join ',') -eq 'VirtualizedItemPattern.Realize,ScrollItemPattern.ScrollIntoView') 'Provider-produced placeholder could not be realized via its verified source container.'
Check ($placeholder.Properties.ContainsKey('Handle')) 'Placeholder was not realized before target ancestry was checked.'
$null = $placeholder.Properties.Remove('Handle')
$window.VirtualRefs.Clear()
$failed = $false
try { $null = Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } catch { $failed = $true }
Check $failed 'An unanchored placeholder must not bypass ancestry validation.'
# Current container membership is rechecked on the bounded worker, not just at find time.
Reset
$placeholder = New-Element Needle ListItem $window.Root
$placeholder.RuntimeId = @(1)
$virtual = New-Object System.Windows.Automation.VirtualizedItemPattern
$virtual.Element = $placeholder
$placeholder.Patterns['realize'] = $virtual
$placeholder.Patterns['scrollIntoView'] = New-Object System.Windows.Automation.ScrollItemPattern
$container = New-Object System.Windows.Automation.ItemContainerPattern
$container.Items = @($placeholder)
$window.Root.Patterns['container'] = $container
$window.Root.Patterns['scroll'] = New-Object System.Windows.Automation.ScrollPattern
$found = Get-OwnedTree ([pscustomobject]@{ root = 'e1'; name = 'Needle'; maxResults = 1; treeDensityThreshold = 0 }) -Find
$ref = [regex]::Match($found.text, 'e\d+').Value
$null = $placeholder.Properties.Remove('Handle')
$container.Items = @()
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } 'A stale container membership must not authorize Realize.'
Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'Stale membership dispatched Realize.'
$container.Items = @($placeholder)
$result = Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true })
Check ($result.path -eq 'scrollitem' -and $result.verticalPercent -eq 50) 'Into must report scrollitem and the containing VerticalScrollPercent when available.'
[System.Windows.Automation.VirtualizedItemPattern]::Calls.Clear()
$foreign = New-Element foreign
$placeholder.Parent = $foreign
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } 'Known foreign ancestry must fail before Realize.'
Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'Foreign item dispatched Realize.'
$placeholder.Parent = $window.Root
$source = New-Element source ListItem $foreign
$window.VirtualRefs[$ref].Container = $source
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } 'A foreign source container must not authorize Realize.'
Check ([System.Windows.Automation.VirtualizedItemPattern]::Calls.Count -eq 0) 'Foreign container dispatched Realize.'
$window.VirtualRefs[$ref].Container = $window.Root
$null = $placeholder.Properties.Remove('Handle')
$virtual.MoveAfter = $true
$virtual.ParentAfter = $foreign
Refused { Invoke-OwnedScroll ([pscustomobject]@{ ref = $ref; into = $true }) } 'Realize must not authorize ScrollIntoView after an item moves foreign.'
Check (([System.Windows.Automation.VirtualizedItemPattern]::Calls -join ',') -eq 'realize') 'Foreign realized item received ScrollIntoView.'
# Stop the into pipeline immediately when realization times out. This stub only
# simulates timeout reporting; all successful action dispatch above used the real worker.
Reset
$realBounded = (Get-Command Invoke-BoundedPattern).ScriptBlock
$window.Root.Patterns['realize'] = New-Object System.Windows.Automation.VirtualizedItemPattern
$window.Root.Patterns['scrollIntoView'] = New-Object System.Windows.Automation.ScrollItemPattern
$script:dispatches = New-Object 'System.Collections.Generic.List[string]'
function Invoke-BoundedPattern($window, $element, $pattern, $action, $path, $text, $Virtual) {
    $script:dispatches.Add($action)
    return @{ path = $path; instruction = 'fake timeout' }
}
$result = Invoke-OwnedScroll ([pscustomobject]@{ ref = 'e1'; into = $true })
Check (($script:dispatches -join ',') -eq 'realize' -and $result.steps.Count -eq 1 -and $result.path -eq 'scrollitem' -and $script:mouse -eq 0) 'Timed-out Realize must not dispatch ScrollIntoView or mouse fallback.'
Set-Item Function:Invoke-BoundedPattern $realBounded
# One cheap poll: no retries, sleeps, value/text/pattern actions, capture or focus.
Reset
$child = New-Element Needle Button $window.Root
$child.Properties['Password'] = $false
$child.Properties['ValueAvailable'] = $true
$child.Properties['TextAvailable'] = $true
$window.Root.Children = @($child)
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'Needle'; role = 'Button'; publish = $true })
Check ($result.found -and $result.element.nodes -eq 1 -and $result.element.text.Contains('Needle')) 'Exists poll must return a TreeResult.'
Check ($window.Refs.Count -eq 1 -and -not $window.Refs.ContainsKey('e1') -and $null -eq $window.Screenshot) 'Found exists poll must publish fresh refs and retire screenshots.'
Check ($script:patternReads.Count -eq 0 -and $script:actionChecks -eq 0 -and $script:shown -eq 0) 'Poll read an action/value/text pattern or dispatched input.'
Reset
$window.Root.Children = @((New-Element Needle Button $window.Root))
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'Needle'; publish = $false })
Check ($result.found -and -not $result.ContainsKey('element') -and $window.Refs.ContainsKey('e1') -and $window.Screenshot.id -eq 'old-image') 'Gone poll must not publish/retire refs or screenshots.'
Reset
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing' })
Check (-not $result.found -and -not $result.cut -and $window.Refs.ContainsKey('e1')) 'Complete missing element poll must preserve refs and report absence.'
[OwnedUia.Native]::Exists = $false
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'Needle' })
Check (-not $result.found -and -not $result.cut) 'Missing window in element mode must return found:false.'
$result = Get-WaitPoll ([pscustomobject]@{ window = '123' })
Check (-not $result.found -and -not $result.cut) 'Handle-only missing window must return found:false.'
Reset
$result = Get-WaitPoll ([pscustomobject]@{ window = '123' })
Check ($result.found -and $result.window -eq '123') 'Handle-only window existence failed.'
$result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE' })
Check ($result.found -and $result.window -eq '123') 'Title poll must use window-list filter.'
$script:listing = @(); $script:listingCut = $true
$result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE' })
Check (-not $result.found -and $result.cut) 'Incomplete title listing must not prove absence.'
foreach ($json in @('{"window":"123","title":"fake"}', '{}', '{"window":"0"}', '{"title":""}',
    '{"window":"123","name":""}', '{"window":"123","role":"ControlType.Button"}',
    '{"window":"123","publish":"false"}', '{"window":"123","budgetMs":1001}', '{"window":"123","budgetMs":0}')) {
    Refused { Get-WaitPoll ($json | ConvertFrom-Json) } ('Invalid wait poll accepted: ' + $json)
}
# Expiration before title enumeration must remain an incomplete poll, not a tool error.
Reset
$script:listMs = 2
$result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE'; budgetMs = 1 })
Check (-not $result.found -and $result.cut) 'Title enumeration deadline escaped the poll boundary.'
# Title queries may match several windows; search them within one shared deadline
# and visited-node allowance, publishing only the window that actually matches.
Reset
$second = $window.PSObject.Copy()
$second.Ref = '124'; $second.Handle = [IntPtr]::new(124)
$second.Root = New-Element Needle Button
$second.Refs = @{ e99 = $second.Root }
$script:windowMap['124'] = $second
$script:listing = @(@{ window = '123' }, @{ window = '124' })
$result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE'; name = 'Needle' })
Check ($result.found -and $result.window -eq '124' -and $result.element.nodes -eq 1) 'Title element poll ignored a later matching window.'
Check ($window.Refs.ContainsKey('e1') -and -not $second.Refs.ContainsKey('e99')) 'Title poll published refs to the wrong window.'
$result = Get-WaitPoll ([pscustomobject]@{ title = 'fake TITLE'; name = 'Needle'; maxVisited = 1 })
Check (-not $result.found -and $result.cut) 'Title candidates did not share the visited-node allowance.'
# Budget, visited, depth and provider failures must all report cut, not false gone.
Reset
$window.Root.Children = @((New-Element other Button $window.Root))
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing'; maxVisited = 1 })
Check (-not $result.found -and $result.cut) 'Node-limited traversal falsely proved gone.'
Reset
$script:readMs = 25
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing'; budgetMs = 10 })
Check (-not $result.found -and $result.cut -and $script:now -eq 25) 'Deadline overrun must stop subsequent traversal and report cut.'
Reset
$window.Root.Broken = $true
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing' })
Check (-not $result.found -and $result.cut) 'Unreadable provider falsely proved gone.'
Reset
$script:failWindow = $true
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing' })
Check (-not $result.found -and $result.cut -and $window.Refs.ContainsKey('e1')) 'Window disappearing mid-query must return an incomplete poll, not throw or publish refs.'
Reset
$parent = $window.Root
for ($i = 0; $i -lt 31; $i++) {
    $child = New-Element other Button $parent
    $parent.Children = @($child)
    $parent = $child
}
$result = Get-WaitPoll ([pscustomobject]@{ window = '123'; name = 'missing' })
Check (-not $result.found -and $result.cut) 'Depth-limited traversal falsely proved gone.'
Assert-NoUia
'Offline U2 regressions passed (scroll/into dispatch, ancestry, virtualized find and bounded wait polls).'
