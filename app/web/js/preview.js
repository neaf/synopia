/* Preview: a text or source file, read-only and highlighted, over the main area (requirements R5.9).
   A file link asks the backend with `preview {path}`; a text file comes back as `preview` (bat's colours as
   escaped spans, one line per '\n'), anything else is opened by the backend as `open` would, and its reply says `opened`. HTML opens in
   the browser; Alt-click shows its source here. Keys while it is shown: Esc closes, j/k scroll a line, g/G
   top and bottom, / or Cmd+F find, Enter or n the next match (Shift or N the previous). A click outside
   closes it. It always opens at the top. Lines the turn changed get quiet gutter marks (a green bar for added, a red
   mark where lines were removed); the diff is where the change itself shows. */
import { send, request } from "./connection.js";
import { esc } from "./format.js";
import { setMode } from "./mode.js";
import { themeNow } from "./theme-switch.js";

export const pv = { el: null, want: null, path: null, line: 0, back: null, hits: [], at: -1 };
const PV_HTML = /\.html?$/i;

/* the click handler's branch (transcript.js): true when the preview took the click */
export function previewClick(a, e) {
  const p = a.dataset.path;
  if (!p || (PV_HTML.test(p) && !e.altKey)) return false;
  pv.want = { path: p, back: a, ...pvChanges(a) };
  if (!request({ t: "preview", path: p, theme: themeNow() })) pv.want = null; // offline: a toast, and nothing waits
  return true;
}
/* the file the stored UI state had open (ui-state.js, after a reload): asked again, its find and scroll put back once shown */
export function restorePreview({ path, scroll, find }) {
  pv.want = { path, back: null, added: new Set(), cut: new Set(), first: 0, restore: { scroll: +scroll || 0, find: String(find || "") } };
  send({ t: "preview", path, theme: themeNow() });
}
function restored(r) {
  if (r.find) { pvOpenFind(); const q = document.getElementById("pv-q"); q.value = r.find; pvFind(r.find); }
  document.getElementById("pv-code").scrollTop = r.scroll;
}
/* the lines the row's diff changed, in the new file: added lines, and for a deletion the line after it.
   The preview marks them quietly in the gutter, like an editor's change bars; it doesn't scroll to them. */
function pvChanges(a) {
  const d = a.closest(".frow")?.nextElementSibling, added = new Set(), cut = new Set();
  if (d && d.matches(".diff")) d.querySelectorAll(".dl.a, .dl.d").forEach(r => {
    if (r.matches(".a")) { const n = +r.querySelector(".no").textContent; if (n) added.add(n); return; }
    if (r.previousElementSibling?.matches(".dl.d")) return; // one mark per run of deletions
    const before = r.previousElementSibling, n = before && before.matches(".dl.c, .dl.a") ? (+before.querySelector(".no").textContent || 0) + 1 : 1;
    cut.add(n);
  });
  const first = Math.min(...added, ...cut);
  return { added, cut, first: Number.isFinite(first) ? first : 0 };
}

function pvBuild() {
  document.querySelector(".app").insertAdjacentHTML("beforeend", `
    <div class="preview" id="preview" role="dialog" aria-label="File preview" hidden>
      <div class="panel pv-panel" tabindex="-1">
        <header class="pv-head">
          <div class="pv-name"><h2 class="pv-path mono" id="pv-path"></h2><p class="c-meta" id="pv-meta"></p></div>
          <div class="pv-acts"><button class="btn" id="pv-open" title="Open it with its default app">Open in app</button><button class="btn quiet" id="pv-close" title="Close (Esc)">Close</button></div>
        </header>
        <div class="composer pv-find" id="pv-find" hidden><span class="g">/</span><input id="pv-q" autocomplete="off" spellcheck="false" placeholder="Find in this file" aria-label="Find in this file"><span class="pv-count" id="pv-count"></span></div>
        <div class="pv-code" id="pv-code"><div class="pv-lines" id="pv-lines"></div></div>
        <p class="ol-keys"><kbd>j</kbd> <kbd>k</kbd> scroll, <kbd>g</kbd> <kbd>G</kbd> top and bottom, <kbd>/</kbd> finds, <kbd>n</kbd> next match, <kbd>Esc</kbd> closes</p>
      </div>
    </div>`);
  pv.el = document.getElementById("preview");
  document.getElementById("pv-close").addEventListener("click", hidePreview);
  document.getElementById("pv-open").addEventListener("click", () => { if (pv.path) request({ t: "open", path: pv.path }); });
  const q = document.getElementById("pv-q");
  q.addEventListener("input", () => pvFind(q.value));
}
export const previewShown = () => Boolean(pv.el && !pv.el.hidden);

