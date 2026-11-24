const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { splitArgs, buildLaunch } = require("../src/main/launch");

test("splitArgs honors quotes", () => {
  assert.deepEqual(splitArgs('"{game}" --fullscreen'), ["{game}", "--fullscreen"]);
  assert.deepEqual(splitArgs('-a "C:\\Games\\GTA VI" -b'), ["-a", "C:\\Games\\GTA VI", "-b"]);
  assert.deepEqual(splitArgs(""), []);
});

test("buildLaunch needs an existing emulator file", () => {
  assert.equal(buildLaunch({ emulatorPath: "" }).code, "no-emulator");
  assert.equal(buildLaunch({ emulatorPath: path.join(os.tmpdir(), "definitely-missing.exe") }).code, "no-emulator");
});

test("buildLaunch fills placeholders, drops empty args and sets env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-launch-"));
  const exe = path.join(dir, "emu.exe");
  fs.writeFileSync(exe, "");
  try {
    const plan = buildLaunch(
      { emulatorPath: exe, gamePath: "", launchArgs: '"{game}" --connect {server} --name "{name}"', playerName: "Kai", masterUrl: "http://localhost:30180" },
      { serverId: "1.2.3.4:30120", contentFile: "C:\\c.json", modsFile: "C:\\m.json" }
    );
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.args, ["--connect", "1.2.3.4:30120", "--name", "Kai"]);
    assert.equal(plan.cwd, dir);
    assert.equal(plan.env.PROJECTVI_SERVER, "1.2.3.4:30120");
    assert.equal(plan.env.PROJECTVI_CONTENT, "C:\\c.json");
    assert.equal(plan.env.PROJECTVI_MODS, "C:\\m.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLaunch ignores a server id with odd characters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-launch-"));
  const exe = path.join(dir, "emu.exe");
  fs.writeFileSync(exe, "");
  try {
    const plan = buildLaunch({ emulatorPath: exe, launchArgs: "{server}" }, { serverId: "x; rm -rf /" });
    assert.deepEqual(plan.args, []);
    assert.equal(plan.env.PROJECTVI_SERVER, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
