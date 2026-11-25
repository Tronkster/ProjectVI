// The overlay page: chat, notices, the player list and client scripts' UI pages, over the game.
// Everything shown comes from the ProjectVI client and is put on screen with textContent, never as HTML.
// Script UI pages run in iframes sandboxed to scripts only, from projectvi-ui:// (main/ui-content.js).

const $ = (id) => document.getElementById(id);
const MAX_LINES = 50;
const FADE_MS = 15_000;
const NOTICE_MS = 6000;

const frames = new Map(); // ui id -> iframe
let players = [];

function addChat(name, text) {
  const li = document.createElement("li");
  if (name === "Server") li.className = "server";
  const who = document.createElement("span");
  who.className = "name";
  who.textContent = name;
  li.append(who, document.createTextNode(text));
  const list = $("chat-lines");
  list.append(li);
  while (list.children.length > MAX_LINES) list.firstElementChild.remove();
  setTimeout(() => li.classList.add("faded"), FADE_MS);
}

function addNotice(text) {
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  $("notices").append(div);
  setTimeout(() => div.classList.add("gone"), NOTICE_MS);
  setTimeout(() => div.remove(), NOTICE_MS + 500);
}

function renderPlayers() {
  const list = $("player-list");
  list.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement("li");
      if (p.me) li.className = "me";
      const name = document.createElement("span");
      name.textContent = `${p.name} #${p.id}`;
      li.append(name);
      if (p.host) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "host";
        li.append(tag);
      }
      return li;
    })
  );
  $("player-count").textContent = players.length === 1 ? "1 player" : `${players.length} players`;
}

function openPage(id, url) {
  frames.get(id)?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.dataset.id = id;
  frame.src = url;
  frames.set(id, frame);
  $("pages").append(frame);
}

function setChatOpen(open) {
  $("chat").classList.toggle("open", open);
  $("chat-form").hidden = !open;
  if (open) {
    $("chat-text").value = "";
    $("chat-text").focus();
  }
}

// Messages from script pages: only from one of our frames, and only with the bridge's marker.
addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.projectvi !== 1 || typeof data.name !== "string") return;
  for (const [id, frame] of frames) {
    if (frame.contentWindow === event.source) {
      window.overlay.uiMessage(id, data.name, data.data ?? null);
      return;
    }
  }
});

$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  window.overlay.sendChat($("chat-text").value);
});
$("chat-text").addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.overlay.closeChat();
});

window.overlay.onEvent((m) => {
  switch (m.type) {
    case "session":
      $("server-name").textContent = m.server;
      addNotice(`Joined ${m.server} as ${m.player.name}.`);
      break;
    case "chat":
      addChat(m.name, m.text);
      break;
    case "notice":
      addNotice(m.text);
      break;
    case "players":
      players = m.players;
      renderPlayers();
      break;
    case "players.toggle":
      $("players").hidden = !$("players").hidden;
      break;
    case "chat.open":
      setChatOpen(true);
      break;
    case "chat.close":
      setChatOpen(false);
      break;
    case "ui.open":
      openPage(m.id, m.url);
      break;
    case "ui.send": {
      const frame = frames.get(m.id);
      // "*": the frame's origin is opaque (sandboxed), so there's no origin to name. The frame is ours.
      frame?.contentWindow?.postMessage({ projectvi: 1, name: m.name, data: m.data }, "*");
      break;
    }
    case "ui.show": {
      const frame = frames.get(m.id);
      if (frame) frame.hidden = !m.visible;
      break;
    }
  }
});
