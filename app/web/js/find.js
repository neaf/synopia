/* Find in the transcript (requirements R5.12e, R9.9): ⌘F opens a find bar over the view shown, in normal and
   insert mode, drawn as the file preview's find box (preview.js) and marking matches as it does. The backend
   searches the whole view (find.ts: `find {sid, view, q}` answered by `found`), so a match in items the page
   hasn't loaded counts too. Enter or ⌘G goes to the next match, Shift the previous; Esc closes the bar and
   the view stays where the match put it. Going to a match loads earlier pages (ui-state.js jumpTo; a shell's
   earlier output, bg-view.js), opens the step or group that holds it, and scrolls it near the top when it
   is off screen, as a scroll of yours. The backend says how many matches each item has; the page finds them
   in that item's rendered text (preview.js findIn), the k-th match of an item being its k-th on the page. */
import { current, view, mounted } from "./state.js";
import { send } from "./connection.js";
import { findIn } from "./preview.js";
import { jumpTo } from "./ui-state.js";
import { shownBg, loadEarlierOutput } from "./bg-view.js";
import { mode, setMode } from "./mode.js";

const DEBOUNCE = 150, GAP = 48; // ms after the last key; a match scrolled to sits this far under the log's top
const HL = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
/* key: the view it searches ("<sid>|<view>"); hits: every match in order, {id, k} (the k-th of item id);
   ranges: each hit's Range on the page, null while its item isn't loaded; at: the current one */
const f = { el: null, key: null, q: "", seq: 0, asked: 0, timer: null, hits: [], total: 0, more: false, ranges: [], at: -1, insert: false, pending: -1, paintAt: 0 };
export const findState = () => ({ shown: shown(), q: f.q, at: f.at, total: f.total, count: f.el ? f.el.querySelector(".pv-count").textContent : "", hits: f.hits.length, waiting: !!f.timer || f.asked !== 0 });
const shown = () => !!(f.el && f.el.isConnected);

/* ---------- the bar ---------- */
export function openFind() {
  if (!mounted || !document.getElementById("log")) return;
  if (!shown() || f.key !== mounted) {
    reset();
    const head = document.querySelector("#conv .thread > .c-head"); if (!head) return;
    f.insert = mode === "insert"; f.key = mounted;
    head.insertAdjacentHTML("afterend", `<div class="composer pv-find tf-find" id="tf-find" role="search"><span class="g">⌘F</span><input id="tf-q" autocomplete="off" spellcheck="false" placeholder="${shownBg() ? "Find in this output" : "Find in this transcript"}" aria-label="Find in the transcript"><span class="pv-count" id="tf-count"></span></div>`);
    f.el = document.getElementById("tf-find");
    const q = document.getElementById("tf-q");
    q.addEventListener("input", () => { clearTimeout(f.timer); f.timer = setTimeout(search, DEBOUNCE); });
    watchLog();
  }
  const q = document.getElementById("tf-q"); q.focus(); q.select();
}
/* Esc: the bar goes, the view stays at the match; insert mode comes back to the box it came from */
export function closeFind() {
  const was = f.insert && shown();
  reset();
  if (was) setMode("insert");
}
function reset() {
  clearTimeout(f.timer); f.timer = null;
  if (f.el) f.el.remove();
  Object.assign(f, { el: null, key: null, q: "", asked: 0, hits: [], total: 0, more: false, ranges: [], at: -1, pending: -1 });
  if (HL) { CSS.highlights.delete("tf-find"); CSS.highlights.delete("tf-cur"); }
  logWatch?.disconnect(); logWatch = null;
}
const count = t => { if (f.el) f.el.querySelector(".pv-count").textContent = t; };

/* ---------- asking the backend ---------- */
function search() {
  clearTimeout(f.timer); f.timer = null;
  if (!shown() || f.key !== mounted) return;
  const q = document.getElementById("tf-q").value;
  f.q = q; f.hits = []; f.total = 0; f.at = -1; f.pending = -1; paint();
  if (!q) { f.asked = 0; count(""); return; }
  f.asked = ++f.seq;
  if (!send({ t: "find", sid: current, view: view || null, q, seq: f.asked })) { f.asked = 0; count(""); }
}
/* `found` (main.js): one for an older query, or another view, is dropped */
export function applyFound(m) {
  if (!shown() || m.seq !== f.asked || `${m.sid}|${m.view || ""}` !== f.key) return;
  f.asked = 0;
  f.hits = m.hits.flatMap(h => (h.at || []).map((_, k) => ({ id: h.id, k })));
  f.total = f.hits.length; f.more = !!m.more;
  if (!f.total) { count("No matches"); paint(); return; }
  paint();
  go(firstBelow());
}

