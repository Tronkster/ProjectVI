// Runs client scripts (Lua) from server resources and public mods, one sandboxed Lua engine per package.
// docs/client-scripting.md is the API for script authors.
//
// Sandbox: no io, os (except time and date), debug, file loading, binary chunks or string.dump; require only finds
// .lua files in the script's own package. Each engine gets SCRIPT_MEMORY bytes; a chunk or a callback that runs
// longer than CALL_TIMEOUT_MS is stopped. A package that keeps failing is stopped, so it can't flood the log.

const fs = require("node:fs");
const { LuaFactory } = require("wasmoon");
const { scriptsOf } = require("./packages");

const SCRIPT_MEMORY = 32 * 1024 * 1024;
const CALL_TIMEOUT_MS = 250; // per callback (a timer, an event handler)
const LOAD_TIMEOUT_MS = 1000; // per script file, when it first runs
const MAX_ERRORS = 50; // then the package is stopped
const MIN_TIMER_MS = 16;
const MAX_TIMERS = 256; // per package
const MAX_SCRIPT_BYTES = 1024 * 1024;

// Lua side of the API. `__pv` is the JS side; it's captured here and removed from the globals.
const PRELUDE = `
local js = __pv
__pv = nil

io = nil
debug = nil
dofile = nil
loadfile = nil
package = nil
collectgarbage = nil
os = { time = os.time, clock = os.clock, date = os.date, difftime = os.difftime }
string.dump = nil
local raw_load = load
load = function(chunk, name, _, env)
  if type(chunk) ~= "string" then return nil, "load only takes strings here" end
  return raw_load(chunk, name, "t", env)
end

local function text(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
  return table.concat(parts, "\\t")
end
print = function(...) js.log(text(...)) end
log = print

local loaded = {}
require = function(name)
  if type(name) ~= "string" or not name:match("^[%w_%-%.]+$") then error("require: bad module name", 2) end
  if loaded[name] ~= nil then return loaded[name] end
  local file = name:gsub("%.", "/") .. ".lua"
  local source = js.source(file)
  if not source then error("require: no " .. file .. " in this package", 2) end
  local chunk, err = raw_load(source, "@" .. file, "t")
  if not chunk then error(err, 2) end
  local value = chunk(name)
  if value == nil then value = true end
  loaded[name] = value
  return value
end

-- Timer functions stay here, by id: a Lua function handed to JS and back comes back as a JS wrapper.
local timer_fns = {}
local function add_timer(ms, fn, rep)
  if type(fn) ~= "function" then error("every/after(ms, function)", 3) end
  local id = js.timer(ms, rep)
  timer_fns[id] = fn
  return id
end
every = function(ms, fn) return add_timer(ms, fn, true) end
after = function(ms, fn) return add_timer(ms, fn, false) end
cancel = function(id) timer_fns[id] = nil; js.cancel(id) end

local handlers = {}
on = function(name, fn)
  if type(name) ~= "string" or type(fn) ~= "function" then error("on(name, function)", 2) end
  handlers[name] = handlers[name] or {}
  table.insert(handlers[name], fn)
end
emit = function(name, ...) js.emit(name, table.pack(...)) end
server = { emit = function(name, ...) js.server_emit(name, table.pack(...)) end }
chat = { send = function(message) js.chat(tostring(message)) end }
notify = function(message) js.notify(tostring(message)) end
players = function() return js.players() end
world = {
  time = function() return js.time() end,
  weather = function() return js.weather() end,
}

local ui_handlers = {}
ui = {
  overlay = function(path)
    local id = js.ui_open(path)
    local handle = { id = id }
    function handle:send(name, data) js.ui_send(self.id, name, data) end
    function handle:on(name, fn) ui_handlers[self.id .. "\\0" .. name] = fn end
    function handle:show() js.ui_show(self.id, true) end
    function handle:hide() js.ui_show(self.id, false) end
    return handle
  end,
}

-- Called from JS.
__pv_dispatch = function(name, args, n)
  local list = handlers[name]
  if not list then return end
  for _, fn in ipairs(list) do
    local ok, err = pcall(fn, table.unpack(args, 1, n))
    if not ok then js.error("handler for " .. name .. ": " .. tostring(err)) end
  end
end
__pv_ui_message = function(id, name, data)
  local fn = ui_handlers[id .. "\\0" .. name]
  if fn then
    local ok, err = pcall(fn, data)
    if not ok then js.error("UI message " .. name .. ": " .. tostring(err)) end
  end
end
__pv_fire = function(id, once)
  local fn = timer_fns[id]
  if not fn then return end
  if once then timer_fns[id] = nil end
  local ok, err = pcall(fn)
  if not ok then js.error(tostring(err)) end
end
`;

