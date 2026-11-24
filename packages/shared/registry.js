// The public mod registry format (registry/schema.json describes the same thing for mod authors).
// The registry's CI and the launcher both validate with this file.

const { isSha256 } = require("./manifest");

const MOD_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const TAG = /^[a-z0-9-]{1,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPDX = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;
const MAX_MOD_BYTES = 1024 ** 3;
const MAX_VERSIONS = 50;

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return diff;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1; // 1.0.0 is newer than 1.0.0-beta
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

function isAllowedUrl(value, allowInsecure) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return allowInsecure && (url.protocol === "http:" || url.protocol === "file:");
}

// Returns [mod, null] or [null, reason].
function validateMod(raw, { allowInsecure = false } = {}) {
  if (!raw || typeof raw !== "object") return [null, "not an object"];
  if (!MOD_ID.test(raw.id ?? "")) return [null, "id must be 2-64 lowercase letters, digits or dashes"];
  if (!str(raw.name, 64)) return [null, "name is required (up to 64 characters)"];
  if (!str(raw.author, 64)) return [null, "author is required (up to 64 characters)"];
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 300)) {
    return [null, "description must be up to 300 characters"];
  }
  if (!str(raw.license, 64) || !SPDX.test(raw.license)) return [null, "license must be an SPDX id like MIT or GPL-3.0-only"];
  if (raw.homepage !== undefined && !isAllowedUrl(raw.homepage, false)) return [null, "homepage must be an https:// link"];
  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 8 || !tags.every((t) => TAG.test(t))) return [null, "tags must be up to 8 short lowercase words"];
  if (!Array.isArray(raw.versions) || raw.versions.length === 0 || raw.versions.length > MAX_VERSIONS) {
    return [null, `versions must list 1-${MAX_VERSIONS} versions`];
  }

  const seen = new Set();
  const versions = [];
  for (const v of raw.versions) {
    if (!v || !SEMVER.test(v.version ?? "") || seen.has(v.version)) return [null, "each version needs a unique semver like 1.2.0"];
    if (!isAllowedUrl(v.url, allowInsecure)) return [null, `version ${v.version}: url must be an https:// link`];
    if (!isSha256(v.sha256)) return [null, `version ${v.version}: sha256 must be 64 lowercase hex characters`];
    if (!Number.isInteger(v.size) || v.size < 1 || v.size > MAX_MOD_BYTES) return [null, `version ${v.version}: size must be 1 byte to 1 GB`];
    if (v.released !== undefined && !DATE.test(v.released)) return [null, `version ${v.version}: released must look like 2026-11-24`];
    seen.add(v.version);
    versions.push({ version: v.version, url: v.url, sha256: v.sha256, size: v.size, released: v.released ?? "" });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version)); // newest first

  return [{
    id: raw.id,
    name: raw.name.trim(),
    author: raw.author.trim(),
    description: (raw.description ?? "").trim(),
    license: raw.license,
    homepage: raw.homepage ?? "",
    tags,
    versions
  }, null];
}

// Returns [{ mods, skipped }, null] or [null, message]. Broken entries are skipped, not fatal,
// so one bad mod can't take the whole list down in the launcher. The registry CI fails on any skip.
function validateRegistry(raw, options = {}) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.mods)) {
    return [null, "The mod registry isn't in a format this launcher understands."];
  }
  const mods = [];
  const skipped = [];
  const ids = new Set();
  for (const entry of raw.mods) {
    const [mod, reason] = validateMod(entry, options);
    const id = typeof entry?.id === "string" ? entry.id : "(no id)";
    if (reason) skipped.push({ id, reason });
    else if (ids.has(mod.id)) skipped.push({ id, reason: "duplicate id" });
    else {
      ids.add(mod.id);
      mods.push(mod);
    }
  }
  return [{ mods, skipped }, null];
}

// mod.json at the root of every mod zip.
function validateModJson(raw) {
  if (!raw || typeof raw !== "object") return [null, "mod.json isn't a JSON object."];
  if (!MOD_ID.test(raw.id ?? "")) return [null, "mod.json has an invalid id."];
  if (!SEMVER.test(raw.version ?? "")) return [null, "mod.json has an invalid version."];
  if (!str(raw.name, 64)) return [null, "mod.json needs a name."];
  return [{ id: raw.id, version: raw.version, name: raw.name.trim() }, null];
}

module.exports = { MOD_ID, MAX_MOD_BYTES, compareVersions, validateMod, validateRegistry, validateModJson };
