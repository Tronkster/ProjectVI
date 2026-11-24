// Friends: your friend code, requests, and who's online and where. Joining a friend uses the
// normal join flow, by server id, so it only works for servers on the master server's list.

import { $, api, esc, initials } from "../util.js";
import { state } from "../state.js";
import { ensurePlayerName } from "../profile.js";
import { stateHtml } from "./servers.js";
import { openDialog, confirmDialog } from "../ui/dialog.js";
import { showToast } from "../ui/toast.js";

const REFRESH_EVERY_MS = 30_000;
let data = null; // last answer from friends:list
let loading = false;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function avatar(p) {
  return p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : esc(initials(p.name));
}

function statusOf(f) {
  if (f.server) return `<span class="presence playing"><i></i>Playing on ${esc(f.server.name)}</span>`;
  if (f.online) return '<span class="presence online"><i></i>Online</span>';
  return '<span class="presence"><i></i>Offline</span>';
}

function row(p, status, actions) {
  return `
    <li class="friend">
      <span class="avatar avatar-lg">${avatar(p)}</span>
      <div class="friend-who"><strong>${esc(p.name)}</strong>${status}</div>
      <div class="friend-actions">${actions}</div>
    </li>`;
}

function section(title, items) {
  return items.length ? `<h2 class="friends-h">${esc(title)} <span>${items.length}</span></h2><ul class="friend-list">${items.join("")}</ul>` : "";
}

export function renderFriends() {
  const body = $("friends-body");
  const box = $("friends-state");
  const actions = $("friends-actions");
  const badge = $("friends-badge");

  if (!data) {
    actions.hidden = true;
    body.innerHTML = "";
    box.hidden = false;
    box.innerHTML = stateHtml("Loading friends", "Asking the master server.");
    $("friends-sub").textContent = "";
    return;
  }

  if (!data.hasAccount) {
    actions.hidden = true;
    badge.hidden = true;
    body.innerHTML = "";
    box.hidden = false;
    $("friends-sub").textContent = "Play together on the same server.";
    const discord = state.auth?.available
      ? " If you log in with Discord later, your friends come with you."
      : "";
    box.innerHTML = stateHtml(
      "Add friends with a friend code",
      `Turning on friends gives you a code to share. Friends see your in-game name, when you're online and which server you're on.${esc(discord)}`,
      '<button type="button" class="btn btn-accent" data-friends="start">Turn on friends</button>'
    );
    return;
  }

  if (!data.ok) {
    actions.hidden = true;
    body.innerHTML = "";
    box.hidden = false;
    $("friends-sub").textContent = "";
    box.innerHTML = stateHtml("Can't load friends", esc(data.error), '<button type="button" class="btn btn-ghost" data-friends="refresh">Try again</button>');
    return;
  }

  actions.hidden = false;
  $("friend-code").textContent = data.code;
  const online = data.friends.filter((f) => f.online).length;
  $("friends-sub").textContent = data.friends.length
    ? `${online} of ${plural(data.friends.length, "friend", "friends")} online`
    : "Share your code, or add a friend with theirs.";
  badge.hidden = !data.incoming.length;
  badge.textContent = data.incoming.length > 9 ? "9+" : String(data.incoming.length);

  const incoming = data.incoming.map((p) => row(p, '<span class="presence">Wants to be friends</span>', `
    <button type="button" class="btn btn-accent btn-sm" data-friends="accept" data-id="${esc(p.id)}">Accept</button>
    <button type="button" class="btn btn-ghost btn-sm" data-friends="decline" data-id="${esc(p.id)}">Decline</button>`));
  const friends = data.friends.map((f) => row(f, statusOf(f), `
    ${f.server ? `<button type="button" class="btn btn-accent btn-sm" data-connect="${esc(f.server.id)}">Join</button>` : ""}
    <button type="button" class="icon-btn icon-btn-sm" data-friends="remove" data-id="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="Remove ${esc(f.name)}" title="Remove friend">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`));
  const outgoing = data.outgoing.map((p) => row(p, '<span class="presence">Request sent</span>', `
    <button type="button" class="btn btn-ghost btn-sm" data-friends="cancel" data-id="${esc(p.id)}">Cancel</button>`));

  body.innerHTML = section("Requests", incoming) + section("Friends", friends) + section("Sent", outgoing);
  box.hidden = Boolean(incoming.length || friends.length || outgoing.length);
  box.innerHTML = stateHtml("No friends yet", `Give a friend your code <strong>${esc(data.code)}</strong>, or press Add friend and type theirs.`);
}

