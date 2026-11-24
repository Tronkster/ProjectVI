// Small file-system helpers shared by settings, content and mods.

const fs = require("node:fs");
const path = require("node:path");

// Total size in bytes of everything under dir. Missing folders count as 0.
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
  }
  return total;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function exists(p) {
  return Boolean(p) && fs.existsSync(p);
}

module.exports = { dirSize, isFile, exists };
