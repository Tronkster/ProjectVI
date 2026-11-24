// Optional Discord login: status, log in, log out. The token never reaches this page.

import { $, api, esc } from "./util.js";
import { avatarInner, avatarStyle } from "./me.js";
import { state, emit } from "./state.js";
import { openProgress } from "./ui/progress.js";
import { showToast } from "./ui/toast.js";

// The player's own avatar: the friends profile when there is one, else the Discord login.
function own() {
  const person = state.me?.user ?? state.auth.user;
  return { ...person, name: state.settings.playerName || person?.name || "" };
}
export function avatarHtml() {
  return avatarInner(own());
}
export function ownAvatarStyle() {
  return avatarStyle(own()).replace(/^ style="|"$/g, "");
}

export function renderAccount() {
  const { available, user } = state.auth;
  const box = $("account-box");
  if (user) {
    box.innerHTML = `
      <div class="account-who">
        <span class="avatar avatar-lg">${avatarHtml()}</span>
        <div><strong>${esc(user.name)}</strong><span>Logged in with Discord as ${esc(user.username)}</span></div>
      </div>
      <button type="button" class="btn btn-ghost" data-auth="logout">Log out</button>`;
  } else if (available) {
    box.innerHTML = `
      <p>You're playing as a guest. Logging in is optional: it shows your Discord name and picture, and keeps your favorites on every PC.</p>
      <button type="button" class="btn btn-accent" data-auth="login">Log in with Discord</button>`;
  } else {
    box.innerHTML = "<p>You're playing as a guest. This master server doesn't offer logging in, so everything works without an account.</p>";
  }
  $("sync-row").hidden = !user;
  $("use-account-name").hidden = !user;
}

export async function refreshAuth() {
  const res = await api.auth.status();
  state.auth = { available: res.available, user: res.user };
  const prev = state.settings;
  state.settings = res.settings;
  emit("auth");
  emit("settings", { prev });
}

export async function login() {
  const ui = openProgress({
    title: "Log in with Discord",
    text: "Finish logging in in the browser window that just opened.",
    onCancel: () => api.auth.cancel()
  });
  const res = await api.auth.login();
  ui.close();
  if (!res.ok) {
    if (!res.cancelled) showToast(res.error);
    return;
  }
  state.auth = { ...state.auth, user: res.user };
  const prev = state.settings;
  state.settings = res.settings;
  emit("auth");
  emit("settings", { prev });
  showToast(`Logged in as ${res.user.name}.`);
}

export async function logout() {
  await api.auth.logout();
  state.auth = { ...state.auth, user: null };
  emit("auth");
  showToast("Logged out. You're playing as a guest.");
}

export async function useAccountName() {
  const suggested = await api.profile.suggestName(state.auth.user?.name ?? "");
  if (!suggested) {
    showToast("Your Discord name can't be used as an in-game name. Type one instead.");
    return;
  }
  const input = $("playerName");
  input.value = suggested;
  input.dispatchEvent(new Event("input"));
}

export function initAccount() {
  state.auth = { available: false, user: null };
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-auth]");
    if (!btn) return;
    if (btn.dataset.auth === "login") login();
    else logout();
  });
  $("use-account-name").addEventListener("click", useAccountName);
}
