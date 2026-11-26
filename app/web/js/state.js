/* State: the page's one store, filled from the server's messages (main.js hands each one here). A session:
   {id, title, now, cwd, prs, state, model, effort, items, total, agents, background, stream}; `items` hold
   only the viewed conversation. `state` is the backend's (status.ts sessionState): status, since, detail,
   light, tone, word, mark, stopped, needsYou, review, driven. The page decides no status itself.
   This module is the only writer of `current` (the session shown) and `view` (the subagent, or the background
   shell or monitor by its tool use id, shown in it; null for the main conversation): everything else calls select() or selectView(). `mounted` is the
   view on screen, which transcript.js renderConv sets once it has built that view's frame. */
/* `layout`: the sidebar's groups, the backend's (layout.ts), replaced whole by `hello`, `layout` and a `session` with `replaces` */
export const store = { sessions: new Map(), layout: { groups: [], others: [] }, menu: {}, pending: new Map(), ui: { connected: false } };
/* every session in the server's order, the same objects as in store.sessions */
export let data = [];
export let current = null;
export let view = null;

/* "<sid>|<agent id>" of the view on screen, null for none */
export let mounted = null;
export function setMounted(key) { mounted = key || null; }
/* the 1 s ticker's time (main.js), so every live time in one render agrees */
export let nowish = Date.now();
/* The credential refresh of each folder (creds.ts, R8.2, 2026-11-26): the backend owns it, this is the last
   `creds` frame per folder, whole, naming the sessions it is for. creds-line.js draws it. */
const credsByRoot = new Map();
export function applyCreds(m) { if (m.phase === "idle" || !m.sids.length) credsByRoot.delete(m.root); else credsByRoot.set(m.root, m); }
export const credsOf = sid => [...credsByRoot.values()].find(f => f.sids.includes(sid)) || null;
export const credsAll = () => [...credsByRoot.values()].map(f => ({ ...f, sids: [...f.sids] }));
export function tick(now) { nowish = now; }

const syncData = () => { data = [...store.sessions.values()]; };
/* a session's subagents and forks */
export const agentsOf = s => s?.agents || [];
export const agentById = (s, id) => agentsOf(s).find(a => a.id === id);
/* A session's `!` runs (session.ts bangs, R5.13 and R7.1, 2026-11-26) as background shells of the panel, marked
   `own` (you started it): the backend owns them, this is only their shape for the panel and the shell view. */
const ownMemo = new WeakMap();
export function ownBg(s) {
  const runs = s?.bangs; if (!runs || !runs.length) return [];
  let out = ownMemo.get(runs);
  if (!out) ownMemo.set(runs, out = runs.map(r => ({ toolUseId: r.id, own: true, kind: "shell", description: "", command: r.cmd, timeout: 0, persistent: false,
    start: new Date(r.at).toISOString(), end: r.end ? new Date(r.end).toISOString() : null, landed: r.landed || null,
    status: r.running ? "running" : r.interrupted ? "killed" : r.exit === 0 ? "completed" : "failed",
    summary: !r.running && !r.interrupted && r.exit ? `Exit code ${r.exit}` : "", waiting: !!r.waiting, quiet: !!r.quiet, cardAt: r.cardAt ?? null })));
  return out;
}
/* Claude's foreground Bash steps of the main conversation (R7.2, 2026-11-26) as runs of the shell view, marked `step`:
   the turn's own step, not background work, so no panel card (R7.1). One that runs in the background is its entry. */
export function stepBg(s) {
  const items = s?.items; if (!items?.length) return [];
  const bg = new Set((s.background || []).map(b => b.toolUseId)), out = [];
  for (const t of items) if (t.k === "tool" && t.name === "Bash" && !t.bg && !bg.has(t.id))
    out.push({ toolUseId: t.id, step: true, kind: "shell", description: t.obj || "", command: t.input || "", timeout: 0, persistent: false, start: t.since || t.ts,
      end: t.state === "running" ? null : t.out?.at || t.ts, status: t.state === "running" ? "running" : t.state === "failed" ? "failed" : t.state === "stopped" ? "stopped" : "completed", summary: "" });
  return out;
}
/* the folder's credential refresh while it runs (creds.ts, 2026-11-26), as a run Synopia started, marked `creds` */
export function credsBg(s) {
  const f = s && credsOf(s.id); if (!f || f.phase !== "running" || !f.at) return [];
  return [{ toolUseId: `creds:${f.root}`, creds: f.root, kind: "shell", description: "Refresh credentials", command: f.command || "", timeout: 0, persistent: false,
    start: new Date(f.at).toISOString(), end: null, status: "running", summary: "", cardAt: f.cardAt ?? null, waiting: !!f.waiting, quiet: !!f.quiet }];
}
/* Claude's own background work (not a step of its turn, nor yours or Synopia's): what "N running in the background" counts */
export const isClaudeBg = b => !b.own && !b.step && !b.creds;
/* a session's runs for the panel and the shell view: Claude's background shells and monitors, its foreground Bash
   steps (the shell view only), your `!` runs, then the credential refresh */
export const bgAll = s => [...(s?.background || []), ...stepBg(s), ...ownBg(s), ...credsBg(s)];
/* a session's background shell or monitor, by its tool use id (a `!` run by its id) */
export const bgById = (s, id) => bgAll(s).find(b => b.toolUseId === id);
/* what a view id names in the session: a subagent or a shell or monitor */
const viewable = (s, id) => !!id && !!(agentById(s, id) || bgById(s, id));
/* how long a subagent ran, or runs (to the ticker's time) */
export const agentMs = a => a.start ? (a.finished ? new Date(a.end) : nowish) - new Date(a.start) : 0;

export const cur = () => store.sessions.get(current);
export const isCurrent = sid => sid === current;
export const isViewed = (sid, agent) => sid === current && (agent || null) === (view || null);
/* The pending requests (question, permission or plan) for the session, oldest first: its cards. */
export const requestsOf = s => store.pending.get(s.id) || [];
/* The messages you sent that the transcript doesn't hold yet (the outbox, R5.5), oldest first; the
   queued ones were sent while a turn runs and wait for Claude's next step. */
export const waitingOf = s => (s.outbox || []).filter(q => !(q.landed && s.items.some(i => i.id === q.landed)));
export const queuedOf = s => waitingOf(s).filter(q => q.queued !== false);

/* Show a session, at its main conversation or at one of its subagents, shells or monitors (dropped if the session has no such one). */
export function select(sid, id = null) {
  current = sid || null;
  view = viewable(store.sessions.get(current), id) ? id : null;
}
/* Show a subagent, shell or monitor of the current session, or its main conversation (null). */
export function selectView(id) { view = viewable(cur(), id) ? id : null; }

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
  store.layout = m.layout;
  store.menu = m.menu || {};
  store.pending = new Map();
  for (const p of m.pending || []) applyPending({ sid: p.sid, request: p.request });
  syncData();
}
/* a `session` frame; with `replaces`, the session's id changed (a new session got its real id, or a reset),
   and its `layout` has the new id in the old one's place */
export function applySession(m) {
  const { t, replaces, layout, ...fields } = m;
  if (layout) store.layout = layout;
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
  const target = m.agent ? agentById(s, m.agent) : s; if (!target) return null;
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
  if (m.sid === current && view && !viewable(s, view)) view = null;
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
export function applyLayout(m) { store.layout = m.layout; }
export function applyMenu(m) { store.menu[m.cwd] = { commands: m.commands || [], models: m.models || [] }; }
