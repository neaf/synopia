/* UI state (requirements R3.9): what is on screen comes back exactly after a reload, a crash or a quit.
   The page is only UI: the backend keeps this in state.json `ui` and returns it in `hello`. The page
   sends `ui {patch}`, only what changed, 300 ms after the last change (2 s at most) and at once when it
   is hidden or unloads. Applied before the first render, so the default view never shows first; the
   scroll waits for the reset items of the view, and the earlier items it had loaded, then goes to its
   anchor: an item block's key and the pixels into it, or the bottom (within 40 px of it, pinned there).
   Per session: the scroll and the loaded-earlier range per view, open steps, open diffs and folds, the
   draft (text, cursor, pasted images, stored by the backend as files), the half-answered card per
   request, and the rail's expansion state. Nothing is shared live between pages: the last one to
   write wins. */
import { store, current, view, cur, requestsOf, select, mounted, agentById } from "./state.js";
import { send, TOKEN } from "./connection.js";
import { openBg, setOpenBg } from "./rail.js";
import { pv, previewShown, restorePreview } from "./preview.js";
import { viewer, showViewer, imageUrl } from "./images.js";
import { mode, setMode } from "./mode.js";
import { themePref, themeSet } from "./theme-switch.js";
import { openList, openListShown, restoreOpenList } from "./open-list.js";

const uiS = {}; // sid -> { scroll: {view: anchor}, earlier: {view: oldest item id}, diffs: Set, folds: Set }
const drafts = new Map(); // sid -> { text, cursor, atts } for the sessions not on screen
const stored = new Set(); // pasted image ids the backend has as files
let sentTop = {}, sentSess = {}; // what the backend has, as JSON per field
let uiLoaded = false, timer = null, firstChange = 0, restoring = null, typing = null, afterFirst = null;
const TOP = ["current", "view", "mode", "openBg", "openList", "preview", "viewer", "theme"];
const sess = sid => (uiS[sid] ||= { scroll: {}, earlier: {}, diffs: new Set(), folds: new Set() });
const viewKey = () => view || "";
/* the steps opened by a click, "<sid>|<view>|<item id>" (transcript.js): a redraw and a reload keep them */
export const openSteps = new Set();
/* the log's render and its earlier-items request (transcript.js; main.js passes them, so no module cycle) */
let logFns = { render() {}, earlier() {} };
export function useLog(render, earlier) { logFns = { render, earlier }; }
/* the message box's text and pasted images, and the cards' picks (composer.js and card.js hand them over when
   they load, so neither imports the other way) */
let box = { attachments: [], value: ta => ta.value, render() {} }, cards = {};
export function useBox(b) { box = b; }
export function useCards(q) { cards = q; }
/* a pasted image's id, the name of its file in the backend's drafts (composer.js) */
export const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");

/* the first hello has been applied; a restored view still waits for its items */
export const loaded = () => uiLoaded;
export const isRestoring = () => !!restoring;

