/* UI state (requirements R3.9): what is on screen comes back exactly after a reload, a crash or a quit.
   The page is only UI: the backend keeps this in state.json `ui` and returns it in `hello`. The page
   sends `ui {patch}`, only what changed, 300 ms after the last change (2 s at most) and at once when it
   is hidden or unloads. Applied before the first render, so the default view never shows first; the
   scroll waits for the reset items of the view, and the earlier items it had loaded, then goes to its
   anchor: an item block's key and the pixels into it; at the end (within 40 px of it) the last block on screen,
   so what came while you were away is below it (R5.12d), under a line, "New since 2:14 PM", above the first
   item you hadn't seen (`seen`, `newAt`: watchSeen, placeNew, drawNew).
   Per session: the scroll and the loaded-earlier range per view, open steps, open diffs and folds, the
   draft (text, cursor, pasted images, stored by the backend as files), the half-answered card per
   request. Nothing is shared live between pages: the last one to
   write wins. */
import { store, current, view, cur, requestsOf, select, mounted, agentById, bgById } from "./state.js";
import { send, TOKEN } from "./connection.js";
import { pv, previewShown, restorePreview } from "./preview.js";
import { viewer, showViewer, imageUrl } from "./images.js";
import { mode, setMode } from "./mode.js";
import { themePref, themeSet } from "./theme-switch.js";
import { openList, openListShown, restoreOpenList } from "./open-list.js";
import { fl, folderListShown, restoreFolderList } from "./folder-list.js";
import { esc, hhmm } from "./format.js";
import { outEnds, lineAt } from "./bg-view.js";

const uiS = {}; // sid -> { scroll: {view: anchor}, earlier: {view: oldest item id}, diffs: Set, folds: Set }
const drafts = new Map(); // sid -> { text, cursor, atts } for the sessions not on screen
const stored = new Set(); // pasted image ids the backend has as files
let sentTop = {}, sentSess = {}; // what the backend has, as JSON per field
let uiLoaded = false, timer = null, firstChange = 0, restoring = null, typing = null, afterFirst = null, lastShown = null;
const TOP = ["current", "view", "mode", "openList", "folderList", "preview", "viewer", "theme"];
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
  if (u.folderList && typeof u.folderList.filter === "string") restoreFolderList(u.folderList);
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
  touchSeen();
  note(document.getElementById("log")); // where the view going away was, and the end you saw
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
  if (agent && bgById(store.sessions.get(sid), agent)) { send({ t: "view", sid, agent: null, bg: agent, ...(f ? { from: f } : {}) }); return; } // a shell's or monitor's output (R7.2)
  send({ t: "view", sid, agent: agent || null, ...(f ? { from: f } : {}) });
}
/* the view on screen asked the server for its items: its scroll waits for them, and its log for their reset */
export function expectReset() {
  clearTimeout(restoring?.timer);
  /* `back`: you come back to this view from another one (not the first view after a load, not a reconnect),
     so the line above what you haven't seen is placed again (placeNew) */
  const key = mounted, back = lastShown !== null && lastShown !== key; lastShown = key;
  if (jump && jump.key !== key) jump = null; // another view came instead
  restoring = { key, back, tries: 0, got: !store.ui.connected, timer: giveUp(key) };
}
/* a restore that waits too long shows what it has, and a jump it carried goes */
const giveUp = key => setTimeout(() => { if (restoring?.key === key) { restoring = null; jump = null; logFns.render(); } }, 5000);
/* the oldest item a view had loaded */
export const from = (sid, agent) => uiS[sid]?.earlier[agent || ""] || null;
/* a view just mounted shows nothing until its reset: no stale items, no short window first; a view
   that stays on screen over a reconnect keeps what it shows until then */
export const holding = () => !!restoring && restoring.key === mounted && !restoring.got;
export function resetIn(m) { if (m.reset && restoring && restoring.key === mounted) restoring.got = true; }

