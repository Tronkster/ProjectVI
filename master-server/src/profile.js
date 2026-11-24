// A player's own profile and account: color, picture, whether they take friend requests,
// and deleting the account. Works for Discord and guest accounts alike.
//
//   PUT    /api/me            { color?, acceptRequests? }
//   PUT    /api/me/avatar     { type, data }   data is base64; PNG, JPEG or WebP, up to 32 KB
//   DELETE /api/me/avatar
//   DELETE /api/me            deletes the account and everything stored for it
//   GET    /avatars/<key>     a picture; keys change on every upload, so it's cached forever

const { send, readJson } = require("./http-util");

const MAX_AVATAR_BYTES = 32 * 1024;
// The launcher offers these; anything else is refused so friends never see odd colors.
const COLORS = ["#ff6a1a", "#f43f5e", "#a855f7", "#3b82f6", "#06b6d4", "#10b981", "#eab308", "#64748b"];
const TYPES = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff], "image/webp": [0x52, 0x49, 0x46, 0x46] };
const AVATAR_PATH = /^\/avatars\/([0-9a-f]{24}\.(?:png|jpeg|webp))$/;

function looksLike(type, bytes) {
  const magic = TYPES[type];
  if (!magic || bytes.length < 12 || !magic.every((b, i) => bytes[i] === b)) return false;
  return type !== "image/webp" || bytes.subarray(8, 12).toString("latin1") === "WEBP";
}

function createProfile({ db, sessionUser, publicUser, onDeleted }) {
  const me = (user) => ({ user: publicUser(user), acceptRequests: user.friend_requests_open !== 0 });

  // Returns true if it handled the request.
  async function handle(req, res, url) {
    const { pathname } = url;
    const reply = (status, payload) => {
      send(res, status, payload);
      return true;
    };

    const avatar = AVATAR_PATH.exec(pathname);
    if (avatar && req.method === "GET") {
      const row = db.avatarByKey(avatar[1]);
      if (!row) return reply(404, { error: "No such picture." });
      res.writeHead(200, {
        "Content-Type": row.avatar_type,
        "Content-Length": row.avatar_data.length,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(row.avatar_data);
      return true;
    }

    const isMe = pathname === "/api/me" && (req.method === "PUT" || req.method === "DELETE");
    const isAvatar = pathname === "/api/me/avatar";
    if (!isMe && !isAvatar) return false;

    const user = sessionUser(req);
    if (!user) return reply(401, { error: "Not logged in." });

    if (isMe && req.method === "DELETE") {
      db.deleteUser(user.id);
      onDeleted?.(user.id);
      return reply(200, { ok: true });
    }

    if (isAvatar && req.method === "DELETE") {
      db.setAvatar(user.id, null, null);
      return reply(200, me(db.userById(user.id)));
    }
    if (isAvatar && req.method !== "PUT") return reply(405, { error: "Use PUT or DELETE." });

    let body;
    try {
      body = await readJson(req, isAvatar ? 64 * 1024 : undefined);
    } catch (err) {
      return reply(400, { error: err.message });
    }

    if (isAvatar) {
      const bytes = typeof body.data === "string" ? Buffer.from(body.data, "base64") : Buffer.alloc(0);
      if (bytes.length > MAX_AVATAR_BYTES) return reply(400, { error: "Pictures can be up to 32 KB. The launcher shrinks them for you." });
      if (!looksLike(body.type, bytes)) return reply(400, { error: "Pictures must be PNG, JPEG or WebP." });
      db.setAvatar(user.id, body.type, bytes);
      return reply(200, me(db.userById(user.id)));
    }

    if ("color" in body) {
      if (body.color !== "" && !COLORS.includes(body.color)) return reply(400, { error: "Pick one of the launcher's colors." });
      db.setColor(user.id, body.color);
    }
    if ("acceptRequests" in body) {
      if (typeof body.acceptRequests !== "boolean") return reply(400, { error: "acceptRequests must be true or false." });
      db.setRequestsOpen(user.id, body.acceptRequests);
    }
    return reply(200, me(db.userById(user.id)));
  }

  return { handle };
}

module.exports = { createProfile, COLORS, MAX_AVATAR_BYTES };
