// The client side of player sync, written once in Node: join, send the local player's state, and keep a
// smoothed view of the players around us. The game client will be native code; this is the reference
// it copies, and what `npm run dev:bots` uses to test servers before the game can join.
// Format: sync.js and docs/protocol.md ("Player sync").
//
// Not exported from index.js, because it opens sockets: require("@projectvi/shared/sync-client").

const dgram = require("node:dgram");
const dns = require("node:dns/promises");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { SYNC_MSG, encodeHello, encodeState, encodeRosterRequest, encodeBye, decodeSync, createInterpolator } = require("./sync");

const UPDATE_MS = 250; // how often timeouts, stream-outs and roster retries are checked
const ROSTER_RETRY_MS = 1000;
const CLOCK_WINDOW = 40; // snapshots kept for the server clock estimate: 2 s at 20 a second

// Events:
//   "snapshot" (msg)           every snapshot packet, after it's applied
//   "streamIn" (playerId)      a player came into range: spawn their ped
//   "streamOut" (playerId)     a player left range or the server: remove their ped
//   "roster" (names)           Map of player id -> name, after it changed
//   "notice" (text)            a message for the player
//   "close" ({ reason, kicked })
class SyncClient extends EventEmitter {
  // host, port: the server's sync address (GET /projectvi/info gives the port). name: the player name.
  // now: a millisecond clock; tests pass their own.
  constructor({
    host,
    port,
    name,
    helloIntervalMs = 500,
    helloAttempts = 10,
    timeoutMs = 10_000,
    streamOutMs = 1000,
    now = () => performance.now()
  }) {
    super();
    this.host = host;
    this.port = port;
    this.name = name;
    this.helloIntervalMs = helloIntervalMs;
    this.helloAttempts = helloAttempts;
    this.timeoutMs = timeoutMs;
    this.streamOutMs = streamOutMs;
    this.now = now;
    this.startedAt = now();

    this.address = null; // host resolved once, so every packet can be checked against it
    this.socket = null;
    this.pending = null; // the join in progress: { nonce, welcome(msg), fail(err) }
    this.session = null;
    this.playerId = null;
    this.tickRate = null;
    this.delayMs = 100;
    this.seq = 0;
    this.lastHeard = 0;
    this.updateTimer = null;
    this.closed = false;

    this.clockSamples = [];
    this.clockOffset = null;
    this.lastTick = null;

    this.remotes = new Map(); // playerId -> { id, interpolator, lastSeen }
    this.names = new Map(); // playerId -> name, from the roster
    this.rosterVersion = null; // the version `names` is for
    this.roster = null; // a roster being collected: { version, pages: Map(page -> players), askedAt }

    this.stats = { snapshots: 0, missedTicks: 0 };
  }

  // Joins the server. Resolves with { session, playerId, tickRate }, or rejects with code "REJECTED"
  // (the server said no, message is its reason), "NO_ANSWER" or "NETWORK". A failed join also emits "close".
  async connect() {
    if (this.socket || this.closed) throw new Error("connect() can only be called once.");
    this.address = (await dns.lookup(this.host, { family: 4 })).address;
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (buf, rinfo) => this.handle(buf, rinfo));
    socket.on("error", (err) => {
      const message = `Network error: ${err.message}`;
      if (this.pending) this.pending.fail(Object.assign(new Error(message), { code: "NETWORK" }));
      else this.end(message, { bye: false });
    });
    await new Promise((resolve) => socket.bind(0, resolve));

