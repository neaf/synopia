/* State: the page's one store, filled from the server's messages (main.js hands each one here). A session:
   {id, title, now, cwd, prs, state, model, effort, items, total, agents, background, stream}; `items` hold
   only the viewed conversation. `state` is the backend's (status.ts sessionState): status, since, detail,
   light, tone, word, mark, stopped, needsYou, review, driven. The page decides no status itself.
   This module is the only writer of `current` (the session shown) and `view` (the subagent shown in it,
   null for the main conversation): everything else calls select() or selectView(). */
export const store = { sessions: new Map(), layout: null, menu: {}, settings: {}, pending: new Map(), ui: { connected: false } };
/* every session in the server's order, the same objects as in store.sessions */
export let data = [];
export let current = null;
export let view = null;

const syncData = () => { data = [...store.sessions.values()]; };
const agentIn = (s, id) => (s?.agents || []).find(a => a.id === id);

export const cur = () => store.sessions.get(current);
export const isCurrent = sid => sid === current;
export const isViewed = (sid, agent) => sid === current && (agent || null) === (view || null);
/* The pending requests (question, permission or plan) for the session, oldest first: its cards. */
export const requestsOf = s => store.pending.get(s.id) || [];

/* Show a session, at its main conversation or at one of its subagents (dropped if the session has no such one). */
export function select(sid, agent = null) {
  current = sid || null;
  view = agent && agentIn(store.sessions.get(current), agent) ? agent : null;
}
/* Show a subagent of the current session, or its main conversation (null). */
export function selectView(agent) { view = agent && agentIn(cur(), agent) ? agent : null; }

/* The session to show: the one in the hash (an id prefix), else the current one, else the first that needs you or waits. */
export function pickCurrent() {
  const hash = location.hash.slice(1);
  if (!current && hash) current = data.find(s => s.id.startsWith(hash))?.id || null;
  if (current && store.sessions.has(current)) return;
  current = (data.find(s => s.state.light === "red") || data.find(s => s.state.status === "idle") || data[0])?.id || null;
  view = null;
}

export function setConnected(on) { store.ui.connected = on; }

/* ---------- applying server messages ---------- */
/* a session the server hasn't described yet: shown as your turn until its `session` frame */
const blankState = () => ({ status: "idle", since: Date.now(), detail: {}, light: "amber", tone: "amber", word: "Your turn", mark: "stopped", stopped: false, needsYou: null, review: 0, driven: false });
const blankSession = id => ({ id, title: "", now: "", cwd: "", prs: [], state: blankState(), items: [], total: 0, agents: [], background: [], stream: null, outbox: [] });
function upsertById(list, upsert, keep) {
  const at = new Map(list.map((x, i) => [x.id ?? x.toolUseId, i]));
  for (const x of upsert) {
    const key = x.id ?? x.toolUseId, i = at.get(key);
    if (i === undefined) { at.set(key, list.length); list.push(keep ? { ...x } : x); }
    else list[i] = keep ? Object.assign(list[i], x) : x;
  }
}
export function applyHello(m) {
  store.sessions = new Map(m.sessions.map(s => [s.id, { ...blankSession(s.id), ...s }]));
  for (const s of store.sessions.values()) s.agents.forEach(a => { a.items ||= []; });
  store.layout = m.layout && (m.layout.groups.length || m.layout.others.length) ? m.layout : null;
  store.menu = m.menu || {}; store.settings = m.settings || {};
  store.pending = new Map();
  for (const p of m.pending || []) applyPending({ sid: p.sid, request: p.request });
  syncData();
}
/* a `session` frame; with `replaces`, the session's id changed (a new session got its real id, or a reset) */
export function applySession(m) {
  const { t, replaces, ...fields } = m;
  let s = store.sessions.get(replaces) || store.sessions.get(m.id);
  if (replaces && store.sessions.has(replaces)) {
    store.sessions.delete(replaces);
    if (current === replaces) current = m.id;
    if (store.pending.has(replaces)) { store.pending.set(m.id, store.pending.get(replaces)); store.pending.delete(replaces); } // a card still up moves with it
  }
  if (!s) s = blankSession(m.id);
  Object.assign(s, fields); store.sessions.set(m.id, s);
  syncData();
}
/* returns whether it was the session shown; then the next one to show is picked */
export function applyRemoved(m) {
  store.sessions.delete(m.id); store.pending.delete(m.id); syncData();
  if (m.id !== current) return false;
  current = null; view = null; pickCurrent();
  return true;
}
export function applyItems(m) {
  const s = store.sessions.get(m.sid); if (!s) return null;
  const target = m.agent ? agentIn(s, m.agent) : s; if (!target) return null;
  if (m.reset) target.items = m.upsert.slice();
  else if (m.prepend) { // `earlier`: the items before the oldest shown, never twice
    const have = new Set(target.items.map(i => i.id));
    target.items = m.upsert.filter(i => !have.has(i.id)).concat(target.items);
  } else upsertById(target.items, m.upsert);
  target.total = m.total;
  return target;
}
export function applyAgents(m) {
  const s = store.sessions.get(m.sid); if (!s) return null;
  upsertById(s.agents, m.upsert, true);
  s.agents.forEach(a => { a.items ||= []; });
  if (m.sid === current && view && !agentIn(s, view)) view = null;
  return s;
}
export function applyBackground(m) { const s = store.sessions.get(m.sid); if (s) upsertById(s.background, m.upsert); return s; }
export function applyPending(m) {
  const list = (store.pending.get(m.sid) || []).filter(r => r.id !== (m.cleared || m.request?.id));
  if (m.request) list.push(m.request);
  list.sort((a, b) => a.since - b.since);
  if (list.length) store.pending.set(m.sid, list); else store.pending.delete(m.sid);
}
export function applyStream(m) { const s = store.sessions.get(m.sid); if (s) s.stream = m.clear ? null : m.text; return s; }
export function applyMenu(m) { store.menu[m.cwd] = { commands: m.commands || [], models: m.models || [] }; }
