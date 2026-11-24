// Console output for the server: time, optional resource tag, message.

function createLog({ write = (line) => console.log(line), debug = false } = {}) {
  const stamp = () => new Date().toLocaleTimeString();
  const out = (prefix, message) => write(`${stamp()}  ${prefix}${message}`);
  return {
    info: (message) => out("", message),
    warn: (message) => out("Warning: ", message),
    error: (message) => out("Error: ", message),
    debug: (message) => debug && out("", message),
    // Messages from scripts, tagged with their resource.
    script(resource, level, message) {
      if (level === "debug" && !debug) return;
      const tag = level === "error" ? "Error: " : level === "warning" ? "Warning: " : "";
      for (const line of String(message).split("\n")) out(`[${resource}] ${tag}`, line);
    }
  };
}

module.exports = { createLog };