/* the backend's reply (main.js); one for a file asked before the last is dropped */
export function showPreview(m) {
  if (!pv.want || m.path !== pv.want.path) return;
  if (m.opened) { pv.want = null; return; } // not text: the backend opened it in its app
  if (!pv.el) pvBuild();
  const want = pv.want; pv.want = null;
  pv.path = m.path; pv.line = 0; pv.back = want.back;
  document.getElementById("pv-path").innerHTML = `<bdi>${esc(m.display || m.path)}</bdi>`; // rtl: a long path loses its start, not its name
  document.getElementById("pv-path").title = m.path;
  const n = Number(m.lines) || 0, count = `${n.toLocaleString()} line${n === 1 ? "" : "s"}`;
  document.getElementById("pv-meta").textContent = `${m.lang || "Plain text"}, ${m.truncated ? `the first ${count} of a ${pvSize(m.size)} file` : count}, read-only`;
  /* m.html is escaped by the backend; its only markup is <span style="color:…"> */
  const rows = String(m.html ?? "").split("\n").slice(0, n || 1);
  const box = document.getElementById("pv-lines");
  box.style.setProperty("--nw", `calc(${String(rows.length).length}ch + 2.5ch + 1px)`); // the digits, the padding, the rule
  const added = want.added || new Set(), cut = want.cut || new Set();
  box.innerHTML = rows.map((h, i) => `<div class="pl${added.has(i + 1) ? " chg" : ""}${cut.has(i + 1) ? " cut" : ""}"><span class="no">${i + 1}</span><span class="tx">${h || " "}</span></div>`).join("");
  pvCloseFind(); pv.el.hidden = false;
  setMode("normal");
  const code = document.getElementById("pv-code");
  code.scrollLeft = 0;
  code.scrollTop = 0; // just the file, from the top: the diff is where changes show
  pv.el.querySelector(".pv-panel").focus({ preventScroll: true });
  if (want.restore) restored(want.restore); // reopened after a reload: its find and scroll (restorePreview)
}
const pvSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
function hidePreview() {
  if (!previewShown()) return;
  pv.el.hidden = true; pv.path = null; pvClearHits();
  document.getElementById("pv-lines").innerHTML = "";
  const back = pv.back; pv.back = null;
  if (back && back.isConnected) back.focus({ preventScroll: true });
}
/* the theme changed (theme-switch.js, through main.js): the file shown is asked again in bat's other theme, keeping its marks, scroll and find */
export function previewRetheme() {
  if (!previewShown() || !pv.path) return;
  const rows = [...document.querySelectorAll("#pv-lines .pl")], at = cls => new Set(rows.flatMap((r, i) => r.classList.contains(cls) ? [i + 1] : []));
  const find = document.getElementById("pv-find");
  pv.want = { path: pv.path, back: pv.back, added: at("chg"), cut: at("cut"), first: 0,
    restore: { scroll: document.getElementById("pv-code").scrollTop, find: find.hidden ? "" : document.getElementById("pv-q").value } };
  send({ t: "preview", path: pv.path, theme: themeNow() });
}

/* ---------- find: every match marked with the CSS Custom Highlight API (no markup added), the current one stronger ---------- */
const pvHL = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
function pvClearHits() {
  pv.hits = []; pv.at = -1;
  if (pvHL) { CSS.highlights.delete("pv-find"); CSS.highlights.delete("pv-cur"); }
  document.querySelectorAll("#pv-lines .pl.found").forEach(r => r.classList.remove("found"));
}
function pvOpenFind() {
  const f = document.getElementById("pv-find"), q = document.getElementById("pv-q");
  f.hidden = false; q.focus(); q.select();
}
function pvCloseFind() {
  const f = document.getElementById("pv-find"); if (!f) return;
  f.hidden = true; document.getElementById("pv-q").value = ""; document.getElementById("pv-count").textContent = "";
  pvClearHits();
}
/* The [from, to) of each match of needle in text, ignoring case, in text's own offsets. Each character is
   lowercased on its own and remembers where it came from, because lowercasing can change a length
   ("İ" becomes two code units), so offsets in the lowercased text don't fit the text shown. */
