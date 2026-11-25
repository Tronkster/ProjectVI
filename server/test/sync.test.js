const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { SyncServer } = require("../src/sync");
const { ServerCore } = require("../src/core/server-core");
const { validateConfig } = require("../src/config");
const shared = require("@projectvi/shared");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function state(x, y = 0, extra = {}) {
  return { position: { x, y, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, vehicleModel: 0, seat: 0, ...extra };
}

async function startServer(options = {}) {
  const config = validateConfig({ server: { name: "Sync test", max_players: options.maxPlayers ?? 8 } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  // A manual clock and manual ticks keep the tests fast and deterministic.
  let clock = 1_000_000;
  const sync = new SyncServer({ core, log: quietLog, tickRate: 20, streamRadius: 100, timeoutSeconds: 5, maxPlayers: config.maxPlayers, now: () => clock, ...options });
  const port = await sync.listen(0, "127.0.0.1");
  clearInterval(sync.timer); // tests call step() themselves
  return { core, sync, port, advance: (ms) => (clock += ms), close: () => sync.close() };
}

// A pretend ProjectVI client: a UDP socket that keeps every decoded message it receives.
async function client(port) {
  const socket = dgram.createSocket("udp4");
  const inbox = [];
  const waiters = [];
  socket.on("message", (buf) => {
    const msg = shared.decodeSync(buf);
    if (!msg) return;
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const send = (buf) => new Promise((resolve) => socket.send(buf, port, "127.0.0.1", resolve));
  const next = (match, ms = 2000) => {
    const found = inbox.find(match);
    if (found) {
      inbox.splice(inbox.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => { clearTimeout(timer); inbox.splice(inbox.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("Timed out waiting for a sync message.")); }, ms);
      waiters.push(w);
    });
  };
  const of = (type) => (m) => m.type === type;
  return {
    send,
    next,
    of,
    inbox,
    async join(name, nonce = 1) {
      await send(shared.encodeHello({ nonce, name }));
      return next((m) => (m.type === shared.SYNC_MSG.WELCOME || m.type === shared.SYNC_MSG.REJECT) && m.nonce === nonce);
    },
    close: () => new Promise((resolve) => socket.close(resolve))
  };
}

// UDP on localhost is fast but asynchronous: give packets a moment to arrive.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("players join, see each other nearby and not far away", async () => {
  const s = await startServer();
  const a = await client(s.port);
  const b = await client(s.port);
  const c = await client(s.port);
  try {
    const wa = await a.join("Ana");
    const wb = await b.join("Ben");
    const wc = await c.join("Cyd");
    assert.equal(wa.type, shared.SYNC_MSG.WELCOME);
    assert.equal(wa.tickRate, 20);
    assert.equal(s.core.players.list().length, 3);

    await a.send(shared.encodeState({ session: wa.session, seq: 1, clientTime: 0, state: state(0) }));
    await b.send(shared.encodeState({ session: wb.session, seq: 1, clientTime: 0, state: state(50, 0, { heading: 450 }) }));
    await c.send(shared.encodeState({ session: wc.session, seq: 1, clientTime: 0, state: state(5000) })); // far away
    await settle();
    s.sync.step();

    const snapA = await a.next(a.of(shared.SYNC_MSG.SNAPSHOT));
    assert.deepEqual(snapA.entries.map((e) => e.playerId), [wb.playerId]);
    assert.equal(snapA.entries[0].state.heading, 90); // normalised by the server
    const snapC = await c.next(c.of(shared.SYNC_MSG.SNAPSHOT));
    assert.deepEqual(snapC.entries, []);

    // The core and scripts see the reported position.
    assert.deepEqual(s.core.callNative("test", "player.position", [wb.playerId]), { x: 50, y: 0, z: 10 });
    assert.equal(s.core.callNative("test", "player.state", [wb.playerId]).heading, 90);

    // The roster maps ids to names.
    await a.send(shared.encodeRosterRequest({ session: wa.session }));
    const roster = await a.next(a.of(shared.SYNC_MSG.ROSTER));
    assert.deepEqual(roster.players.map((p) => p.name).sort(), ["Ana", "Ben", "Cyd"]);
    assert.equal(roster.rosterVersion, snapA.rosterVersion);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    await s.close();
  }
});

test("a repeated HELLO gets the same session instead of a second player", async () => {
  const s = await startServer();
  const a = await client(s.port);
  try {
    const first = await a.join("Ana", 42);
    const again = await a.join("Ana", 42);
    assert.equal(again.session, first.session);
    assert.equal(s.core.players.list().length, 1);
  } finally {
    await a.close();
    await s.close();
  }
});

test("bad names and a full server are rejected", async () => {
  const s = await startServer({ maxPlayers: 1 });
  const a = await client(s.port);
  const b = await client(s.port);
  try {
    const bad = await a.join("x", 1);
    assert.equal(bad.type, shared.SYNC_MSG.REJECT);
    assert.match(bad.reason, /Name not allowed/);
    assert.equal((await a.join("Ana", 2)).type, shared.SYNC_MSG.WELCOME);
    const full = await b.join("Ben", 3);
    assert.equal(full.type, shared.SYNC_MSG.REJECT);
    assert.match(full.reason, /full/);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("states that are stale, impossible or from another address are ignored", async () => {
  const s = await startServer();
  const a = await client(s.port);
  const intruder = await client(s.port);
  try {
    const w = await a.join("Ana");
    const sendState = (who, seq, st) => who.send(shared.encodeState({ session: w.session, seq, clientTime: 0, state: st }));
    await sendState(a, 10, state(1));
    await sendState(a, 9, state(2)); // older sequence
    await sendState(a, 11, state(3, 0, { velocity: { x: 9999, y: 0, z: 0 } })); // too fast
    await sendState(a, 12, state(1e9)); // off the map
    await sendState(a, 13, state(NaN));
    await sendState(intruder, 14, state(4)); // right session, wrong address
    await settle();
    assert.equal(s.core.players.get(w.playerId).position.x, 1);
    await sendState(a, 15, state(5));
    await settle();
    assert.equal(s.core.players.get(w.playerId).position.x, 5);
  } finally {
    await Promise.all([a.close(), intruder.close()]);
    await s.close();
  }
});

test("silent players time out, BYE leaves, and a script kick reaches the client", async () => {
  const s = await startServer();
  const a = await client(s.port);
  const b = await client(s.port);
  const c = await client(s.port);
  try {
    const wa = await a.join("Ana");
    const wb = await b.join("Ben");
    const wc = await c.join("Cyd");

    await b.send(shared.encodeBye({ session: wb.session }));
    await settle();
    assert.equal(s.core.players.get(wb.playerId), undefined);

    s.core.callNative("test", "player.kick", [wc.playerId, "Testing"]);
    const kick = await c.next(c.of(shared.SYNC_MSG.KICK));
    assert.match(kick.reason, /Kicked: Testing/);
    assert.equal(s.sync.stats().players, 1);

    s.advance(6000);
    s.sync.step();
    const timeout = await a.next(a.of(shared.SYNC_MSG.KICK));
    assert.equal(timeout.reason, "Timed out");
    assert.equal(s.core.players.get(wa.playerId), undefined);
    assert.equal(s.core.players.list().length, 0);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    await s.close();
  }
});

test("more nearby players than fit in one packet are split across snapshots", async () => {
  const total = shared.SNAPSHOT_MAX_ENTRIES + 5;
  const s = await startServer({ maxPlayers: total + 1 });
  const viewer = await client(s.port);
  try {
    const wv = await viewer.join("Viewer", 1);
    await viewer.send(shared.encodeState({ session: wv.session, seq: 1, clientTime: 0, state: state(0) }));
    // One socket can't hold many sessions (sessions are per address), so add the crowd directly.
    for (let i = 0; i < total; i++) {
      const p = s.core.addPlayer({ name: `Bot${i}`, identifiers: [`test:${i}`] });
      s.sync.sessions.set(1000 + i, { session: 1000 + i, playerId: p.id, address: "127.0.0.1", port: 9, lastSeen: 1_000_000, lastSeq: 1, state: state(i % 50), budget: { second: 0, count: 0 } });
    }
    await settle();
    s.sync.step();
    const first = await viewer.next(viewer.of(shared.SYNC_MSG.SNAPSHOT));
    const second = await viewer.next(viewer.of(shared.SYNC_MSG.SNAPSHOT));
    assert.equal(first.entries.length + second.entries.length, total);
    assert.equal(first.tick, second.tick);
  } finally {
    await viewer.close();
    await s.close();
  }
});
