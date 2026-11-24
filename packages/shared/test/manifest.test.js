const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest, validateInfo } = require("../manifest");

const SHA = "a".repeat(64);
const file = (path, size = 10) => ({ path, size, sha256: SHA });

test("accepts a good manifest and adds totals", () => {
  const [m, error] = validateManifest({ resources: [{ name: "hud", files: [file("client.lua", 5), file("ui/index.html", 7)] }] });
  assert.equal(error, null);
  assert.equal(m.fileCount, 2);
  assert.equal(m.totalBytes, 12);
});

test("rejects traversal, duplicates, bad sizes and bad hashes", () => {
  const cases = [
    { resources: [{ name: "hud", files: [file("../evil.dll")] }] },
    { resources: [{ name: "hud", files: [file("C:/evil.dll")] }] },
    { resources: [{ name: "hud", files: [file("a.lua"), file("a.lua")] }] },
    { resources: [{ name: "hud", files: [{ path: "a.lua", size: -1, sha256: SHA }] }] },
    { resources: [{ name: "hud", files: [{ path: "a.lua", size: 1, sha256: "nope" }] }] },
    { resources: [{ name: "../hud", files: [] }] },
    { resources: [{ name: "hud", files: [] }, { name: "hud", files: [] }] },
    { resources: "nope" },
    null
  ];
  for (const c of cases) assert.notEqual(validateManifest(c)[1], null, JSON.stringify(c));
});

test("checks the protocol version", () => {
  assert.equal(validateInfo({ protocol: 1, name: "Dev", contentBytes: 5, fileCount: 1 })[1], null);
  assert.match(validateInfo({ protocol: 2 })[1], /newer launcher/);
  assert.match(validateInfo({ protocol: 0 })[1], /older/);
  assert.notEqual(validateInfo(null)[1], null);
});
