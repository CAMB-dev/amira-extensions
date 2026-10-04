# Windows PowerShell 5.1; no UIA desktop/root enumeration and no shipped binaries.
# stdin/stdout are UTF-8 JSON lines. Only the app allowlist can start a process.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $AppsJson,
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted,
    [string] $StatePath
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
$script:windowGeneration = [Guid]::NewGuid().ToString('N')
$script:nextElement = 0
$script:self = $null
$script:lifetime = $null
$script:stopping = $false

function Deny([string] $message) {
    # Never expose provider exceptions, process paths, or unowned window titles.
    throw [System.InvalidOperationException]::new('UIA_SAFE: ' + $message)
}

function Get-Argument($object, [string] $name, $default = $null) {
    # Preserve JSON arrays (including zero/one-item args) across pipeline output.
    if ($null -eq $object) { return ,$default }
    $property = $object.PSObject.Properties[$name]
    if ($null -eq $property) { return ,$default }
    return ,$property.Value
}

function Get-Identity([int] $processId, [switch] $WithPath) {
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById($processId)
        # Open/cache the handle before reading StartTime. Do not trust a PID alone.
        $null = $process.Handle
        $started = $process.StartTime.ToUniversalTime().Ticks
        if ($process.HasExited) { return $null }
        $path = $null
        if ($WithPath) { $path = $process.MainModule.FileName }
        return [pscustomobject]@{
            Pid = $processId
            Started = $started
            Key = ('{0}:{1}' -f $processId, $started)
            Path = $path
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
        return ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$identity.Started)
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

function Stop-ExactProcess($identity) {
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::GetProcessById($identity.Pid)
        # Kill through this same cached handle, not a fresh lookup or image name.
        $null = $process.Handle
        if (-not $process.HasExited -and
            $process.StartTime.ToUniversalTime().Ticks -eq $identity.Started) {
            $process.Kill()
        }
    } catch {
        # Cleanup is best effort (the process may already have exited).
    } finally { if ($null -ne $process) { $process.Dispose() } }
}

# The private journal is written only from our launch records. The independent
# watchdog can reap these identities without UIA if this helper dies or blocks.
function Save-OwnedState {
    if ([string]::IsNullOrEmpty($StatePath)) { return }
    $records = @($script:processes.Values | ForEach-Object {
        @{ Pid = $_.Pid; Started = $_.Started.ToString() }
    })
    $state = @{
        Helper = @{ Pid = $script:self.Pid; Started = $script:self.Started.ToString() }
        Processes = $records
    } | ConvertTo-Json -Depth 4 -Compress
    [IO.File]::WriteAllText($StatePath + '.tmp', $state, $utf8)
    # PowerShell coerces $null to an empty string here; NullString supplies a real
    # null backup path to .NET rather than an invalid empty path.
    if ([IO.File]::Exists($StatePath)) { [IO.File]::Replace($StatePath + '.tmp', $StatePath, [NullString]::Value) }
    else { [IO.File]::Move($StatePath + '.tmp', $StatePath) }
}

