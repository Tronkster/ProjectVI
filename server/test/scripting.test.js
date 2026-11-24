const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventBus } = require("../src/core/events");
const { ServerCore, splitCommandLine } = require("../src/core/server-core");
const { ResourceStore } = require("../src/core/store");
const { parseArgs } = require("../src/core/console");
const { DotnetRuntime, findDotnetHost } = require("../src/runtimes/dotnet");

const quietLog = () => {
  const lines = [];
  const add = (prefix) => (m) => lines.push(`${prefix}${m}`);
  return {
    lines,
    info: add(""),
    warn: add("Warning: "),
    error: add("Error: "),
    debug: () => {},
    script: (resource, level, message) => lines.push(`[${resource}] ${level}: ${message}`)
  };
};

const config = {
  name: "Test",
  maxPlayers: 8,
  port: 30120,
  scripting: { dev: true },
  permissions: { admin: ["discord:111"] }
};

test("local events reach subscribed runtimes; network events only reach network subscribers", () => {
  const bus = new EventBus({ log: quietLog() });
  const calls = [];
  const runtime = { dispatch: (name, args, opts) => calls.push({ name, args, opts }) };
  bus.subscribe(runtime, "jobs:changed", false);
  bus.subscribe(runtime, "jobs:clockIn", true);

  bus.emit("jobs:changed", ["mechanic"]);
  assert.equal(bus.emitFromClient(7, "jobs:changed", []), false, "a client can't trigger a local-only event");
  assert.equal(bus.emitFromClient(7, "jobs:clockIn", [1]), true);
  assert.deepEqual(calls, [
    { name: "jobs:changed", args: ["mechanic"], opts: { network: false } },
    { name: "jobs:clockIn", args: [1], opts: { network: true, source: 7 } }
  ]);

  bus.removeRuntime(runtime);
  bus.emit("jobs:changed", []);
  assert.equal(calls.length, 2);
});

test("console and command parsing", () => {
  assert.deepEqual(parseArgs(' "Kai" 3 true {"a":1} [1,2] bare'), ["Kai", 3, true, { a: 1 }, [1, 2], "bare"]);
  assert.deepEqual(splitCommandLine('job "Ana Lee" mechanic'), ["job", "Ana Lee", "mechanic"]);
});

test("players get groups from verified identifiers, never from their name", () => {
  const core = new ServerCore({ config, log: quietLog(), store: new ResourceStore() });
  const real = core.addPlayer({ name: "Guest", identifiers: ["discord:111"] });
  const impostor = core.addPlayer({ name: "Kai", identifiers: ["guest:abc"] });
  assert.deepEqual(real.groups, ["admin"]);
  assert.deepEqual(impostor.groups, []);
});

test("commands are permission-checked before any script runs", async () => {
  const core = new ServerCore({ config, log: quietLog(), store: new ResourceStore() });
  const invoked = [];
  const runtime = { invokeCommand: async (name, source, args) => { invoked.push({ name, source, args }); return { error: "done" }; } };
  core.registerCommand(runtime, { resource: "jobs", name: "job", permission: "admin", help: "" });
  const admin = core.addPlayer({ name: "Kai", identifiers: ["discord:111"] });
  const guest = core.addPlayer({ name: "Ana", identifiers: ["guest:x"] });

  assert.equal(await core.runCommand(guest.id, "job Ana mechanic"), "You don't have permission to use /job.");
  assert.equal(await core.runCommand(admin.id, "/job Ana mechanic"), "done");
  assert.equal(await core.runCommand(null, "job Ana taxi"), "done");
  assert.equal(await core.runCommand(admin.id, "nope"), "Unknown command: /nope");
  assert.deepEqual(invoked.map((i) => i.source), [admin.id, null]);
});

test("store keys are private to each resource and prefix-matched exactly", () => {
  const store = new ResourceStore();
  store.set("jobs", "job:a", "mechanic");
  store.set("jobs", "jobs:x", 1);
  store.set("other", "job:b", "taxi");
  assert.deepEqual(store.keys("jobs", "job:"), ["job:a"]);
  assert.equal(store.get("other", "job:a"), null);
  assert.equal(store.get("jobs", "job:a"), "mechanic");
  store.delete("jobs", "job:a");
  assert.equal(store.get("jobs", "job:a"), null);
});

// Runs the real C# host with the welcome and jobs resources. Needs `npm run build:scripting` first.
const host = findDotnetHost();
const resourceDll = (name, dll) => path.join(__dirname, "..", "resources", name, "bin", "server", dll);
const welcomeDll = resourceDll("welcome", "Welcome.Server.dll");
const jobsDll = resourceDll("jobs", "Jobs.Server.dll");
const canRunCSharp = Boolean(host) && fs.existsSync(welcomeDll) && fs.existsSync(jobsDll);
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
};

test("C# resources: events, commands, exports, natives and players end to end", { skip: !canRunCSharp && "build the C# scripting first (npm run build:scripting)" }, async () => {
  const log = quietLog();
  const core = new ServerCore({ config, log, store: new ResourceStore() });
  const dotnet = new DotnetRuntime({ host, core, log });
  const replies = [];
  core.bus.on("welcome:pong", (text) => replies.push(text));
  try {
    await dotnet.startResource({ name: "jobs", dir: path.dirname(jobsDll), assemblies: [jobsDll], config: { pay_interval_seconds: 3600, jobs: { mechanic: { label: "Mechanic", pay: 120 } } } });
    await dotnet.startResource({ name: "welcome", dir: path.dirname(welcomeDll), assemblies: [welcomeDll] });

    core.bus.emit("welcome:ping", ["Kai"]);
    await until(() => replies.length > 0);
    assert.deepEqual(replies, ["Hello, Kai!"]);

    const admin = core.addPlayer({ name: "Kai", identifiers: ["discord:111"] });
    const ana = core.addPlayer({ name: "Ana", identifiers: ["guest:ana"] });
    await until(() => log.lines.filter((l) => l.startsWith("[to ")).length >= 2);
    assert.ok(log.lines.includes("[to Kai] Welcome to Test, Kai!"), log.lines.join("\n"));

    assert.equal(await core.runCommand(ana.id, "job Ana mechanic"), "You don't have permission to use /job.");
    assert.equal(await core.runCommand(admin.id, "job Ana mechanic"), "Ana is now a Mechanic.");
    assert.equal(core.store.get("jobs", "job:guest:ana"), "mechanic");
    assert.equal(await core.callExport("jobs", "GetJob", [{ $player: ana.id }]), "mechanic");

    assert.equal(core.bus.emitFromClient(ana.id, "jobs:clockIn", []), true);
    await until(() => log.lines.some((l) => l.includes("[to Ana] Clocked in")));
    assert.equal(await core.runCommand(ana.id, "myjob"), "You're a Mechanic, on duty.");
  } finally {
    await dotnet.stop();
  }
});
