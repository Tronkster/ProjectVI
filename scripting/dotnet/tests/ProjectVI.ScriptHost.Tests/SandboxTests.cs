using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace ProjectVI.ScriptHost.Tests;

/// <summary>
/// Runs the probe inside the AppContainer and checks every escape route is closed.
/// These tests are the proof the client-script sandbox works; they only run on Windows.
/// </summary>
public sealed class SandboxTests
{
    [Fact]
    public async Task Sandboxed_program_can_only_read_what_it_was_given()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The AppContainer sandbox only exists on Windows.");

        string root = Directory.CreateTempSubdirectory("pvi-sandbox-").FullName;
        string granted = Directory.CreateDirectory(Path.Combine(root, "granted")).FullName;
        string forbidden = Directory.CreateDirectory(Path.Combine(root, "forbidden")).FullName;
        File.WriteAllText(Path.Combine(granted, "ok.txt"), "ok");
        File.WriteAllText(Path.Combine(forbidden, "secret.txt"), "secret");
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;

        try
        {
            var info = new ProcessStartInfo(Artifacts.File("ProjectVI.Sandbox", "projectvi-sandbox.exe"))
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            foreach (string arg in new[]
            {
                "--read", granted, "--memory-mb", "256", "--",
                Artifacts.File("ProjectVI.Sandbox.Probe", "ProjectVI.Sandbox.Probe.exe"),
                Path.Combine(granted, "ok.txt"), Path.Combine(forbidden, "secret.txt"), port.ToString(),
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            })
            {
                info.ArgumentList.Add(arg);
            }

            using var process = Process.Start(info)!;
            await process.StandardInput.WriteLineAsync("hello-from-parent");
            process.StandardInput.Close();
            var cancel = TestContext.Current.CancellationToken;
            string output = await process.StandardOutput.ReadToEndAsync(cancel);
            string errors = await process.StandardError.ReadToEndAsync(cancel);
            await process.WaitForExitAsync(cancel).WaitAsync(TimeSpan.FromSeconds(60), cancel);
            Assert.True(process.ExitCode == 0, $"Sandbox exited with {process.ExitCode}: {errors}");

            var results = JsonSerializer.Deserialize<Dictionary<string, string>>(output.Trim().Split('\n')[^1])!;
            Assert.Equal("hello-from-parent", results["stdin"]);
            Assert.Equal("allowed", results["grantedRead"]);
            foreach (string check in new[] { "forbiddenRead", "documents", "writeNextToProgram", "loopback", "internet", "startProcess" })
            {
                Assert.True(results[check].StartsWith("blocked"), $"{check} should be blocked but was: {results[check]}");
            }
        }
        finally
        {
            listener.Stop();
            Directory.Delete(root, recursive: true);
        }
    }
}
