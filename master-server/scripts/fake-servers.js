// Sends heartbeats for a handful of test servers so the launcher has something to show.
// Usage: npm run fake            (master server on http://localhost:30180)
//        MASTER_URL=http://host:port npm run fake

const MASTER_URL = (process.env.MASTER_URL || "http://localhost:30180").replace(/\/+$/, "");
const INTERVAL_MS = 20_000;

const TEST_SERVERS = [
  { port: 30201, name: "Sunset Coast RP", description: "Serious roleplay with whitelisted jobs and a player-run economy.", mode: "Roleplay", region: "EU", players: 88, maxPlayers: 128 },
  { port: 30202, name: "Harbor City Life", description: "Economy roleplay with custom businesses.", mode: "Roleplay", region: "NA", players: 121, maxPlayers: 128 },
  { port: 30203, name: "Street Racing EU", description: "Ranked street races every 15 minutes.", mode: "Racing", region: "EU", players: 41, maxPlayers: 64 },
  { port: 30204, name: "Freeroam Chaos", description: "No rules, lots of vehicles.", mode: "Freeroam", region: "NA", players: 12, maxPlayers: 32 },
  { port: 30205, name: "Night Shift RP", description: "Police, medics and taxi crews after dark.", mode: "Roleplay", region: "EU", players: 64, maxPlayers: 96 },
  { port: 30206, name: "Drift Kings", description: "Drift tracks and weekly car meets.", mode: "Racing", region: "EU", players: 23, maxPlayers: 48 },
  { port: 30207, name: "Crew Heists", description: "Co-op heists with your crew.", mode: "Freeroam", region: "SA", players: 9, maxPlayers: 16 }
];

function drift(server) {
  const change = Math.round((Math.random() - 0.5) * 6);
  server.players = Math.min(server.maxPlayers, Math.max(0, server.players + change));
}

async function beat() {
  const results = await Promise.allSettled(TEST_SERVERS.map(async (server) => {
    drift(server);
    const res = await fetch(`${MASTER_URL}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server)
    });
    if (!res.ok) throw new Error(`${server.name}: ${res.status} ${(await res.json()).error}`);
  }));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error(`Heartbeat failed for ${failed.length} server(s). Is the master server running at ${MASTER_URL}?`);
    console.error(`  ${failed[0].reason.message}`);
  } else {
    console.log(`${new Date().toLocaleTimeString()}  ${TEST_SERVERS.length} test servers reported to ${MASTER_URL}`);
  }
}

beat();
setInterval(beat, INTERVAL_MS);
