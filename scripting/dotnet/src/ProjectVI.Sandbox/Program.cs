// projectvi-sandbox: runs a program inside a locked-down AppContainer.
//
// Usage: projectvi-sandbox [--read <folder>]... [--memory-mb <n>] [--name <container>] -- <program> [args...]

using ProjectVI.Sandbox;

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("projectvi-sandbox only works on Windows.");
    return 2;
}

var readable = new List<string>();
int memoryMb = 1024;
string name = "ProjectVI.ClientScripts";
int i = 0;
for (; i < args.Length && args[i] != "--"; i++)
{
    switch (args[i])
    {
        case "--read" when i + 1 < args.Length:
            readable.Add(Path.GetFullPath(args[++i]));
            break;
        case "--memory-mb" when i + 1 < args.Length && int.TryParse(args[i + 1], out int mb) && mb >= 64:
            memoryMb = mb;
            i++;
            break;
        case "--name" when i + 1 < args.Length:
            name = args[++i];
            break;
        default:
            Console.Error.WriteLine($"Unknown option: {args[i]}");
            return 2;
    }
}
if (i >= args.Length - 1)
{
    Console.Error.WriteLine("Usage: projectvi-sandbox [--read <folder>]... [--memory-mb <n>] -- <program> [args...]");
    return 2;
}

string program = Path.GetFullPath(args[i + 1]);
string[] programArgs = args[(i + 2)..];
try
{
    return AppContainerLauncher.Run(program, programArgs, new SandboxOptions
    {
        ContainerName = name,
        ReadableFolders = readable,
        MemoryLimitMb = memoryMb
    });
}
catch (Exception ex)
{
    Console.Error.WriteLine($"projectvi-sandbox: {ex.Message}");
    return 3;
}
