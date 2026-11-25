const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { World, parseTime } = require("../src/core/world");
const { ServerCore } = require("../src/core/server-core");
const { SyncServer } = require("../src/sync");
const { validateConfig } = require("../src/config");
const { SyncClient } = require("@projectvi/shared/sync-client");
const shared = require("@projectvi/shared");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const hhmm = ({ hour, minute }) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

test("the clock runs at its scale, stops at 0, carries on from where it stopped and wraps at midnight", () => {
  let clock = 0;
  const world = new World({ time: "23:00", timeScale: 30, now: () => clock });
  assert.equal(hhmm(world.time()), "23:00");
  clock += 60_000; // one real minute is 30 in-game minutes
  assert.equal(hhmm(world.time()), "23:30");
  world.setTimeScale(0);
  clock += 600_000;
  assert.equal(hhmm(world.time()), "23:30");
  world.setTimeScale(60);
  clock += 60_000; // an hour later: past midnight
  assert.equal(hhmm(world.time()), "00:30");
  world.setTime(6, 15, 30);
  assert.deepEqual(world.time(), { hour: 6, minute: 15, second: 30 });
  assert.equal(parseTime("18:30"), 66_600);
  assert.equal(parseTime("24:00"), null);
});

test("settings are checked, and every change is announced with what changed", () => {
  const world = new World({ now: () => 0 });
  const changes = [];
  world.on("change", (c) => changes.push(c));
  assert.throws(() => world.setTime(24, 0), /hour from 0 to 23/);
  assert.throws(() => world.setTime(12.5), /hour/);
  assert.throws(() => world.setTimeScale(-1), /from 0 to 1000/);
  assert.throws(() => world.setWeather("heavy rain!"), /Weather names/);
  assert.throws(() => world.setWeather("rain", 9999), /transition/);
  world.setWeather("RAIN", 45);
  world.setWeather("rain", 0);
  world.setTime(12);
  assert.deepEqual(changes, [
    { weatherChanged: true, weather: "rain", previous: "clear", transition: 45 },
    { weatherChanged: false, weather: "rain", previous: "rain", transition: 0 },
    { weatherChanged: false, weather: "rain", previous: "rain", transition: 0 }
  ]);
});

test("the weather cycle picks a different weather from the list every interval", () => {
  let clock = 0;
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const world = new World({ weather: "clear", weatherCycle: ["clear", "clouds", "rain"], weatherMinutes: 10, now: () => clock, random });
  const seen = [];
  world.on("change", (c) => seen.push([c.weather, c.previous, c.transition]));
  clock += 9 * 60_000;
  world.tick();
  assert.deepEqual(seen, []);
  for (let i = 0; i < 6; i++) {
    clock += 10 * 60_000;
    world.tick();
  }
  assert.equal(seen.length, 6);
  for (const [weather, previous, transition] of seen) {
    assert.notEqual(weather, previous);
    assert.ok(["clear", "clouds", "rain"].includes(weather));
    assert.equal(transition, 60);
  }
});

test("[world] settings are read and checked", () => {
  const config = validateConfig({ server: { name: "W" }, world: { time: "18:30", time_scale: 0, weather: "Rain", weather_cycle: ["clear", "rain"], weather_minutes: 5 } });
  assert.deepEqual(config.world, { time: "18:30", timeScale: 0, weather: "Rain", weatherCycle: ["clear", "rain"], weatherMinutes: 5 });
  assert.throws(() => validateConfig({ server: { name: "W" }, world: { time: "25:00" } }), /\[world\] time/);
  assert.throws(() => validateConfig({ server: { name: "W" }, world: { time_scale: -2 } }), /\[world\] time_scale/);
  assert.throws(() => validateConfig({ server: { name: "W" }, world: { weather_cycle: ["sun shine"] } }), /\[world\] weather_cycle/);
});

test("scripts read and change the clock and weather through natives, and hear weatherChanged", () => {
  const core = new ServerCore({ config: validateConfig({ server: { name: "W" }, world: { time: "08:00", time_scale: 0 } }), log: quietLog, store: null });
  const heard = [];
  core.bus.on("weatherChanged", (weather, previous) => heard.push([weather, previous]));
  const native = (name, ...args) => core.callNative("test", name, args);
  assert.deepEqual(native("world.time"), { hour: 8, minute: 0, second: 0 });
  native("world.setTime", 21, 45);
  assert.deepEqual(native("world.time"), { hour: 21, minute: 45, second: 0 });
  assert.equal(native("world.timeScale"), 0);
  native("world.setTimeScale", 12);
  assert.equal(native("world.timeScale"), 12);
  native("world.setWeather", "thunder");
  assert.equal(native("world.weather"), "thunder");
  assert.deepEqual(heard, [["thunder", "clear"]]);
  assert.throws(() => native("world.setTime", 99), /hour/);
});

test("players get the clock and weather on joining and whenever they change, and keep the clock running", async () => {
  const config = validateConfig({ server: { name: "W" }, world: { time: "06:15", time_scale: 0, weather: "foggy" } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const sync = new SyncServer({ core, log: quietLog, tickRate: 20 });
  const port = await sync.listen(0, "127.0.0.1");
  const client = new SyncClient({ host: "127.0.0.1", port, name: "Kai" });
  try {
    const first = once(client, "world");
    await client.connect();
    const [joined] = await first;
    assert.equal(joined.weather, "foggy");
    assert.equal(joined.transition, 0);
    assert.equal(hhmm(client.gameTime()), "06:15");

    const rain = once(client, "world");
    core.callNative("test", "world.setWeather", ["rain", 45]);
    const [rained] = await rain;
    assert.deepEqual([rained.weather, rained.transition, rained.weatherChanged], ["rain", 45, true]);

    // A fast clock: the client keeps it running between messages.
    const faster = once(client, "world");
    core.world.setTimeScale(600); // 10 in-game minutes per real second
    assert.equal((await faster)[0].weatherChanged, false); // still raining: a blend in progress carries on
    const before = client.gameTime();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = client.gameTime();
    const minutes = (after.hour * 60 + after.minute) - (before.hour * 60 + before.minute);
    assert.ok(minutes >= 4 && minutes <= 8, `the clock moved ${minutes} in-game minutes in 0.6 s`);
    // Within a few real milliseconds (at 0.6 in-game seconds each) of the server's clock.
    const secondsOf = ({ hour, minute, second }) => hour * 3600 + minute * 60 + second;
    const drift = Math.abs(secondsOf(core.world.time()) - secondsOf(client.gameTime()));
    assert.ok(Math.min(drift, 86_400 - drift) <= 60, `client clock ${drift} in-game seconds off`);
  } finally {
    await client.close();
    await sync.close();
  }
});

test("WORLD messages survive an encode and decode, and malformed ones are refused", () => {
  const world = { serverTime: 1234, clock: 66_600, scale: 30, weather: "rain", transition: 45 };
  assert.deepEqual(shared.decodeChannelMessage(shared.encodeWorld(world)), { kind: shared.SYNC_CHANNEL.WORLD, ...world });
  const broken = shared.encodeWorld(world);
  broken.writeFloatLE(NaN, 9);
  assert.equal(shared.decodeChannelMessage(broken), null);
  assert.equal(shared.decodeChannelMessage(shared.encodeWorld(world).subarray(0, 17)), null);
});
