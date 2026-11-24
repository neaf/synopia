/* Dnd: dragging sessions in the sidebar (requirements R4.5, R4.6), with pointer events: native drag is
   unreliable on buttons (docs/WKWebView and AppKit.md). A drop's edges insert (blue line), the middle of a
   session not in a group makes a new group of the two, the middle of a grouped one inserts after it, and
   the empty Not in a group placeholder takes it out of its group; headings are no targets. A drop sends one
   intent (sidebar.js); the backend's `layout` frame then redraws the sidebar. */
import { act } from "./connection.js";
import { inOthers, startRename, onRendered } from "./sidebar.js";

/* the drag under way: { row, x, y, started, id, ghost, dx, dy }, null when none (keys.js leaves the keys alone while one runs) */
export let drag = null;
let dragId = null, suppressClick = false;
function clearDrop() { document.querySelectorAll(".drop-before,.drop-after,.drop-merge,.drop-into").forEach(e => e.classList.remove("drop-before", "drop-after", "drop-merge", "drop-into")); }
function dropTarget(x, y) {
  const hit = document.elementFromPoint(x, y); if (!hit) return null;
  const row = hit.closest("#groups .row"), head = hit.closest("#groups [data-drop-group]");
  if (row && row.dataset.id !== dragId) {
    const r = row.getBoundingClientRect(), f = (y - r.top) / r.height;
    if (f < .3) return { kind: "before", el: row, id: row.dataset.id };
    if (f > .7) return { kind: "after", el: row, id: row.dataset.id };
    return { kind: inOthers(row.dataset.id) ? "merge" : "after", el: row, id: row.dataset.id };
  }
  if (head) return { kind: "into", el: head, group: head.dataset.dropGroup }; // only the empty "Not in a group" placeholder
  return null;
}
function drop(id, t) {
  if (t.kind === "into") act({ t: "moveSession", sid: id, group: t.group });
  else if (t.kind === "merge") {
    const group = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    startRename(group); // its name field opens once the backend's layout has it
    act({ t: "newGroup", sid: id, onto: t.id, group }, { done: ok => { if (!ok) startRename(null); } });
  } else act({ t: "moveSession", sid: id, [t.kind]: t.id });
}
/* a render while dragging keeps the dragged row dimmed */
onRendered(el => {
  if (!drag?.started) return;
  const r = [...el.querySelectorAll(".row")].find(x => x.dataset.id === dragId);
  if (r) { r.classList.add("dragging"); drag.row = r; }
});
const sideEl = document.getElementById("groups");
sideEl.addEventListener("pointerdown", e => {
  const row = e.target.closest(".row"); if (!row || e.button !== 0) return;
  drag = { row, x: e.clientX, y: e.clientY, started: false, id: e.pointerId };
});
window.addEventListener("pointermove", e => {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.started = true; dragId = drag.row.dataset.id;
    const r = drag.row.getBoundingClientRect();
    const ghost = drag.row.cloneNode(true); ghost.classList.add("ghost"); ghost.removeAttribute("aria-current");
    Object.assign(ghost.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
    document.body.appendChild(ghost); drag.ghost = ghost; drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
    drag.row.classList.add("dragging"); document.body.classList.add("is-dragging");
  }
  e.preventDefault();
  drag.ghost.style.left = e.clientX - drag.dx + 14 + "px"; drag.ghost.style.top = e.clientY - drag.dy + "px";
  clearDrop(); const t = dropTarget(e.clientX, e.clientY);
  if (t) t.el.classList.add({ before: "drop-before", after: "drop-after", merge: "drop-merge", into: "drop-into" }[t.kind]);
  const sc = document.querySelector(".side-scroll"), sr = sc.getBoundingClientRect();
  if (e.clientY < sr.top + 30) sc.scrollTop -= 8; else if (e.clientY > sr.bottom - 30) sc.scrollTop += 8;
});
function endDrag(e, cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.started) {
    const t = cancel ? null : dropTarget(e.clientX, e.clientY);
    d.ghost.remove(); clearDrop(); d.row.classList.remove("dragging"); document.body.classList.remove("is-dragging");
    suppressClick = true; setTimeout(() => suppressClick = false, 0);
    if (t) drop(dragId, t);
    dragId = null;
  }
}
window.addEventListener("pointerup", e => endDrag(e, false));
window.addEventListener("pointercancel", e => endDrag(e, true));
/* a drag under way has the keys (keys.js: the layer over the session keys): Esc puts the row back */
export function dragKey(e) { if (e.key === "Escape") endDrag(e, true); }
sideEl.addEventListener("click", e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
