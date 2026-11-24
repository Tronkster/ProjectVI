// Server list from the master server, and pings to game servers.
// No Electron imports, so this file can be tested with plain node:test.

const net = require("node:net");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The master server must use HTTPS, except on this machine where plain HTTP is fine for development.
// Returns [url, null] or [null, errorMessage].
function parseMasterUrl(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    return [null, "The master server address isn't a valid URL."];
  }
  if (url.protocol === "https:") return [url, null];
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return [url, null];
  if (url.protocol === "http:") return [null, "The master server must use https:// unless it runs on this PC."];
  return [null, "The master server address must start with https://."];
}

function cleanServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const port = Number(raw.port);
  if (typeof raw.host !== "string" || !raw.host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const host = raw.host.slice(0, 255);
  return {
    id: `${host}:${port}`,
    host,
    port,
    name: text(raw.name, 64) || "Unnamed server",
    description: text(raw.description, 160),
    mode: text(raw.mode, 16) || "Other",
    region: text(raw.region, 8),
    players: int(raw.players),
    maxPlayers: int(raw.maxPlayers)
  };
}

async function fetchServers(masterUrl) {
  const [base, error] = parseMasterUrl(masterUrl);
  if (error) return { ok: false, error };
  const href = `${base.href.replace(/\/+$/, "")}/api/servers`;
  try {
    const res = await fetch(href, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `The master server answered with HTTP ${res.status}.` };
    const data = await res.json();
    const servers = Array.isArray(data.servers) ? data.servers.map(cleanServer).filter(Boolean) : [];
    return { ok: true, servers };
  } catch (err) {
    if (err.name === "TimeoutError") return { ok: false, error: "The master server didn't answer within 5 seconds." };
    return { ok: false, error: `Can't reach the master server at ${base.origin}.` };
  }
}

// TCP round trip to the server's host. A refused connection still proves the host answered,
// so it counts as a ping; only timeouts and network errors show as unreachable (null).
function tcpPing(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.connect({ host, port });
    const done = (ms) => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once("connect", () => done(Math.round(performance.now() - start)));
    socket.once("error", (err) => done(err.code === "ECONNREFUSED" ? Math.round(performance.now() - start) : null));
  });
}

async function pingServers(targets) {
  if (!Array.isArray(targets)) return {};
  const valid = targets
    .filter((t) => t && typeof t.id === "string" && typeof t.host === "string" && t.host.length <= 255 && Number.isInteger(t.port))
    .slice(0, 200);
  const results = await Promise.all(valid.map(async (t) => [t.id, await tcpPing(t.host, t.port)]));
  return Object.fromEntries(results);
}

module.exports = { parseMasterUrl, cleanServer, fetchServers, tcpPing, pingServers };
