const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createMasterServer } = require("../server");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

// Stands in for Discord's token and profile endpoints.
async function fakeDiscord() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/oauth2/token") return res.end(JSON.stringify({ access_token: "discord-access" }));
    if (req.url === "/users/@me" && req.headers.authorization === "Bearer discord-access") {
      return res.end(JSON.stringify({ id: "1234567890", username: "kai", global_name: "Kai Ramírez", avatar: "abc123" }));
    }
    res.writeHead(401).end();
  });
  return { server, base: await listen(server) };
}

async function setup({ withDiscord = true } = {}) {
  const discord = withDiscord ? await fakeDiscord() : null;
  const master = createMasterServer({
    discord: discord && { clientId: "id", clientSecret: "secret", apiBase: discord.base, authorizeUrl: `${discord.base}/authorize` }
  });
  const base = await listen(master);
  return {
    base,
    async cleanup() {
      await close(master);
      if (discord) await close(discord.server);
    }
  };
}

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const launcherState = crypto.randomBytes(16).toString("base64url");

// Runs the browser part of the flow and returns the one-time code from the loopback redirect.
async function browserLogin(base) {
  const start = await fetch(`${base}/auth/discord/start?challenge=${challenge}&port=45678&state=${launcherState}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const toDiscord = new URL(start.headers.get("location"));
  assert.equal(toDiscord.searchParams.get("scope"), "identify");
  const callback = await fetch(`${base}/auth/discord/callback?code=from-discord&state=${toDiscord.searchParams.get("state")}`, { redirect: "manual" });
  const back = new URL(callback.headers.get("location"));
  assert.equal(back.origin, "http://127.0.0.1:45678");
  assert.equal(back.searchParams.get("state"), launcherState);
  return back.searchParams.get("code");
}

test("full login, profile, favorites sync and logout", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await fetch(`${s.base}/auth/config`)).json(), { discord: true });
    const code = await browserLogin(s.base);

    const exchange = await fetch(`${s.base}/auth/exchange`, { method: "POST", body: JSON.stringify({ code, verifier }) });
    assert.equal(exchange.status, 200);
    const { token, user } = await exchange.json();
    assert.equal(user.name, "Kai Ramírez");
    assert.match(user.avatarUrl, /^https:\/\/cdn\.discordapp\.com\/avatars\/1234567890\/abc123\.png/);

    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await (await fetch(`${s.base}/api/me`, { headers: auth })).json()).user.username, "kai");

    const put = await fetch(`${s.base}/api/me/favorites`, { method: "PUT", headers: auth, body: JSON.stringify({ favorites: ["b:1", "a:1", "a:1"] }) });
    assert.deepEqual((await put.json()).favorites, ["a:1", "b:1"]);
    assert.deepEqual((await (await fetch(`${s.base}/api/me/favorites`, { headers: auth })).json()).favorites, ["a:1", "b:1"]);

    await fetch(`${s.base}/auth/logout`, { method: "POST", headers: auth });
    assert.equal((await fetch(`${s.base}/api/me`, { headers: auth })).status, 401);
  } finally {
    await s.cleanup();
  }
});

test("a login code works once, and only with the right verifier", async () => {
  const s = await setup();
  try {
    const code = await browserLogin(s.base);
    const wrong = await fetch(`${s.base}/auth/exchange`, { method: "POST", body: JSON.stringify({ code, verifier: "x".repeat(43) }) });
    assert.equal(wrong.status, 400);
    // The failed try used the code up, so even the right verifier fails now.
    const again = await fetch(`${s.base}/auth/exchange`, { method: "POST", body: JSON.stringify({ code, verifier }) });
    assert.equal(again.status, 400);
  } finally {
    await s.cleanup();
  }
});

test("bad start links and unknown states are refused", async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/auth/discord/start?challenge=short&port=45678&state=${launcherState}`, { redirect: "manual" })).status, 400);
    assert.equal((await fetch(`${s.base}/auth/discord/start?challenge=${challenge}&port=80&state=${launcherState}`, { redirect: "manual" })).status, 400);
    assert.equal((await fetch(`${s.base}/auth/discord/callback?code=x&state=made-up`, { redirect: "manual" })).status, 400);
    assert.equal((await fetch(`${s.base}/api/me`)).status, 401);
  } finally {
    await s.cleanup();
  }
});

test("login is reported as off when Discord isn't configured", async () => {
  const s = await setup({ withDiscord: false });
  try {
    assert.deepEqual(await (await fetch(`${s.base}/auth/config`)).json(), { discord: false });
    assert.equal((await fetch(`${s.base}/auth/discord/start`, { redirect: "manual" })).status, 501);
  } finally {
    await s.cleanup();
  }
});
