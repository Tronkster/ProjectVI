// Optional login through the master server (see master-server/src/auth.js for the flow).
//
// The session token stays in the main process and is encrypted at rest with Electron's
// safeStorage (DPAPI on Windows). The renderer only ever sees the public profile.
// No Electron import here: the token store and browser opener are passed in, so this is testable.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { parseMasterUrl } = require("./servers");

const LOGIN_TIMEOUT_MS = 5 * 60_000;

function createTokenStore(file, safeStorage, logger) {
  return {
    load() {
      try {
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(fs.readFileSync(file)) : "";
      } catch {
        return "";
      }
    },
    save(token) {
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn("This system can't encrypt the login, so it won't be remembered after closing the launcher");
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, safeStorage.encryptString(token));
    },
    clear() {
      fs.rmSync(file, { force: true });
    }
  };
}

function callbackPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#08090c;color:#f2f4f7;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#8b93a1">${text}</p></div>`;
}

const memoryStore = () => {
  let saved = "";
  return { load: () => saved, save: (t) => { saved = t; }, clear: () => { saved = ""; } };
};

// guestStore keeps the token of the guest account used for friends when not logged in with Discord.
function createAuth({ getSettings, tokenStore, guestStore = memoryStore(), openExternal, logger }) {
  let token = tokenStore.load();
  let guestToken = guestStore.load();
  let user = null;
  let pending = null;

  function masterBase() {
    const [url, error] = parseMasterUrl(getSettings().masterUrl);
    if (error) throw new Error(error);
    return url.href.replace(/\/+$/, "");
  }

  // as: "session" sends the Discord session; "friends" sends whichever account friends use.
  async function call(pathname, { method = "GET", body, timeoutMs = 8000, as = "session" } = {}) {
    const usesGuest = as === "friends" && !token;
    const bearer = usesGuest ? guestToken : token;
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${masterBase()}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && bearer) {
      if (usesGuest) {
        guestToken = "";
        guestStore.clear();
      } else {
        token = "";
        user = null;
        tokenStore.clear();
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  // Pictures players upload live on the master server at /avatars/<key>. The page's CSP only
  // allows data: images (and Discord's CDN), so they're fetched here once and handed over inline.
  // Keys change on every upload, so a cached picture never goes stale.
  const pictures = new Map(); // "/avatars/<key>" -> data: URL
  async function inlinePicture(person) {
    const url = person?.avatarUrl;
    if (typeof url !== "string" || !url.startsWith("/avatars/")) return;
    if (!pictures.has(url)) {
      try {
        const res = await fetch(`${masterBase()}${url}`, { signal: AbortSignal.timeout(8000) });
        const type = res.headers.get("content-type") || "";
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(type) || bytes.length > 64 * 1024) throw new Error("bad picture");
        if (pictures.size > 500) pictures.clear();
        pictures.set(url, `data:${type};base64,${bytes.toString("base64")}`);
      } catch {
        person.avatarUrl = ""; // initials instead; tried again next time
        return;
      }
    }
    person.avatarUrl = pictures.get(url);
  }
  async function inlinePictures(data) {
    const people = [data.user, data.player, ...(data.friends ?? []), ...(data.incoming ?? []), ...(data.outgoing ?? [])];
    await Promise.all(people.map(inlinePicture));
    return data;
  }

  // Friends calls answer { ok, ...data } or { ok: false, error }, never throw.
  async function friendsCall(pathname, options) {
    if (!token && !guestToken) return { ok: false, noAccount: true, error: "Turn on friends first." };
    try {
      const r = await call(pathname, { ...options, as: "friends" });
      return r.ok ? inlinePictures({ ok: true, ...r.data }) : { ok: false, status: r.status, error: r.data.error || "The master server said no." };
    } catch {
      return { ok: false, offline: true, error: "Can't reach the master server." };
    }
  }

  // Opens a one-shot listener on 127.0.0.1 and resolves with the code the browser brings back.
  function waitForBrowser(base, challenge, state) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("state") === state ? url.searchParams.get("code") : null;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(code
          ? callbackPage("You're logged in", "Go back to the ProjectVI launcher. You can close this tab.")
          : callbackPage("Login didn't finish", "Go back to the ProjectVI launcher and try again."));
        if (code) finish(null, code);
        else finish(new Error(url.searchParams.get("error") === "denied" ? "Login was cancelled in Discord." : "Login didn't finish. Try again."));
      });
      const timer = setTimeout(() => finish(new Error("Login timed out. Try again.")), LOGIN_TIMEOUT_MS);
      function finish(err, code) {
        clearTimeout(timer);
        server.close();
        pending = null;
        if (err) reject(err);
        else resolve(code);
      }
      pending = {
        cancel: () => finish(Object.assign(new Error("Login cancelled."), { cancelled: true }))
      };
      server.on("error", (err) => finish(err));
      server.listen(0, "127.0.0.1", () => {
        const query = new URLSearchParams({ challenge, port: String(server.address().port), state });
        openExternal(`${base}/auth/discord/start?${query}`);
      });
    });
  }

  return {
    async status() {
      let available = false;
      try {
        const r = await call("/auth/config", { timeoutMs: 4000 });
        available = r.ok && r.data.discord === true;
      } catch {
        // Master server offline: keep any saved login, just report login as unavailable for now.
      }
      if (token && !user) {
        try {
          const r = await call("/api/me");
          if (r.ok) user = (await inlinePictures({ user: r.data.user })).user;
        } catch {
          // offline
        }
      }
      return { available, user };
    },

    async login() {
      pending?.cancel();
      let base;
      try {
        base = masterBase();
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const state = crypto.randomBytes(16).toString("base64url");

      let code;
      try {
        code = await waitForBrowser(base, challenge, state);
      } catch (err) {
        return { ok: false, cancelled: Boolean(err.cancelled), error: err.message };
      }

      try {
        // Sending the guest token moves the guest's friends to the Discord account.
        const r = await call("/auth/exchange", { method: "POST", body: { code, verifier, ...(guestToken ? { guestToken } : {}) } });
        if (!r.ok) return { ok: false, error: r.data.error || "Login failed. Try again." };
        token = r.data.token;
        user = r.data.user;
        tokenStore.save(token);
        if (guestToken) {
          guestToken = "";
          guestStore.clear();
        }
        logger.info("Logged in", { provider: user.provider });
        return { ok: true, user };
      } catch {
        return { ok: false, error: "Can't reach the master server to finish logging in." };
      }
    },

    cancelLogin() {
      pending?.cancel();
    },

    async logout() {
      if (token) {
        try {
          await call("/api/presence", { method: "DELETE" });
          await call("/auth/logout", { method: "POST" });
        } catch {
          // The session expires on its own.
        }
      }
      token = "";
      user = null;
      tokenStore.clear();
      logger.info("Logged out");
      return { ok: true };
    },

    isLoggedIn: () => Boolean(token),
    currentUser: () => user,

    async getFavorites() {
      if (!token) return null;
      const r = await call("/api/me/favorites");
      return r.ok ? r.data.favorites : null;
    },

    async putFavorites(favorites) {
      if (!token) return null;
      const r = await call("/api/me/favorites", { method: "PUT", body: { favorites } });
      return r.ok ? r.data.favorites : null;
    },

    // ---- Friends: a Discord login, or else a guest account made when the player turns friends on ----
    hasFriendsAccount: () => Boolean(token || guestToken),

    async startGuest(name) {
      if (token || guestToken) return { ok: true };
      try {
        const r = await call("/auth/guest", { method: "POST", body: { name } });
        if (!r.ok) return { ok: false, error: r.data.error || "Couldn't turn on friends." };
        guestToken = r.data.token;
        guestStore.save(guestToken);
        logger.info("Guest account made for friends");
        return { ok: true };
      } catch {
        return { ok: false, error: "Can't reach the master server." };
      }
    },

    friends: () => friendsCall("/api/friends"),
    addFriend: (code) => friendsCall("/api/friends/requests", { method: "POST", body: { code } }),
    acceptFriend: (id) => friendsCall(`/api/friends/requests/${id}/accept`, { method: "POST" }),
    dropRequest: (id) => friendsCall(`/api/friends/requests/${id}`, { method: "DELETE" }),
    removeFriend: (id) => friendsCall(`/api/friends/${id}`, { method: "DELETE" }),
    resetFriendCode: () => friendsCall("/api/friends/code", { method: "POST" }),
    messages: (id, after) => friendsCall(`/api/friends/${id}/messages${after ? `?after=${after}` : ""}`),
    sendMessage: (id, text) => friendsCall(`/api/friends/${id}/messages`, { method: "POST", body: { text } }),
    reportPresence: (name, serverId) => friendsCall("/api/presence", { method: "PUT", body: { name, serverId }, timeoutMs: 5000 }),
    clearPresence: () => friendsCall("/api/presence", { method: "DELETE", timeoutMs: 5000 }),

    // ---- The player's own profile, for whichever account friends use ----
    me: () => friendsCall("/api/me"),
    updateProfile: (patch) => friendsCall("/api/me", { method: "PUT", body: patch }),
    setPicture: (type, data) => friendsCall("/api/me/avatar", { method: "PUT", body: { type, data }, timeoutMs: 15000 }),
    removePicture: () => friendsCall("/api/me/avatar", { method: "DELETE" }),

    // Deletes the account on the master server, then forgets it here.
    async deleteAccount() {
      const r = await friendsCall("/api/me", { method: "DELETE" });
      if (!r.ok) return r;
      token = "";
      user = null;
      guestToken = "";
      tokenStore.clear();
      guestStore.clear();
      logger.info("Account deleted on the master server");
      return { ok: true };
    }
  };
}

module.exports = { createAuth, createTokenStore };
