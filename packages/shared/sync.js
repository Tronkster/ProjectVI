// Player sync over UDP: the binary messages a game server and the ProjectVI client exchange.
// docs/protocol.md ("Player sync") describes the same format for people. Both sides use this file, so
// they can't drift apart.
//
// Every packet starts with a 4-byte header: "PV", the sync version, and the message type.
// Numbers are little-endian. Floats are 32-bit. Nothing here is trusted: decoders return null for
// anything malformed, and the server still checks values (positions, speeds, sequence numbers).

const SYNC_VERSION = 1;
const MAGIC_0 = 0x50; // "P"
const MAGIC_1 = 0x56; // "V"
const HEADER = 4;

// Keeps packets under common internet MTUs once IP and UDP headers are added.
const MAX_PACKET = 1200;

const MSG = Object.freeze({
  HELLO: 1, // client -> server: join
  WELCOME: 2, // server -> client: joined
  REJECT: 3, // server -> client: not joined, with a reason
  STATE: 4, // client -> server: the local player's state, every tick
  SNAPSHOT: 5, // server -> client: other players' states
  ROSTER_REQUEST: 6, // client -> server: send me the player list
  ROSTER: 7, // server -> client: player ids and names, one page
  BYE: 8, // client -> server: leaving
  KICK: 9, // server -> client: you were removed, with a reason
  NOTICE: 10 // server -> client: a message to show the player
});

// STATE flags
const FLAG = Object.freeze({
  IN_VEHICLE: 1,
  ON_FOOT_MOVING: 2,
  AIMING: 4,
  DEAD: 8
});

const STATE_FIELDS_BYTES = 28 + 1 + 4 + 1; // pos, vel, heading (7 floats), flags, vehicle model, seat
const SNAPSHOT_HEADER_BYTES = HEADER + 4 + 4 + 2 + 1; // tick, server time, roster version, count
const SNAPSHOT_ENTRY_BYTES = 2 + 2 + STATE_FIELDS_BYTES; // player id, last sequence, state
const SNAPSHOT_MAX_ENTRIES = Math.floor((MAX_PACKET - SNAPSHOT_HEADER_BYTES) / SNAPSHOT_ENTRY_BYTES);

function header(type, size) {
  const buf = Buffer.alloc(size);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = SYNC_VERSION;
  buf[3] = type;
  return buf;
}

// Returns the message type, or null if this isn't a ProjectVI sync packet of our version.
function readType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER || buf.length > MAX_PACKET) return null;
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1 || buf[2] !== SYNC_VERSION) return null;
  return buf[3];
}

function writeText(buf, offset, text, lengthBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (lengthBytes === 1) buf.writeUInt8(bytes.length, offset);
  else buf.writeUInt16LE(bytes.length, offset);
  bytes.copy(buf, offset + lengthBytes);
  return offset + lengthBytes + bytes.length;
}

function readText(buf, offset, lengthBytes) {
  if (offset + lengthBytes > buf.length) return null;
  const length = lengthBytes === 1 ? buf.readUInt8(offset) : buf.readUInt16LE(offset);
  const start = offset + lengthBytes;
  if (start + length > buf.length) return null;
  return { text: buf.toString("utf8", start, start + length), next: start + length };
}

// ---- State: the part of a player the client reports and the server relays ----

function writeState(buf, offset, s) {
  buf.writeFloatLE(s.position.x, offset);
  buf.writeFloatLE(s.position.y, offset + 4);
  buf.writeFloatLE(s.position.z, offset + 8);
  buf.writeFloatLE(s.velocity.x, offset + 12);
  buf.writeFloatLE(s.velocity.y, offset + 16);
  buf.writeFloatLE(s.velocity.z, offset + 20);
  buf.writeFloatLE(s.heading, offset + 24);
  buf.writeUInt8(s.flags & 0xff, offset + 28);
  buf.writeUInt32LE(s.vehicleModel >>> 0, offset + 29);
  buf.writeUInt8(s.seat & 0xff, offset + 33);
  return offset + STATE_FIELDS_BYTES;
}

