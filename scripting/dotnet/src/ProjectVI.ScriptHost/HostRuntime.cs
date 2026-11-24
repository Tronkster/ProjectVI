using System.Text.Json;
using ProjectVI.Runtime;
using ProjectVI.Server;

namespace ProjectVI.ScriptHost;

/// <summary>
/// <see cref="IScriptRuntime"/> backed by the core on the other end of the RPC connection.
/// Events go out as <c>event/emit</c> and come back as <c>event/dispatch</c>, so C# resources and
/// resources in other languages all share the core's event bus, command list and exports.
/// All state here is touched only on the script thread.
/// </summary>
internal sealed class HostRuntime : IScriptRuntime
{
    /// <summary>The resource whose code is running right now. Flows through awaits; used to tag output and natives.</summary>
    public static readonly AsyncLocal<string?> CurrentResource = new();

    private sealed record Subscription(string Resource, Func<EventInvocation, Task> Callback);

    private readonly ScriptThread scripts;
    private readonly Dictionary<(string Name, bool Network), List<Subscription>> subscriptions = [];
    private readonly Dictionary<string, (string Resource, CommandRegistration Registration)> commands = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<(string Resource, string Name), Func<EventInvocation, Task<object?>>> exports = [];
    private RpcConnection? rpc;
    private ServerServices? server;

    public HostRuntime(string side, ScriptThread scripts)
    {
        Side = side;
        this.scripts = scripts;
        Json = ScriptJson.CreateOptions(ServerServices.Converters(() => server?.Players));
    }

    public string Side { get; }

    public JsonSerializerOptions Json { get; }

    public TimeSpan TickInterval => Side == "server" ? TimeSpan.FromMilliseconds(50) : TimeSpan.FromMilliseconds(16);

    public TimeProvider Time => TimeProvider.System;

    public ServerServices? Server => server;

    private RpcConnection Rpc => rpc ?? throw new InvalidOperationException("Not connected yet.");

    public void Connect(RpcConnection connection) => rpc = connection;

    /// <summary>Called on initialize with the server's details and current players.</summary>
    public void InitializeServer(ServerInfo info, IEnumerable<JsonElement> players)
    {
        server = new ServerServices(this, info);
        server.Players.CurrentResource = () => CurrentResource.Value ?? "";
        foreach (JsonElement player in players) server.Players.Upsert(player);
    }

    public object? GetService(Type type) => type == typeof(ServerServices) ? server : null;

    public ISideBinding Binding => server?.Binding ?? (ISideBinding)NoSideBinding.Instance;

    public ILog CreateLog(string resource) => new HostLog(this, resource);

    public void Log(string? resource, LogLevel level, string message) =>
        rpc?.Notify("log", new { resource, level = level.ToString().ToLowerInvariant(), message });

    // ---- Events ----

    public IDisposable Subscribe(string resource, string name, bool network, Func<EventInvocation, Task> callback)
    {
        var key = (name, network);
        if (!subscriptions.TryGetValue(key, out var list))
        {
            list = [];
            subscriptions[key] = list;
            Rpc.Notify("event/subscribe", new { name, network });
        }
        var subscription = new Subscription(resource, callback);
        list.Add(subscription);

        return new Disposable(() =>
        {
            list.Remove(subscription);
            if (list.Count == 0 && subscriptions.Remove(key))
            {
                Rpc.Notify("event/unsubscribe", new { name, network });
            }
        });
    }

    public void Emit(string resource, string name, EventTarget target, IReadOnlyList<object?> args) =>
        Rpc.Notify("event/emit", new { resource, name, target = target.Wire, args });

    /// <summary>Delivers an event from the core to every matching handler, on the script thread.</summary>
    public void Dispatch(EventInvocation invocation, bool network)
    {
        scripts.Post(() =>
        {
            if (!subscriptions.TryGetValue((invocation.Name, network), out var list)) return;
            // Every handler starts in order; their awaits interleave instead of queuing behind each other.
            foreach (Subscription subscription in list.ToArray())
            {
                _ = RunHandlerAsync(subscription, invocation);
            }
        });
    }

    private async Task RunHandlerAsync(Subscription subscription, EventInvocation invocation)
    {
        CurrentResource.Value = subscription.Resource;
        try
        {
            await subscription.Callback(invocation);
        }
        catch (Exception ex)
        {
            string what = ex is ArgumentException ? ex.Message : ex.ToString();
            Log(subscription.Resource, LogLevel.Error, $"Handler for event '{invocation.Name}' failed: {what}");
        }
    }

    // ---- Commands ----

    public IDisposable RegisterCommand(string resource, CommandRegistration registration)
    {
        if (commands.TryGetValue(registration.Name, out var existing))
        {
            throw new InvalidOperationException($"/{registration.Name} is already registered by {existing.Resource}.");
        }
        commands[registration.Name] = (resource, registration);
        Rpc.Notify("command/register", new { resource, name = registration.Name, permission = registration.Permission, help = registration.Help });
        return new Disposable(() =>
        {
            if (commands.Remove(registration.Name))
            {
                Rpc.Notify("command/unregister", new { resource, name = registration.Name });
            }
        });
    }

    /// <summary>Runs a command the core already permission-checked. Returns an error message for the invoker, or null.</summary>
    public async Task<string?> InvokeCommandAsync(CommandInvocation invocation)
    {
        if (!commands.TryGetValue(invocation.Name, out var command))
        {
            return $"/{invocation.Name} isn't available.";
        }
        CurrentResource.Value = command.Resource;
        return await command.Registration.Handler(invocation);
    }

    // ---- Exports ----

    public IDisposable RegisterExport(string resource, string name, Func<EventInvocation, Task<object?>> handler)
    {
        var key = (resource, name);
        if (!exports.TryAdd(key, handler))
        {
            throw new InvalidOperationException($"{resource} already exports {name}.");
        }
        Rpc.Notify("export/register", new { resource, name });
        return new Disposable(() =>
        {
            if (exports.Remove(key))
            {
                Rpc.Notify("export/unregister", new { resource, name });
            }
        });
    }

    public async Task<object?> InvokeExportAsync(string resource, string name, IReadOnlyList<JsonElement> args)
    {
        if (!exports.TryGetValue((resource, name), out var handler))
        {
            throw new RpcException(RpcConnection.MethodNotFound, $"{resource} has no export called {name}.");
        }
        CurrentResource.Value = resource;
        return await handler(new EventInvocation(name, args, EventOrigin.Local));
    }

    public Task<JsonElement> CallExportAsync(string callerResource, string resource, string name, IReadOnlyList<object?> args) =>
        Rpc.RequestAsync("export/call", new { caller = callerResource, resource, name, args });

    // ---- Natives ----

    public Task<JsonElement> CallNativeAsync(string resource, string name, IReadOnlyList<object?> args) =>
        Rpc.RequestAsync("native/call", new { resource, name, args });

    private sealed class HostLog(HostRuntime runtime, string resource) : ILog
    {
        public void Write(LogLevel level, string message) => runtime.Log(resource, level, message);
    }
}
