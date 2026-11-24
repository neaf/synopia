/* UI state (requirements R3.9): what is on screen comes back exactly after a reload, a crash or a quit.
   The page is only UI: the backend keeps this in state.json `ui` and returns it in `hello`. The page
   sends `ui {patch}`, only what changed, 300 ms after the last change (2 s at most) and at once when it
   is hidden or unloads. Applied before the first render, so the default view never shows first; the
   scroll waits for the reset items of the view, and the earlier items it had loaded, then goes to its
   anchor: an item block's key and the pixels into it, or the bottom (within 40 px of it, pinned there).
   Per session: the scroll and the loaded-earlier range per view, open steps, open diffs and folds, the
   draft (text, cursor, pasted images, stored by the backend as files), the half-answered card per
   request, and the rail's expansion state (uiRail, uiSetRail). Nothing is shared live between pages:
   the last one to write wins. */
const uiS = {}; // sid -> { scroll: {view: anchor}, earlier: {view: oldest item id}, diffs: Set, folds: Set, rail }
const uiDrafts = new Map(); // sid -> { text, cursor, atts } for the sessions not on screen
const uiStored = new Set(); // pasted image ids the backend has as files
let uiSentTop = {}, uiSentSess = {}; // what the backend has, as JSON per field
let uiLoaded = false, uiTimer = null, uiFirstChange = 0, uiRestoring = null, uiTyping = null, uiAfterFirst = null;
const UI_TOP = ["current", "view", "mode", "openBg", "openList", "preview", "viewer"];
const uiSess = sid => (uiS[sid] ||= { scroll: {}, earlier: {}, diffs: new Set(), folds: new Set(), rail: undefined });
const uiNewId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const uiView = () => view || "";

/* the background panel's own expansion state for a session (rail.js reads and writes it here) */
const uiRail = sid => uiS[sid]?.rail;
function uiSetRail(sid, v) { uiSess(sid).rail = v; uiChanged(); }

/* ---------- applying the stored state: once per page load, from the first hello ---------- */
function uiApplyHello(u) {
  const first = !uiLoaded; uiLoaded = true;
  if (!first) { uiSentTop = {}; uiSentSess = {}; uiChanged(); return; } // a reconnect: this page's state is the newer, send all of it
  if (!u || typeof u !== "object") return;
  const has = sid => typeof sid === "string" && store.sessions.has(sid);
  if (!location.hash && has(u.current)) {
    current = u.current;
    const s = store.sessions.get(current);
    if (u.view && agentById(s, u.view)) view = u.view;
  }
  if (u.mode === "insert" || u.mode === "normal") mode = u.mode;
  if (typeof u.openBg === "string") openBg = u.openBg;
  for (const [sid, x] of Object.entries(u.sessions || {})) {
    if (!has(sid) || !x) continue;
    const s = uiSess(sid);
    uiSentSess[sid] = Object.fromEntries(Object.keys(x).map(k => [k, "?"])); // the backend has these: the next patch sets or clears them
    s.scroll = { ...(x.scroll || {}) }; s.earlier = { ...(x.earlier || {}) };
    s.diffs = new Set(x.diffs || []); s.folds = new Set(x.folds || []); s.rail = x.rail;
    for (const k of x.steps || []) openSteps.add(`${sid}|${k}`);
    const ids = new Set(requestsOf({ id: sid }).map(r => r.id));
    for (const [rid, st] of Object.entries(x.cards || {})) {
      if (!ids.has(rid) || !st || typeof st !== "object") continue; // the request is gone: so is its card
      const { typing, ...rest } = st;
      qstate[`${sid}:${rid}`] = { qi: 0, oi: 0, picks: {}, own: {}, notes: {}, target: null, noteRow: null, ...rest };
      if (typeof typing === "string" && rest.target != null) uiTyping = { key: `${sid}:${rid}`, text: typing };
    }
    if (x.draft) {
      const atts = (x.draft.images || []).map(im => {
        uiStored.add(im.id);
        const a = { id: im.id, mediaType: im.mediaType, url: imageUrl(sid, null, `draft:${im.id}`), data: null };
        fetch(a.url).then(r => r.ok ? r.blob() : null).then(b => { if (!b) return; const fr = new FileReader(); fr.onload = () => { a.data = fr.result; }; fr.readAsDataURL(b); }).catch(() => {});
        return a;
      });
      uiDrafts.set(sid, { text: String(x.draft.text || ""), cursor: x.draft.cursor, atts });
    }
  }
  uiSentTop = Object.fromEntries(UI_TOP.map(k => [k, JSON.stringify(u[k] ?? null)]));
  uiAfterFirst = u;
}
/* the overlays come back once the view is on screen: the Open list, the file preview, the image viewer */
function uiAfterRender() {
  const u = uiAfterFirst; uiAfterFirst = null; if (!u) return;
  if (u.openList && typeof u.openList.filter === "string") {
    showOpenList();
    const inp = document.getElementById("ol-filter");
    if (u.openList.filter) { inp.value = openList.filter = u.openList.filter; askRecent(); }
  }
  if (u.preview && u.preview.path) {
    pv.want = { path: u.preview.path, back: null, added: new Set(), cut: new Set(), first: 0, restore: { scroll: +u.preview.scroll || 0, find: String(u.preview.find || "") } };
    send({ t: "preview", path: u.preview.path });
  }
  if (u.viewer && Array.isArray(u.viewer.srcs) && u.viewer.srcs.length)
    showViewer(u.viewer.srcs.map(s => s.replace("/api/image?", `/api/image?token=${encodeURIComponent(TOKEN)}&`)), +u.viewer.i || 0);
}
/* preview.js, once the asked file is shown: its find query, then its scroll */
function uiPreviewRestored(r) {
  if (r.find) { pvOpenFind(); const q = document.getElementById("pv-q"); q.value = r.find; pvFind(r.find); }
  document.getElementById("pv-code").scrollTop = r.scroll;
}
/* card.js: the text a field of the card held, put back once into its input */
function uiTakeTyping(key) { if (!uiTyping || uiTyping.key !== key) return null; const t = uiTyping.text; uiTyping = null; return t; }

