/* Sidebar: session rows, the layout of groups and renaming (split from prototype/app.html). */
/* ---------- sidebar ---------- */
let KEYS = [];
function rowHTML(s) {
  return `<button class="row" data-id="${esc(s.id)}" data-state="${toneOf(s)}" aria-current="${s.id === current}">
    <span class="r-main">
      <span class="r-title">${esc(s.title)}</span>
      <span class="r-state">${rowWord(s)}</span>
      ${s.now ? `<span class="r-now" data-line="now">${esc(s.now)}</span>` : ""}
      ${agentsOf(s).filter(a => !a.finished || inGrace(s.id, a.id)).slice(0, 3).map(a => { const k = a.fork ? "fork" : "sub", x = { agent: a, running: !a.finished, failed: false, st: a.stopped ? "stopped" : "done" };
        return `<span class="r-agent kc-${k}" data-line="a:${esc(a.id)}"><i class="el"></i>${a.finished ? `${ind(bgMarkKey(x))}${ind("s_" + k)}` : ind("k_" + k)} <b class="kw">${esc(a.description)}</b> ${a.finished ? took(agentMs(a)) : live(a.start, agentMs(a))}</span>`; }).join("")}
      ${bgLine(s)}
      ${(n => n ? `<span class="r-agent r-review" data-line="review"><i class="el"></i>${ind("review")} ${n} to review</span>` : "")(toReview(s).length)}
    </span>
    <span class="tg" aria-hidden="true"></span><span class="cap ct" aria-hidden="true"></span><span class="cap cb" aria-hidden="true"></span>
    <span class="merge-hint">+ New group</span>
    <span class="r-side" title="${esc(wordOf(s))}">${sessionMark(s)}</span>
  </button>`;
}
/* the main thread's shells and monitors as one line: a count while any runs; once the last finishes, its final
   status for the grace (tween.js), then the line leaves. A subagent's own stay in the panel. */
