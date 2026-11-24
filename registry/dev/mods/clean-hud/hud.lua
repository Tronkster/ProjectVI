-- Example client mod. Planned API, may change.
local hud = ui.overlay("ui/hud.html")

every(250, function()
  hud:send("speed", player.vehicle and math.floor(player.vehicle.speed * 3.6) or 0)
end)
