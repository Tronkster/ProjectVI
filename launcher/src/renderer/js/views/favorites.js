import { $ } from "../util.js";
import { state } from "../state.js";
import { cardHtml } from "../ui/cards.js";
import { sorted, stateHtml } from "./servers.js";

export function renderFavorites() {
  const favs = state.settings.favorites;
  const online = sorted(state.servers.filter((s) => favs.includes(s.id)));
  $("fav-sub").textContent = favs.length ? `${online.length} of ${favs.length} online` : "Servers you star show up here.";
  $("fav-cards").innerHTML = online.map(cardHtml).join("");

  const box = $("fav-state");
  box.hidden = online.length > 0;
  box.innerHTML = favs.length
    ? stateHtml("None of your favorites are online", "They show up here as soon as they report in.")
    : stateHtml("No favorites yet", "Star a server in the browser to keep it here.");
}
