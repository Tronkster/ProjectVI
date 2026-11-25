const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { once } = require("node:events");
const s = require("../sync");
const { SyncClient } = require("../sync-client");
const { joaat } = require("../hash");

const ZERO = { x: 0, y: 0, z: 0 };
const STATE = { position: { x: 1, y: 2, z: 3 }, velocity: ZERO, heading: 0, flags: 0, model: 0, health: 200, armour: 0, weapon: 0, aim: ZERO, vehicleId: 0, seat: 0 };
const VEHICLE = { model: 0x39da2754, position: { x: 5, y: 5, z: 1 }, rotation: s.quatFromHeading(90), velocity: ZERO, health: 1000, steering: 0, flags: 0 };

// A scripted server: a UDP socket that records what the client sends and answers through `reply`.
async function fakeServer(onMessage = () => {}) {
  const socket = dgram.createSocket("udp4");
  const received = [];
  let peer = null;
  const toPeer = (buf) => new Promise((resolve) => socket.send(buf, peer.port, peer.address, resolve));
  socket.on("message", (buf, rinfo) => {
    const msg = s.decodeSync(buf);
    if (!msg) return;
    peer = rinfo;
    received.push(msg);
    onMessage(msg, toPeer);
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, received, send: toPeer, close: () => new Promise((resolve) => socket.close(resolve)) };
}

const welcomeFor = (msg, serverTime = 0) => s.encodeWelcome({ nonce: msg.nonce, session: 77, playerId: 1, tickRate: 20, serverTime });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("joaat matches the game's hashes and ignores case", () => {
  assert.equal(joaat("adder"), 0xb779a091);
  assert.equal(joaat("SULTAN"), 0x39da2754);
});

test("a lost WELCOME is recovered by resending HELLO with the same nonce", async () => {
  let hellos = 0;
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO && ++hellos === 2) reply(welcomeFor(msg));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", helloIntervalMs: 20 });
  try {
    assert.deepEqual(await client.connect(), { session: 77, playerId: 1, tickRate: 20 });
    const [first, second] = server.received;
    assert.equal(first.nonce, second.nonce);
    assert.equal(first.name, "Kai");
    assert.ok(client.sendState(STATE));
    await settle();
    const sent = server.received.find((m) => m.type === s.SYNC_MSG.STATE);
    assert.equal(sent.session, 77);
    assert.equal(sent.seq, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a join fails with the server's reason, or after enough unanswered tries", async () => {
  const rejecting = await fakeServer((msg, reply) => reply(s.encodeReject({ nonce: msg.nonce, reason: "The server is full." })));
  const silent = await fakeServer();
  try {
    const a = new SyncClient({ host: "127.0.0.1", port: rejecting.port, name: "Kai" });
    await assert.rejects(a.connect(), { code: "REJECTED", message: "The server is full." });

    const b = new SyncClient({ host: "127.0.0.1", port: silent.port, name: "Kai", helloIntervalMs: 10, helloAttempts: 3 });
    await assert.rejects(b.connect(), { code: "NO_ANSWER" });
    assert.equal(silent.received.length, 3);
  } finally {
    await Promise.all([rejecting.close(), silent.close()]);
  }
});

test("the server clock follows the snapshot that waited least", async () => {
  let clock = 1000;
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg, 500));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", now: () => clock });
  try {
    await client.connect();
    assert.equal(client.serverNow(), 500);
    const snapshot = (serverTime) => s.encodeSnapshot({ tick: serverTime, serverTime, rosterVersion: 0, entries: [] });

    clock = 1100;
    server.send(snapshot(590)); // 10 ms slower than the WELCOME: the estimate stays
    await once(client, "snapshot");
    assert.equal(client.serverNow(), 600);

    clock = 1200;
    server.send(snapshot(705)); // 5 ms faster: the estimate moves up
    await once(client, "snapshot");
    assert.equal(client.serverNow(), 705);
  } finally {
    await client.close();
    await server.close();
  }
});