try {
    $script:self = Get-Identity $PID
    if ($LifetimePid -lt 0) { Deny 'Invalid lifetime process.' }
    if ($LifetimePid -gt 0) {
        $script:lifetime = Get-Identity $LifetimePid
        if ($null -eq $script:lifetime -or $LifetimePid -eq $PID -or
            $script:lifetime.Started.ToString() -ne $LifetimeStarted) {
            Deny 'Lifetime process is unavailable or its identity changed.'
        }
    }
    if (-not [string]::IsNullOrEmpty($StatePath) -and [IO.File]::Exists($StatePath)) {
        # Restart cleans old launch identities, never adopts their windows or refs.
        $previous = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
        foreach ($identity in (@($previous.Helper) + @($previous.Processes))) {
            Stop-ExactProcess $identity
            if (-not (Test-IdentityGone $identity)) {
                # Never discard a failed kill or grant it a window/ref on restart.
                $record = [pscustomobject]@{
                    Pid = [int]$identity.Pid; Started = [long]$identity.Started
                    Key = ('{0}:{1}' -f $identity.Pid, $identity.Started); Path = $null
                }
                $script:processes[$record.Key] = $record
            }
        }
    }
    Save-OwnedState
    if ($script:processes.Count -gt 0) { Deny 'Previous launch cleanup is incomplete; no new apps launched.' }

    $apps = $AppsJson | ConvertFrom-Json
    if ($null -eq $apps -or $apps -isnot [pscustomobject]) {
        Deny 'AppsJson must be an app map.'
    }
    Add-Type -AssemblyName UIAutomationClient | Out-Null
    Add-Type -AssemblyName UIAutomationTypes | Out-Null
    Add-Type -AssemblyName UIAutomationClientsideProviders | Out-Null
    Add-Type -ReferencedAssemblies @('System.dll', [System.Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OwnedUia {
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

        // Native metadata only: never GetWindowText, MainWindowTitle, or UIA root.
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
        public static bool Key(ushort key, bool up) {
            var input = new INPUT();
            input.Type = 1;
            input.Data.Keyboard.Key = key;
            input.Data.Keyboard.Flags = up ? 2u : 0u;
            // Navigation keys use the extended-key flag.
            if ((key >= 0x21 && key <= 0x28) || key == 0x2E)
                input.Data.Keyboard.Flags |= 1u;
            return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
        }
        public static bool Unicode(string text) {
            var inputs = new INPUT[text.Length * 2];
            for (int i = 0; i < text.Length; i++) {
                inputs[i * 2].Type = inputs[i * 2 + 1].Type = 1;
                inputs[i * 2].Data.Keyboard.Scan = text[i];
                inputs[i * 2 + 1].Data.Keyboard.Scan = text[i];
                inputs[i * 2].Data.Keyboard.Flags = 4;
                inputs[i * 2 + 1].Data.Keyboard.Flags = 4 | 2;
            }
            if (inputs.Length == 0) return true;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length && (sent & 1) != 0) {
                // A partial insertion may have left the last Unicode key down.
                SendInput(1, new INPUT[] { inputs[sent] }, Marshal.SizeOf(typeof(INPUT)));
            }
            return sent == inputs.Length;
        }
        public static bool Mouse(bool up) {
            var input = new INPUT();
            input.Data.Mouse.Flags = up ? 4u : 2u;
            return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
        }
    }
}
'@ | Out-Null

    $proxies = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object {
        $_.GetName().Name -eq 'UIAutomationClientsideProviders'
    }
    [OwnedUia.Native]::InitializeProviders($proxies.GetName())
    $script:walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

    function Assert-Window($window) {
        Assert-Lifetime
        if (-not (Test-Identity $window.Identity) -or
            -not [OwnedUia.Native]::IsWindow($window.Handle) -or
            [OwnedUia.Native]::GetAncestor($window.Handle, 2) -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($window.Handle) -ne $window.Identity.Pid) {
            Deny 'Window ownership is no longer valid.'
        }
    }

    function Assert-Element($window, $element) {
        Assert-Window $window
        if ($null -eq $element) { Deny 'Element is unavailable.' }
        # Identity properties only until the entire ancestry is proven. Stop at
        # our FromHandle root; never ask for its parent (the desktop/foreign UIA).
        $cursor = $element
        for ($i = 0; $i -lt 128; $i++) {
            $elementPid = $cursor.GetCurrentPropertyValue(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $true)
            if ($elementPid -isnot [int] -or $elementPid -ne $window.Identity.Pid) {
                Deny 'Element is outside the owned window.'
            }
            if ([System.Windows.Automation.Automation]::Compare($cursor, $window.Root)) {
                Assert-Window $window
                return
            }
            # A native child must also be inside this exact top-level HWND.
            $handleValue = $cursor.GetCurrentPropertyValue(
                [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, $true)
            if ($handleValue -is [int] -and $handleValue -ne 0) {
                $handle = [IntPtr]::new([long]$handleValue)
                if ([OwnedUia.Native]::GetAncestor($handle, 2) -ne $window.Handle -or
                    [OwnedUia.Native]::WindowPid($handle) -ne $window.Identity.Pid) {
                    Deny 'Element is outside the owned window.'
                }
            }
            $cursor = $script:walker.GetParent($cursor)
            if ($null -eq $cursor) { break }
        }
        Deny 'Element ancestry cannot be verified.'
    }

    function Read-Property($window, $element, $property) {
        Assert-Element $window $element
        return $element.GetCurrentPropertyValue($property, $true)
    }

    function Get-Pattern($window, $element, $patternId) {
        Assert-Element $window $element
        $pattern = $null
        if ($element.TryGetCurrentPattern($patternId, [ref]$pattern)) { return $pattern }
        return $null
    }

    function Get-Window($parameters) {
        $ref = Get-Argument $parameters 'window'
        if ($ref -isnot [string] -or -not $script:windows.ContainsKey($ref)) {
            Deny 'Refused: window was not obtained from this helper launch.'
        }
        $window = $script:windows[$ref]
        Assert-Window $window
        return $window
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
        Assert-Window $window
        $foreground = [OwnedUia.Native]::GetForegroundWindow()
        if ($foreground -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($foreground) -ne $window.Identity.Pid) {
            Deny 'Owned window is not in the foreground.'
        }
    }

    function Assert-NativeFocus($window) {
        Assert-Foreground $window
        $focus = [OwnedUia.Native]::FocusWindow($window.Handle)
        if ($focus -eq [IntPtr]::Zero -or
            [OwnedUia.Native]::GetAncestor($focus, 2) -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($focus) -ne $window.Identity.Pid) {
            Deny 'Owned window does not have keyboard focus.'
        }
        Assert-Foreground $window
    }

    function Focus-Window($window) {
        if (-not [OwnedUia.Native]::InteractiveDesktop()) { Deny 'No interactive input desktop is available.' }
        Assert-Window $window
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
        $element.SetFocus()
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

    function Test-AppPath([string] $path, [string] $expected, [string] $handoff) {
        if ([string]::IsNullOrEmpty($path)) { return $false }
        if ([string]::Equals($path, $expected, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ([string]::IsNullOrEmpty($handoff)) { return $false }
        $programFiles = [Environment]::GetEnvironmentVariable('ProgramW6432')
        if ([string]::IsNullOrEmpty($programFiles)) { $programFiles = $env:ProgramFiles }
        $windowsApps = [IO.Path]::Combine($programFiles, 'WindowsApps')
        if ($handoff -eq 'calculator') {
            $package = 'Microsoft.WindowsCalculator'
            $executable = 'CalculatorApp.exe'
        } else {
            $package = 'Microsoft.WindowsNotepad'
            $executable = 'Notepad.exe'
        }
        $expression = '^' + [regex]::Escape($windowsApps) + '\\' +
            [regex]::Escape($package) + '_[^\\]+\\(?:[^\\]+\\)*' +
            [regex]::Escape($executable) + '$'
        return [regex]::IsMatch($path, $expression, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }

    function Quote-ProcessArgument([string] $argument) {
        # Start-Process joins ArgumentList with spaces in Windows PowerShell 5.1.
        # Quote every argv entry, doubling backslashes before quotes/the final quote.
        $escaped = [regex]::Replace($argument, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        return '"' + $escaped + '"'
    }

    # launch: allowlisted executable only; claim identities before reading an owned title.
    function Start-OwnedApp($parameters) {
        $name = Get-Argument $parameters 'app'
        if ($name -isnot [string]) { Deny 'An allowlisted app name is required.' }
        $entry = $apps.PSObject.Properties[$name]
        # Match names ordinally, just like the TypeScript allowlist.
        if ($null -eq $entry -or $entry.Name -cne $name) {
            Deny ('Unknown app. Allowed apps: ' + (($apps.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '))
        }
        if (-not [OwnedUia.Native]::InteractiveDesktop()) { Deny 'No interactive input desktop is available.' }
        $command = Get-Argument $entry.Value 'command'
        if ($command -isnot [string] -or [string]::IsNullOrWhiteSpace($command)) {
            Deny 'Invalid allowlisted command.'
        }
        # Resolve an executable, not a PowerShell command, expression, or script.
        $resolved = @(Get-Command -Name $command -CommandType Application -ErrorAction SilentlyContinue)
        if ($resolved.Count -eq 0) { Deny 'Allowlisted executable is unavailable.' }
        # Get-Command can return both System32 and Windows copies of Notepad. Use
        # the first PATH resolution, as launching this executable name normally does.
        $path = [IO.Path]::GetFullPath($resolved[0].Path)
        if ([IO.Path]::GetExtension($path) -ine '.exe') { Deny 'Allowlisted command must be an executable.' }
        $arguments = Get-Argument $entry.Value 'args' @()
        if ($null -eq $arguments) { $arguments = @() }
        if ($arguments -is [string] -or $arguments -isnot [System.Array]) {
            Deny 'Allowlisted args must be a string array.'
        }
        foreach ($argument in $arguments) {
            if ($argument -isnot [string]) { Deny 'Allowlisted args must be a string array.' }
        }

        # Only known Windows launchers may hand off into the two packaged apps.
        $handoff = ''
        $leaf = [IO.Path]::GetFileName($path)
        $directory = [IO.Path]::GetDirectoryName($path)
        $windowsDirectories = @($env:WINDIR, ([IO.Path]::Combine($env:WINDIR, 'System32')),
            ([IO.Path]::Combine($env:WINDIR, 'SysWOW64')))
        if ($windowsDirectories -icontains $directory) {
            if ($leaf -ieq 'calc.exe') { $handoff = 'calculator' }
            elseif ($leaf -ieq 'notepad.exe') { $handoff = 'notepad' }
        }

        if ($handoff -eq 'calculator' -and (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) {
            # Legacy UWP Calculator windows belong to a shared ApplicationFrameHost,
            # not CalculatorApp.exe. Refuse BEFORE launch rather than opening a window
            # whose process we cannot own, inspect, or safely terminate.
            $packages = @(Get-AppxPackage -Name Microsoft.WindowsCalculator)
            if ($packages.Count -eq 1) {
                [xml]$manifest = [IO.File]::ReadAllText([IO.Path]::Combine($packages[0].InstallLocation, 'AppxManifest.xml'))
                $application = $manifest.Package.Applications.Application
                if ($application.GetAttribute('EntryPoint') -eq 'Calculator.App') {
                    Deny 'Calculator uses shared ApplicationFrameHost; refused before launch because its window process cannot be owned.'
                }
            }
        }
        Assert-Lifetime
        $beforeHandles = @{}
        foreach ($native in [OwnedUia.Native]::Windows()) {
            $beforeHandles[$native.Handle.ToInt64().ToString()] = $true
        }
        $beforeProcesses = @{}
        foreach ($process in [Diagnostics.Process]::GetProcesses()) {
            try { $beforeProcesses[$process.Id] = $true }
            finally { $process.Dispose() }
        }
        $began = [DateTime]::UtcNow.Ticks
        $startOptions = @{ FilePath = $path; PassThru = $true; ErrorAction = 'Stop' }
        if ($arguments.Count -gt 0) {
            $startOptions.ArgumentList = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
        }
        $launcher = Start-Process @startOptions
        $launcherIdentity = $null
        try {
            # Keep Start-Process's original handle even if a short-lived launcher exits.
            $null = $launcher.Handle
            $started = $launcher.StartTime.ToUniversalTime().Ticks
            if ($started -lt $began -or $beforeProcesses.ContainsKey($launcher.Id)) {
                Deny 'Already-running process handoff is not permitted.'
            }
            $launcherIdentity = [pscustomobject]@{
                Pid = $launcher.Id; Started = $started
                Key = ('{0}:{1}' -f $launcher.Id, $started); Path = $path
            }
            $script:processes[$launcherIdentity.Key] = $launcherIdentity
            Save-OwnedState
        } finally { $launcher.Dispose() }

        $clock = [Diagnostics.Stopwatch]::StartNew()
        $stableKey = ''
        $stableSince = 0L
        $sharedFrameHost = $false
        while ($clock.ElapsedMilliseconds -lt 15000) {
            Assert-Lifetime
            $candidates = New-Object System.Collections.Generic.List[object]
            foreach ($native in [OwnedUia.Native]::Windows()) {
                if (-not $native.Visible -or
                    $beforeHandles.ContainsKey($native.Handle.ToInt64().ToString()) -or
                    [OwnedUia.Native]::GetAncestor($native.Handle, 2) -ne $native.Handle) { continue }
                $identity = Get-Identity ([int]$native.Pid) -WithPath
                if ($null -ne $identity -and $identity.Started -lt $began -and
                    [IO.Path]::GetFileName($identity.Path) -ieq 'ApplicationFrameHost.exe') {
                    $sharedFrameHost = $true
                }
                if ($null -eq $identity -or $identity.Started -lt $began -or
                    $beforeProcesses.ContainsKey($identity.Pid) -or
                    -not (Test-AppPath $identity.Path $path $handoff)) { continue }
                # Ordinary launches require the exact Start-Process identity. Only
                # the explicit Windows packaged mappings may resolve a different PID.
                if ($identity.Key -ne $launcherIdentity.Key -and
                    ([string]::IsNullOrEmpty($handoff) -or
                    -not (Test-AppPath $identity.Path '' $handoff))) { continue }
                $candidates.Add([pscustomobject]@{ Native = $native; Identity = $identity })
            }
            if ($candidates.Count -gt 1) { Deny 'Launch discovery is ambiguous; no window was adopted.' }
            if ($candidates.Count -eq 1) {
                $candidate = $candidates[0]
                $key = $candidate.Identity.Key + ':' + $candidate.Native.Handle.ToInt64()
                if ($key -ne $stableKey) {
                    $stableKey = $key
                    $stableSince = $clock.ElapsedMilliseconds
                } elseif ($clock.ElapsedMilliseconds - $stableSince -ge 500) {
                    # Ownership is recorded before any UIA call, including failure.
                    $script:processes[$candidate.Identity.Key] = $candidate.Identity
                    Save-OwnedState
                    $windowRef = 'w' + $script:windowGeneration + '_' + $candidate.Native.Handle.ToInt64()
                    $window = [pscustomobject]@{
                        Ref = $windowRef; Handle = $candidate.Native.Handle
                        Identity = $candidate.Identity; Root = $null; Refs = @{}
                        ProcessKeys = @($launcherIdentity.Key, $candidate.Identity.Key)
                    }
                    $script:windows[$windowRef] = $window
                    Assert-Window $window
                    $window.Root = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
                    Assert-Element $window $window.Root
                    $title = Read-Property $window $window.Root ([System.Windows.Automation.AutomationElement]::NameProperty)
                    return @{ window = $windowRef; pid = $window.Identity.Pid; title = (Escape-Field $title) }
                }
            } else { $stableKey = '' }
            Start-Sleep -Milliseconds 100
        }
        if ($sharedFrameHost) { Deny 'Refused: a new window uses an existing shared ApplicationFrameHost; it cannot be adopted.' }
        Deny 'No new, unambiguous owned window appeared; old process handoff is refused.'
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
                if ($window.Refs.Count -ge $maxNodes -or $clock.ElapsedMilliseconds -ge 40000) {
                    $cut = $true
                    break
                }
                $item = $stack.Pop()
                $element = $item.Element
                Assert-Window $window
                # Identity-only check on a foreign child; never read its name/state,
                # ask for its children, or call any of its patterns.
                $elementPid = $element.GetCurrentPropertyValue(
                    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $true)
                $foreign = ($elementPid -isnot [int] -or $elementPid -ne $window.Identity.Pid)
                if (-not $foreign) {
                    Assert-Element $window $element
                    $script:nextElement++
                    $ref = 'e' + $script:nextElement
                    $type = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
                    $name = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::NameProperty)
                    $automationId = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
                    $enabled = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
                    $offscreen = Read-Property $window $element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
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
                    $valuePattern = Get-Pattern $window $element ([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($null -ne $valuePattern) {
                        Assert-Element $window $element
                        $line += ' value="' + (Escape-Field $valuePattern.Current.Value) + '"'
                        $line += ' readonly=' + ([string]$valuePattern.Current.IsReadOnly).ToLowerInvariant()
                    } elseif ($typeName -eq 'Document' -or $typeName -eq 'Edit') {
                        # Multiline Notepad exposes TextPattern rather than ValuePattern.
                        # Bound the read in the provider itself, not only after fetching text.
                        $textPattern = Get-Pattern $window $element ([System.Windows.Automation.TextPattern]::Pattern)
                        if ($null -ne $textPattern) {
                            Assert-Element $window $element
                            $line += ' text="' + (Escape-Field $textPattern.DocumentRange.GetText(512)) + '"'
                        }
                    }
                    $togglePattern = Get-Pattern $window $element ([System.Windows.Automation.TogglePattern]::Pattern)
                    if ($null -ne $togglePattern) {
                        Assert-Element $window $element
                        $line += ' toggle=' + (Escape-Field $togglePattern.Current.ToggleState)
                    }
                    $window.Refs[$ref] = $element
                    $lines.Add($line)
                } else { $cut = $true }

                # A sibling navigation request is made on the owned parent, not on
                # a foreign provider. The frame keeps that parent and child index.
                if ($item.Sibling) {
                    Assert-Element $window $item.Parent
                    $siblings = $item.Siblings
                    $next = $item.Index + 1
                    if ($next -lt $siblings.Count) {
                        $stack.Push([pscustomobject]@{
                            Element = $siblings[$next]; Depth = $item.Depth; Sibling = $true
                            Parent = $item.Parent; Siblings = $siblings; Index = $next
                        })
                    }
                }
                if (-not $foreign -and $item.Depth -lt $depth) {
                    Assert-Element $window $element
                    # FindAll is *Children* only, scoped to the proven owned element.
                    # Unlike Descendants, it never traverses a foreign child provider.
                    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children,
                        [System.Windows.Automation.Condition]::TrueCondition)
                    if ($children.Count -gt 0) {
                        $stack.Push([pscustomobject]@{
                            Element = $children[0]; Depth = $item.Depth + 1; Sibling = $true
                            Parent = $element; Siblings = $children; Index = 0
                        })
                    }
                }
            }
            if ($cut) { $lines.Add('[cut: node/time limit or foreign child provider skipped]') }
            $text = [string]::Join("`n", $lines.ToArray())
            return @{ text = $text; nodes = $window.Refs.Count; chars = $text.Length;
                ms = $clock.ElapsedMilliseconds; cut = $cut }
        } catch {
            $window.Refs = @{}
            throw
        }
    }

    # click: prefer UIA patterns; only use input on a proven owned clickable point.
    function Invoke-OwnedClick($parameters) {
        $window = Get-Window $parameters
        $element = Get-Element $window $parameters
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            $pattern.Invoke()
            return @{ path = 'InvokePattern' }
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            $pattern.Toggle()
            return @{ path = 'TogglePattern' }
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            $pattern.Select()
            return @{ path = 'SelectionItemPattern' }
        }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            $state = $pattern.Current.ExpandCollapseState
            Assert-Element $window $element
            if ($state -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $pattern.Collapse() }
            elseif ($state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $pattern.Expand() }
            else { Deny 'Element has no safe expand/collapse action.' }
            return @{ path = 'ExpandCollapsePattern' }
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
        Assert-ClickPoint $window $nativePoint
        try {
            if (-not [OwnedUia.Native]::Mouse($false)) { Deny 'Pointer input was refused.' }
        } finally { $null = [OwnedUia.Native]::Mouse($true) }
        return @{ path = 'SendInput' }
    }

    function Assert-ClickPoint($window, $point) {
        Assert-Foreground $window
        $hit = [OwnedUia.Native]::WindowFromPoint($point)
        if ($hit -eq [IntPtr]::Zero -or
            [OwnedUia.Native]::GetAncestor($hit, 2) -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($hit) -ne $window.Identity.Pid) {
            Deny 'Clickable point is obscured or outside the owned window.'
        }
        # Last foreground check immediately before input, after the hit test.
        Assert-Foreground $window
    }

    # type: use writable ValuePattern, otherwise focused Unicode input in the owned window.
    function Set-OwnedText($parameters) {
        $window = Get-Window $parameters
        $element = Get-Element $window $parameters -Optional
        $text = Get-Argument $parameters 'text'
        if ($text -isnot [string] -or $text.Length -gt 20000) { Deny 'Text must be a string of at most 20000 characters.' }
        $pattern = Get-Pattern $window $element ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $pattern) {
            Assert-Element $window $element
            if ($pattern.Current.IsReadOnly) { Deny 'Element value is read-only.' }
            Assert-Element $window $element
            $pattern.SetValue($text)
            return @{ path = 'ValuePattern.SetValue'; chars = $text.Length }
        }
        $exact = $null -ne (Get-Argument $parameters 'ref')
        if ($exact) { Focus-Element $window $element $true }
        else {
            # Without a ref, retain the owned window's currently focused control.
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

        $elementRef = Get-Argument $parameters 'ref'
        $element = $null
        if ($null -ne $elementRef) {
            $element = Get-Element $window $parameters
            Focus-Element $window $element $true
        } else { Focus-Window $window }
        Assert-NoHeldModifiers
        Assert-NativeFocus $window
        $pressed = New-Object System.Collections.Generic.List[int]
        try {
            foreach ($modifierCode in $modifiers) {
                Assert-NativeFocus $window
                # Add before SendInput: even a reported failure merits a release.
                $pressed.Add($modifierCode)
                if (-not [OwnedUia.Native]::Key([ushort]$modifierCode, $false)) { Deny 'Key input was refused.' }
            }
            if ($null -ne $element) {
                Assert-Element $window $element
                if ((Read-Property $window $element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)) -ne $true) {
                    Deny 'Element lost keyboard focus.'
                }
            }
            Assert-NativeFocus $window
            try {
                if (-not [OwnedUia.Native]::Key([ushort]$code, $false)) { Deny 'Key input was refused.' }
            } finally { $null = [OwnedUia.Native]::Key([ushort]$code, $true) }
        } finally {
            # Release even if ownership/focus/lifetime was lost during the chord.
            for ($i = $pressed.Count - 1; $i -ge 0; $i--) {
                $null = [OwnedUia.Native]::Key([ushort]$pressed[$i], $true)
            }
        }
        return @{ path = 'SendInput' }
    }

    function Request-WindowClose($window) {
        # Cleanup deliberately ignores lifetime (it has often already exited).
        if (-not (Test-Identity $window.Identity) -or
            -not [OwnedUia.Native]::IsWindow($window.Handle) -or
            [OwnedUia.Native]::GetAncestor($window.Handle, 2) -ne $window.Handle -or
            [OwnedUia.Native]::WindowPid($window.Handle) -ne $window.Identity.Pid -or
            $null -eq $window.Root) { return }
        # Temporarily bypass only the lifetime check, never the ownership checks.
        $savedLifetime = $script:lifetime
        $script:lifetime = $null
        try {
            $pattern = Get-Pattern $window $window.Root ([System.Windows.Automation.WindowPattern]::Pattern)
            if ($null -ne $pattern) {
                Assert-Element $window $window.Root
                $pattern.Close()
            }
        } catch { }
        finally { $script:lifetime = $savedLifetime }
    }

    # close: WindowPattern first, then only recorded PID/creation-time identities.
    function Close-OwnedWindow($parameters) {
        $window = Get-Window $parameters
        Request-WindowClose $window
        # Give WindowPattern.Close a second, including save/confirmation dialogs.
        Start-Sleep -Milliseconds 1000
        foreach ($key in $window.ProcessKeys) {
            if ($script:processes.ContainsKey($key)) {
                $identity = $script:processes[$key]
                Stop-ExactProcess $identity
                if (Test-IdentityGone $identity) { $script:processes.Remove($key) }
            }
        }
        $script:windows.Remove($window.Ref)
        Save-OwnedState
        if (-not (Test-IdentityGone $window.Identity)) { Deny 'Owned process cleanup is incomplete; identity retained.' }
        return @{ closed = $true }
    }

    function Clear-OwnedApps {
        foreach ($window in @($script:windows.Values)) { Request-WindowClose $window }
        if ($script:processes.Count -gt 0) { Start-Sleep -Milliseconds 1000 }
        foreach ($identity in @($script:processes.Values)) { Stop-ExactProcess $identity }
        $script:windows.Clear()
        # Retain any failed kills in the journal for the independent watchdog.
        foreach ($key in @($script:processes.Keys)) {
            if (Test-IdentityGone $script:processes[$key]) { $script:processes.Remove($key) }
        }
        Save-OwnedState
    }

    while (-not $script:stopping) {
        Assert-Lifetime
        $pending = $reader.ReadLineAsync()
        while (-not $pending.IsCompleted) {
            if ($null -ne $script:lifetime -and -not (Test-Identity $script:lifetime)) {
                $script:stopping = $true
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($script:stopping) { break }
        Assert-Lifetime
        $line = $pending.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        $id = $null
        try {
            $request = $line | ConvertFrom-Json
            if ($null -eq $request -or $request -isnot [pscustomobject]) { Deny 'Request must be a JSON object.' }
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
            $result = switch -CaseSensitive ($method) {
                'launch' { Start-OwnedApp $parameters; break }
                'tree' { Get-OwnedTree $parameters; break }
                'click' { Invoke-OwnedClick $parameters; break }
                'type' { Set-OwnedText $parameters; break }
                'key' { Send-OwnedKey $parameters; break }
                'close' { Close-OwnedWindow $parameters; break }
                'desktop' { @{ interactive = [OwnedUia.Native]::InteractiveDesktop() }; break }
                'shutdown' { Clear-OwnedApps; $script:stopping = $true; @{ shutdown = $true }; break }
                default { Deny 'Unknown method.' }
            }
            $reply = @{ id = $id; result = $result }
        } catch {
            if ($method -eq 'key') { [Console]::Error.WriteLine('[DEBUG-uia-key] ' + $_.Exception.GetType().FullName + ' ' + $_.ScriptStackTrace) }
            $message = 'Operation failed or ownership could not be verified.'
            if ($_.Exception.Message.StartsWith('UIA_SAFE: ', [StringComparison]::Ordinal)) {
                $message = $_.Exception.Message.Substring(10)
            }
            $reply = @{ id = $id; error = $message }
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
    # EOF, shutdown, lifetime death, provider failure, or broken stdout all converge.
    if ($null -ne (Get-Command Clear-OwnedApps -CommandType Function -ErrorAction SilentlyContinue)) {
        try { Clear-OwnedApps } catch { }
    } else {
        foreach ($identity in @($script:processes.Values)) { Stop-ExactProcess $identity }
    }
    # Do not dispose a StreamReader concurrently with a pending ReadLineAsync;
    # process exit closes the input handle and outstanding background read.
    try { $writer.Dispose() } catch { }
}
