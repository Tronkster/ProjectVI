const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMasterServer, validateHeartbeat } = require("../server");

const VALID = { port: 30201, name: "Test RP", description: "Hi", mode: "Roleplay", region: "eu", players: 3, maxPlayers: 32 };

async function start(options) {
  const server = createMasterServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const list = async () => (await (await fetch(`${base}/api/servers`)).json()).servers;
  return { server, base, post, list, close: () => new Promise((r) => server.close(r)) };
}

test("validateHeartbeat accepts a good body and cleans it", () => {
  const [record, error] = validateHeartbeat({ ...VALID, name: " Test\u0007 RP ", mode: "Karaoke" }, "1.2.3.4", 1000);
  assert.equal(error, null);
  assert.equal(record.id, "1.2.3.4:30201");
  assert.equal(record.name, "Test RP");
  assert.equal(record.mode, "Other");
  assert.equal(record.region, "EU");
  assert.equal(record.lastSeen, 1000);
});

test("validateHeartbeat rejects bad bodies with a reason", () => {
  assert.match(validateHeartbeat(null, "h")[1], /JSON object/);
  assert.match(validateHeartbeat([], "h")[1], /JSON object/);
  assert.match(validateHeartbeat({ ...VALID, name: "" }, "h")[1], /name/);
  assert.match(validateHeartbeat({ ...VALID, port: 0 }, "h")[1], /port/);
  assert.match(validateHeartbeat({ ...VALID, maxPlayers: 5000 }, "h")[1], /maxPlayers/);
  assert.match(validateHeartbeat({ ...VALID, players: 33 }, "h")[1], /players/);
});

test("heartbeats show up in the list, most players first", async () => {
  const m = await start();
  try {
    assert.equal((await m.post(VALID)).status, 200);
    assert.equal((await m.post({ ...VALID, port: 30202, name: "Busy", players: 30 })).status, 200);
    const servers = await m.list();
    assert.deepEqual(servers.map((s) => s.name), ["Busy", "Test RP"]);
    assert.equal(servers[0].host, "127.0.0.1");
  } finally {
    await m.close();
  }
});

test("bad JSON and bad fields return 400", async () => {
  const m = await start();
  try {
    const bad = await fetch(`${m.base}/api/heartbeat`, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal((await m.post({ ...VALID, players: -1 })).status, 400);
  } finally {
    await m.close();
  }
});

test("servers that stop sending heartbeats drop off", async () => {
  let clock = 1_000_000;
  const m = await start({ now: () => clock, staleAfterMs: 90_000 });
  try {
    await m.post(VALID);
    clock += 60_000;
    assert.equal((await m.list()).length, 1);
    clock += 31_000;
    assert.equal((await m.list()).length, 0);
  } finally {
    await m.close();
  }
});

test("too many heartbeats from one IP get 429", async () => {
  const m = await start({ rateLimitPerMin: 2 });
  try {
    assert.equal((await m.post(VALID)).status, 200);
    assert.equal((await m.post(VALID)).status, 200);
    assert.equal((await m.post(VALID)).status, 429);
  } finally {
    await m.close();
  }
});

test("DELETE signs a server off", async () => {
  const m = await start();
  try {
    await m.post(VALID);
    await fetch(`${m.base}/api/heartbeat?port=30201`, { method: "DELETE" });
    assert.equal((await m.list()).length, 0);
  } finally {
    await m.close();
  }
});
