using System.Reflection;
using System.Text.Json;
using ProjectVI.Runtime;
using ProjectVI.Server;

namespace ProjectVI.ScriptHost;

/// <summary>Handles the core's requests: initialize, resources, commands, exports and player updates.</summary>
internal sealed class ResourceHost(HostRuntime runtime, ScriptThread scripts)
{
    public const int ProtocolVersion = 1;
    public const int ResourceFailed = 1001;

    private sealed record Running(ResourceLoadContext LoadContext, LoadedScripts Scripts);

    private readonly Dictionary<string, Running> running = new(StringComparer.Ordinal);

    public static Version SdkVersion => typeof(Script).Assembly.GetName().Version ?? new Version(0, 0, 0);

    /// <summary>Weak references to unloaded contexts, so tests can prove nothing keeps them alive.</summary>
    public List<WeakReference> UnloadedContexts { get; } = [];

    public void Register(RpcConnection rpc)
    {
        rpc.OnRequest("initialize", p => scripts.InvokeAsync<object?>(() =>
        {
            int requested = p.TryGetProperty("protocol", out JsonElement v) && v.TryGetInt32(out int n) ? n : 0;
            if (requested != ProtocolVersion)
            {
                throw new RpcException(RpcConnection.InvalidParams, $"This host speaks protocol {ProtocolVersion}, the core asked for {requested}.");
            }
            if (runtime.Side == "server")
            {
                JsonElement s = p.TryGetProperty("server", out JsonElement server) ? server : default;
                var info = new ServerInfo(
                    s.ValueKind == JsonValueKind.Object && s.TryGetProperty("name", out JsonElement name) ? name.GetString() ?? "" : "",
                    s.ValueKind == JsonValueKind.Object && s.TryGetProperty("maxPlayers", out JsonElement max) ? max.GetInt32() : 0,
                    s.ValueKind == JsonValueKind.Object && s.TryGetProperty("port", out JsonElement port) ? port.GetInt32() : 0);
                IEnumerable<JsonElement> players = p.TryGetProperty("players", out JsonElement list) && list.ValueKind == JsonValueKind.Array ? list.EnumerateArray() : [];
                runtime.InitializeServer(info, players);
            }
            return Task.FromResult<object?>(new { protocol = ProtocolVersion, side = runtime.Side, sdkVersion = SdkVersion.ToString(3), pid = Environment.ProcessId });
        }));

        rpc.OnRequest("resource/start", p => scripts.InvokeAsync<object?>(() => StartAsync(
            Required(p, "name"),
            Required(p, "dir"),
            p.TryGetProperty("assemblies", out JsonElement a) ? a.EnumerateArray().Select(x => x.GetString()!).ToList() : [],
            p.TryGetProperty("config", out JsonElement config) ? config.Clone() : default)));

        rpc.OnRequest("resource/stop", p => scripts.InvokeAsync<object?>(async () =>
        {
            await StopAsync(Required(p, "name"));
            return new { };
        }));

        rpc.OnRequest("command/invoke", p => scripts.InvokeAsync<object?>(async () =>
        {
            int? source = p.TryGetProperty("source", out JsonElement s) && s.ValueKind == JsonValueKind.Number ? s.GetInt32() : null;
            string[] args = p.TryGetProperty("args", out JsonElement a) ? a.EnumerateArray().Select(x => x.GetString() ?? "").ToArray() : [];
            string? error = await runtime.InvokeCommandAsync(new CommandInvocation(Required(p, "name"), source, args));
            return new { error };
        }));

        rpc.OnRequest("export/invoke", p => scripts.InvokeAsync(() => runtime.InvokeExportAsync(
            Required(p, "resource"),
            Required(p, "name"),
            p.TryGetProperty("args", out JsonElement a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().Select(x => x.Clone()).ToArray() : [])));

        rpc.OnNotification("event/dispatch", p =>
        {
            string name = Required(p, "name");
            bool network = p.TryGetProperty("network", out JsonElement net) && net.GetBoolean();
            JsonElement[] args = p.TryGetProperty("args", out JsonElement a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().Select(x => x.Clone()).ToArray() : [];
            int? source = p.TryGetProperty("source", out JsonElement s) && s.ValueKind == JsonValueKind.Number ? s.GetInt32() : null;
            runtime.Dispatch(new EventInvocation(name, args, network ? EventOrigin.Network : EventOrigin.Local, source), network);
        });

        // Player updates arrive in order with events, on the script thread, so handlers always see current data.
        rpc.OnNotification("player/joined", p => { JsonElement player = p.GetProperty("player").Clone(); scripts.Post(() => runtime.Server?.Players.Upsert(player)); });
        rpc.OnNotification("player/updated", p => { JsonElement player = p.GetProperty("player").Clone(); scripts.Post(() => runtime.Server?.Players.Upsert(player)); });
        rpc.OnNotification("player/left", p => { int id = p.GetProperty("id").GetInt32(); scripts.Post(() => runtime.Server?.Players.Remove(id)); });
    }

    public async Task<object?> StartAsync(string name, string dir, IReadOnlyList<string> assemblyPaths, JsonElement config = default)
    {
        if (running.ContainsKey(name))
        {
            throw new RpcException(ResourceFailed, $"{name} is already running.");
        }
        if (assemblyPaths.Count == 0)
        {
            throw new RpcException(ResourceFailed, $"{name} lists no C# assemblies.");
        }

        var loadContext = new ResourceLoadContext(name, dir);
        try
        {
            var assemblies = new List<Assembly>();
            foreach (string path in assemblyPaths)
            {
                if (!File.Exists(path))
                {
                    throw new RpcException(ResourceFailed, $"{Path.GetFileName(path)} wasn't found. Build the resource first.");
                }
                ResourceLoadContext.EnsureCompatibleSdk(path, SdkVersion);
                assemblies.Add(loadContext.LoadResourceAssembly(path));
            }

            Type scriptBase = runtime.Side == "server" ? typeof(ServerScript) : typeof(Script);
            IReadOnlyList<Type> types = ScriptLoader.FindScriptTypes(assemblies, scriptBase);
            if (types.Count == 0)
            {
                throw new RpcException(ResourceFailed, $"{name} has no {scriptBase.Name} classes. Make a public class that derives from {scriptBase.Name}.");
            }

            HostRuntime.CurrentResource.Value = name;
            var context = new ScriptContext(runtime, new ResourceInfo(name, runtime.Side), runtime.Binding, config);
            LoadedScripts loaded = await ScriptLoader.StartAsync(context, types);
            running[name] = new Running(loadContext, loaded);
            runtime.Log(name, LogLevel.Debug, $"Started {types.Count} script(s): {string.Join(", ", types.Select(t => t.Name))}");
            return new { scripts = types.Select(t => t.FullName).ToArray() };
        }
        catch (Exception ex)
        {
            Unload(loadContext);
            if (ex is RpcException)
            {
                throw;
            }
            runtime.Log(name, LogLevel.Error, $"Couldn't start: {ex}");
            throw new RpcException(ResourceFailed, $"{name} couldn't start: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public async Task StopAsync(string name)
    {
        if (!running.Remove(name, out Running? resource))
        {
            return;
        }
        HostRuntime.CurrentResource.Value = name;
        await ScriptLoader.StopAsync(resource.Scripts);
        Unload(resource.LoadContext);
    }

    public async Task StopAllAsync()
    {
        foreach (string name in running.Keys.ToList())
        {
            await StopAsync(name);
        }
    }

    private void Unload(ResourceLoadContext loadContext)
    {
        UnloadedContexts.Add(new WeakReference(loadContext));
        loadContext.Unload();
    }

    private static string Required(JsonElement p, string property) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(property, out JsonElement v) && v.GetString() is { Length: > 0 } s
            ? s
            : throw new RpcException(RpcConnection.InvalidParams, $"Missing '{property}'.");
}
