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

test("buildLaunch passes a join ticket only if it looks like one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-launch-"));
  const exe = path.join(dir, "emu.exe");
  fs.writeFileSync(exe, "");
  try {
    const ticketFor = (ticket) => buildLaunch({ emulatorPath: exe }, { serverId: "1.2.3.4:30120", ticket }).env.PROJECTVI_TICKET;
    assert.equal(ticketFor("v1.eyJhIjoxfQ.c2ln"), "v1.eyJhIjoxfQ.c2ln");
    assert.equal(ticketFor(undefined), "");
    assert.equal(ticketFor("v1.a b.c"), "");
    assert.equal(ticketFor("v2.abc.def"), "");
    assert.equal(ticketFor(`v1.${"a".repeat(1000)}.b`), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("joining passes the bridge file to the emulator and the client, and the client runs on the launcher's Node", () => {
  const { buildClientLaunch } = require("../src/main/launch");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-launch-"));
  const exe = path.join(dir, "emu.exe");
  fs.writeFileSync(exe, "");
  try {
    const bridgeFile = String.raw`C:\cache\bridge\1.json`;
    const clientLog = String.raw`C:\logs\client.log`;
    const plan = buildLaunch({ emulatorPath: exe, playerName: "Kai" }, { serverId: "1.2.3.4:30120", bridgeFile, clientLog });
    assert.equal(plan.env.VICTORY_BRIDGE_FILE, bridgeFile);
    assert.equal(plan.env.PROJECTVI_BRIDGE_FILE, bridgeFile);
    assert.equal(plan.env.PROJECTVI_CLIENT_LOG, clientLog);
    const main = String.raw`C:\app\client\main.js`;
    const node = String.raw`C:\app\ProjectVI.exe`;
    const client = buildClientLaunch(plan, main, node);
    assert.equal(client.exe, node);
    assert.deepEqual(client.args, [main]);
    assert.equal(client.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(client.env.PROJECTVI_SERVER, "1.2.3.4:30120");
    assert.equal(client.env.PROJECTVI_PLAYER, "Kai");

    // A plain launch from Settings opens no bridge.
    assert.equal(buildLaunch({ emulatorPath: exe }, {}).env.VICTORY_BRIDGE_FILE, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the client's path is moved out of app.asar, where the launcher's Node can run it", () => {
  // The same expression as clientEntry() in src/main/ipc.js.
  const unpack = (p) => p.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
  assert.equal(
    unpack(String.raw`C:\x\resources\app.asar\node_modules\@projectvi\client\src\main.js`),
    String.raw`C:\x\resources\app.asar.unpacked\node_modules\@projectvi\client\src\main.js`
  );
  assert.equal(unpack("/x/resources/app.asar/node_modules/a.js"), "/x/resources/app.asar.unpacked/node_modules/a.js");
  assert.equal(unpack(String.raw`C:\dev\ProjectVI\client\src\main.js`), String.raw`C:\dev\ProjectVI\client\src\main.js`);
});
