using ProjectVI.Runtime;

namespace ProjectVI;

/// <summary>Information about the resource a script belongs to.</summary>
/// <param name="Name">Resource name, as in <c>server.toml</c>.</param>
/// <param name="Side"><c>server</c> or <c>client</c>.</param>
public sealed record ResourceInfo(string Name, string Side);

/// <summary>
/// Base for every script. Don't derive from this directly: use <c>ServerScript</c> or <c>ClientScript</c>.
/// The runtime creates one instance of each script class when its resource starts.
/// </summary>
public abstract class Script
{
    private ScriptContext? context;
    private TimersImpl? timers;
    private ExportsImpl? exports;
    private ConfigImpl? config;
    private CommandsImpl? commands;

    internal ScriptContext Context =>
        context ?? throw new InvalidOperationException("This script isn't running yet. Use OnStart instead of the constructor.");

    /// <summary>Log tagged with this resource's name.</summary>
    public ILog Log => Context.Log;

    /// <summary>The resource this script belongs to.</summary>
    public ResourceInfo Resource => Context.Resource;

    /// <summary>Repeating and delayed work.</summary>
    public ITimers Timers => timers ??= new TimersImpl(Context);

    /// <summary>Calls to and from other resources.</summary>
    public IExports Exports => exports ??= new ExportsImpl(Context);

    /// <summary>This resource's <c>config.toml</c>.</summary>
    public IConfig Config => config ??= new ConfigImpl(Context.Config, Context.Runtime.Json);

    /// <summary>Chat and console commands.</summary>
    public ICommands Commands => commands ??= new CommandsImpl(Context);

    /// <summary>Runs when the resource starts, after every script in it was created. Throwing here stops the resource.</summary>
    protected virtual Task OnStart() => Task.CompletedTask;

    /// <summary>Runs when the resource stops. Event handlers, commands and timers are removed for you afterwards.</summary>
    protected virtual Task OnStop() => Task.CompletedTask;

    internal void Attach(ScriptContext scriptContext) => context = scriptContext;

    internal Task StartAsync() => OnStart();

    internal Task StopAsync() => OnStop();
}
