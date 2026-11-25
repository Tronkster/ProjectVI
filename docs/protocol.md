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
| `PROJECTVI_TICKET` | a join ticket for the server (see "Join tickets" below), or empty |
| `PROJECTVI_BRIDGE_FILE` | where the emulator writes its bridge address (see [client.md](client.md)) |
| `PROJECTVI_CLIENT_LOG` | the client's log file |
| `VICTORY_BRIDGE_FILE` | the same bridge file, for the emulator (VIctory opens its bridge when it's set) |

When joining a server, the launcher also starts the ProjectVI client with the same variables
([client.md](client.md)). A plain launch from Settings starts neither the client nor a bridge.

The launcher stores server content but never runs it. Running it will be the ProjectVI client's job.

## Player sync (UDP on the game port)

`GET /projectvi/info` includes `sync: { version, port, tickRate }` when sync is on. The format is defined in
`packages/shared/sync.js`, which both sides use, and `packages/shared/test/sync-vectors.json` has an example packet
of each kind for clients written in other languages. Every packet starts with `"PV"`, the sync version (4) and a
type byte; numbers are little-endian, floats 32-bit, and packets stay under 1,200 bytes. A packet of another version
is ignored.

| Type | Direction | Contents |
| --- | --- | --- |
| `HELLO` 1 | client → server | nonce, name (8-bit length), join ticket (16-bit length, 0 for none; at most 900 bytes). Resent until answered; a repeat gets the same session |
| `WELCOME` 2 | server → client | nonce, session, player id, tick rate, server time (ms) |
| `REJECT` 3 | server → client | nonce, reason (bad name, server full, a ticket that doesn't check out) |
| `STATE` 4 | client → server | session, sequence, client time, then a player state. Every tick |
| `SNAPSHOT` 5 | server → client | tick, server time, roster version, then up to 19 × (player id, sequence, player state). Every tick, split over several packets if needed |
| `ROSTER_REQUEST` 6 | client → server | session. Sent when a snapshot's roster version changes |
| `ROSTER` 7 | server → client | roster version, page, pages, then per player: id, flags (1 host), character model hash (0: none), name |
| `BYE` 8 | client → server | session |
| `KICK` 9 | server → client | reason |
| `VEHICLE_STATE` 11 | client → server | session, sequence, vehicle id, local id, then a vehicle state. Every tick for each vehicle the client controls |
| `VEHICLES` 12 | server → client | tick, server time, then up to 22 × (vehicle id, controlling player id or 0, vehicle state). Every tick there are vehicles near the player |
| `VEHICLE_ASSIGN` 13 | server → client | local id, vehicle id. The answer to a `VEHICLE_STATE` with vehicle id 0 |
| `PING` 14 | client → server | session, client time, the client's last round trip in ms (0 before the first) |
| `PONG` 15 | server → client | the client time from `PING`, server time |
| `RELIABLE` 16 | both ways | session, acknowledgement, then reliable messages. See below |

Player state (56 bytes): position (x, y, z), velocity (x, y, z), heading in degrees (0 = north, counter-clockwise),
flags (16 bits), model hash (0: each client picks), health (16 bits), armour (8 bits), weapon hash, aim point
(x, y, z; meaningful while aiming), vehicle id (0: none), seat (0 = driver, 1 and up passengers).
Flags: 1 in vehicle, 2 moving on foot, 4 aiming, 8 dead, 16 crouched, 32 jumping, 64 ragdoll, 128 shooting,
256 swimming.

Vehicle state (48 bytes): model hash, position (x, y, z), rotation as a quaternion (x, y, z, w), velocity (x, y, z),
health (16 bits), steering (signed byte: 127 full left, -127 full right), flags (1 engine on, 2 lights, 4 siren,
8 horn, 16 destroyed, 32 stays with the host). Models and weapons are joaat hashes of their names (`joaat` in
`@projectvi/shared`).

Server rules:

- Packets after `HELLO` must carry the session and come from the address that joined; anything else is ignored.
- States with an older sequence (16-bit, wrapping), non-finite numbers, coordinates beyond ±50,000 or speeds over
  250 m/s are dropped, and so are vehicle states whose rotation isn't close to a unit quaternion. Up to 90 player
  states and 1,000 vehicle states a second per player; 5 `HELLO`s a second per IP; one `PING` every 200 ms.
- Players only receive others, and vehicles, within `[sync] stream_radius` (500 m by default). A player silent for
  `timeout_seconds` (10) is dropped and sent `KICK`.
- Only `RELIABLE` packets are resent when lost; everything else is replaced by the next tick's.
- A player's identifier comes from their join ticket (`discord:<id>` or `guest:<id>`). Without one, it's only
  `session:<hex>`, which matches no `[permissions]` group. See "Join tickets".
- Movement: between two accepted states a player can't move farther than 250 m/s allows, plus 20 m. A bigger jump
  is refused; if the client keeps reporting the new place for 3 seconds, it's accepted, so a teleport the server
  doesn't know about still resyncs. The first state after being dead is never a jump (respawns).
- Seats: a claimed seat must be in a vehicle the server knows, at most seat 15, within 25 m of the vehicle, and not
  taken (the driver's seat by another driver, any other by another player). An impossible claim is relayed as on
  foot.
- Refused jumps and seat claims raise `playerSuspicious` (`Player player, string kind, details`) for scripts, at most
  once per kind per player every 5 seconds. `kind` is `teleport` (`{ distance, seconds }`) or `seat`
  (`{ vehicle, seat, problem }`). The server only refuses the state; what else to do is up to scripts.
- A player's seat changing raises `playerLeftVehicle` and/or `playerEnteredVehicle` (`Player player, int vehicleId,
  int seat`). A player who leaves the server while seated gets `playerLeftVehicle` before `playerLeft`.
- The round trip a client reports in `PING` is what scripts get from `player.ping`. It's for display: a client
  can report anything.

Host and characters (milestone A: everyone in one world as the story's characters, story scripts off):

- The player who joined first is the host. When the host leaves, the player who has been connected longest takes
  over. Later, only the host's game will run the story.
- A vehicle can stay with the host: the host's game simulates it wherever it is, unless a player is driving it, and
  it moves to the next host when the host leaves. It's never removed for being idle. The host's client sets this by
  registering a vehicle with flag 32 (a mission's car); the flag is ignored from other players. Scripts set it with
  `vehicle.setStaysWithHost`. Mission characters and objects will work the same way once they're synced.
- The server gives out `[sync] characters` (`["lucia", "jason"]` by default) in join order: the first player gets
  the first character. A character freed by someone leaving goes to the earliest player without one. Players beyond
  the list get 0 and keep their own look.
- Both travel in `ROSTER`, which changes version whenever they change. A client switches its own player to its
  character, and if the game keeps the other character around as an AI companion, removes that companion and uses
  the other player in its place, so nobody sees two of the same character.
- In relayed player states, the server replaces the reported model with the player's character, so everyone draws
  them the same way. Scripts get both from `player.character` and `player.isHost`.

Vehicles:

- Every vehicle has a 16-bit id. Ids count up and wrap, skipping ones in use, so a removed vehicle's id isn't
  reused soon. Scripts spawn vehicles with `entities.spawnVehicle`; clients register their own (a parked car the
  player got into) by sending `VEHICLE_STATE` with vehicle id 0 and a local id of their choosing (1-65535). The
  server answers every such packet with `VEHICLE_ASSIGN`, so a lost answer is fixed by the next packet. A player can
  have 8 registered vehicles; a registered vehicle nobody has been within the stream radius of for 60 s is removed.
  Script vehicles stay until the script removes them or its resource stops.
- Each vehicle is simulated by one client, its controller, shown in `VEHICLES`. Only the controller's
  `VEHICLE_STATE` for it is accepted; sequence numbers are per vehicle and start over when the controller changes.
- A player whose `STATE` has the in-vehicle flag, a vehicle id and seat 0 claims the driver's seat. The first claim
  of a free seat wins, and the driver controls the vehicle. An empty vehicle stays with its controller while they're
  within 150 m of it, then goes to the nearest player in range, or nobody.

## Join tickets

A join ticket proves to a game server who a player is. The master server signs it for one listed server; the
launcher asks for one as it starts the game and passes it in `PROJECTVI_TICKET`; the client sends it in `HELLO`.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `POST` 🔒 | `/api/join-ticket` | `{ serverId }` | `{ ticket, expiresAt }`. 404 if the server isn't on the list. 30 a minute per account |
| `GET` | `/api/ticket-key` | | `{ algorithm: "Ed25519", publicKey, keyId }`. `publicKey` is SPKI DER in base64 |

- A ticket is `v1.<payload>.<signature>`, both base64url. The payload is JSON: `aud` (the server's id on the master
  server, `ip:port` as the master server sees it), `sub` (`discord:<id>` or `guest:<id>`), `name`, `iat`, `exp`
  (two minutes later; Unix seconds) and `jti` (random). The signature is Ed25519 over the ASCII of `v1.<payload>`.
- Any account works, guests included: the launcher uses the Discord login if there is one, otherwise the friends
  guest account. The master server keeps its signing key in `data/ticket-key.pem` (or `TICKET_KEY_FILE`).
- A game server fetches the key at start, and learns its own id from the heartbeat answer. It accepts a ticket only
  if the signature is good, `aud` is its own id, it hasn't expired (30 s of clock difference allowed) and its `jti`
  hasn't been used. So a server can't collect tickets and replay them on another server, and a copied ticket can't
  join twice.
- With a valid ticket, the player's identifier is `sub`, so `[permissions]` in `server.toml` apply. A player with
  that identifier who is already on the server is replaced (a crash, a second PC).
- A ticket that doesn't check out gets `REJECT` with the reason. No ticket is fine unless the server sets
  `[sync] require_ticket = true`; the player then only has a session identifier. Unlisted servers (`[master] public =
  false`) can't check tickets, because the master server only issues them for servers on its list.

## Reliable messages

Chat, script events and notices must arrive, so they go over a reliable, ordered stream: one each way per session,
carried in `RELIABLE` packets on the same port. `packages/shared/reliable.js` implements it for both sides.

`RELIABLE` packet: session (the server sends the client's own), ack (the next message number the sender of this
packet expects), ack bits (bit *i* set: message ack + 1 + *i* has arrived too), count, then per message: number
(16 bits, wrapping), flags (1: more fragments of the same message follow), length (16 bits), payload. A packet with
no messages is just an acknowledgement.

- **Sending:** messages are numbered in order. A message bigger than 1,000 bytes is split into fragments, each a
  message of its own; ordered delivery keeps them together. At most 256 messages are in flight. Anything not
  acknowledged is resent after the measured round trip plus four times its variation (300 ms before the first
  measurement, 100 ms to 2 s), doubling for each further resend. Only messages sent once count towards the round
  trip.
- **Receiving:** acknowledge as soon as a packet with messages arrives, duplicates included, and once more on the
  next tick, so a single lost acknowledgement doesn't cause a resend or inflate the measured round trip. Hold messages that
  arrive early (up to 256 ahead) and deliver in order.
- **Limits:** a message is at most 64 KB once put back together. More than 256 KB waiting for acknowledgement, or a
  bigger message, drops the session (`KICK` from the server).
- `KICK` is sent outside the stream, because the session is dropped straight after. A notice queued just before a
  kick may never arrive.

Payload kinds, the first byte of a message:

| Kind | Direction | Contents |
| --- | --- | --- |
| `CHAT` 1 | both ways | player id (16 bits; 0 from a client), text (16-bit length, at most 500 characters) |
| `EVENT` 2 | both ways | name (8-bit length), then the arguments as a JSON array |
| `NOTICE` 3 | server → client | text (16-bit length) |
| `WORLD` 4 | server → client | server time (ms), clock (in-game seconds after midnight, float), scale (in-game seconds per real second, float; 0 stopped), transition (seconds, float), weather (8-bit length) |

Server rules for what clients send:

- **Chat:** a line starting with `/` runs that command as the player (permissions are checked) and the reply comes
  back as a notice. Any other line goes to scripts as `playerChat` (`Player player, string message`) and to every
  player, the sender included. 5 lines a second on average, in bursts of up to 10 (messages held up by a lost
  packet arrive together); beyond that, lines are dropped and the player gets a notice.
- **Events** go only to `[NetEvent]` handlers, with the player as the source. Names are 1-64 letters, digits and
  `_ . : -`; events are at most 16 KB, 50 a second on average in bursts of up to 100; arguments that contain `{"$player": …}` are refused, so a
  client can't hand a script some other player.
- **Events for players:** scripts emit them with a client target (one player or all). An event bigger than 16 KB
  isn't sent.
- **Chat from scripts:** `chat.send` sends a line to one player or everyone, as `CHAT` with player id 0 (the server).
- **Clock and weather:** the server sends `WORLD` to each player as they join (transition 0) and to everyone whenever
  the time, time scale or weather changes. The clock was `clock` at `serverTime` and keeps running at `scale`, so
  clients work out the current time themselves; nothing is sent while it simply runs.

Client side. `packages/shared/sync-client.js` is the reference client: the bots (`npm run dev:bots`) use it, and the
game client should behave the same way.

- Resend `HELLO` every 500 ms, up to 10 times, with the same nonce.
- Render others two snapshot intervals in the past (at least 100 ms). Blend vehicle rotations the short way round
  (flip one quaternion when their dot product is negative) and hold the rotation when extrapolating.
- Estimate the server clock as local time plus the largest (snapshot server time − local arrival time) of the last
  40 snapshots: the packet that waited least. Use this clock for drawing, not one corrected by the round trip,
  which would leave nothing to blend towards whenever the one-way delay is longer than the render delay.
- Send `ROSTER_REQUEST` when a snapshot's roster version differs from the roster you have. Pages can arrive in any
  order, and the answer may be for a newer version than the one asked for. Ask again after 1 s if a page is missing.
- Drop a player or vehicle missing from updates for 1 s (out of range or gone). A known vehicle id that arrives with
  another model is a different vehicle: remove the old one and spawn the new one. Give up on the server after 10 s of
  silence.
- Simulate and report the vehicles `VEHICLES` says you control; draw the rest. Don't spawn a second copy of a vehicle
  you registered: `VEHICLE_ASSIGN` tells you which id is yours.
- Show the server's time and weather, never your own game's: on `WORLD`, set the clock and keep it running at
  `scale` (`gameTime()` in the reference client). Blend into the weather over `transition` seconds only when its name
  changed: a `WORLD` sent because the time changed must not cut a blend in progress short.
- When the roster gives you a character, switch your player to it (0: keep your own look). Run the story only while
  you are the host.
- Send reliable messages, acknowledgements and resends with every `STATE`, as soon as a message is queued, and as
  soon as a `RELIABLE` packet with messages arrives.
- Send `PING` once a second and `BYE` when leaving.
