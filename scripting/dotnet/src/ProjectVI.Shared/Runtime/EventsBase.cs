namespace ProjectVI.Runtime;

/// <summary>The <see cref="IEvents"/> part every side shares. Server and client SDKs add their network methods.</summary>
internal class EventsBase(ScriptContext context) : IEvents
{
    protected ScriptContext Context { get; } = context;

    public IDisposable On(string name, Delegate handler) => Subscribe(name, network: false, handler);

    public void Emit(string name, params object?[] args) => EmitTo(name, new EventTarget.Local(), args);

    protected void EmitTo(string name, EventTarget target, object?[] args)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        Context.Runtime.Emit(Context.Resource.Name, name, target, args);
    }

    protected IDisposable Subscribe(string name, bool network, Delegate handler)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(handler);
        var bound = HandlerBinder.Bind(handler, Context.Runtime.Json, Context.Binding);
        return Context.Track(Context.Runtime.Subscribe(Context.Resource.Name, name, network, inv => bound(inv)));
    }
}
