using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;

namespace ProjectVI.ScriptHost;

/// <summary>
/// One collectible load context per running resource, so a stopped resource can be unloaded and
/// rebuilt without restarting the host.
///
/// The ProjectVI SDK assemblies always come from the host: if a resource shipped its own copy,
/// its ServerScript would be a different type and none of its scripts would be found.
/// Assemblies are loaded from memory, so the files stay unlocked and can be rebuilt while the server runs.
/// </summary>
internal sealed class ResourceLoadContext(string resourceName, string directory)
    : AssemblyLoadContext($"resource:{resourceName}", isCollectible: true)
{
    private static readonly HashSet<string> SdkAssemblies = new(StringComparer.OrdinalIgnoreCase)
    {
        "ProjectVI.Shared", "ProjectVI.Server", "ProjectVI.Client"
    };

    public string ResourceName { get; } = resourceName;

    public Assembly LoadResourceAssembly(string path)
    {
        using var assembly = File.OpenRead(path);
        string pdbPath = Path.ChangeExtension(path, ".pdb");
        if (File.Exists(pdbPath))
        {
            using var pdb = File.OpenRead(pdbPath);
            return LoadFromStream(new MemoryStream(ReadAll(assembly)), new MemoryStream(ReadAll(pdb)));
        }
        return LoadFromStream(new MemoryStream(ReadAll(assembly)));
    }

    protected override Assembly? Load(AssemblyName assemblyName)
    {
        if (assemblyName.Name is null || SdkAssemblies.Contains(assemblyName.Name))
        {
            return null; // the host's copy, from the default context
        }
        // A private dependency shipped next to the resource's own assemblies.
        foreach (string candidate in Directory.EnumerateFiles(directory, assemblyName.Name + ".dll", SearchOption.AllDirectories))
        {
            return LoadResourceAssembly(candidate);
        }
        return null; // framework assemblies come from the default context
    }

    /// <summary>
    /// Refuses assemblies built against an incompatible SDK. While the SDK is 0.x, any minor
    /// version change can break things, so 0.x versions must match exactly in major.minor.
    /// </summary>
    public static void EnsureCompatibleSdk(string path, Version hostSdk)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata)
        {
            throw new InvalidOperationException($"{Path.GetFileName(path)} isn't a .NET assembly.");
        }
        MetadataReader metadata = pe.GetMetadataReader();
        foreach (AssemblyReferenceHandle handle in metadata.AssemblyReferences)
        {
            AssemblyReference reference = metadata.GetAssemblyReference(handle);
            string name = metadata.GetString(reference.Name);
            if (!SdkAssemblies.Contains(name))
            {
                continue;
            }
            Version built = reference.Version;
            if (!IsCompatible(built, hostSdk))
            {
                throw new InvalidOperationException(
                    $"{Path.GetFileName(path)} was built for ProjectVI SDK {built.ToString(3)}, but this host runs SDK {hostSdk.ToString(3)}. Rebuild the resource against SDK {hostSdk.ToString(2)}.");
            }
        }
    }

    internal static bool IsCompatible(Version built, Version host) =>
        host.Major == 0
            ? built.Major == 0 && built.Minor == host.Minor
            : built.Major == host.Major && built <= host;

    private static byte[] ReadAll(Stream stream)
    {
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}
