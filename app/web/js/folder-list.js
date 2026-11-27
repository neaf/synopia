/* Folder list (requirements R3.3, R3.11-R3.13): New session asks where. Over the main area, drawn like the Open
   list. The rows are the folders Synopia knows (the backend's `folders`: where sessions ran), newest first; the
   folder of the session on screen is selected, so n, Enter starts there. Typing filters them with the one
   matcher (fuzzy.js). Text starting with ~ or / is a path: Tab asks the backend for one read of the folder typed
   so far (`completeFolder`), and typing filters its child folders with no new read; Tab on a row fills its path.
   A typed path gets one check when typing stops; a missing one offers "Create folder <path> and start there".
   The rows on screen get one gone check per opening (`checkFolders`); a gone one is dimmed and can't be picked.
   The same list continues a session whose folder is gone ("Continue in a folder"). With no open session it is
   the main area's content and stays (fixed): Esc only leaves its filter. */
import { cur, store } from "./state.js";
import { request, act } from "./connection.js";
import { esc, ago } from "./format.js";
import { rank, marked } from "./fuzzy.js";
import { setMode } from "./mode.js";
import { want } from "./open-list.js";

const CHECK_MS = 300; // a typed path's one check, once typing stops
export const fl = {
  el: null, fixed: false, sid: null, filter: "", known: [], loaded: false, failed: false,
  comp: null, // the last completion: { path, names, error }
  gone: new Map(), // path -> gone, this opening's checks
  asked: new Set(), // paths asked about this opening
  rows: [], sel: 0, selPath: null, timer: null,
};
const isPath = q => /^[~/]/.test(q);
const shownPath = p => p.replace(/\/+$/, "") || "/"; // a typed path as a folder: no trailing slash
const count = n => `${n} session${n === 1 ? "" : "s"}`;
const filterEl = () => document.getElementById("fl-filter");

export const folderListShown = () => Boolean(fl.el && !fl.el.hidden);
/* the layer that has the keys (keys.js): the list while shown, except a fixed list whose filter you left */
export const folderListKeys = () => folderListShown() && !(fl.fixed && document.activeElement !== filterEl());

function mount() {
  if (fl.el) return;
  document.querySelector(".app").insertAdjacentHTML("beforeend", `
    <div class="open-list folder-list" id="folder-list" role="dialog" aria-labelledby="fl-title" hidden>
      <div class="panel ol-panel">
        <header class="ol-head"><h2 class="c-title" id="fl-title"></h2><p class="c-meta" id="fl-meta"></p></header>
        <div class="composer ol-filter"><span class="g">❯</span><input id="fl-filter" autocomplete="off" spellcheck="false" placeholder="Type to find a folder, or a path starting with ~ or /" aria-label="Find a folder" aria-controls="fl-list"></div>
        <div class="ol-list" id="fl-list" role="listbox" aria-label="Folders"></div>
        <p class="ol-note" id="fl-note"></p>
        <p class="ol-keys" id="fl-keys"></p>
      </div>
    </div>`);
  fl.el = document.getElementById("folder-list");
  const inp = filterEl();
  inp.addEventListener("input", () => { fl.filter = inp.value; fl.selPath = null; typedCheckLater(); draw(); });
  document.getElementById("fl-list").addEventListener("click", e => { const it = e.target.closest(".fl-it"); if (it) { fl.sel = +it.dataset.i; pick(); } });
  document.getElementById("fl-list").addEventListener("scroll", () => { clearTimeout(fl.scrollTimer); fl.scrollTimer = setTimeout(checkOnScreen, 150); });
}

/* New session (n, the footer's button), or "Continue in a folder" for the session `sid` whose folder is gone */
export function showFolderList({ sid = null, fixed = false, filter = null } = {}) {
  mount();
  const s = sid ? store.sessions.get(sid) : null;
  fl.fixed = fixed; fl.sid = s ? s.id : null;
  fl.gone = new Map(); fl.asked = new Set(); fl.comp = null; fl.selPath = null;
  fl.filter = filter ?? (s ? repoName(s.cwd) : "");
  document.getElementById("fl-title").textContent = s ? "Continue in a folder" : "New session";
  document.getElementById("fl-meta").textContent = s
    ? `“${s.title}” continues here, with its whole history. The session in the old folder stays in Open session.`
    : "Claude works in the folder you pick. It can't change after your first message.";
  document.getElementById("fl-keys").innerHTML = `<kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Tab</kbd> completes a path, <kbd>Enter</kbd> ${s ? "continues here" : "starts"}${fixed ? "" : ", <kbd>Esc</kbd> closes"}`;
  fl.el.hidden = false;
  const inp = filterEl(); inp.value = fl.filter;
  askFolders();
  setMode("normal"); inp.focus();
  if (isPath(fl.filter)) typedCheckLater();
}
/* the list a reload had open (ui-state.js) */
export function restoreFolderList(u) { showFolderList({ sid: u.sid && store.sessions.has(u.sid) ? u.sid : null, filter: u.filter }); }
export function hideFolderList() {
  if (!folderListShown()) return;
  fl.el.hidden = true; fl.fixed = false; clearTimeout(fl.timer);
  filterEl().blur();
}
/* the main area with no open session (transcript.js renderConv): the fixed list; gone once a session shows */
export function syncFixed(none) {
  if (none && !(folderListShown() && fl.fixed)) showFolderList({ fixed: true });
  else if (!none && folderListShown() && fl.fixed) hideFolderList();
}
/* a worktree folder's repo: its name up to the first dot ("demo-app.billing-v2" is demo-app's) */
const repoName = cwd => (String(cwd).split("/").filter(Boolean).pop() || "").split(".")[0];

