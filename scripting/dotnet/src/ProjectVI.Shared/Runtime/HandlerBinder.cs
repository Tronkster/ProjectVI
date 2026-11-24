using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text.Json;

namespace ProjectVI.Runtime;

/// <summary>
/// Turns a method plus incoming JSON arguments into a call with properly typed parameters, and
/// returns what the method returned (awaiting tasks). Used for events and exports.
/// Wrong argument counts or types throw <see cref="ArgumentException"/> with a readable message,
/// which matters for net events: a client must not be able to make a handler run with bad data.
/// </summary>
internal static class HandlerBinder
{
    public static Func<EventInvocation, Task<object?>> Bind(MethodInfo method, object? target, JsonSerializerOptions json, ISideBinding binding)
    {
        ParameterInfo[] parameters = method.GetParameters();
        string description = $"{method.DeclaringType?.Name}.{method.Name}";

        return async invocation =>
        {
            object?[] values = new object?[parameters.Length];
            int argIndex = 0;
            for (int i = 0; i < parameters.Length; i++)
            {
                ParameterInfo p = parameters[i];
                if (binding.TryResolveEventParameter(p, i, invocation, out object? resolved))
                {
                    values[i] = resolved;
                }
                else if (argIndex < invocation.Args.Count)
                {
                    values[i] = Convert(invocation.Args[argIndex++], p, json, description, invocation.Name);
                }
                else if (p.HasDefaultValue)
                {
                    values[i] = p.DefaultValue;
                }
                else
                {
                    throw new ArgumentException($"'{invocation.Name}' sent {invocation.Args.Count} argument(s), but {description} needs a value for '{p.Name}'.");
                }
            }
            return await InvokeAsync(method, target, values);
        };
    }

    public static Func<EventInvocation, Task<object?>> Bind(Delegate handler, JsonSerializerOptions json, ISideBinding binding) =>
        Bind(handler.Method, handler.Target, json, binding);

    /// <summary>Invokes and unwraps Task/ValueTask results, rethrowing the method's own exception.</summary>
    public static async Task<object?> InvokeAsync(MethodInfo method, object? target, object?[] values)
    {
        object? result;
        try
        {
            result = method.Invoke(target, values);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
        switch (result)
        {
            case Task task:
                await task;
                Type type = task.GetType();
                return type.IsGenericType && type.GetProperty("Result") is { } property && property.PropertyType.Name != "VoidTaskResult"
                    ? property.GetValue(task)
                    : null;
            case ValueTask valueTask:
                await valueTask;
                return null;
            default:
                return result;
        }
    }

    private static object? Convert(JsonElement element, ParameterInfo parameter, JsonSerializerOptions json, string description, string name)
    {
        try
        {
            return element.Deserialize(parameter.ParameterType, json);
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException or InvalidOperationException or ArgumentException)
        {
            throw new ArgumentException(
                $"'{name}': '{parameter.Name}' of {description} expects {parameter.ParameterType.Name}, but got {element.ValueKind}.", ex);
        }
    }
}
