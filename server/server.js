// ProjectVI reference game server.
// Usage: npm start            (uses ./server.toml)
//        node server.js path/to/server.toml
//
// Serves resources to players' launchers, lists the server on the master server and runs
// resource scripts (C# through the ProjectVI script host). Type `help` in this window for commands.
// Player sync runs over UDP on the game port (src/sync.js). Until the ProjectVI client exists,
// use fake players to test scripts.

const path = require("node:path");
const { loadConfig } = require("./src/config");
const { buildContent } = require("./src/content");
const { createGameServer } = require("./src/http");
const { startHeartbeat } = require("./src/heartbeat");
const { createLog } = require("./src/log");
const { ServerCore } = require("./src/core/server-core");
const { ResourceStore } = require("./src/core/store");
const { ResourceManager } = require("./src/core/resources");
const { startConsole } = require("./src/core/console");
const { DotnetRuntime, findDotnetHost } = require("./src/runtimes/dotnet");
const { SyncServer } = require("./src/sync");
const { TicketVerifier } = require("./src/tickets");

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function main() {
  const configPath = path.resolve(process.argv[2] || "server.toml");
  const baseDir = path.dirname(configPath);
  const config = loadConfig(configPath);
  const log = createLog({ debug: process.env.PROJECTVI_DEBUG === "1" });
  const resourcesDir = path.join(baseDir, "resources");

  const content = await buildContent({
    resourcesDir,
    start: config.resources.start,
    cacheFile: path.join(baseDir, ".projectvi", "hash-cache.json")
  });
  for (const warning of content.warnings) log.warn(warning);
  log.info(`${content.manifest.resources.length} resources, ${content.fileCount} files for players (${formatBytes(content.totalBytes)}).`);

  const store = new ResourceStore(path.join(baseDir, ".projectvi", "store.db"));
  const core = new ServerCore({ config, log, store });
  core.world.start();
  const server = createGameServer({ config, content, getPlayers: () => core.players.list().length });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") log.error(`Port ${config.port} is already in use. Change [server] port in server.toml.`);
    else log.error(`Server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.bind, () => log.info(`"${config.name}" is running on port ${config.port}.`));

  let sync = null;
  let tickets = null;
  if (config.sync.enabled) {
    // Join tickets can only be checked on a listed server: the master server only issues them for servers on its list.
    tickets = config.master.public ? new TicketVerifier({ masterUrl: config.master.url, log }) : null;
    tickets?.loadKey();
    sync = new SyncServer({ core, log, maxPlayers: config.maxPlayers, tickets, ...config.sync });
    try {
      await sync.listen(config.port, config.bind);
      log.info(`Player sync on UDP port ${config.port}, ${config.sync.tickRate} updates a second.`);
    } catch (err) {
      log.error(err.code === "EADDRINUSE" ? `UDP port ${config.port} is already in use.` : `Player sync couldn't start: ${err.message}`);
      process.exit(1);
    }
  }

  // Scripting: the C# runtime starts only if a resource needs it.
  const dotnetHost = findDotnetHost(config.scripting.dotnetHost);
  const dotnet = dotnetHost ? new DotnetRuntime({ host: dotnetHost, core, log, waitForDebugger: config.scripting.waitForDebugger }) : null;
  const resources = new ResourceManager({ resourcesDir, core, log, getDotnet: () => dotnet });
  for (const name of config.resources.start) await resources.start(name);

  const stopHeartbeat = config.master.public
    ? startHeartbeat({
      config,
      log: log.info,
      getPlayers: () => core.players.list().length,
      onListed: (id) => {
        tickets?.setServerId(id);
        tickets?.loadKey(); // retried until the master server answers
      }
    })
    : null;
  if (!stopHeartbeat) log.info("Not listed on the master server ([master] public = false).");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info("Shutting down…");
    core.world.stop();
    await sync?.close();
    await resources.stopAll();
    await dotnet?.stop();
    await stopHeartbeat?.();
    store.close();
    // Let Node finish on its own once everything is closed; forcing exit while child-process
    // pipes are still closing trips a libuv assertion on Windows.
    process.stdin.destroy();
    server.closeAllConnections();
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  startConsole({ core, resources, log, onQuit: shutdown });
  log.info(`Type help for server commands.${config.scripting.dev ? " Dev mode is on: try fakeplayer add Kai." : ""}`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
