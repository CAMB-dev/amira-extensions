# Windows PowerShell 5.1; any-window UIA, no shipped binaries.
# stdin/stdout are UTF-8 JSON lines. Kill eligibility comes only from launch identities.
[CmdletBinding()]
param(
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted,
    [string] $StatePath,
    [int] $AmiraPid = 0,
    [ValidateSet('true', 'false')]
    [string] $Overlay = 'true',
    [switch] $TestMode
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
# Console.In can be a synchronous TextReader in .NET Framework. Use a separate
# StreamReader so ReadLineAsync does not block the lifetime-process polling loop.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8, 4096, $true)
$writer.AutoFlush = $true
$script:windows = @{}
$script:processes = @{}
$script:jobs = @{}
$script:receivedJobAcks = @{}
$script:requestedJobs = [Collections.Hashtable]::new([StringComparer]::Ordinal)
$script:nextElement = 0
$script:self = $null
$script:lifetime = $null
$script:stopping = $false
$script:pendingRead = $null
$script:queuedLines = New-Object System.Collections.Generic.Queue[string]
$script:amiraProcesses = @{}
$script:overlayClass = ''
$script:overlayPid = 0

# Both the action handshake and request loop share this one outstanding read.
function Get-PendingRead {
    if ($null -eq $script:pendingRead) { $script:pendingRead = $reader.ReadLineAsync() }
    return $script:pendingRead
}

function Receive-PendingLine {
    $pending = Get-PendingRead
    $line = $pending.GetAwaiter().GetResult()
    $script:pendingRead = $null
    return $line
}

function Deny([string] $message) {
    # Never expose raw provider exceptions or process paths.
    throw [System.InvalidOperationException]::new('UIA_SAFE: ' + $message)
}

function Get-Argument($object, [string] $name, $default = $null) {
    # Preserve JSON arrays (including zero/one-item args) across pipeline output.
    if ($null -eq $object) { return ,$default }
    $property = $object.PSObject.Properties[$name]
    if ($null -eq $property) { return ,$default }
    return ,$property.Value
}

function Get-Identity([int] $processId) {
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById($processId)
        # Open/cache the handle before reading StartTime. Do not trust a PID alone.
        $null = $process.Handle
        $started = [OwnedUia.LaunchGuard]::CreationTime($process.Handle)
        if ($process.HasExited) { return $null }
        return [pscustomobject]@{
            Pid = $processId
            Started = $started
            Key = ('{0}:{1}' -f $processId, $started)
        }
    } catch { return $null }
    finally { if ($null -ne $process) { $process.Dispose() } }
}

function Test-Identity($identity) {
    if ($null -eq $identity) { return $false }
    $current = Get-Identity $identity.Pid
    return ($null -ne $current -and $current.Started -eq $identity.Started)
}

function Test-IdentityGone($identity) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$identity.Pid)
        $null = $process.Handle
        return ($process.HasExited -or [OwnedUia.LaunchGuard]::CreationTime($process.Handle) -ne [long]$identity.Started)
    } catch [ArgumentException] { return $true }
    catch { return $false } # Inaccessible is not proof that an owned process exited.
    finally { if ($null -ne $process) { $process.Dispose() } }
}

function Assert-Lifetime {
    if ($null -ne $script:lifetime -and -not (Test-Identity $script:lifetime)) {
        $script:stopping = $true
        Deny 'Lifetime process exited.'
    }
}

# The watchdog and independent custody owner, not a transient helper, own session cleanup.
# Restart only reloads this client's authenticated records; it never kills apps or scans other journals.
function Save-OwnedState {
    if ([string]::IsNullOrEmpty($StatePath)) { return }
    $records = @($script:processes.Values | ForEach-Object {
        @{ Pid = $_.Pid; Started = $_.Started.ToString() }
    })
    Write-OwnedJournal $StatePath @{
        OwnershipVersion = 3
        Helper = @{ Pid = $script:self.Pid; Started = $script:self.Started.ToString() }
        Processes = $records
        Jobs = @($script:jobs.Keys)
    }
}