/* ---------- a view leaving and coming on screen (renderConv, mountComposer) ---------- */
function uiLeave() {
  if (!mounted) return;
  const sid = mounted.slice(0, mounted.indexOf("|")), ta = document.getElementById("msg");
  if (ta) uiDrafts.set(sid, { text: ta.value, cursor: [ta.selectionStart, ta.selectionEnd], atts: attachments.slice() });
}
function uiEnterComposer(s, ta) {
  const d = uiDrafts.get(s.id); uiDrafts.delete(s.id); // on screen, the box itself is the draft
  attachments.length = 0;
  if (d) {
    attachments.push(...d.atts);
    if (d.text) { ta.value = d.text; ta.dispatchEvent(new Event("input")); }
    const c = Array.isArray(d.cursor) ? d.cursor : [ta.value.length, ta.value.length];
    ta.setSelectionRange(Math.min(+c[0] || 0, ta.value.length), Math.min(+c[1] || 0, ta.value.length));
  }
  renderAttachments();
}
/* an object URL a draft not on screen still shows: not freed (composer.js) */
const uiHeld = url => [...uiDrafts.values()].some(d => d.atts.some(a => a.url === url));
/* the view asked the server for its items: its scroll waits for them, and its log for their reset */
function uiExpectReset() {
  clearTimeout(uiRestoring?.timer);
  const key = mounted;
  uiRestoring = { key, tries: 0, got: !store.ui.connected, timer: setTimeout(() => { if (uiRestoring?.key === key) { uiRestoring = null; renderLog(); } }, 5000) };
}
/* the oldest item a view had loaded, sent with `view` so its reset starts there (bridge.js) */
const uiFrom = (sid, agent) => uiS[sid]?.earlier[agent || ""] || null;
/* a view just mounted shows nothing until its reset: no stale items, no short window first */
const uiHolding = () => !!uiRestoring && uiRestoring.key === mounted && !uiRestoring.got;
function uiResetIn(m) { if (m.reset && uiRestoring && uiRestoring.key === mounted) uiRestoring.got = true; }

