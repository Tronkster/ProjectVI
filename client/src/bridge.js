// The connection to the emulator's bridge (VIctory: crates/victory-bridge). The emulator writes its port and a
// token to a file; we read it, connect to 127.0.0.1 and say hello with the token. Then it's newline-delimited
// JSON: our requests { id, op, args } get answers { id, ok, result | error }, and the emulator sends events such
// as { event: "frame", frame } after every frame the game presents.

const fs = require("node:fs");
const net = require("node:net");
const { EventEmitter } = require("node:events");

const MAX_LINE = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

// Waits for the emulator to write its bridge file, then returns { port, token }. The emulator writes it once the
// title is about to start, which can take a while (it maps and binds the executable first).
async function readBridgeFile(file, { timeoutMs = 120_000, pollMs = 250, now = Date.now } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Number.isInteger(data.port) && data.port > 0 && data.port < 65536 && typeof data.token === "string" && /^[0-9a-f]{64}$/.test(data.token)) {
        return { port: data.port, token: data.token, version: data.bridge };
      }
    } catch {
      // not there yet, or half written
    }
    if (now() >= until) throw Object.assign(new Error("The emulator didn't open its bridge. Is it a version of VIctory with the ProjectVI bridge?"), { code: "NO_BRIDGE" });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Error codes in answers: "unsupported" (the emulator can't do this with this game build), "bad_args",
// "not_ready", "failed", or "timeout" / "closed" from our side.
class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Events: "frame" (frame number), "exit" (game exit code), "close" (reason).
class Bridge extends EventEmitter {
  constructor({ host = "127.0.0.1", port, token, clientName = "projectvi" }) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.clientName = clientName;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = "";
    this.closed = false;
    this.info = null; // the hello answer: { bridge, emulator, emulatorVersion, build, buildHash, capabilities }
  }

  // Connects and says hello. Resolves with the hello answer.
  async connect() {
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    this.socket.setNoDelay(true);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (err) => this.end(`Bridge error: ${err.message}`));
    this.socket.on("close", () => this.end("The emulator closed the bridge."));
    this.info = await this.request("hello", { token: this.token, client: this.clientName });
    return this.info;
  }

  get capabilities() {
    return new Set(this.info?.capabilities ?? []);
  }

  can(op) {
    return this.capabilities.has(op);
  }

  // Sends a request. Resolves with its result, or rejects with a BridgeError.
  request(op, args) {
    if (this.closed || !this.socket) return Promise.reject(new BridgeError("closed", "The bridge is closed."));
    const id = this.nextId++;
    const line = JSON.stringify(args === undefined ? { id, op } : { id, op, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("timeout", `The emulator didn't answer ${op}.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${line}\n`);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE && !this.buffer.includes("\n")) return this.end("The emulator sent a message that was too long.");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.event === "frame") return this.emit("frame", message.frame);
    if (message.event === "exit") return this.emit("exit", message.code);
    if (message.event) return; // newer events we don't know
    const waiting = this.pending.get(message.id);
    if (!waiting) {
      // An answer to nobody: the emulator refused us before hello finished (busy, wrong token).
      if (message.ok === false && message.id === null) this.end(message.error?.message ?? "The emulator refused the connection.");
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new BridgeError(message.error?.code ?? "failed", message.error?.message ?? "The emulator said no."));
  }

  end(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new BridgeError("closed", reason));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.emit("close", reason);
  }

  close() {
    this.end("Closed.");
  }
}

module.exports = { Bridge, BridgeError, readBridgeFile, MAX_LINE };
