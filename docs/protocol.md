# ProjectVI protocol

How the launcher, game servers and the master server talk to each other. Protocol version: **1**.

```
 game server ──heartbeat every 30 s──▶ master server ◀──server list── launcher
      ▲                                                                   │
      └──────────── info, content list and files over HTTP ───────────────┘
```

## Master server

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| `GET` | `/api/servers` | | `{ servers: [...], updatedAt }`, most players first |
| `POST` | `/api/heartbeat` | see below | `{ ok, id, nextHeartbeatInSeconds }` |
| `DELETE` | `/api/heartbeat` | `?port=30120` | `{ ok }` |
| `GET` | `/health` | | `{ ok: true }` |

Heartbeat body:

```json
{ "port": 30120, "name": "My Server", "description": "…", "mode": "Roleplay",
  "region": "EU", "players": 12, "maxPlayers": 64 }
```

- The host is taken from the connection, so a server can only list itself.
- Servers that miss heartbeats for 90 seconds drop off. Each IP can send 60 heartbeats a minute.
- `mode` is `Roleplay`, `Racing`, `Freeroam` or `Other`.

## Accounts and friends (master server)

Calls marked 🔒 need `Authorization: Bearer <token>`. A token comes from Discord login (see [master-server.md](master-server.md)) or from a guest account, so friends work for every player.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `POST` | `/auth/guest` | `{ name }` | `{ token, user }`. 10 per IP an hour. Guest sessions last 10 years |
| `POST` | `/auth/exchange` | `{ code, verifier, guestToken? }` | With `guestToken`, the guest's friends and requests move to the Discord account and the guest is deleted |
| `GET` 🔒 | `/api/friends` | | `{ code, friends, incoming, outgoing }` |
| `POST` 🔒 | `/api/friends/requests` | `{ code }` | `{ ok, result: "sent" | "friends", player }` |
| `POST` 🔒 | `/api/friends/requests/<id>/accept` | | the same as `GET /api/friends` |
| `DELETE` 🔒 | `/api/friends/requests/<id>` | | declines their request or cancels yours; same answer |
| `DELETE` 🔒 | `/api/friends/<id>` | | removes the friend on both sides; same answer |
| `POST` 🔒 | `/api/friends/code` | | `{ code }`: a new friend code. The old one stops working |
| `GET` 🔒 | `/api/friends/<id>/messages` | `?after=<message id>` | `{ messages }`: the newest 50 (after that id), oldest first. Marks theirs as read |
| `POST` 🔒 | `/api/friends/<id>/messages` | `{ text }` | `{ message }` |
| `GET` 🔒 | `/api/me` | | `{ user, acceptRequests }` |
| `PUT` 🔒 | `/api/me` | `{ color?, acceptRequests? }` | the same. `color` is `""` or one of the 8 launcher colors |
| `PUT` 🔒 | `/api/me/avatar` | `{ type, data }` | the same. PNG, JPEG or WebP as base64, up to 32 KB. The launcher sends a 128 px WebP |
| `DELETE` 🔒 | `/api/me/avatar` | | the same |
| `DELETE` 🔒 | `/api/me` | | `{ ok }`: deletes the account with its friends, requests, messages, favorites and picture |
| `GET` | `/avatars/<key>` | | the picture. Keys change with every upload, so it can be cached forever |
| `PUT` 🔒 | `/api/presence` | `{ name?, serverId? }` | `{ ok, nextInSeconds: 60 }` |
| `DELETE` 🔒 | `/api/presence` | | `{ ok }`: shows as offline right away |

A player in these lists is `{ id, name, avatarUrl, color, provider }`. `avatarUrl` is an uploaded picture (`/avatars/<key>`, relative to the master server), else a Discord picture, else `""`; `color` is the background for the player's initials. The launcher fetches `/avatars/` pictures in its main process and hands them to its page as `data:` URLs. Friends also have `since`, `unread` (messages from them not read yet), `online` and `server` (`{ id, name }` or `null`); requests have `requestedAt`. Friends are sorted playing, then online, then offline.

- Friend codes are 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, shown as `K7QP-2M9X`. Case, spaces and dashes are ignored when typed. There's no search by name.
- Sending a request to someone who already asked you makes you friends straight away.
- A player who turned off `acceptRequests` gets no new requests (403), but can still send them and accept replies.
- "Appear offline" is a launcher setting: the launcher sends `DELETE /api/presence` instead of reporting.
- Limits: 200 friends, 50 requests waiting, 30 requests sent an hour.
- The launcher reports presence every 60 seconds while it's open and the player has a friends account, with `serverId` set while the emulator runs for a server, unless the player turned off "Show friends which server I'm on" in Settings. A player counts as offline 150 seconds after the last report. `server` is only shown for servers on the master server's list, so a friend's server can be joined with the normal join flow. Presence is kept in memory, never stored.
- A message is `{ id, from: "me" | "them", text, sentAt, read }`. Only friends can write to each other. Up to 500 characters, 30 a minute. Messages are deleted after 30 days, and removing a friend deletes the conversation for both. The launcher checks for new messages every 3 seconds while a conversation is open.
- A guest's `name` is the in-game name it last reported. Discord players show their Discord display name.

