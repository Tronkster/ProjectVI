# Client: first look at the game executable

What a first pass in IDA Pro found in the Xbox Series executable (the user's own dump), as groundwork for
the ProjectVI client (the part that joins a game). No game code, keys or addresses that only work on one build
are kept in this repository: findings here are about structure.

## The binary

- x64 PE for the Xbox Series (GDK): `d3d12_xs.dll`, `xg_xs.dll`, `xmem.dll`, `xapu.dll`, `XGameRuntime`,
  `libHttpClient.GDK`, `Bink2Scarlett.dll`. Image base `0x140000000`, 120 MB, linked 2026-11-13.
- `.text` is 95 MB: IDA finds **434,408 functions, 307 of them named** (the CRT and the Xbox SDK).
- Only 28,804 strings. The game's own C++ classes carry **no RTTI names** (only the Xbox Live SDK's do), and
  the engine's debug strings are gone: names are hashes. Expect GTA V-style work: anchors come from hashed
  names, script natives and data, not from text.
- The import table holds only a handful of functions: networking (sockets, `XNetworking*`, HTTP) is resolved at
  run time, so it can't be found by its imports.

## What is there that matters to multiplayer

- The Xbox Live multiplayer SDK (`MultiplayerManager`, `MatchmakingService`, `sessiondirectory.xboxlive.com`,
  `XNetworkingQueryPreferredLocalUdpMultiplayerPortAsync`) and Rockstar's services (`ros-SessionTicket`).
  These are the online stack of the console and Rockstar's servers. **ProjectVI should not reimplement or talk
  to them**: VIctory keeps the title offline on purpose, and using Rockstar's online services from a modified
  client is what gets accounts banned.
- A script VM (`ScriptStore`, `ScriptSaveBlock`, `AMBIENT_SCRIPT_SLOT_%d`). As in FiveM for GTA V, the realistic
  route is our own sync: hook the script VM's native calls (spawn a ped, set its position, heading, animation,
  vehicle) and send positions between players over ProjectVI's own protocol.

## Suggested route for the client

1. Get the title running under VIctory first (today: the full game folder is needed, and the world doesn't render
   yet). Nothing below can be tested before that.
2. Run inside VIctory's process: VIctory already loads the title as a DLL in its own process, so the client can be
   a module VIctory loads beside it (a hook point in VIctory, not injection into a console).
3. Find the script VM's native table at run time (hashes → handlers), then the few natives the first version needs:
   local player's ped and position, create ped, set coords/heading, task to move.
4. Sync: 10-20 position updates a second per player over UDP to the game server, interpolated on the other side.

## Community tools that help (from awesome-gta6-reverse-engineering)

The index at https://github.com/Ahmet-Dedeler/awesome-gta6-reverse-engineering lists the open tools. For the client:

