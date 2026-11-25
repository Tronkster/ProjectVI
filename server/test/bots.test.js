const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { SyncServer } = require("../src/sync");
const { ServerCore } = require("../src/core/server-core");
const { validateConfig } = require("../src/config");
const { createMover, createBot, headingOf } = require("../scripts/bots");
const { SyncClient } = require("@projectvi/shared/sync-client");
const { SYNC_FLAG } = require("@projectvi/shared");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// A real server on a real clock: these tests check the whole path, bot -> server -> another client.
async function startServer(streamRadius = 200) {
  const config = validateConfig({ server: { name: "Bots test", max_players: 8 } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const sync = new SyncServer({ core, log: quietLog, tickRate: 20, streamRadius, maxPlayers: config.maxPlayers });
  const port = await sync.listen(0, "127.0.0.1");
  return { core, sync, port };
}

// Repeatable "random" numbers.
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("heading follows the game's convention: 0 north, 90 west", () => {
  assert.equal(headingOf(0, 1), 0);
  assert.equal(headingOf(-1, 0), 90);
  assert.equal(headingOf(0, -1), 180);
  assert.equal(headingOf(1, 0), 270);
});

test("movers stay in their area at believable speeds", () => {
  const center = { x: 100, y: -50, z: 12 };
  for (const mode of ["walk", "drive", "idle"]) {
    const mover = createMover({ mode, center, spread: 80, random: seeded(7) });
    for (let i = 0; i < 2000; i++) {
      const s = mover.step(0.05);
      const away = Math.hypot(s.position.x - center.x, s.position.y - center.y);
      const speed = Math.hypot(s.velocity.x, s.velocity.y);
      assert.ok(away <= 80 + 1e-6, `${mode} wandered ${away} m away`);
      assert.equal(s.position.z, 12);
      if (mode === "walk") assert.ok(speed <= 5 && (speed === 0) === !(s.flags & SYNC_FLAG.ON_FOOT_MOVING));
      if (mode === "drive") assert.ok(speed >= 12 && speed <= 28 && s.flags === SYNC_FLAG.IN_VEHICLE && s.vehicleModel !== 0);
      if (mode === "idle") assert.equal(speed, 0);
      if (speed > 0) assert.ok(Math.abs(s.heading - headingOf(s.velocity.x, s.velocity.y)) < 1e-9);
    }
  }
});

test("bots join a real server and another client sees them, by name, close to where they are", async () => {
  const s = await startServer();
  const center = { x: 0, y: 0, z: 10 };
  // A bot walking east at a steady 5 m/s makes the expected view easy to check.
  const east = { x: 0, step(dt) { this.x += 5 * dt; return { position: { x: this.x, y: 0, z: 10 }, velocity: { x: 5, y: 0, z: 0 }, heading: 270, flags: SYNC_FLAG.ON_FOOT_MOVING, vehicleModel: 0, seat: 0 }; } };
  const bots = [
    createBot({ host: "127.0.0.1", port: s.port, name: "Walker", mover: east }),
    createBot({ host: "127.0.0.1", port: s.port, name: "Driver", mover: createMover({ mode: "drive", center, spread: 100, random: seeded(1) }) }),
    createBot({ host: "127.0.0.1", port: s.port, name: "Far", mover: createMover({ mode: "idle", center: { x: 5000, y: 0, z: 10 }, spread: 10, random: seeded(2) }) })
  ];
  const observer = new SyncClient({ host: "127.0.0.1", port: s.port, name: "Observer" });
  try {
    await Promise.all(bots.map((b) => b.start()));
    await observer.connect();
    const roster = once(observer, "roster");
    observer.sendState({ position: center, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, vehicleModel: 0, seat: 0 });
    await roster;
    await wait(600);
    observer.sendState({ position: center, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, vehicleModel: 0, seat: 0 });

    assert.equal(s.core.players.list().length, 4);
    const seen = new Map(observer.view().map((v) => [v.name, v.state]));
    assert.deepEqual([...seen.keys()].sort(), ["Driver", "Walker"]); // Far is outside the stream radius
    assert.ok(seen.get("Driver").flags & SYNC_FLAG.IN_VEHICLE);

    // The walker is drawn a little in the past: behind the real position, but not by much.
    const lag = bots[0].state.position.x - seen.get("Walker").position.x;
    assert.ok(lag >= -0.3 && lag <= 5 * 0.5, `walker drawn ${lag} m behind`);
    assert.ok(Math.abs(seen.get("Walker").position.y) < 1e-6);
    assert.equal(observer.stats.missedTicks, 0);
  } finally {
    await Promise.all([...bots.map((b) => b.stop()), observer.close()]);
    await s.sync.close();
  }
});

test("bots leave with BYE, and a bot turned away by a full server reports why", async () => {
  const s = await startServer();
  const bot = createBot({ host: "127.0.0.1", port: s.port, name: "Leaver", mover: createMover({ mode: "idle", center: { x: 0, y: 0, z: 0 }, spread: 10 }) });
  try {
    await bot.start();
    assert.equal(s.core.players.list().length, 1);
    await bot.stop();
    await wait(30);
    assert.equal(s.core.players.list().length, 0);

    s.sync.maxPlayers = 0;
    const late = createBot({ host: "127.0.0.1", port: s.port, name: "Late", mover: createMover({ mode: "idle", center: { x: 0, y: 0, z: 0 }, spread: 10 }) });
    await assert.rejects(late.start(), { code: "REJECTED", message: /full/ });
  } finally {
    await bot.stop();
    await s.sync.close();
  }
});
