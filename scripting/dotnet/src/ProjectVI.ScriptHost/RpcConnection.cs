using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace ProjectVI.ScriptHost;

/// <summary>Error returned to the other side of a JSON-RPC call.</summary>
internal sealed class RpcException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// JSON-RPC 2.0 over newline-delimited UTF-8 JSON. One frame per line, at most 1 MB.
/// Requests are handled concurrently; notifications run in the order they arrive.
/// </summary>
internal sealed class RpcConnection(Stream input, Stream output, JsonSerializerOptions json, Action<string> diagnostics)
{
    public const int MaxFrameBytes = 1024 * 1024;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int ScriptError = -32000;

    private readonly Lock writeLock = new();
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> pending = new();
    private readonly Dictionary<string, Func<JsonElement, Task<object?>>> requestHandlers = [];
    private readonly Dictionary<string, Action<JsonElement>> notificationHandlers = [];
    private long nextId;

    public void OnRequest(string method, Func<JsonElement, Task<object?>> handler) => requestHandlers[method] = handler;

    public void OnNotification(string method, Action<JsonElement> handler) => notificationHandlers[method] = handler;

    public void Notify(string method, object? parameters) =>
        Write(new { jsonrpc = "2.0", method, @params = parameters });

    public Task<JsonElement> RequestAsync(string method, object? parameters)
    {
        long id = Interlocked.Increment(ref nextId);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = tcs;
        Write(new { jsonrpc = "2.0", id, method, @params = parameters });
        return tcs.Task;
    }

    /// <summary>Reads frames until the other side closes the stream.</summary>
    public async Task RunAsync()
    {
        using var reader = new StreamReader(input, new UTF8Encoding(false));
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.Length == 0)
            {
                continue;
            }
            if (Encoding.UTF8.GetByteCount(line) > MaxFrameBytes)
            {
                diagnostics("Dropped a protocol frame larger than 1 MB.");
                continue;
            }
            Handle(line);
        }
        foreach (var call in pending.Values)
        {
            call.TrySetException(new RpcException(ScriptError, "The connection closed."));
        }
    }

    private void Handle(string line)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(line);
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            Write(new { jsonrpc = "2.0", id = (object?)null, error = new { code = -32700, message = "Parse error" } });
            return;
        }

        bool hasId = root.TryGetProperty("id", out JsonElement id) && id.ValueKind != JsonValueKind.Null;
        if (root.TryGetProperty("method", out JsonElement methodElement) && methodElement.GetString() is { } method)
        {
            JsonElement parameters = root.TryGetProperty("params", out JsonElement p) ? p : default;
            if (hasId)
            {
                _ = HandleRequestAsync(id, method, parameters);
            }
            else if (notificationHandlers.TryGetValue(method, out var notify))
            {
                try
                {
                    notify(parameters);
                }
                catch (Exception ex)
                {
                    diagnostics($"Notification {method} failed: {ex.Message}");
                }
            }
            return;
        }

        if (hasId && id.TryGetInt64(out long responseId) && pending.TryRemove(responseId, out var call))
        {
            if (root.TryGetProperty("error", out JsonElement error))
            {
                int code = error.TryGetProperty("code", out JsonElement c) && c.TryGetInt32(out int n) ? n : ScriptError;
                string message = error.TryGetProperty("message", out JsonElement m) ? m.GetString() ?? "" : "";
                call.TrySetException(new RpcException(code, message));
            }
            else
            {
                call.TrySetResult(root.TryGetProperty("result", out JsonElement result) ? result : default);
            }
        }
    }

    private async Task HandleRequestAsync(JsonElement id, string method, JsonElement parameters)
    {
        if (!requestHandlers.TryGetValue(method, out var handler))
        {
            WriteError(id, MethodNotFound, $"Unknown method: {method}");
            return;
        }
        try
        {
            object? result = await handler(parameters);
            Write(new { jsonrpc = "2.0", id, result });
        }
        catch (RpcException ex)
        {
            WriteError(id, ex.Code, ex.Message);
        }
        catch (Exception ex)
        {
            WriteError(id, ScriptError, ex.Message);
        }
    }

    private void WriteError(JsonElement id, int code, string message) =>
        Write(new { jsonrpc = "2.0", id, error = new { code, message } });

    private void Write(object message)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message, json);
        lock (writeLock)
        {
            output.Write(bytes);
            output.WriteByte((byte)'\n');
            output.Flush();
        }
    }
}
