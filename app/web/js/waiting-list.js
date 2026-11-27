/* The Waiting on you list (requirements R9.10, FR-ITEM-08): every open item waiting on you in every open session,
   over the main area, built like the Open list (open-list.js). `w` in normal mode or the sidebar head's
   "○ N waiting on you" button opens it. Rows are grouped by session in sidebar order (sidebar.js KEYS), each with
   its id box, text, kind and age; the look is prototype/open-items-storyboard.html scenario 9. The page already
   holds every session's `openItems` (state.js), so the list needs no frame of its own. It shows what the counts
   count (FR-ITEM-06): a session's items only when the backend counts them for it (`state.waiting`), so a shared
   ledger shows once, under the session that touched it last; open Y items, review items aside, not answered
   and not `later`. Typing filters (fuzzy.js) on the item's id, text and session title, keeping the order;
   ↑↓ move (j/k too while the filter is empty), Enter selects the session and starts the item's answer in its box
   (`Y2 `, composer.js writeLine) in insert mode, with the item focused in the panel; Esc closes. */
import { store, select } from "./state.js";
import { esc } from "./format.js";
import { match, marked } from "./fuzzy.js";
import { setMode } from "./mode.js";
import { KEYS, rowWord } from "./sidebar.js";
import { itemsOf, focusItem, ageOf } from "./open-items.js";

export const wl = { el: null, filter: "", sel: null, rows: [] }; // sel: "<sid>\n<id>" of the selected row
let afterPick = () => {};
/* called after Enter selected a session, with the line to start in its box: keys.js renders the page and hands the
   line to composer.js writeLine, so this module imports neither (ui-state.js imports this one, composer.js ui-state.js) */
export function onWaitingPick(fn) { afterPick = fn; }

