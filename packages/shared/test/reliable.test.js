const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../sync");
const { ReliableChannel, RELIABLE_WINDOW } = require("../reliable");

// Repeatable "random" numbers.
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// One direction of a bad network: drops, duplicates and delays (so reorders) packets. Packets go through the
// real codec on the way.
function badLink({ random, loss, duplicate, maxDelay }) {
  const inFlight = [];
  return {
    send(now, fields) {
      if (random() < loss) return;
      const copies = random() < duplicate ? 2 : 1;
      const buf = s.encodeReliable({ session: 1, ...fields });
      for (let i = 0; i < copies; i++) inFlight.push({ at: now + random() * maxDelay, buf });
    },
    due(now) {
      const ready = inFlight.filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
      for (const p of ready) inFlight.splice(inFlight.indexOf(p), 1);
      return ready.map((p) => s.decodeSync(p.buf));
    }
  };
}

test("over a link that drops, duplicates and reorders, every message arrives once and in order, across the wrap", () => {
  const random = seeded(42);
  let clock = 0;
  const a = new ReliableChannel({ now: () => clock });
  const b = new ReliableChannel({ now: () => clock });
  // Start just below 65535 so the sequence numbers wrap during the run.
  a.nextSeq = b.expected = 65_500;
  b.nextSeq = a.expected = 65_400;
  const ab = badLink({ random, loss: 0.25, duplicate: 0.1, maxDelay: 80 });
  const ba = badLink({ random, loss: 0.25, duplicate: 0.1, maxDelay: 80 });

  const message = (i) => Buffer.alloc(Math.floor(random() * 3000), i % 251); // some need several fragments
  const toSend = { a: Array.from({ length: 400 }, (_, i) => message(i)), b: Array.from({ length: 150 }, (_, i) => message(i + 7)) };
  const sent = { a: 0, b: 0 };
  const got = { a: [], b: [] };

  for (let step = 0; step < 20_000 && (got.b.length < toSend.a.length || got.a.length < toSend.b.length); step++) {
    clock += 10;
    // Queue a few at a time, staying well under the unacknowledged-data limit.
    for (const [from, channel] of [["a", a], ["b", b]]) {
      while (sent[from] < toSend[from].length && channel.queuedBytes < 60_000) assert.ok(channel.send(toSend[from][sent[from]++]));
    }
    for (const p of a.poll()) ab.send(clock, p);
    for (const p of b.poll()) ba.send(clock, p);
    for (const p of ab.due(clock)) got.b.push(...b.receive(p));
    for (const p of ba.due(clock)) got.a.push(...a.receive(p));
  }
  assert.equal(a.failed, null);
  assert.equal(b.failed, null);
  assert.deepEqual(got.b, toSend.a);
  assert.deepEqual(got.a, toSend.b);
  assert.ok(a.nextSeq < 65_500, "a's sequence numbers wrapped");
});

test("the sender never has more than a window of messages in flight", () => {
  let clock = 0;
  const a = new ReliableChannel({ now: () => clock });
  for (let i = 0; i < 1000; i++) a.send(Buffer.from([i & 0xff]));
  const seen = new Set();
  for (let step = 0; step < 200; step++) {
    clock += 500; // long enough for everything to be due again; nothing is ever acknowledged
    for (const p of a.poll()) for (const m of p.messages) seen.add(m.seq);
  }
  assert.equal(seen.size, RELIABLE_WINDOW);
});

test("too much unacknowledged data, or a message too big to put back together, fails the channel", () => {
  const a = new ReliableChannel({ now: () => 0 });
  let ok = true;
  for (let i = 0; i < 300 && ok; i++) ok = a.send(Buffer.alloc(1000));
  assert.equal(ok, false);
  assert.match(a.failed, /unacknowledged/);
  assert.equal(a.send(Buffer.alloc(1)), false);

  const b = new ReliableChannel({ now: () => 0 });
  const fragments = Array.from({ length: 70 }, (_, seq) => ({ seq, more: true, payload: Buffer.alloc(1000) }));
  assert.deepEqual(b.receive({ ack: 0, ackBits: 0, messages: fragments.slice(0, 40) }), []);
  b.receive({ ack: 0, ackBits: 0, messages: fragments.slice(40) });
  assert.match(b.failed, /too big/);
});

test("acknowledgements go out at once, set the resend timer from the round trip, and skip resent messages", () => {
  let clock = 0;
  const a = new ReliableChannel({ now: () => clock });
  const b = new ReliableChannel({ now: () => clock });
  assert.deepEqual(a.poll(), []); // nothing to say

  a.send(Buffer.from("hi"));
  const [first] = a.poll();
  assert.equal(first.messages.length, 1);
  clock = 40;
  assert.deepEqual(b.receive(first), [Buffer.from("hi")]);
  const [ack] = b.poll(); // acknowledgement only, straight away
  assert.deepEqual(ack, { ack: 1, ackBits: 0, messages: [] });
  clock = 80;
  a.receive(ack);
  assert.equal(a.pending, 0);
  assert.equal(a.rto(), 240); // 80 ms round trip + 4 × 40 ms variation

  // A message resent before its acknowledgement arrives gives no round-trip sample.
  a.send(Buffer.from("again"));
  const [sentOnce] = a.poll();
  clock += 250;
  const [resent] = a.poll();
  assert.equal(resent.messages[0].seq, sentOnce.messages[0].seq);
  clock += 1000;
  a.receive({ ack: 2, ackBits: 0, messages: [] });
  assert.equal(a.pending, 0);
  assert.equal(a.rto(), 240);
});

test("a selective acknowledgement clears messages that arrived after a gap", () => {
  let clock = 0;
  const a = new ReliableChannel({ now: () => clock });
  const b = new ReliableChannel({ now: () => clock });
  for (const text of ["one", "two", "three"]) a.send(Buffer.from(text));
  const [packet] = a.poll();
  // "one" is lost; b holds "two" and "three" and says so.
  assert.deepEqual(b.receive({ ...packet, messages: packet.messages.slice(1) }), []);
  const [ack] = b.poll();
  assert.deepEqual([ack.ack, ack.ackBits], [0, 0b11]);
  a.receive(ack);
  assert.equal(a.pending, 1); // only "one" is left to resend
  clock += 1000;
  const [resend] = a.poll();
  assert.deepEqual(resend.messages.map((m) => m.payload.toString()), ["one"]);
  assert.deepEqual(b.receive(resend).map(String), ["one", "two", "three"]);
});
