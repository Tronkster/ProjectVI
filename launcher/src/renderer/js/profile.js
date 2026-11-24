// Profile chip in the title bar, its menu, and the "what's your name?" prompt before joining.

import { $, api, esc } from "./util.js";
import { state, emit } from "./state.js";
import { openDialog } from "./ui/dialog.js";
import { avatarHtml } from "./account.js";

export function renderProfile() {
  const name = state.settings.playerName.trim();
  const user = state.auth?.user;
  $("profile-name").textContent = name || "Set your name";
  $("profile-avatar").innerHTML = avatarHtml();
  $("menu-avatar").innerHTML = avatarHtml();
  $("menu-name").textContent = name || user?.name || "No name yet";
  $("menu-sub").textContent = user ? `Logged in as ${user.username}` : "Guest";
  $("menu-account-items").innerHTML = user
    ? '<button type="button" role="menuitem" data-auth="logout">Log out</button>'
    : state.auth?.available
      ? '<button type="button" role="menuitem" data-auth="login">Log in with Discord</button>'
      : "";
  $("status-player").textContent = name ? `Playing as ${name}` : "No player name set";
}

function setMenu(open) {
  $("profile-menu").hidden = !open;
  $("profile-chip").setAttribute("aria-expanded", String(open));
  if (open) $("profile-menu").querySelector("[role=menuitem]")?.focus();
}

export function initProfile(go) {
  $("profile-chip").addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu($("profile-menu").hidden);
  });
  $("profile-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[role=menuitem]");
    if (!item) return;
    setMenu(false);
    if (item.dataset.go) go(item.dataset.go);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".profile")) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("profile-menu").hidden) {
      setMenu(false);
      $("profile-chip").focus();
    }
  });
}

// Resolves true once the player has a valid name, false if they cancel.
export async function ensurePlayerName() {
  const current = await api.profile.validateName(state.settings.playerName);
  if (current.ok) return true;

  let accepted = "";
  const ok = await openDialog({
    title: "Choose an in-game name",
    html: `
      <p>This is what other players see. You can change it later in Settings.</p>
      <div class="field">
        <label for="dialog-name">In-game name</label>
        <input id="dialog-name" maxlength="24" spellcheck="false" autocomplete="off" value="${esc(state.settings.playerName)}">
        <p class="hint" id="dialog-name-hint">3 to 24 characters: letters, numbers, spaces and _ - .</p>
      </div>`,
    cancelValue: false,
    onReady: (dlg) => dlg.querySelector("#dialog-name").focus(),
    actions: [
      { label: "Cancel", value: false, kind: "ghost" },
      {
        label: "Save and join",
        kind: "accent",
        value: true,
        validate: async (dlg) => {
          const input = dlg.querySelector("#dialog-name");
          const hint = dlg.querySelector("#dialog-name-hint");
          const result = await api.profile.validateName(input.value);
          input.setAttribute("aria-invalid", String(!result.ok));
          hint.className = result.ok ? "hint ok" : "hint err";
          hint.textContent = result.ok ? "" : result.error;
          if (result.ok) accepted = result.name;
          return result.ok;
        }
      }
    ]
  });
  if (!ok) return false;

  const prev = state.settings;
  state.settings = await api.settings.update({ playerName: accepted });
  emit("settings", { prev });
  return true;
}
