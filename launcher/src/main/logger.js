// Plain-text log in the logs folder, rotated at 1 MB with three old files kept.
// Never log tokens or full settings; paths under the user's home are shortened to "~".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

function redact(text) {
  const home = os.homedir();
  return home ? text.split(home).join("~") : text;
}

function createLogger(dir, { echo = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "launcher.log");

  function rotate() {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    fs.rmSync(`${file}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  }

  function write(level, message, extra) {
    const detail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra)}`;
    const line = redact(`${new Date().toISOString()} ${level.padEnd(5)} ${message}${detail}\n`);
    try {
      rotate();
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never crash the launcher.
    }
    if (echo) process.stdout.write(line);
  }

  function tail(lines = 40) {
    try {
      return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  return {
    dir,
    file,
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
    tail
  };
}

module.exports = { createLogger, redact };
