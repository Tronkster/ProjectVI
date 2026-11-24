// Runs the launcher's login against a real master server with a fake Discord behind it.
// The "browser" is simulated by following the redirects with fetch.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createMasterServer } = require("projectvi-master-server");
const { createAuth } = require("../src/main/auth");

const silent = { info() {}, warn() {}, error() {} };
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

function memoryTokens() {
  let saved = "";
  return { load: () => saved, save: (t) => { saved = t; }, clear: () => { saved = ""; }, peek: () => saved };
}

async function setup() {
  const discord = http.createServer((req, res) => {
    if (req.url === "/oauth2/token") return res.end(JSON.stringify({ access_token: "a" }));
    if (req.url === "/users/@me") return res.end(JSON.stringify({ id: "42", username: "kai", global_name: "Kai", avatar: null }));
    res.writeHead(404).end();
  });
  const discordBase = await listen(discord);
  const master = createMasterServer({ discord: { clientId: "id", clientSecret: "s", apiBase: discordBase, authorizeUrl: `${discordBase}/authorize` } });
  const masterBase = (await listen(master)).replace("127.0.0.1", "localhost");

  const tokens = memoryTokens();
  let browser = async () => {};
  const auth = createAuth({
    getSettings: () => ({ masterUrl: masterBase }),
    tokenStore: tokens,
    openExternal: (url) => browser(url),
    logger: silent
  });
  return {
    auth,
    tokens,
    setBrowser: (fn) => { browser = fn; },
    cleanup: async () => { await close(master); await close(discord); }
  };
}

// Plays the browser: launcher start link -> master -> (Discord skipped) -> callback -> launcher loopback.
async function approvingBrowser(startUrl) {
  const toDiscord = new URL((await fetch(startUrl, { redirect: "manual" })).headers.get("location"));
  const callback = new URL(startUrl);
  callback.pathname = "/auth/discord/callback";
  callback.search = new URLSearchParams({ code: "c", state: toDiscord.searchParams.get("state") }).toString();
  const loopback = (await fetch(callback, { redirect: "manual" })).headers.get("location");
  await fetch(loopback);
}

test("log in, sync favorites, log out", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await s.auth.status(), { available: true, user: null });

    s.setBrowser(approvingBrowser);
    const result = await s.auth.login();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.user.name, "Kai");
    assert.ok(s.tokens.peek(), "token saved");
    assert.equal(s.auth.isLoggedIn(), true);

    assert.deepEqual(await s.auth.putFavorites(["a:1"]), ["a:1"]);
    assert.deepEqual(await s.auth.getFavorites(), ["a:1"]);

    await s.auth.logout();
    assert.equal(s.tokens.peek(), "");
    assert.equal(s.auth.isLoggedIn(), false);
    assert.equal(await s.auth.getFavorites(), null);
  } finally {
    await s.cleanup();
  }
});

test("cancelling while the browser is open stops the login", async () => {
  const s = await setup();
  try {
    s.setBrowser(async () => {}); // the player never finishes in the browser
    const pending = s.auth.login();
    setTimeout(() => s.auth.cancelLogin(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
  } finally {
    await s.cleanup();
  }
});

test("a callback with the wrong state is refused", async () => {
  const s = await setup();
  try {
    s.setBrowser(async (startUrl) => {
      const port = new URL(startUrl).searchParams.get("port");
      await fetch(`http://127.0.0.1:${port}/callback?code=stolen&state=wrong`);
    });
    const result = await s.auth.login();
    assert.equal(result.ok, false);
    assert.match(result.error, /didn't finish/);
  } finally {
    await s.cleanup();
  }
});
