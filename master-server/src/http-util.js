const MAX_BODY_BYTES = 8 * 1024;

function clientIp(req) {
  const ip = req.socket.remoteAddress || "";
  if (ip === "::1") return "127.0.0.1";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function page(res, status, title, text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;background:#08090c;color:#f2f4f7;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="max-width:420px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#8b93a1">${esc(text)}</p></div>`);
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

module.exports = { clientIp, send, redirect, page, readJson, bearerToken };
