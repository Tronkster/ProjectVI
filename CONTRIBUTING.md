# Contributing to ProjectVI

Thanks for helping. This guide covers setup, how the repo is organized and what a good pull request looks like.

## Ground rules

- **Never commit game files, encryption keys, emulator files or copyrighted assets.** Not in code, tests, issues or pull requests. Pull requests that include them are closed.
- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

You need Node 22.13 or newer and Git.

```sh
git clone https://github.com/OWNER/REPO.git projectvi
cd projectvi
npm install          # installs every workspace, including Electron
npm test             # runs all tests
npm run lint
```

Run the pieces in separate terminals:

```sh
npm run dev:master   # master server on http://localhost:30180
npm run dev:fake     # optional: test servers for the browser
npm run dev:launcher # the launcher
```

## Repo layout

| Folder | What it is |
| --- | --- |
| `packages/shared` | Constants and validators used by everything else |
| `packages/zip` | Safe zip reading for mods, and a tiny zip writer for tests |
| `launcher` | Electron desktop app. `src/main` is the main process, `src/renderer` the UI, `src/preload.js` the bridge |
| `master-server` | Server list, Discord login and favorites sync |
| `server` | Reference game server |
| `registry` | Mod registry format, validator and dev registry |
| `docs` | Architecture, protocol, hosting and modding guides |

[docs/architecture.md](docs/architecture.md) explains how the pieces talk to each other.

For UI changes, `npm run capture -w launcher` saves screenshots of the main screens. Add them to your pull request.

## Code style

- Plain JavaScript, CommonJS in Node code, ES modules in the launcher UI. No build step.
- `npm run lint` must pass.
- Keep modules small and testable: code that doesn't need Electron shouldn't import it.
- Anything that comes from the network or the renderer is untrusted: validate it in the main process, and escape it before it touches HTML.
- Comments explain why, not what.

## Tests

Tests use the built-in `node:test` runner and live in each workspace's `test/` folder. Add tests for new behavior and for every bug you fix.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep pull requests focused on one change.
3. Describe what changed and how you tested it. Add screenshots for UI changes.
4. Make sure `npm test` and `npm run lint` pass.

By contributing you agree your work is released under the [MIT License](LICENSE).
