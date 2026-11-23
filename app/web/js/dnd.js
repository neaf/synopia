/* Dnd: dragging sessions between groups in the sidebar (split from prototype/app.html). */
/* drag and drop with pointer events (native drag is unreliable on buttons):
   edges insert (blue line), the middle of a lone session makes a group, headers take it in */
let dragId = null, drag = null, suppressClick = false;
function clearDrop() { document.querySelectorAll(".drop-before,.drop-after,.drop-merge,.drop-into").forEach(e => e.classList.remove("drop-before", "drop-after", "drop-merge", "drop-into")); }
function dropTarget(x, y) {
  const hit = document.elementFromPoint(x, y); if (!hit) return null;
  const row = hit.closest("#groups .row"), head = hit.closest("#groups [data-drop-group]");
  if (row && row.dataset.id !== dragId) {
    const r = row.getBoundingClientRect(), f = (y - r.top) / r.height;
    const inGroup = !layout.others.includes(row.dataset.id);
    if (f < .3) return { kind: "before", el: row, id: row.dataset.id };
    if (f > .7) return { kind: "after", el: row, id: row.dataset.id };
    return { kind: inGroup ? "after" : "merge", el: row, id: row.dataset.id };
  }
  if (head) return { kind: "into", el: head, group: head.dataset.dropGroup }; // only the empty "Not in a group" placeholder
  return null;
}
function applyDrop(t) {
  const id = dragId; removeId(id);
  if (t.kind === "into") (t.group === "others" ? layout.others : layout.groups.find(g => g.id === t.group).ids).push(id);
  else if (t.kind === "merge") {
    const i = layout.others.indexOf(t.id);
    const g = { id: "g" + Date.now().toString(36), name: "New group", proc: "", ids: [t.id, id] };
    layout.others.splice(i, 1); layout.groups.push(g); renaming = g.id;
  } else { const list = listOf(t.id); list.splice(list.indexOf(t.id) + (t.kind === "before" ? 0 : 1), 0, id); }
  layout.groups = layout.groups.filter(g => g.ids.length);
  saveLayout(); renderSide();
}
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
    if (t) applyDrop(t);
    dragId = null;
  }
}
window.addEventListener("pointerup", e => endDrag(e, false));
window.addEventListener("pointercancel", e => endDrag(e, true));
window.addEventListener("keydown", e => { if (e.key === "Escape" && drag?.started) endDrag(e, true); });
sideEl.addEventListener("click", e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
