const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMasterServer } = require("../server");
const { openDatabase, normalizeFriendCode } = require("../src/db");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

async function setup() {
  let clock = 1_000_000;
  const master = createMasterServer({ now: () => clock });
  const base = await listen(master);

  async function call(token, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  }
  async function guest(name) {
    const r = await call(null, "POST", "/auth/guest", { name });
    assert.equal(r.status, 200);
    const me = (path, method = "GET", body) => call(r.data.token, method, path, body);
    const overview = (await me("/api/friends")).data;
    return { token: r.data.token, user: r.data.user, code: overview.code, me };
  }
  return { base, call, guest, tick: (ms) => { clock += ms; }, cleanup: () => close(master) };
}

test("friend codes are normalized and checked", () => {
  assert.equal(normalizeFriendCode("k7qp-2m9x"), "K7QP2M9X");
  assert.equal(normalizeFriendCode(" K7QP 2M9X "), "K7QP2M9X");
  assert.equal(normalizeFriendCode("K7QP-2M9O"), ""); // O isn't used
  assert.equal(normalizeFriendCode("K7QP"), "");
  assert.equal(normalizeFriendCode(undefined), "");
});

test("guests get a friend code, send, accept and remove friends", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    assert.match(ana.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.equal(ana.user.provider, "guest");

    const sent = await ana.me("/api/friends/requests", "POST", { code: ben.code.toLowerCase() });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.result, "sent");
    assert.equal(sent.data.player.name, "Ben");

    assert.equal((await ana.me("/api/friends")).data.outgoing[0].name, "Ben");
    const incoming = (await ben.me("/api/friends")).data.incoming;
    assert.equal(incoming.length, 1);

    const accepted = await ben.me(`/api/friends/requests/${incoming[0].id}/accept`, "POST");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.data.friends.map((f) => f.name), ["Ana"]);
    assert.equal(accepted.data.incoming.length, 0);
    assert.equal((await ana.me("/api/friends")).data.friends[0].name, "Ben");

    const again = await ana.me("/api/friends/requests", "POST", { code: ben.code });
    assert.equal(again.status, 409);

    const benId = (await ana.me("/api/friends")).data.friends[0].id;
    assert.equal((await ana.me(`/api/friends/${accepted.data.friends[0].id}`, "DELETE")).status, 404); // that's Ana herself
    const removed = await ana.me(`/api/friends/${benId}`, "DELETE");
    assert.equal(removed.data.friends.length, 0);
    assert.equal((await ben.me("/api/friends")).data.friends.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("requests both ways become a friendship; declining and cancelling work", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    const cy = await s.guest("Cy");

    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    const back = await ben.me("/api/friends/requests", "POST", { code: ana.code });
    assert.equal(back.data.result, "friends");

    await cy.me("/api/friends/requests", "POST", { code: ana.code });
    const cyId = (await ana.me("/api/friends")).data.incoming[0].id;
    const declined = await ana.me(`/api/friends/requests/${cyId}`, "DELETE");
    assert.equal(declined.data.incoming.length, 0);
    assert.equal((await cy.me("/api/friends")).data.outgoing.length, 0);

    await cy.me("/api/friends/requests", "POST", { code: ben.code });
    const benId = (await cy.me("/api/friends")).data.outgoing[0].id;
    await cy.me(`/api/friends/requests/${benId}`, "DELETE");
    assert.equal((await ben.me("/api/friends")).data.incoming.length, 0);
    assert.equal((await ana.me(`/api/friends/requests/${benId}`, "DELETE")).status, 404);
  } finally {
    await s.cleanup();
  }
});

test("bad, unknown and own codes are refused; codes can be reset", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    assert.equal((await ana.me("/api/friends/requests", "POST", { code: "nope" })).status, 400);
    assert.equal((await ana.me("/api/friends/requests", "POST", { code: "2222-2222" })).status, 404);
    assert.equal((await ana.me("/api/friends/requests", "POST", { code: ana.code })).status, 400);

    const reset = await ana.me("/api/friends/code", "POST");
    assert.notEqual(reset.data.code, ana.code);
    const ben = await s.guest("Ben");
    assert.equal((await ben.me("/api/friends/requests", "POST", { code: ana.code })).status, 404);
    assert.equal((await ben.me("/api/friends/requests", "POST", { code: reset.data.code })).status, 200);

    assert.equal((await s.call(null, "GET", "/api/friends")).status, 401);
    assert.equal((await s.call(null, "POST", "/auth/guest", { name: "  " })).status, 400);
  } finally {
    await s.cleanup();
  }
});

