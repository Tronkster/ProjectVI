import { $, api, esc } from "../util.js";
import { state, emit } from "../state.js";
import { cardHtml, featuredHtml } from "../ui/cards.js";

function sorted(list) {
  const copy = [...list];
  if (state.sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (state.sort === "ping") {
    const p = (s) => (typeof state.pings[s.id] === "number" ? state.pings[s.id] : Infinity);
    return copy.sort((a, b) => p(a) - p(b));
  }
  return copy.sort((a, b) => b.players - a.players);
}

export function stateHtml(title, text, action = "") {
  return `<strong>${esc(title)}</strong><p>${text}</p>${action}`;
}

export { sorted };

export function renderServers() {
  const all = state.servers;
  const players = all.reduce((sum, s) => sum + s.players, 0);
  $("servers-sub").textContent = state.masterOk === null
    ? "Loading servers…"
    : state.masterOk
      ? `${all.length} ${all.length === 1 ? "server" : "servers"} online · ${players} players`
      : "Master server offline";

  document.querySelectorAll(".seg button").forEach((btn) => {
    const m = btn.dataset.mode;
    btn.querySelector("span").textContent = m === "All" ? all.length : all.filter((s) => s.mode === m).length;
  });

  const q = state.query.toLowerCase();
  const visible = sorted(all.filter((s) =>
    (state.mode === "All" || s.mode === state.mode) &&
    (!q || `${s.name} ${s.description} ${s.region}`.toLowerCase().includes(q))
  ));

  const top = state.masterOk && all.length && state.mode === "All" && !q
    ? [...all].sort((a, b) => b.players - a.players)[0]
    : null;
  $("featured").innerHTML = top ? featuredHtml(top) : "";
  $("server-cards").innerHTML = visible.map(cardHtml).join("");

  const box = $("servers-state");
  box.hidden = visible.length > 0;
  if (state.masterOk === null) {
    box.innerHTML = stateHtml("Loading servers", "Asking the master server for the list.");
  } else if (!state.masterOk) {
    box.innerHTML = stateHtml(
      "Can't load servers",
      `${esc(state.masterError)} Check the address in Settings, or start it with <code>npm run dev:master</code>.`,
      '<button type="button" class="btn btn-ghost" data-action="refresh">Try again</button>'
    );
  } else if (!all.length) {
    box.innerHTML = stateHtml(
      "No servers online",
      "Nobody is hosting right now. For testing, run <code>npm run dev:fake</code>.",
      '<button type="button" class="btn btn-ghost" data-action="refresh">Refresh</button>'
    );
  } else {
    box.innerHTML = stateHtml("No matches", "No servers match that mode or search.");
  }
}

let inFlight = null;

export function refreshServers() {
  if (inFlight) return inFlight;
  $("refresh").classList.add("spin");
  inFlight = api.servers.list().then((res) => {
    state.masterOk = res.ok;
    state.masterError = res.ok ? "" : res.error;
    state.servers = res.ok ? res.servers : [];
    emit("servers");
    if (res.ok) pingAll();
    return res;
  }).finally(() => {
    inFlight = null;
    $("refresh").classList.remove("spin");
  });
  return inFlight;
}

async function pingAll() {
  if (!state.servers.length) return;
  const targets = state.servers.map(({ id, host, port }) => ({ id, host, port }));
  state.pings = { ...state.pings, ...(await api.servers.ping(targets)) };
  emit("servers");
}

export function initServers() {
  document.querySelectorAll(".seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      renderServers();
    });
  });
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    renderServers();
  });
  $("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    emit("servers");
  });
  $("refresh").addEventListener("click", refreshServers);
}
