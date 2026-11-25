using System.Reflection;
using System.Text.Json;
using ProjectVI.Runtime;
using ProjectVI.Server;

namespace ProjectVI.Testing;

/// <summary>An event a script sent to clients. <see cref="PlayerId"/> is null when it went to everyone.</summary>
public sealed record SentEvent(int? PlayerId, string Name, IReadOnlyList<JsonElement> Args)
{
    /// <summary>Argument <paramref name="index"/> converted to <typeparamref name="T"/>.</summary>
    public T Arg<T>(int index) => Args[index].Deserialize<T>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
}

/// <summary>A line a script logged.</summary>
public sealed record LogEntry(string Resource, LogLevel Level, string Message);

/// <summary>A chat line a script sent with <c>Chat</c>: to one player (<see cref="PlayerId"/>), or to everyone (null).</summary>
public sealed record ChatLine(int? PlayerId, string Text);

/// <summary>A fake player you control from the test.</summary>
public sealed class TestPlayer(Player player)
{
    /// <summary>The SDK object scripts see.</summary>
    public Player Player { get; } = player;

    /// <summary>Player id.</summary>
    public int Id => Player.Id;

    /// <summary>Player name.</summary>
    public string Name => Player.Name;

    /// <inheritdoc />
    public override string ToString() => Player.ToString();
}

/// <summary>
/// A server in memory for unit-testing resources: no Node, no game, no network.
/// Scripts run on a script thread exactly as in the real host. Every method waits until scripts
/// are idle again, so you can assert right after calling it. Time only moves when you call
/// <see cref="AdvanceTimeAsync"/>, so timers are testable without waiting.
/// </summary>
/// <example>
/// <code>
/// await using var server = new TestServer();
/// await server.StartAsync&lt;Jobs&gt;("jobs");
/// var kai = await server.AddPlayerAsync("Kai", groups: ["admin"]);
/// Assert.Null(await server.RunCommandAsync(kai, "job Kai mechanic"));
/// </code>
/// </example>
public sealed class TestServer : IAsyncDisposable
{
    private readonly ScriptThread scripts;
    private readonly TestRuntime runtime;
    private readonly Dictionary<string, LoadedScripts> resources = new(StringComparer.Ordinal);
    private int nextPlayerId = 1;

    /// <summary>Creates a server with the given name and slots.</summary>
    public TestServer(string name = "Test Server", int maxPlayers = 32, int port = 30120)
    {
        scripts = new ScriptThread(ex => runtime?.Logs.Add(new LogEntry("", LogLevel.Error, $"Unhandled error in a script: {ex}")));
        runtime = new TestRuntime(new ServerInfo(name, maxPlayers, port));
        runtime.OnKick = (id, reason) => _ = RemovePlayerCoreAsync(id, $"Kicked: {reason}");
    }

    /// <summary>The fake clock's current time.</summary>
    public DateTimeOffset Now => runtime.Clock.GetUtcNow();

    /// <summary>Everything scripts logged, oldest first.</summary>
    public IReadOnlyList<LogEntry> Logs => runtime.Logs;

    /// <summary>Errors scripts logged, including failed handlers. Handy for <c>Assert.Empty(server.Errors)</c>.</summary>
    public IReadOnlyList<LogEntry> Errors => runtime.Logs.Where(l => l.Level == LogLevel.Error).ToList();

    /// <summary>Events scripts sent to clients, oldest first.</summary>
    public IReadOnlyList<SentEvent> SentToClients => runtime.Sent;

    /// <summary>The simulated in-game time; scripts change it through <c>World</c>.</summary>
    public GameTime WorldTime { get => runtime.WorldTime; set => runtime.WorldTime = value; }

    /// <summary>The simulated weather.</summary>
    public string Weather { get => runtime.Weather; set => runtime.Weather = value; }

    /// <summary>Entities scripts spawned.</summary>
    public IReadOnlyList<Entity> Entities => runtime.Entities;

