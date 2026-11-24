using System.Text;

namespace ProjectVI.ScriptHost;

/// <summary>
/// Replaces Console.Out and Console.Error, because the real stdout carries protocol frames.
/// Each line a script prints becomes a log message tagged with the resource that printed it.
/// </summary>
internal sealed class ConsoleRedirect(HostRuntime runtime, LogLevel level) : TextWriter
{
    private readonly StringBuilder line = new();
    private readonly Lock gate = new();

    public override Encoding Encoding => Encoding.UTF8;

    public override void Write(char value)
    {
        string? complete = null;
        lock (gate)
        {
            if (value == '\n')
            {
                complete = line.ToString().TrimEnd('\r');
                line.Clear();
            }
            else
            {
                line.Append(value);
            }
        }
        if (complete is not null)
        {
            runtime.Log(HostRuntime.CurrentResource.Value, level, complete);
        }
    }

    public override void Write(string? value)
    {
        foreach (char c in value ?? "")
        {
            Write(c);
        }
    }

    public override void WriteLine(string? value)
    {
        Write(value);
        Write('\n');
    }
}