/* ---------- the log: the anchor, the earlier items, open diffs and folds (main.js, transcript.js) ---------- */
const NOT_ANCHOR = /^(earlier|day:|live|stream|held:|queue)/;
const blocks = log => [...log.querySelector(".log-inner").children].filter(c => !NOT_ANCHOR.test(c.dataset.key || ""));
export const atEnd = log => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
/* Where the log is: the first block on screen and the pixels into it; at the end (within 40 px of it) the
   last block on screen instead, with `bottom`, so coming back lands where the end was then, with what came
   since below it, not on the new end. */
export function anchor(log) {
  const r = log.getBoundingClientRect(), all = blocks(log);
  const el = atEnd(log) ? all.filter(c => c.getBoundingClientRect().top < r.bottom).pop() : all.find(c => c.getBoundingClientRect().bottom > r.top);
  const a = el ? { id: el.dataset.key, off: Math.round(r.top - el.getBoundingClientRect().top) } : {};
  return atEnd(log) ? { bottom: true, ...a } : el ? a : { bottom: true };
}
/* The one record of what you last saw, per session and view: `scroll[view]`, the anchor plus `seen`, the furthest
   item you saw (watchSeen), `seenAt` when you last had it on screen, and `newAt`, the item the line sits above. The anchor is
   taken on each scroll, after each render of the log and when the view leaves the screen; a view you are not
   looking at doesn't follow its end (transcript.js renderLog), so what came since stays below. */
export function note(log, key = mounted) {
  if (!log || !key || (restoring && restoring.key === key)) return;
  const sid = key.slice(0, key.indexOf("|")), v = key.slice(key.indexOf("|") + 1), u = sess(sid);
  const was = u.scroll[v], { bottom, id, off, ...kept } = was || {};
  const next = { ...anchor(log), ...kept };
  if (JSON.stringify(next) !== JSON.stringify(was)) { u.scroll[v] = next; changed(); }
  if (key === mounted) watchSeen();
}

/* ---------- what you saw, and the line above what you hadn't (R5.12d) ---------- */
/* Seen: an item is seen once its first line has been on screen for 1 s in a row while the window is focused and
   its view shown; everything above the furthest seen item is seen too. A value is a block's key, or for a shell's
   or monitor's run (one block that grows) "run@<offset>", its output up to the end of a line (bytes, or events). */
