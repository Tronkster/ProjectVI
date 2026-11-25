// The in-game clock and weather. The server decides them so every player sees the same time of day and the
// same sky; sync (src/sync.js) sends them to players, and scripts change them through the world.* natives.
//
// The clock runs at `timeScale` in-game minutes per real minute (GTA V's is 30) and stops at 0. It isn't
// ticked: the time is worked out from the last setting and how long ago that was, the same way clients do.
// An optional weather cycle picks the next weather from a list every `weatherMinutes` real minutes.

const { EventEmitter } = require("node:events");

const DAY = 24 * 60 * 60; // in-game seconds
const MAX_TIME_SCALE = 1000;
const WEATHER_NAME = /^[a-z0-9_]{1,32}$/;
const CYCLE_TRANSITION_SECONDS = 60;

// "18:30" -> 66600, or null if it isn't a time of day.
function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

// Weather names are the game's, lowercased: "clear", "rain", "thunder" and so on.
function normaliseWeather(name) {
  const value = String(name ?? "").trim().toLowerCase();
  return WEATHER_NAME.test(value) ? value : null;
}

const isWholeIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Events: "change" ({ weatherChanged, weather, previous, transition }) after any setting changes.
class World extends EventEmitter {
  constructor({ time = "12:00", timeScale = 30, weather = "clear", weatherCycle = [], weatherMinutes = 15, now = () => Date.now(), random = Math.random } = {}) {
    super();
    this.now = now;
    this.random = random;
    this.anchor = now(); // real time the clock was last set
    this.seconds = parseTime(time) ?? 12 * 3600; // in-game seconds since midnight at `anchor`
    this.scale = timeScale;
    this.weather = normaliseWeather(weather) ?? "clear";
    this.cycle = weatherCycle.map(normaliseWeather).filter(Boolean);
    this.cycleMs = weatherMinutes * 60_000;
    this.nextWeatherAt = this.now() + this.cycleMs;
    this.timer = null;
  }

  // Runs the weather cycle, if there is one. Tests call tick() themselves instead.
  start() {
    if (this.cycle.length) this.timer = setInterval(() => this.tick(), 1000).unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    if (!this.cycle.length || this.now() < this.nextWeatherAt) return;
    this.nextWeatherAt = this.now() + this.cycleMs;
    const choices = this.cycle.length > 1 ? this.cycle.filter((w) => w !== this.weather) : this.cycle;
    this.setWeather(choices[Math.floor(this.random() * choices.length)], CYCLE_TRANSITION_SECONDS);
  }

  // In-game seconds since midnight, now.
  clockSeconds() {
    const elapsed = ((this.now() - this.anchor) / 1000) * this.scale;
    return (((this.seconds + elapsed) % DAY) + DAY) % DAY;
  }

  time() {
    const s = Math.floor(this.clockSeconds());
    return { hour: Math.floor(s / 3600), minute: Math.floor((s % 3600) / 60), second: s % 60 };
  }

  setTime(hour, minute = 0, second = 0) {
    if (!isWholeIn(hour, 0, 23) || !isWholeIn(minute, 0, 59) || !isWholeIn(second, 0, 59)) {
      throw new Error("The time must be an hour from 0 to 23, and minutes and seconds from 0 to 59.");
    }
    this.anchor = this.now();
    this.seconds = hour * 3600 + minute * 60 + second;
    this.changed();
  }

  // In-game minutes per real minute. 0 stops the clock.
  setTimeScale(scale) {
    if (!Number.isFinite(scale) || scale < 0 || scale > MAX_TIME_SCALE) throw new Error(`The time scale must be a number from 0 to ${MAX_TIME_SCALE}.`);
    this.seconds = this.clockSeconds();
    this.anchor = this.now();
    this.scale = scale;
    this.changed();
  }

  // transitionSeconds: how long clients take to blend into the new weather.
  setWeather(name, transitionSeconds = 30) {
    const weather = normaliseWeather(name);
    if (!weather) throw new Error("Weather names are 1-32 letters, digits and underscores, for example \"rain\".");
    if (!Number.isFinite(transitionSeconds) || transitionSeconds < 0 || transitionSeconds > 600) throw new Error("The transition must be 0 to 600 seconds.");
    const previous = this.weather;
    this.weather = weather;
    this.changed({ weatherChanged: weather !== previous, previous, transition: transitionSeconds });
  }

  changed({ weatherChanged = false, previous = this.weather, transition = 0 } = {}) {
    this.emit("change", { weatherChanged, weather: this.weather, previous, transition });
  }
}

module.exports = { World, parseTime, normaliseWeather, DAY };
