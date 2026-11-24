// Starts, stops and restarts resources, handing each one to the runtime for its language.

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("smol-toml");
const { readResourceMeta } = require("../resource-meta");
const { matchFiles } = require("../content");

class ResourceManager {
  constructor({ resourcesDir, core, log, getDotnet }) {
    this.resourcesDir = resourcesDir;
    this.core = core;
    this.log = log;
    this.getDotnet = getDotnet; // () => DotnetRuntime, or null when the host isn't available
    this.states = new Map(); // name -> "started" | "stopped" | "failed"
  }

  list() {
    return [...this.states.entries()].map(([name, state]) => ({ name, state }));
  }

  async start(name) {
    if (this.states.get(name) === "started") {
      this.log.info(`${name} is already running.`);
      return true;
    }
    const dir = path.join(this.resourcesDir, name);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || !fs.existsSync(dir)) {
      this.log.error(`There's no resource called ${name} in resources/.`);
      return false;
    }

    try {
      const meta = readResourceMeta(dir);
      const config = readConfig(dir);
      if (meta.dotnet.server.length > 0) {
        await this.startDotnet(name, dir, meta, config);
      }
      this.states.set(name, "started");
      this.core.bus.emit("resourceStarted", [name]);
      this.log.info(`Started ${name}.`);
      return true;
    } catch (err) {
      this.states.set(name, "failed");
      this.log.error(`Couldn't start ${name}: ${err.message}`);
      return false;
    }
  }

  async startDotnet(name, dir, meta, config) {
    const dotnet = this.getDotnet();
    if (!dotnet) {
      throw new Error("it has C# scripts, but the C# script host isn't built. Run `npm run build:scripting` (needs the .NET 10 SDK), or set [scripting] dotnet_host in server.toml.");
    }
    const files = matchFiles(dir, meta.dotnet.server);
    if (files.some((f) => f.endsWith(".cs"))) {
      throw new Error("loose .cs files aren't supported yet. Build the project and list its DLL instead.");
    }
    const assemblies = files.filter((f) => f.endsWith(".dll")).map((f) => path.join(dir, ...f.split("/")));
    if (assemblies.length === 0) {
      throw new Error(`no DLLs match [dotnet] server = ${JSON.stringify(meta.dotnet.server)}. Build the resource first.`);
    }
    await dotnet.startResource({ name, dir, assemblies, config });
  }

  async stop(name) {
    if (this.states.get(name) !== "started") {
      this.log.info(`${name} isn't running.`);
      return false;
    }
    this.core.bus.emit("resourceStopping", [name]);
    try {
      await this.getDotnet()?.stopResource(name);
    } catch (err) {
      this.log.error(`Stopping ${name} failed: ${err.message}`);
    }
    this.core.removeEntitiesOwnedBy(name);
    this.states.set(name, "stopped");
    this.log.info(`Stopped ${name}.`);
    return true;
  }

  async restart(name) {
    if (this.states.get(name) === "started") await this.stop(name);
    return this.start(name);
  }

  async stopAll() {
    for (const [name, state] of [...this.states.entries()].reverse()) {
      if (state === "started") await this.stop(name);
    }
  }
}

// config.toml next to resource.toml, as plain data for the script's Config.
function readConfig(dir) {
  const file = path.join(dir, "config.toml");
  if (!fs.existsSync(file)) return {};
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`config.toml isn't valid TOML: ${err.message}`, { cause: err });
  }
}

module.exports = { ResourceManager };
