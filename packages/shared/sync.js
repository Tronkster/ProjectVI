// Player sync over UDP: the binary messages a game server and the ProjectVI client exchange.
// docs/protocol.md ("Player sync") describes the same format for people. Both sides use this file, so
// they can't drift apart; test/sync-vectors.json has example packets for clients written in other languages.
//
// Every packet starts with a 4-byte header: "PV", the sync version, and the message type.
// Numbers are little-endian. Floats are 32-bit. Nothing here is trusted: decoders return null for
// anything malformed, and the server still checks values (positions, speeds, sequence numbers).

const SYNC_VERSION = 3;
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
  ROSTER: 7, // server -> client: who's who (id, name, character, host), one page
  BYE: 8, // client -> server: leaving
  KICK: 9, // server -> client: you were removed, with a reason
  // 10 was NOTICE: notices are reliable messages now
  VEHICLE_STATE: 11, // client -> server: a vehicle this client controls, every tick
  VEHICLES: 12, // server -> client: vehicles near the player
  VEHICLE_ASSIGN: 13, // server -> client: the vehicle id for a vehicle the client registered
  PING: 14, // client -> server: once a second, with the client's last round trip time
  PONG: 15, // server -> client: the answer to PING
  RELIABLE: 16 // both ways: acknowledgements and reliable messages (reliable.js)
});

// Player state flags
const FLAG = Object.freeze({
  IN_VEHICLE: 1,
  ON_FOOT_MOVING: 2,
  AIMING: 4,
  DEAD: 8,
  CROUCHED: 16,
  JUMPING: 32,
  RAGDOLL: 64,
  SHOOTING: 128,
  SWIMMING: 256
});

// Roster entry flags
const PLAYER_FLAG = Object.freeze({
  HOST: 1 // this player's game runs the story; the others follow it
});

// Vehicle state flags
const VEHICLE_FLAG = Object.freeze({
  ENGINE_ON: 1,
  LIGHTS: 2,
  SIREN: 4,
  HORN: 8,
  DESTROYED: 16
});

// Player: position, velocity, heading (7 floats), flags, model, health, armour, weapon, aim point (3 floats), vehicle id, seat
const STATE_FIELDS_BYTES = 28 + 2 + 4 + 2 + 1 + 4 + 12 + 2 + 1;
// Vehicle: model, position, rotation (quaternion), velocity, health, steering, flags
const VEHICLE_FIELDS_BYTES = 4 + 12 + 16 + 12 + 2 + 1 + 1;

const SNAPSHOT_HEADER_BYTES = HEADER + 4 + 4 + 2 + 1; // tick, server time, roster version, count
const SNAPSHOT_ENTRY_BYTES = 2 + 2 + STATE_FIELDS_BYTES; // player id, last sequence, state
const SNAPSHOT_MAX_ENTRIES = Math.floor((MAX_PACKET - SNAPSHOT_HEADER_BYTES) / SNAPSHOT_ENTRY_BYTES);
const VEHICLES_HEADER_BYTES = HEADER + 4 + 4 + 1; // tick, server time, count
const VEHICLES_ENTRY_BYTES = 2 + 2 + VEHICLE_FIELDS_BYTES; // vehicle id, controlling player id, state
const VEHICLES_MAX_ENTRIES = Math.floor((MAX_PACKET - VEHICLES_HEADER_BYTES) / VEHICLES_ENTRY_BYTES);
const VEHICLE_STATE_BYTES = HEADER + 4 + 2 + 2 + 2 + VEHICLE_FIELDS_BYTES; // session, sequence, vehicle id, local id
const RELIABLE_HEADER_BYTES = HEADER + 4 + 2 + 4 + 1; // session, ack, ack bits, count
const RELIABLE_MESSAGE_OVERHEAD = 2 + 1 + 2; // sequence, flags, length
const RELIABLE_PACKET_BUDGET = MAX_PACKET - RELIABLE_HEADER_BYTES; // room for messages in one packet
const RELIABLE_MORE = 1; // message flag: more fragments of the same message follow

// What a reliable message carries: the first byte says which kind.
const CHANNEL = Object.freeze({
  CHAT: 1, // client -> server: a chat line or /command. server -> client: a chat line from a player
  EVENT: 2, // both ways: a script event, name and JSON arguments
  NOTICE: 3 // server -> client: a message to show the player
});

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

// Whole numbers that must fit a field are clamped rather than wrapped: 70000 health is 65535, not 4464.
const clampInt = (value, max) => Math.min(max, Math.max(0, Math.round(value) || 0));

