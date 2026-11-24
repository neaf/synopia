// connection.js: a daemon of another protocol version (an old daemon serving the new page files after an
// update) gives "Updating…" and retries instead of a blank page; the page reloads once its own version answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../js/protocol.js";

const conn = { hidden: true, textContent: "Reconnecting…" };
let reloads = 0;
const sockets = [], retries = [], warnings = [];
globalThis.location = { search: "?token=t", protocol: "http:", host: "127.0.0.1:1", reload: () => { reloads++; } };
globalThis.document = { getElementById: id => (id === "conn" ? conn : null) };
const stored = new Map();
globalThis.sessionStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) };
class FakeSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen(); }
  frame(m) { this.onmessage({ data: JSON.stringify(m) }); }
}
globalThis.WebSocket = FakeSocket;
const realTimeout = globalThis.setTimeout, realWarn = console.warn;

const { connect, send } = await import("../js/connection.js");
const hello = v => ({ t: "hello", ...(v === undefined ? {} : { v }), code: "c", sessions: [], pending: [], layout: {}, menu: {} });

test("a daemon of an older protocol: Updating…, retries, then a reload once this version answers", () => {
  globalThis.setTimeout = (fn, ms) => { retries.push(ms); fn(); return 0; }; // the retry, at once
  console.warn = w => warnings.push(w);
  try {
    const got = [], toasts = [];
    connect({ message: m => got.push(m), open() {}, close() {}, refused() {}, toast: t => toasts.push(t) });
    sockets[0].open();
    assert.deepEqual(sockets[0].sent, [{ t: "auth", token: "t" }]);
    sockets[0].frame({ t: "hello", code: "old", sessions: [] }); // a daemon from before `v`: also not the schema
    assert.equal(conn.textContent, "Updating…");
    assert.equal(conn.hidden, false);
    assert.deepEqual(got, [], "nothing from the old daemon reaches the page");
    assert.equal(sockets.length, 2, "closed and retried");
    assert.equal(reloads, 0);

    sockets[1].open();
    assert.equal(conn.hidden, false, "Updating… stays while the socket is open");
    assert.equal(send({ t: "ui", patch: {} }), false, "the page sends nothing to the other version");
    sockets[1].frame(hello(VERSION - 1));
    assert.equal(sockets.length, 3);
    assert.ok(retries[1] > retries[0], "with the reconnect backoff");

    sockets[2].open();
    sockets[2].frame(hello(VERSION));
    assert.equal(reloads, 1, "this version answered: the page reloads");
    assert.deepEqual(got, []);
    assert.deepEqual(toasts, []);
    assert.equal(warnings.length, 1, "one warning, not one per retry");
  } finally {
    globalThis.setTimeout = realTimeout; console.warn = realWarn;
  }
});

test("a newer daemon reloads the page once for its version, then waits as for an older one", () => {
  const n = sockets.length, r = reloads;
  globalThis.setTimeout = () => 0; // no retry in this test
  try {
    sockets[n - 1].frame(hello(VERSION + 1));
    assert.equal(reloads, r + 1, "a reload for the newer files");
    assert.equal(stored.get("synopia.reloadedFor"), String(VERSION + 1));
    sockets[n - 1].frame(hello(VERSION + 1)); // the reloaded page meets the same daemon
    assert.equal(reloads, r + 1, "not a second time");
    assert.equal(conn.textContent, "Updating…");
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});
