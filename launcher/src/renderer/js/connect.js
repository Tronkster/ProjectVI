// Joining a server: name check, content check, download (asking first when it's big),
// then starting the emulator with the server's content list.

import { api, esc, formatBytes } from "./util.js";
import { state, emit } from "./state.js";
import { ensurePlayerName } from "./profile.js";
import { flushSettings } from "./views/settings.js";
import { openDialog } from "./ui/dialog.js";
import { openProgress } from "./ui/progress.js";
import { showToast } from "./ui/toast.js";

const MB = 1024 * 1024;
let progress = null;

api.join.onProgress((p) => {
  progress?.update({
    fraction: p.totalBytes ? p.doneBytes / p.totalBytes : 1,
    text: `${formatBytes(p.doneBytes)} of ${formatBytes(p.totalBytes)}`,
    detail: `${p.doneFiles} of ${p.totalFiles} files · ${formatBytes(p.bytesPerSecond)}/s`
  });
});

function needsApproval(serverId, plan) {
  const s = state.settings;
  if (s.trustedServers.includes(serverId)) return false;
  return s.askAboveMb === 0 || plan.missingBytes > s.askAboveMb * MB;
}

function approveDownload(server, plan) {
  const files = `${plan.missingCount} ${plan.missingCount === 1 ? "file" : "files"}`;
  const have = plan.haveBytes > 0 ? ` You already have ${formatBytes(plan.haveBytes)} of it.` : "";
  return openDialog({
    title: `Download content for ${server.name}?`,
    html: `
      <p>This server needs <strong>${formatBytes(plan.missingBytes)}</strong> of mods and files (${files}).${esc(have)}</p>
      <p class="hint">Every file is checked against the server's checksums. The launcher stores them but never runs them.</p>
      <label class="check-row"><input type="checkbox" id="trust-server"> Don't ask again for this server</label>`,
    cancelValue: null,
    actions: [
      { label: "Cancel", value: null, kind: "ghost" },
      { label: "Download and join", kind: "accent", value: (dlg) => ({ trust: dlg.querySelector("#trust-server").checked }) }
    ]
  });
}

async function trustServer(serverId) {
  const prev = state.settings;
  state.settings = await api.settings.update({ trustedServers: [...state.settings.trustedServers, serverId] });
  emit("settings", { prev });
}

function showProgress(server, text) {
  progress = openProgress({ title: `Joining ${server.name}`, text, onCancel: () => api.join.cancel() });
  return progress;
}

export async function connect(serverId, go) {
  await flushSettings();
  if (!(await ensurePlayerName())) return;
  const server = state.servers.find((s) => s.id === serverId) ?? { id: serverId, name: "the server" };

  let ui = showProgress(server, "Checking the server…");
  const prep = await api.join.prepare(serverId);
  if (ui.closed) return; // cancelled while checking
  if (!prep.ok) {
    ui.close();
    showToast(prep.error);
    return;
  }

  const { plan } = prep;
  if (plan.missingCount > 0) {
    if (needsApproval(serverId, plan)) {
      ui.close();
      const choice = await approveDownload(server, plan);
      if (!choice) return;
      if (choice.trust) await trustServer(serverId);
      ui = showProgress(server, "");
    }
    ui.update({ text: `0 MB of ${formatBytes(plan.missingBytes)}`, fraction: 0, detail: `0 of ${plan.missingCount} files` });
    const result = await api.join.download(serverId);
    if (!result.ok) {
      ui.close();
      if (!result.cancelled) showToast(result.error);
      return;
    }
    if (ui.closed) return;
  }

  ui.update({ text: "Starting the emulator…", fraction: 1, detail: "" });
  const res = await api.join.launch(serverId);
  ui.close();
  progress = null;
  if (res.ok) {
    showToast(`Emulator started. Joining ${server.name} needs the ProjectVI client, which isn't released yet.`);
  } else {
    showToast(res.error);
    if (res.code === "no-emulator") go("settings:game");
  }
}
