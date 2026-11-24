// HTTP helpers for talking to game servers and the mod registry.
// Downloads are hashed while they stream and stop as soon as they exceed the expected size,
// so a server can't fill the disk or slip in a different file.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { fileURLToPath } = require("node:url");

// Game servers are addressed by IP, so IPv6 hosts need brackets.
function baseUrl(host, port) {
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

async function readLimited(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("The answer was larger than allowed.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchJson(url, { timeoutMs = 5000, maxBytes = 5 * 1024 * 1024, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse((await readLimited(res.body, maxBytes)).toString("utf8"));
}

// file:// is only reachable when the caller already allowed it (dev-mode mod registries).
async function openSource(url, signal) {
  if (url.startsWith("file:")) {
    const file = fileURLToPath(url);
    const { size } = await fs.promises.stat(file);
    return { body: fs.createReadStream(file, { signal }), length: size };
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The server answered with HTTP ${res.status}.`);
  const length = res.headers.get("content-length");
  return { body: res.body, length: length === null ? null : Number(length) };
}

// Streams url into dest. Rejects (and leaves nothing behind) on a size or checksum mismatch.
async function downloadToFile(url, dest, { size, sha256, signal, onBytes }) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

  const source = await openSource(url, signal);
  if (source.length !== null && source.length !== size) {
    source.body.destroy?.();
    throw new Error("A file has a different size than announced.");
  }

  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    for await (const chunk of source.body) {
      received += chunk.length;
      if (received > size) throw new Error("The server sent more data than it announced.");
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
      onBytes?.(chunk.length);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (received !== size) throw new Error("A download ended early.");
    if (hash.digest("hex") !== sha256) throw new Error("A downloaded file didn't match its checksum.");
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { baseUrl, fetchJson, downloadToFile };
