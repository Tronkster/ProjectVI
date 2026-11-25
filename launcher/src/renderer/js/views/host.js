// Host a game: run a ProjectVI server on this PC (main/hosting.js) and join it.

import { $, api } from "../util.js";
import { state } from "../state.js";
import { showToast } from "../ui/toast.js";

const STATES = { stopped: "Not hosting", starting: "Starting…", running: "Hosting", stopping: "Stopping…" };
let current = null;
let joinFn = null;

function render(status) {
  current = status;
  const running = status.state === "running";
  const busy = status.state === "starting" || status.state === "stopping";
  $("host-state").textContent = STATES[status.state] ?? status.state;
  $("host-count").textContent = running ? `${status.players} of ${status.settings.maxPlayers}` : "–";
  $("host-start").hidden = status.state !== "stopped";
  $("host-start").disabled = busy;
  $("host-stop").hidden = status.state === "stopped";
  $("host-stop").disabled = status.state === "stopping";
  $("host-join").hidden = !running;
  $("host-badge").hidden = !running;
  for (const id of ["host-name", "host-players", "host-port", "host-mode", "host-upnp", "host-listed", "host-verified"]) $(id).disabled = status.state !== "stopped";

  const port = status.settings?.port;
  let share = "–";
  let note = "";
  if (running && status.port.status === "open") {
    share = status.shareAddress || `your public address, port ${port}`;
    note = "Your router forwards the port. Friends type this address in Direct connect.";
  } else if (running && status.port.status === "opening") {
    note = "Asking your router to open the port…";
  } else if (running && status.port.status === "failed") {
    note = `Couldn't open the port automatically: ${status.port.error} Forward TCP and UDP port ${port} to this PC on your router, then friends join at your public address.`;
  } else if (running) {
    note = `Friends outside your network need TCP and UDP port ${port} forwarded to this PC.`;
  }
  // Without a public address, friends on the same network can still join through the local one.
  if (running && !status.shareAddress && status.lanAddress) {
    share = status.lanAddress;
    note = `That's your address on your home network: friends on the same network can join it. ${note}`;
  }
  if (running && status.settings.listed) note += " It's also in the server browser.";
  $("host-share").textContent = share;
  $("host-port-note").textContent = note;
  $("host-resources").textContent = status.resources.length ? status.resources.join(", ") : "none (add folders to the resources folder)";
  $("host-log").textContent = status.log.join("\n");
  $("host-error").hidden = !status.error;
  $("host-error").textContent = status.error;
}

export async function refreshHost() {
  render(await api.host.status());
}

function settingsFromForm() {
  return {
    name: $("host-name").value,
    maxPlayers: Number($("host-players").value),
    port: Number($("host-port").value),
    mode: $("host-mode").value,
    upnp: $("host-upnp").checked,
    listed: $("host-listed").checked,
    requireTicket: $("host-verified").checked
  };
}

// join: the connect(serverId) the rest of the launcher uses.
export function initHost(join) {
  joinFn = join;
  api.host.onStatus(render);
  $("host-name").value = `${state.settings?.playerName || "My"}'s game`.slice(0, 64);
  $("host-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("host-error").hidden = true;
    $("host-start").disabled = true;
    const result = await api.host.start(settingsFromForm());
    if (!result.ok) {
      $("host-error").textContent = result.error;
      $("host-error").hidden = false;
    }
    await refreshHost();
  });
  $("host-stop").addEventListener("click", async () => {
    await api.host.stop();
    await refreshHost();
  });
  $("host-join").addEventListener("click", () => {
    if (current?.localId) joinFn(current.localId);
  });
  $("host-folder").addEventListener("click", () => api.host.openFolder());
  $("host-share").addEventListener("click", async () => {
    const address = current?.shareAddress || current?.lanAddress;
    if (!address) return;
    await navigator.clipboard.writeText(address);
    showToast("Address copied.");
  });
  refreshHost();
}
