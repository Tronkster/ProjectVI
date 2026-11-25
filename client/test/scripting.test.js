const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ScriptHost, MAX_ERRORS } = require("../src/scripting");
const { loadPackages, scriptsOf } = require("../src/packages");

// A package from { "path": "source" }, written to a temp folder.
function makePackage(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-pkg-"));
  const map = new Map();
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    map.set(rel, abs);
  }
  return { pkg: { kind: "mod", name, key: `mod-${name}`, files: map }, dir };
}

function recordingApi() {
  const rec = { logs: [], events: [], chats: [], notices: [], ui: [], sent: [] };
  let nextUi = 1;
  rec.api = {
    log: (pkg, level, text) => rec.logs.push({ pkg: pkg.name, level, text }),
    sendServerEvent: (name, args) => rec.events.push({ name, args }),
    sendChat: (text) => rec.chats.push(text),
    notify: (text) => rec.notices.push(text),
    players: () => [{ id: 1, name: "Ana", is_host: true }, { id: 2, name: "Ben", is_host: false, character: null }],
    time: () => ({ hour: 18, minute: 30 }),
    weather: () => "rain",
    uiOpen: (pkg, file) => {
      const id = `${pkg.key}/${nextUi++}`;
      rec.ui.push({ id, file });
      return id;
    },
    uiSend: (id, name, data) => rec.sent.push({ id, name, data }),
    uiShow: (id, visible) => rec.sent.push({ id, show: visible })
  };
  return rec;
}

