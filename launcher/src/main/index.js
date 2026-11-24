// ProjectVI launcher: main process entry.
// Owns the app lifecycle, the window and the tray. Feature code lives in the sibling modules.

const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("node:path");
const { ORIGIN, registerScheme, serveApp } = require("./protocol");
const { createSettingsStore } = require("./settings");
const { createLogger } = require("./logger");
const { registerIpc } = require("./ipc");

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const ASSETS_DIR = path.join(__dirname, "..", "assets");

registerScheme(); // must happen before "ready"

let win = null;
let tray = null;
let quitting = false;
let store;
let logger;

function getPaths() {
  const s = store.get();
  const data = app.getPath("userData");
  const localData = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "ProjectVI")
    : data;
  return {
    data,
    cache: s.cacheDir.trim() || path.join(localData, "cache"),
    mods: s.modsDir.trim() || path.join(data, "mods"),
    logs: app.getPath("logs")
  };
}

function devToolsAllowed() {
  return !app.isPackaged || store.get().developerMode;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray(enabled) {
  if (enabled && !tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS_DIR, "tray.png")));
    tray.setToolTip("ProjectVI");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open ProjectVI", click: showWindow },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on("click", showWindow);
  } else if (!enabled && tray) {
    tray.destroy();
    tray = null;
  }
}

function onSettingsChanged(prev, next) {
  if (prev.closeToTray !== next.closeToTray) ensureTray(next.closeToTray);
  if (prev.startWithWindows !== next.startWithWindows) {
    // From source this would register electron.exe itself, so only installed builds do it.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.startWithWindows });
    else logger.info("Start with Windows only applies to installed builds");
  }
  if (prev.developerMode && !next.developerMode && app.isPackaged) win?.webContents.closeDevTools();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    show: false,
    title: "ProjectVI",
    backgroundColor: "#08090C",
    icon: path.join(ASSETS_DIR, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadURL(`${ORIGIN}/index.html`);
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("window:state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("window:state", { maximized: false }));
  win.on("close", (event) => {
    if (!quitting && store.get().closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => { win = null; });

  // Links with target=_blank open in the user's browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12" && devToolsAllowed()) win.webContents.toggleDevTools();
  });
  win.webContents.on("render-process-gone", (_event, details) => logger.error("Renderer stopped", details));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    app.setAppLogsPath();
    logger = createLogger(app.getPath("logs"), { echo: !app.isPackaged });
    store = createSettingsStore(app.getPath("userData"));
    logger.info(`Launcher ${app.getVersion()} starting`);

    Menu.setApplicationMenu(null);
    serveApp(RENDERER_DIR);
    registerIpc({ store, logger, getWindow: () => win, getPaths, onSettingsChanged });
    createWindow();
    ensureTray(store.get().closeToTray);
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => app.quit());
  process.on("uncaughtException", (err) => logger?.error("Uncaught exception", err));
}
