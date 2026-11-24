# Making mods

There are two kinds of ProjectVI content:

| | Server resources | Public mods |
| --- | --- | --- |
| Who installs it | Sent automatically by the server you join | Each player picks them in the launcher's **Mods** tab |
| Where it lives | `server/resources/<name>/` | A zip on GitHub Releases, listed in the mod registry |
| Typical use | Game modes, jobs, server HUDs | Personal UI tweaks, visuals, sounds |
| Guide | [hosting-a-server.md](hosting-a-server.md) | this page |

> **Status:** the launcher can browse, install, update and turn mods on and off. Mods run once the ProjectVI client exists. The scripting API in the examples is planned and may change.

## Rules

- **No game files, keys, emulator files or copyrighted assets you don't own.**
- No cheats that affect other players on servers.
- Pick a license (MIT, GPL-3.0-only, CC-BY-4.0 and so on) and say it in the registry entry.

## Mod layout

A mod is a zip with `mod.json` at its root:

```
clean-hud-1.1.0.zip
├── mod.json
├── hud.lua
└── ui/
    └── hud.html
```

```json
{
  "id": "clean-hud",
  "name": "Clean HUD",
  "version": "1.1.0"
}
```

- `id`: 2-64 lowercase letters, digits and dashes. It never changes.
- `version`: semver, like `1.1.0` or `2.0.0-beta.1`. It must match the registry entry.

The launcher refuses zips that contain:
- links or absolute paths
- `..` in a path
- names Windows can't store
- the same file twice
- more than 20,000 files
- more than 4 GB once unpacked

## Publishing

1. Zip your mod and attach it to a GitHub Release in your own repository.
2. Get the size and SHA-256 of the zip:

   ```sh
   # Windows PowerShell
   (Get-Item clean-hud-1.1.0.zip).Length
   (Get-FileHash clean-hud-1.1.0.zip -Algorithm SHA256).Hash.ToLower()
   # macOS / Linux
   wc -c < clean-hud-1.1.0.zip
   shasum -a 256 clean-hud-1.1.0.zip
   ```

3. Open a pull request to the registry repository that adds your entry to `index.json`. The format is in [registry.md](registry.md).
4. CI downloads your zip, checks its size, checksum and contents, and reports any problem on the pull request. A maintainer reviews it and merges it.

To release an update, add a new object to your entry's `versions` list. Launchers offer the update automatically.

## Testing locally

```sh
npm run dev:registry          # builds registry/dev/mods into zips and serves them on :30190
```

Then, in the launcher:

1. Turn on **Settings → Developer → Developer mode**.
2. Set **Settings → Mods → Mod registry** to `http://localhost:30190/index.json`.

Put your own mod folder in `registry/dev/mods/` to try it out. Its `mod.json` can also hold the `author`, `description`, `license` and `tags` the dev registry shows.

## Where installed mods go

- Files: `%APPDATA%\ProjectVI\mods\<id>\<version>\` (changeable in Settings)
- Enabled mods, in load order: `%APPDATA%\ProjectVI\mods-enabled.json`, passed to the client as `PROJECTVI_MODS`