const SEEN_MS = 1000;
const recOf = (key = mounted) => key ? uiS[key.slice(0, key.indexOf("|"))]?.scroll[key.slice(key.indexOf("|") + 1)] : undefined;
const split = v => { const m = /^(.*)@(\d+)$/.exec(v); return m ? { key: m[1], at: +m[2] } : { key: v, at: null }; };
/* where a value sits in the log: [block, offset]; null when its block isn't on the page */
const rank = (all, v) => { const p = split(v), i = all.findIndex(c => c.dataset.key === p.key); return i < 0 ? null : [i, p.at ?? -1]; };
const later = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const runOf = () => { const s = cur(), b = s && view && bgById(s, view); return b ? { sid: s.id, bg: b.toolUseId } : null; };
const outSpan = el => el.querySelector(".step-out .out:not(.err)");
/* the line feeds in a run's output before a caret, the line's label left out */
function linesBefore(out, node, at) {
  const w = document.createTreeWalker(out, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest(".nl-at") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let n = 0;
  for (let t = w.nextNode(); t; t = w.nextNode()) { const x = t === node ? t.data.slice(0, at) : t.data; n += x.split("\n").length - 1; if (t === node) return n; }
  return null;
}
/* a run's output lines whose first row is on screen, as values; null when the block has no output */
function outLines(el, r, run) {
  const out = outSpan(el); if (!out) return null;
  const o = out.getBoundingClientRect(), top = Math.max(o.top, r.top) + 1, bot = Math.min(o.bottom, r.bottom) - 1;
  if (bot <= top) return [];
  const line = y => { const c = document.caretRangeFromPoint(o.left + 1, y); return c && out.contains(c.startContainer) ? linesBefore(out, c.startContainer, c.startOffset) : null; };
  const a = line(top), z = line(bot); if (a === null || z === null) return [];
  const ends = outEnds(run.sid, run.bg), vals = [];
  for (let n = a; n <= z; n++) vals.push(`${el.dataset.key}@${ends[n] ?? +el.dataset.end}`);
  return vals;
}
/* what is on screen now: the blocks whose first line shows, a run's output lines */
function onScreen(log) {
  const r = log.getBoundingClientRect(), run = runOf(), vals = [];
  for (const el of blocks(log)) {
    const t = el.getBoundingClientRect().top; if (t >= r.bottom - 8) break;
    const lines = run && el.dataset.end !== undefined ? outLines(el, r, run) : null;
    if (lines) vals.push(...lines); else if (t >= r.top - 1) vals.push(el.dataset.key);
  }
  return vals;
}
const since = new Map(); let sinceKey = null, seenTimer = null; // a value on screen -> since when (ms)
/* Runs on each scroll and render, and when the window's focus or visibility changes; a timer runs it again when
   the next value on screen reaches its 1 s. */
export function watchSeen() {
  clearTimeout(seenTimer); seenTimer = null;
  const log = document.getElementById("log"), key = mounted;
  if (!log || !key || (restoring && restoring.key === key) || document.visibilityState !== "visible" || !document.hasFocus()) { since.clear(); return; }
  if (sinceKey !== key) { since.clear(); sinceKey = key; }
  const now = performance.now(), on = new Set(onScreen(log)), all = blocks(log);
  for (const v of [...since.keys()]) if (!on.has(v)) since.delete(v);
  let best = null, wait = Infinity;
  for (const v of on) {
    if (!since.has(v)) since.set(v, now);
    const left = since.get(v) + SEEN_MS - now;
    if (left > 0) { wait = Math.min(wait, left); continue; }
    const r = rank(all, v); if (r && (!best || later(r, best[1]))) best = [v, r];
  }
  if (best) {
    const u = sess(key.slice(0, key.indexOf("|"))), k = key.slice(key.indexOf("|") + 1), was = u.scroll[k];
    const old = was?.seen && rank(all, was.seen);
    if (!old || later(best[1], old)) { u.scroll[k] = { ...(was || anchor(log)), seen: best[0], seenAt: Date.now() }; changed(); }
  }
  if (wait < Infinity) seenTimer = setTimeout(watchSeen, wait + 30);
}
/* you leave a view, or hide the window, with the furthest item you saw still on screen: `seenAt` is now, the time a
   run's "New since" shows */
function touchSeen() {
  const rec = recOf(), t = rec?.seen && sinceKey === mounted ? since.get(rec.seen) : undefined;
  if (t !== undefined && performance.now() - t >= SEEN_MS) { rec.seenAt = Date.now(); changed(); }
}
/* the local time of an item block, from its item; null when the block names none */
function timeOf(k) {
  const s = cur(), A = s && view && agentById(s, view), list = (A || s)?.items || [];
  const id = k.replace(/#\d+$/, ""), bare = id.replace(/^(you|ans|run|wave|files|bang|wait|na):/, "");
  const it = list.find(x => x.id === id) || list.find(x => x.id === bare), t = it ? Date.parse(it.ts) : NaN;
  return t > 0 ? t : null;
}
/* the first thing after `seen`: the next block, or the rest of a run's output (its time: when you saw the part before) */
function firstUnseen(log, rec) {
  if (!rec?.seen) return null;
  const all = blocks(log), p = split(rec.seen), i = all.findIndex(c => c.dataset.key === p.key); if (i < 0) return null;
  const at = rec.seenAt || Date.now();
  if (p.at !== null && +(all[i].dataset.end || 0) > p.at) return { id: rec.seen, at };
  const el = all[i + 1];
  return el ? { id: el.dataset.key, at: timeOf(el.dataset.key) ?? at } : null;
}
/* You came back to the view (from another view, or the window shown again): the line goes above the first item you
   hadn't seen, or, back from another view with nothing new, goes. `keep`: the window shown again, where a line
   already there stays when nothing came. A reload is not a coming back: the stored line stays where it was. */
function placeNew(keep) {
  const log = document.getElementById("log"), rec = recOf(); if (!log || !rec) return;
  const n = firstUnseen(log, rec);
  if (n && JSON.stringify(n) !== JSON.stringify(rec.newAt)) { rec.newAt = n; changed(); }
  else if (!n && !keep && rec.newAt) { delete rec.newAt; changed(); }
  drawNew(log);
}
/* Draws the line: a 1px line in the gap above that block (a class and its label), or, in a run's output, a
   zero-height block between two lines. It takes no space, so nothing moves when it comes or goes. */
export function drawNew(log = document.getElementById("log")) {
  if (!log) return;
  const n = !(restoring && restoring.key === mounted) && recOf()?.newAt, label = n ? `New <i>since ${esc(hhmm(n.at))}</i>` : "";
  const p = n ? split(n.id) : null, run = p && p.at !== null && runOf();
  const el = p && blocks(log).find(c => c.dataset.key === p.key), has = log.querySelectorAll(".new-at, .nl-at");
  const mine = !el ? null : run ? el.querySelector(".nl-at") : el.classList.contains("new-at") ? el : null;
  if (mine && has.length === 1 && mine.dataset.at === n.id && mine.querySelector(".nlab")?.innerHTML === label) return;
  for (const x of has) {
    if (x.classList.contains("nl-at")) { const up = x.parentNode; x.remove(); up.normalize(); continue; }
    x.classList.remove("new-at"); delete x.dataset.at; x.querySelector(":scope > .nlab")?.remove();
  }
  if (!el) return;
  const lab = `<span class="nlab">${label}</span>`;
  if (!run) { el.classList.add("new-at"); el.dataset.at = n.id; el.insertAdjacentHTML("beforeend", lab); return; }
  const out = outSpan(el), line = lineAt(run.sid, run.bg, p.at); if (!out || line < 0) return;
  /* the text node and the offset where that line begins */
  const w = document.createTreeWalker(out, NodeFilter.SHOW_TEXT); let left = line;
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    let i = 0;
    while (left > 0) { const j = t.data.indexOf("\n", i); if (j < 0) break; i = j + 1; left--; }
    if (left > 0) continue;
    if (i >= t.data.length) return; // the line isn't on the page yet
    const m = document.createElement("span"); m.className = "nl-at"; m.dataset.at = n.id; m.innerHTML = lab;
    t.parentNode.insertBefore(m, t.splitText(i)); return;
  }
}
function scrollTo(a) {
  const log = document.getElementById("log"); if (!log) return;
  const el = a && a.id && blocks(log).find(c => c.dataset.key === a.id);
  if (!el) { log.scrollTop = log.scrollHeight; return; } // no anchor, or it is gone (a rewritten file): the bottom
  log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top + a.off;
  if (a.bottom && atEnd(log)) log.scrollTop = log.scrollHeight; // nothing came since: pinned to the end again
  log.dispatchEvent(new Event("scroll")); // noted even when the position didn't change
}
/* a jump's target is a block's key, or {has(), land()} for something inside one (find.js: a match) */
const hasBlock = (key) => { if (typeof key !== "string") return key.has(); const log = document.getElementById("log"); return !!log && blocks(log).some(c => c.dataset.key === key); };
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
  const want = u.earlier[viewKey()], a = u.scroll[viewKey()];
  const more = list.length && (t.total || 0) > list.length;
  if (more && want && !list.some(i => i.id === want) && restoring.tries++ < 20) { logFns.earlier(); return; }
  const j = jump && jump.key === mounted ? jump : null;
  /* a jump's block came before the items loaded: the pages before them, until it is there or there are no more */
  if (j && more && !hasBlock(j.block) && restoring.tries++ < JUMP_PAGES) { clearTimeout(restoring.timer); restoring.timer = giveUp(mounted); logFns.earlier(); return; }
  /* the block you last saw came before the last 160 items (a long turn while you were away): a few pages more */
  if (!j && more && a?.id && !hasBlock(a.id) && restoring.tries++ < 5) { logFns.earlier(); return; }
  restored();
}
/* the restore is done: the stored place (or the jump's block), then the line above what you hadn't seen, placed
   again when you came back */
