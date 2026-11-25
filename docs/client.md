# The ProjectVI client

The client is the part of ProjectVI that's in the game with the player. It's a separate program that runs beside
the emulator (`client/`, Node, shipped inside the launcher), not code loaded into the game:

```
 launcher ──starts──▶ emulator (VIctory) ──runs──▶ GTA VI
    │                     ▲
    │                     │ bridge: 127.0.0.1, JSON lines
    └──starts──▶ ProjectVI client ──UDP sync──▶ game server
```

1. When a player joins a server, the launcher picks a fresh bridge file under the cache folder and starts the
   emulator with `VICTORY_BRIDGE_FILE` set to it, and the client with the same path in `PROJECTVI_BRIDGE_FILE`,
   plus the other `PROJECTVI_*` settings ([protocol.md](protocol.md), "Launcher side"). The client runs on the Node
   inside the launcher (`ELECTRON_RUN_AS_NODE`), so players don't need Node installed. Its log is `client.log` in
   the launcher's log folder.
2. VIctory listens on a free local port and writes the port and a random token to the bridge file. The client
   reads it, connects and says hello with the token. Only one program can be connected, and only programs that can
   read the file (the same Windows user) have the token.
3. The client joins the game server with sync (and the join ticket), then works once per frame the game presents:
   VIctory sends a `frame` event, and the client reads the local player, reports them, and places everyone else.
4. When the game exits, VIctory sends `exit` and the client leaves the server. If the emulator closes the bridge
   or the server ends the session, the client stops too.

## The bridge (VIctory side)

Implemented in VIctory, `crates/victory-bridge` (GPL-3.0, in the VIctory repository). Newline-delimited JSON, one
object per line, at most 64 KB:

- Request: `{"id": 1, "op": "player.read", "args": {…}}`
- Answer: `{"id": 1, "ok": true, "result": …}` or `{"id": 1, "ok": false, "error": {"code": "…", "message": "…"}}`.
  Error codes: `unsupported`, `bad_args`, `not_ready`, `failed`; the client adds `timeout` and `closed`.
- Events: `{"event": "frame", "frame": n}` after presented frames (a slow reader gets the latest, not a backlog),
  `{"event": "exit", "code": n}`.
- Built in: `hello` (`{token, client}`, must be first; answers `{bridge, emulator, emulatorVersion, build,
  buildHash, capabilities}`), `info`, `capabilities`.

`cargo run -p victory-bridge --example serve -- <file> [seconds]` opens a bridge with no game attached (frames,
no game operations), for working on the client.

## Game operations

What the client asks the emulator to do. VIctory lists the ones it can do in `capabilities`; the client only calls
those, and logs once what each missing one means (for example "others won't see you" without `player.read`). It
never invents data to stand in for a missing operation.

**None of these exist yet.** Each needs to know where GTA VI keeps the thing in question and how to call into it,
which is the reverse-engineering work in [roadmap.md](roadmap.md). In VIctory, they belong in `victory-game`
(registered with `victory_bridge::register`).

Handles are the emulator's numbers for game objects; the client never interprets them. Positions are metres,
headings degrees (0 = north, counter-clockwise), rotations unit quaternions, models and weapons joaat hashes, as in
the sync protocol.

| Operation | Args | Result |
|---|---|---|
| `player.read` | | `{position, velocity, heading, flags, model, health, armour, weapon, aim, vehicle, seat}`: the sync player state, with `vehicle` the handle of the vehicle the player is in (or null) instead of a server id |
| `player.setModel` | `{model}` | |
| `ped.create` | `{model, position, heading, name}` | `{handle}`. A character for another player; the game mustn't give it AI of its own |
| `ped.update` | `{handle, name, state}` | `state` is the interpolated sync state, with `vehicle` a handle (or null) |
| `ped.delete` | `{handle}` | |
| `vehicle.create` | `{model, position, rotation}` | `{handle}` |
| `vehicle.update` | `{handle, state}` | `state` is the interpolated sync vehicle state |
| `vehicle.read` | `{handle}` | the sync vehicle state, for a vehicle this game simulates |
| `vehicle.delete` | `{handle}` | |
| `world.set` | `{hour, minute, second, scale, weather?, transition}` | `weather` only when it changed: blend to it over `transition` seconds |
| `screen.notify` | `{text}` | |
| `screen.chat` | `{name, text}` | |

Vehicles: a car the server knows is created with `vehicle.create`. A car the game spawned itself (a parked car the
player gets into) shows up as an unknown handle in `player.read`; the client reads it with `vehicle.read` and
registers it with the server. Cars the server says this game simulates are read and reported, not moved.

## Running it by hand

```sh
npm run dev:server
cargo run -p victory-bridge --example serve -- C:\temp\bridge.json 60   # in the VIctory repository
PROJECTVI_SERVER=127.0.0.1:30120 PROJECTVI_PLAYER=Kai PROJECTVI_BRIDGE_FILE=C:\temp\bridge.json npm start -w client
```
