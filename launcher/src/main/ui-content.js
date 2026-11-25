// Serves client scripts' UI pages to the overlay, from projectvi-ui://<host>/<path>. The pages come from server
// resources and public mods, so they're untrusted:
// - each package gets an opaque host (p1, p2, …) and only its own whitelisted files (from the client);
// - every page gets a Content Security Policy with no network, frames or forms, and runs in an iframe sandboxed
//   to scripts only (src/renderer/overlay.js), so it can't reach the overlay, the launcher or another page;
// - HTML pages get a small `projectvi` object injected: projectvi.on(name, fn) and projectvi.send(name, data).
//
// No Electron imports, so this can be tested with plain Node.

const fs = require("node:fs");
const path = require("node:path");
const { isSafeRelativePath } = require("@projectvi/shared");

const SCHEME = "projectvi-ui";
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav"
};

const CSP = [
  "default-src 'none'",
  `script-src ${SCHEME}: 'unsafe-inline'`,
  `style-src ${SCHEME}: 'unsafe-inline'`,
  `img-src ${SCHEME}: data:`,
  `font-src ${SCHEME}: data:`,
  `media-src ${SCHEME}:`,
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

// Runs first in every page. Talks only to the overlay (its parent), with a marker so other messages are ignored.
const BRIDGE = `<script>(() => {
  const handlers = new Map();
  window.projectvi = Object.freeze({
    on(name, fn) {
      if (typeof fn !== "function") return;
      const list = handlers.get(String(name)) || [];
      list.push(fn);
      handlers.set(String(name), list);
    },
    send(name, data) {
      parent.postMessage({ projectvi: 1, name: String(name), data: data === undefined ? null : data }, "*");
    }
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.projectvi !== 1) return;
    for (const fn of handlers.get(event.data.name) || []) {
      try { fn(event.data.data); } catch (err) { console.error(err); }
    }
  });
})();</script>`;

function createUiContent() {
  const byHost = new Map(); // host -> { key, name, files: Map(path -> file) }
  const hostOf = new Map(); // package key -> host
  let next = 1;

  return {
    // Registers (or replaces) a package's files: { path: absolute file }. Unsafe entries are dropped.
    setPackage(key, name, files) {
      if (typeof key !== "string" || !key || !files || typeof files !== "object") return null;
      let host = hostOf.get(key);
      if (!host) {
        host = `p${next++}`;
        hostOf.set(key, host);
      }
      const map = new Map();
      for (const [rel, file] of Object.entries(files)) {
        if (isSafeRelativePath(rel) && typeof file === "string" && path.isAbsolute(file)) map.set(rel, file);
      }
      byHost.set(host, { key, name: String(name || key), files: map });
      return host;
    },

    // The URL for a page of a registered package, or null.
    urlFor(key, rel) {
      const host = hostOf.get(key);
      if (!host || !byHost.get(host).files.has(rel)) return null;
      return `${SCHEME}://${host}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    },

    // Maps a request URL to { file, type, html } or null.
    resolve(urlText) {
      let url;
      try {
        url = new URL(urlText);
      } catch {
        return null;
      }
      if (url.protocol !== `${SCHEME}:`) return null;
      const pkg = byHost.get(url.host);
      if (!pkg) return null;
      let rel;
      try {
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      } catch {
        return null;
      }
      const file = pkg.files.get(rel);
      if (!file) return null;
      const type = TYPES[path.extname(rel).toLowerCase()] || "application/octet-stream";
      return { file, type, html: type.startsWith("text/html") };
    },

    // Builds the response for a request: { status, headers, body }.
    respond(urlText) {
      const hit = this.resolve(urlText);
      if (!hit) return { status: 404, headers: { "Content-Type": "text/plain" }, body: "Not found" };
      let body;
      try {
        const stat = fs.statSync(hit.file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("too big");
        body = fs.readFileSync(hit.file);
      } catch {
        return { status: 404, headers: { "Content-Type": "text/plain" }, body: "Not found" };
      }
      if (hit.html) body = Buffer.from(injectBridge(body.toString("utf8")), "utf8");
      return {
        status: 200,
        headers: { "Content-Type": hit.type, "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
        body
      };
    },

    clear() {
      byHost.clear();
      hostOf.clear();
    }
  };
}

// Puts the bridge first in <head> (or at the very start), so it exists before the page's own scripts run.
function injectBridge(html) {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + BRIDGE + html.slice(head.index + head[0].length);
  return BRIDGE + html;
}

module.exports = { SCHEME, CSP, createUiContent, injectBridge };
