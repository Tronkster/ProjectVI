-- Shows ui/index.html over the game: your speed (when the game can report it) and how many players are on.
-- API: docs/client-scripting.md.

local hud = ui.overlay("ui/index.html")

every(250, function()
  hud:send("update", {
    -- nil until the emulator can read the player from the game: the page shows a dash then.
    speed = player.speed and math.floor(player.speed * 3.6) or nil,
    players = #players(),
  })
end)
