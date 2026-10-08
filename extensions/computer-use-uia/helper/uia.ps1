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

# The watchdog, not a transient helper, owns session cleanup. Restart only reloads
# this client's authenticated records; it never kills apps or scans other journals.
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
    Add-Type -ReferencedAssemblies @('System.dll', [System.Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OwnedUia {
    public sealed class PatternCall {
        static int active;
        int dispatchState; // 0 pending, 1 dispatched, 2 cancelled; timeout and dispatch have one winner.
        public bool Completed { get; private set; }
        public bool Failed { get; private set; }
        public static PatternCall Run(object pattern, string action, string text,
            System.Windows.Automation.AutomationElement element,
            System.Windows.Automation.AutomationElement root, IntPtr window, int pid, long started) {
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
                            var cursor = element;
                            bool verified = false;
                            for (int i = 0; cursor != null && i < 128; i++) {
                                if (System.Windows.Automation.Automation.Compare(cursor, root)) { verified = true; break; }
                                object value = cursor.GetCurrentPropertyValue(
                                    System.Windows.Automation.AutomationElement.NativeWindowHandleProperty, true);
                                if (value is int && (int)value != 0 &&
                                    Native.GetAncestor(new IntPtr((int)value), 2) != window) throw new InvalidOperationException();
                                cursor = System.Windows.Automation.TreeWalker.RawViewWalker.GetParent(cursor);
                            }
                            if (!verified || target.HasExited || Native.CreationTime(handle) != started ||
                                Native.WindowPid(window) != pid || !System.Windows.Automation.Automation.Compare(root,
                                    System.Windows.Automation.AutomationElement.FromHandle(window))) throw new InvalidOperationException();
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
                                default: throw new InvalidOperationException();
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

    function Assert-Element($window, $element) {
        Assert-Window $window
        if ($null -eq $element) { Deny 'Element is unavailable.' }
        # Identity properties only until the entire ancestry is proven. Stop at
        # our FromHandle root; never ask for its parent (the desktop/foreign UIA).
        $cursor = $element
        for ($i = 0; $i -lt 128; $i++) {
            if ([System.Windows.Automation.Automation]::Compare($cursor, $window.Root)) {
                Assert-Window $window
                return
            }
            # A native child must also be inside this exact top-level HWND.
            $handleValue = $cursor.GetCurrentPropertyValue(
                [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, $true)
            if ($handleValue -is [int] -and $handleValue -ne 0) {
                $handle = [IntPtr]::new([long]$handleValue)
                if ([OwnedUia.Native]::GetAncestor($handle, 2) -ne $window.Handle) {
                    Deny 'Element is outside the target window.'
                }
            }
            $cursor = $script:walker.GetParent($cursor)
            if ($null -eq $cursor) { break }
        }
        Deny 'Element ancestry cannot be verified.'
    }

    function Assert-TreeBudget($clock) {
        if ($null -ne $clock -and $clock.ElapsedMilliseconds -ge 20000) {
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

    function Get-Window($parameters) {
        $ref = Get-Argument $parameters 'window'
        $number = 0L
        if ($ref -isnot [string] -or -not [long]::TryParse($ref, [ref]$number) -or $number -le 0) {
            Deny 'Invalid native window handle; use ui_windows.'
        }
        $handle = [IntPtr]::new($number)
        if (-not [OwnedUia.Native]::IsWindow($handle) -or [OwnedUia.Native]::GetAncestor($handle, 2) -ne $handle) {
            Deny 'Target is not a top-level window; use ui_windows.'
        }
        $identity = Get-Identity ([OwnedUia.Native]::WindowPid($handle))
        if ($null -eq $identity) { Deny 'Target process is inaccessible or exited.' }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($script:windows.ContainsKey($ref)) {
            $window = $script:windows[$ref]
            $sameRoot = $false
            try { $sameRoot = [System.Windows.Automation.Automation]::Compare($window.Root, $root) } catch { }
            if ($window.Identity.Key -eq $identity.Key -and $sameRoot) {
                Assert-Window $window
                return $window
            }
            # HWND reuse, even in the same process, invalidates the root and every ref.
            $script:windows.Remove($ref)
        }
        $window = [pscustomobject]@{
            Ref = $ref; Handle = $handle; Identity = $identity
            Root = $root; Refs = @{}
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

    function Get-Windows($parameters) {
        $filter = Get-Argument $parameters 'filter' ''
        if ($filter -isnot [string]) { Deny 'Filter must be a substring.' }
        $matches = New-Object System.Collections.Generic.List[object]
        $cut = $false
        foreach ($native in [OwnedUia.Native]::Windows()) {
            if (-not $native.Visible) { continue }
            $info = Get-WindowInfo $native
            # Filter against the full native title; truncate only the returned text.
            $filterTitle = New-Object Text.StringBuilder 4096
            $null = [OwnedUia.Native]::GetWindowText($native.Handle, $filterTitle, $filterTitle.Capacity)
            $search = $info.window + ' ' + $filterTitle.ToString() + ' ' + $info.process + ' ' + $info.pid + ' ' + $info.class
            if ($search.IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                if ($matches.Count -ge 200) { $cut = $true; break }
                if ($info.titleCut) { $cut = $true }
                $matches.Add($info)
            }
        }
        $result = @{ windows = @($matches.ToArray()); cut = $cut }
        if ($cut) { $result.note = '[cut: window list limited to 200 entries; titles limited to 120 characters]' }
        return $result
    }

    function Show-Action($window, $element, [string] $kind, [string] $label) {
        if ($null -ne $window) { Assert-ActionWindow $window }
        if ($Overlay -eq 'false') { return }
        $point = @{ X = 32; Y = 64 }
        if ($null -ne $window) {
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

    function Focus-Window($window) {
        Assert-ActionWindow $window
        if (-not [OwnedUia.Native]::InteractiveDesktop()) { Deny 'No interactive input desktop is available.' }
        if ([OwnedUia.Native]::IsIconic($window.Handle)) {
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
        # Quote every argv entry, doubling backslashes before quotes/the final quote.
        $escaped = [regex]::Replace($argument, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        return '"' + $escaped + '"'
    }

    function Close-JobAck($ack) {
        $job = Get-Argument $ack 'job'
        if ($job -isnot [string] -or $script:receivedJobAcks.ContainsKey($job)) { return }
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

    # tree: bounded snapshot with unique refs, cheap state/text and traversal metrics.
    function Get-OwnedTree($parameters) {
        $window = Get-Window $parameters
        $depth = Get-Integer $parameters 'depth' 8 0 30
        $maxNodes = Get-Integer $parameters 'maxNodes' 300 1 1000
        # Invalidate refs even if the subsequent snapshot fails.
        $window.Refs = @{}
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $lines = New-Object System.Collections.Generic.List[string]
        $stack = New-Object System.Collections.Generic.Stack[object]
        $stack.Push([pscustomobject]@{ Element = $window.Root; Depth = 0; Sibling = $false })
        $cut = $false
        try {
            while ($stack.Count -gt 0) {
                if ($lines.Count -ge $maxNodes -or $clock.ElapsedMilliseconds -ge 20000) {
                    $cut = $true
                    break
                }
                $item = $stack.Pop()
                $element = $item.Element
                # Queue already-fetched siblings first, so an unreadable node does
                # not prevent visiting the rest. No provider call on the parent.
                if ($item.Sibling) {
                    $siblings = $item.Siblings
                    $next = $item.Index + 1
                    if ($next -lt $siblings.Count) {
                        $stack.Push([pscustomobject]@{
                            Element = $siblings[$next]; Depth = $item.Depth; Sibling = $true
                            Siblings = $siblings; Index = $next
                        })
                    }
                }
                $script:nextElement++
                $ref = 'e' + $script:nextElement
                $lineIndex = $lines.Count
                try {
                    Assert-Window $window
                    # FindAll(Children) scopes this read to the target's UIA subtree.
                    # Include cross-process/pop-up providers; refs are revalidated before actions.
                    $type = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) -Verified -Clock $clock
                    $name = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::NameProperty) -Verified -Clock $clock
                    $automationId = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) -Verified -Clock $clock
                    $enabled = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty) -Verified -Clock $clock
                    $offscreen = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty) -Verified -Clock $clock
                    $typeName = 'Unknown'
                    if ($type -is [System.Windows.Automation.ControlType]) {
                        $typeName = $type.ProgrammaticName.Replace('ControlType.', '')
                    }
                    $enabledFlag = '?'
                    $offscreenFlag = '?'
                    if ($enabled -is [bool]) { $enabledFlag = ([string]$enabled).ToLowerInvariant() }
                    if ($offscreen -is [bool]) { $offscreenFlag = ([string]$offscreen).ToLowerInvariant() }
                    $line = ('{0}{1} {2} name="{3}" enabled={4} offscreen={5}' -f
                        ('  ' * $item.Depth), $ref, $typeName, (Escape-Field $name), $enabledFlag, $offscreenFlag)
                    if ($automationId -is [string] -and $automationId.Length -gt 0) {
                        $line += ' automationId="' + (Escape-Field $automationId) + '"'
                    }
                    $password = $null
                    try {
                        $password = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsPasswordProperty) -Verified -Clock $clock
                    } catch { Assert-TreeBudget $clock }
                    $passwordUnknown = $password -isnot [bool]
                    # Unknown is not a password flag for arbitrary controls, but text
                    # inputs/documents fail closed without querying Value/Text patterns.
                    if ($password -is [bool] -and $password) { $line += ' password=true' }
                    elseif ($passwordUnknown -and $typeName -in @('Edit', 'Document')) { $line += ' password=unknown' }
                    else {
                        $valuePattern = Get-Pattern $window $element ([System.Windows.Automation.ValuePattern]::Pattern) -Verified -Clock $clock
                        if ($null -ne $valuePattern) {
                            $line += ' value="' + (Escape-Field $valuePattern.Current.Value) + '"'
                            $line += ' readonly=' + ([string]$valuePattern.Current.IsReadOnly).ToLowerInvariant()
                        } elseif ($typeName -eq 'Document' -or $typeName -eq 'Edit') {
                            $textPattern = Get-Pattern $window $element ([System.Windows.Automation.TextPattern]::Pattern) -Verified -Clock $clock
                            if ($null -ne $textPattern) {
                                $line += ' text="' + (Escape-Field $textPattern.DocumentRange.GetText(512)) + '"'
                            }
                        }
                    }
                    $togglePattern = Get-Pattern $window $element ([System.Windows.Automation.TogglePattern]::Pattern) -Verified -Clock $clock
                    if ($null -ne $togglePattern) {
                        $line += ' toggle=' + (Escape-Field $togglePattern.Current.ToggleState)
                    }
                    Assert-TreeBudget $clock
                    $window.Refs[$ref] = $element
                    $lines.Add($line)
                    if ($item.Depth -lt $depth -and $lines.Count -lt $maxNodes -and $clock.ElapsedMilliseconds -lt 20000) {
                        # Children only, scoped to the target's UIA subtree.
                        $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children,
                            [System.Windows.Automation.Condition]::TrueCondition)
                        Assert-TreeBudget $clock
                        if ($children.Count -gt 0) {
                            $stack.Push([pscustomobject]@{
                                Element = $children[0]; Depth = $item.Depth + 1; Sibling = $true
                                Siblings = $children; Index = 0
                            })
                        }
                    } elseif ($item.Depth -lt $depth) { $cut = $true }
                } catch {
                    if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) { throw }
                    # Provider errors reveal no exception details and grant no ref.
                    $window.Refs.Remove($ref)
                    $unreadable = ('{0}{1} unreadable' -f ('  ' * $item.Depth), $ref)
                    if ($lines.Count -gt $lineIndex) { $lines[$lineIndex] = $unreadable }
                    else { $lines.Add($unreadable) }
                    $cut = $true
                }
            }
            $nodes = $lines.Count
            if ($cut) { $lines.Add('[cut: node/character/time limit or unreadable node]') }
            $text = [string]::Join("`n", $lines.ToArray())
            return @{ text = $text; nodes = $nodes; chars = $text.Length;
                ms = $clock.ElapsedMilliseconds; cut = $cut }
        } catch {
            $window.Refs = @{}
            throw
        }
    }

    # A modal provider may block its calling thread until the dialog closes. Dispatch
    # on a typed background MTA thread, with a bounded wait; never kill apps on timeout.
    function Invoke-BoundedPattern($window, $element, $pattern, [string] $action, [string] $path, [string] $text = '') {
        Assert-ActionWindow $window
        Assert-Element $window $element
        $call = [OwnedUia.PatternCall]::Run($pattern, $action, $text, $element, $window.Root,
            $window.Handle, $window.Identity.Pid, $window.Identity.Started)
        if ($call.Completed -and $call.Failed) { Deny 'Pattern action failed or target could not be verified.' }
        $result = @{ path = $path }
        if (-not $call.Completed) {
            if ($action -eq 'focus') { Deny 'Element focus timed out; input was not sent.' }
            $result.instruction = 'action timed out; it may still be running or the target may be busy - use ui_windows'
        }
        return $result
    }

    # click: prefer UIA patterns; fallback requires a verified target-window clickable point.
    function Invoke-OwnedClick($parameters) {
        $window = Get-Window $parameters
        Assert-ActionWindow $window
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
            if ($method -in @('launch', 'click', 'type', 'key', 'focus', 'close')) {
                $script:overlayClass = [string](Get-Argument $parameters 'overlayClass' '')
                $script:overlayPid = [int](Get-Argument $parameters 'overlayPid' 0)
            }
            $result = switch -CaseSensitive ($method) {
                'windows' { Get-Windows $parameters; break }
                'launch' { Start-OwnedApp $parameters; break }
                'tree' { Get-OwnedTree $parameters; break }
                'click' { Invoke-OwnedClick $parameters; break }
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
        if ($method -in @('launch', 'click', 'type', 'key', 'focus', 'close')) {
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
