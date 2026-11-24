// Accounts, sessions and synced favorites, stored with Node's built-in SQLite.
// Session tokens are never stored: only their SHA-256.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SESSION_DAYS = 90;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function openDatabase(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL,
      UNIQUE (provider, provider_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL,
      PRIMARY KEY (user_id, server_id)
    );
  `);

  const q = {
    upsertUser: db.prepare(`
      INSERT INTO users (provider, provider_id, username, display_name, avatar, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, provider_id) DO UPDATE SET
        username = excluded.username, display_name = excluded.display_name,
        avatar = excluded.avatar, last_login_at = excluded.last_login_at
      RETURNING *`),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    userForToken: db.prepare(`
      SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    favorites: db.prepare("SELECT server_id FROM favorites WHERE user_id = ? ORDER BY server_id"),
    clearFavorites: db.prepare("DELETE FROM favorites WHERE user_id = ?"),
    addFavorite: db.prepare("INSERT OR IGNORE INTO favorites (user_id, server_id) VALUES (?, ?)")
  };

  return {
    upsertUser({ provider, providerId, username, displayName, avatar }, now) {
      return q.upsertUser.get(provider, providerId, username, displayName, avatar ?? null, now, now);
    },
    // Returns the raw token; only its hash is kept.
    createSession(userId, now) {
      const token = crypto.randomBytes(32).toString("base64url");
      q.insertSession.run(sha256(token), userId, now, now + SESSION_DAYS * 86_400_000);
      return token;
    },
    userForToken(token, now) {
      return token ? q.userForToken.get(sha256(token), now) ?? null : null;
    },
    deleteSession(token) {
      q.deleteSession.run(sha256(token));
    },
    deleteExpiredSessions(now) {
      q.deleteExpired.run(now);
    },
    getFavorites(userId) {
      return q.favorites.all(userId).map((row) => row.server_id);
    },
    setFavorites(userId, list) {
      db.exec("BEGIN");
      try {
        q.clearFavorites.run(userId);
        for (const id of list) q.addFavorite.run(userId, id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close()
  };
}

module.exports = { openDatabase, SESSION_DAYS };
