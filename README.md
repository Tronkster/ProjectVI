<a id="readme-top"></a>

<div align="center">

<img src="docs/images/banner.svg" alt="ProjectVI: open-source multiplayer for GTA VI on PC" width="100%">

<p>
  <a href="https://github.com/Tronkster/ProjectVI/actions/workflows/ci.yml"><img src="https://github.com/Tronkster/ProjectVI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Tronkster/ProjectVI/releases/latest"><img src="https://img.shields.io/github/v/release/Tronkster/ProjectVI?color=ff6b1a&label=release" alt="Latest release"></a>
  <a href="https://github.com/Tronkster/ProjectVI/releases"><img src="https://img.shields.io/github/downloads/Tronkster/ProjectVI/total?color=ff6b1a" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.13 or newer">
  <img src="https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white" alt=".NET 10">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p>
  <a href="https://github.com/Tronkster/ProjectVI/releases/latest"><b>Download</b></a> ·
  <a href="docs/hosting-a-server.md"><b>Host a server</b></a> ·
  <a href="docs/making-mods.md"><b>Make mods</b></a> ·
  <a href="docs/protocol.md"><b>Protocol</b></a> ·
  <a href="docs/roadmap.md"><b>Roadmap</b></a>
</p>

<img src="docs/images/launcher-servers.png" alt="The ProjectVI launcher's server browser" width="100%">

</div>

<br>

