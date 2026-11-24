// Saved data for resources (IStore in C#): one key-value table, keys private to each resource.
// Uses Node's built-in SQLite, stored in .projectvi/store.db next to server.toml.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MAX_VALUE_BYTES = 1024 * 1024;

class ResourceStore {
  constructor(file = ":memory:") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("CREATE TABLE IF NOT EXISTS kv (resource TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (resource, key))");
    this.q = {
      get: this.db.prepare("SELECT value FROM kv WHERE resource = ? AND key = ?"),
      set: this.db.prepare("INSERT INTO kv (resource, key, value) VALUES (?, ?, ?) ON CONFLICT (resource, key) DO UPDATE SET value = excluded.value"),
      del: this.db.prepare("DELETE FROM kv WHERE resource = ? AND key = ?"),
      keys: this.db.prepare("SELECT key FROM kv WHERE resource = ? AND key >= ? AND key < ? ORDER BY key")
    };
  }

  get(resource, key) {
    const row = this.q.get.get(resource, key);
    return row ? JSON.parse(row.value) : null;
  }

  set(resource, key, value) {
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new Error("Store values can be at most 1 MB.");
    this.q.set.run(resource, key, json);
    return true;
  }

  delete(resource, key) {
    this.q.del.run(resource, key);
    return true;
  }

  // Prefix match via a range, so "job:" never matches "jobs:" and no LIKE escaping is needed.
  keys(resource, prefix = "") {
    return this.q.keys.all(resource, prefix, `${prefix}\u{10FFFF}`).map((row) => row.key);
  }

  close() {
    this.db.close();
  }
}

module.exports = { ResourceStore };
