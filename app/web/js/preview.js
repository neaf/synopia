/* Preview: a text or source file, read-only and highlighted, over the main area (requirements R5.9).
   A file link asks the backend with `preview {path}`; a text file comes back as `preview` (bat's colours as
   escaped spans, one line per '\n'), anything else is opened by the backend as `open` would. HTML opens in
   the browser; Alt-click shows its source here. Keys while it is shown: Esc closes, j/k scroll a line, g/G
   top and bottom, / or Cmd+F find, Enter or n the next match (Shift or N the previous). A click outside
   closes it. Opened from Files changed, it starts at the diff's first changed line, softly marked. */
const pv = { el: null, want: null, path: null, line: 0, back: null, hits: [], at: -1 };
const PV_HTML = /\.html?$/i;

/* the click handler's branch (transcript.js): true when the preview took the click */
function previewClick(a, e) {
  const p = a.dataset.path;
  if (!p || (PV_HTML.test(p) && !e.altKey)) return false;
  pv.want = { path: p, back: a, ...pvChanges(a) };
  send({ t: "preview", path: p });
  return true;
}
/* the lines the row's diff changed, in the new file: added lines, and for a deletion the line after it.
   The preview tints them like the diff and starts at the first. */
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
  document.getElementById("pv-open").addEventListener("click", () => { if (pv.path) send({ t: "open", path: pv.path }); });
  const q = document.getElementById("pv-q");
  q.addEventListener("input", () => pvFind(q.value));
}
const previewShown = () => Boolean(pv.el && !pv.el.hidden);

/* the backend's reply (bridge.js); one for a file asked before the last is dropped */
function showPreview(m) {
  if (!pv.want || m.path !== pv.want.path) return;
  if (!pv.el) pvBuild();
  const want = pv.want; pv.want = null;
  pv.path = m.path; pv.line = want.first && want.first <= m.lines ? want.first : 0; pv.back = want.back;
  document.getElementById("pv-path").innerHTML = `<bdi>${esc(m.display || m.path)}</bdi>`; // rtl: a long path loses its start, not its name
  document.getElementById("pv-path").title = m.path;
  const n = Number(m.lines) || 0, count = `${n.toLocaleString()} line${n === 1 ? "" : "s"}`;
  document.getElementById("pv-meta").textContent = `${m.lang || "Plain text"}, ${m.truncated ? `the first ${count} of a ${pvSize(m.size)} file` : count}, read-only`;
  /* m.html is escaped by the backend; its only markup is <span style="color:…"> */
  const rows = String(m.html ?? "").split("\n").slice(0, n || 1);
  const box = document.getElementById("pv-lines");
  box.style.setProperty("--nw", `${String(rows.length).length + 2}ch`);
  const added = want.added || new Set(), cut = want.cut || new Set();
  box.innerHTML = rows.map((h, i) => `<div class="pl${added.has(i + 1) ? " chg" : ""}${cut.has(i + 1) ? " cut" : ""}"><span class="no">${i + 1}</span><span class="tx">${h || " "}</span></div>`).join("");
  pvCloseFind(); pv.el.hidden = false;
  setMode("normal");
  const code = document.getElementById("pv-code");
  code.scrollLeft = 0;
  const hit = pv.line ? box.children[pv.line - 1] : null; // the first changed line
  code.scrollTop = hit ? Math.max(0, hit.offsetTop - code.clientHeight / 3) : 0;
  pv.el.querySelector(".pv-panel").focus({ preventScroll: true });
}
const pvSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
function hidePreview() {
  if (!previewShown()) return;
  pv.el.hidden = true; pv.path = null; pvClearHits();
  document.getElementById("pv-lines").innerHTML = "";
  const back = pv.back; pv.back = null;
  if (back && back.isConnected) back.focus({ preventScroll: true });
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
function pvFind(text) {
  pvClearHits();
  const needle = text.toLowerCase(), count = document.getElementById("pv-count");
  if (!needle) { count.textContent = ""; return; }
  for (const tx of document.querySelectorAll("#pv-lines .tx")) {
    const hay = tx.textContent.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) pv.hits.push(pvRange(tx, i, i + needle.length));
  }
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

/* its keys come before every other handler while it is shown (window, capture), and nothing else gets them */
window.addEventListener("keydown", e => {
  if (!previewShown()) return;
  e.stopImmediatePropagation();
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
}, true);
/* a click outside the panel closes it */
document.addEventListener("mousedown", e => { if (previewShown() && !e.target.closest(".pv-panel")) hidePreview(); }, true);
