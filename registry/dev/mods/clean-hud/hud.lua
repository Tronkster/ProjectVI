-- Example client mod: a big speedometer. API: docs/client-scripting.md.
local hud = ui.overlay("ui/hud.html")

every(250, function()
  hud:send("speed", player.speed and math.floor(player.speed * 3.6) or nil)
end)
