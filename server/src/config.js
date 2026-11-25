// Reads and checks server.toml. Errors are written for server owners, not developers.

const fs = require("node:fs");
const { parse } = require("smol-toml");
const { RESOURCE_NAME, DEFAULT_MASTER_URL } = require("@projectvi/shared");
const { parseTime, normaliseWeather } = require("./core/world");

const MODES = ["Roleplay", "Racing", "Freeroam", "Other"];

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function validateConfig(raw) {
  const s = raw.server ?? {};
  const m = raw.master ?? {};
  const r = raw.resources ?? {};
  const sc = raw.scripting ?? {};
  const sy = raw.sync ?? {};
  const w = raw.world ?? {};
  const errors = [];

  const time = w.time ?? "12:00";
  if (parseTime(time) === null) errors.push("[world] time must be a time of day like \"18:30\".");
  const timeScale = w.time_scale ?? 30;
  if (typeof timeScale !== "number" || !(timeScale >= 0 && timeScale <= 1000)) errors.push("[world] time_scale must be a number from 0 to 1000 (0 stops the clock).");
  const weather = w.weather ?? "clear";
  if (!normaliseWeather(weather)) errors.push("[world] weather must be a weather name like \"clear\" or \"rain\".");
  const weatherCycle = w.weather_cycle ?? [];
  if (!Array.isArray(weatherCycle) || weatherCycle.length > 32 || !weatherCycle.every(normaliseWeather)) {
    errors.push("[world] weather_cycle must be a list of weather names, for example [\"clear\", \"clouds\", \"rain\"].");
  }
  const weatherMinutes = w.weather_minutes ?? 15;
  if (!isInt(weatherMinutes, 1, 1440)) errors.push("[world] weather_minutes must be a whole number of minutes from 1 to 1440.");

  const tickRate = sy.tick_rate ?? 20;
  if (!isInt(tickRate, 1, 60)) errors.push("[sync] tick_rate must be a number between 1 and 60.");
  const streamRadius = sy.stream_radius ?? 500;
  if (!isInt(streamRadius, 50, 10000)) errors.push("[sync] stream_radius must be a number of metres between 50 and 10000.");
  const timeoutSeconds = sy.timeout_seconds ?? 10;
  if (!isInt(timeoutSeconds, 3, 120)) errors.push("[sync] timeout_seconds must be a number between 3 and 120.");
  // Story characters, given out in order: the first player gets the first. Placeholder names until the game's
  // model names are known; a hash such as "0x39da2754" works too.
  const characters = sy.characters ?? ["lucia", "jason"];
  if (!Array.isArray(characters) || characters.length > 16 || !characters.every((c) => typeof c === "string" && c.trim() && c.length <= 64)) {
    errors.push("[sync] characters must be a list of up to 16 model names, for example [\"lucia\", \"jason\"].");
  }

  const name = text(s.name, 64);
  if (!name) errors.push("[server] name is required (1-64 characters).");

  const port = s.port ?? 30120;
  if (!isInt(port, 1, 65535)) errors.push("[server] port must be a number between 1 and 65535.");

  const maxPlayers = s.max_players ?? 32;
  if (!isInt(maxPlayers, 1, 1024)) errors.push("[server] max_players must be a number between 1 and 1024.");

  const modeInput = text(s.gamemode, 16).toLowerCase();
  const mode = MODES.find((x) => x.toLowerCase() === modeInput) ?? "Other";

  const start = r.start ?? [];
  if (!Array.isArray(start) || !start.every((n) => typeof n === "string" && RESOURCE_NAME.test(n))) {
    errors.push("[resources] start must be a list of folder names, like [\"chat\", \"hud\"].");
  }

  const masterUrl = typeof m.url === "string" && m.url.trim() ? m.url.trim() : DEFAULT_MASTER_URL;
  try {
    new URL(masterUrl);
  } catch {
    errors.push("[master] url isn't a valid address.");
  }

  // [permissions] group = ["discord:123", ...]. Players are matched by verified identifier, never by name.
  const permissions = {};
  for (const [group, members] of Object.entries(raw.permissions ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(group) || !Array.isArray(members) || !members.every((m) => typeof m === "string" && /^[a-z]+:.+$/.test(m))) {
      errors.push(`[permissions] ${group} must be a list of identifiers like ["discord:123456789"].`);
      continue;
    }
    permissions[group] = members;
  }

  if (errors.length) throw new Error(`server.toml has problems:\n  ${errors.join("\n  ")}`);

  return {
    permissions,
    name,
    description: text(s.description, 160),
    port,
    bind: text(s.bind, 64) || "0.0.0.0",
    maxPlayers,
    mode,
    region: text(s.region, 8).toUpperCase(),
    master: { url: masterUrl, public: m.public !== false },
    resources: { start: [...new Set(start)] },
    world: { time, timeScale, weather, weatherCycle: Array.isArray(weatherCycle) ? weatherCycle : [], weatherMinutes },
    sync: { enabled: sy.enabled !== false, requireTicket: sy.require_ticket === true, tickRate, streamRadius, timeoutSeconds, characters: Array.isArray(characters) ? characters.map((c) => String(c).trim()) : [] },
    scripting: {
      dotnetHost: text(sc.dotnet_host, 1024),
      watch: sc.watch !== false,
      waitForDebugger: sc.wait_for_debugger === true,
      dev: sc.dev === true
    }
  };
}

function loadConfig(file) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Can't read ${file}. Run the server from its folder, or pass the path to server.toml.`);
  }
  let raw;
  try {
    raw = parse(source);
  } catch (err) {
    throw new Error(`server.toml isn't valid TOML: ${err.message}`, { cause: err });
  }
  return validateConfig(raw);
}

module.exports = { loadConfig, validateConfig, MODES };
