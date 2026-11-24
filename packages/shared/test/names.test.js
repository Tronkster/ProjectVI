const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validatePlayerName, suggestPlayerName } = require("../names");

test("accepts normal names and trims them", () => {
  assert.deepEqual(validatePlayerName("  Kai_M.  "), { ok: true, name: "Kai_M." });
  assert.equal(validatePlayerName("Night Driver 99").ok, true);
});

test("rejects empty, short, long and odd names", () => {
  assert.equal(validatePlayerName("").error, "Enter a name.");
  assert.equal(validatePlayerName(undefined).error, "Enter a name.");
  assert.match(validatePlayerName("ab").error, /at least 3/);
  assert.match(validatePlayerName("a".repeat(25)).error, /at most 24/);
  assert.match(validatePlayerName("bad<name>").error, /only letters/);
  assert.match(validatePlayerName("two  spaces").error, /double spaces/);
});

test("suggests a valid name from a display name", () => {
  assert.equal(suggestPlayerName("Zoë ✨ Ramírez"), "Zoe Ramirez");
  assert.equal(suggestPlayerName("🔥🔥"), "");
  assert.equal(suggestPlayerName("x".repeat(40)).length, 24);
});