/* ---------- the log: the anchor, the earlier items, open diffs and folds (bridge.js, transcript.js) ---------- */
const UI_NOT_ANCHOR = /^(earlier|day:|live|stream|held:)/;
function uiAnchor(log) {
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 40) return { bottom: true };
  const top = log.getBoundingClientRect().top;
  const el = [...log.querySelector(".log-inner").children].find(c => !UI_NOT_ANCHOR.test(c.dataset.key || "") && c.getBoundingClientRect().bottom > top);
  return el ? { id: el.dataset.key, off: Math.round(top - el.getBoundingClientRect().top) } : { bottom: true };
}
function uiScrollTo(a) {
  const log = document.getElementById("log"); if (!log) return;
  const el = a && !a.bottom && [...log.querySelector(".log-inner").children].find(c => c.dataset.key === a.id);
  if (!el) { log.scrollTop = log.scrollHeight; return; } // no anchor, or it is gone (a rewritten file): the bottom
  log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top + a.off;
}
/* items for the viewed conversation, rendered: finish a restore, or note the earlier items loaded */
function uiItems(m) {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view), t = A || s, items = t.items || [], u = uiSess(s.id);
  if (!uiRestoring || uiRestoring.key !== mounted) {
    if (m.prepend && items.length) u.earlier[uiView()] = items[0].id;
    else if (m.reset) delete u.earlier[uiView()];
    return;
  }
  if (!m.reset && !m.prepend) return;
  if (m.reset && uiRestoring.reset) delete u.earlier[uiView()]; // a second reset: the file was rewritten, the range loaded is gone
  if (m.reset) uiRestoring.reset = true;
  const want = u.earlier[uiView()];
  if (want && items.length && !items.some(i => i.id === want) && (t.total || 0) > items.length && uiRestoring.tries++ < 20) { loadEarlier(); return; }
  clearTimeout(uiRestoring.timer); uiRestoring = null;
  uiScrollTo(u.scroll[uiView()]);
}
/* after each renderLog: the diffs and folds that were open are open */
function uiAfterLog() {
  const s = cur(); if (!s) return;
  const u = uiS[s.id]; if (!u) return;
  const pre = uiView() + "|";
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
  if (e.target.id === "log" && mounted && !uiRestoring && current) { uiSess(current).scroll[uiView()] = uiAnchor(e.target); uiChanged(); }
  else if (e.target.id === "pv-code") uiChanged();
}, true);
document.addEventListener("toggle", e => {
  const d = e.target;
  if (!d.matches || !d.matches("#log details:not([data-step])") || !d.isConnected || !current) return;
  const b = d.closest(".log-inner > [data-key]"); if (!b) return;
  const k = `${uiView()}|${b.dataset.key}#${[...b.querySelectorAll("details:not([data-step])")].indexOf(d)}`;
  if (d.open) uiSess(current).folds.add(k); else uiSess(current).folds.delete(k);
  uiChanged();
}, true);
/* after the view's own click handler has shown or hidden the diff */
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("#log .frow .fc"); if (!t || !current) return;
  const d = document.getElementById(t.getAttribute("aria-controls")); if (!d) return;
  const k = `${uiView()}|${d.id}`;
  if (d.hidden) uiSess(current).diffs.delete(k); else uiSess(current).diffs.add(k);
});
for (const ev of ["input", "click", "keyup", "focusin", "focusout", "toggle"]) document.addEventListener(ev, () => uiChanged(), true);
document.addEventListener("selectionchange", () => { if (document.activeElement?.id === "msg") uiChanged(); });

