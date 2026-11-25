using System.Text.Json.Serialization;

namespace ProjectVI.Server;

/// <summary>What a player's client last reported about them. Mirrors the sync protocol's player state.</summary>
[Flags]
public enum PlayerStateFlags
{
    /// <summary>On foot and standing still.</summary>
    None = 0,
    /// <summary>Sitting in a vehicle (see <see cref="PlayerState.VehicleId"/> and <see cref="PlayerState.Seat"/>).</summary>
    InVehicle = 1,
    /// <summary>Walking or running.</summary>
    Moving = 2,
    /// <summary>Aiming a weapon (see <see cref="PlayerState.Aim"/>).</summary>
    Aiming = 4,
    /// <summary>Dead.</summary>
    Dead = 8,
    /// <summary>Crouching.</summary>
    Crouched = 16,
    /// <summary>In a jump.</summary>
    Jumping = 32,
    /// <summary>Ragdolling (knocked over, falling).</summary>
    Ragdoll = 64,
    /// <summary>Firing a weapon.</summary>
    Shooting = 128,
    /// <summary>Swimming.</summary>
    Swimming = 256
}

/// <summary>
/// A player's state as their client last reported it, about 20 times a second. The server has already checked it:
/// impossible jumps and seat claims are refused or removed (see <see cref="ServerEvents.PlayerSuspicious"/>).
/// </summary>
public sealed record PlayerState(
    [property: JsonPropertyName("position")] Vector3 Position,
    [property: JsonPropertyName("velocity")] Vector3 Velocity,
    [property: JsonPropertyName("heading")] float Heading,
    [property: JsonPropertyName("flags")] PlayerStateFlags Flags,
    [property: JsonPropertyName("model")] uint Model,
    [property: JsonPropertyName("health")] int Health,
    [property: JsonPropertyName("armour")] int Armour,
    [property: JsonPropertyName("weapon")] uint Weapon,
    [property: JsonPropertyName("aim")] Vector3 Aim,
    [property: JsonPropertyName("vehicleId")] int VehicleId,
    [property: JsonPropertyName("seat")] int Seat)
{
    /// <summary>Speed in metres per second.</summary>
    public float Speed => Velocity.Length;

    /// <summary>True if the player is sitting in a vehicle.</summary>
    public bool IsInVehicle => Flags.HasFlag(PlayerStateFlags.InVehicle) && VehicleId != 0;

    /// <summary>True if the player is in the driver's seat (seat 0) of a vehicle.</summary>
    public bool IsDriving => IsInVehicle && Seat == 0;

    /// <summary>True if the player is dead.</summary>
    public bool IsDead => Flags.HasFlag(PlayerStateFlags.Dead);
}

/// <summary>Vehicle state flags, as in the sync protocol.</summary>
[Flags]
public enum VehicleStateFlags
{
    /// <summary>Nothing on.</summary>
    None = 0,
    /// <summary>The engine is running.</summary>
    EngineOn = 1,
    /// <summary>Headlights on.</summary>
    Lights = 2,
    /// <summary>Siren on.</summary>
    Siren = 4,
    /// <summary>Horn sounding.</summary>
    Horn = 8,
    /// <summary>Wrecked.</summary>
    Destroyed = 16,
    /// <summary>Kept with the host's game wherever it is (a mission's vehicle). See <see cref="VehicleState.StaysWithHost"/>.</summary>
    StaysWithHost = 32
}

/// <summary>A rotation as a unit quaternion.</summary>
public readonly record struct Quaternion(
    [property: JsonPropertyName("x")] float X,
    [property: JsonPropertyName("y")] float Y,
    [property: JsonPropertyName("z")] float Z,
    [property: JsonPropertyName("w")] float W);

/// <summary>
/// A vehicle as the server last heard about it. <see cref="ControllerId"/> is the player whose game simulates it
/// (0 for nobody nearby); <see cref="DriverId"/> is the player in the driver's seat (0 if empty).
/// <see cref="StaysWithHost"/> vehicles are simulated by the host's game wherever they are, unless someone drives them.
/// </summary>
public sealed record VehicleState(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("position")] Vector3 Position,
    [property: JsonPropertyName("rotation")] Quaternion Rotation,
    [property: JsonPropertyName("velocity")] Vector3 Velocity,
    [property: JsonPropertyName("health")] int Health,
    [property: JsonPropertyName("steering")] float Steering,
    [property: JsonPropertyName("flags")] VehicleStateFlags Flags,
    [property: JsonPropertyName("driver")] int DriverId,
    [property: JsonPropertyName("controller")] int ControllerId,
    [property: JsonPropertyName("staysWithHost")] bool StaysWithHost = false)
{
    /// <summary>Speed in metres per second.</summary>
    public float Speed => Velocity.Length;

    /// <summary>True if someone is in the driver's seat.</summary>
    public bool HasDriver => DriverId != 0;
}
