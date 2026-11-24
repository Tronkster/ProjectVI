// Public mods: reading the registry, installing, updating, enabling and removing mods.
//
// Installed mods live in <mods>/<id>/<version>/. The list of installs is <data>/mods.json,
// and <data>/mods-enabled.json is what the ProjectVI client reads (in load order).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { validateRegistry, validateModJson, compareVersions, MOD_ID } = require("@projectvi/shared");
const { extractZip, readModJson } = require("@projectvi/zip");
const { fetchJson, downloadToFile } = require("./http");

// Returns an error message, or null if the launcher may read from this registry address.
function checkRegistryUrl(raw, developerMode) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "The mod registry address isn't a valid URL.";
  }
  if (url.protocol === "https:") return null;
  if ((url.protocol === "http:" || url.protocol === "file:") && developerMode) return null;
  return "The mod registry must use https://. Turn on developer mode to use http:// or local files.";
}

async function loadRegistry(registryUrl, developerMode) {
  const address = String(registryUrl || "").trim();
  if (!address) return { ok: true, configured: false, mods: [], skipped: 0 };
  const urlError = checkRegistryUrl(address, developerMode);
  if (urlError) return { ok: false, configured: true, error: urlError, mods: [], skipped: 0 };

  let raw;
  try {
    raw = address.startsWith("file:")
      ? JSON.parse(await fs.promises.readFile(fileURLToPath(address), "utf8"))
      : await fetchJson(address, { timeoutMs: 8000, maxBytes: 10 * 1024 * 1024 });
  } catch {
    return { ok: false, configured: true, error: "Can't reach the mod registry.", mods: [], skipped: 0 };
  }
  const [registry, error] = validateRegistry(raw, { allowInsecure: developerMode });
  if (error) return { ok: false, configured: true, error, mods: [], skipped: 0 };
  return { ok: true, configured: true, mods: registry.mods, skipped: registry.skipped.length };
}

function createModManager({ getPaths, getSettings, logger, onProgress }) {
  let registry = { ok: true, configured: false, mods: [], skipped: 0 };
  let busy = false;

  const stateFile = () => path.join(getPaths().data, "mods.json");
  const enabledFile = () => path.join(getPaths().data, "mods-enabled.json");

  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
      const installed = raw.installed && typeof raw.installed === "object" ? raw.installed : {};
      const order = Array.isArray(raw.order) ? raw.order.filter((id) => installed[id]) : [];
      return { installed, order };
    } catch {
      return { installed: {}, order: [] };
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
    const enabled = state.order
      .map((id) => state.installed[id])
      .filter((m) => m.enabled)
      .map(({ id, version, dir }) => ({ id, version, dir }));
    fs.writeFileSync(enabledFile(), JSON.stringify({ mods: enabled }, null, 2));
  }

  function view(state) {
    const byId = new Map(registry.mods.map((m) => [m.id, m]));
    const installed = state.order.map((id) => {
      const m = state.installed[id];
      const latest = byId.get(id)?.versions[0]?.version ?? null;
      return { ...m, latest, updateAvailable: Boolean(latest && compareVersions(latest, m.version) > 0) };
    });
    return {
      registry: { ok: registry.ok, configured: registry.configured, error: registry.error ?? "", skipped: registry.skipped },
      mods: registry.mods.map((m) => ({ ...m, installedVersion: state.installed[m.id]?.version ?? null })),
      installed
    };
  }

  async function install(id, version) {
    const mod = registry.mods.find((m) => m.id === id);
    if (!mod) throw new Error("That mod isn't in the registry anymore. Refresh and try again.");
    const entry = version ? mod.versions.find((v) => v.version === version) : mod.versions[0];
    if (!entry) throw new Error("That version isn't in the registry.");

    const { cache, mods: modsDir } = getPaths();
    const zipFile = path.join(cache, "mod-downloads", `${entry.sha256}.zip`);
    await downloadToFile(entry.url, zipFile, {
      size: entry.size,
      sha256: entry.sha256,
      onBytes: (() => {
        let done = 0;
        return (n) => {
          done += n;
          onProgress({ id, doneBytes: done, totalBytes: entry.size });
        };
      })()
    });

    try {
      const [meta, metaError] = validateModJson(await readModJson(zipFile));
      if (metaError) throw new Error(metaError);
      if (meta.id !== mod.id || meta.version !== entry.version) throw new Error("The mod file doesn't match its registry entry.");

      const finalDir = path.join(modsDir, id, entry.version);
      const tmpDir = `${finalDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
      await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
      await extractZip(zipFile, tmpDir);
      await fs.promises.rm(finalDir, { recursive: true, force: true });
      await fs.promises.rename(tmpDir, finalDir);

      // An update replaces the old version.
      for (const other of await fs.promises.readdir(path.dirname(finalDir))) {
        if (other !== entry.version) await fs.promises.rm(path.join(path.dirname(finalDir), other), { recursive: true, force: true });
      }

      const state = readState();
      const previous = state.installed[id];
      state.installed[id] = {
        id,
        name: mod.name,
        author: mod.author,
        license: mod.license,
        version: entry.version,
        dir: finalDir,
        enabled: previous ? previous.enabled : true,
        installedAt: new Date().toISOString()
      };
      if (!state.order.includes(id)) state.order.push(id);
      writeState(state);
      logger.info(previous ? "Mod updated" : "Mod installed", { id, version: entry.version });
    } finally {
      await fs.promises.rm(zipFile, { force: true });
    }
  }

  return {
    async list() {
      const s = getSettings();
      registry = await loadRegistry(s.registryUrl, s.developerMode);
      if (!registry.ok) logger.warn("Mod registry unavailable", { error: registry.error });
      return view(readState());
    },

    async install(id, version) {
      if (busy) return { ok: false, error: "Another mod is still installing." };
      if (typeof id !== "string" || !MOD_ID.test(id)) return { ok: false, error: "Unknown mod." };
      busy = true;
      try {
        await install(id, typeof version === "string" ? version : undefined);
        return { ok: true, ...view(readState()) };
      } catch (err) {
        logger.warn("Mod install failed", { id, error: err.message });
        return { ok: false, error: err.message };
      } finally {
        busy = false;
      }
    },

    async uninstall(id) {
      const state = readState();
      const mod = state.installed[id];
      if (!mod) return { ok: false, error: "That mod isn't installed." };
      // The folder holding every version of this mod, wherever the mods folder was at install time.
      const modRoot = path.dirname(mod.dir);
      if (path.basename(modRoot) === id) await fs.promises.rm(modRoot, { recursive: true, force: true });
      delete state.installed[id];
      state.order = state.order.filter((x) => x !== id);
      writeState(state);
      logger.info("Mod removed", { id });
      return { ok: true, ...view(state) };
    },

    setEnabled(id, enabled) {
      const state = readState();
      if (!state.installed[id]) return { ok: false, error: "That mod isn't installed." };
      state.installed[id].enabled = Boolean(enabled);
      writeState(state);
      return { ok: true, ...view(state) };
    },

    dirOf(id) {
      return readState().installed[id]?.dir ?? null;
    },

    // For PROJECTVI_MODS. Empty when nothing has been installed yet.
    enabledListFile() {
      return fs.existsSync(enabledFile()) ? enabledFile() : "";
    }
  };
}

module.exports = { checkRegistryUrl, loadRegistry, createModManager };
