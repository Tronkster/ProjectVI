namespace ProjectVI.ScriptHost.Tests;

/// <summary>Finds sibling build outputs in scripting/dotnet/artifacts/bin/&lt;project&gt;/&lt;config&gt;/.</summary>
internal static class Artifacts
{
    private static readonly string TestDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly string Configuration = Path.GetFileName(TestDir);
    private static readonly string BinRoot = Path.GetDirectoryName(Path.GetDirectoryName(TestDir))!;

    public static string File(string project, string fileName)
    {
        string path = Path.Combine(BinRoot, project, Configuration, fileName);
        if (!System.IO.File.Exists(path))
        {
            throw new FileNotFoundException($"Build output missing: {path}. Build the solution first.");
        }
        return path;
    }

    public static string HostDll => File("ProjectVI.ScriptHost", "ProjectVI.ScriptHost.dll");
    public static string TestResources => File("ProjectVI.TestResources", "ProjectVI.TestResources.dll");
    public static string BrokenResource => File("ProjectVI.TestResources.Broken", "ProjectVI.TestResources.Broken.dll");
}