function bgLine(s) {
  const own = bgOf(s).filter(b => !b.agentId), n = own.filter(b => bgState(b) === "running").length;
  const many = c => `${c} shell${c > 1 ? "s" : ""} or monitor${c > 1 ? "s" : ""}`;
  if (n) return `<span class="r-agent" data-line="bg"><i class="el"></i>${ind("k_shell")} ${many(n)} running</span>`;
  const gr = own.filter(b => inGrace(s.id, b.toolUseId)).sort((p, q) => new Date(p.end || 0) - new Date(q.end || 0)), b = gr.at(-1);
  if (!b) return "";
  const st = bgState(b), x = { bg: b, running: false, failed: st === "failed", st };
  const word = st === "failed" ? "failed" : st === "timed out" ? "timed out" : st === "stopped" || st === "killed" ? "stopped" : "finished";
  return `<span class="r-agent" data-line="bg"><i class="el"></i>${ind(bgMarkKey(x))}${ind("s_" + kindKey(x))} ${many(gr.length)} ${word}</span>`;
}
/* the row's state words, as in the status storyboard: working ones without an age, the rest with one */
function rowWord(s) {
  const st = stateOf(s), d = s.statusDetail || {}, n = d.queued;
  if (st === "red") return `${esc(wordOf(s))}, ${age(s.statusAt)}`;
  if (s.status === "busy") return n ? `Working, ${esc(n)} message${n > 1 ? "s" : ""} queued` : WORD.green;
  if (s.status === "compacting") return "Compacting context";
  if (s.status === "retrying") return `Rate limited, retrying${d.retry ? ` ${until(d.retry.at)}` : ""}`;
  if (s.status === "stale") return `No updates for ${age(s.statusAt)}`;
  return `${esc(wordOf(s))}, ${age(s.statusAt)}`;
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
/* Closed sessions keep their place in the layout, hidden (plan section 11), so one reopened from the
   Open list comes back where it was. Open sessions found nowhere go to "Not in a group". */
function reconcile() {
  const placed = new Set([...layout.groups.flatMap(g => g.ids), ...layout.others]);
  data.forEach(s => { if (!placed.has(s.id)) layout.others.push(s.id); });
  layout.groups = layout.groups.filter(g => g.ids.length);
}
const shown = ids => ids.filter(id => store.sessions.has(id));
function removeId(id) { layout.groups.forEach(g => g.ids = g.ids.filter(x => x !== id)); layout.others = layout.others.filter(x => x !== id); }
const listOf = id => layout.groups.find(g => g.ids.includes(id))?.ids || (layout.others.includes(id) ? layout.others : null);
let renaming = null;

function renderSide() {
  if (!layout) loadLayout();
  reconcile();
  graceScan();
  const c = st => data.filter(s => stateOf(s) === st).length;
  const byId = id => data.find(s => s.id === id);
  const groups = layout.groups.map(g => ({ ...g, ids: shown(g.ids) })).filter(g => g.ids.length), others = shown(layout.others);
  KEYS = [...groups.flatMap(g => g.ids), ...others];
  let html = "";
  for (const g of groups) {
    html += `<section class="group tree" data-group="${esc(g.id)}">
      <div class="th">
        ${renaming === g.id ? `<input class="g-input" id="g-input" value="${esc(g.name)}" aria-label="Group name">` : `<span class="g-name" title="Double-click to rename">${esc(g.name)}</span>`}
      </div>
      ${g.ids.map(id => rowHTML(byId(id))).join("")}
    </section>`;
  }
  if (groups.length || others.length) html += `<section class="group tree others" data-group="others"><div class="th"><span class="g-name">Not in a group</span></div>
    ${others.length ? others.map(id => rowHTML(byId(id))).join("") : `<div class="g-empty" data-drop-group="others">Drop a session here to take it out of its group</div>`}</section>`;
  const el = document.getElementById("groups"), before = lineSnap(el); el.innerHTML = html;
  tweenLines(el, before);
  if (drag?.started) { const r = [...el.querySelectorAll(".row")].find(x => x.dataset.id === dragId); if (r) { r.classList.add("dragging"); drag.row = r; } } // a re-render keeps the dragged row dimmed
  el.querySelectorAll(".row").forEach(b => { b.onclick = () => { current = b.dataset.id; view = null; openBg = null; renderAll(); }; });
  el.querySelectorAll(".g-name").forEach(n => n.ondblclick = () => { renaming = n.closest(".group").dataset.group; renderSide(); });
  const inp = document.getElementById("g-input");
  if (inp) {
    inp.focus(); inp.select();
    const done = keep => { const g = layout.groups.find(x => x.id === renaming); if (g && keep && inp.value.trim()) { g.name = inp.value.trim(); saveLayout(); } renaming = null; renderSide(); };
    inp.onkeydown = e => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
    inp.onblur = () => done(true);
  }
}
/* sub-line tweens (R8.1, tween.js): keyed by session id and line (data-line), re-applied after every render */
const sideTw = lineTweens({
  sel: ".r-main > [data-line]", id: "side-line", cls: { tw: "tw", gone: "r-gone" },
  groups: el => new Map([...el.querySelectorAll(".row")].map(r => [r.dataset.id, r])),
  box: (n, h) => ({ open: { height: h, marginTop: "0px" }, shut: { height: "0px", marginTop: "-1px" } }), // -1px takes back the grid gap
  place: (r, n, after) => (after || r.querySelector(".r-state")).after(n),
});
const tweens = sideTw.tweens, lineSnap = sideTw.snap, tweenLines = sideTw.run;
/* "Close session": hides it and ends its process. When a turn or background work runs, ask first. */
function closeSession(s) {
  if (!s) return;
  const n = k => bgOf(s).filter(b => !b.agentId && bgState(b) === "running" && b.kind === k).length; // a subagent's own stop with it
  const plural = (c, one, many) => c ? [`${c} ${c === 1 ? one : many}`] : [];
  const work = [...plural(agentsOf(s).filter(a => !a.finished).length, "subagent", "subagents"),
    ...plural(n("shell"), "background shell", "background shells"), ...plural(n("monitor"), "monitor", "monitors")];
  const turn = turnRuns(s);
  const list = work.length > 1 ? `${work.slice(0, -1).join(", ")} and ${work.at(-1)}` : work[0];
  if (turn || work.length) {
    const what = turn && list ? `Claude is working, and ${list} will stop.` : turn ? "Claude is working, and its turn will stop." : `${list} will stop.`;
    if (!confirm(`Close “${s.title}”? ${what[0].toUpperCase()}${what.slice(1)}`)) return;
  }
  send({ t: "close", sid: s.id });
}
/* the footer's Open line: the list of past sessions (open-list.js) */
document.getElementById("open").onclick = () => showOpenList();
