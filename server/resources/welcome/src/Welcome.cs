using ProjectVI;
using ProjectVI.Server;

namespace Welcome;

/// <summary>Greets players, using the jobs resource's export when it's running.</summary>
public sealed class WelcomeScript : ServerScript
{
    protected override Task OnStart()
    {
        Log.Info("Welcome is running.");
        return Task.CompletedTask;
    }

    [Event(ServerEvents.PlayerJoined)]
    private async Task OnJoin(Player player)
    {
        string? job = null;
        try
        {
            job = await Exports.CallAsync<string>("jobs", "GetJob", player);
        }
        catch (Exception)
        {
            // jobs isn't running; greet without it
        }
        player.Notify(job is null
            ? $"Welcome to {Server.Name}, {player.Name}!"
            : $"Welcome back, {player.Name}. Ready for your {job} shift?");
        Log.Info($"{player.Name} joined as {player.PrimaryIdentifier} ({Players.Count} online)");
    }

    // Try it from the server console: emit welcome:ping "Kai"
    [Event("welcome:ping")]
    private void OnPing(string from)
    {
        Log.Info($"Ping from {from}");
        Events.Emit("welcome:pong", $"Hello, {from}!");
    }
}
