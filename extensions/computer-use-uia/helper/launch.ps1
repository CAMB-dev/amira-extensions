# Atomic launch guard: even a forced helper exit between creation and journal publication
# cannot orphan a child. Only the exact CreateProcess handle enters this private job;
# descendants silently break away, so handoff targets never gain kill eligibility.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
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
        IntPtr job, process, thread;
        public int Id { get; private set; }
        public long Started { get; private set; }
        void Limits(bool guarded) {
            var limits = new EXTENDED_LIMIT();
            // KILL_ON_JOB_CLOSE only before durable identity publication. SILENT_BREAKAWAY_OK
            // prevents killing descendants, including apps which hand off to another process.
            limits.Basic.Flags = 0x1000u | (guarded ? 0x2000u : 0u);
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
                throw new Win32Exception();
        }
        public static LaunchGuard Start(string path, string arguments, string cwd) {
            var guard = new LaunchGuard();
            IntPtr attributes = IntPtr.Zero, value = IntPtr.Zero;
            bool initialized = false;
            try {
                guard.job = CreateJobObject(IntPtr.Zero, null);
                if (guard.job == IntPtr.Zero) throw new Win32Exception();
                guard.Limits(true);
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
            } catch { guard.Dispose(); throw; }
            finally {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            }
        }
        public void Commit() {
            // The caller MUST persist Id+Started before letting the child execute.
            if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception();
            Limits(false);
        }
        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
            if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        }
    }
}
'@ | Out-Null
