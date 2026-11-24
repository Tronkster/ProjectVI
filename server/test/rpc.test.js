const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { JsonRpcPeer } = require("../src/rpc");

function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return [new JsonRpcPeer(bToA, aToB), new JsonRpcPeer(aToB, bToA)];
}

test("requests, results, errors and notifications", async () => {
  const [a, b] = pair();
  b.onRequest("add", ({ x, y }) => x + y);
  b.onRequest("fail", () => {
    throw Object.assign(new Error("nope"), { code: 1001 });
  });
  const seen = [];
  b.onNotification("note", (p) => seen.push(p));

  assert.equal(await a.request("add", { x: 2, y: 3 }), 5);
  await assert.rejects(a.request("fail"), (err) => err.code === 1001 && err.message === "nope");
  await assert.rejects(a.request("missing"), (err) => err.code === -32601);
  a.notify("note", { hi: 1 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [{ hi: 1 }]);
});

test("timeouts and closing reject pending calls", async () => {
  // Request timers are unref'd, so on Node 22 the test runner would see an empty event loop
  // and give up before the timeout fires. Hold the loop open while waiting for it.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const a = new JsonRpcPeer(new PassThrough(), new PassThrough()); // nobody answers
    await assert.rejects(a.request("never", {}, { timeoutMs: 50 }), /timed out/);
    const pending = a.request("never", {}, { timeoutMs: 5000 });
    a.close("bye");
    await assert.rejects(pending, /bye/);
    await assert.rejects(a.request("after"), /closed/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("oversized and broken frames are dropped, not fatal", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const notes = [];
  const peer = new JsonRpcPeer(input, output, { onDiagnostic: (m) => notes.push(m) });
  peer.onNotification("ok", () => notes.push("ok"));
  input.write(`${"x".repeat(1024 * 1024 + 10)}`);
  input.write("\nnot json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ok" })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.ok(notes.some((n) => /larger than 1 MB/.test(n)));
  assert.ok(notes.some((n) => /isn't JSON/.test(n)));
  assert.equal(notes.at(-1), "ok");
});
