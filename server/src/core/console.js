// The server console: type commands into the terminal the server runs in.
// Anything that isn't a built-in command runs as a script command, with full permissions.

const readline = require("node:readline");
const { splitCommandLine } = require("./server-core");
const { parseTime } = require("./world");

const HELP = [
  "help                          this list",
  "resources                     list resources and their state",
  "start | stop | restart <res>  control a resource (restart picks up rebuilt DLLs)",
  "players                       list connected players",
  "commands                      list script commands",
  "emit <event> [json...]        emit a server event, e.g. emit welcome:ping \"Kai\"",
  "time [hh:mm]                  show or set the in-game time",
  "timescale [minutes]           show or set in-game minutes per real minute (0 stops the clock)",
  "weather [name] [seconds]      show or set the weather, blending over the given seconds",
  "<command> [args...]           run a script command as the console, e.g. job Ana mechanic",
  "quit                          stop the server"
];

const DEV_HELP = [
  "fakeplayer add <name> [identifier...]   connect a pretend player (dev mode)",
  "fakeplayer remove <name|id>             disconnect a pretend player",
  "as <name|id> <command> [args...]        run a script command as that player",
  "netevent <name|id> <event> [json...]    send a net event as if that player's client did"
];

// Parses `"Kai" 3 {"a":1} bare` as JSON values where possible.
function parseArgs(text) {
  const args = [];
  const re = /"(?:[^"\\]|\\.)*"|\{[^}]*\}|\[[^\]]*\]|\S+/g;
  for (const token of text.match(re) ?? []) {
    try {
      args.push(JSON.parse(token));
    } catch {
      args.push(token);
    }
  }
  return args;
}

function startConsole({ core, resources, log, onQuit }) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let fakeCount = 0;

  const needDev = () => {
    if (core.dev) return true;
    log.info("That's a development command. Set [scripting] dev = true in server.toml to use it.");
    return false;
  };

  const handlers = {
    help: () => [...HELP, ...(core.dev ? DEV_HELP : [])].forEach((l) => log.info(l)),
    resources: () => resources.list().forEach(({ name, state }) => log.info(`${name.padEnd(20)} ${state}`)),
    start: ([name]) => name && resources.start(name),
    ensure: ([name]) => name && resources.start(name),
    stop: ([name]) => name && resources.stop(name),
    restart: ([name]) => name && resources.restart(name),
    players: () => {
      const all = core.players.list();
      if (all.length === 0) log.info("No players connected.");
      for (const p of all) log.info(`#${String(p.id).padEnd(4)} ${p.name.padEnd(20)} ${p.identifiers.join(", ")}${p.groups.length ? `  [${p.groups.join(", ")}]` : ""}${p.fake ? "  (fake)" : ""}`);
    },
    commands: () => {
      if (core.commands.size === 0) log.info("No script commands registered.");
      for (const [name, c] of core.commands) log.info(`/${name.padEnd(16)} ${c.resource.padEnd(12)} ${c.permission ? `[${c.permission}] ` : ""}${c.help}`);
    },
    emit: (_args, rest) => {
      const [name, ...more] = splitCommandLine(rest);
      if (name) core.bus.emit(name, parseArgs(rest.slice(rest.indexOf(name) + name.length)));
      void more;
    },
    time: ([value]) => {
      if (value) {
        const seconds = parseTime(value);
        if (seconds === null) return log.info("Usage: time 18:30");
        core.world.setTime(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60));
      }
      const { hour, minute } = core.world.time();
      log.info(`In-game time ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}, ${core.world.scale} in-game minutes per real minute.`);
    },
    timescale: ([value]) => {
      if (value !== undefined) {
        try {
          core.world.setTimeScale(Number(value));
        } catch (err) {
          return log.info(err.message);
        }
      }
      log.info(core.world.scale === 0 ? "The clock is stopped." : `${core.world.scale} in-game minutes per real minute.`);
    },
    weather: ([name, seconds]) => {
      if (name) {
        try {
          core.world.setWeather(name, seconds === undefined ? 30 : Number(seconds));
        } catch (err) {
          return log.info(err.message);
        }
      }
      log.info(`Weather: ${core.world.weather}.`);
    },
    fakeplayer: ([action, name, ...identifiers]) => {
      if (!needDev()) return;
      if (action === "add" && name) {
        fakeCount += 1;
        core.addPlayer({ name, identifiers: identifiers.length ? identifiers : [`guest:fake${fakeCount}`], fake: true });
      } else if (action === "remove" && name) {
        const player = core.players.find(name);
        if (player) core.removePlayer(player.id, "Removed from the console");
        else log.info(`No player matches ${name}.`);
      } else {
        log.info("Usage: fakeplayer add <name> [identifier...] | fakeplayer remove <name|id>");
      }
    },
    as: async ([who], rest) => {
      if (!needDev()) return;
      const player = who && core.players.find(who);
      if (!player) return log.info(`No player matches ${who}.`);
      const reply = await core.runCommand(player.id, rest.slice(rest.indexOf(who) + who.length).trim());
      if (reply) core.notify(player, reply);
    },
    netevent: ([who, event], rest) => {
      if (!needDev()) return;
      const player = who && core.players.find(who);
      if (!player || !event) return log.info("Usage: netevent <name|id> <event> [json...]");
      const accepted = core.bus.emitFromClient(player.id, event, parseArgs(rest.slice(rest.indexOf(event) + event.length)));
      if (!accepted) log.info(`Nothing on the server accepts the net event ${event}.`);
    },
    quit: () => {
      rl.close();
      onQuit();
    }
  };
  handlers.exit = handlers.quit;

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) return;
    const [command, ...args] = splitCommandLine(line);
    const rest = line.slice(command.length).trim();
    const handler = handlers[command.toLowerCase()];
    try {
      if (handler) {
        await handler(args, rest);
      } else {
        const reply = await core.runCommand(null, line);
        if (reply) log.info(reply);
      }
    } catch (err) {
      log.error(err.message);
    }
  });
  return rl;
}

module.exports = { startConsole, parseArgs };
