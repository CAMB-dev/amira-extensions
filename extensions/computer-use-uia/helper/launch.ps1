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
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
            out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr data, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        IntPtr job, process, thread;
        public string Name { get; private set; }
        public long HelperHandle { get; private set; }
        public static LaunchGuard CreateFor(string id, int helperPid, long helperStarted) {
            var guard = new LaunchGuard();
            try {
                guard.Name = id; // Opaque protocol ID only; the kernel job is UNNAMED.
                guard.job = CreateJobObject(IntPtr.Zero, null);
                if (guard.job == IntPtr.Zero) throw new Win32Exception();
                guard.Limits();
                using (var helper = Process.GetProcessById(helperPid)) {
                    IntPtr target = helper.Handle;
                    if (helper.HasExited || helper.StartTime.ToUniversalTime().Ticks != helperStarted)
                        throw new InvalidOperationException("Helper identity changed.");
                    IntPtr duplicate;
                    // ASSIGN | QUERY | TERMINATE, not SET_ATTRIBUTES. Never inherit the handle.
                    if (!DuplicateHandle(GetCurrentProcess(), guard.job, target, out duplicate,
                        0x0001u | 0x0004u | 0x0008u, false, 0)) throw new Win32Exception();
                    guard.HelperHandle = duplicate.ToInt64();
                }
                return guard;
            } catch { guard.Dispose(); throw; }
        }
        public static LaunchGuard FromHandle(string id, long handle) {
            return new LaunchGuard { Name = id, job = new IntPtr(handle) };
        }
        public void Terminate() {
            if (!TerminateJobObject(job, 1)) throw new Win32Exception();
        }
        // Capture each member's creation time through the SAME cached handle used to kill.
        // Membership is rechecked after opening the PID (which may have been recycled).
        public void StopHeadless() {
            bool failed = false;
            foreach (int pid in Members()) {
                try {
                    using (var member = Process.GetProcessById(pid)) {
                        IntPtr handle = member.Handle;
                        long started = member.StartTime.ToUniversalTime().Ticks;
                        bool belongs;
                        if (!IsProcessInJob(handle, job, out belongs)) { failed = true; continue; }
                        if (!belongs || member.HasExited) continue;
                        bool visible = false;
                        if (!EnumWindows(delegate(IntPtr window, IntPtr data) {
                            uint owner; GetWindowThreadProcessId(window, out owner);
                            if (owner == pid && IsWindowVisible(window)) visible = true;
                            return true;
                        }, IntPtr.Zero)) throw new Win32Exception();
                        if (!visible && !member.HasExited && member.StartTime.ToUniversalTime().Ticks == started) {
                            member.Kill();
                            if (!member.WaitForExit(1000)) throw new Win32Exception();
                        }
                    }
                } catch (ArgumentException) { } // Exited before opening; never guess ownership.
                catch (InvalidOperationException) { } // Exited between opening and inspecting.
                catch (Win32Exception) { failed = true; } // Continue; report genuine access/kill failures.
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
        public long Started { get; private set; }
        void Limits() {
            var limits = new EXTENDED_LIMIT();
            // No breakaway and NO implicit kill on handle close. The watchdog owns
            // the job before creation; only MAC-verified explicit cleanup may terminate it.
            limits.Basic.Flags = 0u;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
                throw new Win32Exception();
        }
        public static LaunchGuard Start(string path, string arguments, string cwd, LaunchGuard guard) {
            IntPtr attributes = IntPtr.Zero, value = IntPtr.Zero;
            bool initialized = false;
            try {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
                initialized = true;
                value = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(value, guard.job);
                // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the job atomically during creation;
                // there is no CreateProcess -> AssignProcessToJobObject interruption window.
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), value,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var startup = new STARTUPINFOEX();
                startup.Startup.Size = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.Attributes = attributes;
                PROCESS_INFORMATION child;
                // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
                if (!CreateProcess(path, new StringBuilder("\"" + path + "\" " + arguments), IntPtr.Zero,
                    IntPtr.Zero, false, 0x08080004, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
                guard.process = child.Process; guard.thread = child.Thread; guard.Id = checked((int)child.Pid);
                long created, exited, kernel, user;
                if (!GetProcessTimes(guard.process, out created, out exited, out kernel, out user)) throw new Win32Exception();
                guard.Started = DateTime.FromFileTimeUtc(created).Ticks;
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
            }
        }
        public void Commit() {
            // The caller MUST persist the job and await watchdog retention before execution.
            if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception();
        }
        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
            if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        }
    }
}
'@ | Out-Null
