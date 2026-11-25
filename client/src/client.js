// The ProjectVI client: runs beside the emulator, joins the game server, and on every frame the game presents,
// reports the local player and places everyone else, through the emulator's bridge (bridge.js).
//
// The game operations it uses are the contract in docs/client.md. The emulator lists the ones it can do in
// `capabilities`; the client only calls those, and says once what each missing one means for the player. It never
// makes anything up: with no player.read, nothing is reported and other players don't see this one.

const { EventEmitter } = require("node:events");
const { SyncClient } = require("@projectvi/shared/sync-client");
const { SYNC_VERSION, SYNC_FLAG, quatFromHeading } = require("@projectvi/shared");
const { ScriptHost } = require("./scripting");
const { loadPackages } = require("./packages");
const { OverlayLink } = require("./overlay-link");

// What each group of operations gives the player, for the log.
const FEATURES = [
  { ops: ["player.read"], what: "reporting where you are (others won't see you)" },
  { ops: ["ped.create", "ped.update", "ped.delete"], what: "showing other players" },
  { ops: ["vehicle.create", "vehicle.update", "vehicle.delete"], what: "showing other players' cars" },
  { ops: ["vehicle.read"], what: "reporting the cars you drive or are near" },
  { ops: ["player.setModel"], what: "switching you to your story character" },
  { ops: ["world.set"], what: "the server's time of day and weather" },
  { ops: ["screen.notify"], what: "server notices on screen (they go to the client log)" },
  { ops: ["screen.chat"], what: "chat on screen (it goes to the client log)" }
];

const vec = (v) => ({ x: Number(v?.x) || 0, y: Number(v?.y) || 0, z: Number(v?.z) || 0 });

// The player state the game reported, as the sync protocol carries it. `vehicleId` is filled in by the caller
// from the game's vehicle handle.
function toWireState(s, vehicleId) {
  return {
    position: vec(s.position),
    velocity: vec(s.velocity),
    heading: Number(s.heading) || 0,
    flags: ((Number(s.flags) || 0) & ~SYNC_FLAG.IN_VEHICLE) | (vehicleId ? SYNC_FLAG.IN_VEHICLE : 0),
    model: Number(s.model) >>> 0,
    health: Number(s.health) || 0,
    armour: Number(s.armour) || 0,
    weapon: Number(s.weapon) >>> 0,
    aim: vec(s.aim),
    vehicleId,
    seat: vehicleId ? Number(s.seat) || 0 : 0
  };
}

function toWireVehicle(v) {
  const rotation = v.rotation && ["x", "y", "z", "w"].every((k) => Number.isFinite(v.rotation[k])) ? v.rotation : quatFromHeading(v.heading);
  return {
    model: Number(v.model) >>> 0,
    position: vec(v.position),
    rotation,
    velocity: vec(v.velocity),
    health: Number(v.health) || 0,
    steering: Number(v.steering) || 0,
    flags: Number(v.flags) || 0
  };
}

