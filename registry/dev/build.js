// Builds the local dev registry: zips every folder in dev/mods and writes dev/index.json
// pointing at dev/serve.js. Point the launcher at http://localhost:30190/index.json
// with developer mode on to test mod installs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createZip } = require("@projectvi/zip");

const PORT = Number(process.env.PORT) || 30190;
const modsDir = path.join(__dirname, "mods");
const distDir = path.join(__dirname, "dist");

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const mods = [];
for (const id of fs.readdirSync(modsDir)) {
  const dir = path.join(modsDir, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "mod.json"), "utf8"));
  const zip = createZip(listFiles(dir).map((rel) => ({ name: rel, data: fs.readFileSync(path.join(dir, ...rel.split("/"))) })));
  const fileName = `${meta.id}-${meta.version}.zip`;
  fs.writeFileSync(path.join(distDir, fileName), zip);
  mods.push({
    id: meta.id,
    name: meta.name,
    author: meta.author,
    description: meta.description,
    license: meta.license,
    tags: meta.tags,
    versions: [{
      version: meta.version,
      url: `http://localhost:${PORT}/dist/${fileName}`,
      sha256: crypto.createHash("sha256").update(zip).digest("hex"),
      size: zip.length,
      released: new Date().toISOString().slice(0, 10)
    }]
  });
}

fs.writeFileSync(path.join(__dirname, "index.json"), JSON.stringify({ version: 1, mods }, null, 2));
console.log(`Built ${mods.length} dev mods into registry/dev/dist.`);
