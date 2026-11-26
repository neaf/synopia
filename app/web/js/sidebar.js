/* Sidebar: the session rows and the groups tree (requirements R4). The backend owns the layout
   (backend layout.ts): the page draws the one it got (state.js store.layout) and sends intents, as acked
   actions: `moveSession` and `newGroup` from a drop (dnd.js), `renameGroup` from the name field. Nothing
   here changes the layout itself, so a refused or unsent intent leaves the sidebar as the backend has it. */
import { store, data, current, select, agentsOf, agentMs, isClaudeBg } from "./state.js";
import { esc, took, live, age, until } from "./format.js";
import { act } from "./connection.js";
import { ind, sessionMark, bgMarkKey, kindKey } from "./marks.js";
import { lineTweens, inGrace } from "./tween.js";
import { focusItem, firstWaiting } from "./open-items.js";
import { bgOf, bgState, scanGrace } from "./rail.js";

/* the sessions in sidebar order (Ctrl+J/K, keys.js) */
export let KEYS = [];

/* one session row (exported for the escape test) */
export function rowHTML(s) {
  return `<button class="row" data-id="${esc(s.id)}" data-state="${s.state.tone}" aria-current="${s.id === current}">
    <span class="r-main">
      <span class="r-title">${esc(s.title)}</span>
      <span class="r-state">${rowWord(s)}</span>
      ${s.now ? `<span class="r-now" data-line="now">${esc(s.now)}</span>` : ""}
      ${agentsOf(s).filter(a => !a.finished || inGrace(s.id, a.id)).slice(0, 3).map(a => { const k = a.fork ? "fork" : "sub", x = { agent: a, running: !a.finished, failed: false, st: a.stopped ? "stopped" : "done" };
        return `<span class="r-agent kc-${k}" data-line="a:${esc(a.id)}"><i class="el"></i>${a.finished ? `${ind(bgMarkKey(x))}${ind("s_" + k)}` : ind((a.waiting ? "s_" : "k_") + k)} <b class="kw">${esc(a.description)}</b> ${a.finished ? took(agentMs(a)) : `${a.waiting ? "waiting, " : ""}${live(a.start, agentMs(a))}`}</span>`; }).join("")}
      ${waitLine(s)}
      ${bgLine(s)}
      ${(n => n ? `<span class="r-agent r-review" data-line="review"><i class="el"></i>${ind("review")} ${n} to review</span>` : "")(s.state.review)}
      ${waitingLine(s)}
    </span>
    <span class="tg" aria-hidden="true"></span><span class="cap ct" aria-hidden="true"></span><span class="cap cb" aria-hidden="true"></span>
    <span class="merge-hint">+ New group</span>
    <span class="r-side" title="${esc(s.state.word)}">${sessionMark(s)}</span>
  </button>`;
}
/* the main thread's shells and monitors as one line: a count while any runs; once the last finishes, its final
   status for the grace (tween.js), then the line leaves. A subagent's own, and your `!` runs, stay in the panel. */
function bgLine(s) {
  const own = bgOf(s).filter(b => !b.agentId && isClaudeBg(b)), n = own.filter(b => bgState(b) === "running").length;
  const many = c => `${c} shell${c > 1 ? "s" : ""} or monitor${c > 1 ? "s" : ""}`;
  if (n) return `<span class="r-agent" data-line="bg"><i class="el"></i>${ind("k_shell")} ${many(n)} running</span>`;
  const gr = own.filter(b => inGrace(s.id, b.toolUseId)).sort((p, q) => new Date(p.end || 0) - new Date(q.end || 0)), b = gr.at(-1);
  if (!b) return "";
  const st = bgState(b), x = { bg: b, running: false, failed: st === "failed", st };
  const word = st === "failed" ? "failed" : st === "timed out" ? "timed out" : st === "stopped" || st === "killed" ? "stopped" : "finished";
  return `<span class="r-agent" data-line="bg"><i class="el"></i>${ind(bgMarkKey(x))}${ind("s_" + kindKey(x))} ${many(gr.length)} ${word}</span>`;
}
/* the open items waiting on you, and the follow-ups due (R4.2, FR-ITEM-06): the backend's counts (status.ts), under "N to review" */
function waitingLine(s) {
  const n = s.state.waiting || 0, d = s.state.due || 0; if (!n && !d) return "";
  const text = [...(n ? [`${n} waiting on you`] : []), ...(d ? [`${d} due`] : [])].join(", ");
  return `<span class="r-agent r-wait" data-line="waiting"><i class="el"></i>${ind("open")} ${text}</span>`;
}
/* a run of yours that waits for input (R4.2, 2026-11-26): the only run of yours that reaches the sidebar, as needs you */
function waitLine(s) {
  const b = bgOf(s).find(x => x.own && x.waiting && bgState(x) === "running"); if (!b) return "";
  return `<span class="r-agent kc-shell" data-line="wait"><i class="el"></i>${ind("pause")} <b class="kw"><span class="who">!</span> ${esc(b.command)}</b> waits</span>`;
}
/* the row's state words, as in the status storyboard: working ones without an age, the rest with one */
function rowWord(s) {
  const st = s.state, d = st.detail, n = d.queued;
  if (st.light === "red") return `${esc(st.word)}, ${age(st.since)}`;
  if (st.status === "busy") return n ? `Working, ${esc(n)} message${n > 1 ? "s" : ""} queued` : esc(st.word);
  if (st.status === "compacting") return "Compacting context";
  if (st.status === "retrying") return `${esc(st.word)}${d.retry ? `, ${until(d.retry.at)}` : ""}`;
  if (st.status === "refreshing") return esc(st.word);
  if (st.status === "stale") return `No updates for ${age(st.since)}`;
  return `${esc(st.word)}, ${age(st.since)}`;
}

