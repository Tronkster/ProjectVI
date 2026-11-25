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

    /// <summary>
    /// A player sat down in a vehicle. Arguments: <c>Player player, int vehicleId, int seat</c> (seat 0 is the driver's).
    /// Changing seats in the same vehicle is a <see cref="PlayerLeftVehicle"/> followed by this.
    /// </summary>
    public const string PlayerEnteredVehicle = "playerEnteredVehicle";

    /// <summary>
    /// A player got out of a vehicle, or left the server while in one. Arguments: <c>Player player, int vehicleId, int seat</c>.
    /// A player kicked by a script while seated only gets <see cref="PlayerLeft"/>.
    /// </summary>
    public const string PlayerLeftVehicle = "playerLeftVehicle";

    /// <summary>
    /// A player's client reported something it shouldn't be able to, and the server refused it. Arguments:
    /// <c>Player player, string kind, JsonElement details</c>. <c>kind</c> is <c>"teleport"</c> (details: distance in
    /// metres, seconds) or <c>"seat"</c> (details: vehicle, seat, problem). At most one of each kind every 5 seconds per
    /// player. What to do about it is up to the server's scripts: log it, warn, or kick.
    /// </summary>
    public const string PlayerSuspicious = "playerSuspicious";

    /// <summary>The weather changed. Arguments: <c>string weather, string previous</c>.</summary>
    public const string WeatherChanged = "weatherChanged";

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
