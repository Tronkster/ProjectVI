// What the launcher tells the client, in environment variables (docs/protocol.md, "Launcher side").

const { validatePlayerName } = require("@projectvi/shared");

const TICKET = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Returns { ok: true, settings } or { ok: false, error }.
function readSettings(env = process.env) {
  const server = String(env.PROJECTVI_SERVER || "").trim();
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(server);
  if (!match) return { ok: false, error: "PROJECTVI_SERVER isn't a server address like 1.2.3.4:30120. Join from the ProjectVI launcher." };
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return { ok: false, error: "PROJECTVI_SERVER has a port outside 1-65535." };

  const name = validatePlayerName(env.PROJECTVI_PLAYER);
  if (!name.ok) return { ok: false, error: `PROJECTVI_PLAYER: ${name.error}` };

  const bridgeFile = String(env.PROJECTVI_BRIDGE_FILE || "").trim();
  if (!bridgeFile) return { ok: false, error: "PROJECTVI_BRIDGE_FILE isn't set, so there's no way to reach the emulator." };

  const ticket = String(env.PROJECTVI_TICKET || "");
  return {
    ok: true,
    settings: {
      host: match[1].replace(/^\[|\]$/g, ""),
      port,
      name: name.name,
      ticket: TICKET.test(ticket) ? ticket : "",
      masterUrl: String(env.PROJECTVI_MASTER || ""),
      contentFile: String(env.PROJECTVI_CONTENT || ""),
      modsFile: String(env.PROJECTVI_MODS || ""),
      bridgeFile,
      logFile: String(env.PROJECTVI_CLIENT_LOG || "")
    }
  };
}

module.exports = { readSettings };
