// Optional Discord login for the launcher (RFC 8252 loopback flow with a PKCE-style check).
//
// 1. Launcher opens  /auth/discord/start?challenge&port&state  in the browser.
// 2. We send the browser to Discord. Discord sends it back to /auth/discord/callback.
// 3. We swap Discord's code for the user's profile (the client secret never leaves this server),
//    then send the browser to http://127.0.0.1:<port>/callback with a one-time code.
// 4. The launcher posts that code plus its verifier to /auth/exchange and gets a session token.
//
// Only Discord's "identify" scope is requested: id, username, display name and avatar.

const crypto = require("node:crypto");
const { clientIp, send, redirect, page, readJson, bearerToken } = require("./http-util");
const { GUEST_SESSION_DAYS } = require("./db");

const GUESTS_PER_HOUR = 10;
const PENDING_MS = 10 * 60_000;
const CODE_MS = 60_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

const sha256url = (text) => crypto.createHash("sha256").update(text).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// avatarUrl is a picture the player uploaded (a path on this server), else their Discord picture.
// color is the background for their initials when there's no picture.
function publicUser(row) {
  const discordAvatar = row.avatar ? `https://cdn.discordapp.com/avatars/${row.provider_id}/${row.avatar}.png?size=128` : "";
  return {
    name: row.display_name,
    username: row.username,
    provider: row.provider,
    avatarUrl: row.avatar_key ? `/avatars/${row.avatar_key}` : discordAvatar,
    color: row.avatar_color || ""
  };
}

