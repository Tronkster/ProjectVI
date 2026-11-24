const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { parseMasterUrl, cleanServer, tcpPing, pingServers } = require("../src/main/servers");

test("parseMasterUrl allows https anywhere and http only on this PC", () => {
  assert.equal(parseMasterUrl("https://list.example.com/")[1], null);
  assert.equal(parseMasterUrl("http://localhost:30180")[1], null);
  assert.equal(parseMasterUrl("http://127.0.0.1:30180")[1], null);
  assert.match(parseMasterUrl("http://list.example.com")[1], /https/);
  assert.match(parseMasterUrl("ftp://x")[1], /https/);
  assert.match(parseMasterUrl("not a url")[1], /valid URL/);
});

test("cleanServer keeps good records and drops broken ones", () => {
  const s = cleanServer({ host: "1.2.3.4", port: 30120, name: "A".repeat(100), players: 5, maxPlayers: 32, mode: "Racing" });
  assert.equal(s.id, "1.2.3.4:30120");
  assert.equal(s.name.length, 64);
  assert.equal(s.mode, "Racing");
  assert.equal(cleanServer({ host: "1.2.3.4", port: 0 }), null);
  assert.equal(cleanServer({ port: 30120 }), null);
  assert.equal(cleanServer(null), null);
  assert.equal(cleanServer({ host: "h", port: 1, players: -3 }).players, 0);
});

test("tcpPing measures an open port and a refused port", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(typeof (await tcpPing("127.0.0.1", port)), "number");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // Same port, now closed: the host still answers with a refusal, which counts as a ping.
  assert.equal(typeof (await tcpPing("127.0.0.1", port)), "number");
});

test("pingServers skips malformed targets", async () => {
  const result = await pingServers([{ id: "x", host: 42, port: 1 }, null, "nope"]);
  assert.deepEqual(result, {});
  assert.deepEqual(await pingServers("nope"), {});
});