/* ---------- applying the stored state: once per page load, from the first hello ---------- */
export function applyHello(u) {
  const first = !uiLoaded; uiLoaded = true;
  if (!first) { sentTop = {}; sentSess = {}; changed(); return; } // a reconnect: this page's state is the newer, send all of it
  themeSet(u && typeof u === "object" ? u.theme : null); // the stored theme, or the system's (theme-switch.js)
  if (!u || typeof u !== "object") return;
  const has = sid => typeof sid === "string" && store.sessions.has(sid);
  if (!location.hash && has(u.current)) select(u.current, u.view);
  if (u.mode === "insert" || u.mode === "normal") setMode(u.mode, false);
  if (typeof u.openBg === "string") setOpenBg(u.openBg);
  for (const [sid, x] of Object.entries(u.sessions || {})) {
    if (!has(sid) || !x) continue;
    const s = sess(sid);
    sentSess[sid] = Object.fromEntries(Object.keys(x).map(k => [k, "?"])); // the backend has these: the next patch sets or clears them
    s.scroll = { ...(x.scroll || {}) }; s.earlier = { ...(x.earlier || {}) };
    s.diffs = new Set(x.diffs || []); s.folds = new Set(x.folds || []);
    for (const k of x.steps || []) openSteps.add(`${sid}|${k}`);
    const ids = new Set(requestsOf({ id: sid }).map(r => r.id));
    for (const [rid, st] of Object.entries(x.cards || {})) {
      if (!ids.has(rid) || !st || typeof st !== "object") continue; // the request is gone: so is its card
      const { typing: text, ...rest } = st;
      cards[`${sid}:${rid}`] = { qi: 0, oi: 0, picks: {}, own: {}, notes: {}, target: null, noteRow: null, ...rest };
      if (typeof text === "string" && rest.target != null) typing = { key: `${sid}:${rid}`, text };
    }
    if (x.draft) {
      const atts = (x.draft.images || []).map(im => {
        stored.add(im.id);
        const a = { id: im.id, n: im.n || 0, mediaType: im.mediaType, url: imageUrl(sid, null, `draft:${im.id}`), data: null };
        fetch(a.url).then(r => r.ok ? r.blob() : null).then(b => { if (!b) return; const fr = new FileReader(); fr.onload = () => { a.data = fr.result; }; fr.readAsDataURL(b); }).catch(() => {});
        return a;
      });
      drafts.set(sid, { text: String(x.draft.text || ""), cursor: x.draft.cursor, atts });
    }
  }
  sentTop = Object.fromEntries(TOP.map(k => [k, JSON.stringify(u[k] ?? null)]));
  afterFirst = u;
}
/* the overlays come back once the view is on screen: the Open list, the file preview, the image viewer */
export function afterRender() {
  const u = afterFirst; afterFirst = null; if (!u) return;
  if (u.openList && typeof u.openList.filter === "string") restoreOpenList(u.openList.filter);
  if (u.preview && u.preview.path) restorePreview(u.preview);
  if (u.viewer && Array.isArray(u.viewer.srcs) && u.viewer.srcs.length)
    showViewer(u.viewer.srcs.map(s => s.replace("/api/image?", `/api/image?token=${encodeURIComponent(TOKEN)}&`)), +u.viewer.i || 0, Array.isArray(u.viewer.froms) ? u.viewer.froms.map(String) : []);
}
/* card.js: the text a field of the card held, put back once into its input */
export function takeTyping(key) { if (!typing || typing.key !== key) return null; const t = typing.text; typing = null; return t; }

/* ---------- a view leaving and coming on screen (renderConv, mountComposer) ---------- */
export function leave() {
  if (!mounted) return;
  const sid = mounted.slice(0, mounted.indexOf("|")), ta = document.getElementById("msg");
  if (ta) drafts.set(sid, { text: box.value(ta), cursor: [ta.selectionStart, ta.selectionEnd], atts: box.attachments.slice() });
}
export function enterComposer(s, ta) {
  const d = drafts.get(s.id); drafts.delete(s.id); // on screen, the box itself is the draft
  const attachments = box.attachments;
  attachments.length = 0;
  if (d) {
    attachments.push(...d.atts);
    if (d.text) { ta.value = d.text; ta.dispatchEvent(new Event("input")); }
    const c = Array.isArray(d.cursor) ? d.cursor : [ta.value.length, ta.value.length];
    ta.setSelectionRange(Math.min(+c[0] || 0, ta.value.length), Math.min(+c[1] || 0, ta.value.length));
  }
  box.render();
}
/* an object URL a draft not on screen still shows: not freed (composer.js) */
export const held = url => [...drafts.values()].some(d => d.atts.some(a => a.url === url));
/* Asks the server for a view's items. `from`: the oldest item this view had loaded, so the reply is one
   reset with all of it. */
export function requestView(sid, agent) {
  const f = from(sid, agent);
  send({ t: "view", sid, agent: agent || null, ...(f ? { from: f } : {}) });
}
/* the view on screen asked the server for its items: its scroll waits for them, and its log for their reset */
export function expectReset() {
  clearTimeout(restoring?.timer);
  const key = mounted;
  restoring = { key, tries: 0, got: !store.ui.connected, timer: setTimeout(() => { if (restoring?.key === key) { restoring = null; logFns.render(); } }, 5000) };
}
/* the oldest item a view had loaded */
export const from = (sid, agent) => uiS[sid]?.earlier[agent || ""] || null;
/* a view just mounted shows nothing until its reset: no stale items, no short window first; a view
   that stays on screen over a reconnect keeps what it shows until then */
export const holding = () => !!restoring && restoring.key === mounted && !restoring.got;
export function resetIn(m) { if (m.reset && restoring && restoring.key === mounted) restoring.got = true; }

