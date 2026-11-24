// ProjectVI script host: runs C# resources for the server core (or, later, the game client).
// Talks JSON-RPC over stdin/stdout. See docs/scripting/host-protocol.md.
//
// Usage: ProjectVI.ScriptHost [--side server|client] [--wait-for-debugger]

using System.Diagnostics;
using ProjectVI;
using ProjectVI.Runtime;
using ProjectVI.ScriptHost;

string side = "server";
bool waitForDebugger = false;
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--side" && i + 1 < args.Length) side = args[++i];
    else if (args[i] == "--wait-for-debugger") waitForDebugger = true;
}
if (side is not ("server" or "client"))
{
    Console.Error.WriteLine("--side must be server or client.");
    return 2;
}

// stdout carries protocol frames only. Grab the real streams before anything else can write to them.
Stream protocolOut = Console.OpenStandardOutput();
Stream protocolIn = Console.OpenStandardInput();
var fatal = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true };

HostRuntime? runtimeRef = null;
var scripts = new ScriptThread(ex => runtimeRef?.Log(HostRuntime.CurrentResource.Value, LogLevel.Error, $"Unhandled error in a script: {ex}"));
var runtime = new HostRuntime(side, scripts);
runtimeRef = runtime;
var rpc = new RpcConnection(protocolIn, protocolOut, runtime.Json, message => fatal.WriteLine($"[script host] {message}"));
runtime.Connect(rpc);

Console.SetOut(new ConsoleRedirect(runtime, LogLevel.Info));
Console.SetError(new ConsoleRedirect(runtime, LogLevel.Error));
AppDomain.CurrentDomain.UnhandledException += (_, e) => fatal.WriteLine($"[script host] Fatal: {e.ExceptionObject}");
TaskScheduler.UnobservedTaskException += (_, e) =>
{
    runtime.Log(null, LogLevel.Error, $"A script task failed and nobody awaited it: {e.Exception.InnerException ?? e.Exception}");
    e.SetObserved();
};

if (waitForDebugger)
{
    runtime.Log(null, LogLevel.Info, $"Waiting for a debugger to attach to process {Environment.ProcessId}…");
    while (!Debugger.IsAttached)
    {
        Thread.Sleep(200);
    }
}

var host = new ResourceHost(runtime, scripts);
host.Register(rpc);
var stopped = new TaskCompletionSource();
rpc.OnRequest("shutdown", async _ =>
{
    await scripts.InvokeAsync<object?>(async () =>
    {
        await host.StopAllAsync();
        return null;
    });
    stopped.TrySetResult();
    return new { };
});

// Runs until the core closes our stdin (or asks us to shut down).
await Task.WhenAny(rpc.RunAsync(), stopped.Task);
await scripts.InvokeAsync<object?>(async () =>
{
    await host.StopAllAsync();
    return null;
});
scripts.Dispose();
return 0;
