// Launcher UI entry: wires views together, owns navigation and window controls.

import { $, api } from "./util.js";
import { state, on, emit } from "./state.js";
import { initServers, renderServers, refreshServers } from "./views/servers.js";
import { renderFavorites } from "./views/favorites.js";
import { initFriends, renderFriends, refreshFriends } from "./views/friends.js";
import { initMe, renderMe, refreshMe } from "./me.js";
import { fill as fillSettings, initSettings, scrollToSection, updateCacheSize } from "./views/settings.js";
import { initMods, loadMods, modsLoaded, renderMods } from "./views/mods.js";
import { initProfile, renderProfile } from "./profile.js";
import { initAccount, renderAccount, refreshAuth } from "./account.js";
import { initUpdates } from "./updates.js";
import { connect } from "./connect.js";
import { showToast } from "./ui/toast.js";

const VIEWS = ["servers", "favorites", "friends", "mods", "settings"];
const REFRESH_EVERY_MS = 30_000;

// go("settings") or go("settings:game") to jump to a section.
function go(target) {
  const [view, section] = target.split(":");
  if (!VIEWS.includes(view)) return;
  state.view = view;
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll(".rail-btn").forEach((btn) => {
    if (btn.dataset.view === view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  $("content").scrollTop = 0;
  if (view === "mods" && !modsLoaded()) loadMods();
  if (view === "friends") refreshFriends();
  if (view === "settings") {
    updateCacheSize();
    if (section) scrollToSection(section);
  }
}

function renderStatus() {
  const el = $("status-master");
  if (state.masterOk === null) el.innerHTML = '<i class="dot"></i>Connecting to master server…';
  else if (state.masterOk) el.innerHTML = `<i class="dot ok"></i>Master server online · ${state.servers.length} servers`;
  else el.innerHTML = '<i class="dot err"></i>Master server offline';
}

async function toggleFavorite(id) {
  const favs = new Set(state.settings.favorites);
  favs.has(id) ? favs.delete(id) : favs.add(id);
  const prev = state.settings;
  state.settings = await api.settings.update({ favorites: [...favs] });
  emit("settings", { prev });
}

function initWindowControls() {
  $("win-min").addEventListener("click", () => api.window.minimize());
  $("win-max").addEventListener("click", () => api.window.toggleMaximize());
  $("win-close").addEventListener("click", () => api.window.close());
  api.window.onState(({ maximized }) => {
    $("win-max").querySelector(".icon-max").hidden = maximized;
    $("win-max").querySelector(".icon-restore").hidden = !maximized;
    $("win-max").setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  });
}

function initGlobalEvents() {
  document.querySelectorAll(".rail-btn").forEach((btn) => btn.addEventListener("click", () => go(btn.dataset.view)));

  // Cards, banners and state boxes are re-rendered, so their buttons use delegation.
  document.addEventListener("click", async (e) => {
    const fav = e.target.closest("[data-fav]");
    if (fav) return toggleFavorite(fav.dataset.fav);
    const join = e.target.closest("[data-connect]");
    if (join) return connect(join.dataset.connect, go);
    const open = e.target.closest("[data-open]");
    const goTo = e.target.closest("[data-go]");
    if (goTo && !goTo.closest("#profile-menu")) return go(goTo.dataset.go);
    if (open) {
      const res = await api.system.openFolder(open.dataset.open);
      if (!res.ok) showToast("Couldn't open that folder.");
      return;
    }
    if (e.target.closest('[data-action="refresh"]')) refreshServers();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      refreshServers();
    }
  });
}

async function start() {
  [state.settings, state.info] = await Promise.all([api.settings.get(), api.system.info()]);
  $("version").textContent = `v${state.info.version}`;

  on("servers", () => {
    renderServers();
    renderFavorites();
    renderStatus();
  });
  on("settings", ({ prev } = {}) => {
    fillSettings();
    renderProfile();
    renderServers();
    renderFavorites();
    renderMe();
    if (prev && prev.masterUrl.trim() !== state.settings.masterUrl.trim()) {
      refreshServers();
      refreshAuth(); // a different master server may have a different login
    }
    if (prev && prev.cacheDir !== state.settings.cacheDir) updateCacheSize();
    const registryChanged = prev && (prev.registryUrl !== state.settings.registryUrl || prev.developerMode !== state.settings.developerMode);
    if (registryChanged && modsLoaded()) loadMods();
  });

  initWindowControls();
  initServers();
  initSettings();
  on("auth", () => {
    renderAccount();
    renderProfile();
    refreshFriends(); // logging in or out changes which account friends use
    refreshMe();
  });
  on("me", () => {
    renderMe();
    renderProfile();
  });

  initAccount();
  initUpdates();
  initMods();
  initProfile(go);
  initMe();
  initFriends();
  initGlobalEvents();
  renderMods();
  renderFriends();
  renderAccount();

  renderProfile();
  refreshAuth();
  emit("servers");
  go("servers");
  refreshServers();
  setInterval(refreshServers, REFRESH_EVERY_MS);
}

start();
