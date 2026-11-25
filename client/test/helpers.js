// Test helpers: a stand-in for the emulator's bridge that speaks its wire protocol (VIctory's
// crates/victory-bridge), offering only the operations a test gives it; and a real ProjectVI game server.
// Only for tests: the real client talks to the real emulator.

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { SyncServer } = require("../../server/src/sync");
const { ServerCore } = require("../../server/src/core/server-core");
const { validateConfig } = require("../../server/src/config");

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// ops: { "player.read": (args) => result, ... }. Records every call in `calls`.
async function startBridgeDouble(ops = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-bridge-"));
  const file = path.join(dir, "bridge.json");
  const token = crypto.randomBytes(32).toString("hex");
  const calls = [];
  let client = null;
  const server = net.createServer((socket) => {
    client = socket;
    socket.on("error", () => {}); // the client hanging up is normal
    socket.setEncoding("utf8");
    let buffer = "";
    let greeted = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const req = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        const reply = (body) => socket.write(`${JSON.stringify({ id: req.id, ...body })}\n`);
        if (!greeted) {
          if (req.op !== "hello" || req.args?.token !== token) {
            reply({ ok: false, error: { code: "unauthorized", message: "no" } });
            socket.end();
            return;
          }
          greeted = true;
          reply({ ok: true, result: { bridge: 1, emulator: "victory", emulatorVersion: "test", build: null, buildHash: "00", capabilities: Object.keys(ops).sort() } });
          continue;
        }
        calls.push({ op: req.op, args: req.args });
        const op = ops[req.op];
        if (!op) reply({ ok: false, error: { code: "unsupported", message: `can't ${req.op}` } });
        else reply({ ok: true, result: op(req.args) ?? null });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(file, JSON.stringify({ bridge: 1, port: server.address().port, token, pid: process.pid }));
  return {
    file,
    token,
    port: server.address().port,
    calls,
    frame: (n) => client?.write(`${JSON.stringify({ event: "frame", frame: n })}\n`),
    exit: (code) => client?.write(`${JSON.stringify({ event: "exit", code })}\n`),
    close: () => new Promise((resolve) => {
      client?.destroy();
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    })
  };
}

// A real game server's sync channel, plus the info the client fetches.
async function startGameServer() {
  const config = validateConfig({ server: { name: "Client test", max_players: 8 } });
  const core = new ServerCore({ config, log: quietLog, store: null });
  const sync = new SyncServer({ core, log: quietLog, tickRate: 20, streamRadius: 500, maxPlayers: 8 });
  const port = await sync.listen(0, "127.0.0.1");
  return {
    core,
    sync,
    port,
    info: async () => ({ sync: { version: require("@projectvi/shared").SYNC_VERSION, port, tickRate: 20 } }),
    close: () => sync.close()
  };
}

function recordingLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
}

async function until(check, { timeoutMs = 3000, stepMs = 20, every } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    every?.();
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

module.exports = { startBridgeDouble, startGameServer, recordingLog, until, quietLog };
