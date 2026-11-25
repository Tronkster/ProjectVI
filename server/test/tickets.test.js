// Join tickets end to end: the real master server issues them, the game server checks them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TicketVerifier } = require("../src/tickets");
const { SyncServer } = require("../src/sync");
const { ServerCore } = require("../src/core/server-core");
const { validateConfig } = require("../src/config");
const { SyncClient } = require("@projectvi/shared/sync-client");
const { createMasterServer } = require("../../master-server/server");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

async function setup() {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const master = createMasterServer({ now });
  await new Promise((resolve) => master.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${master.address().port}`;
  const call = async (token, method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
  const { data: listed } = await call(null, "POST", "/api/heartbeat", { port: 30120, name: "Test", players: 0, maxPlayers: 8 });
  const verifier = new TicketVerifier({ masterUrl: base, log: quietLog, now });
  assert.equal(await verifier.loadKey(), true);
  verifier.setServerId(listed.id);
  const guest = async (name) => (await call(null, "POST", "/auth/guest", { name })).data;
  const ticket = async (token, serverId = listed.id) => (await call(token, "POST", "/api/join-ticket", { serverId })).data.ticket;
  return { base, call, verifier, serverId: listed.id, guest, ticket, advance: (ms) => (clock += ms), now, close: () => new Promise((r) => master.close(r)) };
}

test("a ticket from the master server verifies once, for this server only", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const good = await s.ticket(ana.token);
    const first = s.verifier.verify(good);
    assert.equal(first.ok, true);
    assert.match(first.identifier, /^guest:.+/);
    assert.equal(first.name, "Ana");
    assert.match(s.verifier.verify(good).error, /already used/);

    // Meant for another listed server.
    await s.call(null, "POST", "/api/heartbeat", { port: 30121, name: "Other", players: 0, maxPlayers: 8 });
    const other = await s.ticket(ana.token, s.serverId.replace(/:30120$/, ":30121"));
    assert.match(s.verifier.verify(other).error, /different server/);

    // Changed after signing.
    const [v, payload, sig] = (await s.ticket(ana.token)).split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.sub = "discord:111";
    assert.match(s.verifier.verify(`${v}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`).error, /isn't signed/);
    assert.match(s.verifier.verify("not a ticket").error, /malformed/);

    // Too old.
    const late = await s.ticket(ana.token);
    s.advance(200_000);
    assert.match(s.verifier.verify(late).error, /expired/);
  } finally {
    await s.close();
  }
});

test("players who join with a ticket get their verified identity and permissions", async () => {
  const s = await setup();
  const ana = await s.guest("Ana");
  const anaId = s.verifier.verify(await s.ticket(ana.token)).identifier;
  const config = validateConfig({ server: { name: "Tickets", max_players: 2 }, permissions: { admin: [anaId] } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const sync = new SyncServer({ core, log: quietLog, maxPlayers: 2, tickets: s.verifier, requireTicket: true, now: s.now });
  const port = await sync.listen(0, "127.0.0.1");
  const clients = [];
  const join = async (name, ticket) => {
    const c = new SyncClient({ host: "127.0.0.1", port, name, ticket, helloIntervalMs: 50, helloAttempts: 20 });
    c.on("error", () => {});
    clients.push(c);
    return [c, await c.connect()];
  };
  try {
    const [, joined] = await join("Ana", await s.ticket(ana.token));
    const player = core.players.get(joined.playerId);
    assert.deepEqual(player.identifiers, [anaId]);
    assert.deepEqual(player.groups, ["admin"]);

    // No ticket on a server that requires one.
    await assert.rejects(join("Ben", ""), (err) => err.code === "REJECTED" && /launcher/.test(err.message));

    // Joining again replaces the old session, even when the server is otherwise full.
    const ben = await s.guest("Ben");
    await join("Ben", await s.ticket(ben.token));
    assert.equal(core.players.list().length, 2);
    const [, again] = await join("Ana", await s.ticket(ana.token));
    assert.equal(core.players.list().length, 2);
    assert.notEqual(again.playerId, joined.playerId);
    assert.equal(core.players.get(joined.playerId), undefined);
    assert.deepEqual(core.players.get(again.playerId).identifiers, [anaId]);
  } finally {
    for (const c of clients) c.close?.();
    await sync.close();
    await s.close();
  }
});

test("without require_ticket, players without a ticket join with only a session id", async () => {
  const s = await setup();
  const config = validateConfig({ server: { name: "Open", max_players: 4 } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const sync = new SyncServer({ core, log: quietLog, maxPlayers: 4, tickets: s.verifier, now: s.now });
  const port = await sync.listen(0, "127.0.0.1");
  const c = new SyncClient({ host: "127.0.0.1", port, name: "Cyd", helloIntervalMs: 50 });
  try {
    const joined = await c.connect();
    assert.match(core.players.get(joined.playerId).identifiers[0], /^session:[0-9a-f]+$/);
  } finally {
    c.close?.();
    await sync.close();
    await s.close();
  }
});
