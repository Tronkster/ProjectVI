// Shared UI state plus a tiny event bus, so views can react to each other without importing each other.

export const state = {
  settings: null,
  info: null,
  servers: [],
  pings: {},
  masterOk: null, // null until the first answer
  masterError: "",
  mode: "All",
  query: "",
  sort: "players",
  view: "servers"
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) ?? []) fn(detail);
}
