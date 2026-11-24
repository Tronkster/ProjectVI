// The player's own profile on the master server (picture, color, friend requests) and the
// account itself (type, friend code, delete). It belongs to whichever account friends use:
// the Discord login, or else the guest account made when friends were turned on.

import { $, api, esc, initials } from "./util.js";
import { state, emit } from "./state.js";
import { confirmDialog } from "./ui/dialog.js";
import { showToast } from "./ui/toast.js";

// The same list the master server accepts.
export const COLORS = ["#ff6a1a", "#f43f5e", "#a855f7", "#3b82f6", "#06b6d4", "#10b981", "#eab308", "#64748b"];
const PICTURE_SIZE = 128;

// An avatar's inside: the picture, or initials (on the player's color, set by avatarStyle).
export function avatarInner(person, fallbackName = "") {
  if (person?.avatarUrl) return `<img src="${esc(person.avatarUrl)}" alt="">`;
  return esc(initials(person?.name || fallbackName));
}
export function avatarStyle(person) {
  return person?.color && !person.avatarUrl ? ` style="background:${esc(person.color)};color:#0b0c10"` : "";
}

export async function refreshMe() {
  const res = await api.me.get();
  state.me = res.ok ? { user: res.user, acceptRequests: res.acceptRequests } : null;
  emit("me");
}

export function renderMe() {
  const me = state.me;
  const has = Boolean(me);

  // Profile: picture and color.
  const preview = $("picture-preview");
  preview.innerHTML = avatarInner(me?.user, state.settings.playerName);
  preview.setAttribute("style", avatarStyle(me?.user).replace(/^ style="|"$/g, ""));
  $("picture-upload").disabled = !has;
  $("picture-remove").hidden = !has || !me.user.avatarUrl || me.user.avatarUrl.startsWith("https://cdn.discordapp.com/");
  $("picture-hint").textContent = has
    ? "Friends see your picture, or your initials on the color you pick."
    : "Turn on friends on the Friends page to pick a picture or color that friends see.";
  $("color-swatches").innerHTML = COLORS.map((c) => `
    <button type="button" class="swatch" role="radio" data-color="${c}" style="background:${c}"
      aria-checked="${String(me?.user.color === c)}" aria-label="Color ${c}" ${has ? "" : "disabled"}></button>`).join("");

  // Friends settings.
  $("friends-settings-hint").hidden = has;
  $("acceptRequests").disabled = !has;
  $("acceptRequests").checked = has && me.acceptRequests;

  // Account details.
  $("account-details").hidden = !has;
  if (has) {
    $("account-type").textContent = me.user.provider === "discord" ? `Discord (${me.user.username})` : "Guest";
    $("account-code").textContent = state.friendCode || "";
  }
}

async function update(patch, done) {
  const res = await api.me.update(patch);
  if (!res.ok) {
    showToast(res.error);
    renderMe(); // put the switch back
    return;
  }
  state.me = { user: res.user, acceptRequests: res.acceptRequests };
  emit("me");
  if (done) showToast(done);
}

// Shrinks the picture to a 128 px square (cropped from the middle) and encodes it as WebP.
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PICTURE_SIZE;
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
    if (data.length <= 44_000) return data;
  }
  throw new Error("too big");
}

async function upload(file) {
  if (!file) return;
  let data;
  try {
    data = await shrink(file);
  } catch {
    showToast("That file couldn't be used as a picture. Try a PNG or JPEG.");
    return;
  }
  const res = await api.me.setPicture("image/webp", data);
  if (!res.ok) return showToast(res.error);
  state.me = { user: res.user, acceptRequests: res.acceptRequests };
  emit("me");
  showToast("Picture updated. Friends see it the next time their list refreshes.");
}

async function deleteAccount() {
  const ok = await confirmDialog({
    title: "Delete your account?",
    text: "Your account on this master server is deleted for good, with your friends, friend requests, messages and picture. Friends will no longer see you. This can't be undone. Your settings and downloads on this PC stay.",
    confirmLabel: "Delete account",
    danger: true
  });
  if (!ok) return;
  const res = await api.me.deleteAccount();
  if (!res.ok) return showToast(res.error);
  state.me = null;
  state.auth = { ...state.auth, user: null };
  emit("auth");
  emit("me");
  showToast("Your account is deleted.");
}

export function initMe() {
  state.me = null;
  $("picture-upload").addEventListener("click", () => $("picture-file").click());
  $("picture-file").addEventListener("change", async (e) => {
    await upload(e.target.files[0]);
    e.target.value = "";
  });
  $("picture-remove").addEventListener("click", async () => {
    const res = await api.me.removePicture();
    if (!res.ok) return showToast(res.error);
    state.me = { user: res.user, acceptRequests: res.acceptRequests };
    emit("me");
  });
  $("color-swatches").addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-color]");
    if (swatch) update({ color: swatch.dataset.color });
  });
  $("acceptRequests").addEventListener("change", (e) => update(
    { acceptRequests: e.target.checked },
    e.target.checked ? "Players can send you friend requests again." : "Nobody can send you friend requests now."
  ));
  $("delete-account").addEventListener("click", deleteAccount);
}