    return new Promise((resolve, reject) => {
      const nonce = crypto.randomBytes(4).readUInt32LE(0);
      const hello = encodeHello({ nonce, name: this.name });
      let attempts = 0;
      let timer = null;
      const sendHello = () => {
        // A repeated HELLO with the same nonce gets the same session back, so resending is safe.
        if (++attempts > this.helloAttempts) return this.pending?.fail(Object.assign(new Error("The server didn't answer."), { code: "NO_ANSWER" }));
        this.send(hello);
      };
      this.pending = {
        nonce,
        welcome: (msg) => {
          clearInterval(timer);
          this.pending = null;
          this.session = msg.session;
          this.playerId = msg.playerId;
          this.tickRate = msg.tickRate;
          // Two snapshot intervals behind, so there's usually a newer state to move towards.
          this.delayMs = Math.max(100, Math.round(2000 / msg.tickRate));
          this.observeServerTime(msg.serverTime);
          this.updateTimer = setInterval(() => this.update(), UPDATE_MS);
          resolve({ session: msg.session, playerId: msg.playerId, tickRate: msg.tickRate });
        },
        fail: (err) => {
          clearInterval(timer);
          this.pending = null;
          this.end(err.message, { bye: false });
          reject(err);
        }
      };
      sendHello();
      timer = setInterval(sendHello, this.helloIntervalMs);
    });
  }

  get connected() {
    return this.session !== null && !this.closed;
  }

  send(buf) {
    if (this.socket && !this.closed) this.socket.send(buf, this.port, this.address);
  }

  // Sends the local player's state. Call once a tick (the tick rate is in the connect() result).
  sendState(state) {
    if (!this.connected) return false;
    this.seq = (this.seq + 1) & 0xffff;
    this.send(encodeState({ session: this.session, seq: this.seq, clientTime: (this.now() - this.startedAt) >>> 0, state }));
    return true;
  }

  // ---- Incoming ----

  handle(buf, rinfo) {
    if (this.closed || rinfo.address !== this.address || rinfo.port !== this.port) return;
    const msg = decodeSync(buf);
    if (!msg) return;
    this.lastHeard = this.now();
    switch (msg.type) {
      case SYNC_MSG.WELCOME:
        if (this.pending?.nonce === msg.nonce) this.pending.welcome(msg);
        break;
      case SYNC_MSG.REJECT:
        if (this.pending?.nonce === msg.nonce) this.pending.fail(Object.assign(new Error(msg.reason), { code: "REJECTED" }));
        break;
      case SYNC_MSG.SNAPSHOT:
        if (this.session !== null) this.onSnapshot(msg);
        break;
      case SYNC_MSG.ROSTER:
        if (this.session !== null) this.onRoster(msg);
        break;
      case SYNC_MSG.NOTICE:
        this.emit("notice", msg.text);
        break;
      case SYNC_MSG.KICK:
        if (this.pending) this.pending.fail(Object.assign(new Error(msg.reason), { code: "REJECTED" }));
        else this.end(msg.reason, { bye: false, kicked: true });
        break;
    }
  }

  onSnapshot(msg) {
    this.stats.snapshots++;
    // With many players nearby the server sends several packets per tick, all with the same tick number.
    if (this.lastTick !== null && msg.tick > this.lastTick + 1) this.stats.missedTicks += msg.tick - this.lastTick - 1;
    if (this.lastTick === null || msg.tick > this.lastTick) this.lastTick = msg.tick;
    this.observeServerTime(msg.serverTime);

    const now = this.now();
    for (const entry of msg.entries) {
      if (entry.playerId === this.playerId) continue;
      let remote = this.remotes.get(entry.playerId);
      if (!remote) {
        remote = { id: entry.playerId, interpolator: createInterpolator({ delayMs: this.delayMs }), lastSeen: now };
        this.remotes.set(entry.playerId, remote);
        this.emit("streamIn", entry.playerId);
      }
      remote.lastSeen = now;
      remote.interpolator.push(msg.serverTime, entry.state);
    }
    if (msg.rosterVersion !== this.rosterVersion) this.requestRoster(msg.rosterVersion);
    this.emit("snapshot", msg);
  }

  requestRoster(version) {
    const now = this.now();
    if (this.roster?.version === version && now - this.roster.askedAt < ROSTER_RETRY_MS) return;
    this.roster = { version, pages: new Map(), askedAt: now };
    this.send(encodeRosterRequest({ session: this.session }));
  }

  // Roster pages can arrive in any order, and the server answers with whatever version it has now,
  // which may already be newer than the one asked for.
  onRoster(msg) {
    if (msg.rosterVersion === this.rosterVersion) return;
    if (!this.roster || this.roster.version !== msg.rosterVersion) {
      this.roster = { version: msg.rosterVersion, pages: new Map(), askedAt: this.roster?.askedAt ?? this.now() };
    }
    this.roster.pages.set(msg.page, msg.players);
    if (this.roster.pages.size < msg.pages) return;
    this.names = new Map([...this.roster.pages.values()].flat().map((p) => [p.id, p.name]));
    this.rosterVersion = msg.rosterVersion;
    this.roster = null;
    this.emit("roster", this.names);
  }

  // ---- Server clock ----

  // Snapshots carry the server's time when they were sent and arrive a little later: later still when
  // the network is busy. The largest (server time - local time) seen recently is the packet that waited
  // least, so the estimate follows it. A window rather than an all-time maximum lets clock drift through.
  observeServerTime(serverTime) {
    this.clockSamples.push(serverTime - this.now());
    if (this.clockSamples.length > CLOCK_WINDOW) this.clockSamples.shift();
    this.clockOffset = Math.max(...this.clockSamples);
  }

  // The server's clock as this client estimates it (ms), or null before the server has answered.
  serverNow() {
    return this.clockOffset === null ? null : this.now() + this.clockOffset;
  }

  // ---- What to draw ----

  // Where to put each remote player's ped this frame: [{ id, name, state }].
  view() {
    const t = this.serverNow();
    if (t === null) return [];
    return [...this.remotes.values()].map((r) => ({ id: r.id, name: this.names.get(r.id) ?? null, state: r.interpolator.sample(t) }));
  }

  // ---- Housekeeping ----

  // Runs every UPDATE_MS while connected. Public so tests with their own clock can call it.
  update() {
    if (!this.connected) return;
    const now = this.now();
    if (now - this.lastHeard > this.timeoutMs) return this.end("The server stopped answering.", { bye: false });
    for (const [id, remote] of this.remotes) {
      if (now - remote.lastSeen > this.streamOutMs) {
        this.remotes.delete(id);
        this.emit("streamOut", id);
      }
    }
    // A lost roster page: ask again.
    if (this.roster && now - this.roster.askedAt >= ROSTER_RETRY_MS) this.requestRoster(this.roster.version);
  }

  // Leaves the server and closes the socket. Resolves once the socket is closed.
  close(reason = "Left") {
    return this.end(reason);
  }

  end(reason, { bye = true, kicked = false } = {}) {
    if (this.closed) return this.closing ?? Promise.resolve();
    clearInterval(this.updateTimer);
    const socket = this.socket;
    const leave = bye && this.session !== null;
    this.closed = true;
    this.closing = new Promise((resolve) => {
      if (!socket) return resolve();
      const done = () => socket.close(resolve);
      // Close only after BYE has gone out, or the send would be cancelled.
      if (leave) socket.send(encodeBye({ session: this.session }), this.port, this.address, done);
      else done();
    });
    for (const id of this.remotes.keys()) this.emit("streamOut", id);
    this.remotes.clear();
    this.emit("close", { reason, kicked });
    return this.closing;
  }
}

module.exports = { SyncClient };