    /// <summary>Messages shown to a player with <c>Player.Notify</c>.</summary>
    public IReadOnlyList<string> NotificationsFor(TestPlayer player) =>
        runtime.Notifications.TryGetValue(player.Id, out var list) ? list : [];

    /// <summary>A value a resource saved with its Store, or default.</summary>
    public T? StoreValue<T>(string resource, string key) =>
        runtime.StoreOf(resource).TryGetValue(key, out JsonElement value) ? value.Deserialize<T>(runtime.Json) : default;

    /// <summary>Sets where a player is, for scripts that ask.</summary>
    public void SetPosition(TestPlayer player, Vector3 position) => runtime.Positions[player.Id] = position;

    /// <summary>Sets everything a player's client would report, for <c>Player.GetStateAsync</c>. Also sets their position.</summary>
    public void SetState(TestPlayer player, PlayerState state)
    {
        runtime.States[player.Id] = state;
        runtime.Positions[player.Id] = state.Position;
    }

    /// <summary>A state on foot at <paramref name="position"/>, full health, to start from with <c>with { ... }</c>.</summary>
    public static PlayerState OnFoot(Vector3 position) =>
        new(position, Vector3.Zero, 0, PlayerStateFlags.None, 0, 200, 0, 0, Vector3.Zero, 0, 0);

    /// <summary>Sets a player's measured round trip, for <c>Player.GetPingAsync</c>.</summary>
    public void SetPing(TestPlayer player, int milliseconds) => runtime.Pings[player.Id] = milliseconds;

    /// <summary>Makes a player the host (the one whose game runs the story), or nobody with null.</summary>
    public void SetHost(TestPlayer? player) => runtime.HostId = player?.Id ?? 0;

    /// <summary>Gives a player a story character (model hash), for <c>Player.GetCharacterAsync</c>.</summary>
    public void SetCharacter(TestPlayer player, uint model) => runtime.Characters[player.Id] = model;

    /// <summary>Sets what the server knows about a vehicle, for <c>Entities.GetVehicleAsync</c>.</summary>
    public void SetVehicle(VehicleState vehicle) => runtime.Vehicles[vehicle.Id] = vehicle;

    /// <summary>Chat lines scripts sent with <c>Chat</c>.</summary>
    public IReadOnlyList<ChatLine> ChatSent => runtime.Chat;

    /// <summary>
    /// Seats a player in a vehicle as the sync server would: updates their state and raises
    /// <see cref="ServerEvents.PlayerEnteredVehicle"/> (after <see cref="ServerEvents.PlayerLeftVehicle"/> if they were in another seat).
    /// </summary>
    public async Task EnterVehicleAsync(TestPlayer player, int vehicleId, int seat = 0)
    {
        await LeaveVehicleAsync(player);
        PlayerState state = runtime.States.GetValueOrDefault(player.Id) ?? OnFoot(runtime.Positions.GetValueOrDefault(player.Id));
        SetState(player, state with { Flags = state.Flags | PlayerStateFlags.InVehicle, VehicleId = vehicleId, Seat = seat });
        await EmitAsync(ServerEvents.PlayerEnteredVehicle, player.Player, vehicleId, seat);
    }

    /// <summary>Takes a player out of their vehicle and raises <see cref="ServerEvents.PlayerLeftVehicle"/>. Does nothing if they're on foot.</summary>
    public async Task LeaveVehicleAsync(TestPlayer player)
    {
        if (runtime.States.GetValueOrDefault(player.Id) is not { IsInVehicle: true } state) return;
        SetState(player, state with { Flags = state.Flags & ~PlayerStateFlags.InVehicle, VehicleId = 0, Seat = 0 });
        await EmitAsync(ServerEvents.PlayerLeftVehicle, player.Player, state.VehicleId, state.Seat);
    }

