using System.Text.Json.Serialization;

namespace ProjectVI;

/// <summary>A position or direction in the game world, in meters.</summary>
public readonly record struct Vector3(
    [property: JsonPropertyName("x")] float X,
    [property: JsonPropertyName("y")] float Y,
    [property: JsonPropertyName("z")] float Z)
{
    /// <summary>(0, 0, 0).</summary>
    public static Vector3 Zero => default;

    /// <summary>Length of the vector.</summary>
    public float Length => MathF.Sqrt(X * X + Y * Y + Z * Z);

    /// <summary>Straight-line distance between two points.</summary>
    public static float Distance(Vector3 a, Vector3 b) => (a - b).Length;

    /// <summary>Adds two vectors.</summary>
    public static Vector3 operator +(Vector3 a, Vector3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);

    /// <summary>Subtracts <paramref name="b"/> from <paramref name="a"/>.</summary>
    public static Vector3 operator -(Vector3 a, Vector3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);

    /// <summary>Scales a vector.</summary>
    public static Vector3 operator *(Vector3 a, float s) => new(a.X * s, a.Y * s, a.Z * s);

    /// <inheritdoc />
    public override string ToString() => $"({X:0.##}, {Y:0.##}, {Z:0.##})";
}
