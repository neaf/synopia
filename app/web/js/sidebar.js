/* Sidebar: session rows, the layout of groups and renaming (split from prototype/app.html). */
/* ---------- sidebar ---------- */
let KEYS = [];
function rowHTML(s) {
  const st = stateOf(s);
  return `<button class="row" data-id="${s.id}" data-state="${st}" aria-current="${s.id === current}">
    <span class="r-main">
      <span class="r-title">${esc(s.title)}</span>
      <span class="r-state">${st === "green" ? WORD.green : `${wordOf(s)}, ${age(s.statusAt)}`}</span>
      <span class="r-now">${esc(s.now)}</span>
      ${agentsOf(s).filter(a => !a.finished).slice(0, 3).map(a => `<span class="r-agent kc-${a.fork ? "fork" : "sub"}"><i class="el"></i>${ind(a.fork ? "k_fork" : "k_sub")} <b class="kw">${esc(a.description)}</b> ${live(a.start, agentMs(a))}</span>`).join("")}
      ${(n => n ? `<span class="r-agent"><i class="el"></i>${ind("k_shell")} ${n} shell${n > 1 ? "s" : ""} or monitor${n > 1 ? "s" : ""} running</span>` : "")(bgOf(s).filter(b => bgState(b) === "running").length)}
      ${(n => n ? `<span class="r-agent r-review"><i class="el"></i>${ind("review")} ${n} to review</span>` : "")(toReview(s).length)}
    </span>
    <span class="tg" aria-hidden="true"></span><span class="cap ct" aria-hidden="true"></span><span class="cap cb" aria-hidden="true"></span>
    <span class="merge-hint">+ New group</span>
    <span class="r-side" title="${esc(wordOf(s))}">${sessionMark(s)}</span>
  </button>`;
}
/* ---------- layout: groups and order are yours; the backend stores it (state.json), nothing is in localStorage ---------- */
let layout = null; // null until hello; renderSide copies it from the store
function loadLayout() {
  layout = store.layout ? JSON.parse(JSON.stringify(store.layout)) : null;
  if (!layout) layout = {
    groups: [],
    others: data.map(s => s.id)
  };
}
const saveLayout = () => { store.layout = JSON.parse(JSON.stringify(layout)); send({ t: "layout", layout }); };
function reconcile() {
  const live = new Set(data.map(s => s.id));
  layout.groups.forEach(g => g.ids = g.ids.filter(id => live.has(id)));
  layout.others = layout.others.filter(id => live.has(id));
  const placed = new Set([...layout.groups.flatMap(g => g.ids), ...layout.others]);
  data.forEach(s => { if (!placed.has(s.id)) layout.others.push(s.id); });
  layout.groups = layout.groups.filter(g => g.ids.length);
}
function removeId(id) { layout.groups.forEach(g => g.ids = g.ids.filter(x => x !== id)); layout.others = layout.others.filter(x => x !== id); }
const listOf = id => layout.groups.find(g => g.ids.includes(id))?.ids || (layout.others.includes(id) ? layout.others : null);
let renaming = null;

function renderSide() {
  if (!layout) loadLayout();
  reconcile();
  const c = st => data.filter(s => stateOf(s) === st).length;
  const byId = id => data.find(s => s.id === id);
  KEYS = [...layout.groups.flatMap(g => g.ids), ...layout.others];
  let html = "";
  for (const g of layout.groups) {
    html += `<section class="group tree" data-group="${g.id}">
      <div class="th">
        ${renaming === g.id ? `<input class="g-input" id="g-input" value="${esc(g.name)}" aria-label="Group name">` : `<span class="g-name" title="Double-click to rename">${esc(g.name)}</span>`}
      </div>
      ${g.ids.map(id => rowHTML(byId(id))).join("")}
    </section>`;
  }
  if (layout.groups.length || layout.others.length) html += `<section class="group tree others" data-group="others"><div class="th"><span class="g-name">Not in a group</span></div>
    ${layout.others.length ? layout.others.map(id => rowHTML(byId(id))).join("") : `<div class="g-empty" data-drop-group="others">Drop a session here to take it out of its group</div>`}</section>`;
  const el = document.getElementById("groups"); el.innerHTML = html;
  el.querySelectorAll(".row").forEach(b => { b.onclick = () => { current = b.dataset.id; view = null; renderAll(); }; });
  el.querySelectorAll(".g-name").forEach(n => n.ondblclick = () => { renaming = n.closest(".group").dataset.group; renderSide(); });
  const inp = document.getElementById("g-input");
  if (inp) {
    inp.focus(); inp.select();
    const done = keep => { const g = layout.groups.find(x => x.id === renaming); if (g && keep && inp.value.trim()) { g.name = inp.value.trim(); saveLayout(); } renaming = null; renderSide(); };
    inp.onkeydown = e => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
    inp.onblur = () => done(true);
  }
}
