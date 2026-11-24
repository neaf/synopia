/* Connection: the WebSocket to the backend (protocol.js has every message). It authenticates with the
   ?token from the URL, checks each server frame against the schema, hands it to the page (main.js), and
   comes back after a loss with backoff (0.5 s doubling to 8 s) under a quiet "Reconnecting…" by the
   heading; the next hello has everything. When the daemon itself is gone, the shell starts a new one and
   reloads the page. A hello of another protocol version reloads the page (its files are the daemon's).
   Actions (act) carry an id and wait for their ack; while the socket is down they are refused with a
   toast and the page keeps what it had (requirements Q9). */
import { VERSION, SERVER, problem } from "./protocol.js";

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") || "";
/* the test hooks: open this subagent, expand the last diff (once each, main.js runHooks) */
export const hooks = { agent: params.get("agent"), open: params.get("open") };

export const NOT_CONNECTED = "Not connected to the Synopia backend, so that wasn't done. Try again once it's back.";
export const LOST = "The connection to the Synopia backend dropped before it confirmed that. Check that it happened.";

let ws = null, retryMs = 500, handlers = null, up = false, nextId = 0;
const waiting = new Map(); // action id -> done(ok, error)
const unsent = new Map(); // state the backend hasn't taken (sync): key -> the last frame
/* the test API's spy (test-api.js): sees every frame sent and received while set */
export const tap = { sent: null, got: null };

/* sends a message; false when the socket is not open (the message is not sent) */
export function send(msg) {
  tap.sent?.(msg);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
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

/* State the page holds and the backend stores (the layout): sent now, or kept and given back by
   takeUnsent once the socket is back, so the next hello doesn't undo it. */
export function sync(key, msg) {
  if (send(msg)) unsent.delete(key); else unsent.set(key, msg);
}
export function takeUnsent(key) { const m = unsent.get(key); unsent.delete(key); return m || null; }

/* on: { message(m), open(), close(wasOpen), refused(), toast(text) } */
export function connect(on) {
  handlers = on;
  open();
}

/* a frame from the socket: checked, acks settled here, the rest to the page */
function receive(m) {
  const bad = problem(SERVER, m);
  if (bad) { console.warn(`Synopia: a frame from the backend was dropped (${bad})`); return; }
  if (m.t === "ack") { acked(m); return; }
  if (m.t === "hello" && m.v !== VERSION && reloadFor(m.v)) return;
  handlers.message(m);
}
function acked(m) {
  if (!waiting.has(m.id)) return;
  const done = waiting.get(m.id); waiting.delete(m.id);
  if (!m.ok) handlers.toast(m.error || "Synopia didn't do that.");
  done?.(m.ok, m.error || "");
}
/* once per version: a page reloaded for it that still differs carries on (and says so) instead of looping */
function reloadFor(v) {
  const key = "synopia.reloadedFor", was = sessionStorage.getItem(key);
  if (was === String(v)) { handlers.toast("This page and the Synopia backend don't match. Quit and open Synopia again."); return false; }
  sessionStorage.setItem(key, String(v));
  location.reload();
  return true;
}

function open() {
  let was = false;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    was = true; up = true; retryMs = 500;
    document.getElementById("conn").hidden = true;
    ws.send(JSON.stringify({ t: "auth", token: TOKEN }));
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