const errors = (rec) => rec.logs.filter((l) => l.level === "error").map((l) => l.text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("scripts get the documented API and nothing that reaches outside", async () => {
  const { pkg, dir } = makePackage("probe", {
    "main.lua": `
      result = {
        io = type(io), debug = type(debug), loadfile = type(loadfile), dofile = type(dofile), package = type(package),
        execute = type(os.execute), getenv = type(os.getenv), time = type(os.time), dump = type(string.dump),
      }
      local binary, err = load("\\27Lua", "x", "b")
      result.binary = tostring(binary) .. ":" .. tostring(err ~= nil)
      local util = require("lib.util")
      result.util = util.double(21)
      result.missing = select(2, pcall(require, "nope")):match("no nope.lua") ~= nil
      result.escape = select(2, pcall(require, "../x")):match("bad module name") ~= nil
      server.emit("probe:result", result, nil, "last")
      print("hello", 1, nil)
    `,
    "lib/util.lua": "return { double = function(n) return n * 2 end }"
  });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  try {
    await host.start([pkg]);
    assert.deepEqual(errors(rec), []);
    assert.equal(rec.events.length, 1);
    const [result, hole, last] = rec.events[0].args;
    assert.deepEqual(result, {
      io: "nil", debug: "nil", loadfile: "nil", dofile: "nil", package: "nil",
      execute: "nil", getenv: "nil", time: "function", dump: "nil",
      binary: "nil:true", util: 42, missing: true, escape: true
    });
    assert.equal(hole, null);
    assert.equal(last, "last");
    assert.ok(rec.logs.some((l) => l.text === "hello\t1\tnil"));
  } finally {
    host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timers run, can be cancelled, and events reach handlers with their arguments", async () => {
  const { pkg, dir } = makePackage("timers", {
    "a.lua": `
      ticks = 0
      local id = every(20, function() ticks = ticks + 1; if ticks == 3 then server.emit("ticked", ticks) end end)
      after(150, function() cancel(id); server.emit("cancelled", ticks) end)
      on("chat", function(name, text, extra) server.emit("heard", name, text, extra) end)
      on("local", function(x) server.emit("local", x) end)
      emit("local", "from a")
      chat.send("hi all")
      notify("note")
      local everyone = players()
      server.emit("players", #everyone, everyone[1].name, everyone[2].character)
      server.emit("world", world.time().hour, world.weather())
    `
  });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  try {
    await host.start([pkg]);
    host.dispatch("chat", ["Ana", "hello", null]);
    await wait(300);
    const by = (name) => rec.events.filter((e) => e.name === name).map((e) => e.args);
    assert.deepEqual(by("ticked"), [[3]]);
    const [cancelledAt] = by("cancelled")[0];
    const after = rec.events.length;
    await wait(100);
    assert.equal(rec.events.length, after); // the repeating timer stopped
    assert.ok(cancelledAt >= 3);
    assert.deepEqual(by("heard"), [["Ana", "hello", null]]);
    assert.deepEqual(by("local"), [["from a"]]);
    assert.deepEqual(by("players"), [[2, "Ana", null]]);
    assert.deepEqual(by("world"), [[18, "rain"]]);
    assert.deepEqual(rec.chats, ["hi all"]);
    assert.deepEqual(rec.notices, ["note"]);
  } finally {
    host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runaway scripts are stopped, and other packages keep running", async () => {
  const bad = makePackage("bad", {
    "a.lua": "while true do end",
    "b.lua": "local t = {} for i = 1, 1e8 do t[i] = ('x'):rep(100) .. i end",
    "c.lua": "every(20, function() while true do end end)"
  });
  const good = makePackage("good", { "a.lua": "every(20, function() server.emit('alive') end)" });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  const started = Date.now();
  try {
    await host.start([bad.pkg, good.pkg]);
    await wait(700);
    const badErrors = rec.logs.filter((l) => l.pkg === "bad" && l.level === "error").map((l) => l.text);
    assert.ok(badErrors.some((t) => t.includes("a.lua") && t.includes("timeout")));
    assert.ok(badErrors.some((t) => t.includes("b.lua") && t.includes("memory")));
    assert.ok(badErrors.some((t) => t.includes("timeout")) && badErrors.length >= 3);
    assert.ok(rec.events.filter((e) => e.name === "alive").length >= 3, "the other package keeps working");
    assert.ok(Date.now() - started < 10_000);
  } finally {
    host.stop();
    fs.rmSync(bad.dir, { recursive: true, force: true });
    fs.rmSync(good.dir, { recursive: true, force: true });
  }
});

test("a package that keeps failing is stopped", async () => {
  const { pkg, dir } = makePackage("noisy", { "a.lua": "every(16, function() error('boom') end)" });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  try {
    await host.start([pkg]);
    await wait(MAX_ERRORS * 16 * 2 + 500);
    assert.equal(errors(rec).length, MAX_ERRORS);
    assert.ok(rec.logs.some((l) => l.level === "warn" && l.text.includes(`stopped after ${MAX_ERRORS} errors`)));
  } finally {
    host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("UI overlays: scripts open pages, send them data, and hear back", async () => {
  const { pkg, dir } = makePackage("hud", {
    "hud.lua": `
      local hud = ui.overlay("ui/hud.html")
      hud:send("speed", { kmh = 42, label = "fast" })
      hud:on("clicked", function(data) server.emit("clicked", data.button) end)
      hud:hide()
    `,
    "ui/hud.html": "<p>hud</p>"
  });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  try {
    await host.start([pkg]);
    assert.deepEqual(rec.ui, [{ id: "mod-hud/1", file: "ui/hud.html" }]);
    assert.deepEqual(rec.sent, [{ id: "mod-hud/1", name: "speed", data: { kmh: 42, label: "fast" } }, { id: "mod-hud/1", show: false }]);
    host.uiMessage("mod-hud/1", "clicked", { button: "left" });
    host.uiMessage("mod-other/1", "clicked", { button: "nope" }); // not this package's page
    assert.deepEqual(rec.events, [{ name: "clicked", args: ["left"] }]);
  } finally {
    host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the player table is what the client knows, and packages don't share globals", async () => {
  const a = makePackage("a", { "a.lua": "secret = 1; on('check', function() server.emit('a', player and player.name, player and player.position and player.position.x, player and player.money) end)" });
  const b = makePackage("b", { "b.lua": "on('check', function() server.emit('b', tostring(secret)) end)" });
  const rec = recordingApi();
  const host = new ScriptHost({ api: rec.api });
  try {
    await host.start([a.pkg, b.pkg]);
    host.setPlayer({ name: "Kai", position: { x: 5, y: 6, z: 7 }, money: null });
    host.dispatch("check");
    assert.deepEqual(rec.events, [{ name: "a", args: ["Kai", 5, null] }, { name: "b", args: ["nil"] }]);
  } finally {
    host.stop();
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

test("packages come from the content list and the enabled mods, scripts from their top level", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-load-"));
  try {
    const blob = path.join(dir, "blob1");
    fs.writeFileSync(blob, "-- hud");
    const content = path.join(dir, "manifest.json");
    fs.writeFileSync(content, JSON.stringify({ resources: [
      { name: "hud", files: [{ path: "client.lua", file: blob }, { path: "ui/index.html", file: blob }, { path: "../evil.lua", file: blob }] },
      { name: "bad name!", files: [] }
    ] }));
    const modDir = path.join(dir, "clean-hud", "1.0.0");
    fs.mkdirSync(path.join(modDir, "ui"), { recursive: true });
    fs.writeFileSync(path.join(modDir, "hud.lua"), "");
    fs.writeFileSync(path.join(modDir, "b.lua"), "");
    fs.writeFileSync(path.join(modDir, "ui", "x.lua"), "");
    const mods = path.join(dir, "mods-enabled.json");
    fs.writeFileSync(mods, JSON.stringify({ mods: [{ id: "clean-hud", version: "1.0.0", dir: modDir }, { id: "gone", version: "1.0.0", dir: path.join(dir, "nope") }] }));

    const { packages, warnings } = loadPackages({ contentFile: content, modsFile: mods });
    assert.deepEqual(packages.map((p) => p.key), ["resource-hud", "mod-clean-hud"]);
    assert.deepEqual([...packages[0].files.keys()], ["client.lua", "ui/index.html"]);
    assert.deepEqual(scriptsOf(packages[1]), ["b.lua", "hud.lua"]);
    assert.equal(warnings.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