- **tarekmania/gta6-namehash** (MIT): joaat hash → name dictionary (~498k hashes from GTA V's public name lists).
  The game's names are hashes, so this is the first thing to load into IDA.
- **lynxnathan/rage-tools-vi** (MIT): a 37k hash → name registry and offset/hash manifests.
- **Ahmet-Dedeler/rage9-re**: decodes `script.rpf` script data: where to look for the script VM and its natives.
- **oguzhanozfe/gta-vi-port-research**: format notes and inspection scripts.
- **DesignWithTommy/6to5m** (GPL-3.0): converts GTA VI map areas to FiveM resources. Not this client, but the other
  way to play together today: a GTA VI map on GTA V's FiveM.

Check each licence before copying code: GPL-3.0 code can't go into ProjectVI without ProjectVI becoming GPL.

## Names loaded from gta6-namehash (24 Nov 2026)

A scan of `.text` for `cmp`/`mov` with a 32-bit constant that is a known joaat hash found **18,063 places,
3,123 distinct names** (1,053 places with a confirmed name). Each is a comment in the IDA database
(`joaat <hash> = <name>`, "(candidate)" when it's only a hash match). Checked by hand: a switch at
`0x1400482cc` returns bone ids (`SKEL_Head`, `SKEL_R_Calf`). Most frequent: bone names, `PLAYER`, `PED`,
`VEHICLE`, `WEAPON`, `SCRIPT`. The scan and the IDA script are kept beside the database
(`Downloads\gta6-ida\hashscan.py`, `apply_names.py`, `hits.json`). Constants built in other ways, or held in
data tables, aren't covered.

## Script natives and the script system (25 Nov 2026)

Goal was the script VM's native table (hash → handler), the native call context, and the VM's per-frame tick.
**How natives are registered and called is still an open question.** What was found, and what was searched for
without result.

### Found: the game skeleton (RAGE `gameSkeleton`) and the script subsystems in it

Subsystems register with three functions, each `(callback, u32 joaat(name))`, called from long lists at
`0x14589E000`-`0x1458A4000` (924 registrations; 93 names match gta6-namehash; full table in the shared notes
folder, `game-skeleton-registrations.json`):

| Registrar | Calls | Role (from the callbacks' bodies) |
|---|---|---|
| `0x141BB1CF0` | 330 | init/shutdown system, callback takes an init mode (2 = core, 0x10, 0x20) |
| `0x141BB1C30` | 571 | init/shutdown system, modes 1 and 8 (session start/end) |
| `0x141BB1B00` | 34 | per-frame update group callbacks |

The script subsystems are all there, with GTA V's names: `CTheScripts` (`0x249760F7`), `CScriptAreas`,
`CScriptCars`, `CScriptPeds`, `CScriptEntities`, `CScriptHud`, `CScriptDebug` (stubbed out in this build). Addresses:

- `CTheScripts` init: `0x1429DEB90` (mode 2 reads ~25 tuning values and sets up per-thread memory contexts at
  `0x1440468C0`; neighbouring functions `0x1429DF490`, `0x1429DFAF0` are the session-start/end hooks of the same
  source file). Shutdown: `0x142B1CD90`.
- `CTheScripts` per-frame update: `0x140B1AE00` → `0x140B1AE10`. **This is the best hook point found for running
  client code once per frame on the game thread**, and the game skeleton itself (registrar `0x141BB1B00`) is a
  clean way to add our own update callback in the same list.
- How we know: the hashes are joaat of the class names (checked with the same hash as gta6-namehash), and the
  registration order and modes match GTA V's skeleton.

### `ScriptStore` (the script program store) is nearly empty

`ScriptStore` is a streaming module (id 89, set up at `0x145CD9BA0`, vtable `0x14630AAE0`). Almost every slot
of its vtable is a shared stub (`ret 0`, `ret 1`, `nullsub`); the only real code is the generic pool. In GTA V
this store is where `.ysc` programs are loaded and their native hashes resolved to handlers.

### Searched for without result: a GTA V-style native hash table

Each of these would have found GTA V's or RDR2's layout, and none matched:

- registration calls `register(hash64, handler)` or `register(handler, hash32)`, called or tail-jumped (no
  registrar beyond the game skeleton, `atexit` and parser/reflection registrars);
- a static array of {hash, handler} pairs, of handler pointers, or of 32-bit handler RVAs, at strides 8-32 bytes,
  in `.rdata` and `.data` (none; the long pointer arrays are vtables and the CRT initialiser table `0x14678F688`);
- an encoded table (long high-entropy arrays: they are fonts, certificates and other data);
- the `{fn, next}` linked lists built by static initialisers (e.g. `0x145E15980`, 1,618 entries, head
  `0x14ABCE390`) are lazy parser/type registrations, not natives;
- `AMBIENT_SCRIPT_SLOT_%d` is audio (wave slots), not script threads.

### Correction: scripts are not compiled into the executable

An earlier version of this section guessed that the game's scripts were compiled into the executable, based on the
small top-level `script.rpf` (4.3 MB). That guess was wrong: the game folder also has
`pack/story000/story000_script.rpf` (78 MB), which is where the script data lives. The game does have a script
VM, and the absence of a GTA V-style hash table means natives are linked some other way, not that there are none.

### Open

- How natives are linked and called, and the call context they read. Not documented here.
- The per-frame hook point above (`CTheScripts` update) doesn't depend on that answer.

## Not done

- No function in the game has been identified by name yet; the IDA database is outside the repo
  (`Downloads\gta6-ida\gta6.exe.i64`).
