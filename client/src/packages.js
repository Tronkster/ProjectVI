// What the client runs: the server's resources (their client files, from the content list the launcher wrote) and
// the player's enabled public mods, in that order. Each is a "package": a name and a whitelist of its files, so a
// script or UI page can only ever reach its own package's files.
//
// Scripts: every .lua file at a package's top level, in name order. Other .lua files can be loaded with require.

const fs = require("node:fs");
const path = require("node:path");
const { isSafeRelativePath, RESOURCE_NAME, MOD_ID } = require("@projectvi/shared");

const MAX_MOD_FILES = 20_000;

// Returns { packages, warnings }. packages: [{ kind: "resource" | "mod", name, key, files: Map(path -> file) }].
function loadPackages({ contentFile = "", modsFile = "" } = {}) {
  const packages = [];
  const warnings = [];

  if (contentFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(contentFile, "utf8"));
      for (const r of manifest.resources ?? []) {
        if (typeof r?.name !== "string" || !RESOURCE_NAME.test(r.name)) {
          warnings.push("Skipped a resource with a bad name.");
          continue;
        }
        const files = new Map();
        for (const f of r.files ?? []) {
          if (isSafeRelativePath(f?.path) && typeof f.file === "string" && path.isAbsolute(f.file)) files.set(f.path, f.file);
        }
        packages.push({ kind: "resource", name: r.name, key: `resource-${r.name}`, files });
      }
    } catch (err) {
      warnings.push(`Couldn't read the server's content list: ${err.message}`);
    }
  }

  if (modsFile) {
    try {
      const list = JSON.parse(fs.readFileSync(modsFile, "utf8"));
      for (const m of list.mods ?? []) {
        if (typeof m?.id !== "string" || !MOD_ID.test(m.id) || typeof m.dir !== "string" || !path.isAbsolute(m.dir)) {
          warnings.push("Skipped a mod with a bad entry in the enabled list.");
          continue;
        }
        const files = listFiles(m.dir);
        if (!files) {
          warnings.push(`Mod ${m.id} isn't installed where the list says (${m.dir}).`);
          continue;
        }
        packages.push({ kind: "mod", name: m.id, key: `mod-${m.id}`, files });
      }
    } catch (err) {
      warnings.push(`Couldn't read the enabled mods list: ${err.message}`);
    }
  }

  return { packages, warnings };
}

// Every regular file under dir, by safe relative path. Symlinks are skipped. Null if dir doesn't exist.
function listFiles(dir) {
  let root;
  try {
    root = fs.realpathSync(dir);
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = new Map();
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (files.size >= MAX_MOD_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink() || !isSafeRelativePath(childRel)) continue;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.set(childRel, childAbs);
    }
  };
  walk(root, "");
  return files;
}

// The scripts a package runs: top-level .lua files, in name order.
function scriptsOf(pkg) {
  return [...pkg.files.keys()].filter((p) => !p.includes("/") && p.toLowerCase().endsWith(".lua")).sort();
}

module.exports = { loadPackages, listFiles, scriptsOf };
