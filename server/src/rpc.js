// JSON-RPC 2.0 over newline-delimited JSON (one frame per line, at most 1 MB).
// Used for script hosts (stdio) and, later, the game channel. See docs/scripting/host-protocol.md.

const MAX_FRAME_BYTES = 1024 * 1024;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class JsonRpcPeer {
  constructor(readable, writable, { onDiagnostic = () => {} } = {}) {
    this.writable = writable;
    this.onDiagnostic = onDiagnostic;
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.buffer = "";

    readable.setEncoding("utf8");
    readable.on("data", (chunk) => this.onData(chunk));
    readable.on("end", () => this.close("The other side closed the connection."));
    readable.on("error", (err) => this.close(err.message));
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new RpcError(-32000, "The connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32000, `${method} timed out after ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  close(reason = "Connection closed.") {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new RpcError(-32000, reason));
    }
    this.pending.clear();
  }

  write(message) {
    if (this.closed || !this.writable.writable) return;
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.onDiagnostic("Dropped a protocol frame larger than 1 MB.");
      this.buffer = "";
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onDiagnostic(`Ignored a line that isn't JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) this.handleRequest(message);
      else this.handleNotification(message);
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new RpcError(message.error.code, message.error.message));
    else call.resolve(message.result);
  }

  async handleRequest({ id, method, params }) {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
      return;
    }
    try {
      const result = await handler(params ?? {});
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message } });
    }
  }

  handleNotification({ method, params }) {
    const handler = this.notificationHandlers.get(method);
    if (!handler) return;
    try {
      handler(params ?? {});
    } catch (err) {
      this.onDiagnostic(`Notification ${method} failed: ${err.message}`);
    }
  }
}

module.exports = { JsonRpcPeer, RpcError, MAX_FRAME_BYTES };
