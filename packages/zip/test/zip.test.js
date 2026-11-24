const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createZip, extractZip, inspectZip, readModJson } = require("..");

function withZip(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-zip-"));
  const file = path.join(dir, "mod.zip");
  fs.writeFileSync(file, createZip(entries));
  return Promise.resolve(fn(file, dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const GOOD = [
  { name: "mod.json", data: JSON.stringify({ id: "clean-hud", name: "Clean HUD", version: "1.0.0" }) },
  { name: "ui", dir: true },
  { name: "ui/hud.lua", data: "print('hi')" }
];

test("extracts a normal mod and reads its mod.json", () =>
  withZip(GOOD, async (file, dir) => {
    assert.deepEqual(await readModJson(file), { id: "clean-hud", name: "Clean HUD", version: "1.0.0" });
    const out = path.join(dir, "out");
    const result = await extractZip(file, out);
    assert.equal(result.entries, 3);
    assert.equal(fs.readFileSync(path.join(out, "ui", "hud.lua"), "utf8"), "print('hi')");
  }));

const EVIL = {
  "parent traversal": [{ name: "../evil.txt", data: "x" }],
  "nested traversal": [{ name: "ui/../../evil.txt", data: "x" }],
  "absolute path": [{ name: "/etc/evil.txt", data: "x" }],
  "drive letter": [{ name: "C:/evil.txt", data: "x" }],
  "symlink": [{ name: "link", data: "/etc/passwd", mode: 0o120777 }],
  "windows reserved name": [{ name: "con.txt", data: "x" }],
  "duplicate file": [{ name: "a.txt", data: "1" }, { name: "A.txt", data: "2" }]
};

for (const [label, entries] of Object.entries(EVIL)) {
  test(`refuses a zip with a ${label}`, () =>
    withZip(entries, async (file, dir) => {
      const out = path.join(dir, "out");
      await assert.rejects(extractZip(file, out), /^Error: The mod/);
      assert.equal(fs.existsSync(out), false, "partial folder is removed");
      assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false);
    }));
}

test("enforces entry and size limits", () =>
  withZip(GOOD, async (file) => {
    await assert.rejects(inspectZip(file, { maxEntries: 2, maxBytes: 1e9 }), /more than 2 files/);
    await assert.rejects(inspectZip(file, { maxEntries: 100, maxBytes: 10 }), /too large/);
  }));

test("explains files that aren't zips", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-zip-"));
  const file = path.join(dir, "not.zip");
  fs.writeFileSync(file, "definitely not a zip");
  try {
    await assert.rejects(inspectZip(file), /isn't a valid zip/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