function restored() {
  const back = restoring.back, u = sess(cur().id); clearTimeout(restoring.timer); restoring = null;
  const j = jump && jump.key === mounted ? jump : null, found = !!j && hasBlock(j.block);
  if (found) toBlock(j.block); else scrollTo(u.scroll[viewKey()]);
  if (back) placeNew(false); else drawNew();
  if (j) endJump(found);
}

/* ---------- a jump to a block: the "To review" card goes to its subagent's report (R7.1) ---------- */
/* { key: the view, block: its block's key (or {has, land}, hasBlock), done(found) } until the block is on screen or the view has no such
   block. It loads earlier pages as the restore does (items above) and lands as a scroll of yours. */
let jump = null;
const JUMP_PAGES = 50, JUMP_GAP = 12; // pages at most; the block's top this far under the log's top
export function jumpTo(key, block, done) {
  jump = { key, block, done };
  if (mounted !== key || (restoring && restoring.key === key)) return; // its items are on their way: the restore lands it
  if (hasBlock(block)) { toBlock(block); endJump(true); return; }
  if (!logFns.earlier()) { endJump(false); return; } // the whole transcript is on the page: no such block
  restoring = { key, back: false, tries: 1, got: true, reset: true, timer: giveUp(key) }; // its replies go through items()
}
function toBlock(key) {
  const log = document.getElementById("log");
  if (typeof key !== "string") key.land(); // it scrolls itself
  else log.scrollTop += blocks(log).find(c => c.dataset.key === key).getBoundingClientRect().top - log.getBoundingClientRect().top - JUMP_GAP;
  log.dispatchEvent(new Event("scroll")); // noted as a scroll of yours: the anchor, what you saw
  const s = cur(), A = view && agentById(s, view), list = (A || s).items || [];
  if (list.length && (A || s).total > list.length) { sess(s.id).earlier[viewKey()] = list[0].id; changed(); } // a reload asks for the pages it loaded
}
function endJump(found) { const j = jump; jump = null; j.done(found); }
/* a shell's or monitor's output for the view on screen: finish a restore, or note the earlier output loaded
   (where it begins, so a reload asks from there) */
export function output(m) {
  const s = cur(); if (!s || !mounted) return;
  const u = sess(s.id);
  if (!restoring || restoring.key !== mounted) {
    if (m.prepend) u.earlier[viewKey()] = String(m.from);
    else if (m.reset) delete u.earlier[viewKey()];
    return;
  }
  if (!m.reset) return;
  restored();
}
/* after each renderLog: the diffs and folds that were open are open */
export function afterLog() {
  drawNew(); // the line above what you hadn't seen, on a block a render replaced too
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
  if (e.target.id === "log") note(e.target);
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
    current, view: view || null, mode, theme: themePref(),
    openList: openListShown() ? { filter: openList.filter } : null,
    folderList: folderListShown() && !fl.fixed ? { filter: fl.filter, sid: fl.sid } : null,
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
/* the window shown again is a coming back: the line goes above what came while it was hidden */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { touchSeen(); flush(); }
  else if (mounted && !(restoring && restoring.key === mounted)) placeNew(true);
  watchSeen();
});
for (const ev of ["focus", "blur"]) window.addEventListener(ev, () => watchSeen());
window.addEventListener("pagehide", flush);
