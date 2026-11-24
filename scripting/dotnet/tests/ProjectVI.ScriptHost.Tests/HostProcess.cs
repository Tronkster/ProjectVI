using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using ProjectVI.Runtime;

namespace ProjectVI.ScriptHost.Tests;

/// <summary>A real script host process, with this test playing the server core on the other end.</summary>
internal sealed class HostProcess : IAsyncDisposable
{
    private readonly Process process;
    private readonly Channel<(string Method, JsonElement Params)> notifications = Channel.CreateUnbounded<(string, JsonElement)>();
    private readonly List<(string Method, JsonElement Params)> seen = [];

    public RpcConnection Rpc { get; }

    private HostProcess(Process process)
    {
        this.process = process;
        Rpc = new RpcConnection(process.StandardOutput.BaseStream, process.StandardInput.BaseStream, ScriptJson.CreateOptions(), _ => { });
        foreach (string method in new[] { "log", "event/emit", "event/subscribe", "event/unsubscribe" })
        {
            Rpc.OnNotification(method, p => notifications.Writer.TryWrite((method, p)));
        }
        _ = Rpc.RunAsync();
        _ = process.StandardError.ReadToEndAsync();
    }

    public static async Task<HostProcess> StartAsync()
    {
        var info = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        info.ArgumentList.Add(Artifacts.HostDll);
        info.ArgumentList.Add("--side");
        info.ArgumentList.Add("server");
        var host = new HostProcess(Process.Start(info)!);
        await host.Rpc.RequestAsync("initialize", new { protocol = 1, side = "server" }).WaitAsync(TimeSpan.FromSeconds(20));
        return host;
    }

    public Task<JsonElement> StartResource(string name, string assembly) =>
        Rpc.RequestAsync("resource/start", new { name, dir = Path.GetDirectoryName(assembly), assemblies = new[] { assembly } }).WaitAsync(TimeSpan.FromSeconds(20));

    public Task<JsonElement> StopResource(string name) =>
        Rpc.RequestAsync("resource/stop", new { name }).WaitAsync(TimeSpan.FromSeconds(20));

    public void Dispatch(string name, bool network, params object?[] args) =>
        Rpc.Notify("event/dispatch", new { name, network, args, source = (int?)null });

    /// <summary>Waits for a notification matching the method and predicate (including ones already received).</summary>
    public async Task<JsonElement> WaitFor(string method, Func<JsonElement, bool> match, int timeoutMs = 10_000)
    {
        foreach (var (m, p) in seen)
        {
            if (m == method && match(p)) return p;
        }
        using var timeout = new CancellationTokenSource(timeoutMs);
        try
        {
            while (true)
            {
                var item = await notifications.Reader.ReadAsync(timeout.Token);
                seen.Add(item);
                if (item.Method == method && match(item.Params)) return item.Params;
            }
        }
        catch (OperationCanceledException)
        {
            string received = string.Join("\n  ", seen.Select(s => $"{s.Method} {s.Params}"));
            throw new TimeoutException($"No {method} notification matched within {timeoutMs} ms. Received:\n  {received}");
        }
    }

    /// <summary>True if a matching notification arrives within the time; used to prove something did NOT happen.</summary>
    public async Task<bool> Arrives(string method, Func<JsonElement, bool> match, int withinMs)
    {
        try
        {
            await WaitFor(method, match, withinMs);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Rpc.RequestAsync("shutdown", new { }).WaitAsync(TimeSpan.FromSeconds(10));
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch
        {
            process.Kill(entireProcessTree: true);
        }
        process.Dispose();
    }
}

internal static class Json
{
    public static string? Str(this JsonElement e, string property) =>
        e.TryGetProperty(property, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
