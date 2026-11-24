using System.Text.Json;

namespace ProjectVI;

/// <summary>Repeating and delayed work. Everything runs on the script thread and stops with the resource.</summary>
public interface ITimers
{
    /// <summary>
    /// Runs <paramref name="callback"/> every <paramref name="interval"/>, waiting for each run to finish
    /// before the next wait starts. <see cref="TimeSpan.Zero"/> means every tick.
    /// </summary>
    IDisposable Every(TimeSpan interval, Func<Task> callback);

    /// <inheritdoc cref="Every(TimeSpan, Func{Task})"/>
    IDisposable Every(TimeSpan interval, Action callback);

    /// <summary>Runs <paramref name="callback"/> once after <paramref name="delay"/>.</summary>
    IDisposable After(TimeSpan delay, Func<Task> callback);

    /// <inheritdoc cref="After(TimeSpan, Func{Task})"/>
    IDisposable After(TimeSpan delay, Action callback);

    /// <summary>Waits without blocking anything. Cancelled when the resource stops.</summary>
    Task Delay(TimeSpan delay);
}

/// <summary>Calls between resources, in any scripting language.</summary>
public interface IExports
{
    /// <summary>Offers a function to other resources. Methods marked <see cref="ExportAttribute"/> are offered automatically.</summary>
    IDisposable Register(string name, Delegate handler);

    /// <summary>Calls another resource's export and converts its result to <typeparamref name="T"/>.</summary>
    Task<T?> CallAsync<T>(string resource, string name, params object?[] args);

    /// <summary>Calls another resource's export and ignores its result.</summary>
    Task CallAsync(string resource, string name, params object?[] args);
}

/// <summary>
/// The resource's <c>config.toml</c>, so server owners can change settings without touching code.
/// Keys are case-insensitive; nested tables use dots, for example <c>"pay.mechanic"</c>.
/// </summary>
public interface IConfig
{
    /// <summary>True if the key exists.</summary>
    bool Has(string key);

    /// <summary>The value at <paramref name="key"/>, or <paramref name="fallback"/> if it's missing or the wrong type.</summary>
    T Get<T>(string key, T fallback);

    /// <summary>The whole config (or one table) as an options class.</summary>
    T Bind<T>(string? key = null) where T : new();
}

/// <summary>Chat and console commands.</summary>
public interface ICommands
{
    /// <summary>
    /// Registers <c>/name</c>. Parameters are filled from what the player typed; on the server, a first
    /// <c>Player</c> parameter receives whoever ran it. Methods marked <see cref="CommandAttribute"/> are registered automatically.
    /// </summary>
    IDisposable Register(string name, Delegate handler, string permission = "", string help = "");
}

/// <summary>Raw JSON access for advanced cases.</summary>
public static class ConfigExtensions
{
    /// <summary>The value at <paramref name="key"/> as raw JSON, or null.</summary>
    public static JsonElement? GetRaw(this IConfig config, string key) =>
        config is Runtime.ConfigImpl impl ? impl.Find(key) : null;
}
