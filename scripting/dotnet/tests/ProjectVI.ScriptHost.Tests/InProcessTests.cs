using System.Runtime.CompilerServices;
using System.Text.Json;
using ProjectVI.Runtime;

namespace ProjectVI.ScriptHost.Tests;

public sealed class InProcessTests
{
    [Theory]
    [InlineData("0.3.0", "0.3.0", true)]
    [InlineData("0.3.0", "0.3.9", true)]
    [InlineData("0.2.0", "0.3.0", false)]
    [InlineData("0.4.0", "0.3.0", false)]
    [InlineData("1.2.0", "1.4.0", true)]
    [InlineData("1.5.0", "1.4.0", false)]
    [InlineData("2.0.0", "1.4.0", false)]
    public void Sdk_compatibility(string built, string host, bool expected) =>
        Assert.Equal(expected, ResourceLoadContext.IsCompatible(Version.Parse(built), Version.Parse(host)));

    [Fact]
    public async Task HandlerBinder_fills_defaults_and_explains_bad_input()
    {
        var json = ScriptJson.CreateOptions();
        string? got = null;
        var bound = HandlerBinder.Bind((string name, int times = 3) => got = $"{name}x{times}", json, NoSideBinding.Instance);

        await bound(Invocation("Kai"));
        Assert.Equal("Kaix3", got);

        var missing = await Assert.ThrowsAsync<ArgumentException>(() => bound(Invocation()));
        Assert.Contains("needs a value for 'name'", missing.Message);

        var wrongType = await Assert.ThrowsAsync<ArgumentException>(() => bound(Invocation("Kai", "lots")));
        Assert.Contains("'times'", wrongType.Message);
    }

    [Fact]
    public async Task Stopped_resources_are_unloaded()
    {
        using var scripts = new ScriptThread(_ => { });
        var runtime = new HostRuntime("server", scripts);
        runtime.Connect(new RpcConnection(new MemoryStream(), Stream.Null, runtime.Json, _ => { }));
        var host = new ResourceHost(runtime, scripts);

        await StartAndStop(host, scripts);

        WeakReference context = Assert.Single(host.UnloadedContexts);
        for (int i = 0; i < 20 && context.IsAlive; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
        Assert.False(context.IsAlive, "The resource's AssemblyLoadContext is still referenced after stopping.");
    }

    // Kept out of the test method so no locals keep the resource alive.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task StartAndStop(ResourceHost host, ScriptThread scripts)
    {
        string dll = Artifacts.TestResources;
        await scripts.InvokeAsync(() => host.StartAsync("test", Path.GetDirectoryName(dll)!, [dll]));
        await scripts.InvokeAsync<object?>(async () =>
        {
            await host.StopAsync("test");
            return null;
        });
    }

    private static EventInvocation Invocation(params object[] args) =>
        new("test", args.Select(a => JsonSerializer.SerializeToElement(a)).ToList(), EventOrigin.Local);
}
