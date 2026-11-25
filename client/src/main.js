#!/usr/bin/env node
// Entry point. The launcher starts this beside the emulator, with the PROJECTVI_* settings (docs/protocol.md).
// Exit codes: 0 the session ended normally, 1 something went wrong (the log says what), 2 bad settings.

const fs = require("node:fs");
const path = require("node:path");
const { readSettings } = require("./settings");
const { Bridge, readBridgeFile } = require("./bridge");
const { GameClient } = require("./client");

function createLog(file) {
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: "a" });
  }
  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
    stream?.write(`${line}\n`);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    close: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve()))
  };
}

async function main() {
  const read = readSettings();
  const log = createLog(read.ok ? read.settings.logFile : "");
  if (!read.ok) {
    log.error(read.error);
    await log.close();
    return 2;
  }
  const settings = read.settings;
  log.info(`ProjectVI client for ${settings.name} → ${settings.host}:${settings.port}. Waiting for the emulator's bridge…`);

  let bridge;
  let client;
  try {
    const { port, token } = await readBridgeFile(settings.bridgeFile);
    bridge = new Bridge({ port, token });
    await bridge.connect();
    client = new GameClient({ settings, bridge, log });
    const stop = () => client.stop("Stopped.");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await client.start();
    const reason = await client.done;
    log.info(`Session over: ${reason}`);
    await log.close();
    return 0;
  } catch (err) {
    log.error(err.message);
    await client?.stop(err.message);
    bridge?.close();
    await log.close();
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { main, createLog };