function createAuth({ db, discord, publicUrl, now }) {
  const pending = new Map(); // our state -> { challenge, port, launcherState, expires }
  const codes = new Map(); // one-time code -> { userId, challenge, expires }
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/auth/discord/callback`;

  const guestHits = new Map(); // ip -> { windowStart, count }
  function guestLimited(ip) {
    const t = now();
    const entry = guestHits.get(ip);
    if (!entry || t - entry.windowStart > 3_600_000) {
      guestHits.set(ip, { windowStart: t, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > GUESTS_PER_HOUR;
  }

  function sweep() {
    const t = now();
    for (const [k, v] of guestHits) if (t - v.windowStart > 3_600_000) guestHits.delete(k);
    for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
    for (const [k, v] of codes) if (v.expires < t) codes.delete(k);
    db.deleteExpiredSessions(t);
  }

  async function discordProfile(code) {
    const tokenRes = await fetch(`${discord.apiBase}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
    const { access_token: accessToken } = await tokenRes.json();
    const meRes = await fetch(`${discord.apiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!meRes.ok) throw new Error(`Discord profile request failed (${meRes.status})`);
    const me = await meRes.json();
    if (typeof me.id !== "string" || typeof me.username !== "string") throw new Error("Discord sent an unexpected profile.");
    return me;
  }

  function sessionUser(req) {
    return db.userForToken(bearerToken(req), now());
  }

  // Returns true if it handled the request.
  async function handle(req, res, url) {
    const { pathname, searchParams } = url;

    if (req.method === "GET" && pathname === "/auth/config") {
      send(res, 200, { discord: Boolean(discord) });
      return true;
    }

    if (pathname.startsWith("/auth/discord/") && !discord) {
      send(res, 501, { error: "Login isn't set up on this master server." });
      return true;
    }

    if (req.method === "GET" && pathname === "/auth/discord/start") {
      const challenge = searchParams.get("challenge") || "";
      const launcherState = searchParams.get("state") || "";
      const port = Number(searchParams.get("port"));
      if (challenge.length !== 43 || !B64URL.test(challenge) || !B64URL.test(launcherState) || launcherState.length < 16 || launcherState.length > 128 ||
          !Number.isInteger(port) || port < 1024 || port > 65535) {
        page(res, 400, "Login link isn't valid", "Start logging in again from the ProjectVI launcher.");
        return true;
      }
      sweep();
      const state = crypto.randomBytes(24).toString("base64url");
      pending.set(state, { challenge, port, launcherState, expires: now() + PENDING_MS });
      const target = new URL(discord.authorizeUrl);
      target.search = new URLSearchParams({
        client_id: discord.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "identify",
        state,
        prompt: "none" // skips Discord's approval screen when the player approved before
      }).toString();
      redirect(res, target.href);
      return true;
    }

    if (req.method === "GET" && pathname === "/auth/discord/callback") {
      const entry = pending.get(searchParams.get("state") || "");
      if (!entry || entry.expires < now()) {
        page(res, 400, "Login expired", "Start logging in again from the ProjectVI launcher.");
        return true;
      }
      pending.delete(searchParams.get("state"));
      const back = new URL(`http://127.0.0.1:${entry.port}/callback`);
      back.searchParams.set("state", entry.launcherState);

      const code = searchParams.get("code");
      if (!code) {
        back.searchParams.set("error", "denied");
        redirect(res, back.href);
        return true;
      }
      try {
        const me = await discordProfile(code);
        const user = db.upsertUser({
          provider: "discord",
          providerId: me.id,
          username: me.username.slice(0, 64),
          displayName: (me.global_name || me.username).slice(0, 64),
          avatar: typeof me.avatar === "string" && /^[a-z0-9_]+$/i.test(me.avatar) ? me.avatar : null
        }, now());
        const oneTime = crypto.randomBytes(32).toString("base64url");
        codes.set(oneTime, { userId: user.id, challenge: entry.challenge, expires: now() + CODE_MS });
        back.searchParams.set("code", oneTime);
      } catch (err) {
        console.error(`Login failed: ${err.message}`);
        back.searchParams.set("error", "failed");
      }
      redirect(res, back.href);
      return true;
    }

    if (req.method === "POST" && pathname === "/auth/exchange") {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        send(res, 400, { error: err.message });
        return true;
      }
      const entry = typeof body.code === "string" ? codes.get(body.code) : undefined;
      if (entry) codes.delete(body.code); // one try only
      if (!entry || entry.expires < now() || typeof body.verifier !== "string" || !safeEqual(sha256url(body.verifier), entry.challenge)) {
        send(res, 400, { error: "That login code isn't valid anymore. Try logging in again." });
        return true;
      }
      // A guest logging in brings its friends along. The guest account is gone afterwards.
      const guest = typeof body.guestToken === "string" ? db.userForToken(body.guestToken, now()) : null;
      if (guest?.provider === "guest") db.mergeGuestInto(guest.id, entry.userId, now());
      const token = db.createSession(entry.userId, now());
      send(res, 200, { token, user: publicUser(db.userForToken(token, now())) });
      return true;
    }

    // Guest accounts exist so players without Discord can have friends. Nothing but a name is stored.
    if (req.method === "POST" && pathname === "/auth/guest") {
      if (guestLimited(clientIp(req))) {
        send(res, 429, { error: "Too many new guest accounts from this address. Try again in an hour." });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        send(res, 400, { error: err.message });
        return true;
      }
      const name = typeof body.name === "string" ? body.name.replace(/\p{Cc}/gu, "").trim().slice(0, 32) : "";
      if (!name) {
        send(res, 400, { error: "name is required (1-32 characters)." });
        return true;
      }
      const user = db.createGuest(name, now());
      const token = db.createSession(user.id, now(), GUEST_SESSION_DAYS);
      send(res, 200, { token, user: publicUser(user) });
      return true;
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      const token = bearerToken(req);
      if (token) db.deleteSession(token);
      send(res, 200, { ok: true });
      return true;
    }

    // Other methods on /api/me are the profile module's (src/profile.js).
    if ((pathname === "/api/me" && req.method === "GET") || pathname === "/api/me/favorites") {
      const user = sessionUser(req);
      if (!user) {
        send(res, 401, { error: "Not logged in." });
        return true;
      }
      if (req.method === "GET" && pathname === "/api/me") {
        send(res, 200, { user: publicUser(user), acceptRequests: user.friend_requests_open !== 0 });
        return true;
      }
      if (req.method === "GET") {
        send(res, 200, { favorites: db.getFavorites(user.id) });
        return true;
      }
      if (req.method === "PUT") {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          send(res, 400, { error: err.message });
          return true;
        }
        const list = Array.isArray(body.favorites) ? body.favorites : null;
        if (!list || list.length > 500 || !list.every((id) => typeof id === "string" && id.length > 0 && id.length <= 300)) {
          send(res, 400, { error: "favorites must be a list of up to 500 server ids." });
          return true;
        }
        db.setFavorites(user.id, [...new Set(list)]);
        send(res, 200, { favorites: db.getFavorites(user.id) });
        return true;
      }
    }

    return false;
  }

  return { handle, sweep, sessionUser };
}

module.exports = { createAuth, publicUser };
