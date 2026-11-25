// Hosting a game from the launcher: runs the ProjectVI game server on this PC (on the launcher's own Node), so a
// player can play with friends without renting a server. The player joins it through 127.0.0.1; friends join
// through the public address, which needs the port open on the router (UPnP, or by hand).
//
// Files: <data>/hosting/server.toml (rewritten on each start) and <data>/hosting/resources/ (the player's own
// resources; empty at first). The server keeps its saved data in <data>/hosting/.projectvi/.
//
// No Electron imports: the server entry, Node path and UPnP are passed in, so this is testable.

const { fork } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_LOG_LINES = 300;
const INFO_EVERY_MS = 5000;
const MODES = ["Roleplay", "Racing", "Freeroam", "Other"];

// A TOML basic string: control characters dropped, backslashes and quotes escaped.
const tomlString = (s) => `"${[...String(s)].filter((c) => c.charCodeAt(0) >= 0x20).join("").replace(/[\\"]/g, (c) => `\\${c}`)}"`;
// Colour codes in the server's console output: ESC [ ... m.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Checks what the player typed. Returns [settings, null] or [null, message].
function checkHostSettings(raw = {}) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 64) return [null, "Give your server a name (1-64 characters)."];
  const port = Number(raw.port ?? 30120);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return [null, "The port must be a number from 1024 to 65535."];
  const maxPlayers = Number(raw.maxPlayers ?? 8);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 128) return [null, "Players must be a number from 1 to 128."];
  const mode = MODES.includes(raw.mode) ? raw.mode : "Freeroam";
  if (raw.requireTicket === true && raw.listed !== true) {
    return [null, "Verified players only works on a listed server: the master server only issues join tickets for servers on its list."];
  }
  return [{ name, port, maxPlayers, mode, listed: raw.listed === true, upnp: raw.upnp !== false, requireTicket: raw.requireTicket === true }, null];
}

function hostToml(settings, masterUrl) {
  return `# Written by the ProjectVI launcher each time you host. Change these in the launcher's Host page.

[server]
name = ${tomlString(settings.name)}
port = ${settings.port}
max_players = ${settings.maxPlayers}
gamemode = ${tomlString(settings.mode)}

[master]
url = ${tomlString(masterUrl)}
public = ${settings.listed}

[sync]
require_ticket = ${settings.requireTicket}

[resources]
# Folders in resources/ next to this file, started in this order. The launcher starts every folder it finds.
start = []
`;
}

// Resource folders the player put in resources/, in name order.
function resourceFolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Events: "status" (status()), whenever anything changes.
class HostManager extends EventEmitter {
  // serverMain: the game server's server.js. nodePath: a Node to run it with. upnp: { openPort, closePort }.
  constructor({ dataDir, serverMain, nodePath = process.execPath, upnp, logger, fetchInfo = defaultFetchInfo }) {
    super();
    this.dir = path.join(dataDir, "hosting");
    this.serverMain = serverMain;
    this.nodePath = nodePath;
    this.upnp = upnp;
    this.logger = logger;
    this.fetchInfo = fetchInfo;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping
    this.settings = null;
    this.error = "";
    this.lines = [];
    this.masterId = ""; // the id the master server knows us by (when listed)
    this.players = 0;
    this.port = { status: "off", externalIp: null, error: "" }; // UPnP: off | opening | open | failed
    this.gateway = null;
    this.timer = null;
  }

  get resourcesDir() {
    return path.join(this.dir, "resources");
  }

