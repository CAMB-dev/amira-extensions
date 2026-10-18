# Session-owned unnamed jobs: the watchdog creates each kernel object and independent
# custody retains a cleanup duplicate BEFORE creation. Only an ASSIGN duplicate enters
# the verified helper; public job names/journal records never grant cleanup authority.
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
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
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
        public static long CreationTime(IntPtr handle) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
            return created; // UTC FILETIME, never local StartTime -> UTC (ambiguous across DST).
        }
        IntPtr job, process, thread, parent, custodyPin;
        Process custodySource, custodyWriter;
        bool custodied;
        public long CleanupHandle { get { return custodyPin.ToInt64(); } }
        public void ConfirmCustody() {
            if (custodied || custodyPin == IntPtr.Zero) throw new InvalidOperationException("Invalid custody acknowledgement.");
            custodied = true;
            CloseHandle(custodyPin); custodyPin = IntPtr.Zero;
        }
        public static LaunchGuard RetainForCleanup(string id, int sourcePid, long sourceStarted, long handle,
            int writerPid, long writerStarted) {
            var guard = new LaunchGuard { Name = id };
            try {
                var source = Process.GetProcessById(sourcePid);
                guard.custodySource = source;
                if (source.HasExited || CreationTime(source.Handle) != sourceStarted)
                    throw new InvalidOperationException("Custody source identity changed.");
                var writer = Process.GetProcessById(writerPid);
                guard.custodyWriter = writer;
                if (writer.HasExited || CreationTime(writer.Handle) != writerStarted)
                    throw new InvalidOperationException("Custody writer identity changed.");
                // Pull a NEW local QUERY | TERMINATE duplicate. Never close a received
                // numeric handle: rejected/replayed input cannot close an unrelated local object.
                if (!DuplicateHandle(source.Handle, new IntPtr(handle), GetCurrentProcess(), out guard.job,
                    0x000Cu, false, 0)) throw new Win32Exception();
                guard.Members(); // Validate job type/query rights before custody acknowledgement.
                return guard;
            } catch { guard.Dispose(); throw; }
        }
        bool OriginalProducersExited() {
            // These handles were cached and creation-time verified during retention.
            // Never reopen a producer PID: it may now name an unrelated process.
            if (custodyWriter == null || custodySource == null) return false;
            return custodyWriter.WaitForExit(0) && custodySource.WaitForExit(0);
        }
        public void RetireProducers() {
            // Cached, creation-time-verified handles came ONLY from the private offer.
            // End both launch producers before draining, so even suspended/in-flight
            // creation cannot add a member after an apparently empty job was checked.
            bool failed = false;
            foreach (var producer in new Process[] { custodyWriter, custodySource }) {
                if (producer == null) continue;
                try {
                    if (!producer.HasExited) producer.Kill();
                    if (!producer.WaitForExit(1000)) failed = true;
                } catch (InvalidOperationException) {
                    try { if (!producer.HasExited) failed = true; } catch { failed = true; }
                } catch (Win32Exception) { failed = true; }
            }
            if (failed) throw new InvalidOperationException("Custody producer retirement incomplete.");
        }
        int rootPid;
        long rootStarted;
        public void RememberRoot(int pid, long started) {
            if (rootPid != 0) {
                if (rootPid == pid && rootStarted == started) return;
                throw new InvalidOperationException("Custody root identity changed.");
            }
            using (var root = Process.GetProcessById(pid)) {
                IntPtr handle = root.Handle;
                bool belongs;
                if (root.HasExited || CreationTime(handle) != started ||
                    !IsProcessInJob(handle, job, out belongs) || !belongs)
                    throw new InvalidOperationException("Custody root is not an exact owned job member.");
            }
            // Retain commit/grace metadata while the root is still suspended. No PID-based
            // recovery authority: only this already-retained native job can authorize a stop.
            rootPid = pid; rootStarted = started;
        }
        public void SetRoot(int pid, long started, uint tid) {
            if (!custodied) throw new InvalidOperationException("Independent launch custody is unavailable.");
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
        public static LaunchGuard CreateFor(string id, int helperPid, long helperStarted,
            int custodyPid, long custodyStarted) {
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
                    // ASSIGN only; cleanup/query authority stays with session owners. Never inherit.
                    if (!DuplicateHandle(GetCurrentProcess(), guard.job, target, out duplicate,
                        0x0001u, false, 0)) throw new Win32Exception();
                    guard.HelperHandle = duplicate.ToInt64();
                    try {
                        using (var owner = Process.GetProcessById(custodyPid)) {
                            if (owner.HasExited || CreationTime(owner.Handle) != custodyStarted)
                                throw new InvalidOperationException("Custody owner identity changed.");
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
                // Pin the offered source slot until an authenticated duplicate ack.
                // On timeout/rejection, keep it until this process exits (Dispose must
                // not recycle it under a delayed custody pull). No launch may run yet.
                if (!DuplicateHandle(GetCurrentProcess(), guard.job, GetCurrentProcess(), out guard.custodyPin,
                    0x000Cu, false, 0)) throw new Win32Exception();
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
            // INHERITED (4), and unknown cloak flags cannot protect the owning process.
            if (!IsWindowVisible(window)) return false;
            // Unverifiable is not windowless: preserve this candidate on native-query failure.
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) != 0) throw new Win32Exception();
            if ((cloaked & ~2u) != 0) return false;
            int styles = GetWindowLong(window, -20);
            RECT rect;
            bool iconic = IsIconic(window);
            if (!iconic) {
                if (!GetWindowRect(window, out rect)) throw new Win32Exception();
            } else {
                // Ignore iconic bounds; visible minimized windows protect even with WS_EX_TOOLWINDOW
                // or saved placement on a removed monitor.
                var placement = new WINDOWPLACEMENT(); placement.Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (!GetWindowPlacement(window, ref placement)) throw new Win32Exception();
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
        // D113: only this member's own windows protect it. The injectable observation
        // keeps classification pure; native failures propagate and preserve the candidate.
        public static bool ShouldStopMember(int pid, bool belongs, bool exited, Func<int, bool> visible) {
            return belongs && !exited && !visible(pid);
        }
        const int HeadlessScanLimit = 4; // Three kill passes, then a read-only completion scan.
        const int HeadlessBudgetMs = 3000; // Cooperative bound; native calls themselves may block.
        sealed class HeadlessMember { public int Pid; public long Started; }
        // Capture identity through the SAME cached handle used to kill and recheck
        // retained-job membership and this member's own windows immediately before killing.
        public void StopHeadless() {
            if (rootPid == 0) {
                if (!OriginalProducersExited()) {
                    Console.Error.WriteLine("Launch root registration pending; emergency stop preserved its members.");
                    return;
                }
                // Both exact producers exited without recording a root. This retained job
                // is abandoned, not a pending launch. Apply the same per-member checks;
                // even here, never substitute whole-job termination for window classification.
            } else if (DateTime.UtcNow.ToFileTimeUtc() - rootStarted < 30000000L) {
                Console.Error.WriteLine("Launch job still starting (3 s grace); emergency stop preserved its members.");
                return;
            }
            bool failed = false;
            var clock = Stopwatch.StartNew();
            for (int scan = 0; scan < HeadlessScanLimit; scan++) {
                var eligible = new List<HeadlessMember>();
                // Re-enumerate after termination: a worker may have created another job member.
                // Each scan snapshots identities, then repeats membership/window checks before killing.
                foreach (int pid in Members()) {
                    if (clock.ElapsedMilliseconds >= HeadlessBudgetMs) { failed = true; break; }
                    try {
                        using (var member = Process.GetProcessById(pid)) {
                            IntPtr handle = member.Handle;
                            long started = CreationTime(handle);
                            bool belongs;
                            if (!IsProcessInJob(handle, job, out belongs)) { failed = true; continue; }
                            if (ShouldStopMember(pid, belongs, member.HasExited, Visible))
                                eligible.Add(new HeadlessMember { Pid = pid, Started = started });
                        }
                    } catch (ArgumentException) { }
                    catch (InvalidOperationException) { } // Process already exited; nothing to kill.
                    catch (Win32Exception) { failed = true; }
                }
                if (eligible.Count == 0) break;
                // The final scan verifies quiescence without an unverified last kill batch.
                if (scan == HeadlessScanLimit - 1 || clock.ElapsedMilliseconds >= HeadlessBudgetMs) {
                    failed = true;
                    break;
                }
                foreach (var candidate in eligible) {
                    if (clock.ElapsedMilliseconds >= HeadlessBudgetMs) { failed = true; break; }
                    int pid = candidate.Pid;
                    try {
                        using (var member = Process.GetProcessById(pid)) {
                            IntPtr handle = member.Handle;
                            long started = CreationTime(handle);
                            bool belongs;
                            if (!IsProcessInJob(handle, job, out belongs)) { failed = true; continue; }
                            if (started != candidate.Started ||
                                !ShouldStopMember(pid, belongs, member.HasExited, Visible)) continue;
                            if (!member.HasExited && CreationTime(handle) == started) {
                                member.Kill();
                                if (!member.WaitForExit(1000)) throw new Win32Exception();
                            }
                        }
                    } catch (ArgumentException) { }
                    catch (InvalidOperationException) { } // Process already exited; nothing to kill.
                    catch (Win32Exception) { failed = true; }
                }
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
            // No breakaway and NO implicit kill on handle close. Both the watchdog
            // and independent session custody hold explicit cleanup authority before creation.
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
                // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS: independent session custody,
                // NOT a helper/watchdog generation, is the OS parent. Provider/monitor
                // retirement cannot reach apps; host exit can still tree-close custody.
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20000), parentValue,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                guard.CheckParent();
                var startup = new STARTUPINFOEX();
                startup.Startup.Size = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.Attributes = attributes;
                PROCESS_INFORMATION child;
                // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
                if (!CreateProcess(path, new StringBuilder("\"" + path + "\" " + arguments), IntPtr.Zero,
                    IntPtr.Zero, false, 0x08080004, IntPtr.Zero, string.IsNullOrEmpty(cwd) ? null : cwd, ref startup, out child)) throw new Win32Exception();
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
            if (custodySource != null) { custodySource.Dispose(); custodySource = null; }
            if (custodyWriter != null) { custodyWriter.Dispose(); custodyWriter = null; }
            // An unacknowledged custodyPin deliberately lives until process exit.
            // Recycling its source slot could turn a delayed transfer into foreign authority.
        }
    }
}
'@ | Out-Null
