/* Sidebar: the session rows and the groups tree (requirements R4). The backend owns the layout
   (backend layout.ts): the page draws the one it got (state.js store.layout) and sends intents, as acked
   actions: `moveSession` and `newGroup` from a drop (dnd.js), `renameGroup` from the name field. Nothing
   here changes the layout itself, so a refused or unsent intent leaves the sidebar as the backend has it. */
import { store, data, current, select, agentsOf, nowish } from "./state.js";
import { esc, took, live, age, until } from "./format.js";
import { act } from "./connection.js";
import { ind, sessionMark, bgMarkKey, kindKey } from "./marks.js";
import { lineTweens } from "./tween.js";
import { bgOf, bgState, scanGrace, mainTree } from "./rail.js";
import { whoHTML } from "./runs.js";

/* the sessions in sidebar order (Ctrl+J/K, keys.js) */
export let KEYS = [];

/* one session row (exported for the escape test) */
export function rowHTML(s) {
  return `<button class="row" data-id="${esc(s.id)}" data-state="${s.state.tone}" aria-current="${s.id === current}">
    <span class="r-main">
      <span class="r-title">${esc(s.title)}</span>
      <span class="r-state">${rowWord(s)}</span>
      ${s.now ? `<span class="r-now" data-line="now">${esc(s.now)}</span>` : ""}
      ${subLines(s)}
      ${(n => n ? `<span class="r-agent r-review" data-line="review"><i class="el"></i>${ind("review")} ${n} to review</span>` : "")(s.state.review)}
    </span>
    <span class="tg" aria-hidden="true"></span><span class="cap ct" aria-hidden="true"></span><span class="cap cb" aria-hidden="true"></span>
    <span class="merge-hint">+ New group</span>
    <span class="r-side" title="${esc(s.state.word)}">${sessionMark(s)}</span>
  </button>`;
}
/* The sub-lines: the panel's Main conversation tree, item for item (R4.2, R7.1, 2026-11-27, the user: "Render exactly
   what we have inside the right panel. Even if there's 10 items, 3 levels deep, it's fine."). Each subagent, fork,
   shell and monitor, yours and the refresh too, has its own line under what started it, one level deeper each, in the
   panel's order, with its name, kind mark and timer. No count lines, no cap. The tree is rail.js's (mainTree). */
function subLines(s) {
  const lines = (x, d) => [subLine(x, d), ...x.kids.flatMap(y => lines(y, d + 1))];
  return mainTree(s).flatMap(x => lines(x, 0)).join("");
}
/* one sub-line: an item of the tree at its depth; a run that waits for input reads "waits" with the pause mark (2026-11-26) */
function subLine(x, depth) {
  const k = kindKey(x), at = depth ? ` style="--depth:${depth}"` : "";
  const mark = x.waits ? ind("pause") : x.waiting ? ind("s_" + k) : x.running ? ind("k_" + k) : `${ind(bgMarkKey(x))}${ind("s_" + k)}`;
  const time = x.waits ? "waits" : x.running ? `${x.waiting ? "waiting, " : ""}${live(x.start, x.ms)}` : took(x.ms);
  return `<span class="r-agent kc-${k}${x.waits ? " waits" : ""}" data-line="${x.agent ? "a:" : "b:"}${esc(x.key)}"${at}><i class="el"></i>${mark} <b class="kw">${whoHTML(x.who)}${esc(x.name)}</b> ${time}</span>`;
}
/* the row's state words, as in the status storyboard: working ones without an age, the rest with one. A command that
   runs has its timer, from its start (status.ts commandOf); idle with background work has no age (R8.2, 2026-11-27) */
function rowWord(s) {
  const st = s.state, d = st.detail, n = d.queued;
  if (st.light === "red") return `${esc(st.word)}, ${age(st.since)}`;
  const queued = n ? `, ${esc(n)} message${n > 1 ? "s" : ""} queued` : "";
  if (st.command) return `${esc(st.word)}, ${cmdTimer(st.command)}${queued}`;
  if (st.resting) return esc(st.word);
  if (st.status === "busy") return `${esc(st.word)}${queued}`;
  if (st.status === "compacting") return "Compacting context";
  if (st.status === "retrying") return `${esc(st.word)}${d.retry ? `, ${until(d.retry.at)}` : ""}`;
  if (st.status === "refreshing") return esc(st.word);
  if (st.status === "stale") return `No updates for ${age(st.since)}`;
  return `${esc(st.word)}, ${age(st.since)}`;
}

/* a running command's timer, from its start (ms) */
export const cmdTimer = c => live(new Date(c.since).toISOString(), nowish - c.since);

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
  el.querySelectorAll(".row").forEach(b => { b.onclick = () => { select(b.dataset.id); picked(); }; });
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
