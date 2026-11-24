namespace ProjectVI;

/// <summary>
/// Runs the method when an event with this name is emitted on this side (by this or another resource,
/// or by the server core). Parameters are filled from the event's arguments, in order.
/// Clients can never trigger these; use <see cref="NetEventAttribute"/> for that.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class EventAttribute(string name) : Attribute
{
    /// <summary>Event name, for example <c>playerJoined</c> or <c>jobs:changed</c>.</summary>
    public string Name { get; } = name;
}

/// <summary>
/// Runs the method when the other side sends this event over the network.
/// On the server, mark a <c>Player</c> parameter with <see cref="FromSourceAttribute"/> to receive the sender.
/// Only methods marked with this attribute can be triggered from the network, and every argument
/// is converted to the declared parameter type, so a client can't send you something unexpected.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class NetEventAttribute(string name) : Attribute
{
    /// <summary>Event name, for example <c>jobs:clockIn</c>.</summary>
    public string Name { get; } = name;
}

/// <summary>
/// Registers the method as a chat or console command, for example <c>/job</c>. Parameters are filled from
/// what was typed. If the method returns a <c>string</c> (or <c>Task&lt;string&gt;</c>), it's shown to whoever ran the command.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class CommandAttribute(string name) : Attribute
{
    /// <summary>Command name without the slash.</summary>
    public string Name { get; } = name;

    /// <summary>Permission group a player needs, for example <c>admin</c>. Empty means everyone.</summary>
    public string Permission { get; init; } = "";

    /// <summary>One line shown in the command list.</summary>
    public string Help { get; init; } = "";
}

/// <summary>
/// Runs the method repeatedly. With no interval it runs every tick (on the client, once per frame).
/// The next run waits until the previous one has finished, so slow ticks never overlap.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class TickAttribute : Attribute
{
    /// <summary>Milliseconds between runs.</summary>
    public int Milliseconds { get; init; }

    /// <summary>Seconds between runs. Added to <see cref="Milliseconds"/>.</summary>
    public int Seconds { get; init; }

    internal TimeSpan Interval => TimeSpan.FromMilliseconds(Milliseconds) + TimeSpan.FromSeconds(Seconds);
}

/// <summary>
/// Fills this parameter with whoever caused the call instead of an argument: the player who sent a
/// net event or ran a command. From the server console it's null, so declare it as <c>Player?</c> if
/// the console may use the command; otherwise the console gets "can only be used by players".
/// </summary>
/// <example><code>[Command("myjob")] string MyJob([FromSource] Player player) => ...;</code></example>
[AttributeUsage(AttributeTargets.Parameter)]
public sealed class FromSourceAttribute : Attribute;

/// <summary>Lets other resources call this method, in any scripting language.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ExportAttribute(string? name = null) : Attribute
{
    /// <summary>Export name. Defaults to the method name.</summary>
    public string? Name { get; } = name;
}

/// <summary>Client only: binds the method to a key the player can change in settings.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class KeyMappingAttribute(string id, string description, string defaultKey) : Attribute
{
    /// <summary>Stable id, for example <c>clock_in</c>.</summary>
    public string Id { get; } = id;

    /// <summary>Shown to players in the key settings.</summary>
    public string Description { get; } = description;

    /// <summary>Default key, for example <c>F6</c>.</summary>
    public string DefaultKey { get; } = defaultKey;
}