/* ---------- the patch: the state now, against what the backend has ---------- */
function uiChanged() {
  if (!uiLoaded) return;
  const now = Date.now(); if (!uiTimer) uiFirstChange = now;
  clearTimeout(uiTimer);
  uiTimer = setTimeout(uiFlush, now - uiFirstChange > 2000 ? 0 : 300);
}
function uiTop() {
  const code = document.getElementById("pv-code"), find = document.getElementById("pv-find");
  return {
    current, view: view || null, mode, openBg: openBg || null,
    openList: openListShown() ? { filter: openList.filter } : null,
    preview: previewShown() && pv.path ? { path: pv.path, scroll: Math.round(code.scrollTop), find: find && !find.hidden ? document.getElementById("pv-q").value : "" } : null,
    viewer: viewer ? (srcs => srcs.length ? { srcs, i: Math.max(0, srcs.indexOf(viewer.srcs[viewer.i])) } : null)(viewer.srcs.filter(s => s.startsWith("/api/image?")).map(s => s.replace(/([?&])token=[^&]*&?/, "$1"))) : null,
  };
}
/* one session's fields; `fresh` collects the pasted images to send with their bytes */
function uiSessionNow(sid, fresh) {
  const u = uiS[sid], live = mounted && mounted.startsWith(sid + "|") && document.getElementById("msg");
  const d = live ? { text: live.value, cursor: [live.selectionStart, live.selectionEnd], atts: attachments } : uiDrafts.get(sid);
  const images = d ? d.atts.filter(a => a.id && (uiStored.has(a.id) || a.data)).map(a => ({ id: a.id, mediaType: a.mediaType })) : [];
  if (d) for (const a of d.atts) if (a.id && !uiStored.has(a.id) && a.data) fresh.push(a);
  const steps = [...openSteps].filter(k => k.startsWith(sid + "|")).map(k => k.slice(sid.length + 1));
  const ids = new Set(requestsOf({ id: sid }).map(r => r.id)), cards = {};
  for (const k of Object.keys(qstate)) {
    if (!k.startsWith(sid + ":")) continue;
    const rid = k.slice(sid.length + 1);
    if (!ids.has(rid)) { delete qstate[k]; continue; } // the request is gone
    const st = { ...qstate[k] }, own = document.getElementById("qa-own");
    if (st.target != null && own && current === sid) st.typing = own.value;
    cards[rid] = st;
  }
  const or = (v, empty) => empty ? null : v;
  return {
    scroll: or(u?.scroll, !u || !Object.keys(u.scroll).length),
    earlier: or(u?.earlier, !u || !Object.keys(u.earlier).length),
    steps: or(steps, !steps.length), diffs: or(u && [...u.diffs], !u?.diffs.size), folds: or(u && [...u.folds], !u?.folds.size),
    draft: d && (d.text || images.length) ? { text: d.text, cursor: d.cursor, images } : null,
    cards: or(cards, !Object.keys(cards).length), rail: u?.rail ?? null,
  };
}
function uiFlush() {
  clearTimeout(uiTimer); uiTimer = null;
  if (!uiLoaded || !store.ui.connected) return;
  const patch = {}, top = uiTop();
  for (const k of UI_TOP) { const j = JSON.stringify(top[k] ?? null); if (uiSentTop[k] !== j) { patch[k] = top[k] ?? null; uiSentTop[k] = j; } }
  const sids = new Set([...Object.keys(uiS), ...uiDrafts.keys(), ...Object.keys(uiSentSess), ...[...openSteps].map(k => k.slice(0, k.indexOf("|"))), ...Object.keys(qstate).map(k => k.slice(0, k.indexOf(":"))), ...(current ? [current] : [])]);
  const sessions = {}, fresh = [];
  for (const sid of sids) {
    if (!store.sessions.has(sid)) { delete uiS[sid]; delete uiSentSess[sid]; uiDrafts.delete(sid); continue; } // closed: the backend pruned it
    const now = uiSessionNow(sid, fresh), sent = uiSentSess[sid] ||= {}, out = {};
    for (const [k, v] of Object.entries(now)) { const j = JSON.stringify(v); if ((sent[k] ?? "null") !== j) { out[k] = v; sent[k] = j; } }
    if (Object.keys(out).length) sessions[sid] = out;
  }
  /* the bytes go once, with the draft that first lists the image */
  for (const a of fresh) {
    const sid = [...sids].find(x => sessions[x]?.draft?.images.some(im => im.id === a.id)); if (!sid) continue;
    const im = sessions[sid].draft.images.find(x => x.id === a.id), m = /^data:[^;]+;base64,(.*)$/.exec(a.data);
    if (m) { im.data = m[1]; uiStored.add(a.id); }
  }
  if (Object.keys(sessions).length) patch.sessions = sessions;
  if (Object.keys(patch).length) send({ t: "ui", patch });
}
/* a session's id changed (bridge.js renamed): what the page holds for it follows */
function uiRekey(from, to) {
  if (uiS[from]) { uiS[to] = uiS[from]; delete uiS[from]; }
  if (uiSentSess[from]) { uiSentSess[to] = uiSentSess[from]; delete uiSentSess[from]; }
  if (uiDrafts.has(from)) { uiDrafts.set(to, uiDrafts.get(from)); uiDrafts.delete(from); }
  for (const k of [...openSteps]) if (k.startsWith(from + "|")) { openSteps.delete(k); openSteps.add(to + k.slice(from.length)); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") uiFlush(); });
window.addEventListener("pagehide", uiFlush);