test("players stream in and out, names come from a roster sent out of order, and BYE is sent on close", async () => {
  let clock = 0;
  const players = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `Player_${String(i).padStart(12, "0")}` }));
  const pages = s.encodeRoster({ rosterVersion: 4, players });
  assert.ok(pages.length > 1);
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
    if (msg.type === s.SYNC_MSG.ROSTER_REQUEST) for (const page of [...pages].reverse()) reply(page);
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", now: () => clock, streamOutMs: 500 });
  try {
    await client.connect();
    const streamedIn = [];
    const streamedOut = [];
    client.on("streamIn", (id) => streamedIn.push(id));
    client.on("streamOut", (id) => streamedOut.push(id));

    const roster = once(client, "roster");
    // Player 1 is us, so only 7 becomes a remote player.
    server.send(s.encodeSnapshot({ tick: 1, serverTime: 0, rosterVersion: 4, entries: [{ playerId: 1, seq: 1, state: STATE }, { playerId: 7, seq: 1, state: STATE }] }));
    const [names] = await roster;
    assert.equal(names.size, 200);
    assert.deepEqual(streamedIn, [7]);
    assert.deepEqual(client.view().map((v) => [v.id, v.name]), [[7, "Player_000000000006"]]);

    clock = 400;
    client.update();
    assert.deepEqual(streamedOut, []);
    clock = 600;
    client.update();
    assert.deepEqual(streamedOut, [7]);
    assert.deepEqual(client.view(), []);

    await client.close();
    await settle();
    assert.equal(server.received.at(-1).type, s.SYNC_MSG.BYE);
    assert.equal(server.received.filter((m) => m.type === s.SYNC_MSG.ROSTER_REQUEST).length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a KICK closes the client with the server's reason", async () => {
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai" });
  try {
    await client.connect();
    const closed = once(client, "close");
    server.send(s.encodeKick({ reason: "Kicked: AFK" }));
    assert.deepEqual((await closed)[0], { reason: "Kicked: AFK", kicked: true });
    assert.equal(client.connected, false);
    assert.equal(client.sendState(STATE), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("vehicles stream in and out, and a reused id with another model is a new vehicle", async () => {
  let clock = 0;
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", now: () => clock, streamOutMs: 500 });
  try {
    await client.connect();
    const events = [];
    client.on("vehicleIn", (id) => events.push(`in ${id}`));
    client.on("vehicleOut", (id) => events.push(`out ${id}`));

    // Vehicle 3 is ours to simulate (controller 1 = us), vehicle 4 belongs to player 9.
    server.send(s.encodeVehicles({ tick: 1, serverTime: 0, entries: [{ vehicleId: 3, controller: 1, state: VEHICLE }, { vehicleId: 4, controller: 9, state: VEHICLE }] }));
    await once(client, "vehicleIn");
    await settle();
    assert.deepEqual(events, ["in 3", "in 4"]);
    assert.deepEqual(client.controlledVehicles(), [3]);
    assert.deepEqual(client.vehicleView().map((v) => [v.id, v.mine]), [[3, true], [4, false]]);

    server.send(s.encodeVehicles({ tick: 2, serverTime: 50, entries: [{ vehicleId: 4, controller: 9, state: { ...VEHICLE, model: 0xb779a091 } }] }));
    await settle();
    assert.deepEqual(events, ["in 3", "in 4", "out 4", "in 4"]);

    clock = 600; // vehicle 3 hasn't been in a message for 600 ms
    server.send(s.encodeVehicles({ tick: 3, serverTime: 100, entries: [{ vehicleId: 4, controller: 9, state: { ...VEHICLE, model: 0xb779a091 } }] }));
    await settle();
    client.update();
    assert.deepEqual(events.slice(4), ["out 3"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a vehicle the client spawned is registered by local id, then reported under the id the server gave it", async () => {
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
    if (msg.type === s.SYNC_MSG.VEHICLE_STATE && msg.vehicleId === 0) reply(s.encodeVehicleAssign({ localId: msg.localId, vehicleId: 21 }));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai" });
  try {
    await client.connect();
    assert.equal(client.sendVehicleState({}, VEHICLE), false); // neither id given
    const assigned = once(client, "vehicleAssigned");
    client.sendVehicleState({ localId: 5 }, VEHICLE);
    assert.deepEqual(await assigned, [5, 21]);
    assert.equal(client.vehicleIdFor(5), 21);
    client.sendVehicleState({ localId: 5 }, VEHICLE);
    client.sendVehicleState({ vehicleId: 8 }, VEHICLE); // a vehicle the server handed us
    await settle();
    const sent = server.received.filter((m) => m.type === s.SYNC_MSG.VEHICLE_STATE).map((m) => [m.vehicleId, m.localId, m.seq]);
    assert.deepEqual(sent, [[0, 5, 1], [21, 5, 2], [8, 0, 3]]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("pings measure the round trip and tell the server about it", async () => {
  let clock = 0;
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
    if (msg.type === s.SYNC_MSG.PING) {
      clock += 40; // the answer takes 40 ms
      reply(s.encodePong({ clientTime: msg.clientTime, serverTime: 0 }));
    }
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", now: () => clock });
  try {
    await client.connect();
    assert.equal(client.rtt, null);
    client.update();
    await settle();
    assert.equal(client.rtt, 40);
    clock += 1000;
    client.update();
    await settle();
    const pings = server.received.filter((m) => m.type === s.SYNC_MSG.PING);
    assert.deepEqual(pings.map((p) => p.rtt), [0, 40]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a registered vehicle that streams out is forgotten, so the next report registers it again", async () => {
  let clock = 0;
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
    if (msg.type === s.SYNC_MSG.VEHICLE_STATE && msg.vehicleId === 0) reply(s.encodeVehicleAssign({ localId: msg.localId, vehicleId: 21 }));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai", now: () => clock, streamOutMs: 500 });
  try {
    await client.connect();
    const assigned = once(client, "vehicleAssigned");
    client.sendVehicleState({ localId: 5 }, VEHICLE);
    await assigned;
    server.send(s.encodeVehicles({ tick: 1, serverTime: 0, entries: [{ vehicleId: 21, controller: 1, state: VEHICLE }] }));
    await once(client, "vehicleIn");

    clock = 600; // the server stopped sending it: removed, or out of range
    client.update();
    assert.equal(client.vehicleIdFor(5), 0);
    client.sendVehicleState({ localId: 5 }, VEHICLE);
    await settle();
    assert.deepEqual(server.received.filter((m) => m.type === s.SYNC_MSG.VEHICLE_STATE).map((m) => m.vehicleId), [0, 0]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the roster tells the client its character and whether it's the host", async () => {
  const server = await fakeServer((msg, reply) => {
    if (msg.type === s.SYNC_MSG.HELLO) reply(welcomeFor(msg));
  });
  const client = new SyncClient({ host: "127.0.0.1", port: server.port, name: "Kai" });
  try {
    await client.connect();
    const roles = [];
    client.on("role", (role) => roles.push(role));
    const lucia = joaat("lucia");
    let role = once(client, "role");
    server.send(s.encodeRoster({ rosterVersion: 1, players: [{ id: 1, name: "Kai", character: lucia, host: true }, { id: 2, name: "Ana", character: 0, host: false }] })[0]);
    await role;
    assert.equal(client.hostId, 1);
    role = once(client, "role");
    server.send(s.encodeRoster({ rosterVersion: 2, players: [{ id: 1, name: "Kai", character: lucia, host: false }, { id: 2, name: "Ana", character: 0, host: true }] })[0]);
    await role;
    server.send(s.encodeRoster({ rosterVersion: 3, players: [{ id: 1, name: "Kai", character: lucia, host: false }, { id: 2, name: "Ana", character: 0, host: true }, { id: 3, name: "Ben", character: 0, host: false }] })[0]);
    await settle();
    assert.deepEqual(roles, [{ character: lucia, host: true }, { character: lucia, host: false }]); // Ben joining changes nothing for us
    assert.equal(client.hostId, 2);
    assert.equal(client.players.get(3).name, "Ben");
  } finally {
    await client.close();
    await server.close();
  }
});
