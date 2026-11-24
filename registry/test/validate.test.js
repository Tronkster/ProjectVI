const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createZip } = require("@projectvi/zip");
const { validateFile } = require("../validate");

function setup(modJson, { tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-reg-"));
  const zip = createZip([{ name: "mod.json", data: JSON.stringify(modJson) }, { name: "a.lua", data: "x" }]);
  const zipFile = path.join(dir, "mod.zip");
  fs.writeFileSync(zipFile, zip);
  const index = {
    version: 1,
    mods: [{
      id: "clean-hud", name: "Clean HUD", author: "Kai", license: "MIT",
      versions: [{
        version: "1.0.0",
        url: pathToFileURL(zipFile).href,
        sha256: tamper ? "0".repeat(64) : crypto.createHash("sha256").update(zip).digest("hex"),
        size: zip.length
      }]
    }]
  };
  const indexFile = path.join(dir, "index.json");
  fs.writeFileSync(indexFile, JSON.stringify(index));
  return { indexFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const GOOD_META = { id: "clean-hud", name: "Clean HUD", version: "1.0.0" };

test("a correct entry passes, including the download checks", async () => {
  const s = setup(GOOD_META);
  try {
    assert.deepEqual(await validateFile(s.indexFile, { download: true, allowInsecure: true }), []);
  } finally {
    s.cleanup();
  }
});

test("file:// URLs fail without --allow-insecure", async () => {
  const s = setup(GOOD_META);
  try {
    const problems = await validateFile(s.indexFile);
    assert.match(problems.join("\n"), /https/);
  } finally {
    s.cleanup();
  }
});

test("wrong checksum and mismatched mod.json are reported", async () => {
  const tampered = setup(GOOD_META, { tamper: true });
  const mismatched = setup({ ...GOOD_META, version: "9.9.9" });
  try {
    assert.match((await validateFile(tampered.indexFile, { download: true, allowInsecure: true })).join("\n"), /sha256/);
    assert.match((await validateFile(mismatched.indexFile, { download: true, allowInsecure: true })).join("\n"), /mod\.json says/);
  } finally {
    tampered.cleanup();
    mismatched.cleanup();
  }
});

test("the published index.json is valid", async () => {
  assert.deepEqual(await validateFile(path.join(__dirname, "..", "index.json")), []);
});
