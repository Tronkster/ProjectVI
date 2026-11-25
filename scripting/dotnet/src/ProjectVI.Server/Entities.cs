using System.Text.Json;
using System.Text.Json.Serialization;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// Something in the game world, such as a vehicle.
/// Vehicles are sent to players over sync. Vehicles that players' clients registered themselves have a model hash
/// instead of a name, for example <c>"0x39da2754"</c>.
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
    /// <summary>
    /// Spawns a vehicle, for example <c>"taxi"</c> or a hash such as <c>"0x39da2754"</c>, at a position facing
    /// <paramref name="heading"/> degrees.
    /// </summary>
    Task<Entity> SpawnVehicleAsync(string model, Vector3 position, float heading = 0);

    /// <summary>Every entity in the world.</summary>
    Task<IReadOnlyList<Entity>> ListAsync();

    /// <summary>Removes an entity. Does nothing if it's already gone.</summary>
    Task DeleteAsync(Entity entity);

    /// <summary>
    /// A vehicle's state as the server last heard it from the game simulating it: position, rotation, speed, health,
    /// lights and siren, who's driving and whose game controls it. Null if there's no vehicle with that id.
    /// </summary>
    Task<VehicleState?> GetVehicleAsync(int vehicleId);

    /// <summary>
    /// Keeps a vehicle with the host's game (<paramref name="stays"/> true), as a mission's vehicle should be: the host
    /// simulates it wherever it is, and it moves to the next host if the host leaves. A driver still controls it while
    /// driving. False lets it go to whoever is nearest again. Throws if there's no such vehicle.
    /// </summary>
    Task SetStaysWithHostAsync(int vehicleId, bool stays = true);
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

    public async Task<VehicleState?> GetVehicleAsync(int vehicleId)
    {
        JsonElement result = await context.Runtime.CallNativeAsync(context.Resource.Name, "vehicle.state", [vehicleId]);
        return result.ValueKind == JsonValueKind.Null ? null : result.Deserialize<VehicleState>(context.Runtime.Json);
    }

    public Task SetStaysWithHostAsync(int vehicleId, bool stays = true) =>
        context.Runtime.CallNativeAsync(context.Resource.Name, "vehicle.setStaysWithHost", [vehicleId, stays]);
}
