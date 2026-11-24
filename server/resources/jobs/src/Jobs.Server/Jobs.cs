using ProjectVI;
using ProjectVI.Server;

namespace Jobs;

/// <summary>config.toml, bound to a class.</summary>
public sealed class JobsConfig
{
    public int PayIntervalSeconds { get; set; } = 60;
    public Dictionary<string, JobDefinition> Jobs { get; set; } = [];
}

public sealed class JobDefinition
{
    public string Label { get; set; } = "";
    public int Pay { get; set; }
}

/// <summary>
/// Admins hand out jobs, players clock in from their client, and everyone on duty gets paid on a timer.
/// Shows commands with permissions, net events, timers, exports, config and saved data.
/// </summary>
public sealed class JobsScript : ServerScript
{
    private readonly HashSet<int> onDuty = [];
    private JobsConfig config = new();

    protected override Task OnStart()
    {
        config = Config.Bind<JobsConfig>();
        Timers.Every(TimeSpan.FromSeconds(config.PayIntervalSeconds), PayDayAsync);
        Log.Info($"{config.Jobs.Count} jobs loaded, payday every {config.PayIntervalSeconds} s");
        return Task.CompletedTask;
    }

    [Command("job", Permission = "admin", Help = "Give a player a job: /job <player> <job>")]
    private async Task<string> SetJob(Player target, string job)
    {
        if (!config.Jobs.TryGetValue(job, out JobDefinition? definition))
        {
            return $"Unknown job '{job}'. Jobs: {string.Join(", ", config.Jobs.Keys)}.";
        }
        await Store.SetAsync(JobKey(target), job);
        target.Notify($"You're now a {definition.Label}.");
        Events.EmitToClient(target, "jobs:changed", job, definition.Label);
        Log.Info($"{target.Name} is now a {definition.Label}");
        return $"{target.Name} is now a {definition.Label}.";
    }

    [Command("myjob", Help = "Show your job")]
    private async Task<string> MyJob([FromSource] Player player) =>
        await GetJob(player) is { } job && config.Jobs.TryGetValue(job, out JobDefinition? definition)
            ? $"You're a {definition.Label}{(onDuty.Contains(player.Id) ? ", on duty" : "")}."
            : "You don't have a job yet.";

    // Sent by the jobs client script when the player presses the clock-in key.
    [NetEvent("jobs:clockIn")]
    private async Task ClockIn([FromSource] Player player)
    {
        if (await GetJob(player) is null)
        {
            player.Notify("You need a job before you can clock in.");
            return;
        }
        if (onDuty.Add(player.Id))
        {
            player.Notify("Clocked in. You get paid while you're on duty.");
        }
    }

    [NetEvent("jobs:clockOut")]
    private void ClockOut([FromSource] Player player)
    {
        if (onDuty.Remove(player.Id))
        {
            player.Notify("Clocked out.");
        }
    }

    [Event(ServerEvents.PlayerLeft)]
    private void OnLeft(Player player, string reason) => onDuty.Remove(player.Id);

    /// <summary>Other resources can ask for a player's job: Exports.CallAsync&lt;string&gt;("jobs", "GetJob", player).</summary>
    [Export]
    public Task<string?> GetJob(Player player) => Store.GetAsync<string>(JobKey(player));

    [Export]
    public int OnDutyCount() => onDuty.Count;

    private async Task PayDayAsync()
    {
        foreach (Player player in Players.All.Where(p => onDuty.Contains(p.Id)).ToList())
        {
            if (await GetJob(player) is not { } job || !config.Jobs.TryGetValue(job, out JobDefinition? definition))
            {
                continue;
            }
            string moneyKey = $"money:{player.PrimaryIdentifier}";
            int money = await Store.GetAsync<int>(moneyKey) + definition.Pay;
            await Store.SetAsync(moneyKey, money);
            player.Notify($"Payday: +${definition.Pay} (you have ${money}).");
            Events.EmitToClient(player, "jobs:paid", definition.Pay, money);
        }
    }

    // Saved by identifier, so the job survives reconnects (guests get a new identifier each time).
    private static string JobKey(Player player) => $"job:{player.PrimaryIdentifier}";
}
