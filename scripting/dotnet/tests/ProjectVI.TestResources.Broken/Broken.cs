using ProjectVI.Server;

namespace ProjectVI.TestResources.Broken;

public sealed class BrokenOnStart : ServerScript
{
    protected override Task OnStart() => throw new InvalidOperationException("database is down");
}
