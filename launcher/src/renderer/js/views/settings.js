// Settings page. Inputs are bound by their data-setting attribute; the main process validates
// every value, and inputs are refilled from what it actually saved.

import { $, api, esc, formatBytes } from "../util.js";
import { state, emit } from "../state.js";
import { confirmDialog } from "../ui/dialog.js";
import { showToast } from "../ui/toast.js";
import { refreshServers } from "./servers.js";

const inputs = () => document.querySelectorAll("[data-setting]");
let pending = {};
let saveTimer = 0;
let savedTimer = 0;

function valueOf(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return Number.isNaN(el.valueAsNumber) ? el.value : el.valueAsNumber;
  return el.value;
}

// Also called when settings change outside this page (login, reset), so inputs never go stale.
export function fill(only) {
  for (const el of inputs()) {
    const key = el.dataset.setting;
    if (only && !only.includes(key)) continue;
    if (el === document.activeElement && el.type !== "checkbox") continue;
    // A switch that can't be used here (dev build, no repo yet) shows as off.
    if (el.type === "checkbox") el.checked = !el.disabled && Boolean(state.settings[key]);
    else el.value = state.settings[key];
  }
}

export async function flushSettings() {
  clearTimeout(saveTimer);
  const patch = pending;
  pending = {};
  if (!Object.keys(patch).length) return;
  const prev = state.settings;
  state.settings = await api.settings.update(patch);
  // Put back anything the main process refused (out of range numbers and the like).
  for (const key of Object.keys(patch)) {
    if (state.settings[key] !== patch[key]) fill([key]);
  }
  $("saved").hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $("saved").hidden = true; }, 1600);
  emit("settings", { prev });
}

function queue(patch, immediate = false) {
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  if (immediate) flushSettings();
  else saveTimer = setTimeout(flushSettings, 400);
}

// ---- Profile ----

async function onNameInput() {
  const el = $("playerName");
  const hint = $("name-hint");
  if (!el.value.trim()) {
    el.removeAttribute("aria-invalid");
    hint.className = "hint";
    hint.textContent = "3 to 24 characters: letters, numbers, spaces and _ - .";
    queue({ playerName: "" });
    return;
  }
  const result = await api.profile.validateName(el.value);
  el.setAttribute("aria-invalid", String(!result.ok));
  hint.className = result.ok ? "hint ok" : "hint err";
  hint.textContent = result.ok ? `Other players see you as ${result.name}.` : result.error;
  if (result.ok) queue({ playerName: result.name });
}

// ---- Game ----

async function checkSetup() {
  await flushSettings();
  const r = await api.settings.checkSetup();
  const list = $("setup-checks");
  list.hidden = false;
  list.innerHTML = [r.name, r.emulator, r.game]
    .map((c) => `<li><i class="${c.ok ? "ok" : ""}"></i>${esc(c.message)}</li>`)
    .join("");
}

async function testLaunch() {
  await flushSettings();
  const res = await api.game.launch(null);
  showToast(res.ok ? "Emulator started." : res.error);
}

// ---- Downloads ----

export async function updateCacheSize() {
  $("cache-size").textContent = formatBytes(await api.system.cacheSize());
}

async function clearCache() {
  const ok = await confirmDialog({
    title: "Clear server content?",
    text: "This deletes everything servers have sent you. Servers send it again the next time you join.",
    confirmLabel: "Clear content",
    danger: true
  });
  if (!ok) return;
  await api.system.clearCache();
  await updateCacheSize();
  showToast("Server content cleared.");
}

// ---- Network ----

async function testMaster() {
  await flushSettings();
  const hint = $("master-hint");
  hint.className = "hint";
  hint.textContent = "Checking…";
  const res = await refreshServers();
  hint.className = res.ok ? "hint ok" : "hint err";
  hint.textContent = res.ok ? `Connected. ${res.servers.length} servers online.` : res.error;
}

// ---- Developer ----

async function copyDiagnostics() {
  await api.system.copyDiagnostics();
  showToast("Diagnostics copied. Paste them into your bug report.");
}

async function resetSettings() {
  const ok = await confirmDialog({
    title: "Reset all settings?",
    text: "Your name, game paths, favorites and every other setting go back to the defaults. Downloaded content and mods stay.",
    confirmLabel: "Reset settings",
    danger: true
  });
  if (!ok) return;
  const prev = state.settings;
  pending = {};
  state.settings = await api.settings.reset();
  fill();
  emit("settings", { prev });
  showToast("Settings reset.");
}

// ---- About and environment-dependent controls ----

function renderAbout() {
  const info = state.info;
  const rows = [
    ["Version", `${esc(info.version)}${info.packaged ? "" : " (from source)"}`],
    ["Built on", `Electron ${esc(info.electron)} · Chromium ${esc(info.chrome)} · Node ${esc(info.node)}`],
    ["System", esc(info.platform)],
    ["License", "MIT"],
    ["Source code", info.repoUrl ? `<a href="${esc(info.repoUrl)}" target="_blank" rel="noopener">${esc(info.repoUrl)}</a>` : "Not published yet"],
    ["Data folder", '<button type="button" class="btn btn-ghost" data-open="data">Open data folder</button>']
  ];
  $("about").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  if (!info.packaged) {
    $("startWithWindows").disabled = true;
    $("startup-hint").textContent = "Only works in the installed version.";
  }
  if (!info.repoConfigured) {
    $("autoUpdate").disabled = true;
    $("updateChannel").disabled = true;
    $("update-hint").textContent = "Turns on once the project's GitHub repository is published.";
  }
  $("cacheDir").placeholder = info.paths.cache;
}

// ---- Section navigation ----

export function scrollToSection(name) {
  const section = $(`set-${name}`);
  if (section) section.scrollIntoView({ block: "start" });
}

function initSectionNav() {
  const links = [...document.querySelectorAll("#settings-nav a")];
  links.forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    $(`set-${a.dataset.section}`).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const name = entry.target.id.slice(4);
      links.forEach((a) => a.classList.toggle("on", a.dataset.section === name));
    }
  }, { root: $("content"), rootMargin: "0px 0px -70% 0px" });
  document.querySelectorAll(".set-section").forEach((s) => observer.observe(s));
}

export function initSettings() {
  renderAbout();
  fill();
  initSectionNav();
  $("settings-form").addEventListener("submit", (e) => e.preventDefault());

  for (const el of inputs()) {
    if (el.id === "playerName") continue;
    const live = el.tagName === "INPUT" && el.type !== "checkbox" && el.type !== "number";
    el.addEventListener(live ? "input" : "change", () => queue({ [el.dataset.setting]: valueOf(el) }, !live));
  }
  $("playerName").addEventListener("input", onNameInput);

  document.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const picked = await api.system.pickPath(btn.dataset.pick);
      if (!picked) return;
      const target = $(btn.dataset.target);
      target.value = picked;
      queue({ [target.dataset.setting]: picked }, true);
    });
  });

  $("check-setup").addEventListener("click", checkSetup);
  $("test-launch").addEventListener("click", testLaunch);
  $("clear-cache").addEventListener("click", clearCache);
  $("test-master").addEventListener("click", testMaster);
  $("copy-diagnostics").addEventListener("click", copyDiagnostics);
  $("reset-settings").addEventListener("click", resetSettings);
}
