// Mods view: browse the public registry, install, update, turn on/off and remove mods.

import { $, api, esc, formatBytes } from "../util.js";
import { state, emit } from "../state.js";
import { artAttrs } from "../ui/cards.js";
import { confirmDialog } from "../ui/dialog.js";
import { openProgress } from "../ui/progress.js";
import { showToast } from "../ui/toast.js";
import { stateHtml } from "./servers.js";

const ICON_FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

const mods = { loaded: false, loading: false, data: null, tab: "browse", query: "" };
let progress = null;

api.mods.onProgress((p) => {
  progress?.update({ fraction: p.totalBytes ? p.doneBytes / p.totalBytes : 1, text: `${formatBytes(p.doneBytes)} of ${formatBytes(p.totalBytes)}` });
});

export const modsLoaded = () => mods.loaded;

export async function loadMods() {
  if (mods.loading) return;
  mods.loading = true;
  $("mods-refresh").classList.add("spin");
  try {
    mods.data = await api.mods.list();
    mods.loaded = true;
  } finally {
    mods.loading = false;
    $("mods-refresh").classList.remove("spin");
  }
  renderMods();
}

function modCard(m) {
  const latest = m.versions[0];
  let action;
  if (m.installedVersion === null) action = `<button type="button" class="btn btn-ghost btn-sm" data-install="${esc(m.id)}">Install</button>`;
  else if (m.installedVersion !== latest.version) action = `<button type="button" class="btn btn-ghost btn-sm" data-install="${esc(m.id)}">Update</button>`;
  else action = '<span class="installed-badge">Installed</span>';
  return `
    <li class="card">
      <div ${artAttrs(m.id, "Other")}>${m.tags[0] ? `<span class="tag">${esc(m.tags[0])}</span>` : ""}</div>
      <div class="card-body">
        <strong class="card-name">${esc(m.name)}</strong>
        <span class="by">by ${esc(m.author)}</span>
        <p>${esc(m.description)}</p>
      </div>
      <div class="card-foot">
        <span class="meta"><span>v${esc(latest.version)}</span><span>${esc(m.license)}</span><span>${formatBytes(latest.size)}</span></span>
        ${action}
      </div>
    </li>`;
}

function modRow(m) {
  return `
    <li class="mod-row${m.enabled ? "" : " off"}">
      <div ${artAttrs(m.id, "Other")} aria-hidden="true"></div>
      <div class="mod-row-info">
        <strong>${esc(m.name)}</strong>
        <span>v${esc(m.version)} · by ${esc(m.author)} · ${esc(m.license)}${m.enabled ? "" : " · Turned off"}</span>
      </div>
      <div class="mod-row-actions">
        ${m.updateAvailable ? `<button type="button" class="btn btn-ghost btn-sm" data-install="${esc(m.id)}">Update to ${esc(m.latest)}</button>` : ""}
        <button type="button" class="icon-btn" data-mod-open="${esc(m.id)}" aria-label="Open the ${esc(m.name)} folder" title="Open folder">${ICON_FOLDER}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-uninstall="${esc(m.id)}">Remove</button>
        <input type="checkbox" class="switch" data-toggle-mod="${esc(m.id)}" ${m.enabled ? "checked" : ""} aria-label="${esc(m.name)} turned on">
      </div>
    </li>`;
}