    /// <summary>Starts a resource made of one script class.</summary>
    public Task StartAsync<TScript>(string resource = "test", object? config = null) where TScript : Script =>
        StartAsync(resource, [typeof(TScript)], config);

    /// <summary>Starts every server script in an assembly as one resource.</summary>
    public Task StartAsync(string resource, Assembly assembly, object? config = null) =>
        StartAsync(resource, ScriptLoader.FindScriptTypes([assembly], typeof(ServerScript)), config);

    /// <summary>
    /// Starts a resource made of these script classes. <paramref name="config"/> stands in for
    /// <c>config.toml</c>: pass an anonymous object or a dictionary.
    /// </summary>
    public async Task StartAsync(string resource, IEnumerable<Type> scriptTypes, object? config = null)
    {
        // Serialized like config.toml would be: snake_case keys, dictionary keys untouched.
        JsonElement configJson = config is null ? default : JsonSerializer.SerializeToElement(config, ConfigImpl.SnakeCase(runtime.Json));
        await scripts.InvokeAsync(async () =>
        {
            var context = new ScriptContext(runtime, new ResourceInfo(resource, "server"), runtime.Services.Binding, configJson);
            resources[resource] = await ScriptLoader.StartAsync(context, scriptTypes.ToList());
            return true;
        });
        await WaitIdleAsync();
    }

    /// <summary>Stops a resource, running OnStop and removing its handlers.</summary>
    public async Task StopAsync(string resource)
    {
        await scripts.InvokeAsync(async () =>
        {
            if (resources.Remove(resource, out LoadedScripts? loaded)) await ScriptLoader.StopAsync(loaded);
            return true;
        });
        await WaitIdleAsync();
    }

    /// <summary>Connects a fake player and raises <c>playerJoined</c>. Without identifiers, they're a guest.</summary>
    public async Task<TestPlayer> AddPlayerAsync(string name, IEnumerable<string>? identifiers = null, IEnumerable<string>? groups = null)
    {
        int id = nextPlayerId++;
        var snapshot = JsonSerializer.SerializeToElement(new Dictionary<string, object>
        {
            ["$player"] = id,
            ["name"] = name,
            ["identifiers"] = identifiers?.ToArray() ?? [$"guest:test{id}"],
            ["groups"] = groups?.ToArray() ?? []
        });
        Player player = await scripts.InvokeAsync(() =>
        {
            Player p = runtime.Services.Players.Upsert(snapshot);
            runtime.Dispatch(ServerEvents.PlayerJoined, [snapshot], network: false, source: null);
            return Task.FromResult(p);
        });
        await WaitIdleAsync();
        return new TestPlayer(player);
    }

    /// <summary>Disconnects a fake player, raising <c>playerLeft</c> first.</summary>
    public async Task RemovePlayerAsync(TestPlayer player, string reason = "Left")
    {
        await RemovePlayerCoreAsync(player.Id, reason);
        await WaitIdleAsync();
    }

    private Task RemovePlayerCoreAsync(int id, string reason) => scripts.InvokeAsync(async () =>
    {
        JsonElement reference = JsonSerializer.SerializeToElement(new Dictionary<string, object> { ["$player"] = id });
        runtime.Dispatch(ServerEvents.PlayerLeft, [reference, JsonSerializer.SerializeToElement(reason)], network: false, source: null);
        await Task.WhenAll(runtime.TakePending());
        runtime.Services.Players.Remove(id);
        return true;
    });

    /// <summary>Emits a server event, as another resource or the core would.</summary>
    public async Task EmitAsync(string name, params object?[] args)
    {
        await scripts.InvokeAsync(() =>
        {
            runtime.Dispatch(name, runtime.ToJson(args), network: false, source: null);
            return Task.FromResult(true);
        });
        await WaitIdleAsync();
    }

