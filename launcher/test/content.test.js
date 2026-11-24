const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { downloadToFile } = require("../src/main/http");
const { planDownload, downloadMissing, writeClientManifest, blobPath, serverKey, inspectServer } = require("../src/main/content");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A tiny fake game server. `files` maps sha256 -> Buffer; `lie` overrides what gets sent for a hash.
async function fakeServer({ files = new Map(), lie = new Map(), manifest = { resources: [] }, slow = false } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === "/projectvi/info") return res.end(JSON.stringify({ protocol: 1, name: "Fake" }));
    if (req.url === "/projectvi/manifest") return res.end(JSON.stringify(manifest));
    const hash = req.url.split("/").pop();
    const body = lie.get(hash) ?? files.get(hash);
    if (!body) return res.writeHead(404).end();
    if (slow) {
      res.writeHead(200);
      res.write(body.subarray(0, 1)); // never finishes
      return;
    }
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    host: "127.0.0.1",
    port: server.address().port,
    url: (h) => `http://127.0.0.1:${server.address().port}/projectvi/files/${h}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); })
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pvi-content-"));

test("downloadToFile saves a good file and rejects a wrong one", async () => {
  const good = Buffer.from("hello world");
  const evil = Buffer.from("hello WORLD"); // same size, different content
  const s = await fakeServer({ files: new Map([[sha(good), good]]), lie: new Map([["f".repeat(64), evil]]) });
  const dir = tmp();
  try {
    const dest = path.join(dir, "a");
    await downloadToFile(s.url(sha(good)), dest, { size: good.length, sha256: sha(good) });
    assert.equal(fs.readFileSync(dest, "utf8"), "hello world");

    await assert.rejects(
      downloadToFile(s.url("f".repeat(64)), path.join(dir, "b"), { size: evil.length, sha256: "f".repeat(64) }),
      /checksum/
    );
    assert.deepEqual(fs.readdirSync(dir), ["a"]); // no leftovers from the failed download
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadToFile stops when the server sends more than announced", async () => {
  const big = Buffer.alloc(5000, 1);
  const s = await fakeServer({ lie: new Map([["e".repeat(64), big]]) });
  const dir = tmp();
  try {
    await assert.rejects(
      downloadToFile(s.url("e".repeat(64)), path.join(dir, "x"), { size: 10, sha256: "e".repeat(64) }),
      /different size|more data/
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planDownload counts cached files and de-duplicates by hash", () => {
  const dir = tmp();
  try {
    const a = Buffer.from("aaa");
    const b = Buffer.from("bbbb");
    fs.mkdirSync(path.dirname(blobPath(dir, sha(a))), { recursive: true });
    fs.writeFileSync(blobPath(dir, sha(a)), a);
    const manifest = { resources: [
      { name: "one", files: [{ path: "a.lua", size: 3, sha256: sha(a) }, { path: "b.lua", size: 4, sha256: sha(b) }] },
      { name: "two", files: [{ path: "copy-of-b.lua", size: 4, sha256: sha(b) }] }
    ] };
    const plan = planDownload(manifest, dir);
    assert.equal(plan.fileCount, 2);
    assert.equal(plan.haveBytes, 3);
    assert.equal(plan.missingBytes, 4);
    assert.deepEqual(plan.missing, [{ sha256: sha(b), size: 4 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadMissing fetches everything and reports progress", async () => {
  const bodies = ["one", "two two", "three three three"].map((t) => Buffer.from(t));
  const files = new Map(bodies.map((b) => [sha(b), b]));
  const manifest = { resources: [{ name: "r", files: bodies.map((b, i) => ({ path: `${i}.txt`, size: b.length, sha256: sha(b) })) }] };
  const s = await fakeServer({ files, manifest });
  const dir = tmp();
  try {
    const { manifest: checked } = await inspectServer({ host: s.host, port: s.port, name: "Fake" });
    const plan = planDownload(checked, dir);
    const reports = [];
    await downloadMissing({
      server: { host: s.host, port: s.port },
      plan,
      contentDir: dir,
      concurrency: 2,
      signal: new AbortController().signal,
      onProgress: (p) => reports.push(p)
    });
    assert.equal(planDownload(checked, dir).missingCount, 0);
    const last = reports.at(-1);
    assert.equal(last.doneFiles, 3);
    assert.equal(last.doneBytes, plan.missingBytes);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadMissing can be cancelled", async () => {
  const body = Buffer.alloc(1000, 7);
  const s = await fakeServer({ files: new Map([[sha(body), body]]), slow: true });
  const dir = tmp();
  try {
    const controller = new AbortController();
    const run = downloadMissing({
      server: { host: s.host, port: s.port },
      plan: { missing: [{ sha256: sha(body), size: body.length }], missingBytes: body.length, missingCount: 1 },
      contentDir: dir,
      concurrency: 1,
      signal: controller.signal,
      onProgress: () => {}
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(run, { name: "AbortError" });
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClientManifest uses a Windows-safe folder and points at cached files", () => {
  const dir = tmp();
  try {
    const server = { id: "2001:db8::1:30120", name: "IPv6" };
    const manifest = { resources: [{ name: "r", files: [{ path: "a.lua", size: 1, sha256: "a".repeat(64) }] }] };
    const file = writeClientManifest({ cacheRoot: dir, contentDir: path.join(dir, "content"), server, manifest });
    assert.equal(path.basename(path.dirname(file)), serverKey(server.id));
    assert.doesNotMatch(path.basename(path.dirname(file)), /:/);
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(body.resources[0].files[0].file, blobPath(path.join(dir, "content"), "a".repeat(64)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectServer explains unreachable servers", async () => {
  await assert.rejects(inspectServer({ host: "127.0.0.1", port: 1, name: "Ghost" }), /Couldn't reach Ghost/);
});
