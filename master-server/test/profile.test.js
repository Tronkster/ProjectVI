const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMasterServer } = require("../server");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function setup() {
  const master = createMasterServer();
  const base = await listen(master);
  async function call(token, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // a picture
    }
    return { status: res.status, data, res };
  }
  async function guest(name) {
    const { data } = await call(null, "POST", "/auth/guest", { name });
    const me = (path, method = "GET", body) => call(data.token, method, path, body);
    return { token: data.token, me, code: (await me("/api/friends")).data.code };
  }
  return { base, call, guest, cleanup: () => close(master) };
}

test("color, picture and the picture's address", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    assert.equal((await ana.me("/api/me", "PUT", { color: "#10b981" })).data.user.color, "#10b981");
    assert.equal((await ana.me("/api/me", "PUT", { color: "red" })).status, 400);

    const up = await ana.me("/api/me/avatar", "PUT", { type: "image/png", data: PNG.toString("base64") });
    assert.equal(up.status, 200);
    const url = up.data.user.avatarUrl;
    assert.match(url, /^\/avatars\/[0-9a-f]{24}\.png$/);

    const pic = await fetch(`${s.base}${url}`); // no login needed: the key is the secret
    assert.equal(pic.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await pic.arrayBuffer()), PNG);

    // Friends see it too.
    const ben = await s.guest("Ben");
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    assert.equal((await ben.me("/api/friends")).data.incoming[0].avatarUrl, url);

    assert.equal((await ana.me("/api/me/avatar", "PUT", { type: "image/png", data: Buffer.from("not a png at all").toString("base64") })).status, 400);
    assert.equal((await ana.me("/api/me/avatar", "PUT", { type: "image/gif", data: PNG.toString("base64") })).status, 400);
    assert.equal((await ana.me("/api/me/avatar", "PUT", { type: "image/png", data: Buffer.concat([PNG, Buffer.alloc(33 * 1024)]).toString("base64") })).status, 400);

    const removed = await ana.me("/api/me/avatar", "DELETE");
    assert.equal(removed.data.user.avatarUrl, "");
    assert.equal((await fetch(`${s.base}${url}`)).status, 404);
  } finally {
    await s.cleanup();
  }
});

test("players can stop taking friend requests", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    assert.equal((await ana.me("/api/me")).data.acceptRequests, true);
    assert.equal((await ana.me("/api/me", "PUT", { acceptRequests: false })).data.acceptRequests, false);
    const refused = await ben.me("/api/friends/requests", "POST", { code: ana.code });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /isn't taking friend requests/);

    // Answering a request you sent still works.
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    assert.equal((await ben.me("/api/friends/requests", "POST", { code: ana.code })).data.result, "friends");
  } finally {
    await s.cleanup();
  }
});

test("deleting an account removes it everywhere", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    await ben.me("/api/friends/requests", "POST", { code: ana.code });
    const benId = (await ana.me("/api/friends")).data.friends[0].id;
    await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "bye" });

    assert.equal((await ana.me("/api/me", "DELETE")).status, 200);
    assert.equal((await ana.me("/api/me")).status, 401);
    assert.equal((await ben.me("/api/friends")).data.friends.length, 0);
  } finally {
    await s.cleanup();
  }
});
