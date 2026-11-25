// Player sync: a UDP channel on the game port. Clients join with HELLO, send their state every tick,
// and get snapshots of the players near them. Format: packages/shared/sync.js and docs/protocol.md.
//
// UDP is used because state is replaced every tick: a lost packet is better skipped than resent.
// Nothing here is reliable; anything that must arrive (chat, script events) needs the reliable channel,
// which isn't built yet.

const dgram = require("node:dgram");
const crypto = require("node:crypto");
const {
  SYNC_MSG,
  SNAPSHOT_MAX_ENTRIES,
  encodeWelcome,
  encodeReject,
  encodeSnapshot,
  encodeRoster,
  encodeKick,
  encodeNotice,
  decodeSync,
  seqNewer,
  validatePlayerName
} = require("@projectvi/shared");

// Sanity limits for reported state. GTA-scale maps fit easily; anything outside is a broken or
// dishonest client, and the packet is dropped.
const MAX_COORD = 50_000;
const MAX_SPEED = 250; // m/s, faster than any vehicle should go
const MAX_STATES_PER_SECOND = 90; // clients send at the tick rate; this leaves room for bursts
const HELLOS_PER_SECOND_PER_IP = 5;

const finite = (v) => Number.isFinite(v);

function validState(s) {
  const p = s.position;
  const v = s.velocity;
  if (![p.x, p.y, p.z, v.x, v.y, v.z, s.heading].every(finite)) return false;
  if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD || Math.abs(p.z) > MAX_COORD) return false;
  if (Math.hypot(v.x, v.y, v.z) > MAX_SPEED) return false;
  return true;
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

class SyncServer {
  // core: ServerCore. options: { tickRate, streamRadius, timeoutSeconds, maxPlayers, now }
  constructor({ core, log, tickRate = 20, streamRadius = 500, timeoutSeconds = 10, maxPlayers = 32, now = () => Date.now() }) {
    this.core = core;
    this.log = log;
    this.tickRate = tickRate;
    this.streamRadiusSq = streamRadius * streamRadius;
    this.timeoutMs = timeoutSeconds * 1000;
    this.maxPlayers = maxPlayers;
    this.now = now;
    this.startedAt = now();
    this.sessions = new Map(); // session -> { session, playerId, address, port, lastSeen, lastSeq, state, budget }
    this.byPlayer = new Map(); // playerId -> session
    this.helloBudget = new Map(); // ip -> { second, count }
    this.rosterVersion = 0;
    this.tick = 0;
    this.socket = null;
    this.timer = null;
  }

  serverTime() {
    return (this.now() - this.startedAt) >>> 0;
  }

