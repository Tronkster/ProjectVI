// Server content: checking what a server needs, downloading what's missing into a shared cache,
// and writing the file the ProjectVI client reads to find it.
//
// Cache layout: <cache>/content/ab/<sha256> (one copy per file, shared by every server)
//               <cache>/servers/<key>/manifest.json (per server, rewritten on each join)

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateInfo, validateManifest, PROTOCOL_VERSION } = require("@projectvi/shared");
const { baseUrl, fetchJson, downloadToFile } = require("./http");

function blobPath(contentDir, sha256) {
  return path.join(contentDir, sha256.slice(0, 2), sha256);
}

// Folder names can't contain ":" on Windows, so servers are keyed by a hash of host:port.
function serverKey(serverId) {
  return crypto.createHash("sha256").update(serverId).digest("hex").slice(0, 16);
}

async function inspectServer(server) {
  const base = `${baseUrl(server.host, server.port)}/projectvi`;
  let rawInfo;
  try {
    rawInfo = await fetchJson(`${base}/info`);
  } catch {
    throw new Error(`Couldn't reach ${server.name}. It may be offline, or not running a ProjectVI server.`);
  }
  const [info, infoError] = validateInfo(rawInfo);
  if (infoError) throw new Error(infoError);

  let rawManifest;
  try {
    rawManifest = await fetchJson(`${base}/manifest`, { timeoutMs: 15_000, maxBytes: 20 * 1024 * 1024 });
  } catch {
    throw new Error(`${server.name} didn't send its content list.`);
  }
  const [manifest, manifestError] = validateManifest(rawManifest);
  if (manifestError) throw new Error(manifestError);
  return { info, manifest };
}

// Works out which files are already cached. Files with the same hash are downloaded once.
function planDownload(manifest, contentDir) {
  const unique = new Map();
  for (const r of manifest.resources) for (const f of r.files) unique.set(f.sha256, f.size);

  const missing = [];
  let haveBytes = 0;
  let missingBytes = 0;
  for (const [sha256, size] of unique) {
    let cached = false;
    try {
      cached = fs.statSync(blobPath(contentDir, sha256)).size === size;
    } catch {
      // not cached
    }
    if (cached) haveBytes += size;
    else {
      missing.push({ sha256, size });
      missingBytes += size;
    }
  }
  return { fileCount: unique.size, totalBytes: haveBytes + missingBytes, haveBytes, missingBytes, missingCount: missing.length, missing };
}

async function downloadMissing({ server, plan, contentDir, concurrency, signal, onProgress }) {
  const base = `${baseUrl(server.host, server.port)}/projectvi/files`;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const samples = [];
  let doneBytes = 0;
  let doneFiles = 0;
  let next = 0;
  let lastReport = 0;

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 150) return;
    lastReport = now;
    samples.push([now, doneBytes]);
    while (samples.length > 2 && now - samples[0][0] > 2000) samples.shift();
    const [t0, b0] = samples[0];
    const bytesPerSecond = now > t0 ? Math.round(((doneBytes - b0) * 1000) / (now - t0)) : 0;
    onProgress({ doneBytes, totalBytes: plan.missingBytes, doneFiles, totalFiles: plan.missingCount, bytesPerSecond });
  };

  async function worker() {
    while (next < plan.missing.length) {
      const file = plan.missing[next++];
      await downloadToFile(`${base}/${file.sha256}`, blobPath(contentDir, file.sha256), {
        size: file.size,
        sha256: file.sha256,
        signal: combined,
        onBytes: (n) => {
          doneBytes += n;
          report();
        }
      });
      doneFiles += 1;
      report();
    }
  }

  report(true);
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.missing.length)) }, worker));
  } catch (err) {
    controller.abort(); // stop the other workers
    throw err;
  }
  report(true);
}

function writeClientManifest({ cacheRoot, contentDir, server, manifest }) {
  const dir = path.join(cacheRoot, "servers", serverKey(server.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  const body = {
    protocol: PROTOCOL_VERSION,
    server: { id: server.id, name: server.name },
    contentDir,
    resources: manifest.resources.map((r) => ({
      name: r.name,
      files: r.files.map((f) => ({ ...f, file: blobPath(contentDir, f.sha256) }))
    })),
    writtenAt: new Date().toISOString()
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

function summary(plan) {
  const { fileCount, totalBytes, haveBytes, missingBytes, missingCount } = plan;
  return { fileCount, totalBytes, haveBytes, missingBytes, missingCount };
}

function createJoinManager({ getPaths, getSettings, getServer, logger, onProgress }) {
  const jobs = new Map(); // serverId -> { server, manifest, plan }
  let active = null;

  const dirs = () => {
    const cacheRoot = getPaths().cache;
    return { cacheRoot, contentDir: path.join(cacheRoot, "content") };
  };

  return {
    async prepare(serverId) {
      const server = getServer(serverId);
      if (!server) return { ok: false, error: "That server isn't in the list anymore. Refresh and try again." };
      try {
        const { info, manifest } = await inspectServer(server);
        const plan = planDownload(manifest, dirs().contentDir);
        jobs.set(serverId, { server, manifest, plan });
        logger.info("Server content checked", { server: server.name, files: plan.fileCount, missing: plan.missingCount });
        return { ok: true, info, plan: summary(plan) };
      } catch (err) {
        logger.warn("Couldn't check server content", { server: server.name, error: err.message });
        return { ok: false, error: err.message };
      }
    },

    async download(serverId) {
      const job = jobs.get(serverId);
      if (!job) return { ok: false, error: "Check the server again before downloading." };
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const { contentDir } = dirs();
      try {
        await downloadMissing({
          server: job.server,
          plan: job.plan,
          contentDir,
          concurrency: getSettings().parallelDownloads,
          signal: controller.signal,
          onProgress: (p) => onProgress({ serverId, ...p })
        });
        job.plan = planDownload(job.manifest, contentDir);
        logger.info("Server content downloaded", { server: job.server.name });
        return { ok: true };
      } catch (err) {
        if (controller.signal.aborted && err.name === "AbortError") return { ok: false, cancelled: true };
        logger.warn("Download failed", { server: job.server.name, error: err.message });
        return { ok: false, error: `Download from ${job.server.name} failed: ${err.message}` };
      } finally {
        if (active === controller) active = null;
      }
    },

    cancel() {
      active?.abort();
    },

    // Path to the file the client reads, or "" if this server's content isn't complete.
    clientManifestFor(serverId) {
      const job = jobs.get(serverId);
      if (!job || job.plan.missingCount > 0) return "";
      const { cacheRoot, contentDir } = dirs();
      return writeClientManifest({ cacheRoot, contentDir, server: job.server, manifest: job.manifest });
    }
  };
}

module.exports = { blobPath, serverKey, planDownload, downloadMissing, writeClientManifest, inspectServer, createJoinManager };
