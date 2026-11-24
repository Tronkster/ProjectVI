using System.Text.Json;

namespace ProjectVI.Runtime;

internal sealed class TimersImpl(ScriptContext context) : ITimers
{
    public IDisposable Every(TimeSpan interval, Func<Task> callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        TimeSpan wait = interval > TimeSpan.Zero ? interval : context.Runtime.TickInterval;
        var cts = CancellationTokenSource.CreateLinkedTokenSource(context.Stopping);
        _ = LoopAsync();
        return context.Track(new Disposable(cts.Cancel));

        async Task LoopAsync()
        {
            while (!cts.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(wait, context.Runtime.Time, cts.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                await RunAsync(callback, "A repeating timer");
            }
        }
    }

    public IDisposable Every(TimeSpan interval, Action callback) => Every(interval, () =>
    {
        callback();
        return Task.CompletedTask;
    });

    public IDisposable After(TimeSpan delay, Func<Task> callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        var cts = CancellationTokenSource.CreateLinkedTokenSource(context.Stopping);
        _ = OnceAsync();
        return context.Track(new Disposable(cts.Cancel));

        async Task OnceAsync()
        {
            try
            {
                await Task.Delay(delay, context.Runtime.Time, cts.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            await RunAsync(callback, "A delayed timer");
        }
    }

    public IDisposable After(TimeSpan delay, Action callback) => After(delay, () =>
    {
        callback();
        return Task.CompletedTask;
    });

    public Task Delay(TimeSpan delay) => Task.Delay(delay, context.Runtime.Time, context.Stopping);

    private async Task RunAsync(Func<Task> callback, string what)
    {
        try
        {
            await callback();
        }
        catch (OperationCanceledException) when (context.Stopping.IsCancellationRequested)
        {
            // the resource is stopping
        }
        catch (Exception ex)
        {
            context.Log.Error(ex, $"{what} failed");
        }
    }
}

internal sealed class ExportsImpl(ScriptContext context) : IExports
{
    public IDisposable Register(string name, Delegate handler)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(handler);
        var bound = HandlerBinder.Bind(handler, context.Runtime.Json, context.Binding);
        return context.Track(context.Runtime.RegisterExport(context.Resource.Name, name, bound));
    }

    public async Task<T?> CallAsync<T>(string resource, string name, params object?[] args)
    {
        JsonElement result = await context.Runtime.CallExportAsync(context.Resource.Name, resource, name, args);
        return result.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? default : result.Deserialize<T>(context.Runtime.Json);
    }

    public Task CallAsync(string resource, string name, params object?[] args) =>
        context.Runtime.CallExportAsync(context.Resource.Name, resource, name, args);
}

/// <summary>
/// config.toml uses snake_case keys (pay_interval_seconds), so options classes bind with the snake_case
/// naming policy. Dictionary keys (job names and the like) are data and stay exactly as written.
/// Get/Has accept either spelling.
/// </summary>
internal sealed class ConfigImpl(JsonElement root, JsonSerializerOptions runtimeJson) : IConfig
{
    private readonly JsonSerializerOptions json = new(runtimeJson) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static JsonSerializerOptions SnakeCase(JsonSerializerOptions baseOptions) =>
        new(baseOptions) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public bool Has(string key) => Find(key) is not null;

    public T Get<T>(string key, T fallback)
    {
        if (Find(key) is not { } element) return fallback;
        try
        {
            return element.Deserialize<T>(json) ?? fallback;
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException or InvalidOperationException)
        {
            return fallback;
        }
    }

    public T Bind<T>(string? key = null) where T : new()
    {
        JsonElement? element = key is null ? (root.ValueKind == JsonValueKind.Object ? root : null) : Find(key);
        return element is { } e ? e.Deserialize<T>(json) ?? new T() : new T();
    }

    public JsonElement? Find(string key)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;
        JsonElement current = root;
        foreach (string part in key.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object) return null;
            JsonElement? next = null;
            foreach (JsonProperty property in current.EnumerateObject())
            {
                if (string.Equals(Normalize(property.Name), Normalize(part), StringComparison.Ordinal))
                {
                    next = property.Value;
                    break;
                }
            }
            if (next is null) return null;
            current = next.Value;
        }
        return current;
    }

    // pay_interval_seconds, payIntervalSeconds and PayIntervalSeconds all mean the same key.
    private static string Normalize(string key) => key.Replace("_", "", StringComparison.Ordinal).ToLowerInvariant();
}

internal sealed class CommandsImpl(ScriptContext context) : ICommands
{
    public IDisposable Register(string name, Delegate handler, string permission = "", string help = "")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(handler);
        string command = name.TrimStart('/').ToLowerInvariant();
        var bound = CommandBinder.Bind(command, handler, context.Binding, context.Log);
        return context.Track(context.Runtime.RegisterCommand(context.Resource.Name, new CommandRegistration(command, permission, help, bound)));
    }
}
