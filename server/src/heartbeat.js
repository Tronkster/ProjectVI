// Reports the server to the master server every 30 seconds, and signs off on shutdown.

// onListed(id): called after every successful heartbeat with the id the master server knows us by.
function startHeartbeat({ config, log, getPlayers = () => 0, intervalMs = 30_000, onListed = () => {} }) {
  const base = config.master.url.replace(/\/+$/, "");
  let failing = false;
  let listed = false;

  async function beat() {
    try {
      const res = await fetch(`${base}/api/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          port: config.port,
          name: config.name,
          description: config.description,
          mode: config.mode,
          region: config.region,
          players: getPlayers(),
          maxPlayers: config.maxPlayers
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const answer = await res.json().catch(() => ({}));
      onListed(answer.id);
      if (!listed) log(`Listed on the master server at ${base}.`);
      else if (failing) log("Master server reachable again. The server is listed.");
      listed = true;
      failing = false;
    } catch (err) {
      if (!failing) log(`Couldn't report to the master server at ${base}: ${err.message}. Retrying every ${intervalMs / 1000} seconds.`);
      failing = true;
    }
  }

  beat();
  const timer = setInterval(beat, intervalMs);

  return async function stop() {
    clearInterval(timer);
    try {
      await fetch(`${base}/api/heartbeat?port=${config.port}`, { method: "DELETE", signal: AbortSignal.timeout(2000) });
    } catch {
      // The master server drops us after 90 seconds anyway.
    }
  };
}

module.exports = { startHeartbeat };
