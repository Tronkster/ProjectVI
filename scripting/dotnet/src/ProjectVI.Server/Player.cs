using System.Text.Json;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// A connected player. The same object is reused for as long as the player is connected, so it's
/// safe to keep in dictionaries. After they leave, <see cref="IsConnected"/> turns false.
/// </summary>
public sealed class Player
{
    private readonly PlayerRegistry registry;

    internal Player(PlayerRegistry registry, int id)
    {
        this.registry = registry;
        Id = id;
    }

    /// <summary>Server-assigned number, unique while the server runs. Not stable across reconnects; use <see cref="Identifiers"/> for saving data.</summary>
    public int Id { get; }

    /// <summary>Display name the player chose.</summary>
    public string Name { get; internal set; } = "";

    /// <summary>
    /// Verified identities, for example <c>discord:123456789</c>. Guests have one <c>guest:</c> identifier
    /// that changes every time they connect. Use these (not the name) as keys for saved data.
    /// </summary>
    public IReadOnlyList<string> Identifiers { get; internal set; } = [];

    /// <summary>Permission groups from <c>server.toml</c> that include one of this player's identifiers.</summary>
    public IReadOnlyCollection<string> Groups { get; internal set; } = [];

    /// <summary>False once the player has left.</summary>
    public bool IsConnected { get; internal set; } = true;

    /// <summary>The most trustworthy identifier: Discord if present, otherwise the first one.</summary>
    public string PrimaryIdentifier =>
        Identifiers.FirstOrDefault(i => i.StartsWith("discord:", StringComparison.Ordinal)) ?? Identifiers.FirstOrDefault() ?? $"player:{Id}";

    /// <summary>True if the player is in the permission group, or the group is empty.</summary>
    public bool HasPermission(string group) =>
        string.IsNullOrEmpty(group) || Groups.Contains(group, StringComparer.OrdinalIgnoreCase);

    /// <summary>Shows a short message on the player's screen.</summary>
    public void Notify(string message) => registry.FireNative("player.notify", Id, message);

    /// <summary>Disconnects the player with a reason they can read.</summary>
    public void Kick(string reason) => registry.FireNative("player.kick", Id, reason);

    /// <summary>Where the player is: the last position their client reported.</summary>
    public async Task<Vector3> GetPositionAsync() =>
        (await Call("player.position")).Deserialize<Vector3>(registry.Runtime.Json);

    /// <summary>
    /// Everything the player's client last reported: position, speed, heading, health, weapon, vehicle and seat.
    /// Null until their client has sent anything (and for players added from the console).
    /// </summary>
    public async Task<PlayerState?> GetStateAsync()
    {
        JsonElement result = await Call("player.state");
        return result.ValueKind == JsonValueKind.Null ? null : result.Deserialize<PlayerState>(registry.Runtime.Json);
    }

    /// <summary>The round trip to the player's game in milliseconds, or null before it's been measured.</summary>
    public async Task<int?> GetPingAsync()
    {
        JsonElement result = await Call("player.ping");
        return result.ValueKind == JsonValueKind.Number ? (int)Math.Round(result.GetDouble()) : null;
    }

    /// <summary>True if this player is the host: the player whose game runs the story for everyone.</summary>
    public async Task<bool> IsHostAsync() => (await Call("player.isHost")).GetBoolean();

    /// <summary>The story character (model hash) the server gave this player, or 0 if they keep their own look.</summary>
    public async Task<uint> GetCharacterAsync() => (await Call("player.character")).GetUInt32();

    private Task<JsonElement> Call(string native) => registry.Runtime.CallNativeAsync(registry.ResourceForNatives, native, [Id]);

    /// <inheritdoc />
    public override string ToString() => $"{Name} (#{Id})";
}

/// <summary>The players currently on the server.</summary>
public interface IPlayers
{
    /// <summary>Everyone connected right now.</summary>
    IReadOnlyCollection<Player> All { get; }

    /// <summary>How many players are connected.</summary>
    int Count { get; }

    /// <summary>The player with this id, or null.</summary>
    Player? Get(int id);

    /// <summary>The player whose name matches exactly (case-insensitive), or the only one whose name starts with <paramref name="name"/>.</summary>
    Player? Find(string name);

    /// <summary>The connected player with this identifier, for example <c>discord:123</c>.</summary>
    Player? FindByIdentifier(string identifier);
}

/// <summary>
/// Host-wide registry of players, shared by every resource. Updated from the core in order with events,
/// so a playerJoined handler always finds the player here.
/// </summary>
internal sealed class PlayerRegistry(IScriptRuntime runtime) : IPlayers
{
    private readonly Dictionary<int, Player> players = [];

    public IScriptRuntime Runtime { get; } = runtime;

    /// <summary>Natives called from Player methods are attributed to whichever resource's code is running.</summary>
    public Func<string> CurrentResource { get; set; } = () => "";

    public string ResourceForNatives => CurrentResource();

    public IReadOnlyCollection<Player> All => players.Values.Where(p => p.IsConnected).ToList();

    public int Count => players.Count;

    public Player? Get(int id) => players.GetValueOrDefault(id);

    public Player? Find(string name)
    {
        var all = players.Values;
        return all.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
            ?? (all.Where(p => p.Name.StartsWith(name, StringComparison.OrdinalIgnoreCase)).ToList() is [var only] ? only : null);
    }

    public Player? FindByIdentifier(string identifier) =>
        players.Values.FirstOrDefault(p => p.Identifiers.Contains(identifier, StringComparer.OrdinalIgnoreCase));

    /// <summary>Adds or updates a player from the core's snapshot: {"$player": id, name, identifiers, groups}.</summary>
    public Player Upsert(JsonElement snapshot)
    {
        int id = snapshot.GetProperty("$player").GetInt32();
        if (!players.TryGetValue(id, out Player? player))
        {
            player = new Player(this, id);
            players[id] = player;
        }
        if (snapshot.TryGetProperty("name", out JsonElement name)) player.Name = name.GetString() ?? "";
        if (snapshot.TryGetProperty("identifiers", out JsonElement ids)) player.Identifiers = ids.EnumerateArray().Select(i => i.GetString()!).ToArray();
        if (snapshot.TryGetProperty("groups", out JsonElement groups)) player.Groups = groups.EnumerateArray().Select(g => g.GetString()!).ToArray();
        player.IsConnected = true;
        return player;
    }

    public void Remove(int id)
    {
        if (players.Remove(id, out Player? player))
        {
            player.IsConnected = false;
        }
    }

    public void FireNative(string name, params object?[] args)
    {
        _ = Runtime.CallNativeAsync(ResourceForNatives, name, args).ContinueWith(
            t => Runtime.CreateLog(ResourceForNatives).Warn($"{name} failed: {t.Exception?.InnerException?.Message}"),
            TaskContinuationOptions.OnlyOnFaulted);
    }
}
