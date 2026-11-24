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

## Not done

- No function in the game has been identified by name yet; the IDA database is outside the repo
  (`Downloads\gta6-ida\gta6.exe.i64`).
