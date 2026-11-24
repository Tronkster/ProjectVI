// Update status in Settings → Launcher and the "Update ready" button in the status bar.

import { $, api } from "./util.js";
import { state } from "./state.js";

function message(s) {
  switch (s.state) {
    case "unavailable":
      return state.info.packaged
        ? "Updates turn on once the project's GitHub repository is published."
        : "Updates only work in the installed version.";
    case "checking": return "Checking for updates…";
    case "current": return "You have the latest version.";
    case "downloading": return `Downloading version ${s.version}… ${s.percent}%`;
    case "ready": return `Version ${s.version} is ready. Restart the launcher to install it.`;
    case "error": return `Couldn't check for updates: ${s.error}`;
    default: return "";
  }
}

function render(s) {
  $("update-ready").hidden = s.state !== "ready";
  $("update-status").textContent = message(s);
  $("update-status").className = s.state === "error" ? "hint err" : "hint";
  $("check-updates").disabled = ["unavailable", "checking", "downloading"].includes(s.state);
}

export async function initUpdates() {
  render(await api.updates.status());
  api.updates.onStatus(render);
  $("check-updates").addEventListener("click", () => api.updates.check());
  $("update-ready").addEventListener("click", () => api.updates.install());
}
