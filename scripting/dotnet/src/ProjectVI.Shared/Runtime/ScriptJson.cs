using System.Text.Json;
using System.Text.Json.Serialization;

namespace ProjectVI.Runtime;

/// <summary>JSON settings for event and export arguments, so C# and other languages agree on the shape.</summary>
internal static class ScriptJson
{
    /// <summary>camelCase out, case-insensitive in, enums as strings. Sides add their own converters on top.</summary>
    public static JsonSerializerOptions CreateOptions(params JsonConverter[] converters)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            NumberHandling = JsonNumberHandling.Strict,
            MaxDepth = 32
        };
        options.Converters.Add(new JsonStringEnumConverter());
        foreach (JsonConverter converter in converters)
        {
            options.Converters.Add(converter);
        }
        return options;
    }
}
