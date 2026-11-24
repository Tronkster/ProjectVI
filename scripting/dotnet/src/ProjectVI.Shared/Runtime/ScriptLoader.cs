using System.Reflection;
using System.Runtime.ExceptionServices;

namespace ProjectVI.Runtime;

/// <summary>A running resource: its script instances and their shared context.</summary>
internal sealed class LoadedScripts(ScriptContext context, IReadOnlyList<Script> scripts)
{
    public ScriptContext Context { get; } = context;
    public IReadOnlyList<Script> Scripts { get; } = scripts;
}

/// <summary>
/// Creates script instances, wires up their attributes ([Event], [NetEvent], [Command], [Tick], [Export])
/// and runs OnStart/OnStop. Used by both the real host and ProjectVI.Testing, so tests exercise the same code.
/// </summary>
internal static class ScriptLoader
{
    private const BindingFlags Members = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

    /// <summary>Classes in the assemblies that derive from <paramref name="scriptBase"/> and can be created.</summary>
    public static IReadOnlyList<Type> FindScriptTypes(IEnumerable<Assembly> assemblies, Type scriptBase) =>
        assemblies
            .SelectMany(SafeGetTypes)
            .Where(t => t is { IsClass: true, IsAbstract: false, ContainsGenericParameters: false } && scriptBase.IsAssignableFrom(t))
            .OrderBy(t => t.FullName, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// Creates every script, attaches it, wires its attributes, then runs OnStart in order.
    /// If anything fails, everything done so far is undone and the error is rethrown.
    /// </summary>
    public static async Task<LoadedScripts> StartAsync(ScriptContext context, IEnumerable<Type> types)
    {
        var scripts = new List<Script>();
        try
        {
            foreach (Type type in types)
            {
                ConstructorInfo ctor = type.GetConstructor(Members, Type.EmptyTypes)
                    ?? throw new InvalidOperationException($"{type.Name} needs a constructor without parameters.");
                var script = (Script)ctor.Invoke(null);
                script.Attach(context);
                Wire(script, context);
                scripts.Add(script);
            }
            foreach (Script script in scripts)
            {
                await script.StartAsync();
            }
            return new LoadedScripts(context, scripts);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            context.DisposeRegistrations();
            ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
        catch
        {
            context.DisposeRegistrations();
            throw;
        }
    }

    /// <summary>Runs OnStop on every script (newest first), then removes all registrations. Never throws.</summary>
    public static async Task StopAsync(LoadedScripts loaded)
    {
        for (int i = loaded.Scripts.Count - 1; i >= 0; i--)
        {
            try
            {
                await loaded.Scripts[i].StopAsync();
            }
            catch (Exception ex)
            {
                loaded.Context.Log.Error(ex, $"{loaded.Scripts[i].GetType().Name}.OnStop failed");
            }
        }
        loaded.Context.DisposeRegistrations();
    }

    /// <summary>Registers every attribute-marked method on the script.</summary>
    public static void Wire(Script script, ScriptContext context)
    {
        IScriptRuntime runtime = context.Runtime;
        foreach (MethodInfo method in script.GetType().GetMethods(Members))
        {
            if (method.IsSpecialName) continue;

            foreach (EventAttribute attr in method.GetCustomAttributes<EventAttribute>())
            {
                var bound = HandlerBinder.Bind(method, script, runtime.Json, context.Binding);
                context.Track(runtime.Subscribe(context.Resource.Name, attr.Name, false, inv => bound(inv)));
            }
            foreach (NetEventAttribute attr in method.GetCustomAttributes<NetEventAttribute>())
            {
                var bound = HandlerBinder.Bind(method, script, runtime.Json, context.Binding);
                context.Track(runtime.Subscribe(context.Resource.Name, attr.Name, true, inv => bound(inv)));
            }
            foreach (CommandAttribute attr in method.GetCustomAttributes<CommandAttribute>())
            {
                string name = attr.Name.TrimStart('/').ToLowerInvariant();
                var bound = CommandBinder.Bind(name, method, script, context.Binding, context.Log);
                context.Track(runtime.RegisterCommand(context.Resource.Name, new CommandRegistration(name, attr.Permission, attr.Help, bound)));
            }
            if (method.GetCustomAttribute<TickAttribute>() is { } tick)
            {
                if (method.GetParameters().Length > 0)
                {
                    throw new InvalidOperationException($"[Tick] method {script.GetType().Name}.{method.Name} can't have parameters.");
                }
                script.Timers.Every(tick.Interval, () => HandlerBinder.InvokeAsync(method, script, []));
            }
            if (method.GetCustomAttribute<ExportAttribute>() is { } export)
            {
                var bound = HandlerBinder.Bind(method, script, runtime.Json, context.Binding);
                context.Track(runtime.RegisterExport(context.Resource.Name, export.Name ?? method.Name, bound));
            }
        }
    }

    private static IEnumerable<Type> SafeGetTypes(Assembly assembly)
    {
        try
        {
            return assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            return ex.Types.Where(t => t is not null)!;
        }
    }
}