/* ---------- the log: the anchor, the earlier items, open diffs and folds (main.js, transcript.js) ---------- */
const NOT_ANCHOR = /^(earlier|day:|live|stream|held:)/;
export function anchor(log) {
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 40) return { bottom: true };
  const top = log.getBoundingClientRect().top;
  const el = [...log.querySelector(".log-inner").children].find(c => !NOT_ANCHOR.test(c.dataset.key || "") && c.getBoundingClientRect().bottom > top);
  return el ? { id: el.dataset.key, off: Math.round(top - el.getBoundingClientRect().top) } : { bottom: true };
}
function scrollTo(a) {
  const log = document.getElementById("log"); if (!log) return;
  const el = a && !a.bottom && [...log.querySelector(".log-inner").children].find(c => c.dataset.key === a.id);
  if (!el) { log.scrollTop = log.scrollHeight; return; } // no anchor, or it is gone (a rewritten file): the bottom
  log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top + a.off;
}
/* items for the viewed conversation, rendered: finish a restore, or note the earlier items loaded */
export function items(m) {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view), t = A || s, list = t.items || [], u = sess(s.id);
  if (!restoring || restoring.key !== mounted) {
    if (m.prepend && list.length) u.earlier[viewKey()] = list[0].id;
    else if (m.reset) delete u.earlier[viewKey()];
    return;
  }
  if (!m.reset && !m.prepend) return;
  if (m.reset && restoring.reset) delete u.earlier[viewKey()]; // a second reset: the file was rewritten, the range loaded is gone
  if (m.reset) restoring.reset = true;
  const want = u.earlier[viewKey()];
  if (want && list.length && !list.some(i => i.id === want) && (t.total || 0) > list.length && restoring.tries++ < 20) { logFns.earlier(); return; }
  clearTimeout(restoring.timer); restoring = null;
  scrollTo(u.scroll[viewKey()]);
}
/* after each renderLog: the diffs and folds that were open are open */
export function afterLog() {
  const s = cur(); if (!s) return;
  const u = uiS[s.id]; if (!u) return;
  const pre = viewKey() + "|";
  for (const k of u.diffs) {
    if (!k.startsWith(pre)) continue;
    const d = document.getElementById(k.slice(pre.length));
    if (d && d.matches("#log .diff") && d.hidden) { d.hidden = false; document.querySelector(`[aria-controls="${CSS.escape(d.id)}"]`)?.setAttribute("aria-expanded", "true"); }
  }
  if (!u.folds.size) return;
  const blocks = new Map([...document.querySelectorAll("#log .log-inner > [data-key]")].map(el => [el.dataset.key, el]));
  for (const k of u.folds) {
    if (!k.startsWith(pre)) continue;
    const at = k.lastIndexOf("#"), b = blocks.get(k.slice(pre.length, at));
    const d = b && b.querySelectorAll("details:not([data-step])")[+k.slice(at + 1)];
    if (d && !d.open) d.open = true;
  }
}
document.addEventListener("scroll", e => {
  if (e.target.id === "log" && mounted && !restoring && current) { sess(current).scroll[viewKey()] = anchor(e.target); changed(); }
  else if (e.target.id === "pv-code") changed();
}, true);
document.addEventListener("toggle", e => {
  const d = e.target;
  if (!d.matches || !d.matches("#log details:not([data-step])") || !d.isConnected || !current) return;
  const b = d.closest(".log-inner > [data-key]"); if (!b) return;
  const k = `${viewKey()}|${b.dataset.key}#${[...b.querySelectorAll("details:not([data-step])")].indexOf(d)}`;
  if (d.open) sess(current).folds.add(k); else sess(current).folds.delete(k);
  changed();
}, true);
/* after the view's own click handler has shown or hidden the diff */
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("#log .frow .fc"); if (!t || !current) return;
  const d = document.getElementById(t.getAttribute("aria-controls")); if (!d) return;
  const k = `${viewKey()}|${d.id}`;
  if (d.hidden) sess(current).diffs.delete(k); else sess(current).diffs.add(k);
});
for (const ev of ["input", "click", "keyup", "focusin", "focusout", "toggle"]) document.addEventListener(ev, () => changed(), true);
document.addEventListener("selectionchange", () => { if (document.activeElement?.id === "msg") changed(); });

