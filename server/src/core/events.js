// The server's event bus. Every runtime (C# today, other languages later) subscribes here,
// so resources in different languages can talk to each other.
//
// Local events reach every subscribed runtime. Network events (from players' clients) only reach
// runtimes that subscribed with network = true, which in C# means a [NetEvent] handler.

class EventBus {
  constructor({ log }) {
    this.log = log;
    this.local = new Map(); // name -> Map(runtime -> count)
    this.network = new Map();
    this.listeners = new Map(); // name -> Set(fn), for the core's own JavaScript code
    this.sendToClients = null; // set by the game channel: (target, name, args) => void
  }

  subscribe(runtime, name, network) {
    const map = network ? this.network : this.local;
    if (!map.has(name)) map.set(name, new Map());
    const counts = map.get(name);
    counts.set(runtime, (counts.get(runtime) ?? 0) + 1);
  }

  unsubscribe(runtime, name, network) {
    const counts = (network ? this.network : this.local).get(name);
    if (!counts?.has(runtime)) return;
    const next = counts.get(runtime) - 1;
    if (next > 0) counts.set(runtime, next);
    else counts.delete(runtime);
  }

  // Forget everything a runtime subscribed to, for example after its process crashed.
  removeRuntime(runtime) {
    for (const map of [this.local, this.network]) {
      for (const counts of map.values()) counts.delete(runtime);
    }
  }

  // Core-side listener in JavaScript.
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name)?.delete(fn);
  }

  // target: "local" | "clients" | "client:<playerId>"
  emit(name, args = [], { target = "local" } = {}) {
    if (target !== "local") {
      if (this.sendToClients) this.sendToClients(target, name, args);
      else this.log.debug?.(`Event ${name} for ${target} dropped: no players connected.`);
      return;
    }
    for (const fn of this.listeners.get(name) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        this.log.error(`Core listener for ${name} failed: ${err.message}`);
      }
    }
    for (const runtime of this.local.get(name)?.keys() ?? []) {
      runtime.dispatch(name, args, { network: false });
    }
  }

  // An event a player's client sent. Returns false if nothing on the server accepts it.
  emitFromClient(playerId, name, args) {
    const runtimes = [...(this.network.get(name)?.keys() ?? [])];
    for (const runtime of runtimes) runtime.dispatch(name, args, { network: true, source: playerId });
    return runtimes.length > 0;
  }
}

module.exports = { EventBus };
