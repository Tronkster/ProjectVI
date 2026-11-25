// Join tickets: proof, signed by this master server, of who a player is, for one game server, for two minutes.
//
//   POST /api/join-ticket  🔒  { serverId }  ->  { ticket, expiresAt }
//   GET  /api/ticket-key                     ->  { algorithm: "Ed25519", publicKey, keyId }
//
// The launcher asks for a ticket as it starts the game and hands it over in PROJECTVI_TICKET; the client sends it
// in HELLO, and the game server checks it with the public key (server/src/tickets.js). That's how a game server
// learns a player's Discord or guest identifier, which its permissions are written in.
//
// Tickets are only issued for servers on the list, and their audience is the server's id here ("ip:port", as this
// master server sees it). A game server learns its own id from its heartbeat, so it can tell a ticket meant for
// another server and refuse it: a server can't collect tickets and replay them somewhere else.
//
// Format: "v1.<payload>.<signature>", both base64url. The payload is JSON:
//   { aud, sub, name, iat, exp, jti }   sub is "discord:<id>" or "guest:<id>"; times are Unix seconds.
// The signature is Ed25519 over the ASCII bytes of "v1.<payload>".

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { send, readJson } = require("./http-util");

const TICKET_SECONDS = 120;
const TICKETS_PER_MINUTE = 30;

// Loads the signing key from file, creating it on first use. Without a file (tests), the key lives in memory.
function loadSigningKey(file) {
  if (file && fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return privateKey;
}

function createTickets({ keyFile = null, now, sessionUser, getServer }) {
  const privateKey = loadSigningKey(keyFile);
  const publicDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicKey = publicDer.toString("base64");
  const keyId = crypto.createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
  const hits = new Map(); // user id -> { windowStart, count }

  function limited(userId) {
    const t = now();
    const entry = hits.get(userId);
    if (!entry || t - entry.windowStart > 60_000) {
      hits.set(userId, { windowStart: t, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > TICKETS_PER_MINUTE;
  }

  function issue(user, serverId) {
    const iat = Math.floor(now() / 1000);
    const payload = {
      aud: serverId,
      sub: `${user.provider}:${user.provider_id}`,
      name: user.display_name,
      iat,
      exp: iat + TICKET_SECONDS,
      jti: crypto.randomBytes(12).toString("base64url")
    };
    const signed = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const signature = crypto.sign(null, Buffer.from(signed), privateKey).toString("base64url");
    return { ticket: `${signed}.${signature}`, expiresAt: payload.exp * 1000 };
  }

  function sweep() {
    const t = now();
    for (const [k, v] of hits) if (t - v.windowStart > 60_000) hits.delete(k);
  }

  async function handle(req, res, url) {
    if (url.pathname === "/api/ticket-key" && req.method === "GET") {
      send(res, 200, { algorithm: "Ed25519", publicKey, keyId });
      return true;
    }
    if (url.pathname !== "/api/join-ticket") return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "Use POST." });
      return true;
    }
    const user = sessionUser(req);
    if (!user) {
      send(res, 401, { error: "Not logged in." });
      return true;
    }
    if (limited(user.id)) {
      send(res, 429, { error: "Too many join tickets. Wait a minute." });
      return true;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      send(res, 400, { error: err.message });
      return true;
    }
    const serverId = typeof body?.serverId === "string" ? body.serverId : "";
    if (!serverId || !getServer(serverId)) {
      send(res, 404, { error: "That server isn't on the list, so it can't check a ticket." });
      return true;
    }
    send(res, 200, issue(user, serverId));
    return true;
  }

  return { handle, sweep, publicKey, keyId, issue };
}

module.exports = { createTickets, TICKET_SECONDS };
