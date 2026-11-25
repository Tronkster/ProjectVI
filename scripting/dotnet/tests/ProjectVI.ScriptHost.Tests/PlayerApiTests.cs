using ProjectVI.Server;
using ProjectVI.Testing;

namespace ProjectVI.ScriptHost.Tests;

// Player state, ping, vehicles with enter and exit events, and chat, as a script uses them.
public sealed class PlayerApiTests : IAsyncLifetime
{
    private readonly TestServer server = new("Player API test");
    private TestPlayer kai = null!;
    private TestPlayer ana = null!;

    public async ValueTask InitializeAsync()
    {
        await server.StartAsync<TaxiScript>("taxi");
        kai = await server.AddPlayerAsync("Kai", ["discord:111"]);
        ana = await server.AddPlayerAsync("Ana", ["discord:222"]);
    }

    public async ValueTask DisposeAsync() => await server.DisposeAsync();

    [Fact]
    public async Task Scripts_read_a_players_state_and_ping()
    {
        Assert.Equal("Kai: no state yet.", await server.RunCommandAsync(kai, "status"));

        server.SetState(kai, TestServer.OnFoot(new Vector3(10, 20, 30)) with { Velocity = new Vector3(3, 4, 0), Health = 150 });
        server.SetPing(kai, 42);
        server.SetHost(kai);
        Assert.Equal("Kai: on foot at (10, 20, 30), 5 m/s, health 150, 42 ms, host.", await server.RunCommandAsync(kai, "status"));
    }

    [Fact]
    public async Task Entering_and_leaving_vehicles_raises_events_and_shows_in_the_state()
    {
        var car = new VehicleState(7, "taxi", new Vector3(1, 2, 3), new Quaternion(0, 0, 0, 1), new Vector3(10, 0, 0), 900, 0.5f,
            VehicleStateFlags.EngineOn | VehicleStateFlags.Lights, DriverId: kai.Id, ControllerId: kai.Id);
        server.SetVehicle(car);

        await server.EnterVehicleAsync(kai, 7, seat: 0);
        await server.EnterVehicleAsync(ana, 7, seat: 1);
        await server.EnterVehicleAsync(ana, 7, seat: 2); // moves over: a leave, then an enter
        await server.LeaveVehicleAsync(kai);

        Assert.Equal(["Kai got in 7 seat 0", "Ana got in 7 seat 1", "Ana got out of 7 seat 1", "Ana got in 7 seat 2", "Kai got out of 7 seat 0"], TaxiScript.Heard);
        Assert.Equal("Ana: passenger in 7 (seat 2).", await server.RunCommandAsync(ana, "status"));
        Assert.Equal("taxi: 10 m/s, health 900, EngineOn, Lights, driver #" + kai.Id + ".", await server.RunCommandAsync(kai, "car 7"));
        Assert.Equal("No vehicle 99.", await server.RunCommandAsync(kai, "car 99"));
    }

    [Fact]
    public async Task Scripts_keep_a_mission_vehicle_with_the_host()
    {
        server.SetVehicle(new VehicleState(3, "police", Vector3.Zero, new Quaternion(0, 0, 0, 1), Vector3.Zero, 1000, 0, VehicleStateFlags.None, 0, 0));
        Assert.Equal("police stays with the host.", await server.RunCommandAsync(kai, "mission 3"));
        Assert.Equal("Something went wrong running /mission.", await server.RunCommandAsync(kai, "mission 99"));
        Assert.Contains(server.Errors, e => e.Message.Contains("no vehicle with id 99"));
    }

    [Fact]
    public async Task Scripts_send_chat_to_one_player_or_everyone()
    {
        await server.EmitAsync(ServerEvents.PlayerChat, ana.Player, "anyone driving?");
        Assert.Equal([new ChatLine(ana.Id, "Kai is free, ask them."), new ChatLine(null, "Ana is looking for a ride.")], server.ChatSent);
    }

    [Fact]
    public async Task Suspicious_reports_reach_scripts()
    {
        await server.EmitAsync(ServerEvents.PlayerSuspicious, kai.Player, "teleport", new { distance = 1800, seconds = 0.05 });
        Assert.Equal(["Kai: teleport 1800"], TaxiScript.Suspicious);
    }

    private sealed class TaxiScript : ServerScript
    {
        public static List<string> Heard { get; } = [];
        public static List<string> Suspicious { get; } = [];

        public TaxiScript()
        {
            Heard.Clear();
            Suspicious.Clear();
        }

        [Event(ServerEvents.PlayerEnteredVehicle)]
        private void OnEnter(Player player, int vehicleId, int seat) => Heard.Add($"{player.Name} got in {vehicleId} seat {seat}");

        [Event(ServerEvents.PlayerLeftVehicle)]
        private void OnLeave(Player player, int vehicleId, int seat) => Heard.Add($"{player.Name} got out of {vehicleId} seat {seat}");

        [Event(ServerEvents.PlayerSuspicious)]
        private void OnSuspicious(Player player, string kind, System.Text.Json.JsonElement details) =>
            Suspicious.Add($"{player.Name}: {kind} {details.GetProperty("distance").GetInt32()}");

        [Event(ServerEvents.PlayerChat)]
        private async Task OnChat(Player player, string message)
        {
            if (!message.Contains("driving", StringComparison.OrdinalIgnoreCase)) return;
            await Chat.SendAsync(player, "Kai is free, ask them.");
            await Chat.BroadcastAsync($"{player.Name} is looking for a ride.");
        }

        [Command("status")]
        private async Task<string> Status([FromSource] Player player)
        {
            if (await player.GetStateAsync() is not { } state) return $"{player.Name}: no state yet.";
            if (state.IsInVehicle) return $"{player.Name}: {(state.IsDriving ? "driving" : "passenger in")} {state.VehicleId} (seat {state.Seat}).";
            int? ping = await player.GetPingAsync();
            bool host = await player.IsHostAsync();
            return $"{player.Name}: on foot at {state.Position}, {state.Speed:0} m/s, health {state.Health}, {ping} ms{(host ? ", host" : "")}.";
        }

        [Command("mission")]
        private async Task<string> Mission(int id)
        {
            await Entities.SetStaysWithHostAsync(id);
            VehicleState car = (await Entities.GetVehicleAsync(id))!;
            return $"{car.Model} {(car.StaysWithHost ? "stays with the host" : "goes to whoever is nearest")}.";
        }

        [Command("car")]
        private async Task<string> Car(int id)
        {
            if (await Entities.GetVehicleAsync(id) is not { } car) return $"No vehicle {id}.";
            return $"{car.Model}: {car.Speed:0} m/s, health {car.Health}, {car.Flags}, driver #{car.DriverId}.";
        }
    }
}