    /// <summary>
    /// Sends a net event as if <paramref name="player"/>'s client sent it. Returns false if no
    /// <c>[NetEvent]</c> handler accepts it, which is what happens to clients in the real server.
    /// </summary>
    public async Task<bool> SendFromClientAsync(TestPlayer player, string name, params object?[] args)
    {
        bool accepted = await scripts.InvokeAsync(() =>
        {
            bool any = runtime.HasSubscribers(name, network: true);
            runtime.Dispatch(name, runtime.ToJson(args), network: true, source: player.Id);
            return Task.FromResult(any);
        });
        await WaitIdleAsync();
        return accepted;
    }

    /// <summary>
    /// Runs a command line such as <c>"job Kai mechanic"</c> as <paramref name="player"/>, or as the
    /// console when null. Returns null if it ran, otherwise the message the player would see.
    /// Permissions are checked like the real server does.
    /// </summary>
    public async Task<string?> RunCommandAsync(TestPlayer? player, string commandLine)
    {
        string[] parts = SplitCommandLine(commandLine.TrimStart('/'));
        if (parts.Length == 0) return "Type a command.";
        string? result = await scripts.InvokeAsync(async () =>
        {
            if (!runtime.Commands.TryGetValue(parts[0], out var command))
            {
                return $"Unknown command: /{parts[0]}";
            }
            if (player is not null && !player.Player.HasPermission(command.Registration.Permission))
            {
                return $"You don't have permission to use /{parts[0]}.";
            }
            return await command.Registration.Handler(new CommandInvocation(parts[0].ToLowerInvariant(), player?.Id, parts[1..]));
        });
        await WaitIdleAsync();
        return result;
    }

    /// <summary>Calls a resource's export, as another resource would.</summary>
    public async Task<T?> CallExportAsync<T>(string resource, string name, params object?[] args)
    {
        JsonElement result = await scripts.InvokeAsync(() => runtime.CallExportAsync("test", resource, name, args));
        await WaitIdleAsync();
        return result.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? default : result.Deserialize<T>(runtime.Json);
    }

    /// <summary>Moves the fake clock forward in <paramref name="step"/>s (default 1 second), running timers that come due.</summary>
    public async Task AdvanceTimeAsync(TimeSpan amount, TimeSpan? step = null)
    {
        TimeSpan increment = step ?? TimeSpan.FromSeconds(1);
        for (TimeSpan moved = TimeSpan.Zero; moved < amount; moved += increment)
        {
            runtime.Clock.Advance(increment < amount - moved ? increment : amount - moved);
            await WaitIdleAsync();
        }
    }

    /// <summary>Waits until no script work is queued or running.</summary>
    public async Task WaitIdleAsync()
    {
        for (int round = 0; round < 1000; round++)
        {
            Task[] pending = await scripts.InvokeAsync(() => Task.FromResult(runtime.TakePending()));
            if (pending.Length > 0)
            {
                try
                {
                    await Task.WhenAll(pending);
                }
                catch
                {
                    // already logged by the runtime
                }
                continue;
            }
            if (scripts.QueueLength == 0) return;
        }
        throw new TimeoutException("Scripts kept producing work; is something looping without a delay?");
    }

    /// <summary>Stops every resource.</summary>
    public async ValueTask DisposeAsync()
    {
        foreach (string resource in resources.Keys.ToList()) await StopAsync(resource);
        scripts.Dispose();
    }

    private static string[] SplitCommandLine(string line)
    {
        var parts = new List<string>();
        var current = new System.Text.StringBuilder();
        bool quoted = false;
        foreach (char c in line)
        {
            if (c == '"')
            {
                quoted = !quoted;
            }
            else if (char.IsWhiteSpace(c) && !quoted)
            {
                if (current.Length > 0)
                {
                    parts.Add(current.ToString());
                    current.Clear();
                }
            }
            else
            {
                current.Append(c);
            }
        }
        if (current.Length > 0) parts.Add(current.ToString());
        return [.. parts];
    }
}
