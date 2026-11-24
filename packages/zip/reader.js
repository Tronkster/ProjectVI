// Reading mod zips without trusting them.
//
// yauzl already refuses absolute paths, ".." and backslashes, and checks that every entry
// unpacks to exactly its declared size. On top of that we refuse symlinks, names Windows
// can't store, duplicate files, too many entries and too many bytes.

const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const { isSafeRelativePath } = require("@projectvi/shared");

const LIMITS = { maxEntries: 20_000, maxBytes: 4 * 1024 ** 3 };

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function openStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream))));
}

function isSymlink(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

// Calls onEntry(entry, info, zip) for every entry after the safety checks, one at a time.
async function walk(file, onEntry, limits = LIMITS) {
  let zip;
  try {
    zip = await openZip(file);
  } catch (err) {
    throw new Error(`The mod file isn't a valid zip: ${err.message}`, { cause: err });
  }
  let count = 0;
  let bytes = 0;
  const seen = new Set();

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      zip.close();
      reject(err.message?.startsWith("The mod") ? err : new Error(`The mod file is broken: ${err.message}`, { cause: err }));
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", async (entry) => {
      try {
        count += 1;
        if (count > limits.maxEntries) throw new Error(`The mod has more than ${limits.maxEntries} files.`);
        if (isSymlink(entry)) throw new Error(`The mod contains a link (${entry.fileName}), which isn't allowed.`);
        const isDir = entry.fileName.endsWith("/");
        const name = isDir ? entry.fileName.slice(0, -1) : entry.fileName;
        if (!isSafeRelativePath(name)) throw new Error(`The mod contains a file name that isn't safe: ${name}`);
        const key = name.toLowerCase(); // Windows file names are case-insensitive
        if (!isDir && seen.has(key)) throw new Error(`The mod contains ${name} twice.`);
        seen.add(key);
        if (!isDir) {
          bytes += entry.uncompressedSize;
          if (bytes > limits.maxBytes) throw new Error("The mod is too large when unpacked.");
        }
        await onEntry(entry, { name, isDir }, zip);
        zip.readEntry();
      } catch (err) {
        fail(err);
      }
    });
    zip.readEntry();
  });
  return { entries: count, bytes };
}

// Checks a zip completely without writing anything.
function inspectZip(file, limits) {
  return walk(file, async () => {}, limits);
}

// Reads and parses mod.json from the zip root, or returns null if there isn't one.
async function readModJson(file) {
  let text = null;
  await walk(file, async (entry, { name, isDir }, zip) => {
    if (isDir || name !== "mod.json") return;
    if (entry.uncompressedSize > 64 * 1024) throw new Error("The mod's mod.json is too large.");
    const chunks = [];
    for await (const chunk of await openStream(zip, entry)) chunks.push(chunk);
    text = Buffer.concat(chunks).toString("utf8");
  });
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The mod's mod.json isn't valid JSON.");
  }
}

// Unpacks into destDir, which must not exist yet. On any error the partial folder is removed.
async function extractZip(file, destDir, limits) {
  const root = path.resolve(destDir);
  await fs.promises.mkdir(root, { recursive: false });
  try {
    return await walk(file, async (entry, { name, isDir }, zip) => {
      const target = path.resolve(root, ...name.split("/"));
      if (!target.startsWith(root + path.sep)) throw new Error(`The mod contains a file name that isn't safe: ${name}`);
      if (isDir) {
        await fs.promises.mkdir(target, { recursive: true });
        return;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await openStream(zip, entry), fs.createWriteStream(target, { flags: "wx" }));
    }, limits);
  } catch (err) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw err;
  }
}

module.exports = { LIMITS, inspectZip, readModJson, extractZip };