function readState(buf, offset) {
  return {
    position: { x: buf.readFloatLE(offset), y: buf.readFloatLE(offset + 4), z: buf.readFloatLE(offset + 8) },
    velocity: { x: buf.readFloatLE(offset + 12), y: buf.readFloatLE(offset + 16), z: buf.readFloatLE(offset + 20) },
    heading: buf.readFloatLE(offset + 24),
    flags: buf.readUInt8(offset + 28),
    vehicleModel: buf.readUInt32LE(offset + 29),
    seat: buf.readUInt8(offset + 33)
  };
}

// ---- Encoders ----

function encodeHello({ nonce, name }) {
  const nameBytes = Buffer.byteLength(name, "utf8");
  const buf = header(MSG.HELLO, HEADER + 4 + 1 + nameBytes);
  buf.writeUInt32LE(nonce >>> 0, HEADER);
  writeText(buf, HEADER + 4, name, 1);
  return buf;
}

function encodeWelcome({ nonce, session, playerId, tickRate, serverTime }) {
  const buf = header(MSG.WELCOME, HEADER + 4 + 4 + 2 + 1 + 4);
  buf.writeUInt32LE(nonce >>> 0, HEADER);
  buf.writeUInt32LE(session >>> 0, HEADER + 4);
  buf.writeUInt16LE(playerId, HEADER + 8);
  buf.writeUInt8(tickRate, HEADER + 10);
  buf.writeUInt32LE(serverTime >>> 0, HEADER + 11);
  return buf;
}

function encodeReject({ nonce, reason }) {
  const text = String(reason).slice(0, 200);
  const buf = header(MSG.REJECT, HEADER + 4 + 1 + Buffer.byteLength(text, "utf8"));
  buf.writeUInt32LE(nonce >>> 0, HEADER);
  writeText(buf, HEADER + 4, text, 1);
  return buf;
}

function encodeState({ session, seq, clientTime, state }) {
  const buf = header(MSG.STATE, HEADER + 4 + 2 + 4 + STATE_FIELDS_BYTES);
  buf.writeUInt32LE(session >>> 0, HEADER);
  buf.writeUInt16LE(seq & 0xffff, HEADER + 4);
  buf.writeUInt32LE(clientTime >>> 0, HEADER + 6);
  writeState(buf, HEADER + 10, state);
  return buf;
}

// entries: [{ playerId, seq, state }], at most SNAPSHOT_MAX_ENTRIES
function encodeSnapshot({ tick, serverTime, rosterVersion, entries }) {
  if (entries.length > SNAPSHOT_MAX_ENTRIES) throw new Error(`A snapshot holds at most ${SNAPSHOT_MAX_ENTRIES} players.`);
  const buf = header(MSG.SNAPSHOT, SNAPSHOT_HEADER_BYTES + entries.length * SNAPSHOT_ENTRY_BYTES);
  buf.writeUInt32LE(tick >>> 0, HEADER);
  buf.writeUInt32LE(serverTime >>> 0, HEADER + 4);
  buf.writeUInt16LE(rosterVersion & 0xffff, HEADER + 8);
  buf.writeUInt8(entries.length, HEADER + 10);
  let offset = SNAPSHOT_HEADER_BYTES;
  for (const e of entries) {
    buf.writeUInt16LE(e.playerId, offset);
    buf.writeUInt16LE(e.seq & 0xffff, offset + 2);
    offset = writeState(buf, offset + 4, e.state);
  }
  return buf;
}

function encodeSessionOnly(type, session) {
  const buf = header(type, HEADER + 4);
  buf.writeUInt32LE(session >>> 0, HEADER);
  return buf;
}

const encodeRosterRequest = ({ session }) => encodeSessionOnly(MSG.ROSTER_REQUEST, session);
const encodeBye = ({ session }) => encodeSessionOnly(MSG.BYE, session);