export function renderMods() {
  const d = mods.data;
  const updates = d ? d.installed.filter((m) => m.updateAvailable) : [];
  const counts = { browse: d ? d.mods.length : "", installed: d ? d.installed.length : "", updates: d ? updates.length : "" };
  document.querySelectorAll("[data-mods-tab]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.modsTab === mods.tab));
    btn.querySelector("span").textContent = counts[btn.dataset.modsTab];
  });
  $("mods-search-wrap").hidden = mods.tab !== "browse";

  const cards = $("mod-cards");
  const rows = $("mod-rows");
  const box = $("mods-state");
  cards.innerHTML = "";
  rows.innerHTML = "";
  box.hidden = true;
  const show = (html) => {
    box.innerHTML = html;
    box.hidden = false;
  };

  if (!d) {
    $("mods-sub").textContent = "Loading mods…";
    return show(stateHtml("Loading mods", "Reading the mod registry."));
  }

  const reg = d.registry;
  $("mods-sub").textContent = !reg.configured
    ? `${d.installed.length} installed · registry not published yet`
    : reg.ok
      ? `${d.mods.length} available · ${d.installed.length} installed`
      : `${d.installed.length} installed · registry unavailable`;

  if (mods.tab === "browse") {
    if (!reg.configured) {
      return show(stateHtml(
        "Mod registry not published yet",
        "Community mods show up here once the project's GitHub repository is live. Mod authors can get ready with <code>docs/making-mods.md</code>."
      ));
    }
    if (!reg.ok) {
      return show(stateHtml(
        "Can't load mods",
        `${esc(reg.error)} Check the address in Settings → Mods.`,
        '<button type="button" class="btn btn-ghost" data-action="mods-refresh">Try again</button>'
      ));
    }
    const q = mods.query.toLowerCase();
    const list = d.mods.filter((m) => !q || `${m.name} ${m.author} ${m.description} ${m.tags.join(" ")}`.toLowerCase().includes(q));
    if (!list.length) return show(d.mods.length ? stateHtml("No matches", "No mods match that search.") : stateHtml("No mods yet", "Nobody has published a mod to this registry yet."));
    cards.innerHTML = list.map(modCard).join("");
    return;
  }

  const list = mods.tab === "updates" ? updates : d.installed;
  if (!list.length) {
    return show(mods.tab === "updates"
      ? stateHtml("Everything is up to date", "Installed mods with newer versions show up here.")
      : stateHtml("No mods installed", "Mods you install from Browse show up here."));
  }
  rows.innerHTML = list.map(modRow).join("");
}

function applyResult(res) {
  if (!res.ok) {
    showToast(res.error);
    return false;
  }
  mods.data = { registry: res.registry, mods: res.mods, installed: res.installed };
  renderMods();
  return true;
}

async function install(id) {
  const m = mods.data.mods.find((x) => x.id === id);
  if (!m) return;
  if (!state.settings.modsNoticeSeen) {
    const ok = await confirmDialog({
      title: "Install community mods?",
      text: "Community mods aren't made by ProjectVI. Only install mods you trust. Every download is checked against the registry, and nothing runs until the ProjectVI client loads it.",
      confirmLabel: "I understand"
    });
    if (!ok) return;
    const prev = state.settings;
    state.settings = await api.settings.update({ modsNoticeSeen: true });
    emit("settings", { prev });
  }
  const updating = m.installedVersion !== null;
  progress = openProgress({ title: `${updating ? "Updating" : "Installing"} ${m.name}`, text: "Downloading…", cancellable: false });
  const res = await api.mods.install(id);
  progress.close();
  progress = null;
  if (applyResult(res)) showToast(`${m.name} ${updating ? "updated" : "installed"}.`);
}

async function uninstall(id) {
  const m = mods.data.installed.find((x) => x.id === id);
  if (!m) return;
  const ok = await confirmDialog({
    title: `Remove ${m.name}?`,
    text: "This deletes the mod's files from your PC. You can install it again from Browse.",
    confirmLabel: "Remove mod",
    danger: true
  });
  if (ok && applyResult(await api.mods.uninstall(id))) showToast(`${m.name} removed.`);
}

export function initMods() {
  document.querySelectorAll("[data-mods-tab]").forEach((btn) => btn.addEventListener("click", () => {
    mods.tab = btn.dataset.modsTab;
    renderMods();
  }));
  $("mods-search").addEventListener("input", (e) => {
    mods.query = e.target.value.trim();
    renderMods();
  });
  $("mods-refresh").addEventListener("click", loadMods);

  const view = $("view-mods");
  view.addEventListener("click", async (e) => {
    const target = e.target.closest("[data-install], [data-uninstall], [data-mod-open], [data-action='mods-refresh']");
    if (!target) return;
    if (target.dataset.install) return install(target.dataset.install);
    if (target.dataset.uninstall) return uninstall(target.dataset.uninstall);
    if (target.dataset.modOpen) {
      const res = await api.mods.openFolder(target.dataset.modOpen);
      if (!res.ok) showToast("Couldn't open that folder.");
      return;
    }
    loadMods();
  });
  view.addEventListener("change", async (e) => {
    const toggle = e.target.closest("[data-toggle-mod]");
    if (toggle) applyResult(await api.mods.setEnabled(toggle.dataset.toggleMod, toggle.checked));
  });
}
