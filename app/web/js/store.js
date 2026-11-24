/* Store: the page's one data object, filled by bridge.js from the server's messages (plan section 4).
   `data` is the sessions in the server's order, the same objects as in store.sessions. A session: {id,
   title, now, cwd, prs, state, model, effort, items, total, agents, background, stream}; `items` hold only
   the viewed conversation. `state` is the backend's (status.ts sessionState): status, since, detail, light,
   tone, word, mark, stopped, needsYou, review, driven. The page decides no status itself. */
const store = { sessions: new Map(), layout: null, menu: {}, settings: {}, pending: new Map(), ui: { connected: false } };
let data = [];
const syncData = () => { data = [...store.sessions.values()]; };
/* The pending requests (question, permission or plan) for the session, oldest first: its cards. */
const requestsOf = s => store.pending.get(s.id) || [];
let current = null;
/* The session to show: the one in the hash (an id prefix), else the current one, else the first that needs you or waits. */
function pickCurrent() {
  const hash = location.hash.slice(1);
  if (!current && hash) current = data.find(s => s.id.startsWith(hash))?.id || null;
  if (current && store.sessions.has(current)) return;
  current = (data.find(s => s.state.light === "red") || data.find(s => s.state.status === "idle") || data[0])?.id || null;
}


/* Applying server messages (bridge.js calls these). Each returns the parts to render. */
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
function applyHello(m) {
  store.sessions = new Map(m.sessions.map(s => [s.id, { ...blankSession(s.id), ...s }]));
  for (const s of store.sessions.values()) s.agents.forEach(a => { a.items ||= []; });
  store.layout = m.layout && (m.layout.groups.length || m.layout.others.length) ? m.layout : null;
  store.menu = m.menu || {}; store.settings = m.settings || {};
  store.pending = new Map();
  for (const p of m.pending || []) applyPending({ sid: p.sid, request: p.request });
  syncData();
}
function applySession(m) {
  const { t, replaces, ...fields } = m;
  let s = store.sessions.get(replaces) || store.sessions.get(m.id);
  if (replaces && store.sessions.has(replaces)) { store.sessions.delete(replaces); if (current === replaces) current = m.id; }
  if (!s) s = blankSession(m.id);
  Object.assign(s, fields); store.sessions.set(m.id, s);
  syncData();
}
function applyRemoved(m) { store.sessions.delete(m.id); store.pending.delete(m.id); syncData(); }
function applyItems(m) {
  const s = store.sessions.get(m.sid); if (!s) return null;
  const target = m.agent ? agentById(s, m.agent) : s; if (!target) return null;
  if (m.reset) target.items = m.upsert.slice();
  else if (m.prepend) { // `earlier`: the items before the oldest shown, never twice
    const have = new Set(target.items.map(i => i.id));
    target.items = m.upsert.filter(i => !have.has(i.id)).concat(target.items);
  } else upsertById(target.items, m.upsert);
  target.total = m.total;
  return target;
}
function applyAgents(m) { const s = store.sessions.get(m.sid); if (s) upsertById(s.agents, m.upsert, true); return s; }
function applyBackground(m) { const s = store.sessions.get(m.sid); if (s) upsertById(s.background, m.upsert); return s; }
function applyPending(m) {
  const list = (store.pending.get(m.sid) || []).filter(r => r.id !== (m.cleared || m.request?.id));
  if (m.request) list.push(m.request);
  list.sort((a, b) => a.since - b.since);
  if (list.length) store.pending.set(m.sid, list); else store.pending.delete(m.sid);
}
function applyStream(m) { const s = store.sessions.get(m.sid); if (s) s.stream = m.clear ? null : m.text; return s; }