// players: [{ id, name }]. Returns one or more packets, each a page of the list.
function encodeRoster({ rosterVersion, players }) {
  const fixed = HEADER + 2 + 2 + 2 + 2; // version, page, pages, count
  const pages = [[]];
  let size = fixed;
  for (const p of players) {
    const entry = 2 + 1 + Buffer.byteLength(p.name, "utf8");
    if (size + entry > MAX_PACKET) {
      pages.push([]);
      size = fixed;
    }
    pages[pages.length - 1].push(p);
    size += entry;
  }
  return pages.map((page, index) => {
    const buf = header(MSG.ROSTER, fixed + page.reduce((n, p) => n + 3 + Buffer.byteLength(p.name, "utf8"), 0));
    buf.writeUInt16LE(rosterVersion & 0xffff, HEADER);
    buf.writeUInt16LE(index, HEADER + 2);
    buf.writeUInt16LE(pages.length, HEADER + 4);
    buf.writeUInt16LE(page.length, HEADER + 6);
    let offset = fixed;
    for (const p of page) {
      buf.writeUInt16LE(p.id, offset);
      offset = writeText(buf, offset + 2, p.name, 1);
    }
    return buf;
  });
}

function encodeTextMessage(type, text) {
  const value = String(text).slice(0, 500);
  const buf = header(type, HEADER + 2 + Buffer.byteLength(value, "utf8"));
  writeText(buf, HEADER, value, 2);
  return buf;
}

const encodeKick = ({ reason }) => encodeTextMessage(MSG.KICK, reason);
const encodeNotice = ({ text }) => encodeTextMessage(MSG.NOTICE, text);

// ---- Decoder ----

// Returns { type, ...fields } or null if the packet is malformed.
function decode(buf) {
  const type = readType(buf);
  if (type === null) return null;
  const at = (n) => buf.length >= HEADER + n;
  switch (type) {
    case MSG.HELLO: {
      if (!at(5)) return null;
      const name = readText(buf, HEADER + 4, 1);
      if (!name || name.next !== buf.length) return null;
      return { type, nonce: buf.readUInt32LE(HEADER), name: name.text };
    }
    case MSG.WELCOME:
      if (buf.length !== HEADER + 15) return null;
      return {
        type,
        nonce: buf.readUInt32LE(HEADER),
        session: buf.readUInt32LE(HEADER + 4),
        playerId: buf.readUInt16LE(HEADER + 8),
        tickRate: buf.readUInt8(HEADER + 10),
        serverTime: buf.readUInt32LE(HEADER + 11)
      };
    case MSG.REJECT: {
      if (!at(5)) return null;
      const reason = readText(buf, HEADER + 4, 1);
      if (!reason || reason.next !== buf.length) return null;
      return { type, nonce: buf.readUInt32LE(HEADER), reason: reason.text };
    }
    case MSG.STATE:
      if (buf.length !== HEADER + 10 + STATE_FIELDS_BYTES) return null;
      return {
        type,
        session: buf.readUInt32LE(HEADER),
        seq: buf.readUInt16LE(HEADER + 4),
        clientTime: buf.readUInt32LE(HEADER + 6),
        state: readState(buf, HEADER + 10)
      };
    case MSG.SNAPSHOT: {
      if (buf.length < SNAPSHOT_HEADER_BYTES) return null;
      const count = buf.readUInt8(HEADER + 10);
      if (buf.length !== SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_ENTRY_BYTES) return null;
      const entries = [];
      for (let i = 0, offset = SNAPSHOT_HEADER_BYTES; i < count; i++, offset += SNAPSHOT_ENTRY_BYTES) {
        entries.push({ playerId: buf.readUInt16LE(offset), seq: buf.readUInt16LE(offset + 2), state: readState(buf, offset + 4) });
      }
      return {
        type,
        tick: buf.readUInt32LE(HEADER),
        serverTime: buf.readUInt32LE(HEADER + 4),
        rosterVersion: buf.readUInt16LE(HEADER + 8),
        entries
      };
    }
    case MSG.ROSTER_REQUEST:
    case MSG.BYE:
      if (buf.length !== HEADER + 4) return null;
      return { type, session: buf.readUInt32LE(HEADER) };
    case MSG.ROSTER: {
      if (!at(8)) return null;
      const count = buf.readUInt16LE(HEADER + 6);
      const players = [];
      let offset = HEADER + 8;
      for (let i = 0; i < count; i++) {
        if (offset + 2 > buf.length) return null;
        const id = buf.readUInt16LE(offset);
        const name = readText(buf, offset + 2, 1);
        if (!name) return null;
        players.push({ id, name: name.text });
        offset = name.next;
      }
      if (offset !== buf.length) return null;
      return {
        type,
        rosterVersion: buf.readUInt16LE(HEADER),
        page: buf.readUInt16LE(HEADER + 2),
        pages: buf.readUInt16LE(HEADER + 4),
        players
      };
    }
    case MSG.KICK:
    case MSG.NOTICE: {
      const text = readText(buf, HEADER, 2);
      if (!text || text.next !== buf.length) return null;
      return type === MSG.KICK ? { type, reason: text.text } : { type, text: text.text };
    }
    default:
      return null;
  }
}