function writeVec(buf, offset, v) {
  buf.writeFloatLE(v.x, offset);
  buf.writeFloatLE(v.y, offset + 4);
  buf.writeFloatLE(v.z, offset + 8);
}

function readVec(buf, offset) {
  return { x: buf.readFloatLE(offset), y: buf.readFloatLE(offset + 4), z: buf.readFloatLE(offset + 8) };
}

// ---- Player state: what the client reports about its player and the server relays ----

function writeState(buf, offset, s) {
  writeVec(buf, offset, s.position);
  writeVec(buf, offset + 12, s.velocity);
  buf.writeFloatLE(s.heading, offset + 24);
  buf.writeUInt16LE(s.flags & 0xffff, offset + 28);
  buf.writeUInt32LE(s.model >>> 0, offset + 30);
  buf.writeUInt16LE(clampInt(s.health, 0xffff), offset + 34);
  buf.writeUInt8(clampInt(s.armour, 0xff), offset + 36);
  buf.writeUInt32LE(s.weapon >>> 0, offset + 37);
  writeVec(buf, offset + 41, s.aim);
  buf.writeUInt16LE(s.vehicleId & 0xffff, offset + 53);
  buf.writeUInt8(s.seat & 0xff, offset + 55);
  return offset + STATE_FIELDS_BYTES;
}

function readState(buf, offset) {
  return {
    position: readVec(buf, offset),
    velocity: readVec(buf, offset + 12),
    heading: buf.readFloatLE(offset + 24),
    flags: buf.readUInt16LE(offset + 28),
    model: buf.readUInt32LE(offset + 30),
    health: buf.readUInt16LE(offset + 34),
    armour: buf.readUInt8(offset + 36),
    weapon: buf.readUInt32LE(offset + 37),
    aim: readVec(buf, offset + 41),
    vehicleId: buf.readUInt16LE(offset + 53),
    seat: buf.readUInt8(offset + 55)
  };
}

// ---- Vehicle state: what the controlling client reports about a vehicle ----

function writeVehicle(buf, offset, v) {
  buf.writeUInt32LE(v.model >>> 0, offset);
  writeVec(buf, offset + 4, v.position);
  buf.writeFloatLE(v.rotation.x, offset + 16);
  buf.writeFloatLE(v.rotation.y, offset + 20);
  buf.writeFloatLE(v.rotation.z, offset + 24);
  buf.writeFloatLE(v.rotation.w, offset + 28);
  writeVec(buf, offset + 32, v.velocity);
  buf.writeUInt16LE(clampInt(v.health, 0xffff), offset + 44);
  buf.writeInt8(Math.round(Math.min(1, Math.max(-1, v.steering || 0)) * 127), offset + 46);
  buf.writeUInt8(v.flags & 0xff, offset + 47);
  return offset + VEHICLE_FIELDS_BYTES;
}