class GameClient extends EventEmitter {
  // bridge: a connected Bridge. settings: from readSettings. log: { info, warn, error }.
  // overlay: an OverlayLink (the launcher's overlay), or one without a channel.
  constructor({ settings, bridge, log, createSync = (options) => new SyncClient(options), fetchInfo = defaultFetchInfo, overlay = new OverlayLink({ channel: null }), scripts = true }) {
    super();
    this.overlay = overlay;
    this.useScripts = scripts;
    this.scripts = null; // ScriptHost, once joined
    this.local = null; // the last player.read result, for scripts' player table
    this.uiPackages = new Set(); // packages whose files the overlay knows
    this.nextUi = 1;
    this.settings = settings;
    this.bridge = bridge;
    this.log = log;
    this.createSync = createSync;
    this.fetchInfo = fetchInfo;
    this.sync = null;
    this.unavailable = new Set(); // operations the emulator turned out not to support
    this.busy = false;
    this.lastStateAt = -Infinity;
    this.stopped = false;

    this.peds = new Map(); // remote player id -> game handle
    this.cars = new Map(); // server vehicle id -> game handle, for vehicles we spawned for others
    this.ownCars = new Map(); // game handle -> { localId, vehicleId }, cars the game spawned that we registered
    this.nextLocalId = 1;
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  can(op) {
    return this.bridge.can(op) && !this.unavailable.has(op);
  }

  // Calls a game operation the emulator listed. Returns its result, or undefined if it failed (logged).
  async call(op, args) {
    try {
      return await this.bridge.request(op, args);
    } catch (err) {
      if (err.code === "unsupported") {
        this.unavailable.add(op);
        this.log.warn(`The emulator listed ${op} but says it can't do it: ${err.message}`);
      } else if (err.code !== "closed") {
        this.warnOnce(`${op}:${err.code}`, `${op} failed (${err.code}): ${err.message}`);
      }
      return undefined;
    }
  }

  warnOnce(key, message) {
    this.warned ??= new Set();
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  // Joins the server. Resolves once joined; `done` resolves when the session ends.
  async start() {
    const info = this.bridge.info;
    this.log.info(`Emulator: ${info.emulator} ${info.emulatorVersion}, game build ${info.build ?? `unknown (${String(info.buildHash).slice(0, 16)}…)`}.`);
    const caps = [...this.bridge.capabilities];
    this.log.info(caps.length ? `Game operations available: ${caps.join(", ")}.` : "The emulator can't do any game operations with this build yet.");
    for (const feature of FEATURES) {
      const missing = feature.ops.filter((op) => !this.bridge.can(op));
      if (missing.length) this.log.warn(`Not available yet: ${feature.what}. Missing: ${missing.join(", ")}.`);
    }

    const serverInfo = await this.fetchInfo(this.settings.host, this.settings.port);
    if (!serverInfo.sync) throw Object.assign(new Error("This server doesn't run player sync."), { code: "NO_SYNC" });
    if (serverInfo.sync.version !== SYNC_VERSION) {
      throw Object.assign(new Error(`The server speaks sync version ${serverInfo.sync.version}; this client speaks ${SYNC_VERSION}. Update whichever is older.`), { code: "VERSION" });
    }

    const sync = this.createSync({ host: this.settings.host, port: serverInfo.sync.port, name: this.settings.name, ticket: this.settings.ticket });
    this.sync = sync;
    sync.on("streamOut", (id) => this.removePed(id));
    sync.on("vehicleOut", (id) => this.removeCar(id));
    sync.on("vehicleAssigned", (localId, vehicleId) => {
      for (const own of this.ownCars.values()) if (own.localId === localId) own.vehicleId = vehicleId;
    });
    sync.on("role", ({ character, host }) => this.onRole(character, host));
    sync.on("world", (world) => this.onWorld(world));
    sync.on("notice", (text) => {
      this.show("screen.notify", { text }, `[notice] ${text}`);
      this.overlay.post({ t: "notice", text });
      this.scripts?.dispatch("notice", [text]);
    });
    sync.on("chat", (playerId, text) => {
      const name = playerId === 0 ? "Server" : sync.players.get(playerId)?.name ?? `#${playerId}`;
      this.show("screen.chat", { name, text }, `[chat] ${name}: ${text}`);
      this.overlay.post({ t: "chat", name, text });
      this.scripts?.dispatch("chat", [name, text, playerId]);
    });
    sync.on("event", (name, args) => this.scripts?.dispatch(name, args));
    sync.on("roster", (players) => this.onRoster(players));
    sync.on("close", ({ reason, kicked }) => this.stop(kicked ? `Kicked: ${reason}` : reason));

    const joined = await sync.connect();
    this.log.info(`Joined ${this.settings.host}:${this.settings.port} as ${this.settings.name} (player #${joined.playerId}, ${joined.tickRate} updates a second${this.settings.ticket ? ", verified" : ", no join ticket"}).`);

    this.overlay.post({ t: "session", server: `${this.settings.host}:${this.settings.port}`, player: { id: joined.playerId, name: this.settings.name } });
    this.overlay.on("chat.send", ({ text }) => typeof text === "string" && text.trim() && sync.sendChat(text.slice(0, 500)));
    this.overlay.on("ui.message", ({ id, name, data }) => this.scripts?.uiMessage(String(id), String(name), data));
    if (!this.overlay.available) this.log.info("No overlay (the client wasn't started by the launcher): chat and script UI pages only go to this log.");
    if (this.useScripts) await this.startScripts();

    this.bridge.on("frame", () => this.onFrame());
    this.bridge.on("exit", (code) => this.stop(`The game exited (${code}).`));
    this.bridge.on("close", (reason) => this.stop(reason));
    return joined;
  }

  // Client scripts from the server's resources and the enabled mods (docs/client-scripting.md).
  async startScripts() {
    const { packages, warnings } = loadPackages({ contentFile: this.settings.contentFile, modsFile: this.settings.modsFile });
    for (const w of warnings) this.log.warn(w);
    if (!packages.length) return;
    this.scripts = new ScriptHost({ api: this.scriptApi() });
    this.scripts.setPlayer(this.playerSnapshot());
    await this.scripts.start(packages);
  }

  scriptApi() {
    const sync = this.sync;
    return {
      log: (pkg, level, text) => this.log[level === "error" ? "error" : level === "warn" ? "warn" : "info"](`[${pkg.kind} ${pkg.name}] ${text}`),
      sendServerEvent: (name, args) => sync.sendEvent(name, args),
      sendChat: (text) => sync.sendChat(String(text).slice(0, 500)),
      notify: (text) => {
        this.show("screen.notify", { text }, `[notice] ${text}`);
        this.overlay.post({ t: "notice", text });
      },
      players: () => [...sync.players.values()].map((p) => ({ id: p.id, name: p.name, is_host: p.host, character: p.character || undefined })),
      time: () => sync.gameTime(),
      weather: () => sync.world?.weather,
      uiOpen: (pkg, file) => this.openUi(pkg, file),
      uiSend: (id, name, data) => this.overlay.post({ t: "ui.send", id, name, data }),
      uiShow: (id, visible) => this.overlay.post({ t: "ui.show", id, visible })
    };
  }

  openUi(pkg, file) {
    if (!pkg.files.has(file) || !/\.html?$/i.test(file)) throw new Error(`ui.overlay: no HTML page ${file} in this package`);
    const id = `${pkg.key}/${this.nextUi++}`;
    if (!this.uiPackages.has(pkg.key)) {
      this.uiPackages.add(pkg.key);
      this.overlay.post({ t: "package", key: pkg.key, name: pkg.name, files: Object.fromEntries(pkg.files) });
    }
    if (!this.overlay.post({ t: "ui.open", id, key: pkg.key, path: file })) this.warnOnce("no-overlay-ui", `${pkg.name} opened ${file}, but there's no overlay to show it in.`);
    return id;
  }

  onRoster(players) {
    const before = this.rosterSeen ?? new Map();
    for (const [id, p] of players) if (!before.has(id) && id !== this.sync.playerId) this.scripts?.dispatch("playerJoined", [{ id, name: p.name }]);
    for (const [id, p] of before) if (!players.has(id)) this.scripts?.dispatch("playerLeft", [{ id, name: p.name }]);
    this.rosterSeen = new Map(players);
    this.overlay.post({ t: "players", players: [...players.values()].map((p) => ({ id: p.id, name: p.name, host: p.host, me: p.id === this.sync.playerId })) });
  }

  // What scripts see as `player`: who we are, plus what the game reported, if it can. Nothing is filled in for
  // what the game can't report.
  playerSnapshot() {
    const sync = this.sync;
    const snapshot = { id: sync?.playerId ?? undefined, name: this.settings.name, is_host: sync?.isHost ?? false, character: sync?.character || undefined };
    const s = this.local;
    if (s) {
      const speed = Math.hypot(s.velocity?.x || 0, s.velocity?.y || 0, s.velocity?.z || 0);
      Object.assign(snapshot, {
        position: s.position,
        heading: s.heading,
        health: s.health,
        armour: s.armour,
        speed,
        dead: (s.flags & SYNC_FLAG.DEAD) !== 0,
        in_vehicle: Boolean(s.vehicleId),
        vehicle: s.vehicleId ? { id: s.vehicleId, seat: s.seat, speed } : undefined
      });
    }
    return snapshot;
  }

  onFrame() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.tick()
      .catch((err) => this.log.error(`Frame update failed: ${err.stack || err.message}`))
      .finally(() => {
        this.busy = false;
      });
  }

  // One frame: report our player and the cars we simulate (at the server's tick rate), then place the others.
  async tick() {
    const sync = this.sync;
    if (!sync?.connected) return;
    const now = performance.now();
    if (now - this.lastStateAt >= 1000 / (sync.tickRate || 20)) {
      this.lastStateAt = now;
      await this.reportLocal();
      await this.reportCars();
    }
    await this.placePlayers();
    await this.placeCars();
  }

  async reportLocal() {
    if (!this.can("player.read")) return;
    const state = await this.call("player.read");
    if (!state) return;
    let vehicleId = 0;
    const handle = state.vehicle ?? null;
    if (handle !== null && handle !== undefined) {
      vehicleId = this.vehicleIdForHandle(handle);
      // A car the game spawned (a parked car we got into): register it so others see it.
      if (!vehicleId && this.can("vehicle.read")) await this.registerOwnCar(handle);
    }
    const wire = toWireState(state, vehicleId);
    this.local = wire;
    this.sync.sendState(wire);
    this.scripts?.setPlayer(this.playerSnapshot());
  }

  vehicleIdForHandle(handle) {
    for (const [id, h] of this.cars) if (h === handle) return id;
    return this.ownCars.get(handle)?.vehicleId ?? 0;
  }

  async registerOwnCar(handle) {
    let own = this.ownCars.get(handle);
    if (!own) {
      own = { localId: this.nextLocalId, vehicleId: 0 };
      this.nextLocalId = (this.nextLocalId % 65535) + 1;
      this.ownCars.set(handle, own);
    }
    const car = await this.call("vehicle.read", { handle });
    if (car) this.sync.sendVehicleState({ localId: own.localId }, toWireVehicle(car));
  }

  // Cars the server says this game simulates: read them from the game and report them.
  async reportCars() {
    if (!this.can("vehicle.read")) return;
    for (const vehicleId of this.sync.controlledVehicles()) {
      const handle = this.cars.get(vehicleId) ?? [...this.ownCars].find(([, own]) => own.vehicleId === vehicleId)?.[0];
      if (handle === undefined) continue;
      const car = await this.call("vehicle.read", { handle });
      if (car) this.sync.sendVehicleState({ vehicleId }, toWireVehicle(car));
    }
  }

  async placePlayers() {
    if (!["ped.create", "ped.update"].every((op) => this.can(op))) return;
    for (const { id, name, state } of this.sync.view()) {
      if (!state) continue;
      let handle = this.peds.get(id);
      if (handle === undefined) {
        const made = await this.call("ped.create", { model: state.model, position: state.position, heading: state.heading, name });
        if (made?.handle === undefined) continue;
        handle = made.handle;
        this.peds.set(id, handle);
      }
      const car = state.vehicleId ? this.cars.get(state.vehicleId) ?? [...this.ownCars].find(([, o]) => o.vehicleId === state.vehicleId)?.[0] : undefined;
      // The name too: the player list can arrive after the character was created.
      await this.call("ped.update", { handle, name, state: { ...state, vehicle: car ?? null } });
    }
  }

  async placeCars() {
    if (!["vehicle.create", "vehicle.update"].every((op) => this.can(op))) return;
    for (const { id, mine, state } of this.sync.vehicleView()) {
      if (!state) continue;
      // Our own registered cars are in the game already.
      if ([...this.ownCars.values()].some((own) => own.vehicleId === id)) continue;
      let handle = this.cars.get(id);
      if (handle === undefined) {
        const made = await this.call("vehicle.create", { model: state.model, position: state.position, rotation: state.rotation });
        if (made?.handle === undefined) continue;
        handle = made.handle;
        this.cars.set(id, handle);
      }
      // Cars we simulate are left to the game's physics; the rest follow the server.
      if (!mine) await this.call("vehicle.update", { handle, state });
    }
  }

  removePed(playerId) {
    const handle = this.peds.get(playerId);
    this.peds.delete(playerId);
    if (handle !== undefined && this.can("ped.delete")) this.call("ped.delete", { handle });
  }

  removeCar(vehicleId) {
    const handle = this.cars.get(vehicleId);
    this.cars.delete(vehicleId);
    if (handle !== undefined && this.can("vehicle.delete")) this.call("vehicle.delete", { handle });
    for (const own of this.ownCars.values()) if (own.vehicleId === vehicleId) own.vehicleId = 0;
  }

  onRole(character, host) {
    this.log.info(`Role: ${host ? "host (your game runs the story)" : "not the host"}, character ${character ? `0x${character.toString(16)}` : "your own"}.`);
    if (character && this.can("player.setModel")) this.call("player.setModel", { model: character });
  }

  onWorld(world) {
    const time = this.sync.gameTime();
    this.scripts?.dispatch("world", [time, world.weather]);
    this.log.info(`World: ${time ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` : "?"}, ${world.weather}, ${world.scale} in-game minutes a minute.`);
    if (!this.can("world.set") || !time) return;
    this.call("world.set", { ...time, scale: world.scale, weather: world.weatherChanged ? world.weather : undefined, transition: world.transition });
  }

  show(op, args, line) {
    this.log.info(line);
    if (this.can(op)) this.call(op, args);
  }

  async stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.log.info(`Leaving: ${reason}`);
    this.scripts?.stop();
    this.overlay.post({ t: "end", reason });
    for (const id of [...this.peds.keys()]) this.removePed(id);
    for (const id of [...this.cars.keys()]) this.removeCar(id);
    await this.sync?.close(reason);
    this.bridge.close();
    this.finish(reason);
  }
}

async function defaultFetchInfo(host, port) {
  const base = host.includes(":") ? `[${host}]` : host;
  const res = await fetch(`http://${base}:${port}/projectvi/info`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The server answered ${res.status} for its info.`);
  return res.json();
}

module.exports = { GameClient, FEATURES, toWireState, toWireVehicle };
