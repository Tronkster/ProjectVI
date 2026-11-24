using System.Text.Json;

namespace ProjectVI.Runtime;

/// <summary>Where an event came from.</summary>
internal enum EventOrigin
{
    /// <summary>Emitted on this side, by a resource or the core.</summary>
    Local,
    /// <summary>Sent over the network by the other side.</summary>
    Network
}

/// <summary>One delivery of an event (or export call) to a handler. Args stay raw JSON so each handler converts them to its own parameter types.</summary>
internal sealed record EventInvocation(string Name, IReadOnlyList<JsonElement> Args, EventOrigin Origin, int? SourcePlayerId = null);

/// <summary>One run of a command. <see cref="SourcePlayerId"/> is null when it came from the server console.</summary>
internal sealed record CommandInvocation(string Name, int? SourcePlayerId, IReadOnlyList<string> Args);

/// <summary>A command a resource offers. The handler returns a reply for whoever ran it (usage, an error, or the command's own answer), or null.</summary>
internal sealed record CommandRegistration(string Name, string Permission, string Help, Func<CommandInvocation, Task<string?>> Handler);

/// <summary>Who receives an emitted event.</summary>
internal abstract record EventTarget
{
    private EventTarget() { }

    /// <summary>Every resource on this side.</summary>
    public sealed record Local : EventTarget;
    /// <summary>The server (client side only).</summary>
    public sealed record Server : EventTarget;
    /// <summary>One player's client (server side only).</summary>
    public sealed record Client(int PlayerId) : EventTarget;
    /// <summary>Every connected client (server side only).</summary>
    public sealed record AllClients : EventTarget;

    public string Wire => this switch
    {
        Local => "local",
        Server => "server",
        Client c => $"client:{c.PlayerId}",
        AllClients => "clients",
        _ => throw new InvalidOperationException()
    };
}

/// <summary>
/// The engine behind the SDK. ProjectVI.ScriptHost implements it by talking to the server core or
/// game client; ProjectVI.Testing implements it in memory. Script authors never see this.
/// All members are called on the script thread.
/// </summary>
internal interface IScriptRuntime
{
    /// <summary><c>server</c> or <c>client</c>.</summary>
    string Side { get; }

    /// <summary>JSON settings for arguments, including side-specific converters (players, entities).</summary>
    JsonSerializerOptions Json { get; }

    /// <summary>Interval used by <c>[Tick]</c> without an explicit interval.</summary>
    TimeSpan TickInterval { get; }

    /// <summary>Clock for timers. The real one in the host; a controllable one in ProjectVI.Testing.</summary>
    TimeProvider Time { get; }

    /// <summary>Side-specific services, such as the server's player registry.</summary>
    object? GetService(Type type);

    ILog CreateLog(string resource);

    /// <summary>Starts delivering events with this name to the callback. <paramref name="network"/> selects net events.</summary>
    IDisposable Subscribe(string resource, string name, bool network, Func<EventInvocation, Task> callback);

    void Emit(string resource, string name, EventTarget target, IReadOnlyList<object?> args);

    IDisposable RegisterCommand(string resource, CommandRegistration registration);

    IDisposable RegisterExport(string resource, string name, Func<EventInvocation, Task<object?>> handler);

    /// <summary>Calls another resource's export, in any language. Returns its result as JSON.</summary>
    Task<JsonElement> CallExportAsync(string callerResource, string resource, string name, IReadOnlyList<object?> args);

    /// <summary>Calls a function the server core or game client provides, such as <c>player.notify</c>.</summary>
    Task<JsonElement> CallNativeAsync(string resource, string name, IReadOnlyList<object?> args);
}

internal static class ScriptRuntimeExtensions
{
    public static T Service<T>(this IScriptRuntime runtime) where T : class =>
        runtime.GetService(typeof(T)) as T ?? throw new InvalidOperationException($"{typeof(T).Name} isn't available on the {runtime.Side} side.");
}
