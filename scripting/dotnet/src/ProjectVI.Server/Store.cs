using System.Text.Json;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// Saved data for this resource, kept by the server between restarts. Keys are private to the resource.
/// Values can be anything that serializes to JSON. Use player identifiers in keys, not names or ids.
/// </summary>
public interface IStore
{
    /// <summary>The value for <paramref name="key"/>, or default if there isn't one.</summary>
    Task<T?> GetAsync<T>(string key);

    /// <summary>Saves a value, replacing any previous one.</summary>
    Task SetAsync<T>(string key, T value);

    /// <summary>Removes a key. Does nothing if it doesn't exist.</summary>
    Task DeleteAsync(string key);

    /// <summary>Every key that starts with <paramref name="prefix"/>.</summary>
    Task<IReadOnlyList<string>> KeysAsync(string prefix = "");
}

internal sealed class StoreImpl(ScriptContext context) : IStore
{
    private IScriptRuntime Runtime => context.Runtime;
    private string Resource => context.Resource.Name;

    public async Task<T?> GetAsync<T>(string key)
    {
        JsonElement value = await Runtime.CallNativeAsync(Resource, "store.get", [Check(key)]);
        return value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? default : value.Deserialize<T>(Runtime.Json);
    }

    public Task SetAsync<T>(string key, T value) => Runtime.CallNativeAsync(Resource, "store.set", [Check(key), value]);

    public Task DeleteAsync(string key) => Runtime.CallNativeAsync(Resource, "store.delete", [Check(key)]);

    public async Task<IReadOnlyList<string>> KeysAsync(string prefix = "") =>
        (await Runtime.CallNativeAsync(Resource, "store.keys", [prefix])).Deserialize<string[]>(Runtime.Json) ?? [];

    private static string Check(string key)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);
        if (key.Length > 256) throw new ArgumentException("Store keys can be at most 256 characters.", nameof(key));
        return key;
    }
}