// True if sequence number a is newer than b, allowing for the 16-bit counter wrapping around.
function seqNewer(a, b) {
  const diff = (a - b) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}

// ---- Interpolation, for the client: show other players slightly in the past, smoothly ----

const lerp = (a, b, t) => a + (b - a) * t;

function lerpAngle(a, b, t) {
  let diff = ((b - a) % 360 + 540) % 360 - 180;
  return (a + diff * t + 360) % 360;
}

// Keeps a short history of one remote player's states and answers "where were they at time t".
// delayMs: how far behind the newest snapshot to render (about two snapshot intervals works well).
// maxExtrapolateMs: how long to keep moving along the last velocity when snapshots stop arriving.
function createInterpolator({ delayMs = 100, maxExtrapolateMs = 250, historySize = 32 } = {}) {
  const history = []; // [{ time, state }], oldest first

  return {
    push(time, state) {
      if (history.length && time <= history[history.length - 1].time) return;
      history.push({ time, state });
      if (history.length > historySize) history.shift();
    },

    // now: the server clock as the client estimates it. Returns a state, or null before the first push.
    sample(now) {
      if (!history.length) return null;
      const target = now - delayMs;
      if (target <= history[0].time) return history[0].state;
      for (let i = history.length - 1; i > 0; i--) {
        const a = history[i - 1];
        const b = history[i];
        if (target >= a.time && target <= b.time) {
          const t = (target - a.time) / (b.time - a.time || 1);
          return {
            ...b.state,
            position: {
              x: lerp(a.state.position.x, b.state.position.x, t),
              y: lerp(a.state.position.y, b.state.position.y, t),
              z: lerp(a.state.position.z, b.state.position.z, t)
            },
            velocity: b.state.velocity,
            heading: lerpAngle(a.state.heading, b.state.heading, t)
          };
        }
      }
      // Past the newest state: extrapolate along its velocity for a short while, then hold.
      const last = history[history.length - 1];
      const dt = Math.min(target - last.time, maxExtrapolateMs) / 1000;
      return {
        ...last.state,
        position: {
          x: last.state.position.x + last.state.velocity.x * dt,
          y: last.state.position.y + last.state.velocity.y * dt,
          z: last.state.position.z + last.state.velocity.z * dt
        }
      };
    }
  };
}

module.exports = {
  SYNC_VERSION,
  SYNC_MAX_PACKET: MAX_PACKET,
  SYNC_MSG: MSG,
  SYNC_FLAG: FLAG,
  SNAPSHOT_MAX_ENTRIES,
  encodeHello,
  encodeWelcome,
  encodeReject,
  encodeState,
  encodeSnapshot,
  encodeRosterRequest,
  encodeRoster,
  encodeBye,
  encodeKick,
  encodeNotice,
  decodeSync: decode,
  seqNewer,
  lerpAngle,
  createInterpolator
};
