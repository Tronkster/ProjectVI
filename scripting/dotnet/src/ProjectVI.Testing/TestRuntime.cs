using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ProjectVI.Runtime;
using ProjectVI.Server;

namespace ProjectVI.Testing;

/// <summary>
/// In-memory stand-in for the server core: event bus, commands, exports and simulated natives.
/// Runs scripts through the same SDK code as the real host. Touched only on the script thread.
/// </summary>
internal sealed class TestRuntime : IScriptRuntime
{
    private sealed record Subscription(string Resource, Func<EventInvocation, Task> Callback);

    private readonly Dictionary<(string Name, bool Network), List<Subscription>> subscriptions = [];
    private readonly List<Task> pending = [];
    private int nextEntityId = 1;

    public TestRuntime(ServerInfo info)
    {
        Json = ScriptJson.CreateOptions(ServerServices.Converters(() => Services?.Players));
        Services = new ServerServices(this, info);
    }

    public ServerServices Services { get; }
    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));

    public Dictionary<string, (string Resource, CommandRegistration Registration)> Commands { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<(string Resource, string Name), Func<EventInvocation, Task<object?>>> Exports { get; } = [];
    public List<SentEvent> Sent { get; } = [];
    public List<LogEntry> Logs { get; } = [];
    public Dictionary<int, List<string>> Notifications { get; } = [];
    public Dictionary<int, Vector3> Positions { get; } = [];
    public Dictionary<string, Dictionary<string, JsonElement>> Store { get; } = [];
    public List<Entity> Entities { get; } = [];

    /// <summary>The simulated clock and weather. The clock doesn't run on its own here.</summary>
    public GameTime WorldTime { get; set; } = new(12, 0, 0);
    public float WorldTimeScale { get; set; } = 30;
    public string Weather { get; set; } = "clear";
    public Action<int, string>? OnKick { get; set; }

    public string Side => "server";
    public JsonSerializerOptions Json { get; }
    public TimeSpan TickInterval => TimeSpan.FromMilliseconds(50);
    public TimeProvider Time => Clock;

    public object? GetService(Type type) => type == typeof(ServerServices) ? Services : null;

    public ILog CreateLog(string resource) => new TestLog(Logs, resource);

    public Task[] TakePending()
    {
        Task[] tasks = [.. pending];
        pending.Clear();
        return tasks;
    }

    public JsonElement[] ToJson(IEnumerable<object?> args) => args.Select(a => JsonSerializer.SerializeToElement(a, Json)).ToArray();

    // ---- Events ----

    public IDisposable Subscribe(string resource, string name, bool network, Func<EventInvocation, Task> callback)
    {
        var key = (name, network);
        if (!subscriptions.TryGetValue(key, out var list))
        {
            list = [];
            subscriptions[key] = list;
        }
        var subscription = new Subscription(resource, callback);
        list.Add(subscription);
        return new Disposable(() => list.Remove(subscription));
    }

    public bool HasSubscribers(string name, bool network) =>
        subscriptions.TryGetValue((name, network), out var list) && list.Count > 0;

    public void Emit(string resource, string name, EventTarget target, IReadOnlyList<object?> args)
    {
        JsonElement[] json = ToJson(args);
        switch (target)
        {
            case EventTarget.Local:
                Dispatch(name, json, network: false, source: null);
                break;
            case EventTarget.Client client:
                Sent.Add(new SentEvent(client.PlayerId, name, json));
                break;
            case EventTarget.AllClients:
                Sent.Add(new SentEvent(null, name, json));
                break;
        }
    }

    public void Dispatch(string name, IReadOnlyList<JsonElement> args, bool network, int? source)
    {
        if (!subscriptions.TryGetValue((name, network), out var list)) return;
        var invocation = new EventInvocation(name, args, network ? EventOrigin.Network : EventOrigin.Local, source);
        foreach (Subscription subscription in list.ToArray())
        {
            pending.Add(RunAsync(subscription, invocation));
        }
    }

    private async Task RunAsync(Subscription subscription, EventInvocation invocation)
    {
        try
        {
            await subscription.Callback(invocation);
        }
        catch (Exception ex)
        {
            Logs.Add(new LogEntry(subscription.Resource, LogLevel.Error, $"Handler for event '{invocation.Name}' failed: {(ex is ArgumentException ? ex.Message : ex.ToString())}"));
        }
    }

    // ---- Commands and exports ----

    public IDisposable RegisterCommand(string resource, CommandRegistration registration)
    {
        if (!Commands.TryAdd(registration.Name, (resource, registration)))
        {
            throw new InvalidOperationException($"/{registration.Name} is already registered by {Commands[registration.Name].Resource}.");
        }
        return new Disposable(() => Commands.Remove(registration.Name));
    }

    public IDisposable RegisterExport(string resource, string name, Func<EventInvocation, Task<object?>> handler)
    {
        if (!Exports.TryAdd((resource, name), handler))
        {
            throw new InvalidOperationException($"{resource} already exports {name}.");
        }
        return new Disposable(() => Exports.Remove((resource, name)));
    }

    public async Task<JsonElement> CallExportAsync(string callerResource, string resource, string name, IReadOnlyList<object?> args)
    {
        if (!Exports.TryGetValue((resource, name), out var handler))
        {
            throw new InvalidOperationException($"{resource} has no export called {name}.");
        }
        object? result = await handler(new EventInvocation(name, ToJson(args), EventOrigin.Local));
        return JsonSerializer.SerializeToElement(result, Json);
    }

    // ---- Simulated natives ----

    public Task<JsonElement> CallNativeAsync(string resource, string name, IReadOnlyList<object?> args)
    {
        JsonElement[] a = ToJson(args);
        object? result = name switch
        {
            "player.notify" => Notify(a[0].GetInt32(), a[1].GetString() ?? ""),
            "player.kick" => Kick(a[0].GetInt32(), a[1].GetString() ?? ""),
            "player.position" => Positions.GetValueOrDefault(a[0].GetInt32()),
            "store.get" => StoreOf(resource).TryGetValue(a[0].GetString()!, out JsonElement v) ? v : null,
            "store.set" => StoreSet(resource, a[0].GetString()!, a[1]),
            "store.delete" => StoreOf(resource).Remove(a[0].GetString()!),
            "store.keys" => StoreOf(resource).Keys.Where(k => k.StartsWith(a[0].GetString() ?? "", StringComparison.Ordinal)).Order().ToArray(),
            "entities.spawnVehicle" => Spawn(a[0].GetString()!, a[1].Deserialize<Vector3>(Json), a[2].GetSingle()),
            "entities.list" => Entities.ToArray(),
            "entities.delete" => Entities.RemoveAll(e => e.Id == a[0].GetInt32()),
            "world.time" => WorldTime,
            "world.setTime" => SetWorldTime(a[0].GetInt32(), a[1].GetInt32(), a[2].GetInt32()),
            "world.timeScale" => WorldTimeScale,
            "world.setTimeScale" => SetWorldTimeScale(a[0].GetSingle()),
            "world.weather" => Weather,
            "world.setWeather" => SetWeather(a[0].GetString() ?? "", a[1].GetSingle()),
            _ => throw new NotSupportedException($"ProjectVI.Testing doesn't simulate the native '{name}'.")
        };
        return Task.FromResult(JsonSerializer.SerializeToElement(result, Json));
    }

    public Dictionary<string, JsonElement> StoreOf(string resource)
    {
        if (!Store.TryGetValue(resource, out var values))
        {
            values = [];
            Store[resource] = values;
        }
        return values;
    }

    private bool StoreSet(string resource, string key, JsonElement value)
    {
        StoreOf(resource)[key] = value.Clone();
        return true;
    }

    private bool Notify(int playerId, string message)
    {
        if (!Notifications.TryGetValue(playerId, out var list))
        {
            list = [];
            Notifications[playerId] = list;
        }
        list.Add(message);
        return true;
    }

    private bool Kick(int playerId, string reason)
    {
        OnKick?.Invoke(playerId, reason);
        return true;
    }

    // Same checks and messages as the server core (server/src/core/world.js).
    private bool SetWorldTime(int hour, int minute, int second)
    {
        if (hour is < 0 or > 23 || minute is < 0 or > 59 || second is < 0 or > 59)
        {
            throw new InvalidOperationException("The time must be an hour from 0 to 23, and minutes and seconds from 0 to 59.");
        }
        WorldTime = new GameTime(hour, minute, second);
        return true;
    }

    private bool SetWorldTimeScale(float scale)
    {
        if (!float.IsFinite(scale) || scale is < 0 or > 1000) throw new InvalidOperationException("The time scale must be a number from 0 to 1000.");
        WorldTimeScale = scale;
        return true;
    }

    private bool SetWeather(string name, float transitionSeconds)
    {
        string weather = name.Trim().ToLowerInvariant();
        if (weather.Length is 0 or > 32 || !weather.All(c => char.IsAsciiLetterOrDigit(c) || c == '_'))
        {
            throw new InvalidOperationException("Weather names are 1-32 letters, digits and underscores, for example \"rain\".");
        }
        if (!float.IsFinite(transitionSeconds) || transitionSeconds is < 0 or > 600) throw new InvalidOperationException("The transition must be 0 to 600 seconds.");
        string previous = Weather;
        Weather = weather;
        if (weather != previous) Dispatch(ServerEvents.WeatherChanged, ToJson([weather, previous]), network: false, source: null);
        return true;
    }

    private Entity Spawn(string model, Vector3 position, float heading)
    {
        var entity = new Entity(nextEntityId++, "vehicle", model, position, heading);
        Entities.Add(entity);
        return entity;
    }

    private sealed class TestLog(List<LogEntry> logs, string resource) : ILog
    {
        public void Write(LogLevel level, string message) => logs.Add(new LogEntry(resource, level, message));
    }
}