function askFolders() {
  fl.failed = !request({ t: "listFolders" }); fl.loaded = false;
  draw();
}
/* a new hello: ask again (a reply lost with the old socket never comes) */
export function foldersAgain() { if (folderListShown() && !fl.loaded) askFolders(); }
export function applyFolders(m) {
  if (!folderListShown()) return;
  fl.known = m.rows || []; fl.loaded = true; fl.failed = Boolean(m.error);
  draw();
}
export function applyCompletion(m) {
  if (!folderListShown()) return;
  fl.comp = m; fl.selPath = null;
  draw();
}
export function applyFolderState(m) {
  for (const st of m.states || []) fl.gone.set(st.path, Boolean(st.gone));
  if (folderListShown()) draw();
}

/* ---------- the rows ---------- */
function computeRows() {
  const q = fl.filter, byPath = new Map(fl.known.map(k => [k.path, k]));
  let rows;
  if (!isPath(q)) {
    rows = rank(fl.known, q, k => k.path).map(h => ({ kind: "known", path: h.row.path, k: h.row, at: h.at }));
  } else {
    const cut = q.lastIndexOf("/") + 1, dir = q.slice(0, cut), rest = q.slice(cut);
    if (fl.comp && fl.comp.path === dir && !fl.comp.error) {
      const names = fl.comp.names.filter(n => !n.startsWith(".") || rest.startsWith("."));
      const from = [...dir].length;
      rows = rank(names, rest, n => n).map(h => ({ kind: "child", path: dir + h.row, k: byPath.get(dir + h.row), at: h.at.map(p => p + from) }));
    } else {
      const low = q.toLowerCase(), n = [...q].length;
      rows = fl.known.filter(k => k.path.toLowerCase().startsWith(low) || (k.path + "/").toLowerCase().startsWith(low))
        .map(k => ({ kind: "known", path: k.path, k, at: [...Array(Math.min(n, [...k.path].length)).keys()] }));
    }
    const t = shownPath(q);
    if (!rows.some(r => shownPath(r.path) === t) && fl.gone.has(t)) {
      rows.push(fl.gone.get(t) ? { kind: "create", path: t } : { kind: "typed", path: t, k: byPath.get(t), at: [] });
    }
  }
  for (const r of rows) r.gone = r.kind !== "create" && fl.gone.get(shownPath(r.path)) === true;
  return rows;
}
const pickable = r => r && !r.gone;
function draw() {
  const box = document.getElementById("fl-list"); if (!box) return;
  const rows = fl.rows = computeRows();
  /* the selection: the row it was on, else the session on screen's folder, else the first that can be picked */
  const here = cur()?.cwd;
  let i = fl.selPath !== null ? rows.findIndex(r => r.path === fl.selPath) : -1;
  if (i < 0 && !fl.filter && !fl.sid && here) i = rows.findIndex(r => r.path === here);
  if (i < 0 || !pickable(rows[i])) i = rows.findIndex(pickable);
  fl.sel = Math.max(0, i); fl.selPath = rows[fl.sel]?.path ?? null;
  const note = document.getElementById("fl-note");
  if (!rows.length) {
    box.innerHTML = `<p class="ol-empty">${fl.failed ? "Synopia couldn't read the folders. Close this and try again."
      : !fl.loaded ? "Reading folders…"
      : fl.comp?.pending && isPath(fl.filter) ? `Reading ${esc(fl.comp.path)}…`
      : fl.comp?.error && isPath(fl.filter) ? esc(fl.comp.error)
      : isPath(fl.filter) ? "Tab lists what is in this folder."
      : `No folder you have used matches “${esc(fl.filter)}”. Type a path to start anywhere.`}</p>`;
  } else {
    box.innerHTML = rows.map((r, j) => rowHTML(r, j === fl.sel && pickable(r), j)).join("");
    box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  note.textContent = fl.filter || !fl.loaded ? "" : fl.known.length <= 1
    ? "No other folders yet. Type a path; Tab lists what is in it."
    : `${fl.known.length} folders, newest first. Type to find one, or a path to start anywhere.`;
  note.hidden = !note.textContent;
  checkOnScreen();
}
function rowHTML(r, on, i) {
  if (r.kind === "create") return `<div class="fl-it mk" role="option" data-i="${i}" aria-selected="${on}"><span class="p">Create folder <span class="mono">${esc(r.path)}</span> and ${fl.sid ? "continue" : "start"} there</span></div>`;
  const n = r.gone ? "Folder gone" : r.k ? (r.k.sessions ? count(r.k.sessions) : r.path === "~" ? "home folder" : "none yet") : "not used yet";
  const label = r.kind === "child" ? r.path + "/" : r.path;
  return `<div class="fl-it${r.gone ? " gone" : ""}" role="option" data-i="${i}" data-kind="${r.kind}" aria-selected="${on}"${r.gone ? ' aria-disabled="true"' : ""}>
    <span class="p">${marked(label, r.at)}</span><span class="c">${esc(n)}</span><span class="a">${r.k?.lastUsed ? esc(ago(r.k.lastUsed)) : ""}</span></div>`;
}
/* one gone check per row on screen, per opening of the list (R3.13); the backend leaves out a protected folder's */
function checkOnScreen() {
  const box = document.getElementById("fl-list"); if (!box || !folderListShown()) return;
  const top = box.scrollTop, bottom = top + box.clientHeight, paths = [];
  box.querySelectorAll(".fl-it:not(.mk):not([data-kind=child])").forEach(el => {
    if (el.offsetTop + el.offsetHeight < top || el.offsetTop > bottom) return;
    const p = shownPath(fl.rows[+el.dataset.i]?.path || "");
    if (p && !fl.asked.has(p)) { fl.asked.add(p); paths.push(p); }
  });
  if (paths.length) request({ t: "checkFolders", paths });
}
/* a typed path: one check of exactly it, once typing stops, for the create row */
function typedCheckLater() {
  clearTimeout(fl.timer);
  if (!isPath(fl.filter)) return;
  fl.timer = setTimeout(() => {
    const t = shownPath(fl.filter);
    if (!isPath(fl.filter) || fl.gone.has(t)) return;
    request({ t: "checkFolders", paths: [t], chosen: true });
  }, CHECK_MS);
}

/* ---------- acting ---------- */
function pick() {
  const r = fl.rows[fl.sel]; if (!pickable(r)) return;
  const cwd = shownPath(r.path), create = r.kind === "create";
  if (fl.sid) {
    const sid = fl.sid;
    if (act({ t: "continueSession", sid, cwd, ...(create ? { create } : {}) })) hideFolderList();
    return;
  }
  if (!act({ t: "newSession", cwd, ...(create ? { create } : {}) }, { done: ok => { if (!ok) want.new = false; } })) return; // the list stays, to try again
  want.new = true;
  if (!fl.fixed) hideFolderList(); // a fixed list goes once the session shows (syncFixed)
}
/* Tab: a path's folder read once; else the selected row's path filled in, to go one folder deeper */
function tab() {
  const q = fl.filter, cut = q.lastIndexOf("/") + 1, dir = q.slice(0, cut);
  if (q === "~") { filterEl().value = fl.filter = "~/"; return tab(); }
  if (isPath(q) && (!fl.comp || fl.comp.path !== dir)) {
    fl.comp = { path: dir, names: [], pending: true };
    if (!request({ t: "completeFolder", path: q })) fl.comp = null;
    draw();
    return;
  }
  const r = fl.rows[fl.sel]; if (!pickable(r) || r.kind === "create") return;
  const inp = filterEl();
  inp.value = fl.filter = shownPath(r.path) + "/";
  fl.selPath = null; typedCheckLater(); draw();
}
function move(step) {
  const n = fl.rows.length; if (!n) return;
  for (let k = 1, i = fl.sel; k <= n; k++) { i = (i + step + n) % n; if (pickable(fl.rows[i])) { fl.sel = i; break; } }
  fl.selPath = fl.rows[fl.sel]?.path ?? null; draw();
}
/* its keys while it has them (keys.js); the rest type into the filter */
export function folderListKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) { if (e.metaKey && e.shiftKey && /^Bracket(Left|Right)$/.test(e.code)) e.preventDefault(); return; }
  const empty = !fl.filter;
  if (e.key === "Escape") { if (fl.fixed) filterEl().blur(); else hideFolderList(); }
  else if (e.key === "Enter") pick();
  else if (e.key === "Tab") tab();
  else if (e.key === "ArrowDown" || (e.key === "j" && empty)) move(1);
  else if (e.key === "ArrowUp" || (e.key === "k" && empty)) move(-1);
  else return;
  e.preventDefault(); e.stopPropagation();
}
/* n in normal mode and the footer's New session: the list, or back into the fixed one's filter */
export function openNewSession() {
  if (folderListShown() && fl.fixed && !fl.sid) { setMode("normal"); filterEl().focus(); return; }
  showFolderList();
}
document.getElementById("new").onclick = () => openNewSession();

/* a click outside a list that isn't fixed closes it */
document.addEventListener("mousedown", e => {
  if (folderListShown() && !fl.fixed && !e.target.closest("#folder-list .ol-panel") && !e.target.closest("#new") && !e.target.closest(".gone-line")) hideFolderList();
}, true);
