// Bridge between the sandboxed renderer and the main process.
// Everything the UI can do is listed here; nothing else from Node or Electron is exposed.

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("launcher", {
  settings: {
    get: invoke("settings:get"),
    update: invoke("settings:update"),
    reset: invoke("settings:reset"),
    checkSetup: invoke("settings:checkSetup")
  },
  profile: {
    validateName: invoke("profile:validateName"),
    suggestName: invoke("profile:suggestName")
  },
  auth: {
    status: invoke("auth:status"),
    login: invoke("auth:login"),
    cancel: invoke("auth:cancel"),
    logout: invoke("auth:logout")
  },
  friends: {
    list: invoke("friends:list"),
    start: invoke("friends:start"),
    add: invoke("friends:add"),
    accept: invoke("friends:accept"),
    dropRequest: invoke("friends:dropRequest"),
    remove: invoke("friends:remove"),
    resetCode: invoke("friends:resetCode")
  },
  servers: {
    list: invoke("servers:list"),
    ping: invoke("servers:ping")
  },
  game: {
    launch: invoke("game:launch")
  },
  join: {
    prepare: invoke("join:prepare"),
    download: invoke("join:download"),
    cancel: invoke("join:cancel"),
    launch: invoke("join:launch"),
    onProgress: (callback) => ipcRenderer.on("join:progress", (_event, progress) => callback(progress))
  },
  mods: {
    list: invoke("mods:list"),
    install: invoke("mods:install"),
    uninstall: invoke("mods:uninstall"),
    setEnabled: invoke("mods:setEnabled"),
    openFolder: invoke("mods:openFolder"),
    onProgress: (callback) => ipcRenderer.on("mods:progress", (_event, progress) => callback(progress))
  },
  updates: {
    status: invoke("updates:status"),
    check: invoke("updates:check"),
    install: invoke("updates:install"),
    onStatus: (callback) => ipcRenderer.on("updates:status", (_event, status) => callback(status))
  },
  system: {
    info: invoke("system:info"),
    pickPath: invoke("dialog:pick"),
    openFolder: invoke("system:openFolder"),
    cacheSize: invoke("system:cacheSize"),
    clearCache: invoke("system:clearCache"),
    copyDiagnostics: invoke("system:copyDiagnostics")
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    onState: (callback) => ipcRenderer.on("window:state", (_event, state) => callback(state))
  }
});