  // Binds UDP on the given port. Resolves with the bound port.
  listen(port, bind = "0.0.0.0") {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", reject);
      socket.on("message", (buf, rinfo) => this.handle(buf, rinfo));
      socket.bind(port, bind, () => {
        socket.off("error", reject);
        socket.on("error", (err) => this.log.error(`Sync socket error: ${err.message}`));
        this.socket = socket;
        this.timer = setInterval(() => this.step(), Math.round(1000 / this.tickRate));
        resolve(socket.address().port);
      });
    });
  }

  close() {
    clearInterval(this.timer);
    for (const s of [...this.sessions.values()]) this.drop(s, "Server shutting down", { kick: true });
    return new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
  }

  send(buf, address, port) {
    this.socket?.send(buf, port, address);
  }

  // ---- Incoming ----

  handle(buf, rinfo) {
    const msg = decodeSync(buf);
    if (!msg) return; // not ours, or malformed: ignore silently
    if (msg.type === SYNC_MSG.HELLO) return this.onHello(msg, rinfo);

    // Everything else must come from the address the session joined from.
    const s = this.sessions.get(msg.session);
    if (!s || s.address !== rinfo.address || s.port !== rinfo.port) return;
    s.lastSeen = this.now();

    if (msg.type === SYNC_MSG.STATE) this.onState(s, msg);
    else if (msg.type === SYNC_MSG.ROSTER_REQUEST) this.sendRoster(s);
    else if (msg.type === SYNC_MSG.BYE) this.drop(s, "Left");
  }

  onHello({ nonce, name }, { address, port }) {
    const second = Math.floor(this.now() / 1000);
    const budget = this.helloBudget.get(address);
    if (budget?.second === second && budget.count >= HELLOS_PER_SECOND_PER_IP) return;
    this.helloBudget.set(address, { second, count: budget?.second === second ? budget.count + 1 : 1 });

    // A repeated HELLO (the WELCOME was lost) gets the same session back.
    for (const s of this.sessions.values()) {
      if (s.address === address && s.port === port && s.nonce === nonce) {
        this.send(encodeWelcome({ nonce, session: s.session, playerId: s.playerId, tickRate: this.tickRate, serverTime: this.serverTime() }), address, port);
        return;
      }
    }

    const checked = validatePlayerName(name);
    if (!checked.ok) return this.send(encodeReject({ nonce, reason: `Name not allowed: ${checked.error}` }), address, port);
    if (this.core.players.list().length >= this.maxPlayers) return this.send(encodeReject({ nonce, reason: "The server is full." }), address, port);

    let session;
    do session = crypto.randomBytes(4).readUInt32LE(0);
    while (session === 0 || this.sessions.has(session));

    const record = { session, nonce, address, port, lastSeen: this.now(), lastSeq: null, state: null, budget: { second, count: 0 }, playerId: 0 };
    const connection = {
      notify: (text) => this.send(encodeNotice({ text }), address, port),
      close: (reason) => {
        if (this.sessions.has(session)) this.drop(record, reason, { kick: true, fromCore: true });
      }
    };
    // Identity isn't verified yet (no login on this channel), so the only identifier is the session.
    const player = this.core.addPlayer({ name: checked.name, identifiers: [`session:${session.toString(16)}`], connection });
    record.playerId = player.id;
    this.sessions.set(session, record);
    this.byPlayer.set(player.id, session);
    this.rosterVersion = (this.rosterVersion + 1) & 0xffff;
    this.send(encodeWelcome({ nonce, session, playerId: player.id, tickRate: this.tickRate, serverTime: this.serverTime() }), address, port);
  }

  onState(s, { seq, state }) {
    const second = Math.floor(this.now() / 1000);
    if (s.budget.second !== second) s.budget = { second, count: 0 };
    if (++s.budget.count > MAX_STATES_PER_SECOND) return;
    if (s.lastSeq !== null && !seqNewer(seq, s.lastSeq)) return; // late or repeated: a newer one already arrived
    if (!validState(state)) return;

    s.lastSeq = seq;
    s.state = { ...state, heading: ((state.heading % 360) + 360) % 360 };
    const player = this.core.players.get(s.playerId);
    if (player) {
      player.position = { ...s.state.position };
      player.sync = s.state;
    }
  }

  // ---- Outgoing ----

  sendRoster(s) {
    const players = this.core.players.list().filter((p) => this.byPlayer.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
    for (const page of encodeRoster({ rosterVersion: this.rosterVersion, players })) this.send(page, s.address, s.port);
  }

  // One tick: time out silent players, then send each player the others near them.
  step() {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastSeen > this.timeoutMs) this.drop(s, "Timed out", { kick: true });
    }

    this.tick = (this.tick + 1) >>> 0;
    const serverTime = this.serverTime();
    const live = [...this.sessions.values()].filter((s) => s.state);
    for (const viewer of this.sessions.values()) {
      const near = viewer.state
        ? live.filter((o) => o !== viewer && distanceSquared(o.state.position, viewer.state.position) <= this.streamRadiusSq)
        : []; // until we know where the viewer is, send nothing but the heartbeat snapshot
      const entries = near.map((o) => ({ playerId: o.playerId, seq: o.lastSeq, state: o.state }));
      // Always send at least one (possibly empty) snapshot, so the client sees the server is alive
      // and learns the roster version.
      for (let i = 0; i === 0 || i < entries.length; i += SNAPSHOT_MAX_ENTRIES) {
        const buf = encodeSnapshot({ tick: this.tick, serverTime, rosterVersion: this.rosterVersion, entries: entries.slice(i, i + SNAPSHOT_MAX_ENTRIES) });
        this.send(buf, viewer.address, viewer.port);
      }
    }
  }

  // Removes a session. fromCore: the core is already removing the player (a kick from a script).
  drop(s, reason, { kick = false, fromCore = false } = {}) {
    if (!this.sessions.delete(s.session)) return;
    this.byPlayer.delete(s.playerId);
    this.rosterVersion = (this.rosterVersion + 1) & 0xffff;
    if (kick) this.send(encodeKick({ reason }), s.address, s.port);
    if (!fromCore) this.core.removePlayer(s.playerId, reason);
  }

  // For tests and the console.
  stats() {
    return { players: this.sessions.size, tick: this.tick, rosterVersion: this.rosterVersion };
  }
}

module.exports = { SyncServer, validState, MAX_COORD, MAX_SPEED };
