const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSettings } = require("../src/settings");
const { Bridge, readBridgeFile } = require("../src/bridge");
const { GameClient, toWireState } = require("../src/client");
const { startBridgeDouble, startGameServer, recordingLog, until } = require("./helpers");

const env = (extra = {}) => ({ PROJECTVI_SERVER: "127.0.0.1:30120", PROJECTVI_PLAYER: "Kai", PROJECTVI_BRIDGE_FILE: "C:\\b.json", ...extra });

test("settings come from the launcher's environment and are checked", () => {
  const ok = readSettings(env({ PROJECTVI_TICKET: "v1.abc.def" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.host, "127.0.0.1");
  assert.equal(ok.settings.port, 30120);
  assert.equal(ok.settings.ticket, "v1.abc.def");
  assert.equal(readSettings(env({ PROJECTVI_TICKET: "junk" })).settings.ticket, "");
  assert.equal(readSettings(env({ PROJECTVI_SERVER: "[::1]:30120" })).settings.host, "::1");
  assert.match(readSettings(env({ PROJECTVI_SERVER: "" })).error, /PROJECTVI_SERVER/);
  assert.match(readSettings(env({ PROJECTVI_SERVER: "x:99999" })).error, /port/);
  assert.match(readSettings(env({ PROJECTVI_PLAYER: "x" })).error, /PROJECTVI_PLAYER/);
  assert.match(readSettings(env({ PROJECTVI_BRIDGE_FILE: "" })).error, /BRIDGE/);
});

test("the bridge file is waited for and checked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-bf-"));
  const file = path.join(dir, "bridge.json");
  try {
    setTimeout(() => fs.writeFileSync(file, JSON.stringify({ bridge: 1, port: 1234, token: "a".repeat(64) })), 100);
    assert.deepEqual(await readBridgeFile(file, { timeoutMs: 2000, pollMs: 20 }), { port: 1234, token: "a".repeat(64), version: 1 });
    fs.writeFileSync(file, JSON.stringify({ port: 1234, token: "short" }));
    await assert.rejects(readBridgeFile(file, { timeoutMs: 100, pollMs: 20 }), (err) => err.code === "NO_BRIDGE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong token is refused by the bridge", async () => {
  const b = await startBridgeDouble({});
  try {
    const bridge = new Bridge({ port: b.port, token: "0".repeat(64) });
    await assert.rejects(bridge.connect(), (err) => err.code === "unauthorized");
  } finally {
    await b.close();
  }
});

test("with no game operations, the client joins, says what's missing, and reports nothing", async () => {
  const server = await startGameServer();
  const b = await startBridgeDouble({});
  const log = recordingLog();
  const bridge = new Bridge({ port: b.port, token: b.token });
  await bridge.connect();
  const client = new GameClient({ settings: { host: "127.0.0.1", port: 1, name: "Kai", ticket: "" }, bridge, log, fetchInfo: server.info });
  try {
    const joined = await client.start();
    assert.equal(server.core.players.list().length, 1);
    assert.ok(log.lines.some((l) => l.includes("can't do any game operations")));
    assert.ok(log.lines.some((l) => l.startsWith("warn Not available yet: reporting where you are")));
    for (let n = 1; n <= 5; n++) b.frame(n);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.core.players.get(joined.playerId).sync, undefined); // nothing made up
    assert.deepEqual(b.calls, []); // nothing called that the emulator didn't offer

    // The game exiting ends the session and leaves the server.
    b.exit(0);
    assert.match(await client.done, /exited/);
    await until(() => server.core.players.list().length === 0);
  } finally {
    await client.stop("test over");
    await b.close();
    await server.close();
  }
});

test("with the game operations, players see each other: one reports, the other places a character", async () => {
  const server = await startGameServer();
  let anaAt = { x: 10, y: 20, z: 30 };
  const ana = await startBridgeDouble({ "player.read": () => ({ position: anaAt, velocity: { x: 1, y: 0, z: 0 }, heading: 90, flags: 2, model: 0x1234, health: 200, armour: 0, weapon: 0, aim: { x: 0, y: 0, z: 0 }, vehicle: null, seat: 0 }) });
  let nextHandle = 100;
  const ben = await startBridgeDouble({
    "player.read": () => ({ position: { x: 0, y: 0, z: 30 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, model: 0, health: 200, armour: 0, weapon: 0, aim: { x: 0, y: 0, z: 0 }, vehicle: null, seat: 0 }),
    "ped.create": () => ({ handle: nextHandle++ }),
    "ped.update": () => null,
    "ped.delete": () => null
  });
  const clients = [];
  const start = async (b, name) => {
    const bridge = new Bridge({ port: b.port, token: b.token });
    await bridge.connect();
    const c = new GameClient({ settings: { host: "127.0.0.1", port: 1, name, ticket: "" }, bridge, log: recordingLog(), fetchInfo: server.info });
    clients.push(c);
    return [c, await c.start()];
  };
  try {
    const [, joinedAna] = await start(ana, "Ana");
    await start(ben, "Ben");
    let frame = 0;
    const frames = () => {
      ana.frame(++frame);
      ben.frame(frame);
    };
    // Ana's game reports her; the server has her where her game says.
    await until(() => server.core.players.get(joinedAna.playerId)?.sync?.position.x === 10, { every: frames });
    assert.equal(server.core.players.get(joinedAna.playerId).sync.heading, 90);

    // Ben's game is asked to create a character for Ana, then to move it.
    const created = await until(() => ben.calls.find((c) => c.op === "ped.create"), { every: frames });
    assert.equal(created.args.model, 0x1234);
    await until(() => ben.calls.some((c) => c.op === "ped.update" && c.args.name === "Ana"), { every: frames });
    anaAt = { x: 12, y: 20, z: 30 };
    await until(() => ben.calls.some((c) => c.op === "ped.update" && c.args.handle === 100 && c.args.state.position.x > 11), { every: frames, timeoutMs: 5000 });

    // Ana leaves: Ben's game removes her character.
    await clients[0].stop("leaving");
    await until(() => ben.calls.some((c) => c.op === "ped.delete" && c.args.handle === 100), { every: () => ben.frame(++frame), timeoutMs: 5000 });
  } finally {
    for (const c of clients) await c.stop("test over");
    await ana.close();
    await ben.close();
    await server.close();
  }
});

test("game state is turned into the sync protocol's state, with the vehicle id from the handle map", () => {
  const s = toWireState({ position: { x: 1, y: 2, z: 3 }, flags: 1 | 2, seat: 3 }, 0);
  assert.equal(s.flags, 2); // not in a vehicle the server knows: the in-vehicle flag is dropped
  assert.equal(s.seat, 0);
  const inCar = toWireState({ position: { x: 1, y: 2, z: 3 }, flags: 2, seat: 1 }, 7);
  assert.equal(inCar.flags, 3);
  assert.equal(inCar.vehicleId, 7);
  assert.equal(inCar.seat, 1);
});
