const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isSafeRelativePath } = require("../paths");

test("accepts plain relative paths", () => {
  for (const p of ["hud.lua", "ui/hud/main.lua", "stream/car_01.ytd", "a-b_c.d/e"]) {
    assert.equal(isSafeRelativePath(p), true, p);
  }
});

test("rejects paths that could escape or break on Windows", () => {
  const bad = [
    "", "/etc/passwd", "../secret", "ui/../../x", "./x", "ui//x", "C:/Windows/x", "C:x",
    "ui\\x", "con", "ui/NUL.txt", "trailing.", "trailing ", "a|b", "a\u0000b", "x".repeat(201), 42, null
  ];
  for (const p of bad) assert.equal(isSafeRelativePath(p), false, JSON.stringify(p));
});
