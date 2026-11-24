/* Connection: the WebSocket to the backend (docs/technical-plan.md section 5). It authenticates with the
   ?token from the URL, hands each server message to the page (main.js), and comes back after a loss with
   backoff (0.5 s doubling to 8 s) under a quiet "Reconnecting…" by the heading; the next hello has
   everything. When the daemon itself is gone, the shell starts a new one and reloads the page. */
const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") || "";
/* the test hooks: open this subagent, expand the last diff (once each, main.js runHooks) */
export const hooks = { agent: params.get("agent"), open: params.get("open") };

let ws = null, retryMs = 500, handlers = null;
/* the test API's spy (test-api.js): sees every frame sent and received while set */
export const tap = { sent: null, got: null };

/* sends a message; false when the socket is not open (the message is not sent) */
export function send(msg) {
  tap.sent?.(msg);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/* on: { message(m), open(), close(wasOpen) } */
export function connect(on) {
  handlers = on;
  open();
}
function open() {
  let was = false;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    was = true; retryMs = 500;
    document.getElementById("conn").hidden = true;
    ws.send(JSON.stringify({ t: "auth", token: TOKEN }));
    handlers.open();
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } tap.got?.(m); handlers.message(m); };
  ws.onclose = e => {
    handlers.close(was);
    if (e.code === 4001) { handlers.refused(); return; }
    if (was) document.getElementById("conn").hidden = false;
    setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}
