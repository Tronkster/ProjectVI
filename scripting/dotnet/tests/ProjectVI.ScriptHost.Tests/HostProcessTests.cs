using System.Text.Json;

namespace ProjectVI.ScriptHost.Tests;

public sealed class HostProcessTests
{
    private static bool EmitOf(JsonElement p, string name) => p.Str("name") == name;

    [Fact]
    public async Task Initialize_reports_protocol_and_sdk()
    {
        await using var host = await HostProcess.StartAsync();
        var result = await host.Rpc.RequestAsync("initialize", new { protocol = 1, side = "server" });
        Assert.Equal(1, result.GetProperty("protocol").GetInt32());
        Assert.Equal("0.3.0", result.GetProperty("sdkVersion").GetString());
    }

    [Fact]
    public async Task Wrong_protocol_version_is_refused()
    {
        await using var host = await HostProcess.StartAsync();
        var ex = await Assert.ThrowsAsync<RpcException>(() => host.Rpc.RequestAsync("initialize", new { protocol = 99 }));
        Assert.Contains("protocol 1", ex.Message);
    }

    [Fact]
    public async Task Starting_a_resource_creates_its_scripts_and_subscribes_their_events()
    {
        await using var host = await HostProcess.StartAsync();
        var result = await host.StartResource("test", Artifacts.TestResources);

        var scripts = result.GetProperty("scripts").EnumerateArray().Select(s => s.GetString()).ToList();
        Assert.Contains("ProjectVI.TestResources.Greeter", scripts);
        await host.WaitFor("event/subscribe", p => p.Str("name") == "test:greet" && !p.GetProperty("network").GetBoolean());
        await host.WaitFor("event/subscribe", p => p.Str("name") == "test:fromClient" && p.GetProperty("network").GetBoolean());
    }

    [Fact]
    public async Task Events_go_in_and_out_with_typed_arguments()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);

        host.Dispatch("test:greet", false, "Kai", 2);
        var emit = await host.WaitFor("event/emit", p => EmitOf(p, "test:greeted"));
        Assert.Equal("Hello, Kai! Hello, Kai!", emit.GetProperty("args")[0].GetString());
        Assert.Equal("local", emit.Str("target"));
        Assert.Equal("test", emit.Str("resource"));
    }

    [Fact]
    public async Task A_throwing_handler_is_logged_and_the_others_still_run()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);

        host.Dispatch("test:greet", false, "Ana");
        await host.WaitFor("event/emit", p => EmitOf(p, "test:greeted"));
        var error = await host.WaitFor("log", p => p.Str("level") == "error" && p.Str("message")!.Contains("boom for Ana"));
        Assert.Equal("test", error.Str("resource"));
    }

    [Fact]
    public async Task Console_output_from_scripts_becomes_log_messages()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);

        var line = await host.WaitFor("log", p => p.Str("message") == "printed from a script");
        Assert.Equal("info", line.Str("level"));
        Assert.Equal("test", line.Str("resource"));
        await host.WaitFor("log", p => p.Str("message") == "printed to stderr from a script" && p.Str("level") == "error");

        // The protocol still works after scripts printed.
        host.Dispatch("test:greet", false, "Kai");
        await host.WaitFor("event/emit", p => EmitOf(p, "test:greeted"));
    }

    [Fact]
    public async Task Async_handlers_continue_on_the_script_thread()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);

        host.Dispatch("test:echoAsync", false, "first");
        host.Dispatch("test:echoAsync", false, "second");
        var first = await host.WaitFor("event/emit", p => EmitOf(p, "test:echoed") && p.GetProperty("args")[0].GetString() == "first");
        var second = await host.WaitFor("event/emit", p => EmitOf(p, "test:echoed") && p.GetProperty("args")[0].GetString() == "second");
        Assert.Equal(first.GetProperty("args")[1].GetInt32(), second.GetProperty("args")[1].GetInt32());
    }

    [Fact]
    public async Task Network_events_only_reach_NetEvent_handlers_and_are_type_checked()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);

        host.Dispatch("test:fromClient", false, 5); // same name, but not from the network
        Assert.False(await host.Arrives("event/emit", p => EmitOf(p, "test:fromClientSeen"), 500));

        host.Dispatch("test:fromClient", true, "not a number");
        await host.WaitFor("log", p => p.Str("level") == "error" && p.Str("message")!.Contains("expects Int32"));
        Assert.False(await host.Arrives("event/emit", p => EmitOf(p, "test:fromClientSeen"), 300));

        host.Dispatch("test:fromClient", true, 5);
        var seen = await host.WaitFor("event/emit", p => EmitOf(p, "test:fromClientSeen"));
        Assert.Equal(5, seen.GetProperty("args")[0].GetInt32());
    }

    [Fact]
    public async Task A_resource_that_fails_OnStart_is_rolled_back_and_others_still_start()
    {
        await using var host = await HostProcess.StartAsync();
        var ex = await Assert.ThrowsAsync<RpcException>(() => host.StartResource("broken", Artifacts.BrokenResource));
        Assert.Equal(ResourceHost.ResourceFailed, ex.Code);
        Assert.Contains("database is down", ex.Message);

        await host.StartResource("test", Artifacts.TestResources);
    }

    [Fact]
    public async Task Stopping_unsubscribes_and_the_resource_can_start_again()
    {
        await using var host = await HostProcess.StartAsync();
        await host.StartResource("test", Artifacts.TestResources);
        await host.StopResource("test");
        await host.WaitFor("event/unsubscribe", p => p.Str("name") == "test:greet");

        await host.StartResource("test", Artifacts.TestResources);
        host.Dispatch("test:greet", false, "again");
        await host.WaitFor("event/emit", p => EmitOf(p, "test:greeted") && p.GetProperty("args")[0].GetString() == "Hello, again!");
    }

    [Fact]
    public async Task Missing_files_and_unknown_methods_are_explained()
    {
        await using var host = await HostProcess.StartAsync();
        var missing = await Assert.ThrowsAsync<RpcException>(() => host.StartResource("ghost", Path.Combine(Path.GetTempPath(), "ghost.dll")));
        Assert.Contains("wasn't found", missing.Message);

        var unknown = await Assert.ThrowsAsync<RpcException>(() => host.Rpc.RequestAsync("does/not/exist", new { }));
        Assert.Equal(RpcConnection.MethodNotFound, unknown.Code);
    }
}
