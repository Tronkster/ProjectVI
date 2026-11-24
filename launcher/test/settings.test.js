const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sanitize, defaults, createSettingsStore } = require("../src/main/settings");

test("sanitize keeps only known keys with valid values", () => {
  const out = sanitize({
    playerName: "Kai",
    parallelDownloads: 12, // out of range
    askAboveMb: "250", // numeric string is accepted
    updateChannel: "nightly", // not an option
    closeToTray: "yes", // not a boolean
    favorites: ["a", "a", "", 7, "b"],
    evil: "ignored",
    __proto__: { polluted: true }
  });
  assert.deepEqual(out, { playerName: "Kai", askAboveMb: 250, favorites: ["a", "b"] });
  assert.equal({}.polluted, undefined);
});

test("store starts from defaults, saves, reloads and resets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-settings-"));
  try {
    const store = createSettingsStore(dir);
    assert.deepEqual(store.get(), defaults());
    store.update({ playerName: "Kai", developerMode: true });

    const reloaded = createSettingsStore(dir);
    assert.equal(reloaded.get().playerName, "Kai");
    assert.equal(reloaded.get().developerMode, true);
    assert.equal(JSON.parse(fs.readFileSync(reloaded.file, "utf8")).schemaVersion, 2);

    assert.deepEqual(reloaded.reset(), defaults());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file falls back to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-settings-"));
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
    assert.deepEqual(createSettingsStore(dir).get(), defaults());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
