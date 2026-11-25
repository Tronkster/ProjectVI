const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../sync");

const STATE = {
  position: { x: 1.5, y: -2.25, z: 30 },
  velocity: { x: 4, y: 0, z: -1 },
  heading: 90,
  flags: s.SYNC_FLAG.IN_VEHICLE,
  vehicleModel: 0xdeadbeef,
  seat: 1
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
  assert.deepEqual(s.decodeSync(s.encodeNotice({ text: "Hi ✓" })), { type: s.SYNC_MSG.NOTICE, text: "Hi ✓" });
});

test("a full snapshot fits in one packet, and more players than that is refused", () => {
  const entries = Array.from({ length: s.SNAPSHOT_MAX_ENTRIES }, (_, i) => ({ playerId: i, seq: i, state: STATE }));
  const buf = s.encodeSnapshot({ tick: 1, serverTime: 1, rosterVersion: 1, entries });
  assert.ok(buf.length <= s.SYNC_MAX_PACKET);
  assert.equal(s.decodeSync(buf).entries.length, s.SNAPSHOT_MAX_ENTRIES);
  assert.throws(() => s.encodeSnapshot({ tick: 1, serverTime: 1, rosterVersion: 1, entries: [...entries, entries[0]] }));
});

test("long rosters are split into pages that each fit", () => {
  const players = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `Player_${String(i).padStart(14, "0")}` }));
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
