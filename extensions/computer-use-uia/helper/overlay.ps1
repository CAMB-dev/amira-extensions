# Independent stop monitor + optional click-through virtual pointer. No binaries on disk.
param(
    [string] $Render = 'true',
    [string] $StopHotkey = 'ctrl+alt+q',
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted,
    [switch] $TestMode
)
$ErrorActionPreference = 'Stop'
try {
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
Add-Type -ReferencedAssemblies @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll') -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AmiraPointer {
    public sealed class Overlay : Form {
        // WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        const int Styles = 0x20 | 0x80000 | 0x8 | 0x80 | 0x08000000;
        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
        delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
        [StructLayout(LayoutKind.Sequential)] struct KEYHOOK { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEHOOK { public POINT Point; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct KEYINPUT { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYINPUT Keyboard; [FieldOffset(0)] public MOUSEINPUT Mouse; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint Type; public UNION Data; }
        [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        readonly ConcurrentQueue<string> input = new ConcurrentQueue<string>();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly bool render, testMode;
        readonly string hotkey;
        readonly int lifetimePid;
        readonly string lifetimeStarted;
        readonly Color accent = Color.FromArgb(126, 76, 230);
        volatile bool eof;
        bool registered, stopped, escapeDown, active, gliding;
        long escapeAt = -1000, began, idleAt = -1, rippleAt = -1000, shutdownAt = -1, cleanupAt = -1;
        int actionId, ownerPid;
        IntPtr keyboardHook, mouseHook;
        HookProc keyboardCallback, mouseCallback;
        readonly Dictionary<uint, INPUT> injectedKeys = new Dictionary<uint, INPUT>();
        readonly HashSet<uint> physicalKeys = new HashSet<uint>();
        bool injectedMouse, physicalMouse;
        string ownerStarted, kind = "", label = "";
        PointF from = new PointF(32, 64), target = new PointF(32, 64), pointer = new PointF(32, 64);
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var p = base.CreateParams; p.ExStyle |= Styles; return p; }
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        static long CreationTime(IntPtr handle) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
            return created; // Raw UTC FILETIME; do not round-trip through local time.
        }
        static bool ExactAlive(int pid, string started) {
            try { using (var p = Process.GetProcessById(pid)) {
                var handle = p.Handle;
                return !p.HasExited && CreationTime(handle).ToString() == started;
            }} catch { return false; }
        }
        void Reply(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
        bool OurInput(UIntPtr extra) { return ownerPid > 0 && extra.ToUInt64() == (0xA1120000u ^ (uint)ownerPid); }
        bool StopWindow() {
            return !stopped && shutdownAt < 0 &&
                (active || (idleAt >= 0 && clock.ElapsedMilliseconds - idleAt <= 3000));
        }
        void InstallHooks() {
            if (keyboardHook != IntPtr.Zero && mouseHook != IntPtr.Zero) return;
            // Seed held keys conservatively; Escape stop detection itself uses ONLY
            // non-injected hook rising edges, never the asynchronous key-state poll.
            physicalKeys.Clear();
            for (uint vk = 1; vk < 256; vk++)
                if ((GetAsyncKeyState((int)vk) & 0x8000) != 0) physicalKeys.Add(vk);
            physicalMouse = (GetAsyncKeyState(1) & 0x8000) != 0;
            escapeDown = physicalKeys.Contains(0x1B);
            escapeAt = -1000;
            try {
                keyboardHook = SetWindowsHookEx(13, keyboardCallback, GetModuleHandle(null), 0);
                if (keyboardHook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                mouseHook = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
                if (mouseHook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            } catch { UninstallHooks(); throw; }
        }
        void UninstallHooks() {
            if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
            keyboardHook = mouseHook = IntPtr.Zero;
            physicalKeys.Clear(); physicalMouse = escapeDown = false;
            escapeAt = -1000;
        }
        IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
            if (code >= 0) {
                var key = (KEYHOOK)Marshal.PtrToStructure(data, typeof(KEYHOOK));
                bool up = (key.Flags & 0x80) != 0;
                bool injected = (key.Flags & (0x10 | 0x2)) != 0; // LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED
                if (OurInput(key.Extra) && injected) {
                    // Suppress ONLY our late injected downs after stop, never user input.
                    if (stopped && !up) return new IntPtr(1);
                    uint identity = key.Key == 0xE7 ? 0x10000u + key.Scan : key.Key;
                    if (up) injectedKeys.Remove(identity);
                    else {
                        var release = new INPUT(); release.Type = 1;
                        release.Data.Keyboard.Key = key.Key == 0xE7 ? (ushort)0 : (ushort)key.Key;
                        release.Data.Keyboard.Scan = key.Key == 0xE7 ? (ushort)key.Scan : (ushort)0;
                        release.Data.Keyboard.Flags = 2u | (key.Key == 0xE7 ? 4u : (key.Flags & 1));
                        injectedKeys[identity] = release;
                    }
                } else if (!injected) {
                    if (up) physicalKeys.Remove(key.Key); else physicalKeys.Add(key.Key);
                    if (key.Key == 0x1B) {
                        if (up) escapeDown = false;
                        else if (!escapeDown) {
                            escapeDown = true;
                            if (!testMode && StopWindow()) {
                                long now = clock.ElapsedMilliseconds;
                                if (now - escapeAt <= 500) { escapeAt = -1000; StopControl(); }
                                else escapeAt = now;
                            } else escapeAt = -1000;
                        }
                    }
                }
            }
            return CallNextHookEx(keyboardHook, code, message, data);
        }
        IntPtr Mouse(int code, IntPtr message, IntPtr data) {
            if (code >= 0 && (message.ToInt32() == 0x201 || message.ToInt32() == 0x202)) {
                var mouse = (MOUSEHOOK)Marshal.PtrToStructure(data, typeof(MOUSEHOOK));
                bool down = message.ToInt32() == 0x201;
                if (OurInput(mouse.Extra) && (mouse.Flags & 1) != 0) {
                    if (stopped && down) return new IntPtr(1);
                    injectedMouse = down;
                } else if ((mouse.Flags & 1) == 0) physicalMouse = down;
            }
            return CallNextHookEx(mouseHook, code, message, data);
        }
        void ReleaseInputs() {
            // This ledger survives helper termination. Never release keys/buttons physically
            // held by the user. Retry a failed insertion rather than forgetting the down.
            foreach (uint identity in new List<uint>(injectedKeys.Keys)) {
                uint vk = identity >= 0x10000 ? 0xE7u : identity;
                if (physicalKeys.Contains(vk)) continue;
                if (SendInput(1, new INPUT[] { injectedKeys[identity] }, Marshal.SizeOf(typeof(INPUT))) == 1)
                    injectedKeys.Remove(identity);
            }
            if (injectedMouse && !physicalMouse) {
                var release = new INPUT(); release.Data.Mouse.Flags = 4;
                if (SendInput(1, new INPUT[] { release }, Marshal.SizeOf(typeof(INPUT))) == 1) injectedMouse = false;
            }
        }
        void AbortOwner() {
            // Only the helper identity supplied over our private pipe; never a process name.
            if (ownerPid <= 0) return;
            try { using (var p = Process.GetProcessById(ownerPid)) {
                var handle = p.Handle;
                if (!p.HasExited && CreationTime(handle).ToString() == ownerStarted) p.Kill();
            }} catch { }
        }
        void StopControl() {
            if (stopped || shutdownAt >= 0) return;
            stopped = true;
            active = gliding = false;
            cleanupAt = clock.ElapsedMilliseconds;
            Hide();
            // Only an actual stop/explicit abort kills the exact helper identity.
            AbortOwner();
            if (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero) ReleaseInputs();
            Reply(new { @event = "stop" });
        }
        void BeginShutdown() {
            if (shutdownAt >= 0) return;
            active = gliding = false;
            Hide();
            shutdownAt = clock.ElapsedMilliseconds;
            if (cleanupAt < 0) cleanupAt = shutdownAt;
            // EOF, exit and lifetime expiry are not user stops and never kill the owner.
            if (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero) ReleaseInputs();
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x0312) { if (StopWindow()) StopControl(); return; } // WM_HOTKEY
            if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            if (message.Msg == 0x0084) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
            base.WndProc(ref message);
        }
        public Overlay(bool render, string hotkey, int lifetimePid, string lifetimeStarted, bool testMode) {
            this.render = render; this.hotkey = hotkey; this.lifetimePid = lifetimePid;
            this.lifetimeStarted = lifetimeStarted; this.testMode = testMode;
            try {
                Text = "AmiraPointerOverlay";
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                AutoScaleMode = AutoScaleMode.None;
                BackColor = TransparencyKey = Color.Magenta;
                DoubleBuffered = true;
                Bounds = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
                var hwnd = Handle; // hidden handle also receives hotkeys when rendering is disabled
                var chord = hotkey.Split('+');
                uint modifiers = 0x4000; // MOD_NOREPEAT
                for (int i = 0; i < chord.Length - 1; i++) {
                    if (chord[i] == "ctrl") modifiers |= 2;
                    else if (chord[i] == "alt") modifiers |= 1;
                    else if (chord[i] == "shift") modifiers |= 4;
                    else throw new InvalidOperationException("Invalid stop modifier.");
                }
                string keyName = chord[chord.Length - 1];
                uint key = keyName.Length == 1 ? (uint)char.ToUpperInvariant(keyName[0]) : (uint)(0x70 + int.Parse(keyName.Substring(1)) - 1);
                if (!testMode) {
                    registered = RegisterHotKey(hwnd, 1, modifiers, key);
                    if (!registered) throw new InvalidOperationException("Stop hotkey " + hotkey + " is unavailable \u2014 set stopHotkey or disable the overlay");
                }
                // WinForms owns class registration. Do not assign an unregistered ClassName;
                // publish the actual native class so the helper can refuse this window safely.
                var windowClass = new StringBuilder(256);
                if (GetClassName(hwnd, windowClass, windowClass.Capacity) == 0)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                keyboardCallback = Keyboard; mouseCallback = Mouse;
                var reader = new Thread(delegate() {
                    try { string line; while ((line = Console.ReadLine()) != null) input.Enqueue(line); }
                    catch (Exception ex) { input.Enqueue(new JavaScriptSerializer().Serialize(new { @event = "reader-error", error = ex.GetBaseException().Message })); }
                    finally { eof = true; }
                });
                reader.IsBackground = true;
                reader.Start();
                timer.Interval = 15;
                timer.Tick += Tick;
                timer.Start();
                Reply(new { @event = "ready", @class = windowClass.ToString(), pid = Process.GetCurrentProcess().Id });
            } catch { Dispose(); throw; }
        }
        void Tick(object sender, EventArgs args) {
            if ((lifetimePid > 0 && !ExactAlive(lifetimePid, lifetimeStarted)) ||
                (ownerPid > 0 && !ExactAlive(ownerPid, ownerStarted))) BeginShutdown();
            long now = clock.ElapsedMilliseconds;
            string line;
            while (input.TryDequeue(out line)) {
                object requestId = null;
                try {
                    var value = json.Deserialize<Dictionary<string, object>>(line);
                    value.TryGetValue("id", out requestId);
                    string ev = Convert.ToString(value["event"]);
                    if (ev == "owner") {
                        ownerPid = Convert.ToInt32(value["pid"]);
                        ownerStarted = Convert.ToString(value["started"]);
                        if (stopped) AbortOwner();
                    } else if (ev == "abort" || (ev == "simulate-stop" && testMode)) { StopControl(); }
                    else if (ev == "exit") BeginShutdown();
                    else if (ev == "busy") {
                        if (stopped || shutdownAt >= 0) throw new InvalidOperationException("Overlay is shutting down.");
                        int busyId = Convert.ToInt32(value["id"]);
                        if (cleanupAt >= 0 && (injectedKeys.Count != 0 || injectedMouse))
                            throw new InvalidOperationException("Input cleanup is still pending; desktop action refused.");
                        InstallHooks();
                        cleanupAt = -1;
                        actionId = busyId; active = true; kind = ""; label = "Preparing";
                        if (render) { Show(); Invalidate(); }
                        // The client MUST await this exact id before invoking the helper.
                        Reply(new { @event = "armed", id = busyId });
                    } else if (ev == "overlay") {
                        if (stopped || shutdownAt >= 0 || !active || keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero)
                            throw new InvalidOperationException("Overlay action is not armed.");
                        actionId = Convert.ToInt32(value["id"]);
                        kind = Convert.ToString(value["kind"]);
                        label = Convert.ToString(value["label"]);
                        if (label.Length > 32) label = label.Substring(0, 32);
                        from = pointer;
                        target = new PointF(Convert.ToSingle(value["x"]), Convert.ToSingle(value["y"]));
                        began = now; active = true; gliding = render;
                        if (render) { Show(); Invalidate(); }
                        else Reply(new { @event = "glided", id = actionId });
                    } else if (ev == "done") {
                        if (active && !stopped && shutdownAt < 0) {
                            active = gliding = false; idleAt = clock.ElapsedMilliseconds;
                            if (kind == "click") rippleAt = idleAt;
                        }
                    } else if (ev == "inspect" && testMode) {
                        POINT cursor; GetCursorPos(out cursor);
                        Reply(new { @event = "inspection", styles = CreateParams.ExStyle,
                            foreground = GetForegroundWindow() == Handle, gliding, active, kind,
                            hooks = keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero,
                            visible = Visible, actionId, targetX = target.X, targetY = target.Y,
                            cursorX = cursor.X, cursorY = cursor.Y,
                            ripple = clock.ElapsedMilliseconds - rippleAt < 450,
                            x = pointer.X, y = pointer.Y,
                            hitRoot = GetAncestor(WindowFromPoint(new POINT { X = (int)Math.Round(pointer.X), Y = (int)Math.Round(pointer.Y) }), 2).ToInt64().ToString() });
                    } else if (ev == "reader-error") {
                        throw new InvalidOperationException(Convert.ToString(value["error"]));
                    } else throw new InvalidOperationException("Unknown overlay event: " + ev);
                } catch (Exception ex) {
                    string error = ex.GetBaseException().Message;
                    if (requestId == null) Reply(new { @event = "error", error });
                    else Reply(new { @event = "error", id = requestId, error });
                }
            }
            if (eof) BeginShutdown();
            now = clock.ElapsedMilliseconds;
            if (stopped || shutdownAt >= 0) {
                // Keep cleanup hooks only until releases succeed or the existing 4s
                // deadline expires. A stop may stay latched without session-long hooks.
                if (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero) ReleaseInputs();
                bool released = injectedKeys.Count == 0 && !injectedMouse;
                if (released || now - cleanupAt >= 4000) {
                    if (!released && (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero))
                        Console.Error.WriteLine("UIA input cleanup incomplete; release held keys/buttons manually.");
                    UninstallHooks();
                    if (shutdownAt >= 0) { Close(); return; }
                }
                return;
            }
            if (!active && idleAt >= 0 && now - idleAt > 3000) {
                if (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero) {
                    if (cleanupAt < 0) cleanupAt = now;
                    ReleaseInputs();
                    bool released = injectedKeys.Count == 0 && !injectedMouse;
                    if (released || now - cleanupAt >= 4000) {
                        if (!released) Console.Error.WriteLine("UIA input cleanup incomplete; release held keys/buttons manually.");
                        UninstallHooks();
                    }
                }
                if (render && Visible) Hide();
            }
            if (gliding) {
                double t = Math.Min(1, (now - began) / 320.0);
                float ease = (float)(1 - Math.Pow(1 - t, 3));
                pointer = new PointF(from.X + (target.X - from.X) * ease, from.Y + (target.Y - from.Y) * ease);
                if (t >= 1) { pointer = target; gliding = false; Reply(new { @event = "glided", id = actionId }); }
            }
            if (render && Visible) {
                if (!active && now - idleAt > 3000) Hide();
                else Invalidate();
            }
        }
        string DisplayHotkey() {
            string[] parts = hotkey.Split('+');
            for (int i = 0; i < parts.Length; i++) {
                parts[i] = parts[i] == "ctrl" ? "Ctrl" : parts[i] == "alt" ? "Alt" : parts[i] == "shift" ? "Shift" : parts[i].ToUpperInvariant();
            }
            return string.Join("+", parts);
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            if (!render || stopped) return;
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            float x = pointer.X - Left, y = pointer.Y - Top;
            using (var brush = new SolidBrush(accent)) {
                g.FillEllipse(brush, x - 5, y - 5, 10, 10);
                string text = "Amira \u00b7 " + label;
                if (active && kind == "type") text += new string('.', (int)(clock.ElapsedMilliseconds / 300 % 3) + 1);
                using (var font = new Font("Segoe UI", 9)) {
                    if (kind == "key") {
                        var size = g.MeasureString(text, font);
                        g.FillRectangle(brush, x + 8, y + 6, size.Width + 8, size.Height + 4);
                        using (var ink = new SolidBrush(Color.White)) g.DrawString(text, font, ink, x + 12, y + 8);
                    } else g.DrawString(text, font, brush, x + 10, y + 8);
                }
            }
            long age = clock.ElapsedMilliseconds - rippleAt;
            if (age >= 0 && age < 450) {
                float radius = 6 + age / 20f;
                using (var pen = new Pen(accent, 2)) g.DrawEllipse(pen, x - radius, y - radius, radius * 2, radius * 2);
            }
            if (active) {
                var primary = Screen.PrimaryScreen.Bounds;
                var banner = new Rectangle(primary.Left - Left, primary.Top - Top, primary.Width, 28);
                using (var brush = new SolidBrush(Color.FromArgb(38, 24, 69))) g.FillRectangle(brush, banner);
                using (var font = new Font("Segoe UI", 10))
                using (var brush = new SolidBrush(Color.White))
                    g.DrawString("Amira is controlling the desktop \u2014 " + DisplayHotkey() + " to stop", font, brush, banner.Left + 12, banner.Top + 5);
            }
        }
        protected override void Dispose(bool disposing) {
            if (disposing) {
                timer.Stop();
                // Disposal (including a failed constructor/startup) is never a stop.
                if (keyboardHook != IntPtr.Zero || mouseHook != IntPtr.Zero) ReleaseInputs();
                UninstallHooks();
            }
            if (registered) {
                if (IsHandleCreated) UnregisterHotKey(Handle, 1);
                registered = false;
            }
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
        public static void Run(bool render, string hotkey, int lifetimePid, string lifetimeStarted, bool testMode) {
            // Set/verify this UI thread, even if PowerShell already established process DPI.
            var dpi = new IntPtr(-4);
            if (SetThreadDpiAwarenessContext(dpi) == IntPtr.Zero ||
                !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), dpi))
                throw new InvalidOperationException("Per-monitor DPI awareness unavailable.");
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Application.EnableVisualStyles();
            using (var form = new Overlay(render, hotkey, lifetimePid, lifetimeStarted, testMode)) {
                // Application.Run(form) would show even an overlay configured not to render.
                Application.Run(new ApplicationContext(form));
            }
        }
    }
}
'@
    if ($StopHotkey -cnotmatch '^(?:(?:ctrl|alt|shift)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$') { throw 'Invalid stop hotkey.' }
    [AmiraPointer.Overlay]::Run($Render -eq 'true', $StopHotkey, $LifetimePid, $LifetimeStarted, $TestMode.IsPresent)
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $reply = @{ event = 'error'; error = $failure.Message } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($reply)
    [Console]::Out.Flush()
    [Console]::Error.WriteLine($failure.Message)
    exit 1
}
