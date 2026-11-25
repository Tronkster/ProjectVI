const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../sync");

const STATE = {
  position: { x: 1.5, y: -2.25, z: 30 },
  velocity: { x: 4, y: 0, z: -1 },
  heading: 90,
  flags: s.SYNC_FLAG.IN_VEHICLE | s.SYNC_FLAG.SWIMMING,
  model: 0x705e61f2,
  health: 200,
  armour: 50,
  weapon: 0xa2719263,
  aim: { x: 10, y: 20, z: 30.5 },
  vehicleId: 7,
  seat: 1
};

const VEHICLE = {
  model: 0x39da2754,
  position: { x: -1000.5, y: 230.25, z: 12 },
  rotation: { x: 0, y: 0, z: 0.5, w: 0.75 },
  velocity: { x: 0, y: 20, z: 0 },
  health: 1000,
  steering: -1,
  flags: s.SYNC_VEHICLE_FLAG.ENGINE_ON | s.SYNC_VEHICLE_FLAG.LIGHTS
};

test("every message survives an encode and decode", () => {
  assert.deepEqual(s.decodeSync(s.encodeHello({ nonce: 7, name: "Kai" })), { type: s.SYNC_MSG.HELLO, nonce: 7, name: "Kai" });
  assert.deepEqual(s.decodeSync(s.encodeWelcome({ nonce: 7, session: 0xabcdef01, playerId: 3, tickRate: 20, serverTime: 1234 })), {
    type: s.SYNC_MSG.WELCOME, nonce: 7, session: 0xabcdef01, playerId: 3, tickRate: 20, serverTime: 1234
  });
  assert.deepEqual(s.decodeSync(s.encodeReject({ nonce: 7, reason: "Full" })), { type: s.SYNC_MSG.REJECT, nonce: 7, reason: "Full" });
  assert.deepEqual(s.decodeSync(s.encodeState({ session: 9, seq: 65535, clientTime: 42, state: STATE })), {
    type: s.SYNC_MSG.STATE, session: 9, seq: 65535, clientTime: 42, state: STATE
  });
  const snap = s.decodeSync(s.encodeSnapshot({ tick: 5, serverTime: 99, rosterVersion: 2, entries: [{ playerId: 4, seq: 10, state: STATE }] }));
  assert.deepEqual(snap, { type: s.SYNC_MSG.SNAPSHOT, tick: 5, serverTime: 99, rosterVersion: 2, entries: [{ playerId: 4, seq: 10, state: STATE }] });
  assert.deepEqual(s.decodeSync(s.encodeBye({ session: 9 })), { type: s.SYNC_MSG.BYE, session: 9 });
  assert.deepEqual(s.decodeSync(s.encodeRosterRequest({ session: 9 })), { type: s.SYNC_MSG.ROSTER_REQUEST, session: 9 });
  assert.deepEqual(s.decodeSync(s.encodeKick({ reason: "Bye" })), { type: s.SYNC_MSG.KICK, reason: "Bye" });
  assert.deepEqual(s.decodeSync(s.encodeVehicleState({ session: 9, seq: 3, vehicleId: 0, localId: 12, state: VEHICLE })), {
    type: s.SYNC_MSG.VEHICLE_STATE, session: 9, seq: 3, vehicleId: 0, localId: 12, state: VEHICLE
  });
  assert.deepEqual(s.decodeSync(s.encodeVehicles({ tick: 5, serverTime: 99, entries: [{ vehicleId: 7, controller: 4, state: VEHICLE }] })), {
    type: s.SYNC_MSG.VEHICLES, tick: 5, serverTime: 99, entries: [{ vehicleId: 7, controller: 4, state: VEHICLE }]
  });
  assert.deepEqual(s.decodeSync(s.encodeVehicleAssign({ localId: 12, vehicleId: 7 })), { type: s.SYNC_MSG.VEHICLE_ASSIGN, localId: 12, vehicleId: 7 });
  assert.deepEqual(s.decodeSync(s.encodePing({ session: 9, clientTime: 5000, rtt: 42 })), { type: s.SYNC_MSG.PING, session: 9, clientTime: 5000, rtt: 42 });
  assert.deepEqual(s.decodeSync(s.encodePong({ clientTime: 5000, serverTime: 123 })), { type: s.SYNC_MSG.PONG, clientTime: 5000, serverTime: 123 });
});

