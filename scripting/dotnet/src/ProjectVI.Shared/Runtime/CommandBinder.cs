using System.Globalization;
using System.Reflection;

namespace ProjectVI.Runtime;

/// <summary>
/// Binds command arguments (text the player typed) to a method's parameters.
/// Supported: string, numbers, bool, enums, a trailing <c>params string[]</c> for "the rest",
/// and whatever the side adds (players on the server). Problems become messages for whoever
/// ran the command, such as the usage line.
/// </summary>
internal static class CommandBinder
{
    public static Func<CommandInvocation, Task<string?>> Bind(string commandName, MethodInfo method, object? target, ISideBinding binding, ILog log)
    {
        ParameterInfo[] parameters = method.GetParameters();
        return async invocation =>
        {
            object?[] values = new object?[parameters.Length];
            int argIndex = 0;
            for (int i = 0; i < parameters.Length; i++)
            {
                ParameterInfo p = parameters[i];
                if (binding.TryResolveCommandSource(p, i, invocation, out object? source, out string? sourceError))
                {
                    if (sourceError is not null) return sourceError;
                    values[i] = source;
                    continue;
                }
                if (p.ParameterType == typeof(string[]) && p.IsDefined(typeof(ParamArrayAttribute)))
                {
                    values[i] = invocation.Args.Skip(argIndex).ToArray();
                    argIndex = invocation.Args.Count;
                    continue;
                }
                if (argIndex < invocation.Args.Count)
                {
                    string text = invocation.Args[argIndex++];
                    if (!TryConvert(p.ParameterType, text, binding, out object? value, out string? error))
                    {
                        return error ?? $"'{text}' isn't a valid {Friendly(p.ParameterType)} for <{p.Name}>. {Usage(commandName, parameters, binding, invocation)}";
                    }
                    values[i] = value;
                }
                else if (p.HasDefaultValue)
                {
                    values[i] = p.DefaultValue;
                }
                else
                {
                    return Usage(commandName, parameters, binding, invocation);
                }
            }

            try
            {
                // A command can return a string: it's shown to whoever ran the command.
                return await HandlerBinder.InvokeAsync(method, target, values) as string;
            }
            catch (Exception ex)
            {
                log.Error(ex, $"/{commandName} failed");
                return $"Something went wrong running /{commandName}.";
            }
        };
    }

    public static Func<CommandInvocation, Task<string?>> Bind(string commandName, Delegate handler, ISideBinding binding, ILog log) =>
        Bind(commandName, handler.Method, handler.Target, binding, log);

    private static bool TryConvert(Type type, string text, ISideBinding binding, out object? value, out string? error)
    {
        error = null;
        Type target = Nullable.GetUnderlyingType(type) ?? type;
        var culture = CultureInfo.InvariantCulture;
        switch (Type.GetTypeCode(target))
        {
            case TypeCode.String:
                value = text;
                return true;
            case TypeCode.Int32 when int.TryParse(text, NumberStyles.Integer, culture, out int i):
                value = i;
                return true;
            case TypeCode.Int64 when long.TryParse(text, NumberStyles.Integer, culture, out long l):
                value = l;
                return true;
            case TypeCode.Single when float.TryParse(text, NumberStyles.Float, culture, out float f):
                value = f;
                return true;
            case TypeCode.Double when double.TryParse(text, NumberStyles.Float, culture, out double d):
                value = d;
                return true;
            case TypeCode.Decimal when decimal.TryParse(text, NumberStyles.Number, culture, out decimal m):
                value = m;
                return true;
            case TypeCode.Boolean:
                value = text.ToLowerInvariant() switch { "true" or "yes" or "on" or "1" => true, "false" or "no" or "off" or "0" => false, _ => null };
                return value is not null;
        }
        if (target.IsEnum && Enum.TryParse(target, text, ignoreCase: true, out object? parsed) && Enum.IsDefined(target, parsed))
        {
            value = parsed;
            return true;
        }
        return binding.TryConvertCommandArgument(target, text, out value, out error) && error is null;
    }

    private static string Usage(string name, ParameterInfo[] parameters, ISideBinding binding, CommandInvocation invocation)
    {
        var parts = new List<string>();
        for (int i = 0; i < parameters.Length; i++)
        {
            ParameterInfo p = parameters[i];
            if (binding.TryResolveCommandSource(p, i, invocation, out _, out _)) continue;
            parts.Add(p.HasDefaultValue || p.IsDefined(typeof(ParamArrayAttribute)) ? $"[{p.Name}]" : $"<{p.Name}>");
        }
        return $"Usage: /{name} {string.Join(' ', parts)}".TrimEnd();
    }

    private static string Friendly(Type type) => (Nullable.GetUnderlyingType(type) ?? type) switch
    {
        var t when t == typeof(int) || t == typeof(long) => "whole number",
        var t when t == typeof(float) || t == typeof(double) || t == typeof(decimal) => "number",
        var t when t == typeof(bool) => "yes/no value",
        var t when t.IsEnum => $"choice ({string.Join(", ", Enum.GetNames(t).Select(n => n.ToLowerInvariant()))})",
        var t => t.Name.ToLowerInvariant()
    };
}
