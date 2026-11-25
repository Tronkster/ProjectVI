// HTTP routes on the game port. Players' launchers use these before joining (docs/protocol.md).

const fs = require("node:fs");
const http = require("node:http");
const { PROTOCOL_VERSION, SYNC_VERSION } = require("@projectvi/shared");

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function createGameServer({ config, content, getPlayers = () => 0 }) {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/projectvi/info") {
      return sendJson(res, 200, {
        name: config.name,
        protocol: PROTOCOL_VERSION,
        contentBytes: content.totalBytes,
        fileCount: content.fileCount,
        players: getPlayers(),
        maxPlayers: config.maxPlayers,
        ...(config.sync?.enabled ? { sync: { version: SYNC_VERSION, port: config.port, tickRate: config.sync.tickRate } } : {})
      });
    }

    if (pathname === "/projectvi/manifest") return sendJson(res, 200, content.manifest);

    const match = /^\/projectvi\/files\/([a-f0-9]{64})$/.exec(pathname);
    if (match) {
      const file = content.files.get(match[1]);
      if (!file) return sendJson(res, 404, { error: "Unknown file." });
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return sendJson(res, 410, { error: "That file was removed. Restart the server to rebuild the content list." });
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": size,
        // Files are addressed by their hash, so they never change.
        "Cache-Control": "public, max-age=31536000, immutable"
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  });
}

module.exports = { createGameServer };
