// Auto-update from GitHub Releases through electron-updater.
//
// Only active in installed builds, and only once REPO is set in packages/shared/project.js,
// so an unconfigured fork can never pull updates from someone else's repository.

const { REPO_CONFIGURED } = require("@projectvi/shared");

const CHECK_EVERY_MS = 6 * 60 * 60_000;

function createUpdater({ isPackaged, getSettings, logger, send }) {
  let status = { state: isPackaged && REPO_CONFIGURED ? "idle" : "unavailable", version: "", percent: 0, error: "" };
  const set = (patch) => {
    status = { ...status, ...patch };
    send(status);
  };

  if (status.state === "unavailable") {
    return { status: () => status, check: async () => status, install: () => {}, applySettings: () => {} };
  }

  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = {
    info: (m) => logger.info(`Updater: ${m}`),
    warn: (m) => logger.warn(`Updater: ${m}`),
    error: (m) => logger.error(`Updater: ${m}`),
    debug: () => {}
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = getSettings().updateChannel === "beta";

  autoUpdater.on("checking-for-update", () => set({ state: "checking", error: "" }));
  autoUpdater.on("update-not-available", () => set({ state: "current" }));
  autoUpdater.on("update-available", (info) => set({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => set({ state: "ready", version: info.version, percent: 100 }));
  autoUpdater.on("error", (err) => set({ state: "error", error: err.message }));

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: "error", error: err.message });
    }
    return status;
  };

  setTimeout(() => getSettings().autoUpdate && check(), 5000).unref?.();
  setInterval(() => getSettings().autoUpdate && check(), CHECK_EVERY_MS).unref?.();

  return {
    status: () => status,
    check,
    install: () => {
      if (status.state === "ready") autoUpdater.quitAndInstall();
    },
    applySettings(next) {
      autoUpdater.allowPrerelease = next.updateChannel === "beta";
    }
  };
}

module.exports = { createUpdater };
