namespace ProjectVI;

/// <summary>Log levels, lowest to highest.</summary>
public enum LogLevel
{
    /// <summary>Details for script authors.</summary>
    Debug,
    /// <summary>Normal messages.</summary>
    Info,
    /// <summary>Something looks wrong but the script keeps going.</summary>
    Warning,
    /// <summary>Something failed.</summary>
    Error
}

/// <summary>Writes to the server console (or client log), tagged with the resource name.</summary>
public interface ILog
{
    /// <summary>Writes a message at the given level.</summary>
    void Write(LogLevel level, string message);

    /// <summary>Writes a debug message.</summary>
    void Debug(string message) => Write(LogLevel.Debug, message);

    /// <summary>Writes an info message.</summary>
    void Info(string message) => Write(LogLevel.Info, message);

    /// <summary>Writes a warning.</summary>
    void Warn(string message) => Write(LogLevel.Warning, message);

    /// <summary>Writes an error.</summary>
    void Error(string message) => Write(LogLevel.Error, message);

    /// <summary>Writes an error with the exception's details.</summary>
    void Error(Exception exception, string message) => Write(LogLevel.Error, $"{message}\n{exception}");
}
