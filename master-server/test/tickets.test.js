const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMasterServer } = require("../server");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

async function setup(options = {}) {
  let clock = 1_700_000_000_000;
  const master = createMasterServer({ now: () => clock, ...options });
  const base = await listen(master);
  const call = async (token, method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
  return { base, call, tick: (ms) => (clock += ms), cleanup: () => close(master) };
}

const heartbeat = (s, port = 30120) => s.call(null, "POST", "/api/heartbeat", { port, name: "Test", players: 0, maxPlayers: 8 });

function decodeTicket(ticket) {
  const [version, payload, signature] = ticket.split(".");
  return { version, signed: `${version}.${payload}`, payload: JSON.parse(Buffer.from(payload, "base64url").toString()), signature };
}

test("a logged-in player gets a signed ticket for a listed server", async () => {
  const s = await setup();
  try {
    const guest = (await s.call(null, "POST", "/auth/guest", { name: "Ana" })).data;
    const listed = await heartbeat(s);
    assert.equal(listed.status, 200);

    const r = await s.call(guest.token, "POST", "/api/join-ticket", { serverId: listed.data.id });
    assert.equal(r.status, 200);
    const { version, signed, payload, signature } = decodeTicket(r.data.ticket);
    assert.equal(version, "v1");
    assert.equal(payload.aud, listed.data.id);
    assert.match(payload.sub, /^guest:.+/);
    assert.equal(payload.name, "Ana");
    assert.equal(payload.exp - payload.iat, 120);
    assert.equal(r.data.expiresAt, payload.exp * 1000);

    const key = (await s.call(null, "GET", "/api/ticket-key")).data;
    assert.equal(key.algorithm, "Ed25519");
    const publicKey = crypto.createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    assert.equal(crypto.verify(null, Buffer.from(signed), publicKey, Buffer.from(signature, "base64url")), true);

    // Each ticket is different, so each can only be used once.
    const again = await s.call(guest.token, "POST", "/api/join-ticket", { serverId: listed.data.id });
    assert.notEqual(decodeTicket(again.data.ticket).payload.jti, payload.jti);
  } finally {
    await s.cleanup();
  }
});

test("no ticket without an account, or for a server that isn't listed", async () => {
  const s = await setup();
  try {
    const guest = (await s.call(null, "POST", "/auth/guest", { name: "Ana" })).data;
    assert.equal((await s.call(null, "POST", "/api/join-ticket", { serverId: "127.0.0.1:30120" })).status, 401);
    assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", { serverId: "127.0.0.1:30120" })).status, 404);
    assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", {})).status, 404);

    // A server that stopped sending heartbeats drops off, and so do its tickets.
    const listed = await heartbeat(s);
    s.tick(91_000);
    assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", { serverId: listed.data.id })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test("tickets are rate limited per account", async () => {
  const s = await setup();
  try {
    const guest = (await s.call(null, "POST", "/auth/guest", { name: "Ana" })).data;
    const { data } = await heartbeat(s);
    for (let i = 0; i < 30; i++) assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", { serverId: data.id })).status, 200);
    assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", { serverId: data.id })).status, 429);
    s.tick(61_000);
    await heartbeat(s);
    assert.equal((await s.call(guest.token, "POST", "/api/join-ticket", { serverId: data.id })).status, 200);
  } finally {
    await s.cleanup();
  }
});

test("the signing key is kept in its file across restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-ticket-"));
  const keyFile = path.join(dir, "data", "ticket-key.pem");
  try {
    const first = await setup({ ticketKeyFile: keyFile });
    const keyA = (await first.call(null, "GET", "/api/ticket-key")).data;
    await first.cleanup();
    assert.ok(fs.existsSync(keyFile));
    const second = await setup({ ticketKeyFile: keyFile });
    const keyB = (await second.call(null, "GET", "/api/ticket-key")).data;
    await second.cleanup();
    assert.equal(keyB.publicKey, keyA.publicKey);
    assert.equal(keyB.keyId, keyA.keyId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
