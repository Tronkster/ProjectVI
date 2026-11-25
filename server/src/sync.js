// Player sync: a UDP channel on the game port. Clients join with HELLO, send their state every tick,
// and get snapshots of the players and vehicles near them. Format: packages/shared/sync.js and
// docs/protocol.md.
//
// UDP is used because state is replaced every tick: a lost packet is better skipped than resent. What must
// arrive (chat, script events, notices) goes over each session's reliable channel (packages/shared/reliable.js)
// in RELIABLE packets on the same port. KICK stays outside it: the session is gone straight after.
//
// Vehicles: each one is simulated by one player's client (its controller), which reports it with
// VEHICLE_STATE; everyone else draws it from VEHICLES. The driver controls their vehicle. An empty vehicle
// stays with its controller while they're within `vehicleHandover` metres, then goes to the nearest player.
//
// Roles: the player who joined first is the host, whose game will run the story; when they leave, the next
// longest-connected player takes over. Story characters (`characters`, Lucia and Jason by default) are given
// out in join order, and a freed one goes to the earliest player without one. Both travel in the roster, and a
// player's character replaces the model their client reports, so everyone draws them the same way.

const dgram = require("node:dgram");
const crypto = require("node:crypto");
const {
  SYNC_MSG,
  SYNC_FLAG,
  SNAPSHOT_MAX_ENTRIES,
  VEHICLES_MAX_ENTRIES,
  encodeWelcome,
  encodeReject,
  encodeSnapshot,
  encodeVehicles,
  encodeVehicleAssign,
  encodePong,
  encodeRoster,
  encodeKick,
  encodeReliable,
  encodeChat,
  encodeChannelNotice,
  encodeEvent,
  encodeWorld,
  decodeChannelMessage,
  decodeSync,
  SYNC_CHANNEL,
  ReliableChannel,
  seqNewer,
  validatePlayerName
} = require("@projectvi/shared");
const { modelHash } = require("./core/server-core");

// Sanity limits for reported state. GTA-scale maps fit easily; anything outside is a broken or
// dishonest client, and the packet is dropped.
const MAX_COORD = 50_000;
const MAX_SPEED = 250; // m/s, faster than any vehicle should go
const MAX_STATES_PER_SECOND = 90; // clients send at the tick rate; this leaves room for bursts
// A client reports every vehicle it controls, so this allows for a car park's worth at 20 a second.
const MAX_VEHICLE_STATES_PER_SECOND = 1000;
const HELLOS_PER_SECOND_PER_IP = 5;
const MIN_PING_INTERVAL_MS = 200;
// Chat and events are limited by token buckets: a steady rate, plus room for a burst. Reliable messages held up
// by a lost packet arrive together once it's resent, so a plain per-second count would drop lines from a client
// that never went over the limit.
const CHAT_PER_SECOND = 5;
const CHAT_BURST = 10;
const CHAT_WARNING_MS = 5000; // at most one "too fast" notice this often
const MAX_CHAT_LENGTH = 500;
const EVENTS_PER_SECOND = 50; // script events from one client; they end up in the script runtimes
const EVENTS_BURST = 100;
const MAX_EVENT_BYTES = 16 * 1024; // either way. An event for every player is copied into every queue
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

const finite = (v) => Number.isFinite(v);

function validCoords(p) {
  return [p.x, p.y, p.z].every(finite) && Math.abs(p.x) <= MAX_COORD && Math.abs(p.y) <= MAX_COORD && Math.abs(p.z) <= MAX_COORD;
}

function validVelocity(v) {
  return [v.x, v.y, v.z].every(finite) && Math.hypot(v.x, v.y, v.z) <= MAX_SPEED;
}

function validState(s) {
  return validCoords(s.position) && validVelocity(s.velocity) && finite(s.heading) && [s.aim.x, s.aim.y, s.aim.z].every(finite);
}

// A rotation must be close to a unit quaternion; it's normalised before use.
function validVehicle(v) {
  const q = v.rotation;
  if (!validCoords(v.position) || !validVelocity(v.velocity) || ![q.x, q.y, q.z, q.w].every(finite)) return false;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return length > 0.5 && length < 1.5;
}

// {"$player": id} in event arguments becomes a Player object in scripts. A client mustn't be able to hand a
// script some other player that way, so its events may not contain one.
function hasPlayerReference(value) {
  if (Array.isArray(value)) return value.some(hasPlayerReference);
  if (value && typeof value === "object") return "$player" in value || Object.values(value).some(hasPlayerReference);
  return false;
}

