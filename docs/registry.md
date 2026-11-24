# Mod registry

The public mod list is one JSON file, `index.json`, in its own GitHub repository, [Tronkster/ProjectVI-mods](https://github.com/Tronkster/ProjectVI-mods) (`MODS_REPO` in `packages/shared/project.js`). Mod authors add their mods there with a pull request. The launcher reads it from:

```
https://raw.githubusercontent.com/Tronkster/ProjectVI-mods/main/index.json
```

This repo's `registry/` folder holds the format, the validator (the mods repository's CI runs it from here) and a local dev registry.

## Format

```json
{
  "version": 1,
  "mods": [
    {
      "id": "clean-hud",
      "name": "Clean HUD",
      "author": "Kai",
      "description": "A minimal speedometer and money display.",
      "license": "MIT",
      "homepage": "https://github.com/kai/clean-hud",
      "tags": ["ui", "hud"],
      "versions": [
        {
          "version": "1.1.0",
          "url": "https://github.com/kai/clean-hud/releases/download/v1.1.0/clean-hud-1.1.0.zip",
          "sha256": "3f1c…",
          "size": 48213,
          "released": "2026-11-20"
        }
      ]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `id` | 2-64 lowercase letters, digits and dashes. Unique, never changes |
| `name`, `author` | Up to 64 characters |
| `description` | Up to 300 characters |
| `license` | An SPDX id, such as `MIT`, `GPL-3.0-only` or `CC-BY-4.0` |
| `homepage` | Optional `https://` link |
| `tags` | Up to 8 short lowercase words |
| `versions` | 1-50 entries. `url` must be `https://`, `sha256` is 64 lowercase hex characters, and `size` is 1 byte to 1 GB |

The full JSON Schema is [registry/schema.json](../registry/schema.json). The rules the launcher and CI actually use live in `packages/shared/registry.js`.

## Validation

```sh
cd registry
npm run validate                                  # format only
node validate.js index.json --download            # also downloads every version and checks the zip
```

CI runs the `--download` check on every pull request. If a single entry is broken, the launcher skips that mod and still shows the rest. CI fails until it's fixed.

## Review checklist for maintainers

- The zip comes from the author's own repository, on a release tag.
- The license matches the repository.
- There are no game files, keys or other people's assets in the zip.
- The description says honestly what the mod does.
