/* Open list: past sessions from the backend's listSessions(), over the main area (plan section 4).
   Newest first, with the title, folder and age. ↑↓ move (j/k too while the filter is empty, after that
   they type), Enter opens, Esc closes, typing filters. Opening adds the session to the sidebar and shows
   it; it resumes on your first message. */
let wantOpen = null; // the id asked for; bridge.js shows it when its session message arrives
const openList = { el: null, rows: [], sel: 0, filter: "", loading: false, failed: false, timer: null };

function showOpenList() {
  if (!openList.el) {
    document.querySelector(".app").insertAdjacentHTML("beforeend", `
      <div class="open-list" id="open-list" role="dialog" aria-label="Open session">
        <div class="panel ol-panel">
          <header class="ol-head">
            <h2 class="c-title">Open session</h2>
            <p class="c-meta">Past sessions, newest first. The one you open joins the sidebar and picks up where it left off when you send a message.</p>
          </header>
          <div class="composer ol-filter"><span class="g">❯</span><input id="ol-filter" autocomplete="off" spellcheck="false" placeholder="Type to filter by title or folder" aria-label="Filter sessions" aria-controls="ol-list"></div>
          <div class="ol-list" id="ol-list" role="listbox" aria-label="Past sessions"></div>
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
  }
  openList.el.hidden = false;
  const inp = document.getElementById("ol-filter");
  inp.value = openList.filter = ""; openList.sel = 0; openList.rows = [];
  askRecent();
  setMode("normal"); inp.focus();
}
const openListShown = () => Boolean(openList.el && !openList.el.hidden);
function hideOpenList() {
  if (!openListShown()) return;
  openList.el.hidden = true; clearTimeout(openList.timer);
  document.getElementById("ol-filter").blur();
}
function askRecent() { openList.loading = true; openList.failed = false; drawOpenList(); send({ t: "listRecent", filter: openList.filter }); }

/* the backend's reply; a reply for an older filter is dropped */
function applyRecent(m) {
  if (!openListShown() || (m.filter || "") !== openList.filter) return;
  openList.rows = m.sessions || []; openList.loading = false; openList.failed = Boolean(m.error);
  openList.sel = Math.min(openList.sel, Math.max(0, openList.rows.length - 1));
  drawOpenList();
}
function drawOpenList() {
  const box = document.getElementById("ol-list"); if (!box) return;
  const { rows, sel } = openList;
  if (!rows.length) {
    box.innerHTML = `<p class="ol-empty">${openList.failed ? "Synopia couldn't read the list of past sessions. Close this and try again."
      : openList.loading ? "Reading past sessions…"
      : openList.filter ? `No past session matches “${esc(openList.filter)}”.` : "No past sessions to open."}</p>`;
    return;
  }
  box.innerHTML = rows.map((r, i) => `<div class="ol-it" role="option" data-i="${i}" aria-selected="${i === sel}">
      <span class="n"><span class="t">${esc(r.title)}</span>${r.terminal ? `<span class="term" title="pid ${esc(r.terminal)}">Open in a terminal</span>` : ""}</span><span class="f">${esc(r.cwd)}</span><span class="a">${olAgo(r.lastModified)}</span></div>`).join("");
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
/* "2 h ago": one unit is enough to tell sessions apart */
function olAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}
function pickRecent(i) {
  const r = openList.rows[i]; if (!r) return;
  wantOpen = r.id; send({ t: "openSession", id: r.id }); hideOpenList();
}
/* its keys come first while it is shown; the rest type into the filter */
document.addEventListener("keydown", e => {
  if (!openListShown() || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = openList.rows.length, empty = !openList.filter;
  const move = step => { if (n) { openList.sel = (openList.sel + step + n) % n; drawOpenList(); } };
  if (e.key === "Escape") hideOpenList();
  else if (e.key === "Enter") pickRecent(openList.sel);
  else if (e.key === "ArrowDown" || (e.key === "j" && empty)) move(1);
  else if (e.key === "ArrowUp" || (e.key === "k" && empty)) move(-1);
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
/* a click outside the list closes it */
document.addEventListener("mousedown", e => { if (openListShown() && !e.target.closest(".ol-panel") && !e.target.closest("#open")) hideOpenList(); }, true);