test("presence shows who is online and on which listed server", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    await ben.me("/api/friends/requests", "POST", { code: ana.code });

    const friend = async () => (await ana.me("/api/friends")).data.friends[0];
    assert.equal((await friend()).online, false);

    await s.call(null, "POST", "/api/heartbeat", { port: 30120, name: "Vice Nights", players: 3, maxPlayers: 32 });
    const put = await ben.me("/api/presence", "PUT", { name: "Benny", serverId: "127.0.0.1:30120" });
    assert.equal(put.data.nextInSeconds, 60);
    let f = await friend();
    assert.equal(f.online, true);
    assert.deepEqual(f.server, { id: "127.0.0.1:30120", name: "Vice Nights" });
    assert.equal(f.name, "Benny"); // a guest's in-game name is the name friends see

    await ben.me("/api/presence", "PUT", { name: "Benny", serverId: "10.0.0.1:1" }); // not a listed server
    f = await friend();
    assert.equal(f.online, true);
    assert.equal(f.server, null);

    s.tick(151_000);
    assert.equal((await friend()).online, false);

    await ben.me("/api/presence", "PUT", {});
    await ben.me("/api/presence", "DELETE");
    assert.equal((await friend()).online, false);
  } finally {
    await s.cleanup();
  }
});

test("a guest's friends move to the account it logs in as", () => {
  const db = openDatabase();
  const t = 1000;
  const guest = db.createGuest("Ana", t);
  const account = db.upsertUser({ provider: "discord", providerId: "1", username: "ana", displayName: "Ana" }, t);
  const ben = db.createGuest("Ben", t);
  const cy = db.createGuest("Cy", t);
  const dee = db.createGuest("Dee", t);
  db.makeFriends(guest.id, ben.id, t);
  db.addRequest(cy.id, guest.id, t); // Cy asked the guest
  db.addRequest(guest.id, dee.id, t); // the guest asked Dee...
  db.addRequest(dee.id, account.id, t); // ...and Dee asked the account: that's a friendship

  db.mergeGuestInto(guest.id, account.id, t);
  assert.equal(db.userById(guest.id), null);
  assert.deepEqual(db.friends(account.id).map((f) => f.display_name), ["Ben", "Dee"]);
  assert.ok(db.areFriends(ben.id, account.id));
  assert.deepEqual(db.incomingRequests(account.id).map((r) => r.display_name), ["Cy"]);
  assert.equal(db.outgoingRequests(account.id).length, 0);
  db.close();
});

test("guests without a session are cleaned up", () => {
  const db = openDatabase();
  const guest = db.createGuest("Ana", 0);
  db.createSession(guest.id, 0, 1);
  db.deleteExpiredSessions(2 * 86_400_000);
  assert.equal(db.userById(guest.id), null);
  db.close();
});

test("friends can write to each other; unread counts clear when read", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    await s.guest("Cy"); // exists, but isn't a friend of Ana
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    await ben.me("/api/friends/requests", "POST", { code: ana.code });
    const benId = (await ana.me("/api/friends")).data.friends[0].id;
    const anaId = (await ben.me("/api/friends")).data.friends[0].id;

    const sent = await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "  join me on Vice Nights\u0007 " });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.message.text, "join me on Vice Nights");
    assert.equal(sent.data.message.from, "me");
    await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "line one\nline two" });

    assert.equal((await ben.me("/api/friends")).data.friends[0].unread, 2);
    const read = await ben.me(`/api/friends/${anaId}/messages`);
    assert.deepEqual(read.data.messages.map((m) => [m.from, m.text]), [["them", "join me on Vice Nights"], ["them", "line one\nline two"]]);
    assert.equal((await ben.me("/api/friends")).data.friends[0].unread, 0);

    const after = await ben.me(`/api/friends/${anaId}/messages?after=${read.data.messages[0].id}`);
    assert.equal(after.data.messages.length, 1);

    assert.equal((await ana.me(`/api/friends/${benId}/messages`, "POST", { text: " " })).status, 400);
    assert.equal((await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "x".repeat(501) })).status, 400);
    const cyId = String(Number(benId) + 1); // made right after Ben, and not a friend of Ana
    assert.equal((await ana.me(`/api/friends/${cyId}/messages`, "POST", { text: "hi" })).status, 404); // not a friend

    // Unfriending deletes the conversation.
    await ana.me(`/api/friends/${benId}`, "DELETE");
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    await ben.me("/api/friends/requests", "POST", { code: ana.code });
    assert.equal((await ana.me(`/api/friends/${benId}/messages`)).data.messages.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("too many messages in a minute get 429", async () => {
  const s = await setup();
  try {
    const ana = await s.guest("Ana");
    const ben = await s.guest("Ben");
    await ana.me("/api/friends/requests", "POST", { code: ben.code });
    await ben.me("/api/friends/requests", "POST", { code: ana.code });
    const benId = (await ana.me("/api/friends")).data.friends[0].id;
    for (let i = 0; i < 30; i++) assert.equal((await ana.me(`/api/friends/${benId}/messages`, "POST", { text: `${i}` })).status, 200);
    assert.equal((await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "one more" })).status, 429);
    s.tick(61_000);
    assert.equal((await ana.me(`/api/friends/${benId}/messages`, "POST", { text: "later" })).status, 200);
  } finally {
    await s.cleanup();
  }
});
