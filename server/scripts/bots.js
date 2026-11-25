// Bots that join a game server over player sync and walk or drive around, so sync can be tested and
// loaded before the ProjectVI client can join. Each bot is a full sync client
// (packages/shared/sync-client.js) with its own UDP socket, so the server sees separate players.
//
// Usage: npm run dev:bots -- [options]          (from the repository root)
//   --server host:port   the game server (default localhost:30120)
//   --count n            how many bots (default 8)
//   --mode m             walk, drive, idle or mixed (default mixed)
//   --spread metres      how far from the centre they roam (default 150)
//   --center x,y,z       where they roam (default the server's spawn point)
//   --name prefix        names are the prefix and a number (default Bot)
//   --view port          a live map of what the first bot sees, on http://127.0.0.1:<port>

const http = require("node:http");
const { parseArgs } = require("node:util");
const { SYNC_VERSION, SYNC_FLAG, SYNC_VEHICLE_FLAG, joaat, quatFromHeading, headingFromQuat, validatePlayerName } = require("@projectvi/shared");
const { SyncClient } = require("@projectvi/shared/sync-client");
const { DEFAULT_SPAWN } = require("../src/core/server-core");

const WALK_SPEED = 1.4; // m/s
const RUN_SPEED = 5;
// GTA V names: any hash will do until the client maps models.
const BOT_CAR = joaat("sultan");
const UNARMED = joaat("weapon_unarmed");
const OWN_CAR = 1; // the local id a driving bot registers its car under
// For labels on the live map: the server's default story characters.
const CHARACTER_NAMES = new Map(["lucia", "jason"].map((name) => [joaat(name), name[0].toUpperCase() + name.slice(1)]));
const characterName = (hash) => (hash ? (CHARACTER_NAMES.get(hash) ?? `0x${hash.toString(16)}`) : "");
// The server takes 5 HELLOs a second from one address, and every bot shares ours.
const JOINS_PER_SECOND = 4;
const MODES = ["walk", "drive", "idle", "mixed"];

const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

// Degrees, 0 = north (+y), turning counter-clockwise: GTA V's convention, to be confirmed in GTA VI.
function headingOf(vx, vy) {
  return ((Math.atan2(-vx, vy) * 180) / Math.PI + 360) % 360;
}

// A player state with everything a bot doesn't vary filled in. Model 0 leaves the look to each client.
function playerState(position, velocity, heading, flags, extra = {}) {
  return { position, velocity, heading, flags, model: 0, health: 200, armour: 0, weapon: UNARMED, aim: ZERO, vehicleId: 0, seat: 0, ...extra };
}

