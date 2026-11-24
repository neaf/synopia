/* Connection: the WebSocket to the backend (protocol.js has every message). It authenticates with the
   ?token from the URL, checks each server frame against the schema, hands it to the page (main.js), and
   comes back after a loss with backoff (0.5 s doubling to 8 s) under a quiet "Reconnecting…" by the
   heading; the next hello has everything. When the daemon itself is gone, the shell starts a new one and
   reloads the page. A hello of another protocol version (or none: a daemon from before `v`) is caught
   before the schema check, as the schema may differ too: "Updating…" in place of "Reconnecting…", the
   socket closes and retries with the same backoff, and the page reloads once a daemon of its own version
   answers. That is the window after an update, while the old daemon serves the new page files until it
   hands over. A newer daemon reloads the page at once, once per version (its files may be newer too).
   Actions (act) carry an id and wait for their ack; while the socket is down they are refused with a
   toast and the page keeps what it had (requirements Q9). */
import { VERSION, SERVER, problem } from "./protocol.js";

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") || "";
/* the test hooks: open this subagent, expand the last diff (once each, main.js runHooks) */
export const hooks = { agent: params.get("agent"), open: params.get("open") };

const NOT_CONNECTED = "Not connected to the Synopia backend, so that wasn't done. Try again once it's back.";
const LOST = "The connection to the Synopia backend dropped before it confirmed that. Check that it happened.";

let ws = null, retryMs = 500, handlers = null, up = false, nextId = 0;
let updating = false; // a daemon of another version answered: wait for one of this version, then reload
const waiting = new Map(); // action id -> done(ok, error)
/* the test API's spy (test-api.js): sees every frame sent and received while set */
export const tap = { sent: null, got: null };

/* sends a message; false when the socket is not open (the message is not sent) */
export function send(msg) {
  tap.sent?.(msg);
  if (updating || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/* A request you made (view data, a preview, a file to open): sent, or a toast while the socket is down.
   False when not sent, so the caller sets no "asked" flag and the next click asks again. */
export function request(msg) {
  if (send(msg)) return true;
  handlers?.toast(NOT_CONNECTED);
  return false;
}

/* An action (protocol.js ACTIONS): sent with an id; done(ok, error) once the backend acks it. While the
   socket is down it isn't sent: a toast (`refused`, else NOT_CONNECTED) and false, and the caller keeps
   its state. A refusal in the ack is toasted here; so is a connection lost before the ack. */
export function act(msg, { done, refused } = {}) {
  if (!up || !ws || ws.readyState !== WebSocket.OPEN) { handlers?.toast(refused || NOT_CONNECTED); return false; }
  const id = `a${++nextId}`;
  waiting.set(id, done || null);
  send({ ...msg, id });
  return true;
}

/* the actions sent and not acked yet (the test API's settle point) */
export const acting = () => waiting.size;

/* on: { message(m), open(), close(wasOpen), refused(), toast(text) } */
export function connect(on) {
  handlers = on;
  open();
}

/* a frame from the socket: hello's version first, then the schema; acks settled here, the rest to the page */
function receive(m) {
  if (m && m.t === "hello") {
    if (m.v !== VERSION) { otherVersion(m.v); return; }
    if (updating) { location.reload(); return; } // this version again: the page starts clean on it
  }
  if (updating) return; // nothing from a daemon of another version reaches the page
  const bad = problem(SERVER, m);
  if (bad) { console.warn(`Synopia: a frame from the backend was dropped (${bad})`); return; }
  if (m.t === "ack") { acked(m); return; }
  handlers.message(m);
}
function acked(m) {
  if (!waiting.has(m.id)) return;
  const done = waiting.get(m.id); waiting.delete(m.id);
  if (!m.ok) handlers.toast(m.error || "Synopia didn't do that.");
  done?.(m.ok, m.error || "");
}
/* A daemon of another version. Newer: reload once for it (sessionStorage), as its page files may be newer.
   Older, none, or already reloaded for it: "Updating…", close, and retry until this version answers. */
function otherVersion(v) {
  const key = "synopia.reloadedFor";
  if (typeof v === "number" && v > VERSION && sessionStorage.getItem(key) !== String(v)) {
    sessionStorage.setItem(key, String(v));
    location.reload();
    return;
  }
  if (!updating) console.warn(`Synopia: the backend speaks protocol ${v ?? "(none)"}, this page ${VERSION}; waiting for the update`);
  updating = true; up = false;
  const conn = document.getElementById("conn");
  conn.textContent = "Updating…"; conn.hidden = false;
  ws.close();
}

function open() {
  let was = false;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    was = true;
    ws.send(JSON.stringify({ t: "auth", token: TOKEN }));
    if (updating) return; // "Updating…" and the backoff stay until a daemon of this version answers
    up = true; retryMs = 500;
    document.getElementById("conn").hidden = true;
    handlers.open();
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } tap.got?.(m); receive(m); };
  ws.onclose = e => {
    up = false;
    /* actions sent and not acked: the backend may or may not have done them */
    if (waiting.size) {
      const dones = [...waiting.values()]; waiting.clear();
      handlers.toast(LOST);
      for (const done of dones) done?.(false, LOST);
    }
    handlers.close(was);
    if (e.code === 4001) { handlers.refused(); return; }
    if (was) document.getElementById("conn").hidden = false;
    setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}
