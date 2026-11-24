const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createZip } = require("@projectvi/zip");
const { checkRegistryUrl, createModManager } = require("../src/main/mods");

const silent = { info() {}, warn() {}, error() {} };

// Builds a temp profile with a file:// registry. versions: [{ version, files, modJson? }]
function setup(versions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-mods-"));
  const paths = { data: path.join(root, "data"), cache: path.join(root, "cache"), mods: path.join(root, "mods") };
  const entries = versions.map((v) => {
    const zip = createZip([
      { name: "mod.json", data: JSON.stringify(v.modJson ?? { id: "clean-hud", name: "Clean HUD", version: v.version }) },
      ...Object.entries(v.files ?? { "hud.lua": "x" }).map(([name, data]) => ({ name, data }))
    ]);
    const file = path.join(root, `clean-hud-${v.version}.zip`);
    fs.writeFileSync(file, zip);
    return { version: v.version, url: pathToFileURL(file).href, sha256: crypto.createHash("sha256").update(zip).digest("hex"), size: zip.length };
  });
  const registryFile = path.join(root, "index.json");
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, mods: [{ id: "clean-hud", name: "Clean HUD", author: "Kai", license: "MIT", versions: entries }] }));

  const settings = { registryUrl: pathToFileURL(registryFile).href, developerMode: true };
  const manager = createModManager({ getPaths: () => paths, getSettings: () => settings, logger: silent, onProgress: () => {} });
  return { root, paths, settings, manager, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("registry addresses need https unless developer mode is on", () => {
  assert.equal(checkRegistryUrl("https://raw.githubusercontent.com/a/b/main/index.json", false), null);
  assert.match(checkRegistryUrl("http://localhost:30190/index.json", false), /developer mode/);
  assert.equal(checkRegistryUrl("http://localhost:30190/index.json", true), null);
  assert.match(checkRegistryUrl("javascript:alert(1)", true), /https/);
});

test("an empty registry address means not published yet", async () => {
  const s = setup([{ version: "1.0.0" }]);
  try {
    s.settings.registryUrl = "";
    const list = await s.manager.list();
    assert.equal(list.registry.configured, false);
    assert.deepEqual(list.mods, []);
  } finally {
    s.cleanup();
  }
});

test("install, turn off, update and remove a mod", async () => {
  const s = setup([{ version: "1.0.0", files: { "hud.lua": "old" } }]);
  try {
    let list = await s.manager.list();
    assert.equal(list.mods[0].installedVersion, null);

    let res = await s.manager.install("clean-hud");
    assert.equal(res.ok, true, res.error);
    const dir = path.join(s.paths.mods, "clean-hud", "1.0.0");
    assert.equal(fs.readFileSync(path.join(dir, "hud.lua"), "utf8"), "old");
    let enabled = JSON.parse(fs.readFileSync(s.manager.enabledListFile(), "utf8"));
    assert.deepEqual(enabled.mods, [{ id: "clean-hud", version: "1.0.0", dir }]);

    res = s.manager.setEnabled("clean-hud", false);
    assert.equal(res.installed[0].enabled, false);
    enabled = JSON.parse(fs.readFileSync(s.manager.enabledListFile(), "utf8"));
    assert.deepEqual(enabled.mods, []);

    // Publish 1.1.0 and update; the old version folder goes away and "off" is kept.
    const next = setup([{ version: "1.0.0" }, { version: "1.1.0", files: { "hud.lua": "new" } }]);
    s.settings.registryUrl = next.settings.registryUrl;
    list = await s.manager.list();
    assert.equal(list.installed[0].updateAvailable, true);
    res = await s.manager.install("clean-hud");
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fs.readdirSync(path.join(s.paths.mods, "clean-hud")), ["1.1.0"]);
    assert.equal(res.installed[0].version, "1.1.0");
    assert.equal(res.installed[0].enabled, false);

    res = await s.manager.uninstall("clean-hud");
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(s.paths.mods, "clean-hud")), false);
    assert.deepEqual(res.installed, []);
    next.cleanup();
  } finally {
    s.cleanup();
  }
});

test("a zip whose mod.json doesn't match the registry is refused", async () => {
  const s = setup([{ version: "1.0.0", modJson: { id: "something-else", name: "X", version: "1.0.0" } }]);
  try {
    await s.manager.list();
    const res = await s.manager.install("clean-hud");
    assert.equal(res.ok, false);
    assert.match(res.error, /doesn't match/);
    assert.equal(fs.existsSync(path.join(s.paths.mods, "clean-hud", "1.0.0")), false);
  } finally {
    s.cleanup();
  }
});

test("a zip with a path traversal is refused and leaves nothing behind", async () => {
  const s = setup([{ version: "1.0.0", files: { "../../escape.txt": "x" } }]);
  try {
    await s.manager.list();
    const res = await s.manager.install("clean-hud");
    assert.equal(res.ok, false);
    assert.equal(fs.existsSync(path.join(s.root, "escape.txt")), false);
    assert.equal(fs.existsSync(path.join(s.paths.mods, "clean-hud", "1.0.0")), false);
  } finally {
    s.cleanup();
  }
});