test("reliable packets and their message kinds survive an encode and decode", () => {
  const messages = [{ seq: 65535, more: true, payload: Buffer.from("ab") }, { seq: 0, more: false, payload: Buffer.alloc(0) }];
  assert.deepEqual(s.decodeSync(s.encodeReliable({ session: 9, ack: 12, ackBits: 0x80000001, messages })), {
    type: s.SYNC_MSG.RELIABLE, session: 9, ack: 12, ackBits: 0x80000001, messages
  });
  assert.deepEqual(s.decodeChannelMessage(s.encodeChat({ playerId: 4, text: "hi ✓" })), { kind: s.SYNC_CHANNEL.CHAT, playerId: 4, text: "hi ✓" });
  assert.deepEqual(s.decodeChannelMessage(s.encodeChannelNotice({ text: "Paid" })), { kind: s.SYNC_CHANNEL.NOTICE, text: "Paid" });
  assert.deepEqual(s.decodeChannelMessage(s.encodeEvent({ name: "jobs:clockIn", args: [1, "a", { b: true }] })), {
    kind: s.SYNC_CHANNEL.EVENT, name: "jobs:clockIn", args: [1, "a", { b: true }]
  });
  // Event arguments must be a JSON array.
  const notArray = Buffer.concat([Buffer.from([s.SYNC_CHANNEL.EVENT, 1]), Buffer.from("x"), Buffer.from('{"a":1}')]);
  assert.equal(s.decodeChannelMessage(notArray), null);
  assert.equal(s.decodeChannelMessage(Buffer.concat([notArray.subarray(0, 3), Buffer.from("[1,")])), null);
  assert.equal(s.decodeChannelMessage(Buffer.from([99])), null);
  // A message claiming to be longer than the packet is refused.
  const short = s.encodeReliable({ session: 1, ack: 0, ackBits: 0, messages: [{ seq: 1, more: false, payload: Buffer.from("abc") }] });
  assert.equal(s.decodeSync(short.subarray(0, short.length - 1)), null);
});

test("numbers too big for their field are clamped, and steering keeps its sign", () => {
  const state = s.decodeSync(s.encodeState({ session: 1, seq: 1, clientTime: 1, state: { ...STATE, health: 70000, armour: -5 } })).state;
  assert.equal(state.health, 65535);
  assert.equal(state.armour, 0);
  const vehicle = s.decodeSync(s.encodeVehicleState({ session: 1, seq: 1, vehicleId: 1, localId: 0, state: { ...VEHICLE, steering: 0.5 } })).state;
  assert.ok(Math.abs(vehicle.steering - 0.5) < 0.01);
  assert.equal(s.decodeSync(s.encodeVehicleState({ session: 1, seq: 1, vehicleId: 1, localId: 0, state: { ...VEHICLE, steering: 9 } })).state.steering, 1);
});

test("full vehicle messages fit in one packet, and more than that is refused", () => {
  const entries = Array.from({ length: s.VEHICLES_MAX_ENTRIES }, (_, i) => ({ vehicleId: i + 1, controller: 0, state: VEHICLE }));
  const buf = s.encodeVehicles({ tick: 1, serverTime: 1, entries });
  assert.ok(buf.length <= s.SYNC_MAX_PACKET);
  assert.equal(s.decodeSync(buf).entries.length, s.VEHICLES_MAX_ENTRIES);
  assert.throws(() => s.encodeVehicles({ tick: 1, serverTime: 1, entries: [...entries, entries[0]] }));
});

// Example packets for clients written in other languages: each must encode to exactly these bytes.
test("messages encode to the example packets in sync-vectors.json", () => {
  const vectors = require("./sync-vectors.json");
  const encoders = {
    HELLO: s.encodeHello,
    WELCOME: s.encodeWelcome,
    STATE: s.encodeState,
    SNAPSHOT: s.encodeSnapshot,
    VEHICLE_STATE: s.encodeVehicleState,
    VEHICLES: s.encodeVehicles,
    VEHICLE_ASSIGN: s.encodeVehicleAssign,
    PING: s.encodePing,
    PONG: s.encodePong,
    ROSTER: (fields) => s.encodeRoster(fields)[0],
    RELIABLE: (fields) => s.encodeReliable({ ...fields, messages: fields.messages.map((m) => ({ ...m, payload: Buffer.from(m.payload, "hex") })) })
  };
  for (const v of vectors.messages) {
    assert.equal(encoders[v.type](v.fields).toString("hex"), v.hex, v.type);
    const decoded = s.decodeSync(Buffer.from(v.hex, "hex"));
    if (decoded.messages) decoded.messages = decoded.messages.map((m) => ({ ...m, payload: m.payload.toString("hex") }));
    assert.deepEqual(decoded, { type: s.SYNC_MSG[v.type], ...v.fields }, v.type);
  }
  assert.equal(vectors.version, s.SYNC_VERSION);
});

test("a full snapshot fits in one packet, and more players than that is refused", () => {
  const entries = Array.from({ length: s.SNAPSHOT_MAX_ENTRIES }, (_, i) => ({ playerId: i, seq: i, state: STATE }));
  const buf = s.encodeSnapshot({ tick: 1, serverTime: 1, rosterVersion: 1, entries });
  assert.ok(buf.length <= s.SYNC_MAX_PACKET);
  assert.equal(s.decodeSync(buf).entries.length, s.SNAPSHOT_MAX_ENTRIES);
  assert.throws(() => s.encodeSnapshot({ tick: 1, serverTime: 1, rosterVersion: 1, entries: [...entries, entries[0]] }));
});

