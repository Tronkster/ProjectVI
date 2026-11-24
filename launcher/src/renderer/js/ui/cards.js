// Server cards and the featured banner. Every server field is escaped.

import { esc, hash } from "../util.js";
import { state } from "../state.js";

export const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
export const ICON_PLAY = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5v13l11-6.5z" fill="currentColor"/></svg>';
const ICON_USER = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4"/></svg>';

// Each server gets its own banner, generated from its name and mode.
export function artAttrs(name, mode) {
  const h = hash(name);
  const h1 = h % 360;
  const h2 = (h1 + 120 + ((h >>> 9) % 100)) % 360;
  const kind = { Roleplay: "rp", Racing: "race" }[mode] || "free";
  return `class="art ${kind}" style="--h1:${h1};--h2:${h2}"`;
}

function pingHtml(id) {
  if (!(id in state.pings)) return '<span><i class="pd"></i>…</span>';
  const ms = state.pings[id];
  if (ms === null) return '<span title="No answer from this server"><i class="pd high"></i>—</span>';
  const cls = ms < 60 ? "good" : ms < 120 ? "mid" : "high";
  return `<span><i class="pd ${cls}"></i>${ms} ms</span>`;
}

function metaHtml(s) {
  return `<span>${ICON_USER}${s.players}/${s.maxPlayers}</span>${pingHtml(s.id)}${s.region ? `<span>${esc(s.region)}</span>` : ""}`;
}

const isFavorite = (id) => state.settings.favorites.includes(id);

export function cardHtml(s) {
  return `
    <li class="card">
      <div ${artAttrs(s.name, s.mode)}>
        <span class="tag">${esc(s.mode)}</span>
        <button class="fav-sm" type="button" data-fav="${esc(s.id)}" aria-pressed="${isFavorite(s.id)}" aria-label="Favorite ${esc(s.name)}">${ICON_STAR}</button>
      </div>
      <div class="card-body">
        <strong class="card-name">${esc(s.name)}</strong>
        <p>${esc(s.description)}</p>
      </div>
      <div class="card-foot">
        <span class="meta">${metaHtml(s)}</span>
        <button class="join-sm" type="button" data-connect="${esc(s.id)}" aria-label="Connect to ${esc(s.name)}" title="Connect">${ICON_PLAY}</button>
      </div>
    </li>`;
}

export function featuredHtml(s) {
  return `
    <div class="featured">
      <div ${artAttrs(s.name, s.mode)} aria-hidden="true"></div>
      <div class="featured-shade" aria-hidden="true"></div>
      <div class="featured-body">
        <div class="featured-info">
          <span class="tag">Most played &middot; ${esc(s.mode)}</span>
          <strong class="feat-name">${esc(s.name)}</strong>
          ${s.description ? `<p>${esc(s.description)}</p>` : ""}
          <div class="meta">${metaHtml(s)}</div>
        </div>
        <div class="featured-actions">
          <button class="fav" type="button" data-fav="${esc(s.id)}" aria-pressed="${isFavorite(s.id)}" aria-label="Favorite ${esc(s.name)}">${ICON_STAR}</button>
          <button class="btn btn-accent connect-lg" type="button" data-connect="${esc(s.id)}">${ICON_PLAY}Connect</button>
        </div>
      </div>
    </div>`;
}