/* ---------- the groups: the backend's layout, closed sessions' ids in it hidden ---------- */
const layout = () => store.layout || { groups: [], others: [] };
/* whether the session is under Not in a group (a drop on its middle makes a new group, dnd.js) */
export const inOthers = id => layout().others.includes(id);
let renaming = null; // the group whose name field is open
/* opens the name field of a group, now or once the backend's layout has it (a new group, dnd.js) */
export function startRename(group) { renaming = group; }
let picked = () => {};
/* called after a row's click selected its session (main.js: the whole page renders) */
export function onPick(fn) { picked = fn; }
const rendered = [];
/* called after every render with the sidebar's element (dnd.js keeps a dragged row dimmed) */
export function onRendered(fn) { rendered.push(fn); }

export function renderSide() {
  scanGrace();
  const l = layout(), byId = id => store.sessions.get(id);
  const shown = ids => ids.filter(id => store.sessions.has(id));
  const placed = new Set([...l.groups.flatMap(g => g.ids), ...l.others]);
  const groups = l.groups.map(g => ({ ...g, ids: shown(g.ids) })).filter(g => g.ids.length);
  /* a session the backend's layout doesn't hold yet (its `layout` frame is on the way) shows last here */
  const others = [...shown(l.others), ...data.map(s => s.id).filter(id => !placed.has(id))];
  KEYS = [...groups.flatMap(g => g.ids), ...others];
  const typing = document.getElementById("g-input"), typed = typing && typing.dataset.group === renaming ? typing.value : null;
  let html = "";
  for (const g of groups) {
    html += `<section class="group tree" data-group="${esc(g.id)}">
      <div class="th">
        ${renaming === g.id ? `<input class="g-input" id="g-input" data-group="${esc(g.id)}" value="${esc(g.name)}" aria-label="Group name">` : `<span class="g-name" title="Double-click to rename">${esc(g.name)}</span>`}
      </div>
      ${g.ids.map(id => rowHTML(byId(id))).join("")}
    </section>`;
  }
  if (groups.length || others.length) html += `<section class="group tree others" data-group="others"><div class="th"><span class="g-name">Not in a group</span></div>
    ${others.length ? others.map(id => rowHTML(byId(id))).join("") : `<div class="g-empty" data-drop-group="others">Drop a session here to take it out of its group</div>`}</section>`;
  const el = document.getElementById("groups"), before = lineSnap(el); el.innerHTML = html;
  tweenLines(el, before);
  rendered.forEach(f => f(el));
  /* a click on the "○ N waiting on you" line opens the session with its first Waiting on you item focused (R4.2) */
  el.querySelectorAll(".row").forEach(b => { b.onclick = e => { select(b.dataset.id); if (e.target.closest('[data-line="waiting"]')) focusItem(b.dataset.id, firstWaiting(store.sessions.get(b.dataset.id))?.id, true); picked(); }; });
  el.querySelectorAll(".g-name").forEach(n => n.ondblclick = () => { renaming = n.closest(".group").dataset.group; renderSide(); });
  const inp = document.getElementById("g-input");
  if (inp) {
    inp.focus();
    if (typed === null) inp.select(); else inp.value = typed; // a render while you type keeps what you typed
    const done = keep => {
      if (renaming === null) return;
      const g = l.groups.find(x => x.id === renaming), name = inp.value.trim();
      renaming = null;
      if (g && keep && name && name !== g.name) act({ t: "renameGroup", group: g.id, name });
      renderSide();
    };
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
export const tweens = sideTw.tweens;
const lineSnap = sideTw.snap, tweenLines = sideTw.run;

/* what closing a session stops: its turn, subagents, shells and monitors, as one sentence ("" when nothing
   runs); the x, x prompt adds it (composer.js) */
export function closeStops(s) {
  const n = k => bgOf(s).filter(b => !b.agentId && bgState(b) === "running" && b.kind === k).length; // a subagent's own stop with it
  const plural = (c, one, many) => c ? [`${c} ${c === 1 ? one : many}`] : [];
  const work = [...(s.state.light !== "amber" ? ["Claude's turn"] : []), ...plural(agentsOf(s).filter(a => !a.finished).length, "subagent", "subagents"),
    ...plural(n("shell"), "shell", "shells"), ...plural(n("monitor"), "monitor", "monitors")];
  if (!work.length) return "";
  return `${work.length > 1 ? `${work.slice(0, -1).join(", ")} and ${work.at(-1)}` : work[0]} will stop.`;
}
/* x, x: hides the session and ends its process (or, one another process drives, only removes it from Synopia) */
export function closeSession(s) {
  if (s) act({ t: "close", sid: s.id });
}
