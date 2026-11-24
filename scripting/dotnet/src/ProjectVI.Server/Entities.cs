using System.Text.Json;
using System.Text.Json.Serialization;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// Something in the game world, such as a vehicle.
/// Simulated by the server core until the ProjectVI client exists; the API stays the same.
/// </summary>
public sealed record Entity(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("position")] Vector3 Position,
    [property: JsonPropertyName("heading")] float Heading);

/// <summary>Creates and removes things in the world. Entities a resource creates are removed when it stops.</summary>
public interface IEntities
{
    /// <summary>Spawns a vehicle, for example <c>"taxi"</c>, at a position facing <paramref name="heading"/> degrees.</summary>
    Task<Entity> SpawnVehicleAsync(string model, Vector3 position, float heading = 0);

    /// <summary>Every entity in the world.</summary>
    Task<IReadOnlyList<Entity>> ListAsync();

    /// <summary>Removes an entity. Does nothing if it's already gone.</summary>
    Task DeleteAsync(Entity entity);
}

internal sealed class EntitiesImpl(ScriptContext context) : IEntities
{
    public async Task<Entity> SpawnVehicleAsync(string model, Vector3 position, float heading = 0)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(model);
        JsonElement result = await context.Runtime.CallNativeAsync(context.Resource.Name, "entities.spawnVehicle", [model, position, heading]);
        return result.Deserialize<Entity>(context.Runtime.Json)!;
    }

    public async Task<IReadOnlyList<Entity>> ListAsync() =>
        (await context.Runtime.CallNativeAsync(context.Resource.Name, "entities.list", [])).Deserialize<Entity[]>(context.Runtime.Json) ?? [];

    public Task DeleteAsync(Entity entity) => context.Runtime.CallNativeAsync(context.Resource.Name, "entities.delete", [entity.Id]);
}