/* ---------- the patch: the state now, against what the backend has ---------- */
export function changed() {
  if (!uiLoaded) return;
  const now = Date.now(); if (!timer) firstChange = now;
  clearTimeout(timer);
  timer = setTimeout(flush, now - firstChange > 2000 ? 0 : 300);
}
function top() {
  const code = document.getElementById("pv-code"), find = document.getElementById("pv-find");
  return {
    current, view: view || null, mode, openBg: openBg || null, theme: themePref(),
    openList: openListShown() ? { filter: openList.filter } : null,
    preview: previewShown() && pv.path ? { path: pv.path, scroll: Math.round(code.scrollTop), find: find && !find.hidden ? document.getElementById("pv-q").value : "" } : null,
    viewer: viewer ? (keep => keep.length ? { srcs: keep.map(k => viewer.srcs[k].replace(/([?&])token=[^&]*&?/, "$1")), froms: keep.map(k => viewer.froms[k] || ""), i: Math.max(0, keep.indexOf(viewer.i)) } : null)(viewer.srcs.map((s, k) => k).filter(k => viewer.srcs[k].startsWith("/api/image?"))) : null,
  };
}
/* one session's fields; `fresh` collects the pasted images to send with their bytes */
function sessionNow(sid, fresh) {
  const u = uiS[sid], live = mounted && mounted.startsWith(sid + "|") && document.getElementById("msg");
  const d = live ? { text: box.value(live), cursor: [live.selectionStart, live.selectionEnd], atts: box.attachments } : drafts.get(sid);
  const images = d ? d.atts.filter(a => a.id && (stored.has(a.id) || a.data)).map(a => ({ id: a.id, mediaType: a.mediaType, n: a.n })) : [];
  if (d) for (const a of d.atts) if (a.id && !stored.has(a.id) && a.data) fresh.push(a);
  const steps = [...openSteps].filter(k => k.startsWith(sid + "|")).map(k => k.slice(sid.length + 1));
  const ids = new Set(requestsOf({ id: sid }).map(r => r.id)), mine = {};
  for (const k of Object.keys(cards)) {
    if (!k.startsWith(sid + ":")) continue;
    const rid = k.slice(sid.length + 1);
    if (!ids.has(rid)) { delete cards[k]; continue; } // the request is gone
    const st = { ...cards[k] }, own = document.getElementById("qa-own");
    if (st.target != null && own && current === sid) st.typing = own.value;
    mine[rid] = st;
  }
  const or = (v, empty) => empty ? null : v;
  return {
    scroll: or(u?.scroll, !u || !Object.keys(u.scroll).length),
    earlier: or(u?.earlier, !u || !Object.keys(u.earlier).length),
    steps: or(steps, !steps.length), diffs: or(u && [...u.diffs], !u?.diffs.size), folds: or(u && [...u.folds], !u?.folds.size),
    draft: d && (d.text || images.length) ? { text: d.text, cursor: d.cursor, images } : null,
    cards: or(mine, !Object.keys(mine).length),
  };
}
export function flush() {
  clearTimeout(timer); timer = null;
  if (!uiLoaded || !store.ui.connected) return;
  const patch = {}, now = top();
  for (const k of TOP) { const j = JSON.stringify(now[k] ?? null); if (sentTop[k] !== j) { patch[k] = now[k] ?? null; sentTop[k] = j; } }
  const sids = new Set([...Object.keys(uiS), ...drafts.keys(), ...Object.keys(sentSess), ...[...openSteps].map(k => k.slice(0, k.indexOf("|"))), ...Object.keys(cards).map(k => k.slice(0, k.indexOf(":"))), ...(current ? [current] : [])]);
  const sessions = {}, fresh = [];
  for (const sid of sids) {
    if (!store.sessions.has(sid)) { delete uiS[sid]; delete sentSess[sid]; drafts.delete(sid); continue; } // closed: the backend pruned it
    const fields = sessionNow(sid, fresh), sent = sentSess[sid] ||= {}, out = {};
    for (const [k, v] of Object.entries(fields)) { const j = JSON.stringify(v); if ((sent[k] ?? "null") !== j) { out[k] = v; sent[k] = j; } }
    if (Object.keys(out).length) sessions[sid] = out;
  }
  /* the bytes go once, with the draft that first lists the image */
  for (const a of fresh) {
    const sid = [...sids].find(x => sessions[x]?.draft?.images.some(im => im.id === a.id)); if (!sid) continue;
    const im = sessions[sid].draft.images.find(x => x.id === a.id), m = /^data:[^;]+;base64,(.*)$/.exec(a.data);
    if (m) { im.data = m[1]; stored.add(a.id); }
  }
  if (Object.keys(sessions).length) patch.sessions = sessions;
  if (Object.keys(patch).length) send({ t: "ui", patch });
}
/* a session's id changed (main.js renamed): what the page holds for it follows */
export function rekey(from, to) {
  if (uiS[from]) { uiS[to] = uiS[from]; delete uiS[from]; }
  if (sentSess[from]) { sentSess[to] = sentSess[from]; delete sentSess[from]; }
  if (drafts.has(from)) { drafts.set(to, drafts.get(from)); drafts.delete(from); }
  for (const k of [...openSteps]) if (k.startsWith(from + "|")) { openSteps.delete(k); openSteps.add(to + k.slice(from.length)); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
window.addEventListener("pagehide", flush);