test("long rosters are split into pages that each fit", () => {
  const players = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `Player_${String(i).padStart(14, "0")}`, character: i * 7919, host: i === 0 }));
  const pages = s.encodeRoster({ rosterVersion: 3, players });
  assert.ok(pages.length > 1);
  const decoded = pages.map(s.decodeSync);
  for (const [i, page] of decoded.entries()) {
    assert.ok(pages[i].length <= s.SYNC_MAX_PACKET);
    assert.equal(page.page, i);
    assert.equal(page.pages, pages.length);
  }
  assert.deepEqual(decoded.flatMap((p) => p.players), players);
});

test("malformed or foreign packets decode to null", () => {
  const good = s.encodeState({ session: 1, seq: 1, clientTime: 1, state: STATE });
  assert.equal(s.decodeSync(good.subarray(0, good.length - 1)), null); // truncated
  assert.equal(s.decodeSync(Buffer.concat([good, Buffer.from([0])])), null); // trailing byte
  assert.equal(s.decodeSync(Buffer.from("GET / HTTP/1.1")), null); // not ours
  const otherVersion = Buffer.from(good);
  otherVersion[2] = 99;
  assert.equal(s.decodeSync(otherVersion), null);
  const unknownType = Buffer.from(good);
  unknownType[3] = 200;
  assert.equal(s.decodeSync(unknownType), null);
  const lyingCount = s.encodeSnapshot({ tick: 1, serverTime: 1, rosterVersion: 1, entries: [{ playerId: 1, seq: 1, state: STATE }] });
  lyingCount[14] = 5; // claims 5 entries, holds 1
  assert.equal(s.decodeSync(lyingCount), null);
  assert.equal(s.decodeSync(Buffer.alloc(s.SYNC_MAX_PACKET + 1)), null);
});

test("sequence numbers compare across the 16-bit wrap", () => {
  assert.equal(s.seqNewer(2, 1), true);
  assert.equal(s.seqNewer(1, 2), false);
  assert.equal(s.seqNewer(1, 1), false);
  assert.equal(s.seqNewer(0, 65535), true);
  assert.equal(s.seqNewer(65535, 0), false);
});

test("headings interpolate the short way round", () => {
  assert.equal(s.lerpAngle(350, 10, 0.5), 0);
  assert.equal(s.lerpAngle(10, 350, 0.5), 0);
  assert.equal(s.lerpAngle(0, 90, 0.5), 45);
});

test("the interpolator blends between states, then extrapolates briefly and holds", () => {
  const at = (x, vx = 0) => ({ ...STATE, position: { x, y: 0, z: 0 }, velocity: { x: vx, y: 0, z: 0 } });
  const it = s.createInterpolator({ delayMs: 100, maxExtrapolateMs: 200 });
  assert.equal(it.sample(0), null);
  it.push(1000, at(0, 10));
  it.push(1100, at(1, 10));
  it.push(1050, at(99)); // older than the newest: ignored
  assert.equal(it.sample(1150).position.x, 0.5); // renders t=1050, halfway
  assert.equal(it.sample(900).position.x, 0); // before history: oldest state
  assert.equal(it.sample(1300).position.x, 2); // t=1200: 100 ms past the last state at 10 m/s
  assert.equal(it.sample(5000).position.x, 3); // extrapolation stops after 200 ms
});

test("headings and rotations convert both ways", () => {
  for (const heading of [0, 45, 90, 180, 270, 359]) assert.ok(Math.abs(s.headingFromQuat(s.quatFromHeading(heading)) - heading) < 1e-9);
});

test("vehicle rotations interpolate the short way round, and hold when extrapolating", () => {
  const at = (heading, q = s.quatFromHeading(heading)) => ({ ...VEHICLE, rotation: q, velocity: { x: 0, y: 0, z: 0 } });
  const it = s.createInterpolator({ delayMs: 0 });
  it.push(0, at(350));
  // The same 10° rotation written as -q: a naive blend would swing through 180°.
  const q10 = s.quatFromHeading(10);
  it.push(100, at(10, { x: -q10.x, y: -q10.y, z: -q10.z, w: -q10.w }));
  const middle = it.sample(50).rotation;
  assert.ok(Math.abs(s.headingFromQuat(middle)) < 1e-6 || Math.abs(s.headingFromQuat(middle) - 360) < 1e-6);
  assert.ok(Math.abs(Math.hypot(middle.x, middle.y, middle.z, middle.w) - 1) < 1e-9);
  assert.ok(Math.abs(s.headingFromQuat(it.sample(500).rotation) - 10) < 1e-6);
});