/* ---------- moving ---------- */
/* Enter, ⌘G: the next match (dir 1) or the one before (-1); a query still being typed is asked now */
export function stepFind(dir) {
  if (f.timer) { search(); return; }
  const n = f.hits.length; if (!n) return;
  go(((f.at < 0 ? (dir > 0 ? -1 : 0) : f.at) + dir + n) % n);
}
function go(i) {
  f.at = i; f.pending = -1;
  count(`${i + 1} of ${f.total.toLocaleString()}${f.more ? "+" : ""}`);
  if (land(i)) return;
  if (shownBg()) { if (loadEarlierOutput()) f.pending = i; return; } // the output before what is loaded; land when it is
  jumpTo(mounted, { has: () => paint() && !!f.ranges[i], land: () => land(i) }, () => {});
}
/* the match on screen: its step or group opened, scrolled near the top when it is off screen, marked current */
function land(i) {
  if (!paint() || i !== f.at) return false;
  const r = f.ranges[i]; if (!r) return false;
  const log = document.getElementById("log");
  for (let n = r.startContainer.parentElement; n && n !== log; n = n.parentElement) if (n.tagName === "DETAILS" && !n.open) n.open = true;
  const rr = r.getBoundingClientRect(), lr = log.getBoundingClientRect();
  if (rr.top < lr.top + 4 || rr.bottom > lr.bottom - 4) { log.scrollTop += rr.top - lr.top - GAP; log.dispatchEvent(new Event("scroll")); } // noted as a scroll of yours (ui-state.js)
  mark();
  return true;
}
/* the first match at or below the top of the view, so typing doesn't jump away; else the nearest above */
function firstBelow() {
  const top = document.getElementById("log").getBoundingClientRect().top;
  const i = f.ranges.findIndex(r => r && shownRect(r).bottom > top);
  return i < 0 ? f.hits.length - 1 : i;
}

/* where a match shows: its own box, or the outermost closed step or group that holds it */
function shownRect(r) {
  let box = null;
  for (let n = r.startContainer.parentElement; n && n.id !== "log"; n = n.parentElement) if (n.tagName === "DETAILS" && !n.open) box = n;
  return (box || r).getBoundingClientRect();
}

/* ---------- on the page: each hit's Range, the marks ---------- */
/* Each hit's Range from the blocks on the page; true when the page shows the view searched. In a conversation
   an item's text is in its block (keyed by its id: a prompt `you:`, a `!` command `bang:`, an answer `ans:`)
   and in rows that carry its id (a step's data-item or data-step). In a shell's view the output is the loaded
   end of what was searched, so its matches are the last ones. */
function paint() {
  const log = document.getElementById("log");
  f.ranges = f.hits.map(() => null);
  if (!shown() || f.key !== mounted || !log) return false;
  const all = [];
  if (f.hits.length) {
    if (shownBg()) {
      const dom = [...log.querySelectorAll(".bg-run .out")].flatMap(el => rangesIn(el, f.q)), off = f.hits.length - dom.length;
      f.ranges = f.hits.map((_, i) => dom[i - off] || null); all.push(...dom);
    } else {
      const els = new Map(), add = (id, el) => { if (!id) return; const l = els.get(id); if (l) l.push(el); else els.set(id, [el]); };
      for (const b of log.querySelector(".log-inner").children) { const k = b.dataset.key || ""; add(/^(you|bang|ans):/.test(k) ? k.slice(k.indexOf(":") + 1) : k, b); }
      for (const el of log.querySelectorAll("[data-item], details[data-step]")) add(el.dataset.item || el.dataset.step, el);
      const dom = new Map();
      f.ranges = f.hits.map(h => {
        let list = dom.get(h.id);
        if (!list) {
          const own = (els.get(h.id) || []).filter((el, j, a) => !el.closest('[data-key="live"]') && !a.some(o => o !== el && o.contains(el))); // a row inside its own block counts once; the live line's copy of a step doesn't
          own.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
          dom.set(h.id, list = own.flatMap(el => rangesIn(el, f.q))); all.push(...list);
        }
        return list.length ? list[Math.min(h.k, list.length - 1)] : null;
      });
    }
  }
  if (HL) { if (all.length) CSS.highlights.set("tf-find", new Highlight(...all)); else CSS.highlights.delete("tf-find"); }
  mark();
  return true;
}
function mark() {
  if (!HL) return;
  const r = f.ranges[f.at];
  if (r) CSS.highlights.set("tf-cur", new Highlight(r)); else CSS.highlights.delete("tf-cur");
}
/* the Ranges of q in an element's text, across its text nodes, in one walk */
function rangesIn(el, q) {
  const hits = findIn(el.textContent, q); if (!hits.length) return [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = [];
  let n = walk.nextNode(), pos = 0, h = 0, r = null;
  while (n && h < hits.length) {
    const end = pos + n.data.length, [from, to] = hits[h];
    if (!r && from < end) { r = document.createRange(); r.setStart(n, from - pos); }
    if (r && to <= end) { r.setEnd(n, to - pos); out.push(r); r = null; h++; continue; }
    pos = end; n = walk.nextNode();
  }
  return out;
}

/* the log redrew a block (an earlier page, new items, a shell's output): the marks again, and a match that
   waited for earlier output */
let logWatch = null;
function watchLog() {
  const inner = document.querySelector("#log .log-inner"); if (!inner) return;
  logWatch = new MutationObserver(() => {
    if (!shown()) return reset();
    if (f.paintAt) return;
    f.paintAt = requestAnimationFrame(() => {
      f.paintAt = 0;
      if (f.pending >= 0 && f.pending === f.at) { if (land(f.at)) f.pending = -1; else if (shownBg() && !loadEarlierOutput()) f.pending = -1; }
      else paint();
    });
  });
  logWatch.observe(inner, { childList: true });
}
/* a view switch replaces the panel, and the bar with it */
new MutationObserver(() => { if (f.el && !f.el.isConnected) reset(); }).observe(document.getElementById("conv"), { childList: true });

/* ---------- keys (keys.js, before the session keys) ---------- */
export function findKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, cmd = e.metaKey && !e.ctrlKey && !e.altKey;
  if (cmd && !e.shiftKey && k === "f") { e.preventDefault(); openFind(); return true; }
  if (!shown()) return false;
  if (cmd && k === "g") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return true; }
  if (e.target.id !== "tf-q") return false;
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeFind(); return true; }
  return false;
}