export async function refreshFriends() {
  if (loading) return;
  loading = true;
  try {
    data = await api.friends.list();
  } finally {
    loading = false;
  }
  renderFriends();
}

// Most friends calls answer with the whole new list; use it, or reload on anything else.
async function apply(promise, success) {
  const res = await promise;
  if (!res.ok) {
    showToast(res.error);
    return refreshFriends();
  }
  if (success) showToast(success);
  if (Array.isArray(res.friends)) {
    data = { ...res, hasAccount: true };
    renderFriends();
  } else {
    await refreshFriends();
  }
}

async function start() {
  if (!(await ensurePlayerName({ action: "Save and turn on friends" }))) return;
  const res = await api.friends.start();
  if (!res.ok) showToast(res.error);
  await refreshFriends();
}

async function addFriend() {
  const code = await openDialog({
    title: "Add a friend",
    html: `
      <p>Ask your friend for their code. It's at the top of their Friends page.</p>
      <div class="field">
        <label for="dialog-code">Friend code</label>
        <input id="dialog-code" class="code-input" maxlength="20" spellcheck="false" autocomplete="off" placeholder="K7QP-2M9X">
        <p class="hint" id="dialog-code-hint"></p>
      </div>`,
    cancelValue: null,
    onReady: (dlg) => dlg.querySelector("#dialog-code").focus(),
    actions: [
      { label: "Cancel", value: null, kind: "ghost" },
      {
        label: "Send request",
        kind: "accent",
        value: (dlg) => dlg.querySelector("#dialog-code").value,
        validate: (dlg) => {
          const input = dlg.querySelector("#dialog-code");
          const ok = input.value.replace(/[\s-]/g, "").length === 8;
          input.setAttribute("aria-invalid", String(!ok));
          const hint = dlg.querySelector("#dialog-code-hint");
          hint.className = ok ? "hint" : "hint err";
          hint.textContent = ok ? "" : "Friend codes have 8 letters and digits, like K7QP-2M9X.";
          return ok;
        }
      }
    ]
  });
  if (code === null) return;
  const res = await api.friends.add(code);
  if (!res.ok) return showToast(res.error);
  showToast(res.result === "friends"
    ? `You and ${res.player.name} are now friends.`
    : `Friend request sent to ${res.player.name}.`);
  await refreshFriends();
}

async function resetCode() {
  const ok = await confirmDialog({
    title: "Get a new friend code?",
    text: "Your old code stops working. Friends you already have stay, and requests you already got stay too.",
    confirmLabel: "Get a new code"
  });
  if (ok) await apply(api.friends.resetCode(), "You have a new friend code.");
}

async function remove(id, name) {
  const ok = await confirmDialog({
    title: `Remove ${name}?`,
    text: `You'll disappear from each other's friends lists. To be friends again, one of you sends a new request.`,
    confirmLabel: "Remove",
    danger: true
  });
  if (ok) await apply(api.friends.remove(id), `Removed ${name}.`);
}

export function initFriends() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-friends]");
    if (!btn) return;
    const { id, name } = btn.dataset;
    switch (btn.dataset.friends) {
      case "start": return start();
      case "refresh": return refreshFriends();
      case "add": return addFriend();
      case "reset": return resetCode();
      case "copy":
        await navigator.clipboard.writeText(data?.code ?? "");
        return showToast("Friend code copied.");
      case "accept": return apply(api.friends.accept(id));
      case "decline": return apply(api.friends.dropRequest(id), "Request declined.");
      case "cancel": return apply(api.friends.dropRequest(id), "Request cancelled.");
      case "remove": return remove(id, name);
    }
  });
  // Keeps the request badge and online states fresh, wherever the player is in the launcher.
  setInterval(refreshFriends, REFRESH_EVERY_MS);
}