## Game server (HTTP on the game port)

### `GET /projectvi/info`

```json
{ "name": "My Server", "protocol": 1, "contentBytes": 1353, "fileCount": 4, "players": 0, "maxPlayers": 32 }
```

If `protocol` doesn't match, the launcher refuses to join and tells the player which side needs updating.

### `GET /projectvi/manifest`

The files players need, grouped by resource:

```json
{ "resources": [
  { "name": "hud", "files": [
    { "path": "client.lua", "size": 325, "sha256": "85d2b2…" },
    { "path": "ui/index.html", "size": 512, "sha256": "c676af…" }
  ] }
] }
```

Rules the launcher enforces before downloading anything:

- `path` is relative with forward slashes. No `..`, no drive letters, no `:` or `\`, at most 200 characters, and no names Windows can't store.
- Resource names are letters, digits, `_` and `-`, up to 64 characters.
- At most 500 resources, 10,000 files and 2 GB per file.

### `GET /projectvi/files/<sha256>`

The file's bytes. Files are addressed by hash, so they can be cached forever.

## Launcher side

1. Fetch `info` and `manifest` and check them against the rules above.
2. Compare against the cache at `<cache>/content/<first two hash chars>/<sha256>`. Files are shared between servers.
3. Download what's missing. Each download is hashed while it streams, stops as soon as it goes over its declared size, and is thrown away on a checksum mismatch.
4. Write `<cache>/servers/<key>/manifest.json`, where `<key>` is the first 16 hex characters of SHA-256(`host:port`). It holds the same resources, plus each file's absolute `file` path in the cache.
5. Start the emulator with these environment variables:

| Variable | Value |
| --- | --- |
| `PROJECTVI_SERVER` | `host:port` |
| `PROJECTVI_PLAYER` | in-game name |
| `PROJECTVI_MASTER` | master server address |
| `PROJECTVI_CONTENT` | path to the file from step 4 |
| `PROJECTVI_MODS` | path to the enabled public mods list (see [making-mods.md](making-mods.md)) |

The launcher stores server content but never runs it. Running it is the ProjectVI client's job.

## Player sync (UDP on the game port)

`GET /projectvi/info` includes `sync: { version, port, tickRate }` when sync is on. The format is defined in
`packages/shared/sync.js`, which both sides use. Every packet starts with `"PV"`, the sync version (1) and a type
byte; numbers are little-endian, floats 32-bit, and packets stay under 1,200 bytes.

| Type | Direction | Contents |
| --- | --- | --- |
| `HELLO` 1 | client → server | nonce, name. Resent until answered; a repeat gets the same session |
| `WELCOME` 2 | server → client | nonce, session, player id, tick rate, server time (ms) |
| `REJECT` 3 | server → client | nonce, reason (bad name, server full) |
| `STATE` 4 | client → server | session, sequence, client time, then the state below. Every tick |
| `SNAPSHOT` 5 | server → client | tick, server time, roster version, then up to 31 × (player id, sequence, state). Every tick, split over several packets if needed |
| `ROSTER_REQUEST` 6 | client → server | session. Sent when a snapshot's roster version changes |
| `ROSTER` 7 | server → client | roster version, page, pages, then (player id, name) pairs |
| `BYE` 8 | client → server | session |
| `KICK` 9 | server → client | reason |
| `NOTICE` 10 | server → client | text to show the player |

State: position (x, y, z), velocity (x, y, z), heading in degrees, flags (1 in vehicle, 2 moving on foot,
4 aiming, 8 dead), vehicle model hash, seat.

Server rules:

- Packets after `HELLO` must carry the session and come from the address that joined; anything else is ignored.
- States with an older sequence (16-bit, wrapping), non-finite numbers, coordinates beyond ±50,000 or speeds over
  250 m/s are dropped. Up to 90 states a second per player; 5 `HELLO`s a second per IP.
- Players only receive others within `[sync] stream_radius` (500 m by default). A player silent for
  `timeout_seconds` (10) is dropped and sent `KICK`.
- Nothing on this channel is reliable. Identity isn't verified yet: a player's only identifier is `session:<hex>`.
- Clients should render others about 100 ms in the past and interpolate; `createInterpolator` in the same file
  does this.

Client side. `packages/shared/sync-client.js` is the reference client: the bots (`npm run dev:bots`) use it, and the
game client should behave the same way.

- Resend `HELLO` every 500 ms, up to 10 times, with the same nonce.
- Render others two snapshot intervals in the past (at least 100 ms).
- Estimate the server clock as local time plus the largest (snapshot server time − local arrival time) of the last
  40 snapshots: the packet that waited least.
- Send `ROSTER_REQUEST` when a snapshot's roster version differs from the roster you have. Pages can arrive in any
  order, and the answer may be for a newer version than the one asked for. Ask again after 1 s if a page is missing.
- Drop a player missing from snapshots for 1 s (out of range or gone). Give up on the server after 10 s of silence.
- Send `BYE` when leaving.
