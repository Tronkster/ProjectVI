// Checks a mod registry index. Run by CI on every pull request to the registry.
//
// Usage: node validate.js [index.json] [--download] [--allow-insecure]
//   --download        also download every version and check size, checksum and zip contents
//   --allow-insecure  accept http:// and file:// URLs (local testing only)

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { validateRegistry, validateModJson } = require("@projectvi/shared");
const { inspectZip, readModJson } = require("@projectvi/zip");

async function fetchToFile(url, dest, maxBytes) {
  if (url.startsWith("file:")) {
    await fs.promises.copyFile(fileURLToPath(url), dest);
    return;
  }
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("download is larger than the declared size");
    chunks.push(chunk);
  }
  await fs.promises.writeFile(dest, Buffer.concat(chunks));
}

async function checkVersion(mod, v, dir) {
  const file = path.join(dir, `${mod.id}-${v.version}.zip`);
  await fetchToFile(v.url, file, v.size);
  const data = await fs.promises.readFile(file);
  if (data.length !== v.size) throw new Error(`size is ${data.length}, registry says ${v.size}`);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (sha256 !== v.sha256) throw new Error(`sha256 is ${sha256}, registry says ${v.sha256}`);
  await inspectZip(file);
  const [meta, error] = validateModJson(await readModJson(file));
  if (error) throw new Error(error);
  if (meta.id !== mod.id || meta.version !== v.version) {
    throw new Error(`mod.json says ${meta.id} ${meta.version}, registry says ${mod.id} ${v.version}`);
  }
}

// Returns a list of problems; empty means valid.
async function validateFile(indexFile, { download = false, allowInsecure = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch (err) {
    return [`${indexFile} isn't valid JSON: ${err.message}`];
  }
  const [registry, error] = validateRegistry(raw, { allowInsecure });
  if (error) return [error];
  const problems = registry.skipped.map((s) => `${s.id}: ${s.reason}`);
  if (!download) return problems;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-registry-"));
  try {
    for (const mod of registry.mods) {
      for (const v of mod.versions) {
        try {
          await checkVersion(mod, v, dir);
        } catch (err) {
          problems.push(`${mod.id} ${v.version}: ${err.message}`);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

module.exports = { validateFile };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) || "index.json";
  validateFile(file, { download: args.includes("--download"), allowInsecure: args.includes("--allow-insecure") }).then((problems) => {
    if (problems.length) {
      console.error(`${file} has ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`${file} is valid.`);
  });
}
