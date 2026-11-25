/* Paths in Claude's replies (R5.9, 2026-11-25): an inline code span that looks like a path (md.js pathCandidate,
   marked `data-pc`) is asked about once, in one `resolvePaths {sid, paths}` per render, and the answer is kept per
   session. One that is there gets `path-ok` and its absolute path and kind. With ⌘ held it shows the link look
   (css `.cmd-held code.path-ok`), and a ⌘-click opens it as a Files changed row does: a text or source file in the
   preview, HTML in the browser (Alt shows its source), an image in the viewer, anything else and folders through
   `open`. A plain click does nothing new, so text selection keeps working. */
import { request } from "./connection.js";
import { current } from "./state.js";
import { previewClick } from "./preview.js";
import { showViewer, imageUrl } from "./images.js";

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const AGAIN_MS = 30000; // a path that wasn't there is asked again after this, once a render shows it
const known = new Map(); // sid -> Map(candidate -> {path, kind} | {missing: at} | "asked")

function mark(el, st) {
  el.dataset.pr = "1";
  if (!st || !st.path) return;
  el.classList.add("path-ok"); el.dataset.path = st.path; el.dataset.kind = st.kind;
}
/* the spans not handled yet: what is known is applied, the rest asked in one request */
function scan() {
  queued = 0;
  const sid = current; if (!sid) return;
  const els = document.querySelectorAll("#log code[data-pc]:not([data-pr])"); if (!els.length) return;
  let m = known.get(sid); if (!m) known.set(sid, (m = new Map()));
  const ask = new Set(), now = Date.now();
  for (const el of els) {
    const p = el.dataset.pc, st = m.get(p);
    if (st === "asked") continue;
    if (st && (st.path || now - st.missing < AGAIN_MS)) { mark(el, st); continue; }
    ask.add(p);
  }
  if (!ask.size) return;
  const paths = [...ask].slice(0, 200);
  paths.forEach(p => m.set(p, "asked"));
  if (!request({ t: "resolvePaths", sid, paths })) paths.forEach(p => m.delete(p));
}
let queued = 0;
const later = () => { if (!queued) queued = requestAnimationFrame(scan); };
new MutationObserver(() => { if (document.querySelector("#log code[data-pc]:not([data-pr])")) later(); })
  .observe(document.documentElement, { childList: true, subtree: true });

/* the backend's answer (main.js) */
export function applyPathState(m) {
  let map = known.get(m.sid); if (!map) known.set(m.sid, (map = new Map()));
  const now = Date.now();
  for (const s of m.states || []) if (s && typeof s.p === "string") map.set(s.p, s.path ? { path: s.path, kind: s.kind } : { missing: now });
  if (m.sid !== current) return;
  for (const el of document.querySelectorAll("#log code[data-pc]:not([data-pr])")) {
    const st = map.get(el.dataset.pc);
    if (st && st !== "asked") mark(el, st);
  }
}

/* ⌘ held: from the keys and from the pointer's own flag (⌘ pressed while the window was elsewhere); off on blur */
const root = document.documentElement;
const held = on => root.classList.toggle("cmd-held", !!on);
window.addEventListener("keydown", e => held(e.metaKey || e.key === "Meta"), true);
window.addEventListener("keyup", e => held(e.key === "Meta" ? false : e.metaKey), true);
window.addEventListener("mousemove", e => { if (e.metaKey !== root.classList.contains("cmd-held")) held(e.metaKey); }, true);
window.addEventListener("blur", () => held(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) held(false); });

document.addEventListener("click", e => {
  if (!e.metaKey) return;
  const el = e.target.closest && e.target.closest("#log code.path-ok"); if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const abs = el.dataset.path;
  if (el.dataset.kind === "folder") { request({ t: "open", path: abs }); return; }
  if (IMG.test(abs)) { showViewer([imageUrl(current, null, "file:" + abs)], 0, [el.dataset.pc]); return; }
  if (!previewClick(el, e)) request({ t: "open", path: abs });
}, true);