export function findIn(text, needle) {
  const q = String(needle).toLowerCase(), out = []; if (!q) return out;
  let hay = "", pos = 0; const from = [], to = []; // for each code unit of hay: the original character's start and end
  for (const ch of String(text)) {
    const lo = ch.toLowerCase();
    for (let k = 0; k < lo.length; k++) { from.push(pos); to.push(pos + ch.length); }
    hay += lo; pos += ch.length;
  }
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push([from[i], to[i + q.length - 1]]);
  return out;
}
function pvFind(text) {
  pvClearHits();
  const count = document.getElementById("pv-count");
  if (!text) { count.textContent = ""; return; }
  for (const tx of document.querySelectorAll("#pv-lines .tx"))
    for (const [from, to] of findIn(tx.textContent, text)) pv.hits.push(pvRange(tx, from, to));
  if (pvHL) CSS.highlights.set("pv-find", new Highlight(...pv.hits));
  count.textContent = pv.hits.length ? "" : "No match";
  if (pv.hits.length) pvStep(1, true);
}
/* a Range over [from, to) of the element's text, across its spans */
function pvRange(el, from, to) {
  const r = document.createRange(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0, started = false;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.data.length;
    if (!started && from < pos + len) { r.setStart(n, from - pos); started = true; }
    if (started && to <= pos + len) { r.setEnd(n, to - pos); break; }
    pos += len;
  }
  return r;
}
function pvStep(dir, first) {
  const n = pv.hits.length; if (!n) return;
  pv.at = first ? pvFirstBelow() : (pv.at + dir + n) % n;
  const r = pv.hits[pv.at];
  if (pvHL) CSS.highlights.set("pv-cur", new Highlight(r));
  document.querySelectorAll("#pv-lines .pl.found").forEach(x => x.classList.remove("found"));
  const row = r.startContainer.parentElement.closest(".pl"); row.classList.add("found");
  const code = document.getElementById("pv-code"), rr = r.getBoundingClientRect(), cr = code.getBoundingClientRect();
  if (rr.top < cr.top || rr.bottom > cr.bottom) code.scrollTop += rr.top - cr.top - code.clientHeight / 3;
  const gut = code.querySelector(".no")?.offsetWidth || 0;
  if (rr.left < cr.left + gut || rr.right > cr.right) code.scrollLeft += rr.left - cr.left - gut - 40;
  document.getElementById("pv-count").textContent = `${pv.at + 1} of ${n}`;
}
/* the first match at or below the top of the view, so typing doesn't jump back to line 1 */
function pvFirstBelow() {
  const top = document.getElementById("pv-code").getBoundingClientRect().top;
  const i = pv.hits.findIndex(r => r.getBoundingClientRect().bottom > top);
  return i < 0 ? 0 : i;
}

/* its keys while it is shown (keys.js: the top layer); nothing under it gets them */
export function previewKey(e) {
  e.stopPropagation();
  const code = document.getElementById("pv-code"), inFind = e.target.id === "pv-q";
  const row = () => code.querySelector(".pl")?.offsetHeight || 17;
  let done = true;
  if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") pvOpenFind();
  else if (e.metaKey || e.ctrlKey || e.altKey) done = false; // copy and the rest keep their default
  else if (e.key === "Escape") { if (inFind) { document.getElementById("pv-find").hidden = true; pv.el.querySelector(".pv-panel").focus(); } else hidePreview(); }
  else if (inFind) { if (e.key === "Enter") pvStep(e.shiftKey ? -1 : 1); else done = false; }
  else if (e.key === "j" || e.key === "ArrowDown") code.scrollBy({ top: row() });
  else if (e.key === "k" || e.key === "ArrowUp") code.scrollBy({ top: -row() });
  else if (e.key === "g" || e.key === "Home") code.scrollTop = 0;
  else if (e.key === "G" || e.key === "End") code.scrollTop = code.scrollHeight;
  else if (e.key === "/") pvOpenFind();
  else if (e.key === "n" || e.key === "Enter") pvStep(1);
  else if (e.key === "N") pvStep(-1);
  else done = false;
  if (done) e.preventDefault();
}
/* a click outside the panel closes it */
document.addEventListener("mousedown", e => { if (previewShown() && !e.target.closest(".pv-panel")) hidePreview(); }, true);