try {
    . "$PSScriptRoot/journal.ps1"
    $script:journalKey = Read-JournalKey $reader
    . "$PSScriptRoot/launch.ps1"
    $script:self = Get-Identity $PID
    if ($LifetimePid -lt 0) { Deny 'Invalid lifetime process.' }
    if ($LifetimePid -gt 0) {
        $script:lifetime = Get-Identity $LifetimePid
        if ($null -eq $script:lifetime -or $LifetimePid -eq $PID -or
            $script:lifetime.Started.ToString() -ne $LifetimeStarted) {
            Deny 'Lifetime process is unavailable or its identity changed.'
        }
    }
    # Complete the PID-bound writer handoff before ANY journal write. Startup may
    # die during Add-Type/provider/DPI initialization without stranding owned jobs.
    $writer.WriteLine((@{ event = 'helper'; pid = $script:self.Pid; started = $script:self.Started.ToString() } | ConvertTo-Json -Compress))
    $handoff = $false
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt 5000) {
        $pending = Get-PendingRead
        if (-not $pending.Wait(25)) { continue }
        $line = Receive-PendingLine
        if ($null -eq $line) { Deny 'Session input closed during writer handoff.' }
        $message = $line | ConvertFrom-Json
        if ((Get-Argument $message 'method') -ceq 'writer_ack') { $handoff = $true; break }
        $script:queuedLines.Enqueue($line)
    }
    if (-not $handoff) { Deny 'Writer handoff timed out; journal unchanged.' }
    $previous = $null
    if (-not [string]::IsNullOrEmpty($StatePath) -and [IO.File]::Exists($StatePath)) {
        try { $previous = Read-OwnedJournal $StatePath }
        catch { [Console]::Error.WriteLine('untrusted launch journal; cleanup refused; records ignored') }
    }
    if ($null -ne $previous) {
        # The client awaits the old helper's exit before starting a replacement.
        if (-not (Test-IdentityGone $previous.Helper)) { Deny 'Previous helper is still active; journal retained.' }
        foreach ($identity in $previous.Processes) {
            $record = [pscustomobject]@{
                Pid = [int]$identity.Pid; Started = [long]$identity.Started
                Key = ('{0}:{1}' -f $identity.Pid, $identity.Started)
            }
            $script:processes[$record.Key] = $record
        }
        foreach ($name in $previous.Jobs) {
            # Opaque IDs only; the watchdog retains the original unnamed kernel jobs.
            $script:jobs[$name] = $null
        }
    }
    Save-OwnedState

    Add-Type -AssemblyName UIAutomationClient | Out-Null
    Add-Type -AssemblyName UIAutomationTypes | Out-Null
    Add-Type -AssemblyName UIAutomationClientsideProviders | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null
    Add-Type -ReferencedAssemblies @('System.dll', 'System.Drawing.dll', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.AutomationProperty].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OwnedUia {
    public sealed class PatternCall {
        static int active;
        int dispatchState; // 0 pending, 1 dispatched, 2 cancelled; timeout and dispatch have one winner.
        public bool Completed { get; private set; }
        public bool Failed { get; private set; }
        public double? VerticalScrollPercent { get; private set; }
        public System.Windows.Automation.AutomationElement Element { get; private set; }
        public sealed class ItemReference {
            public System.Windows.Automation.AutomationElement Container;
            public string Property, Value, Name, Role, AutomationId;
            public int[] RuntimeId;
        }
        static bool SameRuntimeId(int[] first, int[] second) {
            if (first == null || second == null || first.Length != second.Length) return false;
            for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) return false;
            return true;
        }
        static System.Windows.Automation.AutomationElement Reacquire(ItemReference reference) {
            // Property equality (even uniqueness) cannot establish continuity
            // with an observed placeholder. Never look up an opaque replacement.
            if (reference.RuntimeId == null || reference.RuntimeId.Length == 0) throw new InvalidOperationException();
            object containerPattern;
            if (!reference.Container.TryGetCurrentPattern(System.Windows.Automation.ItemContainerPattern.Pattern,
                out containerPattern)) throw new InvalidOperationException();
            var container = (System.Windows.Automation.ItemContainerPattern)containerPattern;
            var property = reference.Property == "automationId" ?
                System.Windows.Automation.AutomationElement.AutomationIdProperty :
                System.Windows.Automation.AutomationElement.NameProperty;
            var current = container.FindItemByProperty(null, property, reference.Value);
            for (int i = 0; current != null && i < 100; i++) {
                if (SameRuntimeId(current.GetRuntimeId(), reference.RuntimeId)) return current;
                current = container.FindItemByProperty(current, property, reference.Value);
            }
            throw new InvalidOperationException();
        }
        static bool MatchesAdditionalFilters(System.Windows.Automation.AutomationElement element, ItemReference reference) {
            if (reference.Property != "name" && !String.IsNullOrEmpty(reference.Name)) {
                var name = element.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.NameProperty, true) as string;
                if (name == null || name.IndexOf(reference.Name, StringComparison.OrdinalIgnoreCase) < 0) return false;
            }
            if (reference.Property != "automationId" && !String.IsNullOrEmpty(reference.AutomationId)) {
                var id = element.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.AutomationIdProperty, true) as string;
                if (id == null || id.IndexOf(reference.AutomationId, StringComparison.OrdinalIgnoreCase) < 0) return false;
            }
            if (!String.IsNullOrEmpty(reference.Role)) {
                var type = element.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.ControlTypeProperty, true)
                    as System.Windows.Automation.ControlType;
                if (type == null || !String.Equals(type.ProgrammaticName.Replace("ControlType.", ""), reference.Role,
                    StringComparison.OrdinalIgnoreCase)) return false;
            }
            return true;
        }
        static bool WithinWindow(System.Windows.Automation.AutomationElement element,
            System.Windows.Automation.AutomationElement root, IntPtr window) {
            var cursor = element;
            for (int i = 0; cursor != null && i < 128; i++) {
                if (System.Windows.Automation.Automation.Compare(cursor, root)) return true;
                object value = cursor.GetCurrentPropertyValue(
                    System.Windows.Automation.AutomationElement.NativeWindowHandleProperty, true);
                if (value is int && (int)value != 0 &&
                    Native.GetAncestor(new IntPtr((int)value), 2) != window) throw new InvalidOperationException();
                cursor = System.Windows.Automation.TreeWalker.RawViewWalker.GetParent(cursor);
            }
            return false;
        }
        public static PatternCall Run(object pattern, string action, string text,
            System.Windows.Automation.AutomationElement element,
            System.Windows.Automation.AutomationElement root, IntPtr window, int pid, long started) {
            return Run(pattern, action, text, element, root, window, pid, started, null);
        }
        public static PatternCall Run(object pattern, string action, string text,
            System.Windows.Automation.AutomationElement element,
            System.Windows.Automation.AutomationElement root, IntPtr window, int pid, long started,
            ItemReference reference) {
            if (System.Threading.Interlocked.Increment(ref active) > 8) {
                System.Threading.Interlocked.Decrement(ref active);
                throw new InvalidOperationException("UIA_SAFE: Too many busy pattern calls; close the target dialog first.");
            }
            bool workerStarted = false;
            try {
                var result = new PatternCall();
                var worker = new System.Threading.Thread(delegate() {
                    try {
                        // Repeat the existing identity/root/ancestry checks on the worker;
                        // never act on a recycled HWND or a ref moved to a foreign window.
                        using (var target = System.Diagnostics.Process.GetProcessById(pid)) {
                            var handle = target.Handle;
                            if (target.HasExited || Native.CreationTime(handle) != started ||
                                !Native.IsWindow(window) || Native.WindowPid(window) != pid ||
                                !System.Windows.Automation.Automation.Compare(root,
                                    System.Windows.Automation.AutomationElement.FromHandle(window))) throw new InvalidOperationException();
                            if (!WithinWindow(reference == null ? element : reference.Container, root, window))
                                throw new InvalidOperationException();
                            if (reference != null) {
                                if (action != "realize") throw new InvalidOperationException();
                                element = Reacquire(reference);
                                // Validate the fresh item, never the expired observation.
                                try {
                                    if (!WithinWindow(element, root, window)) throw new InvalidOperationException();
                                } catch (System.Windows.Automation.ElementNotAvailableException) { }
                                if (!MatchesAdditionalFilters(element, reference) ||
                                    !element.TryGetCurrentPattern(System.Windows.Automation.VirtualizedItemPattern.Pattern, out pattern))
                                    throw new InvalidOperationException();
                            }
                            if (target.HasExited || Native.CreationTime(handle) != started ||
                                Native.WindowPid(window) != pid || !System.Windows.Automation.Automation.Compare(root,
                                    System.Windows.Automation.AutomationElement.FromHandle(window))) throw new InvalidOperationException();
                            if (action == "scroll" && !((System.Windows.Automation.ScrollPattern)pattern).Current.VerticallyScrollable)
                                throw new InvalidOperationException();
                            // A timed-out preflight must not dispatch a delayed action.
                            if (System.Threading.Interlocked.CompareExchange(ref result.dispatchState, 1, 0) != 0) return;
                            switch (action) {
                                case "invoke": ((System.Windows.Automation.InvokePattern)pattern).Invoke(); break;
                                case "toggle": ((System.Windows.Automation.TogglePattern)pattern).Toggle(); break;
                                case "select": ((System.Windows.Automation.SelectionItemPattern)pattern).Select(); break;
                                case "expand": ((System.Windows.Automation.ExpandCollapsePattern)pattern).Expand(); break;
                                case "collapse": ((System.Windows.Automation.ExpandCollapsePattern)pattern).Collapse(); break;
                                case "value": ((System.Windows.Automation.ValuePattern)pattern).SetValue(text); break;
                                case "close": ((System.Windows.Automation.WindowPattern)pattern).Close(); break;
                                case "focus": element.SetFocus(); break;
                                case "realize": ((System.Windows.Automation.VirtualizedItemPattern)pattern).Realize(); break;
                                case "scrollIntoView": ((System.Windows.Automation.ScrollItemPattern)pattern).ScrollIntoView(); break;
                                case "scroll":
                                    var scroll = (System.Windows.Automation.ScrollPattern)pattern;
                                    int delta = Int32.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
                                    if (delta == 0 || Math.Abs(delta) > 10) throw new InvalidOperationException();
                                    for (int step = 0; step < Math.Abs(delta); step++) {
                                        if (!scroll.Current.VerticallyScrollable) throw new InvalidOperationException();
                                        scroll.Scroll(System.Windows.Automation.ScrollAmount.NoAmount,
                                            delta > 0 ? System.Windows.Automation.ScrollAmount.SmallDecrement :
                                                System.Windows.Automation.ScrollAmount.SmallIncrement);
                                    }
                                    try { result.VerticalScrollPercent = scroll.Current.VerticalScrollPercent; } catch { }
                                    break;
                                default: throw new InvalidOperationException();
                            }
                            result.Element = element;
                            if (action == "realize" || action == "scrollIntoView") {
                                // Realize does not grant authority over a foreign/moved item.
                                if (!WithinWindow(element, root, window)) throw new InvalidOperationException();
                                try {
                                    var cursor = element;
                                    for (int level = 0; cursor != null && level <= 5; level++) {
                                        if (!WithinWindow(cursor, root, window)) break;
                                        object scrollPattern;
                                        if (cursor.TryGetCurrentPattern(System.Windows.Automation.ScrollPattern.Pattern, out scrollPattern)) {
                                            result.VerticalScrollPercent = ((System.Windows.Automation.ScrollPattern)scrollPattern).Current.VerticalScrollPercent;
                                            break;
                                        }
                                        if (System.Windows.Automation.Automation.Compare(cursor, root)) break;
                                        cursor = System.Windows.Automation.TreeWalker.RawViewWalker.GetParent(cursor);
                                    }
                                } catch { } // Percentage is optional; never replace a successful action with a read error.
                            }
                        }
                    } catch { result.Failed = true; }
                    finally { System.Threading.Interlocked.Decrement(ref active); }
                });
                worker.IsBackground = true;
                worker.SetApartmentState(System.Threading.ApartmentState.MTA);
                worker.Start();
                workerStarted = true;
                result.Completed = worker.Join(5000);
                if (!result.Completed) System.Threading.Interlocked.CompareExchange(ref result.dispatchState, 2, 0);
                return result;
            } finally {
                // After Start succeeds, only the actual worker exit releases its slot.
                if (!workerStarted) System.Threading.Interlocked.Decrement(ref active);
            }
        }
    }
    public static class Native {
        // WPF's default proxy loader walks ReflectedType on the calling stack.
        // A PowerShell DynamicMethod has no ReflectedType and causes a null dereference,
        // leaving Win32 Edit controls as generic Panes. A typed, non-inlined frame
        // lets it load the built-in Win32 proxies without any window enumeration.
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        public static void InitializeProviders(System.Reflection.AssemblyName name) {
            System.Windows.Automation.ClientSettings.RegisterClientSideProviderAssembly(name);
        }
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index,
            System.Text.StringBuilder name, uint length, out uint needed);
        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQuerySessionInformation(IntPtr server, int session,
            int infoClass, out IntPtr buffer, out uint bytes);
        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr buffer);
        public static bool InteractiveDesktop() {
            int session;
            using (var process = System.Diagnostics.Process.GetCurrentProcess()) { session = process.SessionId; }
            if (!Environment.UserInteractive || session == 0) return false;
            IntPtr state;
            uint bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out state, out bytes)) return false;
            try {
                // WTSActive only: a disconnected RDP session can still expose Default.
                if (bytes < 4 || Marshal.ReadInt32(state) != 0) return false;
            } finally { WTSFreeMemory(state); }
            // Probe desktop identity/access only. Do NOT enumerate its windows or switch desktops.
            IntPtr desktop = OpenInputDesktop(0, false, 0x101);
            if (desktop == IntPtr.Zero) return false;
            try {
                var name = new System.Text.StringBuilder(256);
                uint needed;
                return GetUserObjectInformation(desktop, 2, name, 512, out needed) &&
                    string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            } finally { CloseDesktop(desktop); }
        }
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetConsoleWindow();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        public static long CreationTime(IntPtr handle) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
            return created; // Raw UTC FILETIME, matching the launcher and lifetime identities.
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32 {
            public uint Size, Usage, Pid;
            public UIntPtr Heap;
            public uint Module, Threads, ParentPid;
            public int Priority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
        }
        // Metadata only: protect the client and its terminal/shell ancestors, never names.
        public static Dictionary<int, int> ProcessParents() {
            var parents = new Dictionary<int, int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Process ancestry unavailable.");
            try {
                var entry = new PROCESSENTRY32();
                entry.Size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry)) throw new InvalidOperationException("Process ancestry unavailable.");
                do { parents[(int)entry.Pid] = (int)entry.ParentPid; }
                while (Process32Next(snapshot, ref entry));
            } finally { CloseHandle(snapshot); }
            return parents;
        }
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")]
        public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT {
            public int X, Y;
            public POINT(int x, int y) { X = x; Y = y; }
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct GUITHREADINFO {
            public uint Size, Flags;
            public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
            public RECT CaretRect;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT {
            public int X, Y;
            public uint Data, Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort Key, Scan;
            public uint Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION {
            [FieldOffset(0)] public MOUSEINPUT Mouse;
            [FieldOffset(0)] public KEYBDINPUT Keyboard;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint Type; public INPUTUNION Data; }
        public sealed class Window {
            public IntPtr Handle;
            public uint Pid;
            public bool Visible;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int count);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT {
            public uint Length, Flags, ShowCommand;
            public POINT MinPosition, MaxPosition;
            public RECT NormalPosition;
        }
        [DllImport("user32.dll")]
        public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")]
        public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")]
        private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out uint value, uint size);
        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out RECT value, uint size);
        [DllImport("user32.dll")]
        private static extern int GetWindowRgn(IntPtr window, IntPtr region);
        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")]
        private static extern int GetRgnBox(IntPtr region, out RECT bounds);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr value);
        private delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);
        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr data);
        [DllImport("shcore.dll")]
        private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scalePercent);

        public sealed class CaptureBounds {
            public int X, Y, Width, Height, ScalePercent;
            public uint Dpi;
        }
        public sealed class CapturedImage {
            public CaptureBounds Bounds;
            public int Width, Height;
            public string Data;
        }
        static InvalidOperationException CaptureError(string reason) {
            return new InvalidOperationException("UIA_SAFE: " + reason + "; request a new screenshot of a fully visible window.");
        }
        public static CaptureBounds GetCaptureBounds(IntPtr window) {
            if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)))
                throw CaptureError("Physical-pixel DPI awareness is unavailable");
            if (!InteractiveDesktop() || !IsWindow(window) || !IsWindowVisible(window) || IsIconic(window))
                throw CaptureError("Screenshot target is hidden, minimized or unavailable");
            // Layered/transparent targets can expose unrelated windows beneath their own bounds.
            if ((GetWindowLong(window, -20) & (0x80000 | 0x20)) != 0)
                throw CaptureError("Screenshot target is layered or transparent");
            uint cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) != 0 || cloaked != 0)
                throw CaptureError("Screenshot target is cloaked or cannot be verified");
            RECT nativeRect, rect;
            uint dpi = GetDpiForWindow(window);
            // Extended frame excludes invisible resize borders (notably negative maximized bounds).
            if (!GetWindowRect(window, out nativeRect) || dpi == 0 ||
                DwmGetWindowAttribute(window, 9, out rect, 16) != 0 ||
                rect.Right <= rect.Left || rect.Bottom <= rect.Top ||
                rect.Left < nativeRect.Left || rect.Top < nativeRect.Top ||
                rect.Right > nativeRect.Right || rect.Bottom > nativeRect.Bottom)
                throw CaptureError("Screenshot target bounds or DPI are unavailable");
            // A nonlayered HWND can still have holes via SetWindowRgn. Never export those pixels.
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) throw CaptureError("Window shape cannot be verified");
            try {
                int shape = GetWindowRgn(window, region);
                // ERROR (0) also means no custom region, the normal rectangular HWND case.
                if (shape == 1 || shape == 3) throw CaptureError("Nonrectangular screenshot target");
                if (shape == 2) {
                    RECT area;
                    if (GetRgnBox(region, out area) != 2 ||
                        area.Left > rect.Left - nativeRect.Left || area.Top > rect.Top - nativeRect.Top ||
                        area.Right < rect.Right - nativeRect.Left || area.Bottom < rect.Bottom - nativeRect.Top)
                        throw CaptureError("Screenshot frame extends beyond the window region");
                }
            } finally { DeleteObject(region); }
            long width = (long)rect.Right - rect.Left, height = (long)rect.Bottom - rect.Top;
            // Bound the intermediate physical bitmap, not just its downscaled output.
            if (width > 32768 || height > 32768 || width * height > 67108864)
                throw CaptureError("Screenshot target is too large");
            var bounds = new System.Drawing.Rectangle(rect.Left, rect.Top, (int)width, (int)height);
            int maxScale = 0;
            using (var uncovered = new System.Drawing.Region(bounds))
            using (var probe = new System.Drawing.Bitmap(1, 1))
            using (var graphics = System.Drawing.Graphics.FromImage(probe)) {
                MonitorProc callback = delegate(IntPtr monitor, IntPtr dc, ref RECT area, IntPtr data) {
                    var monitorBounds = System.Drawing.Rectangle.FromLTRB(area.Left, area.Top, area.Right, area.Bottom);
                    if (monitorBounds.IntersectsWith(bounds)) {
                        // GetDpiForWindow is virtualized to 96 for DPI-unaware targets.
                        // Shell monitor scale is independent of the target app's awareness.
                        int monitorScale;
                        if (GetScaleFactorForMonitor(monitor, out monitorScale) != 0 ||
                            monitorScale < 100 || monitorScale > 1000) return false;
                        maxScale = Math.Max(maxScale, monitorScale);
                    }
                    uncovered.Exclude(monitorBounds);
                    return true;
                };
                if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) || !uncovered.IsEmpty(graphics))
                    throw CaptureError("Screenshot target is partly offscreen or monitor scale is unavailable");
                GC.KeepAlive(callback);
            }
            if (maxScale == 0) throw CaptureError("Physical monitor scale cannot be verified");
            return new CaptureBounds { X = rect.Left, Y = rect.Top, Width = (int)width, Height = (int)height,
                ScalePercent = maxScale, Dpi = (uint)Math.Ceiling(96.0 * maxScale / 100.0) };
        }
        static void AssertCaptureClear(IntPtr window, System.Drawing.Rectangle bounds) {
            // Conservatively refuse intersecting top-level windows above the target,
            // even transparent/tool windows: hit tests alone miss click-through occluders.
            IntPtr above = GetWindow(window, 3); // GW_HWNDPREV: walk toward top of Z order.
            int visited = 0;
            while (above != IntPtr.Zero) {
                if (++visited > 10000) throw CaptureError("Window stacking cannot be verified");
                if (IsWindowVisible(above) && !IsIconic(above)) {
                    uint cloaked;
                    if (DwmGetWindowAttribute(above, 14, out cloaked, 4) != 0)
                        throw CaptureError("Window occlusion cannot be verified");
                    if (cloaked == 0) {
                        RECT rect;
                        if (!GetWindowRect(above, out rect)) throw CaptureError("Window occlusion cannot be verified");
                        if (System.Drawing.Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom).IntersectsWith(bounds))
                            throw CaptureError("Screenshot target is occluded");
                    }
                }
                above = GetWindow(above, 3);
            }
        }
        static bool SameBounds(CaptureBounds first, CaptureBounds second) {
            return first.X == second.X && first.Y == second.Y && first.Width == second.Width &&
                first.Height == second.Height && first.Dpi == second.Dpi && first.ScalePercent == second.ScalePercent;
        }
        public static CapturedImage Capture(IntPtr window, int maxEdge) {
            if (maxEdge < 128 || maxEdge > 4096) throw CaptureError("Invalid screenshotMaxEdge");
            var before = GetCaptureBounds(window);
            var bounds = new System.Drawing.Rectangle(before.X, before.Y, before.Width, before.Height);
            AssertCaptureClear(window, bounds);
            double scale = Math.Min(1.0, (double)maxEdge / Math.Max(bounds.Width, bounds.Height));
            int width = Math.Max(1, (int)Math.Floor(bounds.Width * scale));
            int height = Math.Max(1, (int)Math.Floor(bounds.Height * scale));
            // Copy only target bounds, never the virtual desktop. Cannot perfectly prevent races:
            // another window can move over these pixels between checks and CopyFromScreen.
            using (var bitmap = new System.Drawing.Bitmap(bounds.Width, bounds.Height)) {
                using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {
                    graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bitmap.Size, System.Drawing.CopyPixelOperation.SourceCopy);
                }
                AssertCaptureClear(window, bounds);
                if (!SameBounds(before, GetCaptureBounds(window))) throw CaptureError("Screenshot target moved or changed DPI");
                // DWM may round an otherwise rectangular HWND. Conservatively mask corner
                // squares before export so underlying apps at those corners are never included.
                int corner = (int)Math.Ceiling(16.0 * before.ScalePercent / 100.0);
                using (var mask = System.Drawing.Graphics.FromImage(bitmap)) {
                    mask.FillRectangle(System.Drawing.Brushes.Black, 0, 0, corner, corner);
                    mask.FillRectangle(System.Drawing.Brushes.Black, bounds.Width - corner, 0, corner, corner);
                    mask.FillRectangle(System.Drawing.Brushes.Black, 0, bounds.Height - corner, corner, corner);
                    mask.FillRectangle(System.Drawing.Brushes.Black, bounds.Width - corner, bounds.Height - corner, corner, corner);
                }
                using (var scaled = new System.Drawing.Bitmap(width, height))
                using (var graphics = System.Drawing.Graphics.FromImage(scaled))
                using (var stream = new System.IO.MemoryStream()) {
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(bitmap, new System.Drawing.Rectangle(0, 0, width, height));
                    scaled.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
                    return new CapturedImage { Bounds = before, Width = width, Height = height,
                        Data = Convert.ToBase64String(stream.ToArray()) };
                }
            }
        }
        public static bool Wheel(int delta) {
            if (delta == 0 || delta < -10 || delta > 10) return false;
            var input = new INPUT();
            input.Data.Mouse.Flags = 0x0800; // MOUSEEVENTF_WHEEL, signed WHEEL_DELTA notches.
            input.Data.Mouse.Data = unchecked((uint)(delta * 120));
            input.Data.Mouse.Extra = InputTag;
            return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
        }

        // Enumeration itself is metadata only; ui_windows reads titles after enumeration.
        public static Window[] Windows() {
            var windows = new List<Window>();
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr data) {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                windows.Add(new Window { Handle = hwnd, Pid = pid,
                    Visible = IsWindowVisible(hwnd) });
                return true;
            };
            if (!EnumWindows(callback, IntPtr.Zero))
                throw new InvalidOperationException("Window discovery failed.");
            GC.KeepAlive(callback);
            return windows.ToArray();
        }
        public static uint WindowPid(IntPtr hwnd) {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            return pid;
        }
        public static IntPtr FocusWindow(IntPtr hwnd) {
            uint pid;
            uint thread = GetWindowThreadProcessId(hwnd, out pid);
            var info = new GUITHREADINFO();
            info.Size = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
            if (thread == 0 || !GetGUIThreadInfo(thread, ref info)) return IntPtr.Zero;
            return info.Focus;
        }
        static readonly UIntPtr InputTag = new UIntPtr(0xA1120000u ^ (uint)System.Diagnostics.Process.GetCurrentProcess().Id);
        static INPUT KeyInput(ushort key, bool up) {
            var input = new INPUT();
            input.Type = 1;
            input.Data.Keyboard.Key = key;
            input.Data.Keyboard.Flags = up ? 2u : 0u;
            input.Data.Keyboard.Extra = InputTag;
            if ((key >= 0x21 && key <= 0x28) || key == 0x2E)
                input.Data.Keyboard.Flags |= 1u;
            return input;
        }
        public static bool Chord(ushort[] modifiers, ushort key) {
            // One native batch: never call a blocking provider with injected keys held.
            var inputs = new List<INPUT>();
            foreach (ushort modifier in modifiers) inputs.Add(KeyInput(modifier, false));
            inputs.Add(KeyInput(key, false)); inputs.Add(KeyInput(key, true));
            for (int i = modifiers.Length - 1; i >= 0; i--) inputs.Add(KeyInput(modifiers[i], true));
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Count) {
                var held = new HashSet<ushort>();
                for (int i = 0; i < sent; i++) {
                    var k = inputs[i].Data.Keyboard;
                    if ((k.Flags & 2) == 0) held.Add(k.Key); else held.Remove(k.Key);
                }
                foreach (ushort heldKey in held) SendInput(1, new INPUT[] { KeyInput(heldKey, true) }, Marshal.SizeOf(typeof(INPUT)));
            }
            return sent == inputs.Count;
        }
        public static bool Unicode(string text) {
            var inputs = new INPUT[text.Length * 2];
            for (int i = 0; i < text.Length; i++) {
                inputs[i * 2].Type = inputs[i * 2 + 1].Type = 1;
                inputs[i * 2].Data.Keyboard.Scan = text[i];
                inputs[i * 2 + 1].Data.Keyboard.Scan = text[i];
                inputs[i * 2].Data.Keyboard.Flags = 4;
                inputs[i * 2 + 1].Data.Keyboard.Flags = 4 | 2;
                inputs[i * 2].Data.Keyboard.Extra = inputs[i * 2 + 1].Data.Keyboard.Extra = InputTag;
            }
            if (inputs.Length == 0) return true;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length && (sent & 1) != 0) {
                // A partial insertion may have left the last Unicode key down.
                SendInput(1, new INPUT[] { inputs[sent] }, Marshal.SizeOf(typeof(INPUT)));
            }
            return sent == inputs.Length;
        }
        public static bool Click() {
            var inputs = new INPUT[2];
            inputs[0].Data.Mouse.Flags = 2; inputs[1].Data.Mouse.Flags = 4;
            inputs[0].Data.Mouse.Extra = inputs[1].Data.Mouse.Extra = InputTag;
            uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent == 1) SendInput(1, new INPUT[] { inputs[1] }, Marshal.SizeOf(typeof(INPUT)));
            return sent == 2;
        }
    }
}
'@ | Out-Null



    $proxies = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object {
        $_.GetName().Name -eq 'UIAutomationClientsideProviders'
    }
    [OwnedUia.Native]::InitializeProviders($proxies.GetName())
    $script:walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    # Per-monitor v2: UIA points/rectangles and native cursor coordinates are physical pixels.
    if ([OwnedUia.Native]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero) {
        Deny 'Per-monitor DPI awareness is unavailable.'
    }
    $script:actionId = 0
    if ($AmiraPid -lt 0) { Deny 'Invalid Amira process.' }
    if ($AmiraPid -gt 0) {
        $parents = [OwnedUia.Native]::ProcessParents()
        $identity = Get-Identity $AmiraPid
        if ($null -eq $identity) { Deny 'Amira process is unavailable.' }
        for ($i = 0; $i -lt 128 -and $null -ne $identity; $i++) {
            if ($script:amiraProcesses.ContainsKey($identity.Pid)) { break }
            $script:amiraProcesses[$identity.Pid] = $identity
            if (-not $parents.ContainsKey($identity.Pid) -or $parents[$identity.Pid] -le 0) { break }
            $parent = Get-Identity $parents[$identity.Pid]
            # A newer process cannot be the ancestor (the parent PID was reused).
            if ($null -eq $parent -or $parent.Started -gt $identity.Started) { break }
            $identity = $parent
        }
    }
    $script:consoleWindow = [OwnedUia.Native]::GetConsoleWindow()

    function Assert-Window($window) {
        Assert-Lifetime
        if (-not (Test-Identity $window.Identity) -or
            -not [OwnedUia.Native]::IsWindow($window.Handle) -or
            [OwnedUia.Native]::GetAncestor($window.Handle, 2) -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($window.Handle) -ne $window.Identity.Pid) {
            Deny 'Target window is no longer valid.'
        }
    }

    function Assert-ActionWindow($window) {
        Assert-Window $window
        $class = New-Object Text.StringBuilder 256
        if ([OwnedUia.Native]::GetClassName($window.Handle, $class, $class.Capacity) -le 0) {
            Deny 'Target window class cannot be verified.'
        }
        # WinForms can share a native class with other apps: scope its overlay class
        # to the overlay process published over the private pipe, not all TextBoxes.
        if ($class.ToString() -in @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'AmiraPointerOverlay') -or
            ($script:overlayPid -gt 0 -and $window.Identity.Pid -eq $script:overlayPid -and
                $class.ToString() -ceq $script:overlayClass)) {
            Deny 'Actions on shell or Amira overlay windows are not permitted.'
        }
        if (($script:consoleWindow -ne [IntPtr]::Zero -and
                $window.Handle -eq [OwnedUia.Native]::GetAncestor($script:consoleWindow, 2)) -or
            ($script:amiraProcesses.ContainsKey($window.Identity.Pid) -and
                $script:amiraProcesses[$window.Identity.Pid].Started -eq $window.Identity.Started)) {
            Deny 'Actions on the Amira terminal are not permitted.'
        }
    }

    function Assert-Element($window, $element, $Clock = $null) {
        Assert-TreeBudget $Clock
        Assert-Window $window
        if ($null -eq $element) { Deny 'Element is unavailable.' }
        # Identity properties only until the entire ancestry is proven. Stop at
        # our FromHandle root; never ask for its parent (the desktop/foreign UIA).
        $cursor = $element
        for ($i = 0; $i -lt 128; $i++) {
            Assert-TreeBudget $Clock
            if ([System.Windows.Automation.Automation]::Compare($cursor, $window.Root)) {
                Assert-TreeBudget $Clock
                Assert-Window $window
                return
            }
            # Check between provider calls: one may overrun, but must not start
            # more ancestry work after the shared snapshot deadline.
            Assert-TreeBudget $Clock
            # A native child must also be inside this exact top-level HWND.
            $handleValue = $cursor.GetCurrentPropertyValue(
                [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, $true)
            if ($handleValue -is [int] -and $handleValue -ne 0) {
                $handle = [IntPtr]::new([long]$handleValue)
                Assert-TreeBudget $Clock
                if ([OwnedUia.Native]::GetAncestor($handle, 2) -ne $window.Handle) {
                    Deny 'Element is outside the target window.'
                }
            }
            Assert-TreeBudget $Clock
            $cursor = $script:walker.GetParent($cursor)
            if ($null -eq $cursor) { break }
        }
        Deny 'Element ancestry cannot be verified.'
    }

    function Assert-TreeBudget($clock) {
        $budgetMs = 20000
        if ($null -ne $clock -and $null -ne $clock.PSObject.Properties['BudgetMs']) { $budgetMs = $clock.BudgetMs }
        if ($null -ne $clock -and $clock.ElapsedMilliseconds -ge $budgetMs) {
            # Not a safety Deny: the snapshot can return a partial/unreadable node.
            throw [TimeoutException]::new('Tree traversal budget exhausted.')
        }
    }

    function Read-Property($window, $element, $property, [switch] $Verified, $Clock = $null) {
        if (-not $Verified) { Assert-Element $window $element }
        Assert-TreeBudget $Clock
        return $element.GetCurrentPropertyValue($property, $true)
    }

    function Get-Pattern($window, $element, $patternId, [switch] $Verified, $Clock = $null) {
        # Snapshot nodes come from the target's Children traversal; actions always revalidate.
        if (-not $Verified) { Assert-Element $window $element }
        Assert-TreeBudget $Clock
        $pattern = $null
        if ($element.TryGetCurrentPattern($patternId, [ref]$pattern)) { return $pattern }
        return $null
    }

    function Get-Window($parameters, $Clock = $null) {
        Assert-TreeBudget $Clock
        $ref = Get-Argument $parameters 'window'
        $number = 0L
        if ($ref -isnot [string] -or -not [long]::TryParse($ref, [ref]$number) -or $number -le 0) {
            Deny 'Invalid native window handle; use ui_windows.'
        }
        $handle = [IntPtr]::new($number)
        if (-not [OwnedUia.Native]::IsWindow($handle) -or [OwnedUia.Native]::GetAncestor($handle, 2) -ne $handle) {
            Deny 'Target is not a top-level window; use ui_windows.'
        }
        Assert-TreeBudget $Clock
        $identity = Get-Identity ([OwnedUia.Native]::WindowPid($handle))
        if ($null -eq $identity) { Deny 'Target process is inaccessible or exited.' }
        Assert-TreeBudget $Clock
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        Assert-TreeBudget $Clock
        if ($script:windows.ContainsKey($ref)) {
            $window = $script:windows[$ref]
            $sameRoot = $false
            try { $sameRoot = [System.Windows.Automation.Automation]::Compare($window.Root, $root) } catch { }
            Assert-TreeBudget $Clock
            if ($window.Identity.Key -eq $identity.Key -and $sameRoot) {
                Assert-Window $window
                return $window
            }
            # HWND reuse, even in the same process, invalidates the root and every ref.
            $script:windows.Remove($ref)
        }
        $window = [pscustomobject]@{
            Ref = $ref; Handle = $handle; Identity = $identity
            Root = $root; Refs = @{}; VirtualRefs = @{}; Screenshot = $null
        }
        Assert-Window $window
        $script:windows[$ref] = $window
        return $window
    }

    function Get-WindowInfo($native) {
        $title = New-Object Text.StringBuilder 122
        $class = New-Object Text.StringBuilder 256
        $null = [OwnedUia.Native]::GetWindowText($native.Handle, $title, $title.Capacity)
        $null = [OwnedUia.Native]::GetClassName($native.Handle, $class, $class.Capacity)
        $bounds = New-Object OwnedUia.Native+RECT
        $null = [OwnedUia.Native]::GetWindowRect($native.Handle, [ref]$bounds)
        $processName = ''
        $process = $null
        try { $process = [Diagnostics.Process]::GetProcessById($native.Pid); $processName = $process.ProcessName }
        catch { } finally { if ($null -ne $process) { $process.Dispose() } }
        $titleText = $title.ToString()
        $titleCut = $titleText.Length -gt 120
        if ($titleCut) { $titleText = $titleText.Substring(0, 117) + '...' }
        return @{
            window = $native.Handle.ToInt64().ToString(); title = $titleText; process = $processName
            titleCut = $titleCut
            pid = $native.Pid; class = $class.ToString()
            bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top }
            minimized = [OwnedUia.Native]::IsIconic($native.Handle)
            foreground = [OwnedUia.Native]::GetForegroundWindow() -eq $native.Handle
        }
    }

    function Get-Windows($parameters, $Clock = $null) {
        $filter = Get-Argument $parameters 'filter' ''
        if ($filter -isnot [string]) { Deny 'Filter must be a substring.' }
        $matches = New-Object System.Collections.Generic.List[object]
        $cut = $false
        $incomplete = $false
        Assert-TreeBudget $Clock
        try {
            foreach ($native in [OwnedUia.Native]::Windows()) {
                Assert-TreeBudget $Clock
                if (-not $native.Visible) { continue }
                $info = Get-WindowInfo $native
                Assert-TreeBudget $Clock
                # Filter against the full native title; truncate only the returned text.
                $filterTitle = New-Object Text.StringBuilder 4096
                $copied = [OwnedUia.Native]::GetWindowText($native.Handle, $filterTitle, $filterTitle.Capacity)
                # Unlike 120-character display shortening, a full native filter
                # buffer can hide a matching suffix. Absence is then unproven.
                if ($copied -ge $filterTitle.Capacity - 1) { $cut = $true; $incomplete = $true }
                Assert-TreeBudget $Clock
                $search = $info.window + ' ' + $filterTitle.ToString() + ' ' + $info.process + ' ' + $info.pid + ' ' + $info.class
                if ($search.IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    if ($matches.Count -ge 200) { $cut = $true; $incomplete = $true; break }
                    if ($info.titleCut) { $cut = $true }
                    $matches.Add($info)
                }
            }
        } catch [TimeoutException] { $cut = $true; $incomplete = $true }
        $result = @{ windows = @($matches.ToArray()); cut = $cut; incomplete = $incomplete }
        if ($cut) { $result.note = '[cut: window list limited to 200 entries; titles limited to 120 characters]' }
        return $result
    }

    function Show-Action($window, $element, [string] $kind, [string] $label, $ExplicitPoint = $null) {
        if ($null -ne $window) { Assert-ActionWindow $window }
        if ($Overlay -eq 'false') { return }
        $point = @{ X = 32; Y = 64 }
        if ($null -ne $ExplicitPoint) { $point = $ExplicitPoint }
        elseif ($null -ne $window) {
            Assert-ActionWindow $window
            if ($null -eq $element) { $element = $window.Root }
            Assert-Element $window $element
            $point = $null
            try { $point = $element.GetClickablePoint() } catch { }
            if ($null -eq $point) {
                $bounds = $null
                try { $bounds = $element.Current.BoundingRectangle } catch { }
                if ($null -ne $bounds -and -not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
                    $point = @{ X = $bounds.X + $bounds.Width / 2; Y = $bounds.Y + $bounds.Height / 2 }
                } else {
                    # Minimized roots can have an empty UIA rectangle. Use restored native bounds.
                    $nativeBounds = New-Object OwnedUia.Native+RECT
                    $null = [OwnedUia.Native]::GetWindowRect($window.Handle, [ref]$nativeBounds)
                    if ([OwnedUia.Native]::IsIconic($window.Handle)) {
                        $placement = New-Object OwnedUia.Native+WINDOWPLACEMENT
                        $placement.Length = [Runtime.InteropServices.Marshal]::SizeOf($placement)
                        if ([OwnedUia.Native]::GetWindowPlacement($window.Handle, [ref]$placement)) {
                            $nativeBounds = $placement.NormalPosition
                        }
                    }
                    $point = @{ X = ($nativeBounds.Left + $nativeBounds.Right) / 2; Y = ($nativeBounds.Top + $nativeBounds.Bottom) / 2 }
                }
            }
        }
        if ([double]::IsNaN($point.X) -or [double]::IsInfinity($point.X) -or
            [double]::IsNaN($point.Y) -or [double]::IsInfinity($point.Y)) { Deny 'Target point is unavailable.' }
        $script:actionId++
        $writer.WriteLine((@{ event = 'overlay'; id = $script:actionId; kind = $kind; label = $label
            x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
        # Animation is best effort. Keep the shared read alive on timeout; the main
        # loop consumes a late ack rather than starting a concurrent StreamReader read.
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($clock.ElapsedMilliseconds -lt 5000) {
            Assert-Lifetime
            $pending = Get-PendingRead
            if (-not $pending.IsCompleted) { Start-Sleep -Milliseconds 10; continue }
            $line = Receive-PendingLine
            if ($null -eq $line) { Deny 'Session input closed before the action.' }
            $reply = $null
            try { $reply = $line | ConvertFrom-Json } catch { }
            if ((Get-Argument $reply 'method') -ceq 'overlay_ack') {
                if ((Get-Argument $reply 'id') -eq $script:actionId) {
                    if ($null -ne $window) { Assert-ActionWindow $window }
                    return
                }
                continue # A late acknowledgement from an earlier action.
            }
            # Do not swallow a queued request or mistake it for a failed handshake.
            $script:queuedLines.Enqueue($line)
            [Console]::Error.WriteLine('Overlay acknowledgement unavailable; skipping animation wait.')
            return
        }
        [Console]::Error.WriteLine('Overlay glide acknowledgement timed out; skipping animation wait.')
    }

    function Get-Element($window, $parameters, [switch] $Optional) {
        $ref = Get-Argument $parameters 'ref'
        if ($Optional -and $null -eq $ref) { $element = $window.Root }
        else {
            if ($ref -isnot [string] -or -not $window.Refs.ContainsKey($ref)) {
                Deny 'Unknown element reference; request a new tree.'
            }
            $element = $window.Refs[$ref]
        }
        Assert-Element $window $element
        if ((Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty)) -ne $true) {
            Deny 'Element is disabled.'
        }
        return $element
    }

    function Assert-Foreground($window) {
        Assert-ActionWindow $window
        $foreground = [OwnedUia.Native]::GetForegroundWindow()
        if ($foreground -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($foreground) -ne $window.Identity.Pid) {
            Deny 'Target window is not in the foreground.'
        }
    }

    function Assert-NativeFocus($window) {
        Assert-Foreground $window
        $focus = [OwnedUia.Native]::FocusWindow($window.Handle)
        if ($focus -eq [IntPtr]::Zero -or
            [OwnedUia.Native]::GetAncestor($focus, 2) -ne $window.Handle) {
            Deny 'Target window does not have keyboard focus.'
        }
        Assert-Foreground $window
    }

    function Focus-Window($window, [switch] $NoRestore) {
        Assert-ActionWindow $window
        if (-not [OwnedUia.Native]::InteractiveDesktop()) { Deny 'No interactive input desktop is available.' }
        if ([OwnedUia.Native]::IsIconic($window.Handle)) {
            if ($NoRestore) { Deny 'Screenshot target is minimized; request a new screenshot.' }
            $null = [OwnedUia.Native]::ShowWindowAsync($window.Handle, 9)
        }
        $null = [OwnedUia.Native]::SetForegroundWindow($window.Handle)
        for ($i = 0; $i -lt 20; $i++) {
            Assert-Window $window
            if ([OwnedUia.Native]::GetForegroundWindow() -eq $window.Handle) { break }
            Start-Sleep -Milliseconds 50
        }
        Assert-Foreground $window
    }

    function Focus-Element($window, $element, [bool] $requireExact) {
        Focus-Window $window
        Assert-Element $window $element
        $null = Invoke-BoundedPattern $window $element $null 'focus' 'AutomationElement.SetFocus'
        Assert-NativeFocus $window
        if ($requireExact -and
            (Read-Property $window $element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)) -ne $true) {
            Deny 'Element could not receive keyboard focus.'
        }
    }

    function Assert-NoHeldModifiers {
        # Do not combine injected input with the user's physically held chord.
        foreach ($key in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
            if (([int][OwnedUia.Native]::GetAsyncKeyState($key) -band 0x8000) -ne 0) {
                Deny 'Release held modifier keys before sending input.'
            }
        }
    }

    function Quote-ProcessArgument([string] $argument) {
        # Start-Process joins ArgumentList with spaces in Windows PowerShell 5.1.
        # Quote only entries that need it (cmd.exe does not recognize a quoted "/c"),
        # doubling backslashes before quotes/the final quote.
        if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') { return $argument }
        $escaped = [regex]::Replace($argument, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        return '"' + $escaped + '"'
    }

    function Close-JobAck($ack) {
        $job = Get-Argument $ack 'job'
        if ($job -isnot [string] -or -not $script:requestedJobs.ContainsKey($job) -or
            $script:receivedJobAcks.ContainsKey($job)) { return }
        $script:receivedJobAcks[$job] = $true
        foreach ($name in @('handle', 'parentHandle')) {
            $handle = Get-Argument $ack $name
            if (($handle -is [long] -or $handle -is [int]) -and $handle -gt 0) {
                [OwnedUia.LaunchGuard]::CloseTransferredHandle([long]$handle)
            }
        }
    }

    # launch: arbitrary executable/argv; journal only the exact process actually started.
    function Start-OwnedApp($parameters) {
        if (-not [OwnedUia.Native]::InteractiveDesktop()) { Deny 'No interactive input desktop is available.' }
        $command = Get-Argument $parameters 'command'
        if ($command -isnot [string] -or [string]::IsNullOrWhiteSpace($command)) {
            Deny 'Invalid launch command.'
        }
        $cwd = Get-Argument $parameters 'cwd'
        if ($null -ne $cwd -and ($cwd -isnot [string] -or -not [IO.Directory]::Exists($cwd))) {
            Deny 'Launch cwd must be an existing directory.'
        }
        if ($null -ne $cwd -and -not [IO.Path]::IsPathRooted($command) -and
            ($command.Contains('\') -or $command.Contains('/'))) {
            $command = [IO.Path]::Combine($cwd, $command)
        }
        # Resolve a program, not a PowerShell expression. Scripts can be passed to their interpreter.
        $resolved = @(Get-Command -Name $command -CommandType Application -ErrorAction SilentlyContinue)
        if ($resolved.Count -eq 0) { Deny 'Launch executable is unavailable.' }
        # Use the first PATH resolution, as launching this executable name normally does.
        $path = [IO.Path]::GetFullPath($resolved[0].Path)
        $arguments = Get-Argument $parameters 'args' @()
        if ($null -eq $arguments) { $arguments = @() }
        if ($arguments -is [string] -or $arguments -isnot [System.Array]) {
            Deny 'Launch args must be a string array.'
        }
        foreach ($argument in $arguments) {
            if ($argument -isnot [string]) { Deny 'Launch args must be a string array.' }
        }

        Assert-Lifetime
        $beforeHandles = @{}
        foreach ($native in [OwnedUia.Native]::Windows()) {
            $beforeHandles[$native.Handle.ToInt64().ToString()] = $true
        }
        $began = [DateTime]::UtcNow.ToFileTimeUtc()
        $argumentLine = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
        Show-Action $null $null 'launch' 'Launch'
        # Request an unnamed job BEFORE process creation. The watchdog authenticates
        # this helper identity and owns the object even if publication is interrupted.
        $jobId = 'amira-uia-job-' + [Guid]::NewGuid().ToString()
        $committed = $false
        $launcher = $null
        $launcherIdentity = $null
        try {
            $writer.WriteLine((@{ event = 'create-job'; job = $jobId } | ConvertTo-Json -Compress))
            $script:requestedJobs[$jobId] = $true
            $retainClock = [Diagnostics.Stopwatch]::StartNew()
            while ($retainClock.ElapsedMilliseconds -lt 5000) {
                Assert-Lifetime
                $pending = Get-PendingRead
                if (-not $pending.IsCompleted) { Start-Sleep -Milliseconds 25; continue }
                $line = Receive-PendingLine
                if ($null -eq $line) { break }
                $ack = $line | ConvertFrom-Json
                if ((Get-Argument $ack 'method') -ceq 'job_ack' -and
                    (Get-Argument $ack 'job') -ceq $jobId) {
                    if ((Get-Argument $ack 'rejected' $false) -eq $true) {
                        Close-JobAck $ack
                        Deny 'Launch refused: watchdog job transfer was rejected.'
                    }
                    $transferred = $false
                    try {
                        $handle = Get-Argument $ack 'handle'
                        if (($handle -isnot [long] -and $handle -isnot [int]) -or $handle -le 0) { Deny 'Invalid launch job handle.' }
                        $parentHandle = Get-Argument $ack 'parentHandle'
                        $parentPid = Get-Argument $ack 'parentPid'
                        $parentStarted = Get-Argument $ack 'parentStarted'
                        if (($parentHandle -isnot [long] -and $parentHandle -isnot [int]) -or $parentHandle -le 0 -or
                            $parentPid -isnot [int] -or $parentPid -le 0 -or $parentStarted -isnot [string] -or
                            $parentStarted -cnotmatch '^[1-9][0-9]*$') { Deny 'Invalid launch parent identity.' }
                        $parentTime = 0L
                        if (-not [long]::TryParse($parentStarted, [ref]$parentTime)) { Deny 'Invalid launch parent identity.' }
                        if ($script:receivedJobAcks.ContainsKey($jobId)) { Deny 'Duplicate launch job transfer.' }
                        # FromHandle owns both handles even if its identity check throws.
                        $transferred = $true
                        $script:receivedJobAcks[$jobId] = $true
                        $launcher = [OwnedUia.LaunchGuard]::FromHandle($jobId, [long]$handle, [long]$parentHandle, $parentPid, $parentTime)
                    } finally { if (-not $transferred) { Close-JobAck $ack } }
                    break
                }
                if ((Get-Argument $ack 'method') -ceq 'job_ack') { Close-JobAck $ack }
                else { $script:queuedLines.Enqueue($line) }
            }
            if ($null -eq $launcher) { Deny 'Launch refused: watchdog did not retain the launch job.' }
            $script:jobs[$jobId] = $launcher
            Save-OwnedState
            Assert-Lifetime
            try { $launcher = [OwnedUia.LaunchGuard]::Start($path, $argumentLine, $cwd, $launcher) }
            catch {
                $exception = $_.Exception
                while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
                if ($exception.Message -ceq 'Launch parent identity changed or exited.') {
                    Deny 'Launch refused: launch parent identity changed or exited.'
                }
                Deny 'Launch refused: could not retain a non-breakaway job (nested jobs may be unsupported).'
            }
            $started = $launcher.Started
            if ($started -lt $began) { Deny 'Launch did not return a newly created process.' }
            $launcherIdentity = [pscustomobject]@{
                Pid = $launcher.Id; Started = $started
                Key = ('{0}:{1}' -f $launcher.Id, $started)
            }
            $script:processes[$launcherIdentity.Key] = $launcherIdentity
            Save-OwnedState
            $writer.WriteLine((@{ event = 'launch-root'; job = $jobId; pid = $launcher.Id; started = $started.ToString(); threadId = $launcher.ThreadId } | ConvertTo-Json -Compress))
            $registered = $false
            $clock = [Diagnostics.Stopwatch]::StartNew()
            while ($clock.ElapsedMilliseconds -lt 5000) {
                Assert-Lifetime
                $pending = Get-PendingRead
                if (-not $pending.Wait(25)) { continue }
                $line = Receive-PendingLine
                if ($null -eq $line) { Deny 'Session input closed during launch root registration.' }
                $ack = $line | ConvertFrom-Json
                if ((Get-Argument $ack 'method') -ceq 'root_ack' -and (Get-Argument $ack 'job') -ceq $jobId) {
                    $registered = $true; break
                }
                $script:queuedLines.Enqueue($line)
            }
            if (-not $registered) { Deny 'Launch commit acknowledgement timed out; watchdog retains the launch job.' }
            $committed = $true # The watchdog registered AND resumed the exact primary thread before ack.
            Assert-Lifetime

            $clock = [Diagnostics.Stopwatch]::StartNew()
            $stableKey = ''
            $stableSince = 0L
            $executable = [IO.Path]::GetFileNameWithoutExtension($path)
            while ($clock.ElapsedMilliseconds -lt 10000) {
                Assert-Lifetime
                $candidates = New-Object System.Collections.Generic.List[object]
                foreach ($native in [OwnedUia.Native]::Windows()) {
                    if (-not $native.Visible -or
                        $beforeHandles.ContainsKey($native.Handle.ToInt64().ToString())) { continue }
                    $matches = $native.Pid -eq $launcherIdentity.Pid -and (Test-Identity $launcherIdentity)
                    if (-not $matches) {
                        $candidateProcess = $null
                        try {
                            $candidateProcess = [Diagnostics.Process]::GetProcessById($native.Pid)
                            $matches = $candidateProcess.ProcessName -ieq $executable
                        } catch { } finally { if ($null -ne $candidateProcess) { $candidateProcess.Dispose() } }
                    }
                    if ($matches) { $candidates.Add($native) }
                }
                # Handoff matching grants a handle, NOT launch/kill eligibility.
                if ($candidates.Count -eq 1) {
                    $candidate = $candidates[0]
                    $key = $candidate.Handle.ToInt64().ToString()
                    if ($key -ne $stableKey) { $stableKey = $key; $stableSince = $clock.ElapsedMilliseconds }
                    elseif ($clock.ElapsedMilliseconds - $stableSince -ge 500) {
                        $info = Get-WindowInfo $candidate
                        return @{ window = $info.window; pid = $launcherIdentity.Pid; title = $info.title
                            windowPid = $info.pid; handoff = $info.pid -ne $launcherIdentity.Pid }
                    }
                } else { $stableKey = '' }
                Start-Sleep -Milliseconds 100
            }
            return @{ pid = $launcherIdentity.Pid; instruction = 'No unambiguous new window found; use ui_windows with an executable/title filter.' }
        } finally {
            try {
                if (-not $committed) {
                    $script:jobs.Remove($jobId)
                    if ($null -ne $launcherIdentity) { $script:processes.Remove($launcherIdentity.Key) }
                    if ($null -ne $launcher) { $launcher.Dispose() }
                    Save-OwnedState
                }
            } finally {
                # A failed pre-commit launch is drained by its retained watchdog job.
                # Discovery/provider failure after commit must NOT terminate an app.
                $writer.WriteLine((@{ event = 'launch-finished'; job = $jobId; failed = (-not $committed) } | ConvertTo-Json -Compress))
            }
        }
    }

    function Escape-Field($value) {
        if ([Object]::ReferenceEquals($value, [System.Windows.Automation.AutomationElement]::NotSupported)) { return '' }
        $text = [string]$value
        if ($text.Length -gt 512) { $text = $text.Substring(0, 509) + '...' }
        $text = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
        $text = [regex]::Replace($text, '[\x00-\x1f\x7f\x85\u2028\u2029]', ' ')
        if ($text.Length -gt 512) { $text = $text.Substring(0, 509) + '...' }
        return $text
    }

    function Get-Integer($parameters, [string] $name, [int] $default, [int] $minimum, [int] $maximum) {
        $value = Get-Argument $parameters $name $default
        if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt $minimum -or $value -gt $maximum) {
            Deny ('Invalid ' + $name + ' range.')
        }
        return [int]$value
    }

    function Get-TargetScreenshot($window, [int] $maxEdge) {
        Assert-Window $window
        $capture = [OwnedUia.Native]::Capture($window.Handle, $maxEdge)
        Assert-Window $window
        $bounds = $capture.Bounds
        $screenshot = @{
            id = [Guid]::NewGuid().ToString('N')
            data = $capture.Data; mimeType = 'image/png'
            width = $capture.Width; height = $capture.Height
            bounds = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
            scaleX = $capture.Width / [double]$bounds.Width
            scaleY = $capture.Height / [double]$bounds.Height
            dpi = $bounds.Dpi
        }
        # Retain only geometry/token, not the potentially large PNG, on this exact root.
        $window.Screenshot = @{
            id = $screenshot.id; width = $screenshot.width; height = $screenshot.height
            bounds = $screenshot.bounds; scaleX = $screenshot.scaleX; scaleY = $screenshot.scaleY; dpi = $screenshot.dpi
        }
        return $screenshot
    }

    function Assert-Screenshot($window, $parameters) {
        Assert-Window $window
        $id = Get-Argument $parameters 'screenshot'
        $shot = $window.Screenshot
        if ($id -isnot [string] -or $null -eq $shot -or $id -cne $shot.id) {
            Deny 'Unknown screenshot token for this window; request a new screenshot.'
        }
        try {
            $current = [OwnedUia.Native]::GetCaptureBounds($window.Handle)
            if ($current.X -ne $shot.bounds.x -or $current.Y -ne $shot.bounds.y -or
                $current.Width -ne $shot.bounds.width -or $current.Height -ne $shot.bounds.height -or
                $current.Dpi -ne $shot.dpi) {
                Deny 'Screenshot target moved, resized or changed DPI; request a new screenshot.'
            }
        } catch {
            $window.Screenshot = $null
            throw
        }
        return $shot
    }

    function Get-ScreenshotPoint($window, $parameters) {
        $shot = Assert-Screenshot $window $parameters
        $x = Get-Integer $parameters 'x' -1 0 ($shot.width - 1)
        $y = Get-Integer $parameters 'y' -1 0 ($shot.height - 1)
        # Screenshot pixels -> physical desktop pixels. Use separate rounded-axis scales:
        # bounds.x + floor(x / scaleX), bounds.y + floor(y / scaleY).
        return [OwnedUia.Native+POINT]::new(
            ($shot.bounds.x + [int][Math]::Floor($x / $shot.scaleX)),
            ($shot.bounds.y + [int][Math]::Floor($y / $shot.scaleY)))
    }

    # The complete cache allowlist. Never add values, readOnly, text or patterns:
    # those require current, password-guarded reads after this metadata is available.
    function Get-TreeProperties {
        return [ordered]@{
            Type = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
            Name = [System.Windows.Automation.AutomationElement]::NameProperty
            AutomationId = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
            Enabled = [System.Windows.Automation.AutomationElement]::IsEnabledProperty
            Offscreen = [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
            Password = [System.Windows.Automation.AutomationElement]::IsPasswordProperty
            ValueAvailable = [System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty
            ToggleAvailable = [System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty
            TextAvailable = [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty
            ScrollItemAvailable = [System.Windows.Automation.AutomationElement]::IsScrollItemPatternAvailableProperty
            ScrollAvailable = [System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty
            ExpandCollapseAvailable = [System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty
            InvokeAvailable = [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty
            SelectionItemAvailable = [System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty
            ToggleState = [System.Windows.Automation.TogglePattern]::ToggleStateProperty
        }
    }

    function New-TreeCacheRequest($properties) {
        $cache = New-Object System.Windows.Automation.CacheRequest
        $cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
        $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
        $cache.TreeFilter = [System.Windows.Automation.Condition]::TrueCondition
        foreach ($property in $properties.Values) { $cache.Add($property) }
        return $cache
    }

    function Read-TreeProperties($window, $element, $properties, $metrics, $clock, [bool] $UseCache = $true) {
        $values = @{}
        if ($UseCache) {
            try {
                foreach ($entry in $properties.GetEnumerator()) {
                    Assert-TreeBudget $clock
                    $values[$entry.Key] = $element.GetCachedPropertyValue($entry.Value, $true)
                }
                $metrics.cached++
                return $values
            } catch { } # Per-node/provider fallback, not an all-or-nothing snapshot.
        }
        $metrics.fallback++
        foreach ($entry in $properties.GetEnumerator()) {
            try {
                $values[$entry.Key] = Read-Property $window $element $entry.Value -Verified -Clock $clock
            } catch {
                Assert-TreeBudget $clock
                # Keep the original fail-closed handling for unknown password
                # flags, and tolerate unavailable optional pattern metadata.
                if ($entry.Key -in @('Type', 'Name', 'AutomationId', 'Enabled', 'Offscreen')) { throw }
                $values[$entry.Key] = $null
            }
        }
        return $values
    }

    function Get-TreeChildren($element, $properties, $clock) {
        Assert-TreeBudget $clock
        try {
            # Build independently for each parent: construction failures must not
            # disable caching for other nodes/providers in this traversal.
            $cache = New-TreeCacheRequest $properties
            $pushed = $false
            try {
                $cache.Push()
                $pushed = $true
                # Raw Children enumeration is unchanged; the cache covers each
                # returned element, never a ControlView-filtered subtree.
                return ,$element.FindAll([System.Windows.Automation.TreeScope]::Children,
                    [System.Windows.Automation.Condition]::TrueCondition)
            } finally { if ($pushed) { $cache.Pop() } }
        } catch {
            # A provider may reject caching yet still support current reads.
            Assert-TreeBudget $clock
            return ,$element.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
        }
    }

    # Exact provider lookup supplements (never changes) the normal substring AND filters.
    # No Realize/ScrollIntoView here: placeholders are observations, not actions.
    function Get-ContainerLookup($window, $root, $filters, $clock) {
        $key = 'name'
        if ($filters.automationId.Length -gt 0) { $key = 'automationId' }
        if ($filters[$key].Length -eq 0) { return $null }
        $property = [System.Windows.Automation.AutomationElement]::NameProperty
        if ($key -eq 'automationId') { $property = [System.Windows.Automation.AutomationElement]::AutomationIdProperty }
        $pattern = Get-Pattern $window $root ([System.Windows.Automation.ItemContainerPattern]::Pattern) -Verified -Clock $clock
        if ($null -eq $pattern) { return $null }
        return @{ Pattern = $pattern; Property = $property; Key = $key; Value = $filters[$key] }
    }

    function Read-VirtualMetadata($element, $properties, $clock) {
        $metadata = @{}
        foreach ($key in @('Type', 'Name', 'AutomationId', 'Enabled', 'Offscreen', 'Password')) {
            Assert-TreeBudget $clock
            try { $metadata[$key] = $element.GetCurrentPropertyValue($properties[$key], $true) }
            catch { Assert-TreeBudget $clock; $metadata[$key] = $null }
        }
        # A virtualized placeholder can expose only Name/AutomationId. Never query
        # values or text, nor require enabled/visibility/type to be available.
        $metadata.ValueAvailable = $false
        $metadata.TextAvailable = $false
        $metadata.ToggleAvailable = $false
        return $metadata
    }

    # tree/find share the same bounded raw traversal and reference generations.
    function Get-OwnedTree($parameters, [switch] $Find, [switch] $Poll, $Clock = $null) {
        if ($Poll) { $window = Get-Window $parameters -Clock $Clock }
        else { $window = Get-Window $parameters }
        $publishWindow = $window
        if ($null -eq $window.PSObject.Properties['VirtualRefs']) { $window | Add-Member NoteProperty VirtualRefs @{} }
        if ($Poll) {
            # Missing/gone polls never retire the caller's existing generation.
            $window = $window.PSObject.Copy()
            $window.Refs = @{}
            $window.VirtualRefs = @{}
        }
        $window.Screenshot = $null
        # Root ancestry (including retry validation) shares the traversal deadline.
        if ($null -eq $clock) { $clock = [Diagnostics.Stopwatch]::StartNew() }
        $budgetMs = 20000
        if ($Poll) {
            $budgetMs = Get-Integer $parameters 'budgetMs' 1000 1 1000
            if ($null -eq $clock.PSObject.Properties['BudgetMs']) { $clock | Add-Member NoteProperty BudgetMs $budgetMs }
            if ($null -eq $clock.PSObject.Properties['RemainingNodes']) {
                $clock | Add-Member NoteProperty RemainingNodes (Get-Integer $parameters 'maxVisited' 1000 1 1000)
            }
        }
        try {
            $rootRef = Get-Argument $parameters 'root'
            $root = $window.Root
            if ($null -ne $rootRef) {
                if ($rootRef -isnot [string] -or -not $window.Refs.ContainsKey($rootRef)) {
                    Deny 'Unknown or stale root reference; call ui_tree without root.'
                }
                $root = $window.Refs[$rootRef]
                try { Assert-Element $window $root -Clock $clock }
                catch [TimeoutException] { Deny 'Tree traversal budget exhausted during root validation.' }
                catch { Deny 'Unknown or stale root reference; call ui_tree without root.' }
            }
            # Resolve and validate the old root before replacing its generation.
            $window.Refs = @{}
            $window.VirtualRefs = @{}
            $depthDefault = 8
            if ($Find) { $depthDefault = 30 }
            $depth = Get-Integer $parameters 'depth' $depthDefault 0 30
            $maxNodes = Get-Integer $parameters 'maxNodes' 300 1 1000
            $maxResults = Get-Integer $parameters 'maxResults' 20 1 100
            # Tree's node cap applies to the returned attempt; find has a hard
            # total visited cap, including unmatched nodes and any retry.
            $maxVisited = $maxNodes * 2
            $maxLines = $maxNodes
            if ($Find) { $maxVisited = 3000; $maxLines = $maxResults }
            if ($Poll) { $maxVisited = Get-Integer $parameters 'maxVisited' 1000 1 1000; $maxLines = 1 }
            $threshold = Get-Integer $parameters 'treeDensityThreshold' 12 0 1000
            $filters = @{}
            foreach ($key in @('name', 'role', 'automationId')) {
                $filter = Get-Argument $parameters $key
                if ($null -ne $filter -and ($filter -isnot [string] -or [string]::IsNullOrWhiteSpace($filter))) {
                    Deny 'Find filters must be nonempty strings.'
                }
                if ($key -eq 'role' -and $null -ne $filter -and $filter -notmatch '^[A-Za-z]+$') {
                    Deny "role must be a ControlType name without 'ControlType.'."
                }
                if ($null -eq $filter) { $filter = '' }
                $filters[$key] = $filter
            }
            if ($Find -and $filters.name.Length -eq 0 -and $filters.role.Length -eq 0 -and $filters.automationId.Length -eq 0) {
                Deny 'ui_find requires at least one of name, role or automationId.'
            }
            $includeScreenshot = Get-Argument $parameters 'screenshot' $false
            if ($includeScreenshot -isnot [bool]) { Deny 'screenshot must be a boolean.' }
            $maxEdge = Get-Integer $parameters 'screenshotMaxEdge' 1280 128 4096
            $screenshot = $null
            # Find never captures. A rooted tree still captures the whole target
            # window, once, before slow UIA reads; never focus or restore it.
            if (-not $Find -and $includeScreenshot) {
                Assert-TreeBudget $clock
                # Capture/startup overhead stays outside the cooperative UIA budget.
                $clock.Stop()
                try { $screenshot = Get-TargetScreenshot $window $maxEdge }
                finally { $clock.Start() }
            }
            $properties = Get-TreeProperties
            if ($Poll) {
                # Cheap presence checks never read value/text or action patterns.
                $cheapProperties = [ordered]@{}
                foreach ($key in @('Type', 'Name', 'AutomationId', 'Enabled', 'Offscreen', 'Password')) {
                    $cheapProperties[$key] = $properties[$key]
                }
                $properties = $cheapProperties
            }
            $metrics = @{ cached = 0; fallback = 0; visited = 0 }
            $class = New-Object Text.StringBuilder 256
            $null = [OwnedUia.Native]::GetClassName($window.Handle, $class, $class.Capacity)
            $chromium = $class.ToString().StartsWith('Chrome_WidgetWin_', [StringComparison]::Ordinal)
            $retried = $false
            do {
                Assert-Window $window
                if ($null -ne $rootRef) {
                    try { Assert-Element $window $root -Clock $clock }
                    catch [TimeoutException] { Deny 'Tree traversal budget exhausted during root validation.' }
                    catch { Deny 'Unknown or stale root reference; call ui_tree without root.' }
                }
                # Every attempt has its own refs; no first-pass or unmatched refs survive.
                $window.Refs = @{}
                $window.VirtualRefs = @{}
                $publishedContainer = New-Object System.Collections.Generic.List[object]
                $lines = New-Object System.Collections.Generic.List[string]
                $stack = New-Object System.Collections.Generic.Stack[object]
                $cachedRoot = $root
                $rootCacheReady = $false
                try {
                    Assert-TreeBudget $clock
                    $cache = New-TreeCacheRequest $properties
                    $cachedRoot = $root.GetUpdatedCache($cache)
                    $rootCacheReady = $true
                } catch { } # Never reuse a previous generation's cached root metadata.
                $stack.Push([pscustomobject]@{ Element = $cachedRoot; Depth = 0; Sibling = $false; Path = @(); ContainerItem = $false })
                $cut = $false
                $lookup = $null
                $containerAfter = $null
                $containerCount = 0
                if ($Find -and -not $Poll) {
                    try { $lookup = Get-ContainerLookup $window $root $filters $clock }
                    catch { $cut = $true }
                }
                $density = 0
                $chars = 0
                while ($stack.Count -gt 0 -or $null -ne $lookup) {
                    if ($metrics.visited -ge $maxVisited -or $clock.ElapsedMilliseconds -ge $budgetMs -or
                        $lines.Count -ge $maxLines) {
                        $cut = $true
                        break
                    }
                    if ($null -ne $lookup) {
                        # A new lookup may invalidate the preceding placeholder, even
                        # when it returns null. Consume this item before advancing.
                        if ($containerCount -ge $maxResults) { $cut = $true; $lookup = $null; continue }
                        try {
                            Assert-TreeBudget $clock
                            $element = $lookup.Pattern.FindItemByProperty($containerAfter, $lookup.Property, $lookup.Value)
                        } catch { $cut = $true; $lookup = $null; continue }
                        if ($null -eq $element) { $lookup = $null; continue }
                        $containerAfter = $element
                        $containerCount++
                        $item = [pscustomobject]@{ Element = $element; Depth = 1; Sibling = $false; Path = @(); ContainerItem = $true }
                    } else { $item = $stack.Pop(); $element = $item.Element }
                    # Queue fetched siblings before reading this node, including
                    # unreadable nodes. No additional call on their parent.
                    if ($item.Sibling) {
                        $siblings = $item.Siblings
                        $next = $item.Index + 1
                        if ($next -lt $siblings.Count) {
                            $stack.Push([pscustomobject]@{
                                Element = $siblings[$next]; Depth = $item.Depth; Sibling = $true
                                Siblings = $siblings; Index = $next; Path = $item.Path; ContainerItem = $false
                            })
                        }
                    }
                    if (-not $item.ContainerItem -and $publishedContainer.Count -gt 0) {
                        $duplicate = $false
                        try {
                            foreach ($candidate in $publishedContainer) {
                                Assert-TreeBudget $clock
                                try {
                                    if ([System.Windows.Automation.Automation]::Compare($candidate, $element)) { $duplicate = $true; break }
                                } catch [System.Windows.Automation.ElementNotAvailableException] { }
                                # Previously consumed virtual placeholders may now be invalid.

                            }
                        } catch { $cut = $true; break }
                        # Skip duplicate output, not its children (it may be a container).
                        if ($duplicate) { $item | Add-Member NoteProperty Duplicate $true }
                    }
                    if ($Poll) {
                        if ($clock.RemainingNodes -le 0) { $cut = $true; break }
                        $clock.RemainingNodes--
                    }
                    $metrics.visited++
                    $script:nextElement++
                    $ref = 'e' + $script:nextElement
                    $lineIndex = $lines.Count
                    $countedDensity = $false
                    try {
                        Assert-Window $window
                        $virtualized = $false
                        if ($item.ContainerItem) {
                            $virtualized = $null -ne (Get-Pattern $window $element ([System.Windows.Automation.VirtualizedItemPattern]::Pattern) -Verified -Clock $clock)
                        }
                        if ($virtualized) {
                            $metadata = Read-VirtualMetadata $element $properties $clock
                            # FindItemByProperty already proves this one exact predicate;
                            # placeholders need not expose the corresponding getter.
                            if ($metadata[$lookup.Key] -isnot [string]) { $metadata[$lookup.Key] = $lookup.Value }
                        }
                        else { $metadata = Read-TreeProperties $window $element $properties $metrics $clock -UseCache (-not $item.ContainerItem -and ($item.Depth -gt 0 -or $rootCacheReady)) }
                        if ($Poll) { $metadata.ValueAvailable = $false; $metadata.TextAvailable = $false; $metadata.ToggleAvailable = $false }
                        $type = $metadata.Type
                        $name = $metadata.Name
                        $automationId = $metadata.AutomationId
                        $enabled = $metadata.Enabled
                        $offscreen = $metadata.Offscreen
                        $password = $metadata.Password
                        $typeName = 'Unknown'
                        if ($type -is [System.Windows.Automation.ControlType]) {
                            $typeName = $type.ProgrammaticName.Replace('ControlType.', '')
                        }
                        # Density covers all readable visited nodes, not just find
                        # matches; unknown visibility counts conservatively.
                        if ($typeName -ne 'Window' -and $offscreen -ne $true) { $density++; $countedDensity = $true }
                        $matches = -not $Find -or (
                            ($filters.name.Length -eq 0 -or ($name -is [string] -and $name.IndexOf($filters.name, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -and
                            ($filters.role.Length -eq 0 -or ($type -is [System.Windows.Automation.ControlType] -and [string]::Equals($typeName, $filters.role, [StringComparison]::OrdinalIgnoreCase))) -and
                            ($filters.automationId.Length -eq 0 -or ($automationId -is [string] -and $automationId.IndexOf($filters.automationId, [StringComparison]::OrdinalIgnoreCase) -ge 0)))
                        if ($null -ne $item.PSObject.Properties['Duplicate']) { $matches = $false }
                        if ($matches) {
                            $enabledFlag = '?'
                            $offscreenFlag = '?'
                            if ($enabled -is [bool]) { $enabledFlag = ([string]$enabled).ToLowerInvariant() }
                            if ($offscreen -is [bool]) { $offscreenFlag = ([string]$offscreen).ToLowerInvariant() }
                            $line = ('{0}{1} {2} name="{3}" enabled={4} offscreen={5}' -f
                                ('  ' * $item.Depth), $ref, $typeName, (Escape-Field $name), $enabledFlag, $offscreenFlag)
                            if ($automationId -is [string] -and $automationId.Length -gt 0) {
                                $line += ' automationId="' + (Escape-Field $automationId) + '"'
                            }
                            if ($Find -and $item.Path.Count -gt 0) {
                                $line += ' path="' + (Escape-Field ([string]::Join(' > ', [string[]]$item.Path))) + '"'
                            }
                            if ($virtualized) { $line += ' virtualized=true' }
                            $passwordUnknown = $password -isnot [bool]
                            # Passwords and unknown Edit/Document flags never query
                            # current Value/Text patterns; neither is ever cached.
                            if ($password -is [bool] -and $password) { $line += ' password=true' }
                            elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document')) { $line += ' password=unknown' }
                            else {
                                $valuePattern = $null
                                if ($metadata.ValueAvailable -ne $false) {
                                    $valuePattern = Get-Pattern $window $element ([System.Windows.Automation.ValuePattern]::Pattern) -Verified -Clock $clock
                                }
                                if ($null -ne $valuePattern) {
                                    Assert-TreeBudget $clock
                                    $line += ' value="' + (Escape-Field $valuePattern.Current.Value) + '"'
                                    Assert-TreeBudget $clock
                                    $line += ' readonly=' + ([string]$valuePattern.Current.IsReadOnly).ToLowerInvariant()
                                } elseif ($typeName -in @('Document', 'Edit') -and $metadata.TextAvailable -ne $false) {
                                    $textPattern = Get-Pattern $window $element ([System.Windows.Automation.TextPattern]::Pattern) -Verified -Clock $clock
                                    if ($null -ne $textPattern) {
                                        Assert-TreeBudget $clock
                                        $range = $textPattern.DocumentRange
                                        Assert-TreeBudget $clock
                                        $line += ' text="' + (Escape-Field $range.GetText(512)) + '"'
                                    }
                                }
                            }
                            if ($metadata.ToggleAvailable -eq $true -and
                                $metadata.ToggleState -is [System.Windows.Automation.ToggleState]) {
                                $line += ' toggle=' + (Escape-Field $metadata.ToggleState)
                            }
                            Assert-TreeBudget $clock
                            # Reserve 100 characters for the cut note/newline.
                            if ($chars + $line.Length + 1 -gt 199900) { $cut = $true; break }
                            $window.Refs[$ref] = $element
                            if ($item.ContainerItem) { $publishedContainer.Add($element) }
                            if ($virtualized) {
                                $runtimeId = $null
                                try { Assert-TreeBudget $clock; $runtimeId = $element.GetRuntimeId() } catch { Assert-TreeBudget $clock }
                                $window.VirtualRefs[$ref] = @{ Container = $root; Property = $lookup.Key; Value = $lookup.Value;
                                    RuntimeId = $runtimeId; Name = $filters.name; Role = $filters.role; AutomationId = $filters.automationId }
                            }
                            $lines.Add($line)
                            $chars += $line.Length + 1
                        }
                        if (-not $item.ContainerItem -and $item.Depth -lt $depth -and $metrics.visited -lt $maxVisited -and
                            $lines.Count -lt $maxLines -and $clock.ElapsedMilliseconds -lt $budgetMs) {
                            $children = Get-TreeChildren $element $properties $clock
                            Assert-TreeBudget $clock
                            if ($children.Count -gt 0) {
                                # Context only: no refs for unmatched ancestors, and
                                # never climb outside the requested traversal root.
                                $path = @($item.Path) + @($typeName + ' ' + (Escape-Field $name))
                                if ($path.Count -gt 3) { $path = @($path[($path.Count - 3)..($path.Count - 1)]) }
                                $stack.Push([pscustomobject]@{
                                    Element = $children[0]; Depth = $item.Depth + 1; Sibling = $true
                                    Siblings = $children; Index = 0; Path = $path; ContainerItem = $false
                                })
                            }
                        } elseif (-not $item.ContainerItem) { $cut = $true }
                    } catch {
                        if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }
                        $window.Refs.Remove($ref)
                        $window.VirtualRefs.Remove($ref)
                        if ($countedDensity) { $density-- }
                        # Provider errors reveal no details or matching ref. A tree
                        # retains its unreadable marker; find returns matches only.
                        if ($lines.Count -gt $lineIndex) {
                            $chars -= $lines[$lineIndex].Length + 1
                            $lines.RemoveAt($lineIndex)
                        }
                        if (-not $Find) {
                            $unreadable = ('{0}{1} unreadable' -f ('  ' * $item.Depth), $ref)
                            if ($chars + $unreadable.Length + 1 -gt 199900) { $cut = $true; break }
                            $lines.Add($unreadable)
                            $chars += $unreadable.Length + 1
                        }
                        $cut = $true
                    }
                }
                $chromiumSparse = $chromium -and $density -lt $threshold
                if (-not $Poll -and $chromiumSparse -and -not $retried -and $metrics.visited -lt $maxVisited -and
                    $clock.ElapsedMilliseconds -lt 19500) {
                    # One Chromium accessibility warm-up retry, inside the SAME
                    # 20 s and visited-node budgets (no focus/flags/messages).
                    Start-Sleep -Milliseconds 500
                    $retried = $true
                    continue
                }
                break
            } while ($true)
            Assert-Window $window
            $nodes = $lines.Count
            if ($cut) { $lines.Add('[cut: node/character/time/result limit or unreadable node]') }
            $text = [string]::Join("`n", $lines.ToArray())
            $result = @{ text = $text; nodes = $nodes; chars = $text.Length;
                ms = $clock.ElapsedMilliseconds; cut = $cut; cached = $metrics.cached;
                fallback = $metrics.fallback; retried = [bool]$retried; chromiumSparse = [bool]$chromiumSparse;
                visited = $metrics.visited; density = $density }
            if (-not $Find -and $includeScreenshot) { $result.screenshot = $screenshot }
            if ($Poll -and $nodes -gt 0 -and (Get-Argument $parameters 'publish' $true)) {
                $publishWindow.Refs = $window.Refs
                $publishWindow.VirtualRefs = $window.VirtualRefs
                $publishWindow.Screenshot = $null
            }
            return $result
        } catch {
            $window.Refs = @{}
            $window.VirtualRefs = @{}
            $window.Screenshot = $null
            throw
        }
    }

    # Exactly one cooperative poll. TS owns all sleeps, deadlines and cancellation.
    function Get-WaitPoll($parameters) {
        $windowRef = Get-Argument $parameters 'window'
        $title = Get-Argument $parameters 'title'
        $hasWindow = $null -ne $parameters.PSObject.Properties['window']
        $hasTitle = $null -ne $parameters.PSObject.Properties['title']
        if ($hasWindow -eq $hasTitle) { Deny 'Use either window or title for wait_poll.' }
        $number = 0L
        if ($hasWindow -and ($windowRef -isnot [string] -or $windowRef -notmatch '^[1-9][0-9]*$' -or
            -not [long]::TryParse($windowRef, [ref]$number))) { Deny 'Invalid native window handle; use ui_windows.' }
        if ($hasTitle -and ($title -isnot [string] -or [string]::IsNullOrWhiteSpace($title))) {
            Deny 'title must be a nonempty window filter.'
        }
        $publish = Get-Argument $parameters 'publish' $true
        if ($publish -isnot [bool]) { Deny 'publish must be a boolean.' }
        $budgetMs = Get-Integer $parameters 'budgetMs' 1000 1 1000
        $maxVisited = Get-Integer $parameters 'maxVisited' 1000 1 1000
        $query = @{}
        foreach ($key in @('name', 'role', 'automationId')) {
            if ($null -eq $parameters.PSObject.Properties[$key]) { continue }
            $value = Get-Argument $parameters $key
            if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { Deny 'Wait filters must be nonempty strings.' }
            if ($key -eq 'role' -and $value -notmatch '^[A-Za-z]+$') { Deny "role must be a ControlType name without 'ControlType.'." }
            $query[$key] = $value
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $clock | Add-Member NoteProperty BudgetMs $budgetMs
        $clock | Add-Member NoteProperty RemainingNodes $maxVisited
        $cut = $false
        $candidates = @($windowRef)
        if ($hasTitle) {
            # Identical case-insensitive identifier/title substring matching to ui_windows.
            try {
                $listing = Get-Windows ([pscustomobject]@{ filter = $title }) -Clock $clock
                $cut = $listing.incomplete
                $candidates = @($listing.windows | ForEach-Object { $_.window })
            } catch {
                if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }
                return @{ found = $false; cut = $true }
            }
        }
        $elementMode = $query.Count -gt 0
        foreach ($candidate in $candidates) {
            $windowRef = [string]$candidate
            $handle = [IntPtr]::new([long]$windowRef)
            $validatedWindow = $false
            try {
                Assert-TreeBudget $clock
                if (-not [OwnedUia.Native]::IsWindow($handle)) { continue }
                Assert-TreeBudget $clock
                if ([OwnedUia.Native]::GetAncestor($handle, 2) -ne $handle) { Deny 'Target is not a top-level window; use ui_windows.' }
                $validatedWindow = $true
                if (-not $elementMode) { return @{ found = $true; cut = $cut; window = $windowRef } }
                if ($clock.RemainingNodes -le 0) { $cut = $true; break }
                $query.window = $windowRef
                $query.publish = $publish
                $query.budgetMs = $budgetMs
                $query.maxVisited = $clock.RemainingNodes
                $query.maxResults = 1
                $query.screenshot = $false
                $tree = Get-OwnedTree ([pscustomobject]$query) -Find -Poll -Clock $clock
                $cut = $cut -or $tree.cut
                if ($tree.nodes -gt 0) {
                    $result = @{ found = $true; cut = $cut; window = $windowRef }
                    if ($publish) { $result.element = $tree }
                    return $result
                }
            } catch {
                if (-not $validatedWindow -and $_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }
                # A provider failure/overrun or window disappearing mid-query is
                # unknown, never evidence of absence. The next poll may prove gone.
                $cut = $true
            }
        }
        return @{ found = $false; cut = $cut }
    }

    # A modal provider may block its calling thread until the dialog closes. Dispatch
    # on a typed background MTA thread, with a bounded wait; never kill apps on timeout.
    function Invoke-BoundedPattern($window, $element, $pattern, [string] $action, [string] $path, [string] $text = '', $Virtual = $null) {
        Assert-ActionWindow $window
        if ($null -ne $Virtual) {
            if ($null -eq $Virtual.RuntimeId -or @($Virtual.RuntimeId).Count -eq 0) {
                Deny 'Placeholder identity cannot be verified without a runtime ID; run ui_find again and act on the fresh ref. No replacement item was selected.'
            }
            Assert-Element $window $Virtual.Container
            $reference = New-Object 'OwnedUia.PatternCall+ItemReference'
            foreach ($key in @('Container', 'Property', 'Value', 'RuntimeId', 'Name', 'Role', 'AutomationId')) { $reference.$key = $Virtual[$key] }
            $call = [OwnedUia.PatternCall]::Run($pattern, $action, $text, $element, $window.Root,
                $window.Handle, $window.Identity.Pid, $window.Identity.Started, $reference)
            if ($call.Completed -and -not $call.Failed) { $Virtual.Element = $call.Element }
        } else {
            Assert-Element $window $element
            $call = [OwnedUia.PatternCall]::Run($pattern, $action, $text, $element, $window.Root,
                $window.Handle, $window.Identity.Pid, $window.Identity.Started)
        }
        if ($call.Completed -and $call.Failed) { Deny 'Pattern action failed or target could not be verified.' }
        $result = @{ path = $path }
        if ($null -ne $call.VerticalScrollPercent) { $result.verticalPercent = $call.VerticalScrollPercent }
        if (-not $call.Completed) {
            if ($action -eq 'focus') { Deny 'Element focus timed out; input was not sent.' }
            $result.instruction = 'action timed out; it may still be running or the target may be busy - use ui_windows'
        }
        return $result
    }

    function Invoke-CoordinateInput($window, $parameters, [string] $kind) {
        Assert-ActionWindow $window
        if ($null -ne (Get-Argument $parameters 'ref')) { Deny 'Use ref or screenshot coordinates, not both.' }
        $delta = 0
        if ($kind -eq 'scroll') {
            $delta = Get-Integer $parameters 'delta' 0 -10 10
            if ($delta -eq 0) { Deny 'Scroll delta must be nonzero wheel notches.' }
        }
        $nativePoint = Get-ScreenshotPoint $window $parameters
        Show-Action $window $window.Root $kind $kind $nativePoint
        # Animation can take seconds. Revalidate before focusing; never restore stale pixels.
        $null = Assert-Screenshot $window $parameters
        Focus-Window $window -NoRestore
        $null = Assert-Screenshot $window $parameters
        Assert-NoHeldModifiers
        Assert-ClickPoint $window $nativePoint
        if (-not [OwnedUia.Native]::SetCursorPos($nativePoint.X, $nativePoint.Y)) {
            Deny 'Pointer could not be positioned.'
        }
        $null = Assert-Screenshot $window $parameters
        $actualPoint = [OwnedUia.Native+POINT]::new(0, 0)
        if (-not [OwnedUia.Native]::GetCursorPos([ref]$actualPoint) -or
            $actualPoint.X -ne $nativePoint.X -or $actualPoint.Y -ne $nativePoint.Y) {
            Deny 'Pointer moved before input; coordinate action refused.'
        }
        Assert-ClickPoint $window $actualPoint
        Assert-NoHeldModifiers
        if (([int][OwnedUia.Native]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) { Deny 'Release the mouse button before sending input.' }
        if ($kind -eq 'scroll') {
            if (-not [OwnedUia.Native]::Wheel($delta)) { Deny 'Wheel input was refused.' }
        } else {
            if (-not [OwnedUia.Native]::Click()) { Deny 'Pointer input was refused.' }
        }
        return @{ path = 'SendInput'; screenshot = (Get-Argument $parameters 'screenshot') }
    }

    # Ref itself plus at most five parent levels, never the parent of our root.
    function Get-ScrollPattern($window, $element) {
        $cursor = $element
        for ($level = 0; $level -le 5 -and $null -ne $cursor; $level++) {
            Assert-Element $window $cursor
            $pattern = Get-Pattern $window $cursor ([System.Windows.Automation.ScrollPattern]::Pattern)
            if ($null -ne $pattern) {
                return @{ Element = $cursor; Pattern = $pattern; Ancestor = $level }
            }
            if ($level -eq 5 -or [System.Windows.Automation.Automation]::Compare($cursor, $window.Root)) { break }
            $cursor = $script:walker.GetParent($cursor)
        }
        Deny 'No vertically scrollable ScrollPattern on the ref or within five parent levels.'
    }

    function Invoke-OwnedScroll($parameters) {
        # Presence, not truthiness: null/false/mixed forms must never fall through to mouse input.
        $hasRef = $null -ne $parameters.PSObject.Properties['ref']
        $hasInto = $null -ne $parameters.PSObject.Properties['into']
        $hasDelta = $null -ne $parameters.PSObject.Properties['delta']
        $coordinates = @('screenshot', 'x', 'y') | Where-Object { $null -ne $parameters.PSObject.Properties[$_] }
        if ($hasRef) {
            if (@($coordinates).Count -gt 0) { Deny 'Use ref or screenshot coordinates, not both.' }
            if ($hasInto) {
                $into = Get-Argument $parameters 'into'
                if ($into -isnot [bool] -or -not $into -or $hasDelta) { Deny 'Use ref with either delta or into:true.' }
            } elseif (-not $hasDelta) { Deny 'Use ref with either delta or into:true.' }
        } elseif ($hasInto -or @($coordinates).Count -ne 3 -or -not $hasDelta) {
            Deny 'Use ref with delta/into:true, or screenshot/x/y with delta.'
        }
        $delta = 0
        if ($hasDelta) {
            if ($null -eq (Get-Argument $parameters 'delta')) { Deny 'Scroll delta must be nonzero wheel notches.' }
            $delta = Get-Integer $parameters 'delta' 0 -10 10
            if ($delta -eq 0) { Deny 'Scroll delta must be nonzero wheel notches.' }
        }
        $window = Get-Window $parameters
        Assert-ActionWindow $window
        if (-not $hasRef) { return Invoke-CoordinateInput $window $parameters 'scroll' }
        $ref = Get-Argument $parameters 'ref'
        if ($ref -isnot [string] -or -not $window.Refs.ContainsKey($ref)) {
            Deny 'Unknown element reference; request a new tree.'
        }
        # Only provider-produced placeholders may Realize using their verified
        # source container as the worker's ancestry anchor: unrealized items can
        # reject even NativeWindowHandle/parent reads. No other action gets this
        # exception, and ScrollIntoView must validate the realized item itself.
        $element = $window.Refs[$ref]
        $anchor = $element
        $virtual = $hasInto -and $null -ne $window.PSObject.Properties['VirtualRefs'] -and $window.VirtualRefs.ContainsKey($ref)
        $provenance = $null
        if ($virtual) { $provenance = $window.VirtualRefs[$ref]; $anchor = $provenance.Container }
        Assert-Element $window $anchor
        Show-Action $window $anchor 'scroll' 'Scroll'
        if ($hasInto) {
            $steps = New-Object System.Collections.Generic.List[string]
            $pattern = $null
            if (-not $virtual) { $pattern = Get-Pattern $window $element ([System.Windows.Automation.VirtualizedItemPattern]::Pattern) }
            if ($virtual -or $null -ne $pattern) {
                $result = Invoke-BoundedPattern $window $element $pattern 'realize' 'VirtualizedItemPattern.Realize' -Virtual $provenance
                $steps.Add($result.path)
                if ($result.ContainsKey('instruction')) { $result.steps = @($steps.ToArray()); $result.path = 'scrollitem'; return $result }
                if ($virtual) { $element = $provenance.Element; $window.Refs[$ref] = $element }
            }
            $pattern = Get-Pattern $window $element ([System.Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -ne $pattern) {
                $result = Invoke-BoundedPattern $window $element $pattern 'scrollIntoView' 'ScrollItemPattern.ScrollIntoView'
                $steps.Add($result.path)
            } elseif ($steps.Count -eq 0) { Deny 'Ref supports neither VirtualizedItemPattern nor ScrollItemPattern.' }
            $result.steps = @($steps.ToArray())
            $result.path = 'scrollitem'
            return $result
        }
        $target = Get-ScrollPattern $window $element
        $result = Invoke-BoundedPattern $window $target.Element $target.Pattern 'scroll' 'scrollpattern' ([string]$delta)
        $result.ancestor = $target.Ancestor
        return $result
    }

    # click: prefer UIA patterns; fallback requires a verified target-window clickable point.
    function Invoke-OwnedClick($parameters) {
        $window = Get-Window $parameters
        Assert-ActionWindow $window
        if ($null -ne (Get-Argument $parameters 'screenshot') -or
            $null -ne (Get-Argument $parameters 'x') -or $null -ne (Get-Argument $parameters 'y')) {
            return Invoke-CoordinateInput $window $parameters 'click'
        }
        $element = Get-Element $window $parameters
        Show-Action $window $element 'click' 'Click'
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            return Invoke-BoundedPattern $window $element $pattern 'invoke' 'InvokePattern'
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            return Invoke-BoundedPattern $window $element $pattern 'toggle' 'TogglePattern'
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            return Invoke-BoundedPattern $window $element $pattern 'select' 'SelectionItemPattern'
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            $state = $pattern.Current.ExpandCollapseState
            Assert-Element $window $element
            if ($state -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) {
                return Invoke-BoundedPattern $window $element $pattern 'collapse' 'ExpandCollapsePattern'
            }
            elseif ($state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
                return Invoke-BoundedPattern $window $element $pattern 'expand' 'ExpandCollapsePattern'
            }
            else { Deny 'Element has no safe expand/collapse action.' }
        }
        if ((Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)) -ne $false) {
            Deny 'Element is offscreen.'
        }
        Focus-Window $window
        Assert-NoHeldModifiers
        Assert-Element $window $element
        $point = $element.GetClickablePoint()
        if ([double]::IsNaN($point.X) -or [double]::IsNaN($point.Y) -or
            [double]::IsInfinity($point.X) -or [double]::IsInfinity($point.Y)) {
            Deny 'Element has no safe clickable point.'
        }
        $nativePoint = [OwnedUia.Native+POINT]::new([int][Math]::Round($point.X), [int][Math]::Round($point.Y))
        Assert-ClickPoint $window $nativePoint
        if (-not [OwnedUia.Native]::SetCursorPos($nativePoint.X, $nativePoint.Y)) {
            Deny 'Pointer could not be positioned.'
        }
        Assert-Element $window $element
        if ((Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)) -ne $false) {
            Deny 'Element is offscreen.'
        }
        $actualPoint = [OwnedUia.Native+POINT]::new(0, 0)
        if (-not [OwnedUia.Native]::GetCursorPos([ref]$actualPoint) -or
            $actualPoint.X -ne $nativePoint.X -or $actualPoint.Y -ne $nativePoint.Y) {
            Deny 'Pointer moved before input; click refused.'
        }
        Assert-ClickPoint $window $actualPoint
        if (([int][OwnedUia.Native]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) { Deny 'Release the mouse button before clicking.' }
        if (-not [OwnedUia.Native]::Click()) { Deny 'Pointer input was refused.' }
        return @{ path = 'SendInput' }
    }

    function Assert-ClickPoint($window, $point) {
        Assert-Foreground $window
        $hit = [OwnedUia.Native]::WindowFromPoint($point)
        if ($hit -eq [IntPtr]::Zero -or
            [OwnedUia.Native]::GetAncestor($hit, 2) -ne $window.Handle) {
            Deny 'Clickable point is obscured or outside the target window.'
        }
        # Last foreground check immediately before input, after the hit test.
        Assert-Foreground $window
    }

    # type: use writable ValuePattern, otherwise focused Unicode input in the target window.
    function Set-OwnedText($parameters) {
        $window = Get-Window $parameters
        Assert-ActionWindow $window
        $element = Get-Element $window $parameters -Optional
        $text = Get-Argument $parameters 'text'
        if ($text -isnot [string] -or $text.Length -gt 20000) { Deny 'Text must be a string of at most 20000 characters.' }
        Show-Action $window $element 'type' 'Typing'
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            if ($pattern.Current.IsReadOnly) { Deny 'Element value is read-only.' }
            Assert-Element $window $element
            $result = Invoke-BoundedPattern $window $element $pattern 'value' 'ValuePattern.SetValue' $text
            $result.chars = $text.Length
            return $result
        }
        $exact = $null -ne (Get-Argument $parameters 'ref')
        if ($exact) { Focus-Element $window $element $true }
        else {
            # Without a ref, retain the target window's currently focused control.
            # A top-level Window provider need not itself be keyboard-focusable.
            Focus-Window $window
            Assert-NativeFocus $window
        }
        Assert-NoHeldModifiers
        for ($offset = 0; $offset -lt $text.Length; $offset += 64) {
            $chunk = $text.Substring($offset, [Math]::Min(64, $text.Length - $offset))
            Assert-Element $window $element
            Assert-NoHeldModifiers
            if ($exact -and
                (Read-Property $window $element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)) -ne $true) {
                Deny 'Element lost keyboard focus.'
            }
            Assert-NativeFocus $window
            if (-not [OwnedUia.Native]::Unicode($chunk)) { Deny 'Text input was refused.' }
        }
        return @{ path = 'SendInput'; chars = $text.Length }
    }

    # key: validated chord, forbidden closing/system keys, guarded focus and modifier release.
    function Send-OwnedKey($parameters) {
        $window = Get-Window $parameters
        Assert-ActionWindow $window
        $chord = Get-Argument $parameters 'keys'
        if ($chord -isnot [string]) { Deny 'Key must be a single chord.' }
        $parts = @($chord.ToLowerInvariant().Split('+') | ForEach-Object { $_.Trim() })
        # Reject forbidden chords before interpreting order/case; win is never a key.
        if (($parts -contains 'alt' -and ($parts -contains 'f4' -or $parts -contains 'tab' -or $parts -contains 'escape')) -or
            ($parts -contains 'ctrl' -and $parts -contains 'escape')) {
            Deny 'System/window-management shortcuts are not permitted.'
        }
        if ($parts.Count -lt 1 -or $parts.Count -gt 4) { Deny 'Key must be a single chord.' }
        $modifierCodes = @{ ctrl = 0x11; alt = 0x12; shift = 0x10 }
        $modifiers = New-Object System.Collections.Generic.List[int]
        $seen = @{}
        for ($i = 0; $i -lt $parts.Count - 1; $i++) {
            $modifier = $parts[$i]
            if (-not $modifierCodes.ContainsKey($modifier) -or $seen.ContainsKey($modifier)) {
                Deny 'Invalid or duplicate key modifier.'
            }
            $seen[$modifier] = $true
            $modifiers.Add($modifierCodes[$modifier])
        }
        $key = $parts[$parts.Count - 1]
        $keys = @{ enter = 0x0D; tab = 0x09; escape = 0x1B; left = 0x25; up = 0x26;
            right = 0x27; down = 0x28; home = 0x24; end = 0x23; delete = 0x2E; backspace = 0x08;
            space = 0x20; pageup = 0x21; pagedown = 0x22 }
        $code = 0
        if ($keys.ContainsKey($key)) { $code = $keys[$key] }
        elseif ($key -cmatch '^[a-z0-9]$') { $code = [int][char]$key.ToUpperInvariant() }
        elseif ($key -cmatch '^f([1-9]|1[0-2])$') { $code = 0x70 + [int]$key.Substring(1) - 1 }
        else { Deny 'Key is not allowlisted.' }

        Show-Action $window $window.Root 'key' $chord
        $elementRef = Get-Argument $parameters 'ref'
        $element = $null
        if ($null -ne $elementRef) {
            $element = Get-Element $window $parameters
            Focus-Element $window $element $true
        } else { Focus-Window $window }
        Assert-NoHeldModifiers
        Assert-NativeFocus $window
        if ($null -ne $element) {
            Assert-Element $window $element
            if ((Read-Property $window $element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)) -ne $true) {
                Deny 'Element lost keyboard focus.'
            }
        }
        if (([int][OwnedUia.Native]::GetAsyncKeyState($code) -band 0x8000) -ne 0) { Deny 'Release the target key before sending input.' }
        Assert-NoHeldModifiers
        Assert-NativeFocus $window
        if (-not [OwnedUia.Native]::Chord([uint16[]]$modifiers.ToArray(), [uint16]$code)) { Deny 'Key input was refused.' }
        return @{ path = 'SendInput' }
    }

    function Request-WindowClose($window) {
        Assert-ActionWindow $window
        try {
            $pattern = Get-Pattern $window $window.Root ([System.Windows.Automation.WindowPattern]::Pattern)
            if ($null -ne $pattern) {
                Assert-Element $window $window.Root
                $null = Invoke-BoundedPattern $window $window.Root $pattern 'close' 'WindowPattern.Close'
                return 'WindowPattern.Close'
            }
        } catch {
            $exception = $_.Exception
            while ($exception -is [System.Management.Automation.MethodInvocationException] -and
                $null -ne $exception.InnerException) {
                $exception = $exception.InnerException
            }
            if ($exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }
        }
        # A provider call may have blocked before throwing; revalidate before native fallback.
        Assert-ActionWindow $window
        # Asynchronous WM_CLOSE, never WM_QUIT or an image-name/process sweep.
        if ([OwnedUia.Native]::PostMessage($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { return 'WM_CLOSE' }
        Deny 'Close request was refused.'
    }

    # close: a polite window request only, including launched apps that ignore it.
    function Close-OwnedWindow($parameters) {
        $window = Get-Window $parameters
        Assert-ActionWindow $window
        Show-Action $window $window.Root 'close' 'Close'
        $path = Request-WindowClose $window
        Start-Sleep -Milliseconds 1000
        $closed = -not [OwnedUia.Native]::IsWindow($window.Handle) -or
            [OwnedUia.Native]::WindowPid($window.Handle) -ne $window.Identity.Pid -or
            (Test-IdentityGone $window.Identity)
        if ($closed) { $script:windows.Remove($window.Ref) }
        # Forget an exited launch identity, never a still-running app/window sibling.
        $key = $window.Identity.Key
        if ($script:processes.ContainsKey($key) -and (Test-IdentityGone $script:processes[$key])) {
            $script:processes.Remove($key)
        }
        Save-OwnedState
        $instruction = 'Window closed'
        if (-not $closed) { $instruction = 'Window is still open; a save prompt may have appeared.' }
        return @{ closed = $closed; path = $path; terminated = $false; instruction = $instruction }
    }

    while (-not $script:stopping) {
        Assert-Lifetime
        if ($script:queuedLines.Count -gt 0) { $line = $script:queuedLines.Dequeue() }
        else {
            $pending = Get-PendingRead
            while (-not $pending.IsCompleted) {
                if ($null -ne $script:lifetime -and -not (Test-Identity $script:lifetime)) {
                    $script:stopping = $true
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            if ($script:stopping) { break }
            Assert-Lifetime
            $line = Receive-PendingLine
        }
        if ($null -eq $line) { break }
        $id = $null
        $method = ''
        $parameters = $null
        $targetRef = $null
        try {
            $request = $line | ConvertFrom-Json
            if ($null -eq $request -or $request -isnot [pscustomobject]) { Deny 'Request must be a JSON object.' }
            # Late animation acknowledgements are protocol events, not RPC requests.
            if ((Get-Argument $request 'method') -ceq 'job_ack') { Close-JobAck $request; continue }
            if ((Get-Argument $request 'method') -cin @('overlay_ack', 'root_ack', 'writer_ack')) { continue }
            $id = Get-Argument $request 'id'
            if ($null -eq $request.PSObject.Properties['id'] -or
                ($id -isnot [string] -and $id -isnot [int] -and $id -isnot [long])) {
                $id = $null
                Deny 'Request id must be a string or integer.'
            }
            $method = Get-Argument $request 'method'
            $parameters = Get-Argument $request 'params'
            if ($method -isnot [string] -or
                ($null -ne $parameters -and $parameters -isnot [pscustomobject])) {
                Deny 'Invalid method or params.'
            }
            $targetRef = Get-Argument $parameters 'window'
            if ($method -cin @('tree', 'find') -and $targetRef -is [string] -and $script:windows.ContainsKey($targetRef)) {
                # Clear coordinates before Get-Window too. Keep refs until the
                # optional root has been resolved/revalidated, or clear on error.
                $script:windows[$targetRef].Screenshot = $null
            }
            if ($method -in @('launch', 'click', 'scroll', 'type', 'key', 'focus', 'close')) {
                $script:overlayClass = [string](Get-Argument $parameters 'overlayClass' '')
                $script:overlayPid = [int](Get-Argument $parameters 'overlayPid' 0)
            }
            $result = switch -CaseSensitive ($method) {
                'windows' { Get-Windows $parameters; break }
                'launch' { Start-OwnedApp $parameters; break }
                'tree' { Get-OwnedTree $parameters; break }
                'find' { Get-OwnedTree $parameters -Find; break }
                'wait_poll' { Get-WaitPoll $parameters; break }
                'click' { Invoke-OwnedClick $parameters; break }
                'scroll' { Invoke-OwnedScroll $parameters; break }
                'type' { Set-OwnedText $parameters; break }
                'key' { Send-OwnedKey $parameters; break }
                'focus' {
                    $window = Get-Window $parameters
                    Show-Action $window $window.Root 'focus' 'Focus'
                    Focus-Window $window
                    @{ focused = $true }; break
                }
                'close' { Close-OwnedWindow $parameters; break }
                'desktop' { @{ interactive = [OwnedUia.Native]::InteractiveDesktop() }; break }
                'shutdown' { $script:stopping = $true; @{ shutdown = $true }; break }
                default { Deny 'Unknown method.' }
            }
            $reply = @{ id = $id; result = $result }
        } catch {
            if ($targetRef -is [string] -and $script:windows.ContainsKey($targetRef)) {
                $script:windows[$targetRef].Screenshot = $null
                if ($method -cin @('tree', 'find')) {
                    $script:windows[$targetRef].Refs = @{}
                    $script:windows[$targetRef].VirtualRefs = @{}
                }
            }
            $message = 'Operation failed or target could not be verified.'
            $exception = $_.Exception
            while ($exception -is [System.Management.Automation.MethodInvocationException] -and
                $null -ne $exception.InnerException) {
                $exception = $exception.InnerException
            }
            if ($exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) {
                $message = $exception.Message.Substring(10)
            }
            $reply = @{ id = $id; error = $message }
        }
        if ($method -in @('launch', 'click', 'scroll', 'type', 'key', 'focus', 'close')) {
            $writer.WriteLine((@{ event = 'done' } | ConvertTo-Json -Compress))
        }
        $writer.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
    }
} catch {
    # Startup/lifetime errors have no request id; never emit raw PowerShell errors.
    if (-not $script:stopping) {
        try {
            $message = 'Helper initialization or input failed.'
            if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) {
                $message = $_.Exception.Message.Substring(10)
            }
            $writer.WriteLine((@{ id = $null; error = $message } | ConvertTo-Json -Compress))
        } catch { }
    }
} finally {
    # Retirement/timeout is NOT session end. Retained watchdog handles preserve apps.
    foreach ($job in @($script:jobs.Values)) { if ($null -ne $job) { try { $job.Dispose() } catch { } } }
    # Do not dispose a StreamReader concurrently with a pending ReadLineAsync;
    # process exit closes the input handle and outstanding background read.
    try { $writer.Dispose() } catch { }
}
