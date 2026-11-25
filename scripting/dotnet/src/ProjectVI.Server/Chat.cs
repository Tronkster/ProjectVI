using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>
/// Chat lines from the server, shown in players' chat as coming from the server (not from a player).
/// For a short message on one player's screen instead, use <see cref="Player.Notify"/>.
/// </summary>
public interface IChat
{
    /// <summary>Sends a chat line (up to 500 characters) to one player.</summary>
    Task SendAsync(Player player, string text);

    /// <summary>Sends a chat line (up to 500 characters) to everyone on the server.</summary>
    Task BroadcastAsync(string text);
}

internal sealed class ChatImpl(ScriptContext context) : IChat
{
    public Task SendAsync(Player player, string text)
    {
        ArgumentNullException.ThrowIfNull(player);
        ArgumentException.ThrowIfNullOrWhiteSpace(text);
        return context.Runtime.CallNativeAsync(context.Resource.Name, "chat.send", [player.Id, text]);
    }

    public Task BroadcastAsync(string text)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(text);
        return context.Runtime.CallNativeAsync(context.Resource.Name, "chat.send", [0, text]);
    }
}
