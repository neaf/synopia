/* Open list: past sessions from the backend's listSessions(), over the main area (requirements R3.2).
   Newest first, with the title, folder and age; the header gives the totals. Typing searches every past
   session in the backend with the one matcher (fuzzy.js), and the page marks the matched letters with the
   same matcher. The rows on screen get one gone check per opening: a gone one says "Folder gone". ↑↓ move
   (j/k too while the filter is empty, after that they type), Enter opens, Esc closes. Opening adds the
   session to the sidebar and shows it; it resumes on your first message. New session (folder-list.js) and
   this list both show the session asked for when its `session` frame arrives (main.js, `want`). */
import { request, act } from "./connection.js";
import { esc, ago } from "./format.js";
import { match, marked } from "./fuzzy.js";
import { setMode } from "./mode.js";

/* the session asked for, until it arrives: a new one (any `new-` id) or the id opened. A refused or
   failed ack clears it, so a later frame doesn't switch the view. */
export const want = { new: false, open: null };
export const openList = { el: null, rows: [], sel: 0, filter: "", loading: false, failed: false, timer: null, totals: null, gone: new Map(), asked: new Set() };

document.getElementById("open").onclick = () => showOpenList();

export function showOpenList() {
  if (!openList.el) {
    document.querySelector(".app").insertAdjacentHTML("beforeend", `
      <div class="open-list" id="open-list" role="dialog" aria-label="Open session">
        <div class="panel ol-panel">
          <header class="ol-head">
            <h2 class="c-title">Open session</h2>
            <p class="c-meta" id="ol-meta">Past sessions, newest first.</p>
          </header>
          <div class="composer ol-filter"><span class="g">❯</span><input id="ol-filter" autocomplete="off" spellcheck="false" placeholder="Type to find a session by title or folder" aria-label="Filter sessions" aria-controls="ol-list"></div>
          <div class="ol-list" id="ol-list" role="listbox" aria-label="Past sessions"></div>
          <p class="ol-note" id="ol-note" hidden></p>
          <p class="ol-keys"><kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> opens, <kbd>Esc</kbd> closes</p>
        </div>
      </div>`);
    openList.el = document.getElementById("open-list");
    const inp = document.getElementById("ol-filter");
    inp.addEventListener("input", () => {
      openList.filter = inp.value; openList.sel = 0;
      clearTimeout(openList.timer); openList.timer = setTimeout(askRecent, 120);
    });
    document.getElementById("ol-list").addEventListener("click", e => {
      const it = e.target.closest(".ol-it"); if (it) pickRecent(+it.dataset.i);
    });
    document.getElementById("ol-list").addEventListener("scroll", () => { clearTimeout(openList.scrollTimer); openList.scrollTimer = setTimeout(checkOnScreen, 150); });
  }
  openList.el.hidden = false;
  const inp = document.getElementById("ol-filter");
  inp.value = openList.filter = ""; openList.sel = 0; openList.rows = []; openList.totals = null;
  openList.gone = new Map(); openList.asked = new Set(); // one check per row on screen, per opening (R3.13)
  askRecent();
  setMode("normal"); inp.focus();
}
/* the list a reload had open (ui-state.js), with its filter */
export function restoreOpenList(filter) {
  showOpenList();
  if (filter) { document.getElementById("ol-filter").value = openList.filter = filter; askRecent(); }
}
export const openListShown = () => Boolean(openList.el && !openList.el.hidden);
function hideOpenList() {
  if (!openListShown()) return;
  openList.el.hidden = true; clearTimeout(openList.timer);
  document.getElementById("ol-filter").blur();
}
/* asks for the list; offline the list says it could not be read (a toast says why), so it never stays on "Reading…" */
function askRecent() {
  openList.failed = !request({ t: "listRecent", filter: openList.filter }); openList.loading = !openList.failed;
  drawOpenList();
}

/* a new hello: a list still reading or refused offline asks again (a reply lost with the old socket never comes) */
export function recentAgain() { if (openListShown() && (openList.loading || openList.failed)) askRecent(); }

