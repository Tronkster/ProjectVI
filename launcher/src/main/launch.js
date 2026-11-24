// Starting the emulator. No Electron imports, so this file can be tested with plain node:test.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_ID = /^[\w.:\-[\]]{1,300}$/;

// Splits an argument template like `"{game}" --fullscreen` into an argv array, honoring quotes.
function splitArgs(template) {
  const args = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(String(template)))) args.push(match[1] ?? match[2]);
  return args;
}

// Works out what to run. Returns { ok: true, exe, args, cwd, env } or { ok: false, code, error }.
// extra: { serverId, contentFile, modsFile } — files the ProjectVI client reads once it exists.
function buildLaunch(settings, extra = {}) {
  const exe = String(settings.emulatorPath || "").trim();
  if (!exe) return { ok: false, code: "no-emulator", error: "Choose your emulator in Settings first." };
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    return { ok: false, code: "no-emulator", error: "The emulator file wasn't found. Check the path in Settings." };
  }

  const server = typeof extra.serverId === "string" && SERVER_ID.test(extra.serverId) ? extra.serverId : "";
  const vars = { game: String(settings.gamePath || "").trim(), server, name: String(settings.playerName || "").trim() };
  const args = splitArgs(settings.launchArgs)
    .map((arg) => arg.replace(/\{(game|server|name)\}/g, (_, key) => vars[key]))
    .filter((arg) => arg !== "");

  return {
    ok: true,
    exe,
    args,
    cwd: path.dirname(exe),
    env: {
      PROJECTVI_SERVER: server,
      PROJECTVI_PLAYER: vars.name,
      PROJECTVI_MASTER: String(settings.masterUrl || ""),
      PROJECTVI_CONTENT: extra.contentFile || "",
      PROJECTVI_MODS: extra.modsFile || ""
    }
  };
}

function launchGame(settings, extra) {
  const plan = buildLaunch(settings, extra);
  if (!plan.ok) return Promise.resolve(plan);
  return new Promise((resolve) => {
    const child = spawn(plan.exe, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...plan.env }
    });
    child.once("error", (err) => resolve({ ok: false, error: `Couldn't start the emulator: ${err.message}` }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

module.exports = { splitArgs, buildLaunch, launchGame };