let factory = null;

// Values handed to Lua: JSON-like data only. null becomes undefined (nil in Lua; wasmoon can't push a null inside a
// table), functions and cycles are dropped, and nesting stops at 16 levels.
function toLua(value, depth = 0) {
  if (value === null || value === undefined || depth > 16) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => toLua(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = toLua(v, depth + 1);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  }
  return undefined;
}

// Values coming back from Lua: tables are plain objects or arrays already; keep only JSON-like data.
function fromLua(value, depth = 0) {
  if (value === null || value === undefined || depth > 16) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => fromLua(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromLua(v, depth + 1)]));
  return null;
}

// api: what scripts can reach, provided by the client:
//   log(pkg, level, text), sendServerEvent(name, args), sendChat(text), notify(text), players(), time(), weather(),
//   uiOpen(pkg, path) -> id, uiSend(id, name, data), uiShow(id, visible)
class ScriptHost {
  constructor({ api }) {
    this.api = api;
    this.running = []; // { pkg, lua, dispatch, uiMessage, call, timers: Map, errors, stopped }
    this.uiOwners = new Map(); // ui id -> running package
  }

  async start(packages) {
    factory ??= new LuaFactory();
    for (const pkg of packages) {
      const scripts = scriptsOf(pkg);
      if (!scripts.length) continue;
      const run = await this.createEngine(pkg);
      this.running.push(run);
      for (const file of scripts) {
        if (run.stopped) break;
        const source = this.readSource(pkg, file);
        if (source === null) {
          this.fail(run, `${file} can't be read.`);
          continue;
        }
        await this.runChunk(run, source, file);
      }
      this.api.log(pkg, "info", `Started ${scripts.join(", ")}.`);
    }
  }

  readSource(pkg, file) {
    const abs = pkg.files.get(file);
    if (!abs) return null;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_SCRIPT_BYTES) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  async createEngine(pkg) {
    const lua = await factory.createEngine({ traceAllocations: true, functionTimeout: CALL_TIMEOUT_MS, injectObjects: false, enableProxy: false });
    lua.global.setMemoryMax(SCRIPT_MEMORY);
    const run = { pkg, lua, timers: new Map(), nextTimer: 1, errors: 0, stopped: false };
    const api = this.api;
    // table.pack(...) arrives as { 1: a, 3: c, n: 3 }.
    const toArgs = (packed) => {
      if (!packed || typeof packed !== "object") return [];
      const n = Math.min(Number(packed.n) || 0, 64);
      return Array.from({ length: n }, (_, i) => fromLua(packed[i + 1]));
    };
    // wasmoon can't take a null back from a JS function, so none of these return one.
    const noNull = (fns) => Object.fromEntries(Object.entries(fns).map(([k, fn]) => [k, (...a) => fn(...a) ?? undefined]));
    lua.global.set("__pv", noNull({
      log: (message) => api.log(pkg, "info", String(message)),
      error: (message) => this.fail(run, String(message)),
      source: (file) => this.readSource(pkg, String(file)) ?? undefined,
      timer: (ms, repeat) => this.addTimer(run, ms, Boolean(repeat)),
      cancel: (id) => this.cancelTimer(run, id),
      emit: (name, packed) => this.dispatch(String(name), toArgs(packed)),
      server_emit: (name, packed) => api.sendServerEvent(String(name), toArgs(packed)),
      chat: (message) => api.sendChat(message),
      notify: (message) => api.notify(message),
      players: () => toLua(api.players()),
      time: () => toLua(api.time()),
      weather: () => toLua(api.weather()),
      ui_open: (file) => {
        const id = api.uiOpen(pkg, String(file));
        this.uiOwners.set(id, run);
        return id;
      },
      ui_send: (id, name, data) => api.uiSend(String(id), String(name), fromLua(data)),
      ui_show: (id, visible) => api.uiShow(String(id), Boolean(visible))
    }));
    await this.runChunk(run, PRELUDE, "prelude");
    run.dispatch = lua.global.get("__pv_dispatch");
    run.uiMessage = lua.global.get("__pv_ui_message");
    run.fire = lua.global.get("__pv_fire");
    await this.runChunk(run, "__pv_dispatch = nil; __pv_ui_message = nil; __pv_fire = nil", "prelude");
    lua.global.set("player", toLua(this.player ?? {})); // a table from the start: fields are nil until known
    return run;
  }

