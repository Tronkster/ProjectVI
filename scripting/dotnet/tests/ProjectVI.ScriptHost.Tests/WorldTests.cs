using ProjectVI.Server;
using ProjectVI.Testing;

namespace ProjectVI.ScriptHost.Tests;

// The World API as a script uses it, against ProjectVI.Testing's simulated clock and weather.
public sealed class WorldTests : IAsyncLifetime
{
    private readonly TestServer server = new("World test");
    private TestPlayer admin = null!;

    public async ValueTask InitializeAsync()
    {
        await server.StartAsync<ClockScript>("clock");
        admin = await server.AddPlayerAsync("Kai", ["discord:111"], groups: ["admin"]);
    }

    public async ValueTask DisposeAsync() => await server.DisposeAsync();

    [Fact]
    public async Task Scripts_read_and_change_the_time()
    {
        server.WorldTime = new GameTime(6, 5, 0);
        Assert.Equal("It's 06:05.", await server.RunCommandAsync(admin, "time"));

        Assert.Equal("It's 18:30.", await server.RunCommandAsync(admin, "time 18 30"));
        Assert.Equal(new GameTime(18, 30, 0), server.WorldTime);
    }

    [Fact]
    public async Task Scripts_read_and_change_the_weather_and_the_time_scale()
    {
        Assert.Equal("Weather: rain, clock stopped.", await server.RunCommandAsync(admin, "storm"));
        Assert.Equal("rain", server.Weather);
        await server.WaitIdleAsync();
        Assert.Equal(["rain after clear"], ClockScript.Heard);

        await server.RunCommandAsync(admin, "storm"); // already raining: no event
        await server.WaitIdleAsync();
        Assert.Single(ClockScript.Heard);
    }

    [Fact]
    public async Task Bad_settings_are_refused_like_on_a_real_server()
    {
        string? reply = await server.RunCommandAsync(admin, "time 25");
        Assert.Equal("Something went wrong running /time.", reply);
        Assert.Contains(server.Errors, e => e.Message.Contains("hour from 0 to 23"));
        Assert.Equal(new GameTime(12, 0, 0), server.WorldTime);
    }

    [Fact]
    public void GameTime_prints_as_hours_and_minutes() => Assert.Equal("07:09", new GameTime(7, 9, 59).ToString());

    private sealed class ClockScript : ServerScript
    {
        public static List<string> Heard { get; } = [];

        public ClockScript() => Heard.Clear();

        [Event(ServerEvents.WeatherChanged)]
        private void OnWeather(string weather, string previous) => Heard.Add($"{weather} after {previous}");

        [Command("time", Permission = "admin")]
        private async Task<string> Time(int? hour = null, int minute = 0)
        {
            if (hour is { } h) await World.SetTimeAsync(h, minute);
            return $"It's {await World.GetTimeAsync()}.";
        }

        [Command("storm", Permission = "admin")]
        private async Task<string> Storm()
        {
            await World.SetWeatherAsync("Rain", transitionSeconds: 10);
            await World.SetTimeScaleAsync(0);
            float scale = await World.GetTimeScaleAsync();
            return $"Weather: {await World.GetWeatherAsync()}, {(scale == 0 ? "clock stopped" : $"{scale}x")}.";
        }
    }
}