> [!IMPORTANT]
> ProjectVI is an independent community project. It is not affiliated with, endorsed by or sponsored by Rockstar Games, Take-Two Interactive or Microsoft. Players need their own copy of the game. ProjectVI never ships or links to game files, encryption keys or emulators, and never connects to Rockstar's or Xbox Live's online services.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Screenshots](#screenshots)
- [Status](#status)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Testing without the game](#testing-without-the-game)
- [Development](#development)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Overview

GTA VI on PC means the Xbox Series version running through emulation, and it only has the story mode. ProjectVI adds multiplayer on top of it. Every player runs their own copy of the game; ProjectVI keeps the parts they share in step. Today that is players, vehicles, roles, chat, script events, the time of day and the weather. Next comes, step by step, the story itself.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🚀 Launcher

- Server browser with favorites, ping, game-mode filters and search
- Friends by friend code, with online status and "join my server"
- Server content downloads, verified by checksum and shared between servers
- Public mod library: browse, install, update, turn on and off
- Windows installer with automatic updates

</td>
<td width="50%" valign="top">

### 🖥️ Game server

- One TOML file for configuration
- Resources scripted in C#, with commands, permissions, exports, storage and events
- Hosts each resource's files for players' launchers
- Lists itself on the master server

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔄 Player sync

- Player and vehicle state over UDP, up to 60 updates a second, smoothed on arrival
- Vehicle ids from the server, one client simulating each vehicle, hand-over between players
- A host role, and the story's characters (Lucia and Jason) given out so nobody sees two of the same
- A reliable channel for chat, `/commands`, notices and script events
- The time of day and weather decided by the server, with an optional weather cycle

</td>
<td width="50%" valign="top">

### 🧪 Testing without the game

- Bots that join any server, walk, drive and chat
- A live map of what a bot sees, and simulated packet loss
- A reference client in Node, and example packets for every message, for porting the client to C++

</td>
</tr>
</table>

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/images/launcher-join.png" alt="Joining a server: the launcher asks before downloading the server's content"></td>
<td width="50%"><img src="docs/images/launcher-mods.png" alt="The mod library"></td>
</tr>
<tr>
<td align="center"><sub>Joining a server: content is checked against the server's checksums</sub></td>
<td align="center"><sub>The mod library</sub></td>
</tr>
</table>

## Status

| Area | Status |
| --- | --- |
| Launcher: server browser, favorites, settings, profile | ✅ Works |
| Launcher: server content downloads | ✅ Works |
| Launcher: public mods | ✅ Works with the dev registry; the public registry isn't published yet |
| Launcher: friends, online status, join a friend's server | ✅ Works; in-game presence waits for the game client |
| Launcher: Windows installer and auto-update | ✅ Works; published on GitHub Releases |
| Launcher: optional Discord login | ❌ Discontinued |
| Master server: server list, login, favorites, friends | ✅ Works |
| Game server: config, resources, C# scripting, content hosting, listing | ✅ Works |
| Player sync: players, vehicles, host and characters | ✅ Server and reference client, tested with bots |
| Reliable messages: chat, commands, notices, script events | ✅ Server and reference client, tested at 20% packet loss |
| Time of day and weather | ✅ Server, scripts (C#), console and reference client |
| Game client: a program beside the emulator, joining the server and driving the game through VIctory's bridge | ✅ Joins, syncs and leaves; the launcher starts it ([docs/client.md](docs/client.md)) |
| **The game side: reading the player and showing others in GTA VI** | ❌ Needs the emulator's game operations, which need reverse engineering, and the game to render |

## How it works

```mermaid
flowchart LR
  subgraph PC["Player's PC"]
    L["Launcher"]
    E["Emulator + GTA VI<br/>+ ProjectVI client"]
  end
  M["Master server"]
  G["Game server"]
  R["Mod registry"]

  G -- "heartbeat" --> M
  L -- "server list, friends" --> M
  L -- "server info and content" --> G
  L -- "mods" --> R
  L -- "starts the game" --> E
  E <-- "player sync (UDP)" --> G
```

- **The launcher** finds a server, downloads its content and the player's mods, then starts the game with the server's address.
- **The game server** owns what everyone must agree on: who is playing, who is host, which character each player is, every vehicle and who simulates it. It relays player state to whoever is near, and runs the resources' C# scripts.
- **The game client**, once it exists, reports the local player and the vehicles it simulates, and draws everyone else as characters driven by the network.

Details: [architecture](docs/architecture.md) and [protocol](docs/protocol.md).

## Getting started

You need [Node.js](https://nodejs.org) 22.13 or newer, and the [.NET 10 SDK](https://dotnet.microsoft.com/download) for C# scripting.

```sh
git clone https://github.com/Tronkster/ProjectVI.git
cd ProjectVI
npm install            # every package, including Electron
npm run build:scripting

npm run dev:master     # master server on http://localhost:30180
npm run dev:server     # a local game server with example resources
npm run dev:launcher   # the launcher
```

To use the example mods, run `npm run dev:registry`, turn on **Settings → Developer → Developer mode**, then set **Settings → Mods → Mod registry** to `http://localhost:30190/index.json`. `npm run dev:fake` adds seven pretend servers so the browser looks busy.

To host a real server, see [Hosting a server](docs/hosting-a-server.md).

## Testing without the game

Bots exercise sync the way the game client will: each one is a full client with its own connection.

```sh
npm run dev:server
npm run dev:bots -- --count 20 --view 30125 --chat 5 --loss 10
```

That joins 20 bots that walk and drive near the spawn point, chat every 5 seconds over a link that loses 10% of packets, and serves a live map of what the first bot sees on http://127.0.0.1:30125. The status line reports what each bot sees, missed updates, round trip and how much chat arrived. All options are at the top of [`server/scripts/bots.js`](server/scripts/bots.js).

## Development

<p>
  <img src="https://skillicons.dev/icons?i=nodejs,electron,cs,dotnet,githubactions" alt="Built with Node.js, Electron, C#, .NET and GitHub Actions">
</p>

| Command | What it does |
| --- | --- |
| `npm test` | Runs every test (Node and .NET) |
| `npm run lint` | Runs ESLint |
| `npm run build:scripting` | Builds the C# script host |
| `npm run dist` | Builds `launcher/dist/ProjectVI-Setup-<version>.exe` |
| `npm run capture -w launcher` | Screenshots of the main launcher screens |

<details>
<summary><b>Repository layout</b></summary>

```
launcher/          Electron desktop app
client/            Game client: runs beside the emulator, joins the server, drives the game through the bridge
master-server/     Server list, friends and favorites (Node, no dependencies)
server/            Reference game server, and the bots (server/scripts/bots.js)
scripting/dotnet/  C# scripting: SDK, script host and test helpers
registry/          Public mod registry format, validator and dev registry
packages/shared/   Shared by everything: sync protocol, reference client, names, paths, content lists
packages/zip/      Safe zip reading for mods
docs/              Guides and reference
```

</details>

<details>
<summary><b>Releasing</b></summary>

Tag a version, for example `git tag v0.5.0 && git push --tags`. The Release workflow builds the installer and publishes it on GitHub Releases, where installed launchers find it. Builds aren't code-signed yet, so Windows SmartScreen warns on first install (**More info → Run anyway**).

</details>

## Documentation

| Guide | For |
| --- | --- |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [Protocol](docs/protocol.md) | Launcher, master server and game server APIs, and player sync |
| [Hosting a server](docs/hosting-a-server.md) | Server owners |
| [Running a master server](docs/master-server.md) | Running your own server list |
| [Making mods](docs/making-mods.md) and the [mod registry](docs/registry.md) | Mod authors |
| [Client reverse engineering](docs/client-reverse-engineering.md) | Contributors working on the game client |
| [Roadmap and todo](docs/roadmap.md) | What's left, item by item |

## Roadmap

1. **One world (milestone A).** Everyone in the same world as the story's characters, with the story switched off. Player and vehicle sync, roles, chat, events, time and weather are done; damage and join tickets are next.
2. **The game client.** A program beside the emulator that runs the same protocol and drives the game through the emulator's bridge ([docs/client.md](docs/client.md)). The client and bridge exist; the game operations behind the bridge wait for reverse engineering and for the game to render under the emulator.
3. **A shared story (milestone B).** The host's game runs the story; mission characters, vehicles and events stream to the other players, and progress comes from the host's save.

The full list, including the reverse-engineering work, is in [docs/roadmap.md](docs/roadmap.md).

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md) first. Report security problems privately as described in [SECURITY.md](SECURITY.md).

<a href="https://github.com/Tronkster/ProjectVI/graphs/contributors"><img src="https://contrib.rocks/image?repo=Tronkster/ProjectVI" alt="Contributors"></a>

## License

[MIT](LICENSE). Grand Theft Auto and Grand Theft Auto VI are trademarks of Take-Two Interactive Software, Inc. Xbox is a trademark of Microsoft Corporation.

<p align="right"><a href="#readme-top">Back to top ↑</a></p>