  // The local address this PC joins its own server at.
  get localId() {
    return this.settings ? `127.0.0.1:${this.settings.port}` : "";
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      settings: this.settings,
      localId: this.localId,
      masterId: this.masterId,
      players: this.players,
      port: { ...this.port },
      shareAddress: this.port.externalIp && this.settings ? `${this.port.externalIp}:${this.settings.port}` : "",
      // For friends on the same home network, which works without opening any port.
      lanAddress: this.state === "running" && lanIp() ? `${lanIp()}:${this.settings.port}` : "",
      resources: resourceFolders(this.resourcesDir),
      log: this.lines.slice(-100)
    };
  }

  changed() {
    this.emit("status", this.status());
  }

  // For joining: a server entry for our own server, or undefined.
  serverFor(id) {
    if (this.state !== "running" || id !== this.localId) return undefined;
    return { id, host: "127.0.0.1", port: this.settings.port, name: this.settings.name };
  }

  // The server id to ask the master server for a join ticket with, when joining our own server.
  ticketIdFor(id) {
    return id === this.localId && this.masterId ? this.masterId : id;
  }

  async start(raw, { masterUrl }) {
    if (this.state !== "stopped") return { ok: false, error: "Already hosting." };
    const [settings, error] = checkHostSettings(raw);
    if (error) return { ok: false, error };
    this.settings = settings;
    this.error = "";
    this.lines = [];
    this.masterId = "";
    this.players = 0;
    this.state = "starting";
    this.changed();

    fs.mkdirSync(this.resourcesDir, { recursive: true });
    const tomlFile = path.join(this.dir, "server.toml");
    const toml = hostToml(settings, masterUrl).replace("start = []", `start = ${JSON.stringify(resourceFolders(this.resourcesDir))}`);
    fs.writeFileSync(tomlFile, toml);

    const child = fork(this.serverMain, [tomlFile], {
      execPath: this.nodePath,
      cwd: this.dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true
    });
    this.child = child;
    const onLine = (line) => this.onLine(line);
    lines(child.stdout, onLine);
    lines(child.stderr, onLine);
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      clearInterval(this.timer);
      const unexpected = this.state !== "stopping";
      this.state = "stopped";
      if (unexpected) this.error = this.error || `The server stopped (exit code ${code}). Its last lines are below.`;
      this.releasePort();
      this.changed();
    });

    const ready = await new Promise((resolve) => {
      const check = () => {
        if (this.state === "running") return resolve(true);
        if (this.state === "stopped") return resolve(false);
        setTimeout(check, 50);
      };
      check();
    });
    if (!ready) return { ok: false, error: this.error };

    this.timer = setInterval(() => this.refreshInfo(), INFO_EVERY_MS);
    this.refreshInfo();
    if (settings.upnp) this.openPort();
    return { ok: true };
  }

  onLine(raw) {
    const line = raw.replace(ANSI, "").trimEnd();
    if (!line || /ExperimentalWarning|--trace-warnings/.test(line)) return;
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    if (/is running on port \d+/.test(line) && this.state === "starting") this.state = "running";
    const known = /knows this server as (\S+?);/.exec(line);
    if (known) this.masterId = known[1];
    if (/already in use/i.test(line)) this.error = `Port ${this.settings.port} is in use. Pick another port.`;
    this.changed();
  }

  async refreshInfo() {
    if (this.state !== "running") return;
    try {
      const info = await this.fetchInfo(this.settings.port);
      if (Number.isInteger(info.players) && info.players !== this.players) {
        this.players = info.players;
        this.changed();
      }
    } catch {
      // the next try will do
    }
  }

  async openPort() {
    this.port = { status: "opening", externalIp: null, error: "" };
    this.changed();
    try {
      const { gateway, externalIp } = await this.upnp.openPort(this.settings.port);
      if (this.state !== "running") return this.upnp.closePort(gateway, this.settings.port);
      this.gateway = gateway;
      this.port = { status: "open", externalIp, error: "" };
      this.logger?.info("Opened the hosting port with UPnP", { port: this.settings.port });
    } catch (err) {
      this.port = { status: "failed", externalIp: null, error: err.message };
      this.logger?.warn("Couldn't open the hosting port with UPnP", { error: err.message });
    }
    this.changed();
  }

  releasePort() {
    if (this.gateway && this.settings) {
      const gateway = this.gateway;
      this.gateway = null;
      this.upnp.closePort(gateway, this.settings.port).catch(() => {});
    }
    if (this.port.status !== "off") this.port = { status: "off", externalIp: null, error: "" };
  }

  // Stops the server the way its console does ("quit"), so it signs off the master server and saves.
  async stop() {
    const child = this.child;
    if (!child || this.state === "stopping") return { ok: true };
    this.state = "stopping";
    this.changed();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.write("quit\n");
    const timeout = setTimeout(() => child.kill(), 8000);
    await exited;
    clearTimeout(timeout);
    return { ok: true };
  }
}

// This PC's address on its local network: the first private IPv4 address, or "".
function lanIp(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
    }
  }
  return "";
}

function lines(stream, fn) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      fn(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  });
}

async function defaultFetchInfo(port) {
  const res = await fetch(`http://127.0.0.1:${port}/projectvi/info`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}

module.exports = { HostManager, checkHostSettings, hostToml, resourceFolders, lanIp };
