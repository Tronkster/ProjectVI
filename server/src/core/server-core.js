// The server core: players, commands, exports, entities and the natives scripts call.
// Runtimes (C# today) plug into it; it doesn't care which language a resource is written in.

const { joaat, quatFromHeading, headingFromQuat } = require("@projectvi/shared");
const { EventBus } = require("./events");
const { World } = require("./world");

const DEFAULT_SPAWN = { x: -1012.4, y: 233.8, z: 12.0 };

// Splits `job "Ana Lee" mechanic` into ["job", "Ana Lee", "mechanic"].
function splitCommandLine(line) {
  const parts = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) parts.push(m[1] ?? m[2]);
  return parts;
}

class PlayerRegistry {
  constructor(permissions) {
    this.permissions = permissions; // { group: [identifier, ...] }
    this.players = new Map();
    this.nextId = 1;
  }

  groupsFor(identifiers) {
    return Object.entries(this.permissions)
      .filter(([, members]) => members.some((id) => identifiers.includes(id)))
      .map(([group]) => group);
  }

  add({ name, identifiers, fake = false, connection = null }) {
    const player = { id: this.nextId++, name, identifiers, groups: this.groupsFor(identifiers), fake, connection, position: { ...DEFAULT_SPAWN } };
    this.players.set(player.id, player);
    return player;
  }

  remove(id) {
    const player = this.players.get(id);
    this.players.delete(id);
    return player;
  }

  get(id) {
    return this.players.get(Number(id));
  }

  find(nameOrId) {
    if (/^\d+$/.test(nameOrId)) return this.get(Number(nameOrId));
    const lower = nameOrId.toLowerCase();
    const all = [...this.players.values()];
    const starts = all.filter((p) => p.name.toLowerCase().startsWith(lower));
    return all.find((p) => p.name.toLowerCase() === lower) ?? (starts.length === 1 ? starts[0] : undefined);
  }

  list() {
    return [...this.players.values()];
  }

  // What runtimes see: {"$player": id, name, identifiers, groups}.
  snapshot(player) {
    return { $player: player.id, name: player.name, identifiers: player.identifiers, groups: player.groups };
  }
}

class ServerCore {
  constructor({ config, log, store }) {
    this.log = log;
    this.store = store;
    this.info = { name: config.name, maxPlayers: config.maxPlayers, port: config.port };
    this.dev = config.scripting.dev;
    this.bus = new EventBus({ log });
    this.world = new World(config.world);
    this.world.on("change", ({ weatherChanged, weather, previous }) => {
      if (weatherChanged) this.bus.emit("weatherChanged", [weather, previous]);
    });
    this.players = new PlayerRegistry(config.permissions);
    this.runtimes = new Set();
    this.commands = new Map(); // name -> { runtime, resource, permission, help }
    this.exports = new Map(); // "resource/name" -> runtime
    this.entities = new Map(); // id -> entity (see addEntity)
    this.nextEntityId = 1;
  }

  addRuntime(runtime) {
    this.runtimes.add(runtime);
  }

  // Forget everything a runtime registered, for example after its process crashed.
  forgetRuntime(runtime) {
    this.bus.removeRuntime(runtime);
    for (const [name, command] of this.commands) if (command.runtime === runtime) this.commands.delete(name);
    for (const [key, owner] of this.exports) if (owner === runtime) this.exports.delete(key);
  }

  // ---- Players ----

  addPlayer({ name, identifiers, fake = false, connection = null }) {
    const player = this.players.add({ name, identifiers, fake, connection });
    const snapshot = this.players.snapshot(player);
    for (const runtime of this.runtimes) runtime.playerJoined(snapshot);
    this.bus.emit("playerJoined", [snapshot]);
    this.log.info(`${player.name} joined (#${player.id}, ${identifiers.join(", ")}${player.groups.length ? `, groups: ${player.groups.join(", ")}` : ""}).`);
    return player;
  }

