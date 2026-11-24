const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, validateRegistry, validateModJson } = require("../registry");

const version = (v, extra = {}) => ({ version: v, url: `https://github.com/a/b/releases/download/v${v}/mod.zip`, sha256: "a".repeat(64), size: 100, released: "2026-11-20", ...extra });
const mod = (extra = {}) => ({ id: "clean-hud", name: "Clean HUD", author: "Kai", license: "MIT", tags: ["ui"], versions: [version("1.0.0"), version("1.2.0")], ...extra });

test("compareVersions orders semver correctly", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("valid registry: versions are sorted newest first", () => {
  const [registry, error] = validateRegistry({ version: 1, mods: [mod()] });
  assert.equal(error, null);
  assert.deepEqual(registry.mods[0].versions.map((v) => v.version), ["1.2.0", "1.0.0"]);
  assert.deepEqual(registry.skipped, []);
});

test("broken mods are skipped with a reason, the rest still load", () => {
  const [registry] = validateRegistry({ version: 1, mods: [
    mod(),
    mod({ id: "Bad ID" }),
    mod({ id: "no-license", license: "" }),
    mod({ id: "http-url", versions: [version("1.0.0", { url: "http://example.com/x.zip" })] }),
    mod({ id: "bad-hash", versions: [version("1.0.0", { sha256: "xyz" })] }),
    mod() // duplicate id
  ] });
  assert.equal(registry.mods.length, 1);
  assert.equal(registry.skipped.length, 5);
  assert.match(registry.skipped.find((s) => s.id === "http-url").reason, /https/);
});

test("developer mode allows http and file URLs", () => {
  const raw = { version: 1, mods: [mod({ versions: [version("1.0.0", { url: "http://localhost:30190/x.zip" })] })] };
  assert.equal(validateRegistry(raw)[0].mods.length, 0);
  assert.equal(validateRegistry(raw, { allowInsecure: true })[0].mods.length, 1);
});

test("rejects unknown registry formats and checks mod.json", () => {
  assert.notEqual(validateRegistry({ version: 2, mods: [] })[1], null);
  assert.notEqual(validateRegistry(null)[1], null);
  assert.equal(validateModJson({ id: "clean-hud", version: "1.2.0", name: "Clean HUD" })[1], null);
  assert.notEqual(validateModJson({ id: "clean-hud", version: "one", name: "x" })[1], null);
});
