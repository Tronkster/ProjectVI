// Accounts (Discord or guest), sessions, synced favorites and friends, stored with Node's built-in SQLite.
// Session tokens are never stored: only their SHA-256.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SESSION_DAYS = 90;
const GUEST_SESSION_DAYS = 3650; // a guest has no other way back into its account
// Friend codes: 8 characters without 0, O, 1 or I. Shown as XXXX-XXXX.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function newFriendCode() {
  return [...crypto.randomBytes(8)].map((b) => CODE_ALPHABET[b & 31]).join("");
}

// Accepts "k7qp-2m9x", "K7QP 2M9X" and so on. Returns "" for anything that can't be a code.
function normalizeFriendCode(text) {
  const code = String(text ?? "").toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : "";
}

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
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE TABLE IF NOT EXISTS friends (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      since INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, id);
  `);
  // Friend codes came after the first release, so older databases get the column here.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "friend_code")) {
    db.exec("ALTER TABLE users ADD COLUMN friend_code TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users(friend_code)");
  // Profile settings, also added after the first release.
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  for (const [name, type] of [
    ["friend_requests_open", "INTEGER NOT NULL DEFAULT 1"],
    ["avatar_color", "TEXT"],
    ["avatar_key", "TEXT"],
    ["avatar_type", "TEXT"],
    ["avatar_data", "BLOB"]
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_avatar_key ON users(avatar_key)");

  const q = {
    upsertUser: db.prepare(`
      INSERT INTO users (provider, provider_id, username, display_name, avatar, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, provider_id) DO UPDATE SET
        username = excluded.username, display_name = excluded.display_name,
        avatar = excluded.avatar, last_login_at = excluded.last_login_at
      RETURNING *`),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    setRequestsOpen: db.prepare("UPDATE users SET friend_requests_open = ? WHERE id = ?"),
    setColor: db.prepare("UPDATE users SET avatar_color = ? WHERE id = ?"),
    setAvatar: db.prepare("UPDATE users SET avatar_key = ?, avatar_type = ?, avatar_data = ? WHERE id = ?"),
    avatarByKey: db.prepare("SELECT avatar_type, avatar_data FROM users WHERE avatar_key = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    userForToken: db.prepare(`
      SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    deleteOrphanGuests: db.prepare("DELETE FROM users WHERE provider = 'guest' AND id NOT IN (SELECT user_id FROM sessions)"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    setDisplayName: db.prepare("UPDATE users SET display_name = ? WHERE id = ?"),
    favorites: db.prepare("SELECT server_id FROM favorites WHERE user_id = ? ORDER BY server_id"),
    clearFavorites: db.prepare("DELETE FROM favorites WHERE user_id = ?"),
    addFavorite: db.prepare("INSERT OR IGNORE INTO favorites (user_id, server_id) VALUES (?, ?)"),

    setCode: db.prepare("UPDATE users SET friend_code = ? WHERE id = ?"),
    userByCode: db.prepare("SELECT * FROM users WHERE friend_code = ?"),
    friends: db.prepare(`
      SELECT users.*, friends.since FROM friends JOIN users ON users.id = friends.friend_id
      WHERE friends.user_id = ? ORDER BY users.display_name COLLATE NOCASE`),
    friendCount: db.prepare("SELECT COUNT(*) AS n FROM friends WHERE user_id = ?"),
    isFriend: db.prepare("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?"),
    addFriend: db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?)"),
    removeFriend: db.prepare("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"),
    incoming: db.prepare(`
      SELECT users.*, r.created_at AS requested_at FROM friend_requests r JOIN users ON users.id = r.from_id
      WHERE r.to_id = ? ORDER BY r.created_at DESC`),
    outgoing: db.prepare(`
      SELECT users.*, r.created_at AS requested_at FROM friend_requests r JOIN users ON users.id = r.to_id
      WHERE r.from_id = ? ORDER BY r.created_at DESC`),
    outgoingCount: db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?"),
    hasRequest: db.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?"),
    addRequest: db.prepare("INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)"),
    deleteRequest: db.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?"),
    addMessage: db.prepare("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?) RETURNING *"),
    // The newest `limit` messages between two players after a message id, oldest first.
    conversation: db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id > ?
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id`),
    markRead: db.prepare("UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL"),
    unread: db.prepare("SELECT from_id, COUNT(*) AS n FROM messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id"),
    deleteConversation: db.prepare("DELETE FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)"),
    deleteOldMessages: db.prepare("DELETE FROM messages WHERE sent_at < ?"),
    moveMessagesFrom: db.prepare("UPDATE messages SET from_id = ? WHERE from_id = ?"),
    moveMessagesTo: db.prepare("UPDATE messages SET to_id = ? WHERE to_id = ?"),
    // Used when a guest logs in with Discord: everything the guest had moves to the account.
    friendsOfUser: db.prepare("SELECT friend_id, since FROM friends WHERE user_id = ?"),
    requestsFrom: db.prepare("SELECT to_id, created_at FROM friend_requests WHERE from_id = ?"),
    requestsTo: db.prepare("SELECT from_id, created_at FROM friend_requests WHERE to_id = ?")
  };

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function makeFriends(a, b, now) {
    q.addFriend.run(a, b, now);
    q.addFriend.run(b, a, now);
    q.deleteRequest.run(a, b);
    q.deleteRequest.run(b, a);
  }

  function resetFriendCode(userId) {
    for (;;) {
      const code = newFriendCode();
      try {
        q.setCode.run(code, userId);
        return code;
      } catch (err) {
        if (!/UNIQUE/i.test(err.message)) throw err; // a clash in a trillion: pick another
      }
    }
  }

  return {
    upsertUser({ provider, providerId, username, displayName, avatar }, now) {
      return q.upsertUser.get(provider, providerId, username, displayName, avatar ?? null, now, now);
    },
    createGuest(displayName, now) {
      return q.upsertUser.get("guest", crypto.randomBytes(16).toString("hex"), "", displayName, null, now, now);
    },
    userById: (id) => q.userById.get(id) ?? null,
    setDisplayName: (userId, name) => q.setDisplayName.run(name, userId),
    setRequestsOpen: (userId, open) => q.setRequestsOpen.run(open ? 1 : 0, userId),
    setColor: (userId, color) => q.setColor.run(color || null, userId),
    // A new key on every upload, so a picture's address never changes what it shows.
    setAvatar(userId, type, data) {
      const key = data ? `${crypto.randomBytes(12).toString("hex")}.${type.split("/")[1]}` : null;
      q.setAvatar.run(key, data ? type : null, data ?? null, userId);
      return key;
    },
    avatarByKey: (key) => q.avatarByKey.get(key) ?? null,
    // Everything goes with the user row: sessions, favorites, friends, requests and messages.
    deleteUser: (userId) => q.deleteUser.run(userId),
    // Returns the raw token; only its hash is kept.
    createSession(userId, now, days = SESSION_DAYS) {
      const token = crypto.randomBytes(32).toString("base64url");
      q.insertSession.run(sha256(token), userId, now, now + days * 86_400_000);
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
      q.deleteOrphanGuests.run(); // a guest without a session can never be used again
    },
    getFavorites(userId) {
      return q.favorites.all(userId).map((row) => row.server_id);
    },
    setFavorites(userId, list) {
      transaction(() => {
        q.clearFavorites.run(userId);
        for (const id of list) q.addFavorite.run(userId, id);
      });
    },

    // ---- Friends ----
    friendCode: (userId) => q.userById.get(userId).friend_code || resetFriendCode(userId),
    resetFriendCode,
    userByFriendCode: (code) => q.userByCode.get(code) ?? null,
    friends: (userId) => q.friends.all(userId),
    friendCount: (userId) => q.friendCount.get(userId).n,
    areFriends: (a, b) => Boolean(q.isFriend.get(a, b)),
    incomingRequests: (userId) => q.incoming.all(userId),
    outgoingRequests: (userId) => q.outgoing.all(userId),
    outgoingCount: (userId) => q.outgoingCount.get(userId).n,
    hasRequest: (from, to) => Boolean(q.hasRequest.get(from, to)),
    addRequest: (from, to, now) => q.addRequest.run(from, to, now),
    deleteRequest: (from, to) => q.deleteRequest.run(from, to).changes > 0,
    makeFriends: (a, b, now) => transaction(() => makeFriends(a, b, now)),
    // Unfriending also deletes the conversation, for both players.
    removeFriend: (a, b) => transaction(() => {
      q.deleteConversation.run(a, b, b, a);
      return q.removeFriend.run(a, b, b, a).changes > 0;
    }),

    // ---- Messages between friends ----
    addMessage: (from, to, text, now) => q.addMessage.get(from, to, text, now),
    conversation: (a, b, afterId = 0, limit = 50) => q.conversation.all(a, b, b, a, afterId, limit),
    markRead: (reader, other, now) => q.markRead.run(now, other, reader),
    unreadCounts: (userId) => new Map(q.unread.all(userId).map((r) => [r.from_id, r.n])),
    deleteMessagesBefore: (time) => q.deleteOldMessages.run(time),

    // Moves a guest's friends and requests to the account it logged in as, then deletes the guest.
    mergeGuestInto(guestId, userId, now) {
      if (guestId === userId) return;
      transaction(() => {
        for (const { friend_id: other, since } of q.friendsOfUser.all(guestId)) {
          if (other === userId) continue;
          q.addFriend.run(userId, other, since);
          q.addFriend.run(other, userId, since);
        }
        for (const { to_id: other, created_at: at } of q.requestsFrom.all(guestId)) {
          if (other !== userId && !q.isFriend.get(userId, other)) q.addRequest.run(userId, other, at);
        }
        for (const { from_id: other, created_at: at } of q.requestsTo.all(guestId)) {
          if (other !== userId && !q.isFriend.get(userId, other)) q.addRequest.run(other, userId, at);
        }
        // Requests both ways between the same two people are a friendship.
        for (const { to_id: other } of q.requestsFrom.all(userId)) {
          if (q.hasRequest.get(other, userId)) makeFriends(userId, other, now);
        }
        q.moveMessagesFrom.run(userId, guestId);
        q.moveMessagesTo.run(userId, guestId);
        q.deleteUser.run(guestId);
      });
    },
    close: () => db.close()
  };
}

module.exports = { openDatabase, normalizeFriendCode, SESSION_DAYS, GUEST_SESSION_DAYS };