/* what waits on you, as the counts count it: the open Y items, review apart, not answered and not later */
const waits = i => i.kind !== "review" && i.state !== "answered" && i.state !== "later";
const plain = t => String(t || "").replace(/`([^`]+)`/g, "$1");
/* every row, in sidebar order: { s, i, text } */
function allRows() {
  const out = [];
  for (const sid of KEYS) {
    const s = store.sessions.get(sid); if (!s || !(s.state.waiting > 0)) continue;
    for (const i of itemsOf(s).items) if (waits(i)) out.push({ s, i, text: plain(i.text) });
  }
  return out;
}
const keyOf = r => `${r.s.id}\n${r.i.id}`;

document.getElementById("waiting").onclick = () => showWaitingList();

export function showWaitingList() {
  if (!wl.el) {
    document.querySelector(".app").insertAdjacentHTML("beforeend", `
      <div class="open-list waiting-list" id="waiting-list" role="dialog" aria-label="Waiting on you">
        <div class="panel ol-panel">
          <header class="ol-head">
            <h2 class="c-title">Waiting on you</h2>
            <p class="c-meta" id="wl-meta"></p>
          </header>
          <div class="composer ol-filter"><span class="g">❯</span><input id="wl-filter" autocomplete="off" spellcheck="false" placeholder="Type to find an item by its text, its id or its session" aria-label="Filter items" aria-controls="wl-list"></div>
          <div class="ol-list" id="wl-list" role="listbox" aria-label="Items waiting on you"></div>
          <p class="ol-keys"><kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> answers in its session, <kbd>Esc</kbd> closes</p>
        </div>
      </div>`);
    wl.el = document.getElementById("waiting-list");
    const inp = document.getElementById("wl-filter");
    inp.addEventListener("input", () => { wl.filter = inp.value; wl.sel = null; drawWaitingList(); });
    document.getElementById("wl-list").addEventListener("click", e => {
      const it = e.target.closest(".ol-it"); if (it) pick(wl.rows[+it.dataset.i]);
    });
  }
  wl.el.hidden = false;
  const inp = document.getElementById("wl-filter");
  inp.value = wl.filter = ""; wl.sel = null;
  drawWaitingList();
  setMode("normal"); inp.focus();
}
/* the list a reload had open (ui-state.js), with its filter */
export function restoreWaitingList(filter) {
  showWaitingList();
  if (filter) { document.getElementById("wl-filter").value = wl.filter = filter; drawWaitingList(); }
}
export const waitingListShown = () => Boolean(wl.el && !wl.el.hidden);
function hideWaitingList() {
  if (!waitingListShown()) return;
  wl.el.hidden = true;
  document.getElementById("wl-filter").blur();
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/* draws the list; also on every change of the items or the counts while it is shown (main.js) */
export function drawWaitingList() {
  if (!waitingListShown()) return;
  const all = allRows(), box = document.getElementById("wl-list");
  const sessions = new Set(all.map(r => r.s.id)).size;
  document.getElementById("wl-meta").textContent = all.length ? `${plural(all.length, "item", "items")} in ${plural(sessions, "session", "sessions")}, in sidebar order.` : "Nothing waits on you in the open sessions.";
  /* the filter keeps the order: the groups stay in sidebar order. Matched on "<id> <text> <title>". */
  const rows = [];
  for (const r of all) {
    const m = wl.filter ? match(wl.filter, `${r.i.id} ${r.text} ${r.s.title}`) : { at: [] };
    if (m) rows.push({ ...r, at: m.at });
  }
  wl.rows = rows;
  if (!rows.length) {
    box.innerHTML = all.length ? `<p class="ol-empty">No item matches “${esc(wl.filter)}”.</p>` : "";
    return;
  }
  if (!rows.some(r => keyOf(r) === wl.sel)) wl.sel = keyOf(rows[0]);
  let html = "", group = null;
  rows.forEach((r, n) => {
    if (r.s.id !== group) { group = r.s.id; html += `<div class="wl-h"><span class="t">${esc(r.s.title || "New session")}</span><span>${rowWord(r.s)}</span></div>`; }
    const id = r.i.id, kind = `${esc(r.i.kind)}${r.i.with ? `, with ${esc(r.i.with.name)}` : ""}`;
    html += `<div class="ol-it" role="option" data-i="${n}" data-sid="${esc(r.s.id)}" data-oi="${esc(id)}" aria-selected="${keyOf(r) === wl.sel}">`
      + `<span class="n"><span class="oi-id${r.i.source === "synopia" ? " found" : ""}">${marked(id, r.at)}</span><span class="x-t">${marked(r.text, r.at, id.length + 1)}</span></span>`
      + `<span class="f">${kind}</span><span class="a">${ageOf(r.i)}</span></div>`;
  });
  box.innerHTML = html;
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
/* Enter or a click: the session, its item focused in the panel, `Y2 ` started in its box in insert mode. A session
   with no box to type in (its folder gone, a terminal holds it) opens in normal mode. */
function pick(r) {
  if (!r) return;
  hideWaitingList();
  select(r.s.id); focusItem(r.s.id, r.i.id, true);
  afterPick(r.s.id, `${r.i.id} `);
}
/* its keys while it is shown (keys.js: the layer over the session keys); the rest type into the filter */
export function waitingListKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) { if (e.metaKey && e.shiftKey && /^Bracket(Left|Right)$/.test(e.code)) e.preventDefault(); return; } // the session behind it stays
  const n = wl.rows.length, empty = !wl.filter, at = wl.rows.findIndex(r => keyOf(r) === wl.sel);
  const move = step => { if (n) { wl.sel = keyOf(wl.rows[(Math.max(0, at) + step + n) % n]); drawWaitingList(); } };
  if (e.key === "Escape") hideWaitingList();
  else if (e.key === "Enter") pick(wl.rows[at]);
  else if (e.key === "ArrowDown" || (e.key === "j" && empty)) move(1);
  else if (e.key === "ArrowUp" || (e.key === "k" && empty)) move(-1);
  else return;
  e.preventDefault(); e.stopPropagation();
}
/* a click outside the list closes it */
document.addEventListener("mousedown", e => { if (waitingListShown() && !e.target.closest(".waiting-list .ol-panel") && !e.target.closest("#waiting")) hideWaitingList(); }, true);
