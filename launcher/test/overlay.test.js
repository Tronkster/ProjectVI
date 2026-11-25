const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createUiContent, injectBridge, CSP } = require("../src/main/ui-content");
const { Overlay, KEYS } = require("../src/main/overlay");

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvi-ui-"));
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  return {
    dir,
    html: write("blob-html", "<!doctype html><html><head><meta charset=utf-8></head><body>hi</body></html>"),
    css: write("blob-css", "body{}"),
    secret: write("secret.txt", "launcher token")
  };
}

test("UI pages are served only from their package's whitelist, with the bridge and a strict CSP", () => {
  const f = files();
  try {
    const ui = createUiContent();
    const host = ui.setPackage("mod-clean-hud", "clean-hud", { "ui/hud.html": f.html, "ui/style.css": f.css, "../escape.html": f.secret, "rel.css": "relative/path" });
    assert.equal(host, "p1");
    assert.equal(ui.setPackage("mod-clean-hud", "clean-hud", { "ui/hud.html": f.html, "ui/style.css": f.css }), "p1"); // same package, same host
    assert.equal(ui.setPackage("resource-hud", "hud", { "a.html": f.html }), "p2");

    assert.equal(ui.urlFor("mod-clean-hud", "ui/hud.html"), "projectvi-ui://p1/ui/hud.html");
    assert.equal(ui.urlFor("mod-clean-hud", "secret.txt"), null);
    assert.equal(ui.urlFor("nobody", "ui/hud.html"), null);

    const page = ui.respond("projectvi-ui://p1/ui/hud.html");
    assert.equal(page.status, 200);
    assert.equal(page.headers["Content-Security-Policy"], CSP);
    assert.match(CSP, /connect-src 'none'/);
    assert.match(page.headers["Content-Type"], /text\/html/);
    const text = page.body.toString();
    assert.ok(text.indexOf("window.projectvi") > text.indexOf("<head>") && text.indexOf("window.projectvi") < text.indexOf("<meta"));

    assert.equal(ui.respond("projectvi-ui://p1/ui/style.css").headers["Content-Type"], "text/css; charset=utf-8");
    assert.equal(ui.respond("projectvi-ui://p1/../escape.html").status, 404);
    assert.equal(ui.respond("projectvi-ui://p1/ui/%2e%2e/%2e%2e/escape.html").status, 404);
    assert.equal(ui.respond("projectvi-ui://p2/ui/hud.html").status, 404); // another package's file
    assert.equal(ui.respond("projectvi-ui://p9/ui/hud.html").status, 404);
    assert.equal(ui.respond("app://launcher/index.html").status, 404);

    ui.clear();
    assert.equal(ui.respond("projectvi-ui://p1/ui/hud.html").status, 404);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the bridge goes first, with or without a <head>", () => {
  assert.ok(injectBridge("<p>x</p>").startsWith("<script>"));
  assert.ok(injectBridge('<HEAD lang="en"><title>t</title></HEAD>').startsWith('<HEAD lang="en"><script>'));
});

function fakeWindow() {
  const w = { sent: [], interactive: [], closed: false, onClosedFn: null };
  w.send = (m) => w.sent.push(m);
  w.setInteractive = (on) => w.interactive.push(on);
  w.onClosed = (fn) => { w.onClosedFn = fn; };
  w.close = () => { w.closed = true; };
  return w;
}

function setup() {
  const windows = [];
  const keys = new Map();
  const ui = createUiContent();
  const overlay = new Overlay({
    createWindow: () => {
      const w = fakeWindow();
      windows.push(w);
      return w;
    },
    shortcuts: { register: (k, fn) => keys.set(k, fn), unregister: (k) => keys.delete(k) },
    ui,
    logger: { info() {}, warn() {} }
  });
  const child = new EventEmitter();
  child.connected = true;
  child.toClient = [];
  child.send = (m) => child.toClient.push(m);
  overlay.attach(child);
  return { overlay, windows, keys, child, ui };
}

test("the overlay opens on the client's session, shows what it sends, and routes chat and UI messages back", () => {
  const f = files();
  try {
    const { overlay, windows, keys, child } = setup();
    child.emit("message", { t: "chat", name: "Ana", text: "early" }); // before a session: nowhere to show it
    assert.equal(windows.length, 0);

    child.emit("message", { t: "session", server: "1.2.3.4:30120", player: { id: 3, name: "Kai" } });
    const w = windows[0];
    assert.deepEqual([...keys.keys()].sort(), [KEYS.chat, KEYS.players].sort());
    child.emit("message", { t: "package", key: "mod-hud", name: "hud", files: { "ui/hud.html": f.html } });
    child.emit("message", { t: "ui.open", id: "mod-hud/1", key: "mod-hud", path: "ui/hud.html" });
    child.emit("message", { t: "ui.open", id: "mod-hud/2", key: "mod-hud", path: "ui/missing.html" });
    child.emit("message", { t: "ui.send", id: "mod-hud/1", name: "speed", data: { kmh: 40 } });
    child.emit("message", { t: "chat", name: "Ana", text: "x".repeat(2000) });
    child.emit("message", { t: "players", players: [{ id: 1, name: "Ana", host: true }, { id: 3, name: "Kai", me: true, extra: "dropped" }] });
    child.emit("message", { t: "unknown" });
    child.emit("message", "not an object");

    assert.deepEqual(w.sent.map((m) => m.type), ["session", "ui.open", "ui.send", "chat", "players"]);
    assert.equal(w.sent[1].url, "projectvi-ui://p1/ui/hud.html");
    assert.equal(w.sent[3].text.length, 500);
    assert.deepEqual(w.sent[4].players[1], { id: 3, name: "Kai", host: false, me: true });

    // F6 opens chat: the overlay takes input; sending closes it again and the line goes to the client.
    keys.get(KEYS.chat)();
    assert.deepEqual(w.interactive, [true]);
    overlay.fromPage("chat.send", { text: "  hello  " });
    assert.deepEqual(w.interactive, [true, false]);
    assert.deepEqual(child.toClient, [{ t: "chat.send", text: "hello" }]);
    overlay.fromPage("chat.send", { text: "   " }); // empty: nothing sent
    assert.equal(child.toClient.length, 1);

    overlay.fromPage("ui.message", { id: "mod-hud/1", name: "clicked", data: { x: 1 } });
    assert.deepEqual(child.toClient[1], { t: "ui.message", id: "mod-hud/1", name: "clicked", data: { x: 1 } });

    keys.get(KEYS.players)();
    assert.equal(w.sent.at(-1).type, "players.toggle");

    // The session ends: window closed, keys given back, pages forgotten.
    child.emit("message", { t: "end", reason: "Left" });
    assert.equal(w.closed, true);
    assert.equal(keys.size, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the overlay closes when the client process exits", () => {
  const { windows, keys, child } = setup();
  child.emit("message", { t: "session", server: "s", player: { id: 1, name: "Kai" } });
  child.emit("exit", 0);
  assert.equal(windows[0].closed, true);
  assert.equal(keys.size, 0);
});
