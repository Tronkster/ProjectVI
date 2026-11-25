namespace ProjectVI;

/// <summary>Events on this side (server or client), shared by all resources and runtimes.</summary>
public interface IEvents
{
    /// <summary>
    /// Runs <paramref name="handler"/> whenever <paramref name="name"/> is emitted on this side.
    /// Parameters are filled from the event's arguments, like <see cref="EventAttribute"/> methods.
    /// Dispose the result to stop listening; everything is removed automatically when the resource stops.
    /// </summary>
    IDisposable On(string name, Delegate handler);

    /// <summary>Emits an event to every resource on this side, including this one.</summary>
    void Emit(string name, params object?[] args);
}

/// <summary>Built-in event names on the server.</summary>
public static class ServerEvents
{
    /// <summary>A player finished joining. Arguments: <c>Player player</c>.</summary>
    public const string PlayerJoined = "playerJoined";

    /// <summary>A player left. Arguments: <c>Player player, string reason</c>.</summary>
    public const string PlayerLeft = "playerLeft";

    /// <summary>
    /// A player said something in chat (not a /command; those run the command). Arguments: <c>Player player, string message</c>.
    /// </summary>
    public const string PlayerChat = "playerChat";

    /// <summary>A resource started. Arguments: <c>string resource</c>.</summary>
    public const string ResourceStarted = "resourceStarted";

    /// <summary>A resource is stopping. Arguments: <c>string resource</c>.</summary>
    public const string ResourceStopping = "resourceStopping";
}

/// <summary>Built-in event names on the client.</summary>
public static class ClientEvents
{
    /// <summary>The local player spawned in the world.</summary>
    public const string Spawned = "spawned";

    /// <summary>The connection to the server dropped. Arguments: <c>string reason</c>.</summary>
    public const string Disconnected = "disconnected";
}
