using ProjectVI;
using ProjectVI.Server;

namespace ProjectVI.TestResources;

/// <summary>Answers test:greet with test:greeted.</summary>
public sealed class Greeter : ServerScript
{
    [Event("test:greet")]
    private void Greet(string name, int times = 1) => Events.Emit("test:greeted", string.Concat(Enumerable.Repeat($"Hello, {name}! ", times)).Trim());

    [Event("test:echoAsync")]
    private async Task EchoAsync(string text)
    {
        await Task.Delay(10); // continues on the script thread afterwards
        Events.Emit("test:echoed", text, Environment.CurrentManagedThreadId);
    }
}

/// <summary>Prints to the console, which must not corrupt the protocol stream.</summary>
public sealed class Printer : ServerScript
{
    protected override Task OnStart()
    {
        Console.WriteLine("printed from a script");
        Console.Error.WriteLine("printed to stderr from a script");
        return Task.CompletedTask;
    }
}

/// <summary>Its handler always throws; the others must keep working.</summary>
public sealed class Thrower : ServerScript
{
    [Event("test:greet")]
    private void Explode(string name) => throw new InvalidOperationException($"boom for {name}");
}

/// <summary>Only reacts to network events.</summary>
public sealed class NetListener : ServerScript
{
    [NetEvent("test:fromClient")]
    private void FromClient(int amount) => Events.Emit("test:fromClientSeen", amount);
}
