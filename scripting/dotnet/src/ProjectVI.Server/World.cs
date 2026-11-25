using System.Text.Json;
using System.Text.Json.Serialization;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>A time of day in the game world.</summary>
public readonly record struct GameTime(
    [property: JsonPropertyName("hour")] int Hour,
    [property: JsonPropertyName("minute")] int Minute,
    [property: JsonPropertyName("second")] int Second)
{
    /// <summary>The time as <c>hh:mm</c>, for example <c>18:30</c>.</summary>
    public override string ToString() => $"{Hour:00}:{Minute:00}";
}

/// <summary>
/// The in-game clock and weather. The server decides both, so every player sees the same time of day and sky;
/// changes reach players straight away.
/// </summary>
public interface IWorld
{
    /// <summary>The in-game time now.</summary>
    Task<GameTime> GetTimeAsync();

    /// <summary>Sets the in-game time. The clock carries on from there at the current time scale.</summary>
    Task SetTimeAsync(int hour, int minute = 0, int second = 0);

    /// <summary>In-game minutes per real minute. 0 means the clock is stopped.</summary>
    Task<float> GetTimeScaleAsync();

    /// <summary>Sets how fast the clock runs, in in-game minutes per real minute (0 to 1000; 0 stops it).</summary>
    Task SetTimeScaleAsync(float scale);

    /// <summary>The current weather, for example <c>"clear"</c>.</summary>
    Task<string> GetWeatherAsync();

    /// <summary>
    /// Changes the weather, for example to <c>"rain"</c>. Players' games blend into it over
    /// <paramref name="transitionSeconds"/> (0 to 600; 0 changes it at once).
    /// Raises <see cref="ServerEvents.WeatherChanged"/> if the weather is different.
    /// </summary>
    Task SetWeatherAsync(string weather, float transitionSeconds = 30);
}

internal sealed class WorldImpl(ScriptContext context) : IWorld
{
    private Task<JsonElement> Call(string native, params object?[] args) =>
        context.Runtime.CallNativeAsync(context.Resource.Name, native, args);

    public async Task<GameTime> GetTimeAsync() => (await Call("world.time")).Deserialize<GameTime>(context.Runtime.Json);

    public Task SetTimeAsync(int hour, int minute = 0, int second = 0) => Call("world.setTime", hour, minute, second);

    public async Task<float> GetTimeScaleAsync() => (await Call("world.timeScale")).GetSingle();

    public Task SetTimeScaleAsync(float scale) => Call("world.setTimeScale", scale);

    public async Task<string> GetWeatherAsync() => (await Call("world.weather")).GetString() ?? "";

    public Task SetWeatherAsync(string weather, float transitionSeconds = 30)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(weather);
        return Call("world.setWeather", weather, transitionSeconds);
    }
}
