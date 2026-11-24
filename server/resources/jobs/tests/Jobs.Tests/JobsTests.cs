using Jobs;
using ProjectVI.Testing;

namespace Jobs.Tests;

public sealed class JobsTests : IAsyncLifetime
{
    // Same shape as config.toml.
    private static readonly object Config = new
    {
        payIntervalSeconds = 60,
        jobs = new Dictionary<string, object>
        {
            ["mechanic"] = new { label = "Mechanic", pay = 120 },
            ["taxi"] = new { label = "Taxi driver", pay = 90 }
        }
    };

    private readonly TestServer server = new("Sunset Coast RP");
    private TestPlayer admin = null!;
    private TestPlayer ana = null!;

    public async ValueTask InitializeAsync()
    {
        await server.StartAsync<JobsScript>("jobs", Config);
        admin = await server.AddPlayerAsync("Kai", ["discord:111"], groups: ["admin"]);
        ana = await server.AddPlayerAsync("Ana", ["discord:222"]);
    }

    public async ValueTask DisposeAsync() => await server.DisposeAsync();

    [Fact]
    public async Task Admin_gives_a_job_and_the_player_is_told()
    {
        Assert.Equal("Ana is now a Mechanic.", await server.RunCommandAsync(admin, "job Ana mechanic"));

        Assert.Contains("You're now a Mechanic.", server.NotificationsFor(ana));
        SentEvent changed = Assert.Single(server.SentToClients, e => e.Name == "jobs:changed");
        Assert.Equal(ana.Id, changed.PlayerId);
        Assert.Equal("mechanic", changed.Arg<string>(0));
        Assert.Equal("mechanic", server.StoreValue<string>("jobs", "job:discord:222"));
        Assert.Empty(server.Errors);
    }

    [Fact]
    public async Task Players_without_the_admin_group_are_refused()
    {
        Assert.Equal("You don't have permission to use /job.", await server.RunCommandAsync(ana, "job Ana mechanic"));
        Assert.Null(server.StoreValue<string>("jobs", "job:discord:222"));
    }

    [Fact]
    public async Task The_console_can_give_jobs_too() =>
        Assert.Equal("Ana is now a Taxi driver.", await server.RunCommandAsync(null, "job Ana taxi"));

    [Theory]
    [InlineData("job", "Usage: /job <target> <job>")]
    [InlineData("job Ana pilot", "Unknown job 'pilot'. Jobs: mechanic, taxi.")]
    [InlineData("job Nobody taxi", "No player called 'Nobody' is online.")]
    public async Task Mistakes_get_a_helpful_reply(string command, string reply) =>
        Assert.Equal(reply, await server.RunCommandAsync(admin, command));

    [Fact]
    public async Task Clocking_in_needs_a_job()
    {
        Assert.True(await server.SendFromClientAsync(ana, "jobs:clockIn"));
        Assert.Contains("You need a job before you can clock in.", server.NotificationsFor(ana));
    }

    [Fact]
    public async Task Players_on_duty_get_paid_every_interval()
    {
        await server.RunCommandAsync(admin, "job Ana mechanic");
        await server.SendFromClientAsync(ana, "jobs:clockIn");

        await server.AdvanceTimeAsync(TimeSpan.FromSeconds(60));
        Assert.Contains("Payday: +$120 (you have $120).", server.NotificationsFor(ana));

        await server.AdvanceTimeAsync(TimeSpan.FromSeconds(60));
        Assert.Equal(240, server.StoreValue<int>("jobs", "money:discord:222"));

        await server.SendFromClientAsync(ana, "jobs:clockOut");
        await server.AdvanceTimeAsync(TimeSpan.FromSeconds(60));
        Assert.Equal(240, server.StoreValue<int>("jobs", "money:discord:222"));
    }

    [Fact]
    public async Task Other_resources_can_read_jobs_through_the_export()
    {
        await server.RunCommandAsync(admin, "job Ana taxi");
        Assert.Equal("taxi", await server.CallExportAsync<string>("jobs", "GetJob", ana.Player));
        Assert.Null(await server.CallExportAsync<string>("jobs", "GetJob", admin.Player));
    }

    [Fact]
    public async Task Myjob_answers_the_player() =>
        Assert.Equal("You don't have a job yet.", await server.RunCommandAsync(ana, "myjob"));

    [Fact]
    public async Task Clients_cant_trigger_events_that_arent_NetEvents() =>
        Assert.False(await server.SendFromClientAsync(ana, "jobs:paid", 1_000_000));
}
