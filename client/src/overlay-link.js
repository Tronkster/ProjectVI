// The link to the overlay the launcher shows over the game (chat, notices, the player list, script UI pages).
// The launcher starts the client with an IPC channel (child_process.fork); without one (run by hand), there's no
// overlay, and the client says so once.
//
// Client -> launcher:
//   { t: "session", server, player }                 joined
//   { t: "package", key, name, files: { path: file } }  files a package's UI pages may load (whitelist)
//   { t: "ui.open", id, key, path }  { t: "ui.send", id, name, data }  { t: "ui.show", id, visible }
//   { t: "chat", name, text }  { t: "notice", text }  { t: "players", players: [{ id, name, host }] }
//   { t: "status", text }  { t: "end", reason }
// Launcher -> client:
//   { t: "ui.message", id, name, data }   a UI page called projectvi.send(name, data)
//   { t: "chat.send", text }              the player typed in the overlay's chat box

const { EventEmitter } = require("node:events");

const MAX_MESSAGE_BYTES = 256 * 1024;

class OverlayLink extends EventEmitter {
  constructor({ channel = process } = {}) {
    super();
    this.channel = typeof channel?.send === "function" && channel.connected !== false ? channel : null;
    if (this.channel) {
      this.channel.on("message", (message) => {
        if (message && typeof message === "object" && typeof message.t === "string") this.emit(message.t, message);
      });
      this.channel.on("disconnect", () => {
        this.channel = null;
        this.emit("gone");
      });
    }
  }

  get available() {
    return this.channel !== null;
  }

  post(message) {
    if (!this.channel) return false;
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(message));
    } catch {
      return false;
    }
    if (size > MAX_MESSAGE_BYTES) return false;
    try {
      this.channel.send(message);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { OverlayLink };
