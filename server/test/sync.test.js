const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { SyncServer } = require("../src/sync");
const { ServerCore } = require("../src/core/server-core");
const { validateConfig } = require("../src/config");
const shared = require("@projectvi/shared");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function state(x, y = 0, extra = {}) {
  return { position: { x, y, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, model: 0, health: 200, armour: 0, weapon: 0, aim: { x: 0, y: 0, z: 0 }, vehicleId: 0, seat: 0, ...extra };
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

function vehicle(x, y = 0, extra = {}) {
  return { model: shared.joaat("sultan"), position: { x, y, z: 10 }, rotation: shared.quatFromHeading(90), velocity: { x: 0, y: 0, z: 0 }, health: 1000, steering: 0, flags: 0, ...extra };
}

test("a client registers a vehicle by local id, reports it, and others see it with its controller", async () => {
  const s = await startServer();
  const a = await client(s.port);
  const b = await client(s.port);
  try {
    const wa = await a.join("Ana");
    const wb = await b.join("Ben");
    await a.send(shared.encodeState({ session: wa.session, seq: 1, clientTime: 0, state: state(0) }));
    await b.send(shared.encodeState({ session: wb.session, seq: 1, clientTime: 0, state: state(50) }));

    // A lost VEHICLE_ASSIGN is fixed by the next packet, which gets the same id.
    await a.send(shared.encodeVehicleState({ session: wa.session, seq: 1, vehicleId: 0, localId: 3, state: vehicle(10) }));
    const assign = await a.next(a.of(shared.SYNC_MSG.VEHICLE_ASSIGN));
    await a.send(shared.encodeVehicleState({ session: wa.session, seq: 2, vehicleId: 0, localId: 3, state: vehicle(11) }));
    assert.equal((await a.next(a.of(shared.SYNC_MSG.VEHICLE_ASSIGN))).vehicleId, assign.vehicleId);
    assert.equal(assign.localId, 3);
    assert.equal(s.sync.stats().vehicles, 1);

    // Scripts see it like any other entity, with the model as a hash string.
    const [listed] = s.core.callNative("test", "entities.list", []);
    assert.deepEqual(listed, { id: assign.vehicleId, kind: "vehicle", model: "0x39da2754", position: { x: 11, y: 0, z: 10 }, heading: 90 });

    const report = (who, session, seq, st) => who.send(shared.encodeVehicleState({ session, seq, vehicleId: assign.vehicleId, localId: 0, state: st }));
    await report(b, wb.session, 50, vehicle(99)); // not Ben's to report
    await report(a, wa.session, 3, vehicle(20, 0, { steering: 1 }));
    await report(a, wa.session, 2, vehicle(30)); // older
    await report(a, wa.session, 4, vehicle(40, 0, { rotation: { x: 0, y: 0, z: 0, w: 0 } })); // not a rotation
    await settle();
    s.sync.step();

    const seen = await b.next(b.of(shared.SYNC_MSG.VEHICLES));
    assert.equal(seen.entries.length, 1);
    assert.equal(seen.entries[0].vehicleId, assign.vehicleId);
    assert.equal(seen.entries[0].controller, wa.playerId);
    assert.equal(seen.entries[0].state.position.x, 20);
    assert.equal(seen.entries[0].state.steering, 1);
    assert.equal(seen.entries[0].state.model, shared.joaat("sultan"));
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("the driver controls a vehicle; an empty one stays with its controller nearby, then goes to the nearest player", async () => {
  const s = await startServer({ vehicleHandover: 60 });
  const a = await client(s.port);
  const b = await client(s.port);
  try {
    const wa = await a.join("Ana");
    const wb = await b.join("Ben");
    let seqA = 0;
    let seqB = 0;
    const moveA = (st) => a.send(shared.encodeState({ session: wa.session, seq: ++seqA, clientTime: 0, state: st }));
    const moveB = (st) => b.send(shared.encodeState({ session: wb.session, seq: ++seqB, clientTime: 0, state: st }));
    const { id } = s.core.callNative("test", "entities.spawnVehicle", ["sultan", { x: 0, y: 0, z: 10 }, 0]);
    const controller = () => s.core.entities.get(id).controller;

    await moveA(state(5));
    await moveB(state(40));
    await settle();
    s.sync.step();
    assert.equal(controller(), wa.playerId); // nearest

    const driving = { flags: shared.SYNC_FLAG.IN_VEHICLE, vehicleId: id, seat: 0 };
    await moveB(state(0, 0, driving));
    await settle();
    await moveA(state(0, 0, driving)); // the seat is taken
    await settle();
    s.sync.step();
    assert.equal(s.core.entities.get(id).driver, wb.playerId);
    assert.equal(controller(), wb.playerId);

    await moveB(state(3)); // gets out; still close, so keeps control
    await moveA(state(5));
    await settle();
    s.sync.step();
    assert.equal(s.core.entities.get(id).driver, 0);
    assert.equal(controller(), wb.playerId);

    await moveB(state(90)); // walks away past the handover distance
    await settle();
    s.sync.step();
    assert.equal(controller(), wa.playerId);

    // A driver who disconnects gives the vehicle up.
    await moveA(state(0, 0, driving));
    await settle();
    s.sync.step();
    assert.equal(s.core.entities.get(id).driver, wa.playerId);
    await a.send(shared.encodeBye({ session: wa.session }));
    await settle();
    s.sync.step();
    assert.equal(s.core.entities.get(id).driver, 0);
    assert.equal(controller(), wb.playerId); // the only player left in range
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("registered vehicles are limited per player and removed once nobody has been near; script vehicles stay", async () => {
  const s = await startServer({ maxVehiclesPerPlayer: 2, vehicleIdleSeconds: 60 });
  const a = await client(s.port);
  try {
    const wa = await a.join("Ana");
    let seq = 0;
    const move = (x) => a.send(shared.encodeState({ session: wa.session, seq: ++seq, clientTime: 0, state: state(x) }));
    await move(0);
    for (const localId of [1, 2, 3]) await a.send(shared.encodeVehicleState({ session: wa.session, seq: localId, vehicleId: 0, localId, state: vehicle(localId) }));
    await settle();
    assert.deepEqual(a.inbox.filter((m) => m.type === shared.SYNC_MSG.VEHICLE_ASSIGN).map((m) => m.localId), [1, 2]);
    s.core.callNative("test", "entities.spawnVehicle", ["taxi", { x: 0, y: 0, z: 10 }, 0]);
    s.sync.step();
    assert.equal(s.sync.stats().vehicles, 3);

    await move(5000); // nobody near the vehicles from now on
    await settle();
    s.sync.step();
    s.advance(59_000);
    await move(5000);
    await settle();
    s.sync.step();
    assert.equal(s.sync.stats().vehicles, 3);
    s.advance(2000);
    await move(5000);
    await settle();
    s.sync.step();
    assert.deepEqual(s.core.callNative("test", "entities.list", []).map((e) => e.model), ["taxi"]);
  } finally {
    await a.close();
    await s.close();
  }
});

test("PING gets a PONG and sets the player's ping for scripts, at most five times a second", async () => {
  const s = await startServer();
  const a = await client(s.port);
  try {
    const wa = await a.join("Ana");
    assert.equal(s.core.callNative("test", "player.ping", [wa.playerId]), null);
    await a.send(shared.encodePing({ session: wa.session, clientTime: 1234, rtt: 55 }));
    const pong = await a.next(a.of(shared.SYNC_MSG.PONG));
    assert.equal(pong.clientTime, 1234);
    assert.equal(s.core.callNative("test", "player.ping", [wa.playerId]), 55);
    await a.send(shared.encodePing({ session: wa.session, clientTime: 1235, rtt: 1 })); // too soon
    await settle();
    assert.equal(a.inbox.filter((m) => m.type === shared.SYNC_MSG.PONG).length, 0);
    assert.equal(s.core.callNative("test", "player.ping", [wa.playerId]), 55);
  } finally {
    await a.close();
    await s.close();
  }
});

test("entity ids count up and wrap past 65535, skipping ids in use; models become wire hashes", () => {
  const { modelHash } = require("../src/core/server-core");
  const config = validateConfig({ server: { name: "Ids" } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const first = core.spawnEntity("test", "vehicle", "sultan", { x: 0, y: 0, z: 0 }, 0);
  core.nextEntityId = 0xffff;
  assert.equal(core.spawnEntity("test", "vehicle", "sultan", { x: 0, y: 0, z: 0 }, 0).id, 0xffff);
  assert.equal(core.spawnEntity("test", "vehicle", "sultan", { x: 0, y: 0, z: 0 }, 0).id, first.id + 1); // 1 is taken
  assert.equal(modelHash("sultan"), 0x39da2754);
  assert.equal(modelHash("0x39DA2754"), 0x39da2754);
  assert.equal(modelHash("970598228"), 970598228);
  assert.equal(core.spawnEntity("test", "vehicle", "taxi", { x: 1, y: 2, z: 3 }, 450).heading, 90);
});

test("the first player is host and story characters go out in join order; leaving passes both on", async () => {
  const s = await startServer({ characters: ["lucia", "jason"] });
  const a = await client(s.port);
  const b = await client(s.port);
  const c = await client(s.port);
  try {
    const wa = await a.join("Ana");
    const wb = await b.join("Ben");
    const wc = await c.join("Cyd");
    const native = (name, id) => s.core.callNative("test", name, [id]);
    assert.deepEqual([native("player.isHost", wa.playerId), native("player.isHost", wb.playerId), native("player.isHost", wc.playerId)], [true, false, false]);
    assert.deepEqual([wa, wb, wc].map((w) => native("player.character", w.playerId)), [shared.joaat("lucia"), shared.joaat("jason"), 0]);

    await c.send(shared.encodeRosterRequest({ session: wc.session }));
    const roster = await c.next(c.of(shared.SYNC_MSG.ROSTER));
    assert.deepEqual(roster.players.map((p) => [p.name, p.character, p.host]), [["Ana", shared.joaat("lucia"), true], ["Ben", shared.joaat("jason"), false], ["Cyd", 0, false]]);

    // A character replaces the model the client reports; without one, the client's own model is relayed.
    await b.send(shared.encodeState({ session: wb.session, seq: 1, clientTime: 0, state: state(1, 0, { model: 0x1234 }) }));
    await c.send(shared.encodeState({ session: wc.session, seq: 1, clientTime: 0, state: state(2, 0, { model: 0x5555 }) }));
    await a.send(shared.encodeState({ session: wa.session, seq: 1, clientTime: 0, state: state(0) }));
    await settle();
    s.sync.step();
    const snap = await a.next(a.of(shared.SYNC_MSG.SNAPSHOT));
    assert.deepEqual(snap.entries.map((e) => [e.playerId, e.state.model]), [[wb.playerId, shared.joaat("jason")], [wc.playerId, 0x5555]]);

    // The host leaves: Ben takes over as host and keeps Jason; Cyd gets the freed Lucia.
    await a.send(shared.encodeBye({ session: wa.session }));
    await settle();
    assert.equal(s.sync.stats().host, wb.playerId);
    assert.equal(native("player.character", wb.playerId), shared.joaat("jason"));
    assert.equal(native("player.character", wc.playerId), shared.joaat("lucia"));
    assert.notEqual(s.sync.rosterVersion, roster.rosterVersion);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    await s.close();
  }
});

// ---- Reliable messages ----

const { SyncClient } = require("@projectvi/shared/sync-client");

async function syncClient(port, name) {
  const c = new SyncClient({ host: "127.0.0.1", port, name });
  await c.connect();
  return c;
}

// The server sends queued reliable messages on its tick.
async function tickAndSettle(s) {
  await settle();
  s.sync.step();
  await settle();
}

test("chat reaches every player and scripts; /commands run and answer with a notice; chat is rate-limited", async () => {
  const s = await startServer();
  const a = await syncClient(s.port, "Ana");
  const b = await syncClient(s.port, "Ben");
  try {
    const heard = [];
    s.core.bus.on("playerChat", (player, text) => heard.push([player.$player, text]));
    const runtime = { invokeCommand: async (name, source, args) => ({ error: `pong ${args.join(" ")} from #${source}` }) };
    s.core.registerCommand(runtime, { resource: "test", name: "ping" });
    const chatB = [];
    const noticesA = [];
    b.on("chat", (id, text) => chatB.push([id, text]));
    a.on("notice", (text) => noticesA.push(text));

    a.sendChat("  hello  ");
    a.sendChat("/ping x");
    a.sendChat("/nope");
    for (const line of ["l1", "l2", "l3", "l4"]) a.sendChat(line); // only 5 lines a second get through
    await tickAndSettle(s);
    await tickAndSettle(s);

    assert.deepEqual(chatB, [[a.playerId, "hello"], [a.playerId, "l1"], [a.playerId, "l2"]]);
    assert.deepEqual(heard, [[a.playerId, "hello"], [a.playerId, "l1"], [a.playerId, "l2"]]);
    assert.deepEqual(noticesA, [`pong x from #${a.playerId}`, "Unknown command: /nope"]);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("client events reach [NetEvent] handlers with the player as source; script events reach the clients they're for", async () => {
  const s = await startServer();
  const a = await syncClient(s.port, "Ana");
  const b = await syncClient(s.port, "Ben");
  try {
    const got = [];
    const runtime = { dispatch: (name, args, options) => got.push([name, args, options.source]) };
    s.core.bus.subscribe(runtime, "jobs:clockIn", true);
    a.sendEvent("jobs:clockIn", [1, "x"]);
    a.sendEvent("bad name!", []);
    a.sendEvent("jobs:clockIn", [{ $player: b.playerId }]); // can't name another player
    await tickAndSettle(s);
    assert.deepEqual(got, [["jobs:clockIn", [1, "x"], a.playerId]]);

    const eventsA = [];
    const eventsB = [];
    a.on("event", (name, args) => eventsA.push([name, args]));
    b.on("event", (name, args) => eventsB.push([name, args]));
    s.core.bus.emit("hud:cash", [{ cash: 5 }], { target: `client:${b.playerId}` });
    s.core.bus.emit("hud:time", ["12:00"], { target: "clients" });
    s.core.bus.emit("hud:big", ["x".repeat(20_000)], { target: "clients" }); // too big: not sent
    await tickAndSettle(s);
    assert.deepEqual(eventsA, [["hud:time", ["12:00"]]]);
    assert.deepEqual(eventsB, [["hud:cash", [{ cash: 5 }]], ["hud:time", ["12:00"]]]);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("a client that never acknowledges is dropped once too much is waiting for it", async () => {
  const s = await startServer();
  const silent = await client(s.port); // a bare socket: it never acknowledges anything
  try {
    const w = await silent.join("Ana");
    const player = s.core.players.get(w.playerId);
    for (let i = 0; i < 600 && s.core.players.get(w.playerId); i++) s.core.notify(player, "x".repeat(500));
    const kick = await silent.next(silent.of(shared.SYNC_MSG.KICK));
    assert.match(kick.reason, /unacknowledged/);
    assert.equal(s.core.players.get(w.playerId), undefined);
  } finally {
    await silent.close();
    await s.close();
  }
});
