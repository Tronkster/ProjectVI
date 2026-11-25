# Hosting a ProjectVI server

> **Status:** the server already lists itself and sends resources to players' launchers. Actual gameplay sync arrives with the ProjectVI client. Until then, `npm run dev:bots -- --server <host>:<port>` joins bots over player sync to test a server.

## Rules

- **Never put game files, encryption keys or emulator files in `resources/`.** Everything you list in `client_files` is sent to every player.
- Only send content you have the rights to share.

## What you need

- Node 22.13 or newer
- One open port (default `30120`), TCP and UDP, if players outside your network should join. TCP carries downloads; UDP carries player positions

## Start

```sh
cd server
npm install
npm start
```

You should see:

```
2 resources, 4 files for players (1 KB).
"ProjectVI Dev Server" is running on port 30120.
Listed on the master server at http://localhost:30180.
```

Press Ctrl+C to stop. The server signs off from the master server on the way out.

## server.toml

```toml
[server]
name = "My Server"          # required, up to 64 characters
description = "…"           # up to 160 characters
port = 30120                # game port; launchers download resources from it too
max_players = 32            # 1-1024
gamemode = "Roleplay"       # Roleplay, Racing, Freeroam or Other
region = "EU"
# bind = "0.0.0.0"

[master]
url = "https://list.example.com"
public = true               # false keeps the server off the list

[resources]
start = ["welcome", "hud"]  # folders in resources/, started in this order

[world]
time = "12:00"              # in-game time when the server starts
time_scale = 30             # in-game minutes per real minute (GTA V's is 30); 0 stops the clock
weather = "clear"
weather_cycle = []          # e.g. ["clear", "clouds", "rain"]: a new one from the list every weather_minutes
weather_minutes = 15
```

Restart the server after changing it.

### Time and weather

Every player sees the server's time of day and weather, not their own game's. Change them while the server runs by
typing in its window:

| Command | Does |
| --- | --- |
| `time` / `time 18:30` | Shows or sets the in-game time |
| `timescale` / `timescale 0` | Shows or sets in-game minutes per real minute; 0 stops the clock |
| `weather` / `weather rain 20` | Shows or sets the weather, blending into it over 20 seconds (30 if left out) |

Scripts can do the same through `World` (C#). Weather names are the game's, lowercased: until GTA VI's are known,
GTA V's are a good guide (`clear`, `extrasunny`, `clouds`, `overcast`, `rain`, `thunder`, `foggy`, `smog`).

## Resources

A resource is a folder in `resources/`. Its `resource.toml` says which files go to players:

```toml
description = "Simple speedometer and money display."
version = "1.0.0"
client_files = ["client.lua", "ui/*"]
```

- `*` matches within one folder, `**` matches any depth, and `?` matches one character.
- Files not listed stay on the server. Put server scripts, passwords and API keys there.
- A resource without `resource.toml` sends nothing to players.
- Hidden files (starting with `.`) and symlinks are never sent.
- File names must work on Windows. The server skips any that don't and says so when it starts.

File hashes are cached in `.projectvi/hash-cache.json`, so restarts stay fast with large resources.

## Who players are

Players who join from the launcher bring a join ticket from the master server, so the server knows their Discord or
guest identifier and `[permissions]` work. That needs the server on the list (`[master] public = true`). To turn away
players without a ticket, set:

```toml
[sync]
require_ticket = true
```

Without it, players with no ticket can still join, with no permissions.

## Opening your server to the internet

1. Forward port `30120`, or whatever you set, for both TCP and UDP on your router to the server's PC.
2. Allow it in the firewall.
3. Point `[master] url` at a public master server.

The master server lists your public IP automatically.
