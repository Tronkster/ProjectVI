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

function createAuth({ getSettings, tokenStore, openExternal, logger }) {
  let token = tokenStore.load();
  let user = null;
  let pending = null;

  function masterBase() {
    const [url, error] = parseMasterUrl(getSettings().masterUrl);
    if (error) throw new Error(error);
    return url.href.replace(/\/+$/, "");
  }

  async function call(pathname, { method = "GET", body, timeoutMs = 8000 } = {}) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${masterBase()}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) {
      token = "";
      user = null;
      tokenStore.clear();
    }
    return { ok: res.ok, status: res.status, data };
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
          if (r.ok) user = r.data.user;
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
        const r = await call("/auth/exchange", { method: "POST", body: { code, verifier } });
        if (!r.ok) return { ok: false, error: r.data.error || "Login failed. Try again." };
        token = r.data.token;
        user = r.data.user;
        tokenStore.save(token);
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
    }
  };
}

module.exports = { createAuth, createTokenStore };
