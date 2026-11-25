// ProjectVI master server.
// Game servers POST a heartbeat every ~30 s and the launcher GETs the list.
// Optional Discord login adds accounts and synced favorites (see src/auth.js).
// No npm dependencies: node:http and node:sqlite, so Node 22.13+ is all it needs.

const http = require("node:http");
const path = require("node:path");
const { clientIp, send, readJson } = require("./src/http-util");
const { openDatabase } = require("./src/db");
const { createAuth, publicUser } = require("./src/auth");
const { createFriends } = require("./src/friends");
const { createProfile } = require("./src/profile");
const { createTickets } = require("./src/tickets");

const MODES = ["Roleplay", "Racing", "Freeroam", "Other"];

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\p{Cc}/gu, "").trim().slice(0, maxLength);
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// Returns [record, null] or [null, errorMessage].
function validateHeartbeat(body, host, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [null, "Body must be a JSON object."];
  const name = cleanText(body.name, 64);
  if (!name) return [null, "name is required (1-64 characters)."];
  if (!intInRange(body.port, 1, 65535)) return [null, "port must be an integer between 1 and 65535."];
  if (!intInRange(body.maxPlayers, 1, 1024)) return [null, "maxPlayers must be an integer between 1 and 1024."];
  if (!intInRange(body.players, 0, body.maxPlayers)) return [null, "players must be an integer between 0 and maxPlayers."];

  return [{
    id: `${host}:${body.port}`,
    host,
    port: body.port,
    name,
    description: cleanText(body.description, 160),
    mode: MODES.includes(body.mode) ? body.mode : "Other",
    region: cleanText(body.region, 8).toUpperCase(),
    players: body.players,
    maxPlayers: body.maxPlayers,
    lastSeen: now
  }, null];
}

// Options exist so tests can control time, limits, storage and the Discord endpoints.
//   discord: null, or { clientId, clientSecret, apiBase, authorizeUrl }
function createMasterServer({
  now = Date.now,
  staleAfterMs = 90_000,
  rateLimitPerMin = 60,
  dbFile = ":memory:",
  discord = null,
  publicUrl = "http://localhost:30180",
  ticketKeyFile = null
} = {}) {
  const servers = new Map(); // "host:port" -> server record
  const hits = new Map(); // ip -> { windowStart, count }
  const db = openDatabase(dbFile);
  const auth = createAuth({ db, discord, publicUrl, now });
  const friends = createFriends({
    db,
    now,
    sessionUser: auth.sessionUser,
    publicUser,
    getServer: (id) => {
      const s = servers.get(id);
      return s && s.lastSeen >= now() - staleAfterMs ? s : null;
    }
  });
  const profile = createProfile({ db, sessionUser: auth.sessionUser, publicUser, onDeleted: friends.forget });
  const freshServer = (id) => {
    const s = servers.get(id);
    return s && s.lastSeen >= now() - staleAfterMs ? s : null;
  };
  const tickets = createTickets({ keyFile: ticketKeyFile, now, sessionUser: auth.sessionUser, getServer: freshServer });

  function rateLimited(ip) {
    const t = now();
    const entry = hits.get(ip);
    if (!entry || t - entry.windowStart > 60_000) {
      hits.set(ip, { windowStart: t, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > rateLimitPerMin;
  }

  function pruneStale() {
    const cutoff = now() - staleAfterMs;
    for (const [id, server] of servers) {
      if (server.lastSeen < cutoff) servers.delete(id);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (req.method === "GET" && url.pathname === "/api/servers") {
        pruneStale();
        const list = [...servers.values()].sort((a, b) => b.players - a.players);
        return send(res, 200, { servers: list, updatedAt: now() });
      }

      if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        const ip = clientIp(req);
        if (rateLimited(ip)) return send(res, 429, { error: "Too many heartbeats. Send one every 30 seconds." });
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        const [record, error] = validateHeartbeat(body, ip, now());
        if (error) return send(res, 400, { error });
        servers.set(record.id, record);
        return send(res, 200, { ok: true, id: record.id, nextHeartbeatInSeconds: 30 });
      }

      if (req.method === "DELETE" && url.pathname === "/api/heartbeat") {
        const port = Number(url.searchParams.get("port"));
        servers.delete(`${clientIp(req)}:${port}`);
        return send(res, 200, { ok: true });
      }

      if (await tickets.handle(req, res, url)) return;
      if (await profile.handle(req, res, url)) return;
      if (await auth.handle(req, res, url)) return;
      if (await friends.handle(req, res, url)) return;

      send(res, 404, { error: "Not found." });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on the master server." });
    }
  });

  const timer = setInterval(() => {
    pruneStale();
    auth.sweep();
    friends.sweep();
    tickets.sweep();
  }, 15_000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    db.close();
  });
  return server;
}

module.exports = { createMasterServer, validateHeartbeat, MODES };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 30180;
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const discord = process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
    ? {
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      apiBase: process.env.DISCORD_API_BASE || "https://discord.com/api/v10",
      authorizeUrl: process.env.DISCORD_AUTHORIZE_URL || "https://discord.com/oauth2/authorize"
    }
    : null;

  createMasterServer({
    dbFile: process.env.DB_FILE || path.join(__dirname, "data", "projectvi.db"),
    ticketKeyFile: process.env.TICKET_KEY_FILE || path.join(__dirname, "data", "ticket-key.pem"),
    discord,
    publicUrl
  }).listen(PORT, () => {
    console.log(`ProjectVI master server listening on http://localhost:${PORT}`);
    console.log("  GET  /api/servers     list of online servers");
    console.log("  POST /api/heartbeat   game servers report in here");
    console.log("  GET  /api/ticket-key  public key game servers check join tickets with");
    console.log(discord
      ? `  Discord login is on. Redirect URL: ${publicUrl.replace(/\/+$/, "")}/auth/discord/callback`
      : "  Discord login is off (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to turn it on).");
  });
}