function readVehicle(buf, offset) {
  return {
    model: buf.readUInt32LE(offset),
    position: readVec(buf, offset + 4),
    rotation: { x: buf.readFloatLE(offset + 16), y: buf.readFloatLE(offset + 20), z: buf.readFloatLE(offset + 24), w: buf.readFloatLE(offset + 28) },
    velocity: readVec(buf, offset + 32),
    health: buf.readUInt16LE(offset + 44),
    steering: buf.readInt8(offset + 46) / 127, // 1 full left, -1 full right
    flags: buf.readUInt8(offset + 47)
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

// vehicleId 0 registers a vehicle the server doesn't know yet; localId is the client's own number for it,
// echoed back in VEHICLE_ASSIGN.
function encodeVehicleState({ session, seq, vehicleId, localId, state }) {
  const buf = header(MSG.VEHICLE_STATE, VEHICLE_STATE_BYTES);
  buf.writeUInt32LE(session >>> 0, HEADER);
  buf.writeUInt16LE(seq & 0xffff, HEADER + 4);
  buf.writeUInt16LE(vehicleId & 0xffff, HEADER + 6);
  buf.writeUInt16LE(localId & 0xffff, HEADER + 8);
  writeVehicle(buf, HEADER + 10, state);
  return buf;
}

// entries: [{ vehicleId, controller, state }], at most VEHICLES_MAX_ENTRIES. controller 0: nobody.
function encodeVehicles({ tick, serverTime, entries }) {
  if (entries.length > VEHICLES_MAX_ENTRIES) throw new Error(`A vehicles message holds at most ${VEHICLES_MAX_ENTRIES} vehicles.`);
  const buf = header(MSG.VEHICLES, VEHICLES_HEADER_BYTES + entries.length * VEHICLES_ENTRY_BYTES);
  buf.writeUInt32LE(tick >>> 0, HEADER);
  buf.writeUInt32LE(serverTime >>> 0, HEADER + 4);
  buf.writeUInt8(entries.length, HEADER + 8);
  let offset = VEHICLES_HEADER_BYTES;
  for (const e of entries) {
    buf.writeUInt16LE(e.vehicleId, offset);
    buf.writeUInt16LE(e.controller, offset + 2);
    offset = writeVehicle(buf, offset + 4, e.state);
  }
  return buf;
}

function encodeVehicleAssign({ localId, vehicleId }) {
  const buf = header(MSG.VEHICLE_ASSIGN, HEADER + 4);
  buf.writeUInt16LE(localId & 0xffff, HEADER);
  buf.writeUInt16LE(vehicleId & 0xffff, HEADER + 2);
  return buf;
}

// rtt: the client's last measured round trip in ms (0 before the first PONG).
function encodePing({ session, clientTime, rtt }) {
  const buf = header(MSG.PING, HEADER + 4 + 4 + 2);
  buf.writeUInt32LE(session >>> 0, HEADER);
  buf.writeUInt32LE(clientTime >>> 0, HEADER + 4);
  buf.writeUInt16LE(clampInt(rtt, 0xffff), HEADER + 8);
  return buf;
}

function encodePong({ clientTime, serverTime }) {
  const buf = header(MSG.PONG, HEADER + 4 + 4);
  buf.writeUInt32LE(clientTime >>> 0, HEADER);
  buf.writeUInt32LE(serverTime >>> 0, HEADER + 4);
  return buf;
}

function encodeSessionOnly(type, session) {
  const buf = header(type, HEADER + 4);
  buf.writeUInt32LE(session >>> 0, HEADER);
  return buf;
}

const encodeRosterRequest = ({ session }) => encodeSessionOnly(MSG.ROSTER_REQUEST, session);
const encodeBye = ({ session }) => encodeSessionOnly(MSG.BYE, session);

// Roster entry: player id, flags, character model hash (0: none assigned, the client picks), then the name.
const ROSTER_ENTRY_FIXED = 2 + 1 + 4 + 1;
const rosterEntryBytes = (p) => ROSTER_ENTRY_FIXED + Buffer.byteLength(p.name, "utf8");

// players: [{ id, name, character, host }]. Returns one or more packets, each a page of the list.
function encodeRoster({ rosterVersion, players }) {
  const fixed = HEADER + 2 + 2 + 2 + 2; // version, page, pages, count
  const pages = [[]];
  let size = fixed;
  for (const p of players) {
    const entry = rosterEntryBytes(p);
    if (size + entry > MAX_PACKET) {
      pages.push([]);
      size = fixed;
    }
    pages[pages.length - 1].push(p);
    size += entry;
  }
  return pages.map((page, index) => {
    const buf = header(MSG.ROSTER, fixed + page.reduce((n, p) => n + rosterEntryBytes(p), 0));
    buf.writeUInt16LE(rosterVersion & 0xffff, HEADER);
    buf.writeUInt16LE(index, HEADER + 2);
    buf.writeUInt16LE(pages.length, HEADER + 4);
    buf.writeUInt16LE(page.length, HEADER + 6);
    let offset = fixed;
    for (const p of page) {
      buf.writeUInt16LE(p.id, offset);
      buf.writeUInt8(p.host ? PLAYER_FLAG.HOST : 0, offset + 2);
      buf.writeUInt32LE((p.character ?? 0) >>> 0, offset + 3);
      offset = writeText(buf, offset + 7, p.name, 1);
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

// messages: [{ seq, more, payload }], as ReliableChannel.poll() returns them. The server sends the
// client's own session, so both directions share one format.
function encodeReliable({ session, ack, ackBits, messages }) {
  const size = RELIABLE_HEADER_BYTES + messages.reduce((n, m) => n + RELIABLE_MESSAGE_OVERHEAD + m.payload.length, 0);
  if (size > MAX_PACKET || messages.length > 255) throw new Error("Too many reliable messages for one packet.");
  const buf = header(MSG.RELIABLE, size);
  buf.writeUInt32LE(session >>> 0, HEADER);
  buf.writeUInt16LE(ack & 0xffff, HEADER + 4);
  buf.writeUInt32LE(ackBits >>> 0, HEADER + 6);
  buf.writeUInt8(messages.length, HEADER + 10);
  let offset = RELIABLE_HEADER_BYTES;
  for (const m of messages) {
    buf.writeUInt16LE(m.seq & 0xffff, offset);
    buf.writeUInt8(m.more ? RELIABLE_MORE : 0, offset + 2);
    buf.writeUInt16LE(m.payload.length, offset + 3);
    m.payload.copy(buf, offset + 5);
    offset += RELIABLE_MESSAGE_OVERHEAD + m.payload.length;
  }
  return buf;
}

// ---- Reliable message payloads ----

function channelText(kind, prefixBytes, text, max) {
  const value = Buffer.from(String(text).slice(0, max), "utf8");
  const buf = Buffer.alloc(1 + prefixBytes + 2 + value.length);
  buf.writeUInt8(kind, 0);
  buf.writeUInt16LE(value.length, 1 + prefixBytes);
  value.copy(buf, 3 + prefixBytes);
  return buf;
}

// playerId: who said it (server -> client); 0 from a client.
function encodeChat({ playerId = 0, text }) {
  const buf = channelText(CHANNEL.CHAT, 2, text, 500);
  buf.writeUInt16LE(playerId, 1);
  return buf;
}

const encodeChannelNotice = ({ text }) => channelText(CHANNEL.NOTICE, 0, text, 500);

// args: an array, sent as JSON.
function encodeEvent({ name, args = [] }) {
  const nameBytes = Buffer.from(String(name), "utf8");
  if (nameBytes.length > 255) throw new Error("Event names can be at most 255 bytes.");
  const json = Buffer.from(JSON.stringify(args), "utf8");
  const buf = Buffer.alloc(1 + 1 + nameBytes.length + json.length);
  buf.writeUInt8(CHANNEL.EVENT, 0);
  buf.writeUInt8(nameBytes.length, 1);
  nameBytes.copy(buf, 2);
  json.copy(buf, 2 + nameBytes.length);
  return buf;
}

// Returns { kind, ...fields } or null for anything malformed, including event arguments that aren't a JSON array.
function decodeChannelMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) return null;
  const kind = buf[0];
  if (kind === CHANNEL.CHAT) {
    if (buf.length < 5) return null;
    const text = readText(buf, 3, 2);
    if (!text || text.next !== buf.length) return null;
    return { kind, playerId: buf.readUInt16LE(1), text: text.text };
  }
  if (kind === CHANNEL.NOTICE) {
    const text = readText(buf, 1, 2);
    if (!text || text.next !== buf.length) return null;
    return { kind, text: text.text };
  }
  if (kind === CHANNEL.EVENT) {
    const name = readText(buf, 1, 1);
    if (!name || !name.text) return null;
    let args;
    try {
      args = JSON.parse(buf.toString("utf8", name.next));
    } catch {
      return null;
    }
    if (!Array.isArray(args)) return null;
    return { kind, name: name.text, args };
  }
  return null;
}

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
    case MSG.VEHICLE_STATE:
      if (buf.length !== VEHICLE_STATE_BYTES) return null;
      return {
        type,
        session: buf.readUInt32LE(HEADER),
        seq: buf.readUInt16LE(HEADER + 4),
        vehicleId: buf.readUInt16LE(HEADER + 6),
        localId: buf.readUInt16LE(HEADER + 8),
        state: readVehicle(buf, HEADER + 10)
      };
    case MSG.VEHICLES: {
      if (buf.length < VEHICLES_HEADER_BYTES) return null;
      const count = buf.readUInt8(HEADER + 8);
      if (buf.length !== VEHICLES_HEADER_BYTES + count * VEHICLES_ENTRY_BYTES) return null;
      const entries = [];
      for (let i = 0, offset = VEHICLES_HEADER_BYTES; i < count; i++, offset += VEHICLES_ENTRY_BYTES) {
        entries.push({ vehicleId: buf.readUInt16LE(offset), controller: buf.readUInt16LE(offset + 2), state: readVehicle(buf, offset + 4) });
      }
      return { type, tick: buf.readUInt32LE(HEADER), serverTime: buf.readUInt32LE(HEADER + 4), entries };
    }
    case MSG.VEHICLE_ASSIGN:
      if (buf.length !== HEADER + 4) return null;
      return { type, localId: buf.readUInt16LE(HEADER), vehicleId: buf.readUInt16LE(HEADER + 2) };
    case MSG.PING:
      if (buf.length !== HEADER + 10) return null;
      return { type, session: buf.readUInt32LE(HEADER), clientTime: buf.readUInt32LE(HEADER + 4), rtt: buf.readUInt16LE(HEADER + 8) };
    case MSG.PONG:
      if (buf.length !== HEADER + 8) return null;
      return { type, clientTime: buf.readUInt32LE(HEADER), serverTime: buf.readUInt32LE(HEADER + 4) };
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
        if (offset + 7 > buf.length) return null;
        const id = buf.readUInt16LE(offset);
        const host = (buf.readUInt8(offset + 2) & PLAYER_FLAG.HOST) !== 0;
        const character = buf.readUInt32LE(offset + 3);
        const name = readText(buf, offset + 7, 1);
        if (!name) return null;
        players.push({ id, name: name.text, character, host });
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
    case MSG.RELIABLE: {
      if (buf.length < RELIABLE_HEADER_BYTES) return null;
      const count = buf.readUInt8(HEADER + 10);
      const messages = [];
      let offset = RELIABLE_HEADER_BYTES;
      for (let i = 0; i < count; i++) {
        if (offset + RELIABLE_MESSAGE_OVERHEAD > buf.length) return null;
        const length = buf.readUInt16LE(offset + 3);
        const end = offset + RELIABLE_MESSAGE_OVERHEAD + length;
        if (end > buf.length) return null;
        messages.push({ seq: buf.readUInt16LE(offset), more: (buf.readUInt8(offset + 2) & RELIABLE_MORE) !== 0, payload: Buffer.from(buf.subarray(offset + 5, end)) });
        offset = end;
      }
      if (offset !== buf.length) return null;
      return { type, session: buf.readUInt32LE(HEADER), ack: buf.readUInt16LE(HEADER + 4), ackBits: buf.readUInt32LE(HEADER + 6), messages };
    }
    case MSG.KICK: {
      const text = readText(buf, HEADER, 2);
      if (!text || text.next !== buf.length) return null;
      return { type, reason: text.text };
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

// ---- Rotations ----
// Headings are degrees, 0 = north (+y), turning counter-clockwise, as the game's scripts use them.
// A vehicle's rotation is a unit quaternion { x, y, z, w }; a heading is a turn about the up (z) axis.

function quatFromHeading(degrees) {
  const half = ((Number(degrees) || 0) * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

function headingFromQuat(q) {
  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  return ((yaw * 180) / Math.PI + 360) % 360;
}

// ---- Interpolation, for the client: show other players and vehicles slightly in the past, smoothly ----

const lerp = (a, b, t) => a + (b - a) * t;
const lerpVec = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

function lerpAngle(a, b, t) {
  let diff = ((b - a) % 360 + 540) % 360 - 180;
  return (a + diff * t + 360) % 360;
}

// Blends two rotations. q and -q are the same rotation, so flip one when they point apart, or the blend
// takes the long way round and the vehicle spins.
function nlerp(a, b, t) {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const q = { x: lerp(a.x, b.x * sign, t), y: lerp(a.y, b.y * sign, t), z: lerp(a.z, b.z * sign, t), w: lerp(a.w, b.w * sign, t) };
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function blend(a, b, t) {
  const out = { ...b, position: lerpVec(a.position, b.position, t), velocity: b.velocity };
  if (typeof a.heading === "number" && typeof b.heading === "number") out.heading = lerpAngle(a.heading, b.heading, t);
  if (a.rotation && b.rotation) out.rotation = nlerp(a.rotation, b.rotation, t);
  return out;
}

// Keeps a short history of one remote player's or vehicle's states and answers "where was it at time t".
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
        if (target >= a.time && target <= b.time) return blend(a.state, b.state, (target - a.time) / (b.time - a.time || 1));
      }
      // Past the newest state: extrapolate along its velocity for a short while, then hold.
      // Rotation is held as it was.
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
  SYNC_PLAYER_FLAG: PLAYER_FLAG,
  SYNC_CHANNEL: CHANNEL,
  RELIABLE_PACKET_BUDGET,
  RELIABLE_MESSAGE_OVERHEAD,
  SYNC_VEHICLE_FLAG: VEHICLE_FLAG,
  SNAPSHOT_MAX_ENTRIES,
  VEHICLES_MAX_ENTRIES,
  encodeHello,
  encodeWelcome,
  encodeReject,
  encodeState,
  encodeSnapshot,
  encodeVehicleState,
  encodeVehicles,
  encodeVehicleAssign,
  encodePing,
  encodePong,
  encodeRosterRequest,
  encodeRoster,
  encodeBye,
  encodeKick,
  encodeReliable,
  encodeChat,
  encodeChannelNotice,
  encodeEvent,
  decodeChannelMessage,
  decodeSync: decode,
  seqNewer,
  lerpAngle,
  quatFromHeading,
  headingFromQuat,
  createInterpolator
};
