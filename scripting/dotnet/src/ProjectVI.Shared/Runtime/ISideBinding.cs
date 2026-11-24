using System.Reflection;

namespace ProjectVI.Runtime;

/// <summary>
/// The side-specific part of argument binding: on the server, a <c>Player</c> parameter can be the
/// sender of a net event, the player who ran a command, or a player named in a command argument.
/// </summary>
internal interface ISideBinding
{
    /// <summary>Fills a parameter that doesn't come from event arguments (for example the sender).</summary>
    bool TryResolveEventParameter(ParameterInfo parameter, int position, EventInvocation invocation, out object? value);

    /// <summary>
    /// Fills a parameter that doesn't come from command arguments (the invoker). Sets
    /// <paramref name="error"/> if the command can't run, for example a player-only command from the console.
    /// </summary>
    bool TryResolveCommandSource(ParameterInfo parameter, int position, CommandInvocation invocation, out object? value, out string? error);

    /// <summary>Converts a typed command argument such as a player name or id. Returns false if the type isn't handled here.</summary>
    bool TryConvertCommandArgument(Type type, string text, out object? value, out string? error);
}

/// <summary>Binding with no side-specific parameters.</summary>
internal sealed class NoSideBinding : ISideBinding
{
    public static readonly NoSideBinding Instance = new();

    public bool TryResolveEventParameter(ParameterInfo parameter, int position, EventInvocation invocation, out object? value)
    {
        value = null;
        return false;
    }

    public bool TryResolveCommandSource(ParameterInfo parameter, int position, CommandInvocation invocation, out object? value, out string? error)
    {
        value = null;
        error = null;
        return false;
    }

    public bool TryConvertCommandArgument(Type type, string text, out object? value, out string? error)
    {
        value = null;
        error = null;
        return false;
    }
}
