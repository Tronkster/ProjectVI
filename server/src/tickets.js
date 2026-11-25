// Checks join tickets (master-server/src/tickets.js has the format). A valid ticket tells the server who a
// player is: "discord:<id>" or "guest:<id>", which is what [permissions] in server.toml lists.
//
// What makes a ticket valid here:
// - signed by the master server's key (fetched from GET /api/ticket-key);
// - meant for this server: its audience is the id the master server gave us in the heartbeat answer;
// - not expired (a little clock difference is allowed);
// - not used before. Ticket ids are remembered until they expire, so a copied ticket can't join a second time.

const crypto = require("node:crypto");

const CLOCK_SKEW_SECONDS = 30;
const MAX_TICKET_SECONDS = 600; // longer-lived tickets are refused even if signed
const TICKET = /^v1\.([A-Za-z0-9_-]{1,1200})\.([A-Za-z0-9_-]{1,200})$/;
const SUBJECT = /^(discord|guest):[A-Za-z0-9_-]{1,64}$/;

class TicketVerifier {
  // masterUrl: the master server's base URL. now: millisecond clock.
  constructor({ masterUrl, log, now = () => Date.now(), fetchImpl = fetch }) {
    this.base = String(masterUrl || "").replace(/\/+$/, "");
    this.log = log;
    this.now = now;
    this.fetch = fetchImpl;
    this.key = null; // crypto.KeyObject
    this.keyId = "";
    this.serverId = ""; // our id on the master server, from the heartbeat
    this.used = new Map(); // jti -> exp (seconds)
    this.loading = null;
  }

  // Fetches the master server's public key. Safe to call often: one request at a time, and only until it worked.
  async loadKey() {
    if (this.key) return true;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const res = await this.fetch(`${this.base}/api/ticket-key`, { signal: AbortSignal.timeout(5000) });
          const body = await res.json();
          if (!res.ok || body.algorithm !== "Ed25519" || typeof body.publicKey !== "string") throw new Error(`HTTP ${res.status}`);
          this.key = crypto.createPublicKey({ key: Buffer.from(body.publicKey, "base64"), format: "der", type: "spki" });
          this.keyId = String(body.keyId || "");
          this.log.info(`Join tickets from ${this.base} will be checked (key ${this.keyId}).`);
        } catch (err) {
          this.log.warn(`Couldn't get the master server's ticket key (${err.message}). Players join without verified identities until it's reachable.`);
        } finally {
          this.loading = null;
        }
      })();
    }
    await this.loading;
    return Boolean(this.key);
  }

  setServerId(id) {
    if (typeof id === "string" && id && id !== this.serverId) {
      this.serverId = id;
      this.log.info(`The master server knows this server as ${id}; join tickets must be for that.`);
    }
  }

  // True once tickets can be checked: we have the key and know our id.
  get ready() {
    return Boolean(this.key && this.serverId);
  }

  // Returns { ok: true, identifier, name } or { ok: false, error } with a reason the player can be shown.
  verify(ticket) {
    if (!this.ready) return { ok: false, error: "This server can't check join tickets right now." };
    const match = TICKET.exec(ticket);
    if (!match) return { ok: false, error: "The join ticket is malformed." };
    const signed = Buffer.from(`v1.${match[1]}`);
    let good;
    try {
      good = crypto.verify(null, signed, this.key, Buffer.from(match[2], "base64url"));
    } catch {
      good = false;
    }
    if (!good) return { ok: false, error: "The join ticket isn't signed by this server's master server." };

    let payload;
    try {
      payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    } catch {
      return { ok: false, error: "The join ticket is malformed." };
    }
    const { aud, sub, name, iat, exp, jti } = payload ?? {};
    const nowSeconds = Math.floor(this.now() / 1000);
    if (aud !== this.serverId) return { ok: false, error: "The join ticket is for a different server." };
    if (!Number.isInteger(iat) || !Number.isInteger(exp) || exp - iat > MAX_TICKET_SECONDS) return { ok: false, error: "The join ticket is malformed." };
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, error: "The join ticket isn't valid yet. Check the server's clock." };
    if (exp < nowSeconds - CLOCK_SKEW_SECONDS) return { ok: false, error: "The join ticket has expired. Join again from the launcher." };
    if (typeof sub !== "string" || !SUBJECT.test(sub) || typeof jti !== "string" || !jti || jti.length > 64) {
      return { ok: false, error: "The join ticket is malformed." };
    }

    this.forgetExpired(nowSeconds);
    if (this.used.has(jti)) return { ok: false, error: "That join ticket was already used. Join again from the launcher." };
    this.used.set(jti, exp + CLOCK_SKEW_SECONDS);
    return { ok: true, identifier: sub, name: typeof name === "string" ? name : "" };
  }

  forgetExpired(nowSeconds = Math.floor(this.now() / 1000)) {
    for (const [jti, until] of this.used) if (until < nowSeconds) this.used.delete(jti);
  }
}

module.exports = { TicketVerifier };