/* the backend's reply; a reply for an older filter is dropped */
export function applyRecent(m) {
  if (!openListShown() || (m.filter || "") !== openList.filter) return;
  openList.rows = m.sessions || []; openList.loading = false; openList.failed = Boolean(m.error);
  if (typeof m.total === "number") openList.totals = { total: m.total, folders: m.folders ?? 0, matched: m.matched ?? 0 };
  openList.sel = Math.min(openList.sel, Math.max(0, openList.rows.length - 1));
  drawOpenList();
}
/* the gone checks' replies (main.js passes every folderState to both lists) */
export function applyOpenFolderState(m) {
  for (const st of m.states || []) openList.gone.set(st.path, Boolean(st.gone));
  if (openListShown()) drawOpenList();
}
function checkOnScreen() {
  const box = document.getElementById("ol-list"); if (!box || !openListShown()) return;
  const top = box.scrollTop, bottom = top + box.clientHeight, paths = [];
  box.querySelectorAll(".ol-it").forEach(el => {
    if (el.offsetTop + el.offsetHeight < top || el.offsetTop > bottom) return;
    const p = openList.rows[+el.dataset.i]?.cwd;
    if (p && !openList.asked.has(p)) { openList.asked.add(p); paths.push(p); }
  });
  if (paths.length) request({ t: "checkFolders", paths });
}
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function drawTotals() {
  const t = openList.totals, meta = document.getElementById("ol-meta"), note = document.getElementById("ol-note");
  if (!meta || !note) return;
  meta.textContent = t ? `${plural(t.total, "past session")} in ${plural(t.folders, "folder")}, newest first.` : "Past sessions, newest first.";
  note.textContent = !t || openList.loading ? "" : openList.filter ? (t.matched ? `${plural(t.matched, "session")} match${t.matched === 1 ? "es" : ""}.${t.matched > openList.rows.length ? ` The best ${openList.rows.length} show.` : ""}` : "")
    : t.total > openList.rows.length ? `Newest ${openList.rows.length} of ${t.total}. Type to search all of them.` : "";
  note.hidden = !note.textContent;
}
function drawOpenList() {
  const box = document.getElementById("ol-list"); if (!box) return;
  const { rows, sel } = openList;
  drawTotals();
  if (!rows.length) {
    box.innerHTML = `<p class="ol-empty">${openList.failed ? "Synopia couldn't read the list of past sessions. Close this and try again."
      : openList.loading ? "Reading past sessions…"
      : openList.filter ? `No past session matches “${esc(openList.filter)}”.` : "No past sessions to open."}</p>`;
    return;
  }
  box.innerHTML = rows.map((r, i) => {
    /* the matched letters, as the backend's matcher ranked them: on "title folder" */
    const m = openList.filter ? match(openList.filter, `${r.title} ${r.cwd}`) : null, at = m ? m.at : [];
    const gone = openList.gone.get(r.cwd) === true, tl = [...r.title].length;
    return `<div class="ol-it" role="option" data-i="${i}" aria-selected="${i === sel}">
      <span class="n"><span class="t">${marked(r.title, at)}</span>${r.terminal ? `<span class="term" title="pid ${esc(r.terminal)}">Open in a terminal</span>` : ""}${gone ? `<span class="term">Folder gone</span>` : ""}</span><span class="f${gone ? " gone" : ""}">${marked(r.cwd, at, tl + 1)}</span><span class="a">${esc(ago(r.lastModified))}</span></div>`;
  }).join("");
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  checkOnScreen();
}
function pickRecent(i) {
  const r = openList.rows[i]; if (!r) return;
  if (!act({ t: "openSession", sid: r.id }, { done: ok => { if (!ok && want.open === r.id) want.open = null; } })) return; // the list stays, to try again
  want.open = r.id; hideOpenList();
}
/* its keys while it is shown (keys.js: the layer over the session keys); the rest type into the filter */
export function openListKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) { if (e.metaKey && e.shiftKey && /^Bracket(Left|Right)$/.test(e.code)) e.preventDefault(); return; } // the session behind it stays
  const n = openList.rows.length, empty = !openList.filter;
  const move = step => { if (n) { openList.sel = (openList.sel + step + n) % n; drawOpenList(); } };
  if (e.key === "Escape") hideOpenList();
  else if (e.key === "Enter") pickRecent(openList.sel);
  else if (e.key === "ArrowDown" || (e.key === "j" && empty)) move(1);
  else if (e.key === "ArrowUp" || (e.key === "k" && empty)) move(-1);
  else return;
  e.preventDefault(); e.stopPropagation();
}
/* a click outside the list closes it */
document.addEventListener("mousedown", e => { if (openListShown() && !e.target.closest(".ol-panel") && !e.target.closest("#open")) hideOpenList(); }, true);
