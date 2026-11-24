using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// Base class for server scripts. Every non-abstract class deriving from it in a resource's
/// server assemblies is created when the resource starts.
/// </summary>
/// <example>
/// <code>
/// public sealed class Welcome : ServerScript
/// {
///     [Event(ServerEvents.PlayerJoined)]
///     void OnJoin(Player player) => player.Notify($"Welcome to {Server.Name}!");
/// }
/// </code>
/// </example>
public abstract class ServerScript : Script
{
    private ServerEventsImpl? events;
    private StoreImpl? store;
    private EntitiesImpl? entities;

    private ServerServices Services => Context.Runtime.Service<ServerServices>();

    /// <summary>Local events, and network events to and from clients.</summary>
    public IServerEvents Events => events ??= new ServerEventsImpl(Context);

    /// <summary>The players on the server.</summary>
    public IPlayers Players => Services.Players;

    /// <summary>Facts about this server.</summary>
    public ServerInfo Server => Services.Info;

    /// <summary>Saved data for this resource.</summary>
    public IStore Store => store ??= new StoreImpl(Context);

    /// <summary>Vehicles and other things in the world.</summary>
    public IEntities Entities => entities ??= new EntitiesImpl(Context);
}

/// <summary>Server-side events.</summary>
public interface IServerEvents : IEvents
{
    /// <summary>
    /// Runs <paramref name="handler"/> when a client sends this event. If the handler's first parameter
    /// is a <c>Player</c>, it receives the sender. Same rules as <see cref="NetEventAttribute"/>.
    /// </summary>
    IDisposable OnNet(string name, Delegate handler);

    /// <summary>Sends an event to one player's client.</summary>
    void EmitToClient(Player player, string name, params object?[] args);

    /// <summary>Sends an event to every connected client.</summary>
    void EmitToClients(string name, params object?[] args);
}

internal sealed class ServerEventsImpl(ScriptContext context) : EventsBase(context), IServerEvents
{
    public IDisposable OnNet(string name, Delegate handler) => Subscribe(name, network: true, handler);

    public void EmitToClient(Player player, string name, params object?[] args)
    {
        ArgumentNullException.ThrowIfNull(player);
        EmitTo(name, new EventTarget.Client(player.Id), args);
    }

    public void EmitToClients(string name, params object?[] args) => EmitTo(name, new EventTarget.AllClients(), args);
}
