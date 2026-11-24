// Capture plan for the Friends screens, against a throwaway master server seeded with players.
// Usage: $env:CAPTURE_STEPS = "scripts/capture-friends.js"; npm run capture -w launcher

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { createMasterServer } = require("projectvi-master-server");

const PORT = 30199;
const base = `http://localhost:${PORT}`;

async function call(token, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

async function guest(name) {
  const { token } = await call(null, "POST", "/auth/guest", { name });
  const { code } = await call(token, "GET", "/api/friends");
  return { token, code };
}

// Other players: two friends (one playing, one in the launcher), one asking, one asked.
async function seed(win) {
  const mine = await win.webContents.executeJavaScript('document.getElementById("friend-code").textContent');
  await call(null, "POST", "/api/heartbeat", { port: 30120, name: "Vice Nights RP", mode: "Roleplay", region: "EU", players: 41, maxPlayers: 64 });
  const [ana, ben, cy, dee, eli] = await Promise.all(["Ana_Ruiz", "BenTheWheelman", "cy.sato", "Dee", "Eli Marsh"].map(guest));
  for (const friend of [ana, ben, eli]) {
    await call(friend.token, "POST", "/api/friends/requests", { code: mine });
    await win.webContents.executeJavaScript(`launcher.friends.add(${JSON.stringify(friend.code)})`);
  }
  await call(ana.token, "PUT", "/api/presence", { name: "Ana_Ruiz", serverId: `127.0.0.1:30120` });
  await call(ben.token, "PUT", "/api/presence", { name: "BenTheWheelman" });
  await call(cy.token, "POST", "/api/friends/requests", { code: mine });
  await win.webContents.executeJavaScript(`launcher.friends.add(${JSON.stringify(dee.code)})`);
  // A short conversation with Ana, the last message unread.
  const kai = (await call(ana.token, "GET", "/api/friends")).friends.find((f) => f.name === "Kai");
  const anaId = (await win.webContents.executeJavaScript("launcher.friends.list()")).friends.find((f) => f.name === "Ana_Ruiz").id;
  await win.webContents.executeJavaScript(`launcher.friends.send(${JSON.stringify(anaId)}, "You on tonight?")`);
  await call(ana.token, "POST", `/api/friends/${kai.id}/messages`, { text: "Already in, we're doing the harbor heist. Join me!" });
}

module.exports = {
  setup() {
    createMasterServer().listen(PORT, "127.0.0.1");
    fs.writeFileSync(path.join(app.getPath("userData"), "settings.json"), JSON.stringify({ masterUrl: base, playerName: "Kai" }));
  },
  steps: [
    { name: "friends-01-off", run: 'document.querySelector("[data-view=friends]").click()', wait: 1200 },
    { name: "friends-02-empty", run: 'document.querySelector("[data-friends=start]").click()', wait: 1500 },
    { name: "friends-03-list", main: seed, run: 'document.querySelector("[data-view=friends]").click()', wait: 1500 },
    { name: "friends-04-add", run: 'document.querySelector("[data-friends=add]").click(); document.getElementById("dialog-code").value = "k7qp-2m9x"', wait: 600 },
    { name: "friends-05-chat", run: 'document.getElementById("dialog").close(); document.querySelector("[data-friends=chat]").click()', wait: 1200 },
    { name: "friends-06-remove", run: 'document.getElementById("dialog").close(); document.querySelector("[data-friends=remove]").click()', wait: 600 }
  ]
};