// Moves one bot around `center`. step(dt) advances it dt seconds and returns { player, vehicle }: the
// player's state for STATE and, while driving, the car's for VEHICLE_STATE (null on foot).
// random returns a number in [0, 1); tests pass their own to make movement repeatable.
function createMover({ mode, center, spread, random = Math.random }) {
  const pointNear = (c, radius) => {
    const angle = random() * 2 * Math.PI;
    const distance = Math.sqrt(random()) * radius; // even spread over the disc, not bunched in the middle
    return { x: c.x + Math.cos(angle) * distance, y: c.y + Math.sin(angle) * distance, z: c.z };
  };

  if (mode === "drive") {
    // Laps of a circle that fits inside the area.
    const radius = spread * (0.2 + 0.4 * random());
    const middle = pointNear(center, spread - radius);
    const speed = 12 + 16 * random();
    const direction = random() < 0.5 ? 1 : -1;
    let angle = random() * 2 * Math.PI;
    return {
      step(dt) {
        angle += (direction * speed * dt) / radius;
        const position = { x: middle.x + Math.cos(angle) * radius, y: middle.y + Math.sin(angle) * radius, z: middle.z };
        const velocity = { x: -Math.sin(angle) * speed * direction, y: Math.cos(angle) * speed * direction, z: 0 };
        const heading = headingOf(velocity.x, velocity.y);
        return {
          player: playerState(position, velocity, heading, SYNC_FLAG.IN_VEHICLE),
          vehicle: {
            model: BOT_CAR,
            position,
            rotation: quatFromHeading(heading),
            velocity,
            health: 1000,
            steering: direction * 0.3,
            flags: SYNC_VEHICLE_FLAG.ENGINE_ON | SYNC_VEHICLE_FLAG.LIGHTS
          }
        };
      }
    };
  }

  const position = pointNear(center, spread);
  let heading = random() * 360;

  if (mode === "idle") {
    return {
      step(dt) {
        if (random() < dt * 0.2) heading = random() * 360; // look around now and then
        return { player: playerState({ ...position }, ZERO, heading, 0), vehicle: null };
      }
    };
  }

  // Walk (sometimes run) to a random point, wait a moment, repeat.
  let target = null;
  let speed = 0;
  let wait = random() * 2;
  return {
    step(dt) {
      let velocity = ZERO;
      if (wait > 0) {
        wait -= dt;
      } else {
        if (!target) {
          target = pointNear(center, spread);
          speed = random() < 0.3 ? RUN_SPEED : WALK_SPEED;
        }
        const dx = target.x - position.x;
        const dy = target.y - position.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= speed * dt) {
          position.x = target.x;
          position.y = target.y;
          target = null;
          wait = 1 + 3 * random();
        } else {
          velocity = { x: (dx / distance) * speed, y: (dy / distance) * speed, z: 0 };
          position.x += velocity.x * dt;
          position.y += velocity.y * dt;
          heading = headingOf(velocity.x, velocity.y);
        }
      }
      const flags = velocity === ZERO ? 0 : SYNC_FLAG.ON_FOOT_MOVING;
      return { player: playerState({ ...position }, velocity, heading, flags), vehicle: null };
    }
  };
}

// One bot: a sync client that sends its mover's state every tick once it has joined. It plays the story
// character the server gives it, as the game client will. A driving bot registers its car, and any empty
// vehicle the server hands the bot is reported standing still.
function createBot({ host, port, name, mover, clientOptions = {} }) {
  const client = new SyncClient({ host, port, name, ...clientOptions });
  let state = null;
  let timer = null;
  client.once("close", () => clearInterval(timer));
  return {
    name,
    client,
    get state() {
      return state;
    },
    async start() {
      const { tickRate } = await client.connect();
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        const { player, vehicle } = mover.step((now - last) / 1000);
        last = now;
        player.model = client.character || player.model;
        if (vehicle) {
          client.sendVehicleState({ localId: OWN_CAR }, vehicle);
          player.vehicleId = client.vehicleIdFor(OWN_CAR); // 0 until the server has answered
        }
        state = player;
        client.sendState(player);
        const own = client.vehicleIdFor(OWN_CAR);
        for (const v of client.vehicleView()) {
          if (v.mine && v.id !== own) client.sendVehicleState({ vehicleId: v.id }, { ...v.state, velocity: ZERO });
        }
      };
      tick();
      timer = setInterval(tick, 1000 / tickRate);
    },
    stop: () => client.close()
  };
}

// ---- Live map ----

const VIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ProjectVI bots</title>
<style>html,body{margin:0;height:100%;background:#111;color:#ddd;font:13px system-ui,sans-serif}canvas{display:block}
#legend{position:fixed;top:10px;left:12px;line-height:1.6}</style></head>
<body><canvas id="map"></canvas><div id="legend"></div>
<script>
const canvas = document.getElementById("map");
const legend = document.getElementById("legend");
const ctx = canvas.getContext("2d");
new EventSource("/frames").onmessage = (e) => draw(JSON.parse(e.data));
function draw(f) {
  const w = (canvas.width = innerWidth), h = (canvas.height = innerHeight);
  const scale = Math.min(w, h) / 2 / (f.spread * 1.15);
  const sx = (x) => w / 2 + (x - f.center.x) * scale, sy = (y) => h / 2 - (y - f.center.y) * scale;
  ctx.strokeStyle = "#333";
  ctx.beginPath(); ctx.arc(w / 2, h / 2, f.spread * scale, 0, 7); ctx.stroke();
  ctx.strokeStyle = "#666";
  for (const t of f.truth) { ctx.beginPath(); ctx.arc(sx(t.x), sy(t.y), 7, 0, 7); ctx.stroke(); }
  for (const v of f.vehicles) {
    const len = Math.max(4.6 * scale, 12), wid = Math.max(2 * scale, 6);
    ctx.save(); ctx.translate(sx(v.x), sy(v.y)); ctx.rotate((-v.heading * Math.PI) / 180);
    ctx.strokeStyle = "#f4a340"; ctx.strokeRect(-wid / 2, -len / 2, wid, len);
    ctx.restore();
    ctx.fillStyle = "#888"; ctx.fillText(v.controller, sx(v.x) + 8, sy(v.y) + 14);
  }
  for (const p of f.seen) {
    const x = sx(p.x), y = sy(p.y), a = (p.heading * Math.PI) / 180;
    ctx.fillStyle = ctx.strokeStyle = p.inVehicle ? "#f4a340" : "#5aa9f4";
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.sin(a) * 12, y - Math.cos(a) * 12); ctx.stroke();
    ctx.fillText(p.name, x + 8, y - 6);
  }
  if (f.me) { ctx.fillStyle = "#fff"; ctx.fillRect(sx(f.me.x) - 4, sy(f.me.y) - 4, 8, 8); }
  legend.textContent = f.observer + (f.role ? " (" + f.role + ")" : "") + " (white square) sees " + f.seen.length + " players and " + f.vehicles.length +
    " vehicles, drawn " + f.delayMs + " ms in the past as the client would. Grey rings: where the bots really are. " +
    "Blue on foot, orange driving. ★ is the host. Boxes are vehicles, labelled with the player who simulates them.";
}
</script></body></html>`;

function startView({ port, observer, bots, center, spread }) {
  const frame = () => ({
    observer: observer.name,
    delayMs: observer.client.delayMs,
    center,
    spread,
    me: observer.state?.position ?? null,
    role: [characterName(observer.client.character), observer.client.isHost ? "host" : ""].filter(Boolean).join(", "),
    seen: observer.client.view().map(({ id, name, state }) => ({
      name: [name ?? `#${id}`, characterName(state.model) && `(${characterName(state.model)})`, observer.client.hostId === id ? "★" : ""].filter(Boolean).join(" "),
      x: state.position.x,
      y: state.position.y,
      heading: state.heading,
      inVehicle: (state.flags & SYNC_FLAG.IN_VEHICLE) !== 0
    })),
    vehicles: observer.client.vehicleView().map(({ controller, state }) => ({
      x: state.position.x,
      y: state.position.y,
      heading: headingFromQuat(state.rotation),
      controller: controller === observer.client.playerId ? observer.name : (observer.client.players.get(controller)?.name ?? (controller ? `#${controller}` : "nobody"))
    })),
    truth: bots.filter((b) => b !== observer && b.client.connected && b.state).map((b) => ({ x: b.state.position.x, y: b.state.position.y }))
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(VIEW_HTML);
    }
    if (req.url === "/frames") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      const timer = setInterval(() => res.write(`data: ${JSON.stringify(frame())}\n\n`), 50);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => console.log(`Live map: http://127.0.0.1:${port}`));
  return server;
}

// ---- Command line ----

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        server: { type: "string", default: "localhost:30120" },
        count: { type: "string", default: "8" },
        mode: { type: "string", default: "mixed" },
        spread: { type: "string", default: "150" },
        center: { type: "string" },
        name: { type: "string", default: "Bot" },
        view: { type: "string" }
      }
    }));
  } catch (err) {
    fail(`${err.message}\nSee the top of server/scripts/bots.js for the options.`);
  }
  const match = /^(.+):(\d+)$/.exec(values.server);
  if (!match) fail("--server must be host:port, for example localhost:30120.");
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) fail("--count must be a whole number from 1 to 1000.");
  if (!MODES.includes(values.mode)) fail(`--mode must be one of ${MODES.join(", ")}.`);
  const spread = Number(values.spread);
  if (!(spread >= 10 && spread <= 10_000)) fail("--spread must be a number of metres from 10 to 10000.");
  let center = DEFAULT_SPAWN;
  if (values.center) {
    const parts = values.center.split(",").map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite)) fail("--center must be x,y,z, for example -1012.4,233.8,12.");
    center = { x: parts[0], y: parts[1], z: parts[2] };
  }
  const longest = validatePlayerName(`${values.name}${count}`);
  if (!longest.ok) fail(`--name doesn't make valid player names: ${longest.error}`);
  const view = values.view === undefined ? null : Number(values.view);
  if (view !== null && !(Number.isInteger(view) && view > 0 && view < 65536)) fail("--view must be a port number.");
  return { host: match[1], port: Number(match[2]), count, mode: values.mode, spread, center, prefix: values.name, view };
}

