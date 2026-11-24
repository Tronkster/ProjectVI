const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildRoutes, resolveRequest } = require("../src/main/protocol");

const rendererDir = path.resolve(__dirname, "..", "src", "renderer");
const routes = buildRoutes(rendererDir);

test("serves renderer files and the font packages", () => {
  assert.equal(resolveRequest(routes, "/"), path.join(rendererDir, "index.html"));
  assert.equal(resolveRequest(routes, "/styles.css"), path.join(rendererDir, "styles.css"));
  assert.match(resolveRequest(routes, "/fonts/archivo/wdth.css"), /archivo[\\/]wdth\.css$/);
  assert.match(resolveRequest(routes, "/fonts/jetbrains-mono/files/x.woff2"), /jetbrains-mono[\\/]files[\\/]x\.woff2$/);
});

test("refuses anything outside those folders", () => {
  for (const p of [
    "/../main/index.js",
    "/%2e%2e/main/index.js",
    "/..%5cmain%5cindex.js",
    "/fonts/archivo/../../../package.json",
    "/fonts/archivo",
    "/%E0%A4%A"
  ]) {
    assert.equal(resolveRequest(routes, p), null, p);
  }
});