function normalise(q) {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

// Splits entries into groups that each fit one packet.
function* chunks(entries, size) {
  for (let i = 0; i < entries.length; i += size) yield entries.slice(i, i + size);
}

class SyncServer {
  // core: ServerCore. options: { tickRate, streamRadius, timeoutSeconds, maxPlayers, characters, vehicleHandover,
  // vehicleIdleSeconds, maxVehiclesPerPlayer, now }
  constructor({
    core,
    log,
    tickRate = 20,
    streamRadius = 500,
    timeoutSeconds = 10,
    maxPlayers = 32,
    characters = [],
    vehicleHandover = 150,
    vehicleIdleSeconds = 60,
    maxVehiclesPerPlayer = 8,
    now = () => Date.now()
  }) {
    this.core = core;
    this.log = log;
    this.tickRate = tickRate;
    this.streamRadiusSq = streamRadius * streamRadius;
    this.handoverSq = vehicleHandover * vehicleHandover;
    this.vehicleIdleMs = vehicleIdleSeconds * 1000;
    this.maxVehiclesPerPlayer = maxVehiclesPerPlayer;
    this.timeoutMs = timeoutSeconds * 1000;
    this.maxPlayers = maxPlayers;
    this.characters = characters.map(modelHash);
    this.slots = this.characters.map(() => 0); // the player holding each character, 0 for nobody
    this.hostId = 0;
    this.now = now;
    this.startedAt = now();
    // session -> { session, playerId, address, port, lastSeen, lastSeq, state, budget, vehicleBudget, localVehicles, driving, lastPing }
    this.sessions = new Map();
    this.byPlayer = new Map(); // playerId -> session
    this.helloBudget = new Map(); // ip -> { second, count }
    this.rosterVersion = 0;
    this.tick = 0;
    this.socket = null;
    this.timer = null;
    // Script events for players (emitted with a client target) come here.
    this.sendToClients = (target, name, args) => this.sendEvent(target, name, args);
    core.bus.sendToClients = this.sendToClients;
    // The clock and weather go to everyone when they change, and to each player as they join.
    this.onWorldChange = ({ transition }) => {
      const payload = this.worldMessage(transition);
      for (const s of [...this.sessions.values()]) this.queue(s, payload);
    };
    core.world.on("change", this.onWorldChange);
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
    if (this.core.bus.sendToClients === this.sendToClients) this.core.bus.sendToClients = null;
    this.core.world.off("change", this.onWorldChange);
    for (const s of [...this.sessions.values()]) this.drop(s, "Server shutting down", { kick: true });
    return new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
  }

  send(buf, address, port) {
    this.socket?.send(buf, port, address);
  }

  sessionOf(playerId) {
    return this.sessions.get(this.byPlayer.get(playerId));
  }

  vehicles() {
    return [...this.core.entities.values()].filter((e) => e.kind === "vehicle");
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
    else if (msg.type === SYNC_MSG.VEHICLE_STATE) this.onVehicleState(s, msg);
    else if (msg.type === SYNC_MSG.PING) this.onPing(s, msg);
    else if (msg.type === SYNC_MSG.RELIABLE) this.onReliable(s, msg);
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

    const record = {
      session,
      nonce,
      address,
      port,
      lastSeen: this.now(),
      lastSeq: null,
      state: null,
      budget: { second, count: 0 },
      vehicleBudget: { second, count: 0 },
      localVehicles: new Map(), // the client's local id -> vehicle id, for vehicles it registered
      driving: 0,
      lastPing: -Infinity,
      reliable: new ReliableChannel({ now: this.now }),
      chatBudget: { tokens: CHAT_BURST, at: this.now(), rate: CHAT_PER_SECOND, burst: CHAT_BURST },
      eventBudget: { tokens: EVENTS_BURST, at: this.now(), rate: EVENTS_PER_SECOND, burst: EVENTS_BURST },
      chatWarnedAt: -Infinity,
      playerId: 0
    };
    const connection = {
      notify: (text) => this.queue(record, encodeChannelNotice({ text })),
      close: (reason) => {
        if (this.sessions.has(session)) this.drop(record, reason, { kick: true, fromCore: true });
      }
    };
    // Identity isn't verified yet (no login on this channel), so the only identifier is the session.
    const player = this.core.addPlayer({ name: checked.name, identifiers: [`session:${session.toString(16)}`], connection });
    record.playerId = player.id;
    this.sessions.set(session, record);
    this.byPlayer.set(player.id, session);
    this.assignRoles();
    this.rosterVersion = (this.rosterVersion + 1) & 0xffff;
    this.queue(record, this.worldMessage(0));
    this.send(encodeWelcome({ nonce, session, playerId: player.id, tickRate: this.tickRate, serverTime: this.serverTime() }), address, port);
  }

  onState(s, { seq, state }) {
    const second = Math.floor(this.now() / 1000);
    if (s.budget.second !== second) s.budget = { second, count: 0 };
    if (++s.budget.count > MAX_STATES_PER_SECOND) return;
    if (s.lastSeq !== null && !seqNewer(seq, s.lastSeq)) return; // late or repeated: a newer one already arrived
    if (!validState(state)) return;

    s.lastSeq = seq;
    s.state = { ...state, heading: ((state.heading % 360) + 360) % 360, model: this.characterOf(s.playerId) || state.model };
    const player = this.core.players.get(s.playerId);
    if (player) {
      player.position = { ...s.state.position };
      player.sync = s.state;
    }
    this.updateDriver(s, state);
  }

  // Seat 0 is the driver's. The first player to claim a free driver's seat gets it, and with it control.
  updateDriver(s, state) {
    const vehicle = (state.flags & SYNC_FLAG.IN_VEHICLE) && state.seat === 0 ? this.core.entities.get(state.vehicleId) : null;
    const claim = vehicle?.kind === "vehicle" && (!vehicle.driver || vehicle.driver === s.playerId || !this.byPlayer.has(vehicle.driver));
    const driving = claim ? vehicle.id : 0;
    if (s.driving && s.driving !== driving) {
      const left = this.core.entities.get(s.driving);
      if (left?.driver === s.playerId) left.driver = 0;
    }
    if (claim) {
      vehicle.driver = s.playerId;
      this.setController(vehicle, s.playerId);
    }
    s.driving = driving;
  }

  setController(vehicle, playerId) {
    if (vehicle.controller === playerId) return;
    vehicle.controller = playerId;
    vehicle.seq = null; // sequence numbers are per controller
  }

  onVehicleState(s, { seq, vehicleId, localId, state }) {
    const second = Math.floor(this.now() / 1000);
    if (s.vehicleBudget.second !== second) s.vehicleBudget = { second, count: 0 };
    if (++s.vehicleBudget.count > MAX_VEHICLE_STATES_PER_SECOND) return;
    if (!validVehicle(state)) return;

    let vehicle;
    if (vehicleId === 0) {
      // Registration: answered with VEHICLE_ASSIGN every time, so a lost answer is fixed by the next packet.
      if (localId === 0) return;
      vehicle = this.core.entities.get(s.localVehicles.get(localId));
      if (!vehicle || vehicle.player !== s.playerId || vehicle.localId !== localId) {
        const registered = this.vehicles().filter((v) => v.player === s.playerId).length;
        if (registered >= this.maxVehiclesPerPlayer) return;
        vehicle = this.core.registerVehicle(s.playerId, state.model, { position: state.position, rotation: normalise(state.rotation) });
        vehicle.localId = localId;
        vehicle.lastNear = this.now();
        s.localVehicles.set(localId, vehicle.id);
        this.setController(vehicle, s.playerId);
      }
      this.send(encodeVehicleAssign({ localId, vehicleId: vehicle.id }), s.address, s.port);
    } else {
      vehicle = this.core.entities.get(vehicleId);
    }
    if (vehicle?.kind !== "vehicle" || vehicle.controller !== s.playerId) return; // not this client's to report
    if (vehicle.seq !== null && !seqNewer(seq, vehicle.seq)) return;

    vehicle.seq = seq;
    vehicle.position = { ...state.position };
    vehicle.rotation = normalise(state.rotation);
    vehicle.velocity = { ...state.velocity };
    vehicle.health = state.health;
    vehicle.steering = state.steering;
    vehicle.flags = state.flags;
  }

  onPing(s, { clientTime, rtt }) {
    const now = this.now();
    if (now - s.lastPing < MIN_PING_INTERVAL_MS) return;
    s.lastPing = now;
    const player = this.core.players.get(s.playerId);
    if (player) player.ping = rtt;
    this.send(encodePong({ clientTime, serverTime: this.serverTime() }), s.address, s.port);
  }

  // ---- Roles ----

  characterOf(playerId) {
    const slot = this.slots.indexOf(playerId);
    return slot < 0 ? 0 : this.characters[slot];
  }

  // Runs when someone joins or leaves. Sessions are kept in join order.
  assignRoles() {
    const joined = [...this.sessions.values()].filter((s) => this.byPlayer.get(s.playerId) === s.session);
    this.hostId = joined[0]?.playerId ?? 0;
    this.slots = this.slots.map((id) => (this.byPlayer.has(id) ? id : 0));
    for (const s of joined) {
      const free = this.slots.indexOf(0);
      if (free < 0) break;
      if (!this.slots.includes(s.playerId)) this.slots[free] = s.playerId;
    }
    for (const s of joined) {
      const player = this.core.players.get(s.playerId);
      if (!player) continue;
      player.character = this.characterOf(s.playerId);
      player.host = s.playerId === this.hostId;
    }
  }

  // ---- Reliable messages ----

  onReliable(s, msg) {
    const delivered = s.reliable.receive(msg);
    if (s.reliable.failed) return this.drop(s, s.reliable.failed, { kick: true });
    this.flush(s); // acknowledge now, so the client doesn't resend what arrived
    for (const payload of delivered) {
      const message = decodeChannelMessage(payload);
      if (message?.kind === SYNC_CHANNEL.CHAT) this.onChat(s, message.text);
      else if (message?.kind === SYNC_CHANNEL.EVENT) this.onClientEvent(s, message, payload.length);
    }
  }

  // Takes a token from a bucket that refills at budget.rate a second, up to budget.burst.
  takeToken(budget) {
    const now = this.now();
    budget.tokens = Math.min(budget.burst, budget.tokens + ((now - budget.at) / 1000) * budget.rate);
    budget.at = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  // A line starting with / runs a command (permissions are checked there) and the reply comes back as a notice.
  // Anything else goes to scripts as playerChat and to every player.
  onChat(s, text) {
    const line = text.trim();
    const player = this.core.players.get(s.playerId);
    if (!player || !line || line.length > MAX_CHAT_LENGTH) return;
    if (!this.takeToken(s.chatBudget)) {
      if (this.now() - s.chatWarnedAt >= CHAT_WARNING_MS) {
        s.chatWarnedAt = this.now();
        this.core.notify(player, "You're sending messages too fast; some weren't sent.");
      }
      return;
    }
    if (line.startsWith("/")) {
      this.core.runCommand(player.id, line).then(
        (reply) => reply && this.core.notify(player, reply),
        (err) => this.log.error(`${line.split(" ")[0]} from ${player.name} failed: ${err.message}`)
      );
      return;
    }
    this.log.info(`[chat] ${player.name}: ${line}`);
    this.core.bus.emit("playerChat", [{ $player: player.id }, line]);
    const buf = encodeChat({ playerId: player.id, text: line });
    for (const other of [...this.sessions.values()]) this.queue(other, buf);
  }

  onClientEvent(s, { name, args }, size) {
    if (!EVENT_NAME.test(name) || size > MAX_EVENT_BYTES || hasPlayerReference(args)) return;
    if (!this.takeToken(s.eventBudget)) return;
    if (!this.core.bus.emitFromClient(s.playerId, name, args)) this.log.debug?.(`Nothing on the server accepts the net event ${name}.`);
  }

  // target: "clients" or "client:<playerId>", from the event bus.
  sendEvent(target, name, args) {
    let payload;
    try {
      payload = encodeEvent({ name, args });
    } catch (err) {
      return this.log.warn(`Event ${name} can't be sent to players: ${err.message}`);
    }
    if (payload.length > MAX_EVENT_BYTES) {
      return this.log.warn(`Event ${name} is too big to send to players (${payload.length} bytes; the limit is ${MAX_EVENT_BYTES}).`);
    }
    if (target === "clients") {
      for (const s of [...this.sessions.values()]) this.queue(s, payload);
    } else if (target.startsWith("client:")) {
      const s = this.sessionOf(Number(target.slice("client:".length)));
      if (s) this.queue(s, payload);
    }
  }

  // The clock as of now, in server time, so a client can keep it running between messages.
  worldMessage(transition) {
    const world = this.core.world;
    return encodeWorld({ serverTime: this.serverTime(), clock: world.clockSeconds(), scale: world.scale, weather: world.weather, transition });
  }

  // Queues a reliable message; it goes out on the next tick. A client that stops acknowledging is dropped
  // once too much is waiting.
  queue(s, payload) {
    if (!s.reliable || !this.sessions.has(s.session)) return;
    if (!s.reliable.send(payload)) this.drop(s, s.reliable.failed, { kick: true });
  }

  flush(s) {
    for (const packet of s.reliable.poll()) this.send(encodeReliable({ session: s.session, ...packet }), s.address, s.port);
  }

  // ---- Outgoing ----

  sendRoster(s) {
    const players = this.core.players
      .list()
      .filter((p) => this.byPlayer.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, character: this.characterOf(p.id), host: p.id === this.hostId }));
    for (const page of encodeRoster({ rosterVersion: this.rosterVersion, players })) this.send(page, s.address, s.port);
  }

  // Decides who simulates each vehicle, and removes player-registered vehicles nobody has been near.
  assignVehicles(vehicles, live, now) {
    for (const vehicle of vehicles) {
      if (vehicle.driver && !this.byPlayer.has(vehicle.driver)) vehicle.driver = 0;
      let nearest = null;
      let nearestSq = this.streamRadiusSq;
      for (const s of live) {
        const d = distanceSquared(s.state.position, vehicle.position);
        if (d <= nearestSq) {
          nearest = s;
          nearestSq = d;
        }
      }
      if (nearest || vehicle.lastNear === null) vehicle.lastNear = now;
      if (vehicle.owner === null && vehicle.player !== null && now - vehicle.lastNear > this.vehicleIdleMs) {
        this.core.entities.delete(vehicle.id);
        continue;
      }
      if (vehicle.driver) {
        this.setController(vehicle, vehicle.driver);
        continue;
      }
      const current = vehicle.controller ? this.sessionOf(vehicle.controller) : null;
      const keep = current?.state && distanceSquared(current.state.position, vehicle.position) <= this.handoverSq;
      if (!keep) this.setController(vehicle, nearest ? nearest.playerId : 0);
    }
  }

  // One tick: time out silent players, assign vehicles, then send each player what's near them.
  step() {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastSeen > this.timeoutMs) this.drop(s, "Timed out", { kick: true });
    }

    this.tick = (this.tick + 1) >>> 0;
    const serverTime = this.serverTime();
    const live = [...this.sessions.values()].filter((s) => s.state);
    const vehicles = this.vehicles();
    this.assignVehicles(vehicles, live.filter((s) => this.byPlayer.get(s.playerId) === s.session), now);
    const remaining = vehicles.filter((v) => this.core.entities.has(v.id));

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

      if (!viewer.state) continue;
      const nearVehicles = remaining
        .filter((v) => distanceSquared(v.position, viewer.state.position) <= this.streamRadiusSq)
        .map((v) => ({
          vehicleId: v.id,
          controller: v.controller,
          state: { model: v.hash, position: v.position, rotation: v.rotation, velocity: v.velocity, health: v.health, steering: v.steering, flags: v.flags }
        }));
      for (const chunk of chunks(nearVehicles, VEHICLES_MAX_ENTRIES)) {
        this.send(encodeVehicles({ tick: this.tick, serverTime, entries: chunk }), viewer.address, viewer.port);
      }
    }

    // Reliable messages queued since the last tick, and resends.
    for (const s of [...this.sessions.values()]) if (s.reliable) this.flush(s);
  }

  // Removes a session. fromCore: the core is already removing the player (a kick from a script).
  drop(s, reason, { kick = false, fromCore = false } = {}) {
    if (!this.sessions.delete(s.session)) return;
    this.byPlayer.delete(s.playerId);
    this.assignRoles();
    this.rosterVersion = (this.rosterVersion + 1) & 0xffff;
    // Their vehicles get a new controller on the next tick.
    for (const v of this.vehicles()) if (v.driver === s.playerId) v.driver = 0;
    if (kick) this.send(encodeKick({ reason }), s.address, s.port);
    if (!fromCore) this.core.removePlayer(s.playerId, reason);
  }

  // For tests and the console.
  stats() {
    return { players: this.sessions.size, vehicles: this.vehicles().length, host: this.hostId, tick: this.tick, rosterVersion: this.rosterVersion };
  }
}

module.exports = { SyncServer, validState, validVehicle, MAX_COORD, MAX_SPEED };
