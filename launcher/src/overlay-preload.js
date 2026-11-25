// Bridge for the overlay page (renderer/overlay.html). It can receive overlay events and send three things back:
// a chat line, closing the chat box, and a message from a script's UI page. Nothing else.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onEvent(fn) {
    ipcRenderer.on("overlay:event", (_event, message) => fn(message));
  },
  sendChat(text) {
    ipcRenderer.send("overlay:page", "chat.send", { text: String(text) });
  },
  closeChat() {
    ipcRenderer.send("overlay:page", "chat.close", {});
  },
  uiMessage(id, name, data) {
    ipcRenderer.send("overlay:page", "ui.message", { id: String(id), name: String(name), data });
  }
});
