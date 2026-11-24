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
