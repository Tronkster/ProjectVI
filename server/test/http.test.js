const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../src/http");
const { validateConfig } = require("../src/config");
const { SYNC_VERSION } = require("@projectvi/shared");

const SHA = "b".repeat(64);

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-http-"));
  const file = path.join(dir, "client.lua");
  fs.writeFileSync(file, "hello");
  const config = validateConfig({ server: { name: "Test", max_players: 8 }, resources: { start: ["a"] } });
  const content = {
    manifest: { resources: [{ name: "a", files: [{ path: "client.lua", size: 5, sha256: SHA }] }] },
    files: new Map([[SHA, file]]),
    fileCount: 1,
    totalBytes: 5
  };
  const server = createGameServer({ config, content });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/projectvi`;
  return { base, close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test("info, manifest and files are served", async () => {
  const s = await start();
  try {
    const info = await (await fetch(`${s.base}/info`)).json();
    assert.deepEqual(info, {
      name: "Test", protocol: 1, contentBytes: 5, fileCount: 1, players: 0, maxPlayers: 8,
      sync: { version: SYNC_VERSION, port: 30120, tickRate: 20 }
    });

    const manifest = await (await fetch(`${s.base}/manifest`)).json();
    assert.equal(manifest.resources[0].files[0].sha256, SHA);

    const res = await fetch(`${s.base}/files/${SHA}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "5");
    assert.equal(await res.text(), "hello");
  } finally {
    await s.close();
  }
});

test("unknown files, bad hashes and other methods are refused", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/files/${"c".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${s.base}/files/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${s.base}/files/xyz`)).status, 404);
    assert.equal((await fetch(`${s.base}/info`, { method: "POST" })).status, 405);
  } finally {
    await s.close();
  }
});

test("config errors are explained", () => {
  assert.throws(() => validateConfig({ server: { port: 99999 } }), /name is required[\s\S]*port must be/);
  assert.equal(validateConfig({ server: { name: "X", gamemode: "roleplay" } }).mode, "Roleplay");
  assert.equal(validateConfig({ server: { name: "X" } }).master.public, true);
});
