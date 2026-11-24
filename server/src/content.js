// Builds the content list players download before joining.
//
// Each resource is a folder in resources/. Only files matched by `client_files` in its
// resource.toml are sent to players, so server-side scripts (and any secrets in them) stay private.
// Hashes are cached by size and modification time so restarts are fast.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isSafeRelativePath, MAX_FILES, MAX_FILE_BYTES } = require("@projectvi/shared");
const { readResourceMeta } = require("./resource-meta");

// Supports *, ** and ? in forward-slash paths: "ui/*", "ui/**", "**/*.lua".
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

// Relative forward-slash paths of every regular file under dir. Hidden files and symlinks are skipped.
function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Files in dir (relative, forward slashes) matching any of the glob patterns, sorted.
function matchFiles(dir, patterns) {
  const regexps = patterns.map(globToRegExp);
  return listFiles(dir).filter((rel) => regexps.some((re) => re.test(rel))).sort();
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function loadHashCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

async function buildContent({ resourcesDir, start, cacheFile }) {
  const oldCache = cacheFile ? loadHashCache(cacheFile) : {};
  const newCache = {};
  const resources = [];
  const files = new Map(); // sha256 -> absolute path
  const warnings = [];
  let fileCount = 0;
  let totalBytes = 0;

  for (const name of start) {
    const dir = path.join(resourcesDir, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      warnings.push(`Resource "${name}" is listed in server.toml, but resources/${name} doesn't exist.`);
      continue;
    }

    let meta;
    try {
      meta = readResourceMeta(dir);
    } catch (err) {
      warnings.push(`Skipped resource "${name}": resource.toml isn't valid TOML (${err.message}).`);
      continue;
    }
    // Client-side C# assemblies (or sources) are content too: players need them to run the resource.
    const patterns = [...meta.clientFiles, ...meta.dotnet.client].map(globToRegExp);
    const entries = [];

    for (const rel of listFiles(dir)) {
      if (rel === "resource.toml" || !patterns.some((re) => re.test(rel))) continue;
      if (!isSafeRelativePath(rel)) {
        warnings.push(`Skipped resources/${name}/${rel}: that file name doesn't work on every system.`);
        continue;
      }
      const abs = path.join(dir, ...rel.split("/"));
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        warnings.push(`Skipped resources/${name}/${rel}: files over 2 GB can't be sent.`);
        continue;
      }
      const cached = oldCache[abs];
      const sha256 = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.sha256 : await hashFile(abs);
      newCache[abs] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };

      entries.push({ path: rel, size: stat.size, sha256 });
      files.set(sha256, abs);
      fileCount += 1;
      totalBytes += stat.size;
    }
    if (fileCount > MAX_FILES) throw new Error(`Resources send more than ${MAX_FILES} files to players. Narrow client_files.`);
    resources.push({ name, files: entries });
  }

  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(newCache));
  }
  return { manifest: { resources }, files, fileCount, totalBytes, warnings };
}

module.exports = { buildContent, globToRegExp, listFiles, matchFiles };
