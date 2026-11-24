// Runs C# resources in a ProjectVI.ScriptHost child process and connects it to the server core.
// If the host crashes it's restarted with backoff, and its resources start again.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { JsonRpcPeer } = require("../rpc");

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST_DIR = path.resolve(__dirname, "..", "..", "..", "scripting", "dotnet", "artifacts", "publish", "ProjectVI.ScriptHost", "release");

// Finds the script host: an explicit path from server.toml, or the build in this repository.
// Returns { command, args } or null.
function findDotnetHost(configured) {
  const candidates = configured
    ? [path.resolve(configured)]
    : [path.join(DEFAULT_HOST_DIR, process.platform === "win32" ? "ProjectVI.ScriptHost.exe" : "ProjectVI.ScriptHost"), path.join(DEFAULT_HOST_DIR, "ProjectVI.ScriptHost.dll")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    return file.endsWith(".dll") ? { command: "dotnet", args: [file] } : { command: file, args: [] };
  }
  return null;
}

class DotnetRuntime {
  constructor({ host, core, log, waitForDebugger = false }) {
    this.name = "dotnet";
    this.host = host;
    this.core = core;
    this.log = log;
    this.waitForDebugger = waitForDebugger;
    this.resources = new Map(); // name -> start params, so they can restart after a crash
    this.child = null;
    this.rpc = null;
    this.ready = null;
    this.stopping = false;
    this.crashes = 0;
    core.addRuntime(this);
  }

  ensureStarted() {
    if (!this.ready) this.ready = this.launch();
    return this.ready;
  }

  async launch() {
    const args = [...this.host.args, "--side", "server"];
    if (this.waitForDebugger) args.push("--wait-for-debugger");
    const child = spawn(this.host.command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;

    const rpc = new JsonRpcPeer(child.stdout, child.stdin, { onDiagnostic: (m) => this.log.warn(`[C# host] ${m}`) });
    this.rpc = rpc;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.log.warn(`[C# host] ${line}`);
    });

    const core = this.core;
    rpc.onNotification("log", ({ resource, level, message }) => this.log.script(resource || "C#", level, message));
    rpc.onNotification("event/subscribe", ({ name, network }) => core.bus.subscribe(this, name, Boolean(network)));
    rpc.onNotification("event/unsubscribe", ({ name, network }) => core.bus.unsubscribe(this, name, Boolean(network)));
    rpc.onNotification("event/emit", ({ name, target, args }) => core.bus.emit(name, Array.isArray(args) ? args : [], { target }));
    rpc.onNotification("command/register", (p) => core.registerCommand(this, p));
    rpc.onNotification("command/unregister", (p) => core.unregisterCommand(this, p));
    rpc.onNotification("export/register", (p) => core.registerExport(this, p));
    rpc.onNotification("export/unregister", (p) => core.unregisterExport(this, p));
    rpc.onRequest("export/call", ({ resource, name, args }) => core.callExport(resource, name, Array.isArray(args) ? args : []));
    rpc.onRequest("native/call", ({ resource, name, args }) => core.callNative(resource, name, Array.isArray(args) ? args : []));

    child.on("exit", (code) => this.onExit(code));
    child.on("error", (err) => this.log.error(`Couldn't start the C# script host: ${err.message}`));

    const timeoutMs = this.waitForDebugger ? 10 * 60_000 : 30_000;
    const info = await rpc.request("initialize", {
      protocol: PROTOCOL_VERSION,
      side: "server",
      server: core.info,
      players: core.players.list().map((p) => core.players.snapshot(p))
    }, { timeoutMs });
    this.log.info(`C# scripting ready (SDK ${info.sdkVersion}, host process ${info.pid}).`);
    return info;
  }

  async startResource({ name, dir, assemblies, config }) {
    await this.ensureStarted();
    this.resources.set(name, { name, dir, assemblies, config });
    try {
      return await this.rpc.request("resource/start", { name, dir, assemblies, config: config ?? {} });
    } catch (err) {
      this.resources.delete(name);
      throw err;
    }
  }

  async stopResource(name) {
    this.resources.delete(name);
    if (!this.rpc || this.rpc.closed) return;
    await this.rpc.request("resource/stop", { name });
  }

  dispatch(name, args, { network = false, source } = {}) {
    if (!this.rpc || this.rpc.closed) return;
    this.rpc.notify("event/dispatch", { name, args, network, source: source ?? null });
  }

  playerJoined(snapshot) {
    if (this.rpc && !this.rpc.closed) this.rpc.notify("player/joined", { player: snapshot });
  }

  playerLeft(id) {
    if (this.rpc && !this.rpc.closed) this.rpc.notify("player/left", { id });
  }

  invokeCommand(name, source, args) {
    return this.rpc.request("command/invoke", { name, source, args });
  }

  invokeExport(resource, name, args) {
    return this.rpc.request("export/invoke", { resource, name, args });
  }

  async onExit(code) {
    this.rpc?.close("The C# script host stopped.");
    this.core.forgetRuntime(this);
    this.ready = null;
    if (this.stopping) return;

    this.crashes += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes - 1));
    this.log.error(`The C# script host stopped unexpectedly (exit code ${code}). Restarting in ${delay / 1000} s.`);
    setTimeout(async () => {
      const toRestart = [...this.resources.values()];
      this.resources.clear();
      for (const resource of toRestart) {
        try {
          await this.startResource(resource);
          this.log.info(`Restarted ${resource.name}.`);
        } catch (err) {
          this.log.error(`Couldn't restart ${resource.name}: ${err.message}`);
        }
      }
    }, delay).unref();
  }

  async stop() {
    this.stopping = true;
    if (!this.child || this.child.exitCode !== null) return;
    try {
      await this.rpc.request("shutdown", {}, { timeoutMs: 10_000 });
    } catch {
      // fall through to kill
    }
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { DotnetRuntime, findDotnetHost, PROTOCOL_VERSION };
