using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using static ProjectVI.Sandbox.Native;

namespace ProjectVI.Sandbox;

public sealed record SandboxOptions
{
    /// <summary>AppContainer profile name. The profile is created once and reused.</summary>
    public string ContainerName { get; init; } = "ProjectVI.ClientScripts";

    /// <summary>Folders the sandboxed process may read (recursively). Nothing else is readable except system files.</summary>
    public IReadOnlyList<string> ReadableFolders { get; init; } = [];

    /// <summary>Memory cap for the sandboxed process, in megabytes.</summary>
    public int MemoryLimitMb { get; init; } = 1024;
}

/// <summary>
/// Starts a program inside an AppContainer with no capabilities: no network, no access to the
/// user's files or registry, plus a Job object that caps memory, forbids child processes and
/// kills the program when this launcher exits. The program shares this process's stdin, stdout
/// and stderr, so whoever started the launcher talks to the sandboxed program directly.
/// </summary>
[SupportedOSPlatform("windows")]
public static class AppContainerLauncher
{
    public static int Run(string program, IReadOnlyList<string> args, SandboxOptions options)
    {
        IntPtr sid = GetOrCreateContainerSid(options.ContainerName);
        try
        {
            var identity = new SecurityIdentifier(sid);
            foreach (string folder in options.ReadableFolders.Append(Path.GetDirectoryName(Path.GetFullPath(program))!).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                GrantRead(folder, identity);
            }
            return Launch(program, args, sid, options.MemoryLimitMb);
        }
        finally
        {
            FreeSid(sid);
        }
    }

    public static IntPtr GetOrCreateContainerSid(string name)
    {
        int hr = CreateAppContainerProfile(name, name, "ProjectVI client scripts", IntPtr.Zero, 0, out IntPtr sid);
        if (hr == HRESULT_ALREADY_EXISTS)
        {
            hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        }
        if (hr != 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }
        return sid;
    }

    /// <summary>Lets the container read a folder and everything under it. Idempotent.</summary>
    public static void GrantRead(string folder, SecurityIdentifier container)
    {
        var directory = new DirectoryInfo(folder);
        if (!directory.Exists)
        {
            throw new DirectoryNotFoundException($"Folder to share with the sandbox doesn't exist: {folder}");
        }
        DirectorySecurity security = directory.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(
            container,
            FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static int Launch(string program, IReadOnlyList<string> args, IntPtr sid, int memoryLimitMb)
    {
        // The child uses our own standard handles, so they must be inheritable.
        IntPtr[] stdHandles = [GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)];
        IntPtr[] inherit = stdHandles.Where(h => h != IntPtr.Zero && h != new IntPtr(-1)).Distinct().ToArray();
        foreach (IntPtr h in inherit)
        {
            SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }

        IntPtr job = CreateJob(memoryLimitMb);
        IntPtr attributeList = IntPtr.Zero;
        IntPtr capabilitiesPtr = IntPtr.Zero;
        IntPtr handleListPtr = IntPtr.Zero;
        try
        {
            var capabilities = new SECURITY_CAPABILITIES { AppContainerSid = sid };
            capabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf<SECURITY_CAPABILITIES>());
            Marshal.StructureToPtr(capabilities, capabilitiesPtr, false);

            handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * inherit.Length);
            Marshal.Copy(inherit, 0, handleListPtr, inherit.Length);

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributeList = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributeList, 2, 0, ref size), "InitializeProcThreadAttributeList");
            Check(UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capabilitiesPtr,
                Marshal.SizeOf<SECURITY_CAPABILITIES>(), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(capabilities)");
            // Only the standard handles are inherited, nothing else this process has open.
            Check(UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleListPtr,
                IntPtr.Size * inherit.Length, IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handles)");

            var startup = new STARTUPINFOEX
            {
                StartupInfo = new STARTUPINFO
                {
                    cb = Marshal.SizeOf<STARTUPINFOEX>(),
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = stdHandles[0],
                    hStdOutput = stdHandles[1],
                    hStdError = stdHandles[2]
                },
                lpAttributeList = attributeList
            };

            var commandLine = new StringBuilder(BuildCommandLine(program, args));
            Check(CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | DETACHED_PROCESS,
                IntPtr.Zero, Path.GetDirectoryName(Path.GetFullPath(program)), ref startup, out PROCESS_INFORMATION process), "CreateProcess");

            try
            {
                if (!AssignProcessToJobObject(job, process.hProcess))
                {
                    int error = Marshal.GetLastWin32Error();
                    TerminateProcess(process.hProcess, 1);
                    throw new Win32Exception(error, "AssignProcessToJobObject failed");
                }
                ResumeThread(process.hThread);
                WaitForSingleObject(process.hProcess, INFINITE);
                GetExitCodeProcess(process.hProcess, out uint exitCode);
                return unchecked((int)exitCode);
            }
            finally
            {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (capabilitiesPtr != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesPtr);
            if (handleListPtr != IntPtr.Zero) Marshal.FreeHGlobal(handleListPtr);
            CloseHandle(job); // kill-on-close takes the child down with us
        }
    }

    private static IntPtr CreateJob(int memoryLimitMb)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                ActiveProcessLimit = 1 // the sandboxed program can't start other programs
            },
            ProcessMemoryLimit = (UIntPtr)((ulong)memoryLimitMb * 1024 * 1024)
        };
        Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
        return job;
    }

    // Quoting rules from CommandLineToArgvW, so arguments with spaces and quotes arrive intact.
    internal static string BuildCommandLine(string program, IEnumerable<string> args)
    {
        return string.Join(' ', new[] { program }.Concat(args).Select(Quote));

        static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '"']) < 0)
            {
                return arg;
            }
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1).Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes).Append(c);
                }
                backslashes = 0;
            }
            return sb.Append('\\', backslashes * 2).Append('"').ToString();
        }
    }

    private static void Check(bool ok, string what)
    {
        if (!ok)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"{what} failed");
        }
    }
}
