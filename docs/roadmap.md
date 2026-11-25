# Roadmap and todo

What's left to build, grouped by where the work happens. Tick items off in the pull request that finishes them.

**Milestones**

1. **One world (A).** Everyone in the same world as the story's characters, with the story switched off.
2. **The game client.** A program beside the emulator that runs the sync protocol and drives the game through the
   emulator's bridge ([client.md](client.md)).
3. **A shared story (B).** The host's game runs the story, and the other players follow it.

> [!NOTE]
> Rules that always hold: ProjectVI never connects to Rockstar's or Xbox Live's online services, and no game files,
> keys or build-specific addresses go into this repository. Reverse-engineering findings are recorded as structure in
> [client-reverse-engineering.md](client-reverse-engineering.md).

## Blocker

- [ ] Get the game running under VIctory and drawing its world. Today it needs the full game folder, and the world
  doesn't render. Nothing in the game can be tested before this.

## Reverse engineering (IDA Pro)

### Groundwork

- [ ] Merge the `docs/script-natives` notes into main.
- [ ] Confirm the once-per-frame hook on the game thread: the `CTheScripts` update, or our own callback added through
  the game skeleton's update registrar (addresses in the script-natives notes).
- [ ] Find how script natives are linked and called:
  - [ ] Decode a few scripts from `pack/story000/story000_script.rpf` with rage9-re, and see what a native call looks
    like in the bytecode.
  - [ ] Trace where those scripts are really loaded and their natives linked (`ScriptStore` is mostly stubs).
  - [ ] Find the structure a native reads its arguments from and writes its result to.
  - [ ] Fallback: call the game's own systems directly (`CScriptPeds`, `CScriptEntities`).
- [ ] Name natives by how the story scripts use them, the way GTA V's natives were first named.

### What the client needs

Natives or engine functions for each of these:

- [ ] **Local player:** the player's character, position, speed and heading; health, armour, weapon and aim; which car
  and seat; crouching, jumping, ragdoll, swimming and dead.
- [ ] **Spawning:** load a model by hash; create and delete characters and cars; set position, rotation (quaternion)
  and speed; freeze; collision on and off.
- [ ] **Puppets (other players):** walk or run to a point at a given speed; put a character in a car seat; aim and
  shooting poses, ragdoll and death; turn off their AI reactions.
- [ ] **Cars:** read and set steering, engine, lights, siren, horn and health.
- [ ] **Characters:**
  - [ ] The real model names for Lucia and Jason, to replace the `lucia`/`jason` placeholders in `[sync] characters`.
  - [ ] How the game switches the player's character.
  - [ ] Whether the other main character stays in the world as an AI companion, and how to remove them.
  - [ ] Locking character switching.
- [ ] **Story off (milestone A):** stop story mission scripts from launching; skip the prologue; turn off saving and
  autosave; keep the world running when paused or the window loses focus; unlock map areas the story gates.
- [ ] **World:** set the time of day and the weather; turn traffic and pedestrians down.
- [ ] **Damage:** catch damage events; apply damage and set health.
- [ ] **Screen:** show notices and chat; read chat input.

### Shared story (milestone B)

- [ ] Where story progress lives (`ScriptSaveBlock` is the lead).
- [ ] How missions are launched.
- [ ] When cutscenes start and end.
- [ ] How missions create their characters, cars and objects.

## Game client

A separate program beside the emulator rather than a DLL ([client.md](client.md)), so the sync code is the tested
Node code and nothing is loaded into the game.

- [x] The bridge in VIctory: a local connection, a frame event per presented frame, game operations by capability
  (`crates/victory-bridge`, branch `feat/projectvi-bridge` on the fork https://github.com/Tronkster/VIctory; not in
  upstream VIctory).
- [x] The client (`client/`): reads the `PROJECTVI_*` settings, connects to the bridge, joins with the ticket, and
  on each frame uses whatever game operations the emulator has. Logs what's missing; never invents data.
- [x] The launcher starts it beside the emulator when joining, on its own Node.
- [ ] The game operations themselves in VIctory's `victory-game` (`player.read`, `ped.*`, `vehicle.*`,
  `player.setModel`, `world.set`, `screen.*`). Each needs the reverse-engineering items above.
- [ ] Running server client scripts (`client.lua` and UI files from resources) in the client.

## Server and protocol (no game needed)

- [x] Player sync: players, interpolation, streaming by distance
- [x] Vehicles: ids, rotation, who simulates each one, hand-over
- [x] Host and story characters
- [x] Reliable channel: chat, `/commands`, notices, script events
- [x] Server time of day and weather, pushed to every player
- [x] "Stays with the host" control for cars: the host's client or a script marks a vehicle, and the host's game keeps it
- [ ] The same for mission characters and objects, once they're synced (needs how missions create them)
- [x] Join tickets: the master server signs a ticket, the launcher passes it to the game, and the server checks it in
  `HELLO`, so real players get their Discord identifiers and admin permissions work
- [ ] Damage: the shooter reports a hit, the server checks it, and the victim's client applies it
- [x] A typed C# API for player state, ping, vehicles (with enter and exit events) and chat
- [x] Server-side checks against teleporting and impossible seat claims (`playerSuspicious` for scripts)
- [ ] Smaller packets (quantised positions and rotations) once the client exists and real traffic can be measured

## Launcher

- [x] Pass the join ticket to the game (`PROJECTVI_TICKET`).
- [ ] Show in-game presence to friends once the client exists.

## Housekeeping

- [ ] Delete the merged branches `feat/sync-bots`, `feat/sync-v2` and `feat/reliable-channel`.
- [ ] Publish the public mod registry.
- [ ] Code-sign builds, so Windows SmartScreen stops warning on install.
