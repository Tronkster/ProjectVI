# Client scripts (Lua)

Client scripts run in the ProjectVI client beside the game, for every player. They come from two places:

- **Server resources:** the `.lua` files a resource sends to players (`client_files` in its `resource.toml`).
- **Public mods** the player turned on in the launcher.

Every `.lua` file at the top level of a resource or mod runs when the player joins, in name order. Other `.lua`
files (in folders) are modules: load them with `require("lib.util")` for `lib/util.lua`.

Scripts are Lua 5.4. Each resource or mod runs in its own sandbox:

- No `io`, `debug`, `package`, `dofile` or `loadfile`; `os` has only `time`, `clock`, `date` and `difftime`;
  `load` takes source text only. `require` only finds files in the same resource or mod.
- 32 MB of memory each. A file that runs longer than 1 second when it starts, or a callback that runs longer than
  250 ms, is stopped with an error. After 50 errors, the resource's or mod's scripts are stopped.
- Errors go to the client log (`client.log` in the launcher's log folder), with the resource or mod name.

## API

### Timers

```lua
local id = every(250, function() ... end)   -- every 250 ms (at least 16)
after(5000, function() ... end)             -- once, after 5 s
cancel(id)
```

### Events

```lua
on("chat", function(name, text, playerId) end)       -- a chat line, including your own
on("notice", function(text) end)                     -- a server notice
on("playerJoined", function(p) print(p.name) end)    -- { id, name }
on("playerLeft", function(p) end)
on("world", function(time, weather) end)             -- time = { hour, minute, second }
on("jobs:assigned", function(job) end)               -- any event the server sends this player

emit("myhud:refresh", 1, 2)                          -- to client scripts on this PC, including other mods
server.emit("shop:buy", "taxi")                      -- to the server: [NetEvent] handlers in C#
```

Arguments are JSON-like: strings, numbers, booleans, tables and nil.

### Chat and messages

```lua
chat.send("hello")              -- a chat line, or a /command
notify("Saved.")                -- a short message on this player's screen
```

### Players and the world

```lua
for _, p in ipairs(players()) do print(p.id, p.name, p.is_host) end
local t = world.time()          -- { hour, minute, second }, or nil before the server sent it
local w = world.weather()       -- "clear", "rain", …
```

### `player`

What the client knows about this player, refreshed many times a second:

| Field | |
|---|---|
| `id`, `name`, `is_host`, `character` | always |
| `position` `{x, y, z}`, `heading`, `speed` (m/s), `health`, `armour`, `dead` | when the game can report the player |
| `in_vehicle`, `vehicle` `{id, seat, speed}` | the same; `vehicle` is nil on foot |

Fields the game can't report are **nil**, never made up. Today the emulator can't read the player yet
([client.md](client.md)), so only the first row is filled in. Write scripts that show a dash or nothing for nil.

### UI pages

```lua
local hud = ui.overlay("ui/hud.html")   -- an HTML page from the same resource or mod
hud:send("speed", 87)                   -- to the page
hud:on("clicked", function(data) end)   -- from the page
hud:hide()
hud:show()
```

In the page:

```html
<script>
  projectvi.on("speed", (kmh) => { document.getElementById("speed").textContent = kmh ?? "–"; });
  projectvi.send("clicked", { button: "left" });
</script>
```

Pages are shown full-screen and see-through in the launcher's overlay, over the game. They can't take the mouse.
They can load files from their own resource or mod (CSS, scripts, images, fonts, sounds) by relative path, and
nothing else: no network, no other pages, no storage. Inline scripts and styles are allowed.

## Examples

`server/resources/hud/` (a speedometer and player count, as a server resource) and
`registry/dev/mods/clean-hud/` (a speedometer, as a mod).
