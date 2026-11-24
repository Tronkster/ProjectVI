using System.Text.Json;

namespace ProjectVI.Runtime;

/// <summary>
/// Everything one resource's scripts share: runtime, log, config, side bindings,
/// and every registration to undo when the resource stops.
/// </summary>
internal sealed class ScriptContext(IScriptRuntime runtime, ResourceInfo resource, ISideBinding binding, JsonElement config = default)
{
    private readonly List<IDisposable> registrations = [];
    private readonly CancellationTokenSource stopping = new();

    public IScriptRuntime Runtime { get; } = runtime;
    public ResourceInfo Resource { get; } = resource;
    public ISideBinding Binding { get; } = binding;
    public JsonElement Config { get; } = config;
    public ILog Log { get; } = runtime.CreateLog(resource.Name);

    /// <summary>Cancelled when the resource stops, so timers and delays end with it.</summary>
    public CancellationToken Stopping => stopping.Token;

    /// <summary>Remembers something to dispose when the resource stops, and returns it.</summary>
    public IDisposable Track(IDisposable registration)
    {
        registrations.Add(registration);
        return registration;
    }

    /// <summary>Cancels timers and undoes every registration, newest first. Never throws.</summary>
    public void DisposeRegistrations()
    {
        stopping.Cancel();
        for (int i = registrations.Count - 1; i >= 0; i--)
        {
            try
            {
                registrations[i].Dispose();
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Cleaning up a registration failed");
            }
        }
        registrations.Clear();
    }
}

/// <summary>Disposable that runs an action once.</summary>
internal sealed class Disposable(Action action) : IDisposable
{
    private Action? action = action;

    public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
}
