// The content list a game server sends before a player joins (see docs/protocol.md).
// Game servers build it, the launcher checks it before downloading anything.

const { isSafeRelativePath } = require("./paths");
const { PROTOCOL_VERSION } = require("./project");

const MAX_RESOURCES = 500;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const SHA256 = /^[a-f0-9]{64}$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

// Returns [manifest, null] or [null, message]. The manifest gets fileCount and totalBytes added.
function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.resources)) {
    return [null, "The server sent an invalid content list."];
  }
  if (raw.resources.length > MAX_RESOURCES) return [null, `The server lists more than ${MAX_RESOURCES} resources.`];

  const resources = [];
  const names = new Set();
  let fileCount = 0;
  let totalBytes = 0;

  for (const r of raw.resources) {
    if (!r || typeof r.name !== "string" || !RESOURCE_NAME.test(r.name) || names.has(r.name) || !Array.isArray(r.files)) {
      return [null, "The server's content list has a broken resource."];
    }
    names.add(r.name);
    const paths = new Set();
    const files = [];
    for (const f of r.files) {
      if (!f || !isSafeRelativePath(f.path) || paths.has(f.path)) {
        return [null, `Resource ${r.name} has an unsafe or duplicate file path.`];
      }
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) {
        return [null, `Resource ${r.name} has a file with an invalid size.`];
      }
      if (!isSha256(f.sha256)) return [null, `Resource ${r.name} has a file with an invalid checksum.`];
      paths.add(f.path);
      files.push({ path: f.path, size: f.size, sha256: f.sha256 });
      fileCount += 1;
      totalBytes += f.size;
      if (fileCount > MAX_FILES) return [null, `The server lists more than ${MAX_FILES} files.`];
    }
    resources.push({ name: r.name, files });
  }
  return [{ resources, fileCount, totalBytes }, null];
}

// Returns [info, null] or [null, message].
function validateInfo(raw) {
  if (!raw || typeof raw !== "object") return [null, "The server sent an invalid answer."];
  if (raw.protocol !== PROTOCOL_VERSION) {
    return [null, raw.protocol > PROTOCOL_VERSION
      ? "This server needs a newer launcher. Update ProjectVI and try again."
      : "This server runs an older ProjectVI version the launcher doesn't support."];
  }
  return [{
    name: typeof raw.name === "string" ? raw.name.slice(0, 64) : "",
    protocol: raw.protocol,
    contentBytes: Number.isInteger(raw.contentBytes) && raw.contentBytes >= 0 ? raw.contentBytes : 0,
    fileCount: Number.isInteger(raw.fileCount) && raw.fileCount >= 0 ? raw.fileCount : 0
  }, null];
}

module.exports = { MAX_FILES, MAX_FILE_BYTES, RESOURCE_NAME, isSha256, validateManifest, validateInfo };
