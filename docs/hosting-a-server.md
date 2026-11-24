# Hosting a ProjectVI server

> **Status:** the server already lists itself and sends resources to players' launchers. Actual gameplay sync arrives with the ProjectVI client.

## Rules

- **Never put game files, encryption keys or emulator files in `resources/`.** Everything you list in `client_files` is sent to every player.
- Only send content you have the rights to share.

## What you need

- Node 22.13 or newer
- One open TCP port (default `30120`) if players outside your network should join

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
```

Restart the server after changing it.

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

## Opening your server to the internet

1. Forward TCP port `30120`, or whatever you set, on your router to the server's PC.
2. Allow it in the firewall.
3. Point `[master] url` at a public master server.

The master server lists your public IP automatically.
