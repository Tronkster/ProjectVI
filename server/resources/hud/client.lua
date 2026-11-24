-- Shows ui/index.html as an overlay and feeds it the player's speed and money.
-- Planned API, may change.

local hud = ui.overlay("ui/index.html")

every(250, function()
  local vehicle = player.vehicle
  hud:send("update", {
    speed = vehicle and math.floor(vehicle.speed * 3.6) or 0,
    money = player.money
  })
end)
