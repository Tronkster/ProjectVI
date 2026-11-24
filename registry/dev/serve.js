// Serves the dev registry built by dev/build.js on http://localhost:30190.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 30190;
const indexFile = path.join(__dirname, "index.json");
const distDir = path.join(__dirname, "dist");

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/index.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return fs.createReadStream(indexFile).pipe(res);
  }
  const match = /^\/dist\/([a-z0-9.-]+\.zip)$/.exec(pathname);
  const file = match && path.join(distDir, match[1]);
  if (file && fs.existsSync(file)) {
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log(`Dev mod registry on http://localhost:${PORT}/index.json`);
  console.log("In the launcher: turn on developer mode, then set Settings → Mods → Registry to that address.");
});
