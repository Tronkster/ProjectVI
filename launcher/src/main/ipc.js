// Every call the renderer can make. Each handler checks that the call comes from the launcher's
// own page and validates its arguments; the renderer is never trusted with paths or tokens.

const { app, clipboard, dialog, ipcMain, safeStorage, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validatePlayerName, suggestPlayerName, REPO_CONFIGURED, REPO_URL } = require("@projectvi/shared");
const { createAuth, createTokenStore } = require("./auth");
const { ORIGIN } = require("./protocol");
const { fetchServers, pingServers, parseMasterUrl } = require("./servers");
const { launchGame } = require("./launch");
const { dirSize, isFile, exists } = require("./files");
const { createJoinManager } = require("./content");
const { createModManager } = require("./mods");
const { createUpdater } = require("./updater");

const FOLDERS = ["data", "cache", "mods", "logs"];

function fromLauncher(event) {
  const url = event.senderFrame?.url || "";
  return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
}

function systemName() {
  const type = os.type() === "Windows_NT" ? "Windows" : os.type() === "Darwin" ? "macOS" : os.type();
  return `${type} ${os.release()} ${os.arch()}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function registerIpc(ctx) {
  const { store, logger, getWindow, getPaths, onSettingsChanged } = ctx;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromLauncher(event)) throw new Error("Blocked call from an unknown page.");
      return fn(...args);
    });
  };
  const on = (channel, fn) => {
    ipcMain.on(channel, (event, ...args) => {
      if (fromLauncher(event)) fn(...args);
    });
  };

  // ---- Updates ----
  const updater = createUpdater({
    isPackaged: app.isPackaged,
    getSettings: () => store.get(),
    logger,
    send: (status) => getWindow()?.webContents.send("updates:status", status)
  });
  handle("updates:status", () => updater.status());
  handle("updates:check", () => updater.check());
  handle("updates:install", () => updater.install());

  // ---- Settings ----
  handle("settings:get", () => store.get());
  handle("settings:update", (patch) => {
    const prev = store.get();
    const next = store.update(patch);
    onSettingsChanged(prev, next);
    updater.applySettings(next);
    const favoritesChanged = prev.favorites.join("\n") !== next.favorites.join("\n");
    if (favoritesChanged && next.syncFavorites && auth.isLoggedIn()) {
      auth.putFavorites(next.favorites).catch((err) => logger.warn("Favorites sync failed", { error: err.message }));
    }
    return next;
  });
  handle("settings:reset", () => {
    const prev = store.get();
    const next = store.reset();
    onSettingsChanged(prev, next);
    updater.applySettings(next);
    logger.info("Settings reset to defaults");
    return next;
  });
  handle("settings:checkSetup", () => {
    const s = store.get();
    const name = validatePlayerName(s.playerName);
    const emulatorSet = Boolean(s.emulatorPath.trim());
    const gameSet = Boolean(s.gamePath.trim());
    return {
      name: name.ok
        ? { ok: true, message: `Playing as ${name.name}.` }
        : { ok: false, message: s.playerName.trim() ? `In-game name: ${name.error}` : "No in-game name set." },
      emulator: !emulatorSet
        ? { ok: false, message: "No emulator chosen." }
        : isFile(s.emulatorPath.trim())
          ? { ok: true, message: "Emulator found." }
          : { ok: false, message: "The emulator file wasn't found." },
      game: !gameSet
        ? { ok: false, message: "No game chosen." }
        : exists(s.gamePath.trim())
          ? { ok: true, message: "Game found." }
          : { ok: false, message: "The game file or folder wasn't found." }
    };
  });

  // ---- Profile ----
  handle("profile:validateName", (name) => validatePlayerName(name));
  handle("profile:suggestName", (name) => suggestPlayerName(name));

  // ---- Optional login and favorites sync ----
  const auth = createAuth({
    getSettings: () => store.get(),
    tokenStore: createTokenStore(path.join(app.getPath("userData"), "session.bin"), safeStorage, logger),
    guestStore: createTokenStore(path.join(app.getPath("userData"), "guest.bin"), safeStorage, logger),
    openExternal: (url) => shell.openExternal(url),
    logger
  });

  // Favorites are the union of this PC's and the account's, so logging in never loses any.
  async function syncFavorites() {
    if (!auth.isLoggedIn() || !store.get().syncFavorites) return;
    try {
      const remote = await auth.getFavorites();
      if (!remote) return;
      const merged = [...new Set([...store.get().favorites, ...remote])];
      const prev = store.get();
      const next = store.update({ favorites: merged });
      onSettingsChanged(prev, next);
      if (merged.length !== remote.length) await auth.putFavorites(next.favorites);
    } catch (err) {
      logger.warn("Favorites sync failed", { error: err.message });
    }
  }

  handle("auth:status", async () => {
    const status = await auth.status();
    if (status.user) await syncFavorites();
    return { ...status, settings: store.get() };
  });
  handle("auth:login", async () => {
    const result = await auth.login();
    if (!result.ok) return result;
    // First login on this PC: start from the account's display name if no name is set yet.
    if (!validatePlayerName(store.get().playerName).ok) {
      const suggested = suggestPlayerName(result.user.name);
      if (suggested) store.update({ playerName: suggested });
    }
    await syncFavorites();
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return { ...result, settings: store.get() };
  });
  handle("auth:cancel", () => auth.cancelLogin());
  handle("auth:logout", () => auth.logout());

  // ---- Friends ----
  // Presence: while the launcher is open and the player has a friends account, tell the master
  // server every minute that we're online, and which server we joined while the emulator runs.
  let playingOn = "";
  async function reportPresence() {
    if (!auth.hasFriendsAccount()) return;
    const name = validatePlayerName(store.get().playerName);
    const r = await auth.reportPresence(name.ok ? name.name : "", playingOn);
    if (!r.ok && !r.offline) logger.warn("Presence update failed", { error: r.error });
  }
  setInterval(reportPresence, 60_000).unref();
  reportPresence();

  const FRIEND_ID = /^\d{1,15}$/;
  const byId = (fn) => (id) => (typeof id === "string" && FRIEND_ID.test(id) ? fn(id) : { ok: false, error: "Unknown player." });
  handle("friends:list", async () => ({ ...(await auth.friends()), hasAccount: auth.hasFriendsAccount() }));
  handle("friends:start", async () => {
    const name = validatePlayerName(store.get().playerName);
    if (!name.ok) return { ok: false, needsName: true, error: "Set an in-game name first. Friends see it." };
    const r = await auth.startGuest(name.name);
    if (r.ok) await reportPresence();
    return r;
  });
  handle("friends:add", (code) => (typeof code === "string" && code.length <= 20
    ? auth.addFriend(code)
    : { ok: false, error: "Friend codes look like K7QP-2M9X." }));
  handle("friends:accept", byId((id) => auth.acceptFriend(id)));
  handle("friends:dropRequest", byId((id) => auth.dropRequest(id)));
  handle("friends:remove", byId((id) => auth.removeFriend(id)));
  handle("friends:resetCode", () => auth.resetFriendCode());

  // ---- Servers ----
  // The last list from the master server. Joins look servers up here, so the renderer
  // can only ever pick a server by id and never supply its own host or port.
  const knownServers = new Map();
  handle("servers:list", async () => {
    const result = await fetchServers(store.get().masterUrl);
    if (result.ok) {
      knownServers.clear();
      for (const s of result.servers) knownServers.set(s.id, s);
    }
    return result;
  });
  handle("servers:ping", (targets) => pingServers(targets));

  // ---- Public mods ----
  const mods = createModManager({
    getPaths,
    getSettings: () => store.get(),
    logger,
    onProgress: (progress) => getWindow()?.webContents.send("mods:progress", progress)
  });
  handle("mods:list", () => mods.list());
  handle("mods:install", (id, version) => mods.install(id, version));
  handle("mods:uninstall", (id) => mods.uninstall(id));
  handle("mods:setEnabled", (id, enabled) => mods.setEnabled(id, enabled));
  handle("mods:openFolder", async (id) => {
    const dir = mods.dirOf(id);
    if (!dir) return { ok: false };
    const error = await shell.openPath(dir);
    return { ok: !error };
  });

  // ---- Joining: content check, download, launch ----
  const join = createJoinManager({
    getPaths,
    getSettings: () => store.get(),
    getServer: (id) => (typeof id === "string" ? knownServers.get(id) : undefined),
    logger,
    onProgress: (progress) => getWindow()?.webContents.send("join:progress", progress)
  });
  handle("join:prepare", (serverId) => join.prepare(serverId));
  handle("join:download", (serverId) => join.download(serverId));
  handle("join:cancel", () => join.cancel());
  handle("join:launch", async (serverId) => {
    const contentFile = join.clientManifestFor(serverId);
    const result = await launchGame(store.get(), { serverId, contentFile, modsFile: mods.enabledListFile() }, () => {
      if (playingOn === serverId) {
        playingOn = "";
        reportPresence();
      }
    });
    if (result.ok) {
      logger.info("Emulator started for a server", { server: serverId });
      playingOn = serverId;
      reportPresence();
    }
    else logger.warn("Emulator didn't start", { error: result.error });
    return result;
  });
  handle("game:launch", async () => {
    const result = await launchGame(store.get(), { modsFile: mods.enabledListFile() });
    if (result.ok) logger.info("Emulator started from Settings");
    else logger.warn("Emulator didn't start", { error: result.error });
    return result;
  });

  // ---- Dialogs and folders ----
  handle("dialog:pick", async (kind) => {
    const options = {
      emulator: { title: "Choose your emulator", properties: ["openFile"], filters: process.platform === "win32" ? [{ name: "Programs", extensions: ["exe"] }] : [] },
      gameFile: { title: "Choose your game file", properties: ["openFile"] },
      gameFolder: { title: "Choose your game folder", properties: ["openDirectory"] },
      cacheDir: { title: "Choose a folder for downloaded server content", properties: ["openDirectory", "createDirectory"] },
      modsDir: { title: "Choose a folder for mods", properties: ["openDirectory", "createDirectory"] }
    }[kind];
    if (!options) return null;
    const result = await dialog.showOpenDialog(getWindow(), options);
    return result.canceled ? null : result.filePaths[0];
  });
  handle("system:openFolder", async (which) => {
    if (!FOLDERS.includes(which)) return { ok: false };
    const dir = getPaths()[which];
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return { ok: !error, error };
  });

  // ---- Storage ----
  handle("system:cacheSize", () => dirSize(getPaths().cache));
  handle("system:clearCache", async () => {
    await fs.promises.rm(getPaths().cache, { recursive: true, force: true });
    logger.info("Content cache cleared");
    return 0;
  });

  // ---- About and diagnostics ----
  handle("system:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: systemName(),
    packaged: app.isPackaged,
    repoConfigured: REPO_CONFIGURED,
    repoUrl: REPO_URL,
    paths: getPaths()
  }));
  handle("system:copyDiagnostics", async () => {
    const s = store.get();
    const [master] = parseMasterUrl(s.masterUrl);
    const text = [
      `ProjectVI launcher ${app.getVersion()}${app.isPackaged ? "" : " (from source)"}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      systemName(),
      `Developer mode: ${s.developerMode ? "on" : "off"}`,
      `Master server: ${master ? master.origin : "invalid address"}`,
      `Emulator chosen: ${s.emulatorPath.trim() ? (isFile(s.emulatorPath.trim()) ? "yes, found" : "yes, not found") : "no"}`,
      `Game chosen: ${s.gamePath.trim() ? (exists(s.gamePath.trim()) ? "yes, found" : "yes, not found") : "no"}`,
      `Player name valid: ${validatePlayerName(s.playerName).ok ? "yes" : "no"}`,
      `Content cache: ${formatBytes(await dirSize(getPaths().cache))}`,
      "",
      "Recent log:",
      logger.tail(40) || "(empty)"
    ].join("\n");
    clipboard.writeText(text);
    return { ok: true };
  });

  // ---- Window ----
  on("window:minimize", () => getWindow()?.minimize());
  on("window:toggle-maximize", () => {
    const win = getWindow();
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  on("window:close", () => getWindow()?.close());
}

module.exports = { registerIpc, formatBytes };
