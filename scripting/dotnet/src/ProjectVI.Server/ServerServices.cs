using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using ProjectVI.Runtime;

namespace ProjectVI.Server;

/// <summary>Facts about this server from <c>server.toml</c>.</summary>
public sealed record ServerInfo(string Name, int MaxPlayers, int Port);

/// <summary>Server-side state shared by every resource in one host: the player registry and server info.</summary>
internal sealed class ServerServices
{
    public ServerServices(IScriptRuntime runtime, ServerInfo info)
    {
        Info = info;
        Players = new PlayerRegistry(runtime);
        Binding = new ServerBinding(Players);
    }

    public ServerInfo Info { get; }
    public PlayerRegistry Players { get; }
    public ServerBinding Binding { get; }

    /// <summary>Converters for server types in event and export arguments.</summary>
    public static JsonConverter[] Converters(Func<PlayerRegistry?> registry) => [new PlayerConverter(registry)];
}

/// <summary>Players travel as {"$player": id, ...}. Only ids of connected players are accepted.</summary>
internal sealed class PlayerConverter(Func<PlayerRegistry?> registry) : JsonConverter<Player>
{
    public override Player? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        using var doc = JsonDocument.ParseValue(ref reader);
        JsonElement root = doc.RootElement;
        int id = root.ValueKind switch
        {
            JsonValueKind.Number => root.GetInt32(),
            JsonValueKind.Object when root.TryGetProperty("$player", out JsonElement p) => p.GetInt32(),
            _ => throw new JsonException("Expected a player.")
        };
        PlayerRegistry players = registry() ?? throw new JsonException("Players aren't available here.");
        return root.ValueKind == JsonValueKind.Object && root.TryGetProperty("name", out _)
            ? players.Upsert(root)
            : players.Get(id) ?? throw new JsonException($"There's no player with id {id}.");
    }

    public override void Write(Utf8JsonWriter writer, Player value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteNumber("$player", value.Id);
        writer.WriteEndObject();
    }
}

/// <summary>
/// Server rules for Player parameters: one marked [FromSource] is whoever sent the net event or ran the
/// command; any other Player comes from the arguments (JSON references, or a name/id typed in a command).
/// </summary>
internal sealed class ServerBinding(PlayerRegistry players) : ISideBinding
{
    public bool TryResolveEventParameter(ParameterInfo parameter, int position, EventInvocation invocation, out object? value)
    {
        value = null;
        if (!IsSource(parameter)) return false;
        value = invocation.Origin == EventOrigin.Network && invocation.SourcePlayerId is int id ? players.Get(id) : null;
        if (value is null && !IsNullable(parameter))
        {
            throw new ArgumentException($"'{invocation.Name}' has no sending player; declare '{parameter.Name}' as Player? to accept that.");
        }
        return true;
    }

    public bool TryResolveCommandSource(ParameterInfo parameter, int position, CommandInvocation invocation, out object? value, out string? error)
    {
        value = null;
        error = null;
        if (!IsSource(parameter)) return false;
        if (invocation.SourcePlayerId is int id && players.Get(id) is { } player)
        {
            value = player;
        }
        else if (!IsNullable(parameter))
        {
            error = $"/{invocation.Name} can only be used by players.";
        }
        return true;
    }

    private static bool IsSource(ParameterInfo parameter) =>
        parameter.IsDefined(typeof(FromSourceAttribute)) && parameter.ParameterType == typeof(Player);

    public bool TryConvertCommandArgument(Type type, string text, out object? value, out string? error)
    {
        value = null;
        error = null;
        if (type != typeof(Player)) return false;
        Player? player = int.TryParse(text, out int id) ? players.Get(id) : players.Find(text);
        if (player is null)
        {
            error = $"No player called '{text}' is online.";
        }
        value = player;
        return true;
    }

    private static bool IsNullable(ParameterInfo parameter) =>
        new NullabilityInfoContext().Create(parameter).WriteState == NullabilityState.Nullable;
}