  async runChunk(run, source, name) {
    const g = run.lua.global;
    const thread = g.newThread();
    const index = g.getTop();
    try {
      thread.loadString(source, `@${name}`);
      await thread.run(0, { timeout: LOAD_TIMEOUT_MS });
    } catch (err) {
      this.fail(run, `${name}: ${err.message}`);
    } finally {
      g.remove(index);
    }
  }

  // Calls into a package's Lua. Errors (including timeouts) count against it.
  invoke(run, fn, ...args) {
    if (run.stopped) return;
    try {
      fn(...args);
    } catch (err) {
      this.fail(run, err.message);
    }
  }

  addTimer(run, ms, repeat) {
    if (run.timers.size >= MAX_TIMERS) throw new Error(`at most ${MAX_TIMERS} timers per package`);
    const delay = Math.max(MIN_TIMER_MS, Number(ms) || 0);
    const id = run.nextTimer++;
    const tick = () => {
      if (!repeat) run.timers.delete(id);
      this.invoke(run, run.fire, id, !repeat);
    };
    run.timers.set(id, repeat ? setInterval(tick, delay) : setTimeout(tick, delay));
    return id;
  }

  cancelTimer(run, id) {
    const timer = run.timers.get(Number(id));
    if (timer === undefined) return;
    clearInterval(timer);
    clearTimeout(timer);
    run.timers.delete(Number(id));
  }

  // An event for every package's on(name, ...) handlers.
  dispatch(name, args = []) {
    const converted = args.map((a) => toLua(a));
    for (const run of this.running) this.invoke(run, run.dispatch, name, converted, converted.length);
  }

  // A message from a UI page, for its package's handle:on(name, ...).
  uiMessage(id, name, data) {
    const run = this.uiOwners.get(id);
    if (run) this.invoke(run, run.uiMessage, id, name, toLua(data));
  }

  fail(run, message) {
    if (run.stopped) return;
    run.errors++;
    this.api.log(run.pkg, "error", message);
    if (run.errors >= MAX_ERRORS) this.stopPackage(run, `stopped after ${MAX_ERRORS} errors`);
  }

  stopPackage(run, reason) {
    if (run.stopped) return;
    run.stopped = true;
    for (const id of [...run.timers.keys()]) this.cancelTimer(run, id);
    this.api.log(run.pkg, "warn", `Scripts ${reason}.`);
  }

  stop() {
    for (const run of this.running) {
      this.stopPackage(run, "stopped");
      try {
        run.lua.global.close();
      } catch {
        // already closed
      }
    }
    this.running = [];
  }

  // The player table scripts see, refreshed before every frame's work.
  setPlayer(snapshot) {
    this.player = snapshot; // for engines started later
    for (const run of this.running) {
      if (run.stopped) continue;
      try {
        run.lua.global.set("player", toLua(snapshot));
      } catch (err) {
        this.fail(run, `player update: ${err.message}`);
      }
    }
  }
}

module.exports = { ScriptHost, toLua, fromLua, SCRIPT_MEMORY, CALL_TIMEOUT_MS, MAX_ERRORS };
