// The overlay: a transparent, always-on-top window over the game that shows chat, notices, the player list and
// client scripts' UI pages. It sits over the game's screen rather than inside the game, so it needs nothing from
// the game itself. Messages come from the ProjectVI client over its IPC channel (client/src/overlay-link.js).
//
// Keys (global while the overlay is up): F6 opens chat; Esc or Enter closes it. F7 shows or hides the player list.
// The overlay ignores the mouse and never takes focus, except while the chat box is open.
//
// Window creation is passed in, so the message handling can be tested without Electron.

const MAX_TEXT = 500;
const KEYS = { chat: "F6", players: "F7" };

const str = (v, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

class Overlay {
  // createWindow(): an overlay BrowserWindow-like object (see createOverlayWindow below).
  // shortcuts: { register(key, fn), unregister(key) }. ui: createUiContent().
  constructor({ createWindow, shortcuts, ui, logger }) {
    this.createWindow = createWindow;
    this.shortcuts = shortcuts;
    this.ui = ui;
    this.logger = logger;
    this.window = null;
    this.client = null; // the client's child process
    this.chatOpen = false;
  }

  // Connects a started client process (with an IPC channel).
  attach(child) {
    this.detach();
    this.client = child;
    child.on("message", (message) => this.fromClient(message));
    child.once("exit", () => {
      if (this.client === child) this.close("The client exited.");
    });
  }

  detach() {
    if (this.client) this.client.removeAllListeners("message");
    this.client = null;
  }

  toClient(message) {
    if (this.client?.connected) this.client.send(message);
  }

  // Everything the client sends, checked before it reaches the overlay page.
  fromClient(message) {
    if (!message || typeof message !== "object" || typeof message.t !== "string") return;
    switch (message.t) {
      case "session":
        this.open();
        this.show("session", { server: str(message.server, 300), player: { id: Number(message.player?.id) || 0, name: str(message.player?.name, 64) } });
        break;
      case "package":
        this.ui.setPackage(str(message.key, 100), str(message.name, 100), message.files);
        break;
      case "ui.open": {
        const url = this.ui.urlFor(str(message.key, 100), str(message.path, 300));
        if (url) this.show("ui.open", { id: str(message.id, 120), url });
        else this.logger?.warn("A client script tried to open a page that isn't in its package", { path: str(message.path, 300) });
        break;
      }
      case "ui.send":
        this.show("ui.send", { id: str(message.id, 120), name: str(message.name, 100), data: message.data ?? null });
        break;
      case "ui.show":
        this.show("ui.show", { id: str(message.id, 120), visible: message.visible === true });
        break;
      case "chat":
        this.show("chat", { name: str(message.name, 64), text: str(message.text) });
        break;
      case "notice":
        this.show("notice", { text: str(message.text) });
        break;
      case "players":
        if (Array.isArray(message.players)) {
          const players = message.players.slice(0, 1024).map((p) => ({ id: Number(p?.id) || 0, name: str(p?.name, 64), host: p?.host === true, me: p?.me === true }));
          this.show("players", { players });
        }
        break;
      case "end":
        this.close(str(message.reason));
        break;
    }
  }

  open() {
    if (this.window) return;
    this.window = this.createWindow();
    this.window.onClosed(() => {
      this.window = null;
    });
    this.shortcuts.register(KEYS.chat, () => this.setChatOpen(true));
    this.shortcuts.register(KEYS.players, () => this.show("players.toggle", {}));
  }

  show(type, payload) {
    this.window?.send({ type, ...payload });
  }

  // While the chat box is open, the overlay takes the mouse and keyboard; otherwise it lets everything through.
  setChatOpen(open) {
    if (!this.window || this.chatOpen === open) return;
    this.chatOpen = open;
    this.window.setInteractive(open);
    this.show(open ? "chat.open" : "chat.close", {});
  }

  // From the overlay page.
  fromPage(type, payload) {
    if (type === "chat.send") {
      const text = str(payload?.text).trim();
      if (text) this.toClient({ t: "chat.send", text });
      this.setChatOpen(false);
    } else if (type === "chat.close") {
      this.setChatOpen(false);
    } else if (type === "ui.message") {
      this.toClient({ t: "ui.message", id: str(payload?.id, 120), name: str(payload?.name, 100), data: payload?.data ?? null });
    }
  }

  close(reason) {
    if (reason) this.logger?.info("Overlay closed", { reason });
    this.shortcuts.unregister(KEYS.chat);
    this.shortcuts.unregister(KEYS.players);
    this.chatOpen = false;
    this.window?.close();
    this.window = null;
    this.ui.clear();
    this.detach();
  }
}

// The real window. Electron is required here only.
function createOverlayWindow({ preload, url, onPage }) {
  const { BrowserWindow, screen } = require("electron");
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // Only the overlay page itself, never the mod pages framed inside it.
  win.webContents.ipc.on("overlay:page", (event, type, payload) => {
    if (event.senderFrame === win.webContents.mainFrame) onPage(String(type), payload);
  });
  const ready = win.loadURL(url).then(() => win.showInactive());
  let queue = [];
  ready.then(() => {
    for (const m of queue) win.webContents.send("overlay:event", m);
    queue = null;
  });
  return {
    send(message) {
      if (win.isDestroyed()) return;
      if (queue) queue.push(message);
      else win.webContents.send("overlay:event", message);
    },
    setInteractive(on) {
      if (win.isDestroyed()) return;
      win.setFocusable(on);
      win.setIgnoreMouseEvents(!on, { forward: true });
      if (on) win.focus();
      else win.blur();
    },
    onClosed(fn) {
      win.once("closed", fn);
    },
    close() {
      if (!win.isDestroyed()) win.close();
    }
  };
}

module.exports = { Overlay, createOverlayWindow, KEYS };
