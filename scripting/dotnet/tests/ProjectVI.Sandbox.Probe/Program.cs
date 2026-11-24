// Runs inside the sandbox in tests. Each check reports "allowed" or "blocked: <reason>".
// Usage: ProjectVI.Sandbox.Probe <granted-file> <forbidden-file> <loopback-port> [documents-folder]

using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json;

var results = new Dictionary<string, string>
{
    ["stdin"] = Console.ReadLine() ?? "(end of input)",
    ["grantedRead"] = Try(() => File.ReadAllText(args[0])),
    ["forbiddenRead"] = Try(() => File.ReadAllText(args[1])),
    ["documents"] = Try(() => Directory.GetFiles(args.Length > 3 ? args[3] : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments))),
    ["writeNextToProgram"] = Try(() => File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "written.txt"), "x")),
    ["loopback"] = Try(() => Connect("127.0.0.1", int.Parse(args[2]))),
    ["internet"] = Try(() => Connect("1.1.1.1", 443)),
    ["startProcess"] = Try(() => Process.Start(new ProcessStartInfo("cmd.exe", "/c exit") { UseShellExecute = false })?.WaitForExit()),
};
Console.WriteLine(JsonSerializer.Serialize(results));
return 0;

static string Try(Action action)
{
    try
    {
        action();
        return "allowed";
    }
    catch (Exception ex)
    {
        return $"blocked: {ex.GetType().Name}";
    }
}

static void Connect(string host, int port)
{
    using var client = new TcpClient();
    if (!client.ConnectAsync(host, port).Wait(TimeSpan.FromSeconds(3)))
    {
        throw new TimeoutException();
    }
}
