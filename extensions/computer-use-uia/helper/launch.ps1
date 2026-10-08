# Session-owned unnamed jobs: the watchdog creates/retains the kernel object BEFORE
# creation. Only a duplicated handle enters the verified helper; no public job name
# or journal-supplied handle can be rebound to an unrelated process tree.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace OwnedUia {
    public sealed class LaunchGuard : IDisposable {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedSize;
            public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX { public STARTUPINFO Startup; public IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)]
        struct BASIC_LIMIT {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet;
            public uint ActiveProcesses; public UIntPtr Affinity;
            public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct EXTENDED_LIMIT {
            public BASIC_LIMIT Basic; public IO_COUNTERS Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
            bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetProcessIdOfThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
            out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr data, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct WINDOWPLACEMENT {
            public int Length, Flags, Show; public POINT MinPosition, MaxPosition; public RECT NormalPosition;
        }
        [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref WINDOWPLACEMENT placement);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32 {
            public uint Size, Usage, Pid; public UIntPtr Heap;
            public uint Module, Threads, ParentPid; public int Priority; public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
        }
        public static long CreationTime(IntPtr handle) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
            return created; // UTC FILETIME, never local StartTime -> UTC (ambiguous across DST).
        }
        static bool? HasExited(IntPtr handle, bool synchronize) {
            if (!synchronize) {
                uint code;
                if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception();
                // Query-only access cannot distinguish STILL_ACTIVE from an exit code of 259.
                if (code == 259u) return null;
                return true;
            }
            uint status = WaitForSingleObject(handle, 0);
            if (status == 0) return true; // WAIT_OBJECT_0
            if (status == 258) return false; // WAIT_TIMEOUT
            if (status == 0xffffffffu) throw new Win32Exception(); // WAIT_FAILED
            throw new Win32Exception("Unexpected process wait result.");
        }
        IntPtr job, process, thread, parent;
        int rootPid;
        long rootStarted;
        public void SetRoot(int pid, long started, uint tid) {
            if (rootPid != 0) throw new InvalidOperationException("Launch root already registered.");
            using (var root = Process.GetProcessById(pid)) {
                bool belongs;
                if (root.HasExited || CreationTime(root.Handle) != started ||
                    !IsProcessInJob(root.Handle, job, out belongs) || !belongs)
                    throw new InvalidOperationException("Launch root identity changed.");
                // The watchdog commits while holding the verified root identity. There
                // is no registered-but-suspended gap if the helper dies before the ack.
                IntPtr primary = OpenThread(0x0802u, false, tid); // QUERY_LIMITED_INFORMATION | SUSPEND_RESUME
                if (primary == IntPtr.Zero) throw new Win32Exception();
                try {
                    if (GetProcessIdOfThread(primary) != pid || root.HasExited || CreationTime(root.Handle) != started)
                        throw new InvalidOperationException("Launch thread identity changed.");
                    if (ResumeThread(primary) == uint.MaxValue) throw new Win32Exception();
                } finally { CloseHandle(primary); }
            }
            rootPid = pid; rootStarted = started;
        }
        public string Name { get; private set; }
        public long HelperHandle { get; private set; }
        public long ParentHandle { get; private set; }
        public int ParentPid { get; private set; }
        public long ParentStarted { get; private set; }
        void CheckParent() {
            uint code;
            if (parent == IntPtr.Zero || GetProcessId(parent) != ParentPid ||
                CreationTime(parent) != ParentStarted || !GetExitCodeProcess(parent, out code) || code != 259u)
                throw new InvalidOperationException("Launch parent identity changed or exited.");
        }
        static void CloseRemote(IntPtr target, IntPtr handle) {
            IntPtr local;
            // DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS: roll back only our own duplicate.
            if (DuplicateHandle(target, handle, GetCurrentProcess(), out local, 0, false, 3)) CloseHandle(local);
        }
        public static LaunchGuard CreateFor(string id, int helperPid, long helperStarted) {
            var guard = new LaunchGuard();
            try {
                guard.Name = id; // Opaque protocol ID only; the kernel job is UNNAMED.
                guard.job = CreateJobObject(IntPtr.Zero, null);
                if (guard.job == IntPtr.Zero) throw new Win32Exception();
                guard.Limits();
                using (var helper = Process.GetProcessById(helperPid)) {
                    IntPtr target = helper.Handle;
                    if (helper.HasExited || CreationTime(target) != helperStarted)
                        throw new InvalidOperationException("Helper identity changed.");
                    IntPtr duplicate;
                    // ASSIGN only; cleanup/query authority stays with the watchdog. Never inherit.
                    if (!DuplicateHandle(GetCurrentProcess(), guard.job, target, out duplicate,
                        0x0001u, false, 0)) throw new Win32Exception();
                    guard.HelperHandle = duplicate.ToInt64();
                    try {
                        using (var owner = Process.GetCurrentProcess()) {
                            guard.ParentPid = owner.Id;
                            guard.ParentStarted = CreationTime(owner.Handle);
                            IntPtr parentDuplicate;
                            // PROCESS_CREATE_PROCESS | PROCESS_QUERY_LIMITED_INFORMATION only.
                            if (!DuplicateHandle(GetCurrentProcess(), owner.Handle, target, out parentDuplicate,
                                0x1080u, false, 0)) throw new Win32Exception();
                            guard.ParentHandle = parentDuplicate.ToInt64();
                        }
                    } catch {
                        CloseRemote(target, duplicate);
                        throw;
                    }
                }
                return guard;
            } catch { guard.Dispose(); throw; }
        }
        public static LaunchGuard FromHandle(string id, long handle, long parentHandle, int parentPid, long parentStarted) {
            var guard = new LaunchGuard { Name = id, job = new IntPtr(handle), parent = new IntPtr(parentHandle),
                ParentPid = parentPid, ParentStarted = parentStarted };
            try { guard.CheckParent(); return guard; }
            catch { guard.Dispose(); throw; }
        }
        public void Terminate() {
            if (!TerminateJobObject(job, 1)) throw new Win32Exception();
        }
        public bool HasRoot { get { return rootPid != 0; } }
        public static void CloseTransferredHandle(long handle) {
            if (handle > 0) CloseHandle(new IntPtr(handle));
        }
        bool ProtectorWindow(IntPtr window) {
            uint cloaked;
            // SHELL (2) alone includes windows on another virtual desktop; APP (1),
            // INHERITED (4), and unknown cloak flags cannot protect a subtree.
            if (!IsWindowVisible(window) || DwmGetWindowAttribute(window, 14, out cloaked, 4) != 0 ||
                (cloaked & ~2u) != 0) return false;
            int styles = GetWindowLong(window, -20);
            RECT rect;
            bool iconic = IsIconic(window);
            if (!iconic) {
                if (!GetWindowRect(window, out rect)) return false;
            } else {
                // Ignore iconic bounds; a taskbar-restorable app still protects after monitor removal.
                if ((styles & 0x80) != 0) return false; // WS_EX_TOOLWINDOW
                var placement = new WINDOWPLACEMENT(); placement.Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (!GetWindowPlacement(window, ref placement)) return false;
                rect = placement.NormalPosition;
            }
            if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) return false;
            if (!iconic) {
                long left = GetSystemMetrics(76), top = GetSystemMetrics(77);
                long right = left + GetSystemMetrics(78), bottom = top + GetSystemMetrics(79);
                if (rect.Right <= left || rect.Left >= right || rect.Bottom <= top || rect.Top >= bottom) return false;
            }
            if ((styles & 0x80000) != 0) {
                uint key, flags; byte alpha;
                // Per-pixel layered windows may not expose a global alpha. This is a heuristic.
                if (GetLayeredWindowAttributes(window, out key, out alpha, out flags) && (flags & 2) != 0 && alpha == 0)
                    return false;
            }
            return true;
        }
        bool Visible(int pid) {
            bool visible = false;
            if (!EnumWindows(delegate(IntPtr window, IntPtr data) {
                uint owner; GetWindowThreadProcessId(window, out owner);
                if (owner == pid && ProtectorWindow(window)) visible = true;
                return true;
            }, IntPtr.Zero)) throw new Win32Exception();
            return visible;
        }
        Dictionary<int, int> Parents() {
            var parents = new Dictionary<int, int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) throw new Win32Exception();
            try {
                var entry = new PROCESSENTRY32(); entry.Size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry)) throw new Win32Exception();
                do { parents[(int)entry.Pid] = (int)entry.ParentPid; }
                while (Process32Next(snapshot, ref entry));
            } finally { CloseHandle(snapshot); }
            return parents;
        }
        // Job membership already proves ownership. Ancestry only finds a live,
        // strictly older, same-job windowed protector; a broken chain grants none.
        // Access/API failures are not broken chains: propagate and skip that candidate.
        sealed class HeadlessMember { public int Pid, Depth; public long Started; }
        bool HeadlessAncestors(int pid, long started, Dictionary<int, int> parents, out int depth) {
            depth = 0;
            var seen = new HashSet<int>();
            if (Visible(pid)) return false;
            while (seen.Add(pid)) {
                if (pid == rootPid && started == rootStarted) return true;
                int parentPid;
                if (!parents.TryGetValue(pid, out parentPid) || parentPid <= 0) return true;
                // Limited query + SYNCHRONIZE, never Process.Handle (ALL_ACCESS).
                bool synchronize = true;
                IntPtr handle = OpenProcess(0x101000u, false, (uint)parentPid);
                if (handle == IntPtr.Zero) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 5) { // ERROR_ACCESS_DENIED: retry without SYNCHRONIZE.
                        synchronize = false;
                        handle = OpenProcess(0x1000u, false, (uint)parentPid);
                        error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                    }
                    if (handle == IntPtr.Zero) {
                        if (error == 87) return true; // ERROR_INVALID_PARAMETER: PID gone.
                        throw new Win32Exception(error);
                    }
                }
                try {
                    if (GetProcessId(handle) != (uint)parentPid) throw new Win32Exception();
                    bool? exited = HasExited(handle, synchronize);
                    if (exited == true) return true;
                    long parentStarted = CreationTime(handle);
                    bool belongs;
                    if (HasExited(handle, synchronize) == true || parentStarted >= started) return true;
                    if (!IsProcessInJob(handle, job, out belongs)) throw new Win32Exception();
                    if (!belongs) return true;
                    if (parentPid == rootPid && parentStarted != rootStarted) return true;
                    // An ambiguous query-only ancestor is not proof of a traversable live
                    // chain. Preserve this candidate, without pretending cleanup failed.
                    if (exited == null) return false;
                    if (Visible(parentPid) && HasExited(handle, synchronize) == false && CreationTime(handle) == parentStarted) return false;
                    pid = parentPid; started = parentStarted; depth++;
                } finally { CloseHandle(handle); }
            }
            return true;
        }
        // Capture identity through the SAME cached handle used to kill, recheck job
        // membership and each live ancestor, and stop at the exact registered launch root.
        public void StopHeadless() {
            if (rootPid == 0) {
                Console.Error.WriteLine("Launch root registration pending; emergency stop preserved its members.");
                return;
            }
            if (DateTime.UtcNow.ToFileTimeUtc() - rootStarted < 30000000L) {
                Console.Error.WriteLine("Launch job still starting (3 s grace); emergency stop preserved its members.");
                return;
            }
            bool failed = false;
            var parents = Parents();
            var eligible = new List<HeadlessMember>();
            // Snapshot eligibility before any kills: never erase a parent needed by a child.
            foreach (int pid in Members()) {
                try {
                    using (var member = Process.GetProcessById(pid)) {
                        IntPtr handle = member.Handle;
                        long started = CreationTime(handle);
                        bool belongs;
                        if (!IsProcessInJob(handle, job, out belongs)) { failed = true; continue; }
                        int depth;
                        if (belongs && !member.HasExited && HeadlessAncestors(pid, started, parents, out depth))
                            eligible.Add(new HeadlessMember { Pid = pid, Started = started, Depth = depth });
                    }
                } catch (ArgumentException) { }
                catch (InvalidOperationException) { } // Process already exited; nothing to kill.
                catch (Win32Exception) { failed = true; }
            }
            // Children first; exited ancestors never exempt surviving owned descendants.
            eligible.Sort(delegate(HeadlessMember a, HeadlessMember b) { return b.Depth.CompareTo(a.Depth); });
            foreach (var candidate in eligible) {
                int pid = candidate.Pid;
                try {
                    using (var member = Process.GetProcessById(pid)) {
                        IntPtr handle = member.Handle;
                        long started = CreationTime(handle);
                        bool belongs;
                        if (!IsProcessInJob(handle, job, out belongs)) { failed = true; continue; }
                        int depth;
                        if (!belongs || member.HasExited || started != candidate.Started ||
                            !HeadlessAncestors(pid, started, Parents(), out depth)) continue;
                        if (!member.HasExited && CreationTime(handle) == started) {
                            member.Kill();
                            if (!member.WaitForExit(1000)) throw new Win32Exception();
                        }
                    }
                } catch (ArgumentException) { }
                catch (InvalidOperationException) { } // Process already exited; nothing to kill.
                catch (Win32Exception) { failed = true; }
            }
            if (failed) throw new InvalidOperationException("Headless member cleanup incomplete.");
        }
        public int[] Members() {
            int size = 1024;
            while (true) {
                IntPtr data = Marshal.AllocHGlobal(size);
                try {
                    uint returned;
                    if (!QueryInformationJobObject(job, 3, data, (uint)size, out returned)) {
                        if (Marshal.GetLastWin32Error() == 234 && size < 16777216) { size *= 2; continue; }
                        throw new Win32Exception();
                    }
                    int count = Marshal.ReadInt32(data, 4);
                    var members = new List<int>();
                    for (int i = 0; i < count; i++) {
                        long pid = Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
                        if (pid > 0 && pid <= int.MaxValue) members.Add((int)pid);
                    }
                    return members.ToArray();
                } finally { Marshal.FreeHGlobal(data); }
            }
        }
        public int Id { get; private set; }
        public uint ThreadId { get; private set; }
        public long Started { get; private set; }
        void Limits() {
            var limits = new EXTENDED_LIMIT();
            // No breakaway and NO implicit kill on handle close. The watchdog owns
            // the job before creation; its retained handle authorizes explicit cleanup.
            limits.Basic.Flags = 0u;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
                throw new Win32Exception();
        }
        public static LaunchGuard Start(string path, string arguments, string cwd, LaunchGuard guard) {
            IntPtr attributes = IntPtr.Zero, value = IntPtr.Zero, parentValue = IntPtr.Zero;
            bool initialized = false;
            try {
                IntPtr size = IntPtr.Zero;
                guard.CheckParent();
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Win32Exception();
                initialized = true;
                value = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(value, guard.job);
                // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the job atomically during creation;
                // there is no CreateProcess -> AssignProcessToJobObject interruption window.
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), value,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                parentValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(parentValue, guard.parent);
                // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS: the session owner, NOT the helper,
                // is the OS parent. Helper/overlay tree retirement cannot reach launched apps.
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20000), parentValue,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                guard.CheckParent();
                var startup = new STARTUPINFOEX();
                startup.Startup.Size = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.Attributes = attributes;
                PROCESS_INFORMATION child;
                // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
                if (!CreateProcess(path, new StringBuilder("\"" + path + "\" " + arguments), IntPtr.Zero,
                    IntPtr.Zero, false, 0x08080004, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
                guard.process = child.Process; guard.thread = child.Thread; guard.Id = checked((int)child.Pid);
                guard.ThreadId = child.Tid;
                guard.Started = CreationTime(guard.process);
                return guard;
            } catch {
                // Atomic assignment means a failed/suspended creation cannot escape
                // the already-retained session job. Do not kill on provider retirement.
                guard.Dispose(); throw;
            }
            finally {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
                if (parentValue != IntPtr.Zero) Marshal.FreeHGlobal(parentValue);
            }
        }
        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
            if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
            if (parent != IntPtr.Zero) { CloseHandle(parent); parent = IntPtr.Zero; }
        }
    }
}
'@ | Out-Null
