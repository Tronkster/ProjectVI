// Serves the UI from app://launcher/ instead of file://, which gives the renderer ES modules and a
// strict Content Security Policy. Only files inside the renderer folder and the two font packages
// can be reached; anything else is a 404.

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "app";
const HOST = "launcher";
const ORIGIN = `${SCHEME}://${HOST}`;

// Electron is required inside the functions so resolveRequest can be tested with plain Node.
function registerScheme() {
  const { protocol } = require("electron");
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    // Client scripts' UI pages in the overlay (ui-content.js): standard, so relative links work; nothing else.
    { scheme: "projectvi-ui", privileges: { standard: true, secure: true } }
  ]);
}

// Serves projectvi-ui:// from the files the client registered (ui-content.js decides what exists).
function serveUi(ui) {
  const { protocol } = require("electron");
  protocol.handle("projectvi-ui", async (request) => {
    const { status, headers, body } = ui.respond(request.url);
    return new Response(body, { status, headers });
  });
}

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

// Longest prefix first, so "fonts/archivo/..." never falls through to the renderer folder.
function buildRoutes(rendererDir) {
  return [
    ["fonts/archivo", packageDir("@fontsource-variable/archivo")],
    ["fonts/jetbrains-mono", packageDir("@fontsource/jetbrains-mono")],
    ["", rendererDir]
  ];
}

// Maps a request path to a file on disk, or null if it's outside the allowed folders.
function resolveRequest(routes, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  // Backslashes are separators on Windows but plain characters elsewhere, so refuse them everywhere.
  if (rel.includes("\\") || rel.includes("\0")) return null;
  if (rel === "") rel = "index.html";
  for (const [prefix, dir] of routes) {
    if (prefix && rel !== prefix && !rel.startsWith(`${prefix}/`)) continue;
    const sub = prefix ? rel.slice(prefix.length + 1) : rel;
    const file = path.resolve(dir, sub);
    return file.startsWith(dir + path.sep) ? file : null;
  }
  return null;
}

function serveApp(rendererDir) {
  const { net, protocol } = require("electron");
  const routes = buildRoutes(rendererDir);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = url.host === HOST ? resolveRequest(routes, url.pathname) : null;
    if (!file) return new Response("Not found", { status: 404 });
    try {
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

module.exports = { ORIGIN, registerScheme, serveApp, serveUi, buildRoutes, resolveRequest };
