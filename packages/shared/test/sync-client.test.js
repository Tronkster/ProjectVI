const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { once } = require("node:events");
const s = require("../sync");
const { SyncClient } = require("../sync-client");
const { joaat } = require("../hash");

const STATE = { position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, flags: 0, vehicleModel: 0, seat: 0 };

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
