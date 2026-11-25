// A reliable, ordered stream of messages over sync's UDP packets: one per direction per session, for
// things that must arrive (chat, script events, notices). docs/protocol.md ("Reliable messages") has the rules.
//
// Messages are numbered (16 bits, wrapping). The receiver acknowledges with the next number it expects plus a
// bitmask of the 32 after it that it already holds, and delivers in order; the sender resends whatever isn't
// acknowledged, waiting longer each time. A message bigger than one packet goes as several fragments, each but
// the last flagged "more"; ordered delivery keeps them together.
//
// No sockets here: the owner sends what poll() returns as RELIABLE packets (encodeReliable) and passes the
// ones it receives to receive(). That keeps the logic testable on a simulated bad network.

const { RELIABLE_PACKET_BUDGET, RELIABLE_MESSAGE_OVERHEAD, seqNewer } = require("./sync");

const WINDOW = 256; // messages in flight; far below 32768, so wrapped numbers still compare correctly
const MAX_FRAGMENT = 1000; // payload bytes per message
const MAX_MESSAGE = 64 * 1024; // a reassembled message bigger than this is a protocol error
const MAX_QUEUE_BYTES = 256 * 1024; // unacknowledged data before the peer is considered broken
const INITIAL_RTO = 300; // ms before the first resend, until the round trip has been measured
const MIN_RTO = 100;
const MAX_RTO = 2000;
// Each acknowledgement goes out on two polls in a row (now, and on the next tick). With a single one, a lost
// acknowledgement waits for the next message to carry it, which both causes needless resends and inflates the
// measured round trip, and with it every resend timer.
const ACK_REPEATS = 2;

class ReliableChannel {
  // now: a millisecond clock.
  constructor({ now }) {
    this.now = now;
    this.failed = null; // why the channel broke (the peer sent too much, or never acknowledged): drop the session

    // Sending
    this.nextSeq = 0;
    this.unacked = []; // [{ seq, more, payload, sentAt, tries }], oldest first
    this.queuedBytes = 0;
    this.srtt = null; // smoothed round trip, from acknowledgements of messages sent once
    this.rttvar = 0;

    // Receiving
    this.expected = 0; // the next number to deliver
    this.held = new Map(); // seq -> message, arrived early
    this.partial = []; // fragments of the message being put back together
    this.partialBytes = 0;
    this.acksOwed = 0;
  }

  // Queues a message (a Buffer of any size up to 64 KB). Returns false if the channel has failed, or fails now
  // because too much is waiting for acknowledgement.
  send(payload) {
    if (this.failed) return false;
    if (payload.length > MAX_MESSAGE) throw new Error(`A reliable message can be at most ${MAX_MESSAGE} bytes.`);
    let offset = 0;
    do {
      const chunk = payload.subarray(offset, offset + MAX_FRAGMENT);
      offset += chunk.length;
      this.unacked.push({ seq: this.nextSeq, more: offset < payload.length, payload: chunk, sentAt: null, tries: 0 });
      this.nextSeq = (this.nextSeq + 1) & 0xffff;
      this.queuedBytes += chunk.length;
    } while (offset < payload.length);
    if (this.queuedBytes > MAX_QUEUE_BYTES) {
      this.failed = "Too much unacknowledged data.";
      return false;
    }
    return true;
  }

  // How long to wait before resending a message sent once.
  rto() {
    if (this.srtt === null) return INITIAL_RTO;
    return Math.min(MAX_RTO, Math.max(MIN_RTO, this.srtt + 4 * this.rttvar));
  }

  // What to send now: [{ ack, ackBits, messages: [{ seq, more, payload }] }], each fitting one packet.
  // Includes new messages, ones due for a resend, and an acknowledgement-only packet if one is owed.
  poll() {
    const now = this.now();
    const groups = [];
    let current = null;
    let size = 0;
    const base = this.unacked[0]?.seq;
    for (const m of this.unacked) {
      if (((m.seq - base) & 0xffff) >= WINDOW) break; // the receiver wouldn't keep it
      const wait = m.tries === 0 ? 0 : Math.min(MAX_RTO, this.rto() * 2 ** (m.tries - 1));
      if (m.sentAt !== null && now - m.sentAt < wait) continue;
      const bytes = RELIABLE_MESSAGE_OVERHEAD + m.payload.length;
      if (!current || size + bytes > RELIABLE_PACKET_BUDGET) {
        current = [];
        groups.push(current);
        size = 0;
      }
      current.push(m);
      size += bytes;
      m.sentAt = now;
      m.tries++;
    }
    if (!groups.length && this.acksOwed > 0) groups.push([]);
    if (!groups.length) return [];
    this.acksOwed = Math.max(0, this.acksOwed - 1);
    const { ack, ackBits } = this.ackFields();
    return groups.map((messages) => ({ ack, ackBits, messages: messages.map(({ seq, more, payload }) => ({ seq, more, payload })) }));
  }

  ackFields() {
    let bits = 0;
    for (let i = 0; i < 32; i++) if (this.held.has((this.expected + 1 + i) & 0xffff)) bits |= 1 << i;
    return { ack: this.expected, ackBits: bits >>> 0 };
  }

  // Takes a received RELIABLE packet's { ack, ackBits, messages }. Returns the complete messages it finishes,
  // in order, as Buffers.
  receive({ ack, ackBits, messages }) {
    if (this.failed) return [];
    this.acknowledged(ack, ackBits);
    if (messages.length) this.acksOwed = ACK_REPEATS; // even for duplicates: our acknowledgement may have been lost

    for (const m of messages) {
      const ahead = (m.seq - this.expected) & 0xffff;
      if (ahead < WINDOW && !this.held.has(m.seq)) this.held.set(m.seq, m); // otherwise already delivered
    }
    const delivered = [];
    while (this.held.has(this.expected)) {
      const m = this.held.get(this.expected);
      this.held.delete(this.expected);
      this.expected = (this.expected + 1) & 0xffff;
      this.partialBytes += m.payload.length;
      if (this.partialBytes > MAX_MESSAGE) {
        this.failed = "A reliable message was too big.";
        break;
      }
      this.partial.push(m.payload);
      if (!m.more) {
        delivered.push(Buffer.concat(this.partial));
        this.partial = [];
        this.partialBytes = 0;
      }
    }
    return delivered;
  }

  acknowledged(ack, bits) {
    const now = this.now();
    this.unacked = this.unacked.filter((m) => {
      if (m.sentAt === null) return true; // never sent, so it can't have arrived
      const bit = ((m.seq - ack) & 0xffff) - 1;
      const done = seqNewer(ack, m.seq) || (bit >= 0 && bit < 32 && ((bits >>> bit) & 1) === 1);
      if (!done) return true;
      // Only messages sent once give a clean round trip: for a resent one, we can't tell which copy arrived.
      if (m.tries === 1) this.sampleRtt(now - m.sentAt);
      this.queuedBytes -= m.payload.length;
      return false;
    });
  }

  sampleRtt(sample) {
    if (this.srtt === null) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
  }

  // Messages sent or queued but not yet acknowledged.
  get pending() {
    return this.unacked.length;
  }
}

module.exports = { ReliableChannel, RELIABLE_WINDOW: WINDOW, RELIABLE_MAX_FRAGMENT: MAX_FRAGMENT, RELIABLE_MAX_MESSAGE: MAX_MESSAGE };