  removePlayer(id, reason = "Left") {
    const player = this.players.get(id);
    if (!player) return false;
    // Scripts get playerLeft while the player still exists, then it's removed everywhere.
    this.bus.emit("playerLeft", [{ $player: player.id }, reason]);
    for (const runtime of this.runtimes) runtime.playerLeft(player.id);
    this.players.remove(player.id);
    player.connection?.close?.(reason);
    this.log.info(`${player.name} left (${reason}).`);
    return true;
  }

  notify(player, message) {
    if (player.connection) player.connection.notify(message);
    else this.log.info(`[to ${player.name}] ${message}`);
  }

  // ---- Commands ----

  registerCommand(runtime, { resource, name, permission, help }) {
    const existing = this.commands.get(name);
    if (existing && existing.runtime !== runtime) {
      this.log.warn(`${resource} tried to add /${name}, but ${existing.resource} already has it.`);
      return;
    }
    this.commands.set(name, { runtime, resource, permission: permission || "", help: help || "" });
  }

  unregisterCommand(runtime, { name }) {
    if (this.commands.get(name)?.runtime === runtime) this.commands.delete(name);
  }

  // Runs a command line as a player (source = player id) or the console (source = null).
  // Returns the reply text, or null.
  async runCommand(source, line) {
    const [name, ...args] = splitCommandLine(line.replace(/^\//, ""));
    if (!name) return null;
    const command = this.commands.get(name.toLowerCase());
    if (!command) return `Unknown command: /${name}`;
    if (source !== null) {
      const player = this.players.get(source);
      if (!player) return null;
      if (command.permission && !player.groups.includes(command.permission)) return `You don't have permission to use /${name}.`;
    }
    try {
      const { error } = await command.runtime.invokeCommand(name.toLowerCase(), source, args);
      return error ?? null;
    } catch (err) {
      this.log.error(`/${name} failed: ${err.message}`);
      return `Something went wrong running /${name}.`;
    }
  }

  // ---- Exports ----

  registerExport(runtime, { resource, name }) {
    this.exports.set(`${resource}/${name}`, runtime);
  }

  unregisterExport(runtime, { resource, name }) {
    if (this.exports.get(`${resource}/${name}`) === runtime) this.exports.delete(`${resource}/${name}`);
  }

  async callExport(resource, name, args) {
    const runtime = this.exports.get(`${resource}/${name}`);
    if (!runtime) throw Object.assign(new Error(`${resource} has no export called ${name} (is it running?).`), { code: -32601 });
    return runtime.invokeExport(resource, name, args);
  }

  // ---- Entities ----
  // Vehicles are sent to players over sync (src/sync.js), which also decides which player's client
  // simulates each one. Ids are 16-bit on the wire.

  // The next free id, counting up and wrapping, so a removed vehicle's id isn't reused straight away.
  allocateEntityId() {
    for (let tries = 0; tries < 0xffff; tries++) {
      const id = this.nextEntityId;
      this.nextEntityId = id >= 0xffff ? 1 : id + 1;
      if (!this.entities.has(id)) return id;
    }
    throw new Error("There are too many entities (65,535).");
  }

  // A vehicle spawned by a resource. owner: the resource; it's removed when the resource stops.
  spawnEntity(owner, kind, model, position, heading) {
    const name = String(model).slice(0, 64);
    const rotation = quatFromHeading(heading);
    return publicEntity(this.addEntity({ kind, model: name, hash: modelHash(name), position: toVec(position), rotation, owner, player: null }));
  }

  // A vehicle a player's client spawned and registered (a parked car they got into, for example). It has
  // no resource, only a model hash, and sync removes it once nobody has been near it for a while.
  registerVehicle(playerId, hash, { position, rotation }) {
    const model = `0x${(hash >>> 0).toString(16).padStart(8, "0")}`;
    return this.addEntity({ kind: "vehicle", model, hash: hash >>> 0, position: toVec(position), rotation, owner: null, player: playerId });
  }

  addEntity(fields) {
    const entity = {
      id: this.allocateEntityId(),
      velocity: { x: 0, y: 0, z: 0 },
      health: 1000,
      steering: 0,
      flags: 0,
      controller: 0, // the player whose client simulates it, 0 for nobody
      driver: 0,
      seq: null, // the controller's last VEHICLE_STATE sequence
      lastNear: null, // when a player was last in range
      ...fields
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  removeEntitiesOwnedBy(resource) {
    for (const [id, entity] of this.entities) if (entity.owner === resource) this.entities.delete(id);
  }

  // ---- Natives: functions scripts call into the core ----

  callNative(resource, name, args) {
    const fn = NATIVES[name];
    if (!fn) throw Object.assign(new Error(`Unknown native: ${name}`), { code: -32601 });
    return fn(this, resource, ...args);
  }
}

// What scripts see. The C# Entity record reads exactly these fields, with model as a string.
function publicEntity({ id, kind, model, position, rotation }) {
  return { id, kind, model, position: { ...position }, heading: headingFromQuat(rotation) };
}

// The wire carries models as hashes. Names are hashed; "0x39da2754" or "970598228" is already a hash.
function modelHash(model) {
  if (/^0x[0-9a-f]{1,8}$/i.test(model)) return parseInt(model.slice(2), 16) >>> 0;
  if (/^\d{1,10}$/.test(model) && Number(model) <= 0xffffffff) return Number(model);
  return joaat(model);
}

function toVec(v) {
  return { x: Number(v?.x) || 0, y: Number(v?.y) || 0, z: Number(v?.z) || 0 };
}

function requirePlayer(core, id) {
  const player = core.players.get(id);
  if (!player) throw new Error(`There's no player with id ${id}.`);
  return player;
}

function requireKey(key) {
  if (typeof key !== "string" || !key || key.length > 256) throw new Error("Store keys must be 1-256 characters.");
  return key;
}

const NATIVES = {
  "player.notify": (core, resource, id, message) => {
    core.notify(requirePlayer(core, id), String(message).slice(0, 500));
    return true;
  },
  "player.kick": (core, resource, id, reason) => core.removePlayer(requirePlayer(core, id).id, `Kicked: ${String(reason).slice(0, 200)}`),
  "player.position": (core, resource, id) => requirePlayer(core, id).position,
  // The last state the player's client reported over sync, or null (fake players, or nothing sent yet).
  "player.state": (core, resource, id) => requirePlayer(core, id).sync ?? null,
  // Round trip in ms as the player's client reports it, or null. For display only: a client can lie about it.
  "player.ping": (core, resource, id) => requirePlayer(core, id).ping ?? null,
  // The story character model hash sync gave the player, 0 for none (fake players, or more players than characters).
  "player.character": (core, resource, id) => requirePlayer(core, id).character ?? 0,
  // True for the player whose game runs the story.
  "player.isHost": (core, resource, id) => requirePlayer(core, id).host === true,
  "world.time": (core) => core.world.time(),
  "world.setTime": (core, resource, hour, minute, second) => (core.world.setTime(hour, minute ?? 0, second ?? 0), true),
  "world.timeScale": (core) => core.world.scale,
  "world.setTimeScale": (core, resource, scale) => (core.world.setTimeScale(scale), true),
  "world.weather": (core) => core.world.weather,
  "world.setWeather": (core, resource, name, transitionSeconds) => (core.world.setWeather(name, transitionSeconds ?? 30), true),
  "store.get": (core, resource, key) => core.store.get(resource, requireKey(key)),
  "store.set": (core, resource, key, value) => core.store.set(resource, requireKey(key), value),
  "store.delete": (core, resource, key) => core.store.delete(resource, requireKey(key)),
  "store.keys": (core, resource, prefix) => core.store.keys(resource, typeof prefix === "string" ? prefix : ""),
  "entities.spawnVehicle": (core, resource, model, position, heading) => core.spawnEntity(resource, "vehicle", model, position, heading),
  "entities.list": (core) => [...core.entities.values()].map(publicEntity),
  "entities.delete": (core, resource, id) => core.entities.delete(Number(id))
};

module.exports = { ServerCore, PlayerRegistry, splitCommandLine, DEFAULT_SPAWN, modelHash };