async function main() {
  const options = readOptions();
  const base = `http://${options.host}:${options.port}`;
  let info;
  try {
    const res = await fetch(`${base}/projectvi/info`, { signal: AbortSignal.timeout(5000) });
    info = await res.json();
  } catch (err) {
    fail(`Couldn't reach the game server at ${base} (${err.message}). Is it running? Try npm run dev:server.`);
  }
  if (!info.sync) fail("Player sync is off on that server ([sync] enabled = false in server.toml).");
  if (info.sync.version !== SYNC_VERSION) fail(`That server speaks sync version ${info.sync.version}; these bots speak ${SYNC_VERSION}.`);
  const free = info.maxPlayers - info.players;
  if (options.count > free) console.log(`"${info.name}" has ${free} free slots, so ${options.count - free} bots will be turned away.`);

  const bots = [];
  let stopping = false;
  for (let i = 0; i < options.count; i++) {
    const mode = options.mode === "mixed" ? ["walk", "drive", "walk", "idle"][i % 4] : options.mode;
    const bot = createBot({
      host: options.host,
      port: info.sync.port,
      name: `${options.prefix}${i + 1}`,
      mover: createMover({ mode, center: options.center, spread: options.spread })
    });
    bot.client.on("close", ({ reason }) => {
      // A bot that never joined is reported by start() instead.
      if (!stopping && bot.client.playerId !== null) console.log(`${bot.name} left: ${reason}`);
    });
    bots.push(bot);
  }

  process.on("SIGINT", async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Leaving…");
    await Promise.all(bots.map((b) => b.stop()));
    process.exit(0);
  });

  if (options.view) startView({ port: options.view, observer: bots[0], bots, center: options.center, spread: options.spread });

  let previous = { snapshots: 0, missed: 0, at: performance.now() };
  setInterval(() => {
    const live = bots.filter((b) => b.client.connected);
    const snapshots = bots.reduce((n, b) => n + b.client.stats.snapshots, 0);
    const missed = bots.reduce((n, b) => n + b.client.stats.missedTicks, 0);
    const now = performance.now();
    const perBot = live.length ? (snapshots - previous.snapshots) / ((now - previous.at) / 1000) / live.length : 0;
    const average = (fn) => (live.length ? live.reduce((n, b) => n + fn(b), 0) / live.length : 0);
    const sees = average((b) => b.client.remotes.size);
    const vehicles = average((b) => b.client.vehicles.size);
    const rtt = average((b) => b.client.rtt ?? 0);
    console.log(
      `${new Date().toLocaleTimeString()}  ${live.length}/${bots.length} in · each sees ${sees.toFixed(1)} others and ` +
        `${vehicles.toFixed(1)} vehicles · ${perBot.toFixed(1)} snapshots/s each · ${missed - previous.missed} ticks missed · ` +
        `round trip ${rtt.toFixed(1)} ms`
    );
    previous = { snapshots, missed, at: now };
  }, 5000);

  console.log(`Joining ${options.count} bots to "${info.name}", ${JOINS_PER_SECOND} a second. Ctrl+C to leave.`);
  for (const bot of bots) {
    if (stopping) break;
    bot.start().catch((err) => console.log(`${bot.name} couldn't join: ${err.message}`));
    await new Promise((resolve) => setTimeout(resolve, 1000 / JOINS_PER_SECOND));
  }
}

if (require.main === module) main();

module.exports = { createMover, createBot, headingOf };
