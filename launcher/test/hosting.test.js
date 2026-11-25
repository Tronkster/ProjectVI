// Hosting runs the real game server (server/server.js) on this Node, with a stand-in for the router.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { HostManager, checkHostSettings, hostToml } = require("../src/main/hosting");
const { SyncClient } = require("@projectvi/shared/sync-client");

const SERVER_MAIN = path.join(__dirname, "..", "..", "server", "server.js");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

function fakeUpnp({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    openPort: async (port) => {
      calls.push(["open", port]);
      if (fail) throw new Error("No router answered a UPnP search. UPnP may be turned off on the router.");
      return { gateway: { controlUrl: "x" }, externalIp: "203.0.113.7" };
    },
    closePort: async (_gateway, port) => calls.push(["close", port])
  };
}

const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out.");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("host settings are checked, and the server config is written from them", () => {
  assert.equal(checkHostSettings({ name: "" })[1], "Give your server a name (1-64 characters).");
  assert.match(checkHostSettings({ name: "x", port: 80 })[1], /1024 to 65535/);
  assert.match(checkHostSettings({ name: "x", maxPlayers: 0 })[1], /1 to 128/);
  assert.match(checkHostSettings({ name: "x", requireTicket: true, listed: false })[1], /listed server/);
  const [s] = checkHostSettings({ name: 'Kai "the host"\n', port: 30200, maxPlayers: 4, mode: "Racing", listed: true, upnp: false });
  assert.deepEqual(s, { name: 'Kai "the host"', port: 30200, maxPlayers: 4, mode: "Racing", listed: true, upnp: false, requireTicket: false });
  const toml = hostToml(s, "http://localhost:30180");
  assert.match(toml, /name = "Kai \\"the host\\""/);
  assert.match(toml, /public = true/);
});

test("hosting starts the real server, opens the port, lets players join, and stops cleanly", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-host-"));
  const upnp = fakeUpnp();
  const host = new HostManager({ dataDir, serverMain: SERVER_MAIN, upnp, logger: { info() {}, warn() {} } });
  const port = await freePort();
  fs.mkdirSync(path.join(dataDir, "hosting", "resources", "mine"), { recursive: true });
  try {
    const result = await host.start({ name: "Kai's game", port, maxPlayers: 4, upnp: true }, { masterUrl: "http://127.0.0.1:9" });
    assert.deepEqual(result, { ok: true });
    await until(() => host.status().port.status === "open");
    const status = host.status();
    assert.equal(status.state, "running");
    assert.equal(status.shareAddress, `203.0.113.7:${port}`);
    assert.deepEqual(status.resources, ["mine"]);
    assert.ok(status.log.some((l) => l.includes(`is running on port ${port}`)));
    assert.deepEqual(upnp.calls, [["open", port]]);
    assert.match(fs.readFileSync(path.join(dataDir, "hosting", "server.toml"), "utf8"), /start = \["mine"\]/);

    // The host joins their own server through 127.0.0.1.
    assert.deepEqual(host.serverFor(`127.0.0.1:${port}`), { id: `127.0.0.1:${port}`, host: "127.0.0.1", port, name: "Kai's game" });
    assert.equal(host.serverFor("1.2.3.4:5"), undefined);
    const client = new SyncClient({ host: "127.0.0.1", port, name: "Kai", helloIntervalMs: 100 });
    client.on("error", () => {});
    await client.connect();
    await until(async () => {
      await host.refreshInfo();
      return host.status().players === 1;
    });
    await client.close();

    await host.stop();
    assert.equal(host.status().state, "stopped");
    assert.equal(host.status().error, "");
    assert.deepEqual(upnp.calls, [["open", port], ["close", port]]);
    assert.deepEqual(await host.start({ name: "x", port: 80 }, { masterUrl: "http://127.0.0.1:9" }), { ok: false, error: "The port must be a number from 1024 to 65535." });
  } finally {
    await host.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a port that's taken, or a router without UPnP, is reported plainly", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-host-"));
  const blocker = net.createServer();
  const port = await freePort();
  await new Promise((r) => blocker.listen(port, "0.0.0.0", r));
  const host = new HostManager({ dataDir, serverMain: SERVER_MAIN, upnp: fakeUpnp(), logger: { info() {}, warn() {} } });
  try {
    const result = await host.start({ name: "Busy", port }, { masterUrl: "http://127.0.0.1:9" });
    assert.equal(result.ok, false);
    assert.match(result.error, /in use/);
    assert.equal(host.status().state, "stopped");
  } finally {
    blocker.close();
  }

  const noRouter = new HostManager({ dataDir, serverMain: SERVER_MAIN, upnp: fakeUpnp({ fail: true }), logger: { info() {}, warn() {} } });
  const port2 = await freePort();
  try {
    assert.equal((await noRouter.start({ name: "Home", port: port2 }, { masterUrl: "http://127.0.0.1:9" })).ok, true);
    await until(() => noRouter.status().port.status === "failed");
    assert.match(noRouter.status().port.error, /UPnP may be turned off/);
    assert.equal(noRouter.status().shareAddress, "");
  } finally {
    await noRouter.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("odd server names survive the trip through server.toml", () => {
  const { parse } = require("smol-toml");
  const name = String.raw`Kai's "best" C:\game` + "\u0007\u0000 night";
  const [s] = checkHostSettings({ name, port: 30200 });
  const parsed = parse(hostToml(s, "http://localhost:30180"));
  assert.equal(parsed.server.name, String.raw`Kai's "best" C:\game night`);
  assert.equal(parsed.server.port, 30200);
  assert.equal(parsed.master.public, false);
});

test("the LAN address is a private IPv4 address", () => {
  const { lanIp } = require("../src/main/hosting");
  assert.equal(lanIp({ a: [{ family: "IPv4", internal: true, address: "127.0.0.1" }], b: [{ family: "IPv4", internal: false, address: "203.0.113.5" }], c: [{ family: "IPv4", internal: false, address: "192.168.1.20" }] }), "192.168.1.20");
  assert.equal(lanIp({ a: [{ family: "IPv4", internal: false, address: "172.20.0.4" }] }), "172.20.0.4");
  assert.equal(lanIp({ a: [{ family: "IPv4", internal: false, address: "172.32.0.4" }] }), "");
  assert.equal(lanIp({}), "");
});
