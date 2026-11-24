// Friends: friend codes, requests, the friends list, presence (online, and on which server)
// and messages between friends.
//
// Works for Discord accounts and for guest accounts alike (see POST /auth/guest in auth.js).
// Presence lives in memory only: the launcher reports in every minute while it's open,
// and a player counts as offline two and a half minutes after their last report.

const { send, readJson } = require("./http-util");
const { normalizeFriendCode } = require("./db");

const MAX_FRIENDS = 200;
const MAX_OUTGOING = 50;
const REQUESTS_PER_HOUR = 30;
const PRESENCE_EVERY_S = 60;
const OFFLINE_AFTER_MS = 150_000;
const MAX_MESSAGE = 500;
const MESSAGES_PER_MINUTE = 30;
const MESSAGE_DAYS = 30; // older messages are deleted

const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\p{Cc}/gu, "").trim().slice(0, 32);
}

function createFriends({ db, now, sessionUser, getServer, publicUser }) {
  const presence = new Map(); // user id -> { at, serverId }
  const sent = new Map(); // user id -> { windowStart, count }, to slow down code guessing
  const messageHits = new Map(); // user id -> { windowStart, count }

  function presenceOf(userId) {
    const p = presence.get(userId);
    if (!p || now() - p.at > OFFLINE_AFTER_MS) return { online: false, server: null };
    const server = p.serverId ? getServer(p.serverId) : null;
    return { online: true, server: server ? { id: server.id, name: server.name } : null };
  }

  function person(row) {
    const { name, avatarUrl, provider } = publicUser(row);
    return { id: String(row.id), name, avatarUrl, provider };
  }

  function overview(user) {
    const unread = db.unreadCounts(user.id);
    const friends = db.friends(user.id).map((row) => ({ ...person(row), since: row.since, unread: unread.get(row.id) ?? 0, ...presenceOf(row.id) }));
    // Playing first, then online, then the rest; names within each group.
    const rank = (f) => (f.server ? 0 : f.online ? 1 : 2);
    friends.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return {
      code: formatCode(db.friendCode(user.id)),
      friends,
      incoming: db.incomingRequests(user.id).map((row) => ({ ...person(row), requestedAt: row.requested_at })),
      outgoing: db.outgoingRequests(user.id).map((row) => ({ ...person(row), requestedAt: row.requested_at }))
    };
  }

  function overLimit(userId) {
    const t = now();
    const entry = sent.get(userId);
    if (!entry || t - entry.windowStart > 3_600_000) {
      sent.set(userId, { windowStart: t, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > REQUESTS_PER_HOUR;
  }

  // Returns [status, payload].
  function sendRequest(user, codeText) {
    const code = normalizeFriendCode(codeText);
    if (!code) return [400, { error: "Friend codes look like K7QP-2M9X: 8 letters and digits." }];
    if (overLimit(user.id)) return [429, { error: "That's a lot of friend requests. Try again in an hour." }];
    const other = db.userByFriendCode(code);
    if (!other) return [404, { error: "No player has that friend code. Check it with your friend." }];
    if (other.id === user.id) return [400, { error: "That's your own friend code." }];
    if (db.areFriends(user.id, other.id)) return [409, { error: `You're already friends with ${person(other).name}.` }];
    // They already asked us: sending one back is the same as accepting.
    if (db.hasRequest(other.id, user.id)) {
      if (db.friendCount(user.id) >= MAX_FRIENDS || db.friendCount(other.id) >= MAX_FRIENDS) {
        return [409, { error: `Friend lists hold up to ${MAX_FRIENDS} players.` }];
      }
      db.makeFriends(user.id, other.id, now());
      return [200, { ok: true, result: "friends", player: person(other) }];
    }
    if (db.hasRequest(user.id, other.id)) return [200, { ok: true, result: "sent", player: person(other) }];
    if (db.outgoingCount(user.id) >= MAX_OUTGOING) {
      return [409, { error: `You have ${MAX_OUTGOING} requests waiting. Cancel some first.` }];
    }
    if (db.friendCount(user.id) >= MAX_FRIENDS) return [409, { error: `Friend lists hold up to ${MAX_FRIENDS} players.` }];
    db.addRequest(user.id, other.id, now());
    return [200, { ok: true, result: "sent", player: person(other) }];
  }

  function messageOut(row, userId) {
    return { id: String(row.id), from: row.from_id === userId ? "me" : "them", text: row.text, sentAt: row.sent_at, read: row.read_at !== null };
  }

  function overMessageLimit(userId) {
    const t = now();
    const entry = messageHits.get(userId);
    if (!entry || t - entry.windowStart > 60_000) {
      messageHits.set(userId, { windowStart: t, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > MESSAGES_PER_MINUTE;
  }

  // GET and POST /api/friends/<id>/messages. Only friends can write to each other.
  async function messages(req, res, url, user, otherId, reply, body) {
    if (!db.areFriends(user.id, otherId)) return reply(404, { error: "That player isn't on your friends list." });
    if (req.method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      const list = db.conversation(user.id, otherId, Number.isSafeInteger(after) && after > 0 ? after : 0);
      db.markRead(user.id, otherId, now()); // reading the conversation reads their messages
      return reply(200, { messages: list.map((m) => messageOut(m, user.id)) });
    }
    if (req.method !== "POST") return reply(405, { error: "Use GET or POST." });
    const [data, error] = await body();
    if (error) return reply(400, { error });
    const text = typeof data?.text === "string" ? data.text.replace(/[^\P{Cc}\n]/gu, "").trim() : "";
    if (!text) return reply(400, { error: "Write something first." });
    if (text.length > MAX_MESSAGE) return reply(400, { error: `Messages can be up to ${MAX_MESSAGE} characters.` });
    if (overMessageLimit(user.id)) return reply(429, { error: "Slow down a little: too many messages in a minute." });
    return reply(200, { message: messageOut(db.addMessage(user.id, otherId, text, now()), user.id) });
  }

  const ROUTE = /^\/api\/friends(?:\/(requests|code))?(?:\/(\d{1,15}))?(?:\/(accept|messages))?$/;

  // Returns true if it handled the request.
  async function handle(req, res, url) {
    const { pathname } = url;
    const isPresence = pathname === "/api/presence";
    const match = isPresence ? null : ROUTE.exec(pathname);
    if (!isPresence && !match) return false;

    const user = sessionUser(req);
    if (!user) {
      send(res, 401, { error: "Not logged in." });
      return true;
    }
    const reply = (status, payload) => {
      send(res, status, payload);
      return true;
    };
    const body = async () => {
      try {
        return [await readJson(req), null];
      } catch (err) {
        return [null, err.message];
      }
    };

    if (isPresence) {
      if (req.method === "DELETE") {
        presence.delete(user.id);
        return reply(200, { ok: true });
      }
      if (req.method !== "PUT") return reply(405, { error: "Use PUT or DELETE." });
      const [data, error] = await body();
      if (error) return reply(400, { error });
      const serverId = typeof data.serverId === "string" && data.serverId.length <= 300 ? data.serverId : "";
      presence.set(user.id, { at: now(), serverId });
      // Guests have no other name, so their in-game name is the one friends see.
      const name = cleanName(data.name);
      if (user.provider === "guest" && name && name !== user.display_name) db.setDisplayName(user.id, name);
      return reply(200, { ok: true, nextInSeconds: PRESENCE_EVERY_S });
    }

    const [, kind, idText, action] = match;
    const otherId = idText ? Number(idText) : null;
    if (action === "messages") {
      if (kind || !otherId) return reply(404, { error: "Not found." });
      return messages(req, res, url, user, otherId, reply, body);
    }
    const accept = action === "accept";

    if (!kind && !otherId) {
      if (req.method !== "GET") return reply(405, { error: "Use GET." });
      return reply(200, overview(user));
    }

    if (kind === "code" && !otherId && !accept) {
      if (req.method !== "POST") return reply(405, { error: "Use POST." });
      return reply(200, { code: formatCode(db.resetFriendCode(user.id)) });
    }

    if (kind === "requests" && !otherId) {
      if (req.method !== "POST") return reply(405, { error: "Use POST." });
      const [data, error] = await body();
      if (error) return reply(400, { error });
      const [status, payload] = sendRequest(user, data?.code);
      return reply(status, payload);
    }

    if (kind === "requests" && otherId && accept) {
      if (req.method !== "POST") return reply(405, { error: "Use POST." });
      if (!db.hasRequest(otherId, user.id)) return reply(404, { error: "That friend request isn't there anymore." });
      if (db.friendCount(user.id) >= MAX_FRIENDS || db.friendCount(otherId) >= MAX_FRIENDS) {
        return reply(409, { error: `Friend lists hold up to ${MAX_FRIENDS} players.` });
      }
      db.makeFriends(user.id, otherId, now());
      return reply(200, overview(user));
    }

    if (kind === "requests" && otherId && !accept) {
      if (req.method !== "DELETE") return reply(405, { error: "Use DELETE." });
      // Declines a request they sent, or cancels one we sent.
      const removed = db.deleteRequest(otherId, user.id) || db.deleteRequest(user.id, otherId);
      if (!removed) return reply(404, { error: "That friend request isn't there anymore." });
      return reply(200, overview(user));
    }

    if (!kind && otherId && !accept) {
      if (req.method !== "DELETE") return reply(405, { error: "Use DELETE." });
      if (!db.removeFriend(user.id, otherId)) return reply(404, { error: "That player isn't on your friends list." });
      return reply(200, overview(user));
    }

    return reply(404, { error: "Not found." });
  }

  function sweep() {
    const t = now();
    for (const [id, p] of presence) if (t - p.at > OFFLINE_AFTER_MS) presence.delete(id);
    for (const [id, s] of sent) if (t - s.windowStart > 3_600_000) sent.delete(id);
    for (const [id, s] of messageHits) if (t - s.windowStart > 60_000) messageHits.delete(id);
    db.deleteMessagesBefore(t - MESSAGE_DAYS * 86_400_000);
  }

  return { handle, sweep };
}

module.exports = { createFriends, MAX_FRIENDS, MAX_OUTGOING, OFFLINE_AFTER_MS };
