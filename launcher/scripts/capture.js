// Dev tool: starts the launcher with a throwaway profile, clicks through the main screens and
// saves a PNG of each. Useful for pull requests and for checking UI changes.
// Usage: npm run capture -w launcher [-- <output folder>]

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron"); // from plain Node this is the path to the Electron binary

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "projectvi-captures"));

spawn(electron, [path.join(__dirname, "capture-entry.js")], {
  stdio: "inherit",
  env: { ...process.env, CAPTURE_OUT: out }
}).on("exit", (code) => {
  console.log(`Screenshots in ${out}`);
  process.exit(code ?? 0);
});
