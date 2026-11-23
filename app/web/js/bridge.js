/* Bridge: the protocol client (plan section 5). It authenticates with the ?token from the URL, applies
   each server message to the store (store.js) and renders the parts that changed. It loads last, so the
   first render and the 1 s timer live here. A dropped connection is retried; the next hello has everything. */
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") || "";
let ws = null;
let viewing = null; // the {sid, agent} this page asked the server for
const hooks = { agent: params.get("agent"), open: params.get("open") }; // one-shot: open a subagent, expand the last diff

function send(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function requestView(sid, agent) { viewing = { sid, agent: agent || null }; send({ t: "view", sid, agent: agent || null }); }

/* render(part): side, header, log, card, rail, or conv (all of the view) */
function render(...parts) {
  for (const p of new Set(parts)) {
    if (p === "side") renderSide();
    else if (p === "conv") renderConv();
    else if (p === "header") renderHeader();
    else if (p === "log") renderLog();
    else if (p === "card") renderCard();
    else if (p === "rail") renderRail();
  }
}
const isCurrent = sid => sid === current;
const isViewed = (sid, agent) => sid === current && (agent || null) === (view || null);

function onMessage(m) {
  switch (m.t) {
    case "hello": {
      applyHello(m); layout = null; pickCurrent();
      const before = mounted; renderAll(); // mounting a view asks the server for it
      if (mounted && mounted === before) requestView(current, view); // a reconnect keeps the composer as it was
      break;
    }
    case "session": {
      const had = store.sessions.has(m.id) || store.sessions.has(m.replaces);
      if (m.replaces) renamed(m.replaces, m.id);
      applySession(m);
      if (!had && wantNew && m.id.startsWith("new-")) { wantNew = false; current = m.id; view = null; mode = "insert"; renderAll(); break; }
      if (wantOpen === m.id) { wantOpen = null; current = m.id; view = null; renderAll(); break; } // opened from the Open list
      if (!current) pickCurrent();
      syncInterrupt(); // the turn ended under the "Interrupt?" prompt
      if (!had || !mounted) { renderAll(); break; }
      render("side", ...(isCurrent(m.id) ? ["header", "log", "card", "rail"] : []));
      break;
    }
    case "removed": {
      applyRemoved(m);
      if (isCurrent(m.id)) { current = null; view = null; pickCurrent(); renderAll(); } else render("side");
      break;
    }
    case "items": {
      if (!applyItems(m)) break;
      if (!isViewed(m.sid, m.agent)) break;
      if (m.prepend) { renderLogKeepingPlace(); break; } // earlier items: the card and header don't change
      render("log", "card", "header"); // the header drops its Now line while a new session is empty
      runHooks(m);
      break;
    }
    case "agents": {
      const s = applyAgents(m); if (!s) break;
      s.agents.forEach(a => { a.items ||= []; });
      if (isCurrent(m.sid) && view && !agentById(s, view)) view = null;
      render("side", ...(isCurrent(m.sid) ? ["header", "log", "rail"] : []));
      break;
    }
    case "background": {
      if (!applyBackground(m)) break;
      render("side", ...(isCurrent(m.sid) ? ["rail", "card"] : []));
      break;
    }
    case "pending": {
      applyPending(m);
      render("side", ...(isCurrent(m.sid) ? ["log", "card", "rail"] : []));
      break;
    }
    case "stream": {
      if (applyStream(m) && isViewed(m.sid, null)) render("log");
      break;
    }
    case "menu": {
      store.menu[m.cwd] = { commands: m.commands || [], models: m.models || [] };
      if (isCurrent(current)) render("header");
      break;
    }
    case "toast": toast(m.text); break;
    case "recent": applyRecent(m); break;
    case "restore": restoreTexts(m.sid, m.texts); break;
    default: break;
  }
}

/* a session's id changed (a new session got its real id, or a reset): the view on screen, the layout and
   the subscription follow it, so the message box keeps what you typed */
function renamed(from, to) {
  const swap = ids => ids.map(x => x === from ? to : x);
  for (const l of [layout, store.layout]) if (l) { l.groups.forEach(g => g.ids = swap(g.ids)); l.others = swap(l.others); }
  if (mounted && mounted.startsWith(from + "|")) mounted = to + mounted.slice(from.length);
  if (viewing && viewing.sid === from) viewing.sid = to;
  /* a card still up moves with it, with what you picked on it */
  if (store.pending.has(from)) { store.pending.set(to, store.pending.get(from)); store.pending.delete(from); }
  for (const k of Object.keys(qstate)) if (k.startsWith(from + ":")) { qstate[to + k.slice(from.length)] = qstate[k]; delete qstate[k]; }
}

/* the ?agent= and ?open= hooks, once the view they need has its items */
function runHooks(m) {
  if (hooks.agent && !m.agent) {
    const s = cur(); if (s && agentById(s, hooks.agent)) { view = hooks.agent; hooks.agent = null; renderConv(); }
    return;
  }
  if (hooks.open) {
    const r = [...document.querySelectorAll(".frow .fc")].pop();
    if (r) { hooks.open = null; r.click(); r.scrollIntoView({ block: "start" }); }
  }
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { store.ui.connected = true; ws.send(JSON.stringify({ t: "auth", token: TOKEN })); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = e => {
    store.ui.connected = false; viewing = null;
    if (e.code === 4001) { toast("The page's token was refused. Open Synopia again."); return; }
    setTimeout(connect, 1000);
  };
}

/* live durations and ages tick once a second, in place */
setInterval(() => {
  NOWISH = liveNow();
  document.querySelectorAll("[data-live]").forEach(el => { el.textContent = tookLive(NOWISH - new Date(el.dataset.live)); });
  document.querySelectorAll("[data-age]").forEach(el => { el.textContent = dur(+el.dataset.age); });
  document.querySelectorAll("[data-until]").forEach(el => { el.textContent = left(+el.dataset.until); });
}, 1000);

renderAll();
connect();
