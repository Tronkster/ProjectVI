# ProjectVI

Open-source multiplayer mod for GTA VI on PC, built for the Xbox version running through emulation. Run your own servers, script your own game modes and play with your crew.

![The ProjectVI launcher's server browser](docs/images/launcher-servers.png)

> ProjectVI is an independent community project. It is not affiliated with, endorsed by or sponsored by Rockstar Games, Take-Two Interactive or Microsoft. Players need their own copy of the game. ProjectVI never ships or links to game files, encryption keys or emulators.

## Status

| Part | State |
| --- | --- |
| Launcher: server browser, favorites, settings, profile | ✅ Works |
| Launcher: optional Discord login with favorites sync | 🟡 Works against a test Discord. Real Discord is untested until a Discord app is set up |
| Launcher: server content downloads, checked by checksum | ✅ Works |
| Launcher: public mods (browse, install, update, turn on and off) | ✅ Works with the dev registry. The public registry isn't published yet |
| Launcher: friends by friend code, online status, join a friend's server | ✅ Works. Shows the server a friend joined; in-game presence waits for the client |
| Launcher: Windows installer | ✅ Builds and runs |
| Launcher: auto-update | 🟡 Untested until the first GitHub release |
| Master server: server list, login, favorites, friends | ✅ Works |
| Game server: config, resources, content hosting, listing | ✅ Works |
| **Client mod: actually joining a game** | ❌ Not started. It needs reverse engineering of the emulated game |

The launcher prepares everything the client will need: the server address, player name, downloaded content and enabled mods. See [docs/protocol.md](docs/protocol.md).

## Quick start

You need Node 22.13 or newer.

```sh
npm install            # every package, including Electron
npm run dev:master     # master server on http://localhost:30180
npm run dev:server     # a local game server with example resources
npm run dev:launcher   # the launcher
```

Optional extras for development:

```sh
npm run dev:fake       # seven fake servers so the browser looks busy
npm run dev:registry   # example mods on http://localhost:30190/index.json
```

To use the example mods, turn on **Settings → Developer → Developer mode**, then set **Settings → Mods → Mod registry** to that address.

| Command | What it does |
| --- | --- |
| `npm test` | Runs every test |
| `npm run lint` | Runs ESLint |
| `npm run dist` | Builds `launcher/dist/ProjectVI-Setup-<version>.exe` |
| `npm run capture -w launcher` | Screenshots of the main launcher screens (set `CAPTURE_STEPS=scripts/capture-friends.js` for the Friends screens) |

## Repository layout

```
launcher/          Electron desktop app
master-server/     Server list, Discord login, favorites sync and friends (Node, no dependencies)
server/            Reference game server
registry/          Public mod registry format, validator and dev registry
packages/shared/   Rules shared by everything: names, paths, content lists, registry format
packages/zip/      Safe zip reading for mods
docs/              Guides
```

## Docs

- [Architecture](docs/architecture.md): how the pieces fit together
- [Protocol](docs/protocol.md): launcher, game server and master server APIs
- [Hosting a server](docs/hosting-a-server.md)
- [Running a master server](docs/master-server.md), including Discord login setup
- [Making mods](docs/making-mods.md) and the [mod registry](docs/registry.md)

## Before the first release

1. Create the GitHub repository and set `REPO` in [`packages/shared/project.js`](packages/shared/project.js). This turns on auto-update and the public mod registry.
2. Create the mods repository with `registry/index.json` in it, and set `MODS_REPO` in [`packages/shared/project.js`](packages/shared/project.js). This project's is [Tronkster/ProjectVI-mods](https://github.com/Tronkster/ProjectVI-mods).
3. Tag a version, for example `git tag v0.2.0 && git push --tags`. The release workflow builds the installer and publishes it.

Builds aren't code-signed yet, so Windows SmartScreen warns on first install. Choose **More info → Run anyway**.

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security problems go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Grand Theft Auto and Grand Theft Auto VI are trademarks of Take-Two Interactive Software, Inc. Xbox is a trademark of Microsoft Corporation.
