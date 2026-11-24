// Launcher settings: a typed schema plus a small JSON store.
// Only known keys with valid values are ever saved, whether they come from the settings file,
// the renderer or an older launcher version.

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_MASTER_URL, DEFAULT_REGISTRY_URL } = require("@projectvi/shared");

const SCHEMA_VERSION = 2;

const SCHEMA = {
  playerName: { type: "string", max: 24, default: "" },
  emulatorPath: { type: "string", max: 1024, default: "" },
  gamePath: { type: "string", max: 1024, default: "" },
  launchArgs: { type: "string", max: 1024, default: '"{game}"' },
  masterUrl: { type: "string", max: 512, default: DEFAULT_MASTER_URL },
  registryUrl: { type: "string", max: 512, default: DEFAULT_REGISTRY_URL },
  cacheDir: { type: "string", max: 1024, default: "" }, // "" means the default folder
  modsDir: { type: "string", max: 1024, default: "" },
  favorites: { type: "list", maxItems: 500, itemMax: 300, default: [] },
  trustedServers: { type: "list", maxItems: 500, itemMax: 300, default: [] }, // "don't ask again" for downloads
  askAboveMb: { type: "int", min: 0, max: 100_000, default: 500 },
  parallelDownloads: { type: "int", min: 1, max: 8, default: 4 },
  syncFavorites: { type: "bool", default: true },
  shareServerWithFriends: { type: "bool", default: true }, // off: friends see "Online", not the server
  startWithWindows: { type: "bool", default: false },
  closeToTray: { type: "bool", default: false },
  autoUpdate: { type: "bool", default: true },
  updateChannel: { type: "enum", values: ["stable", "beta"], default: "stable" },
  developerMode: { type: "bool", default: false },
  modsNoticeSeen: { type: "bool", default: false }
};

function defaults() {
  const out = {};
  for (const [key, rule] of Object.entries(SCHEMA)) out[key] = Array.isArray(rule.default) ? [...rule.default] : rule.default;
  return out;
}

// Returns the coerced value, or undefined if the value doesn't fit the rule.
function coerce(rule, value) {
  switch (rule.type) {
    case "string":
      return typeof value === "string" ? value.slice(0, rule.max) : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "int": {
      const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      return Number.isInteger(n) && n >= rule.min && n <= rule.max ? n : undefined;
    }
    case "enum":
      return rule.values.includes(value) ? value : undefined;
    case "list":
      return Array.isArray(value)
        ? [...new Set(value.filter((v) => typeof v === "string" && v.length > 0 && v.length <= rule.itemMax))].slice(0, rule.maxItems)
        : undefined;
    default:
      return undefined;
  }
}

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, rule] of Object.entries(SCHEMA)) {
    if (!(key in input)) continue;
    const value = coerce(rule, input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function createSettingsStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");

  let values = defaults();
  try {
    values = { ...values, ...sanitize(JSON.parse(fs.readFileSync(file, "utf8"))) };
  } catch {
    // Missing or unreadable file: start from defaults.
  }

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...values }, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    file,
    get: () => values,
    update(patch) {
      values = { ...values, ...sanitize(patch) };
      save();
      return values;
    },
    reset() {
      values = defaults();
      save();
      return values;
    }
  };
}

module.exports = { SCHEMA, SCHEMA_VERSION, defaults, sanitize, createSettingsStore };
