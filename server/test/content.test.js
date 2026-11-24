const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateManifest } = require("@projectvi/shared");
const { buildContent, globToRegExp } = require("../src/content");

function makeResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-server-"));
  const write = (rel, body) => {
    const file = path.join(root, "resources", ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write("hud/resource.toml", 'client_files = ["client.lua", "ui/**"]');
  write("hud/client.lua", "print('hud')");
  write("hud/server.lua", "secret = 'do not send'");
  write("hud/ui/index.html", "<p>hi</p>");
  write("hud/ui/img/logo.txt", "logo");
  write("hud/.env", "TOKEN=x");
  write("noclient/server.lua", "-- no resource.toml, nothing is sent");
  return root;
}

test("globToRegExp handles *, ** and ?", () => {
  assert.ok(globToRegExp("ui/*").test("ui/a.css"));
  assert.ok(!globToRegExp("ui/*").test("ui/x/a.css"));
  assert.ok(globToRegExp("ui/**").test("ui/x/a.css"));
  assert.ok(globToRegExp("**/*.lua").test("a.lua"));
  assert.ok(globToRegExp("**/*.lua").test("x/y/a.lua"));
  assert.ok(globToRegExp("file?.txt").test("file1.txt"));
  assert.ok(!globToRegExp("a.lua").test("aXlua"));
});

test("only client_files are sent, with correct hashes", async () => {
  const root = makeResources();
  try {
    const content = await buildContent({
      resourcesDir: path.join(root, "resources"),
      start: ["hud", "noclient", "missing"],
      cacheFile: path.join(root, ".projectvi", "hash-cache.json")
    });
    const hud = content.manifest.resources.find((r) => r.name === "hud");
    assert.deepEqual(hud.files.map((f) => f.path).sort(), ["client.lua", "ui/img/logo.txt", "ui/index.html"]);
    assert.deepEqual(content.manifest.resources.find((r) => r.name === "noclient").files, []);
    assert.match(content.warnings.join("\n"), /missing/);

    const client = hud.files.find((f) => f.path === "client.lua");
    assert.equal(client.sha256, crypto.createHash("sha256").update("print('hud')").digest("hex"));
    assert.equal(content.files.get(client.sha256), path.join(root, "resources", "hud", "client.lua"));

    // What the server sends must pass the launcher's own checks.
    assert.equal(validateManifest(content.manifest)[1], null);
    assert.ok(fs.existsSync(path.join(root, ".projectvi", "hash-cache.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
