/* Rail: the background work panel (requirements R7.1, R7.2): Main conversation, the running forks,
   subagents, shells and monitors as a tree, To review, and Past. Rebuilt whole on each render; its cards
   tween in and out (tween.js). */
import { store, cur, view, mounted, nowish, agentsOf, agentById, agentMs } from "./state.js";
import { esc, live, took, hhmm } from "./format.js";
import { ind, kind, KG, kindKey, bgMarkKey, sessionMark } from "./marks.js";
import { lineTweens, graceScan, inGrace } from "./tween.js";

export const bgOf = s => s.background || [];
const hasBackground = s => agentsOf(s).length || bgOf(s).length;
export function bgState(b) {
  if (b.status && b.status !== "running") return b.status === "completed" ? "done" : b.status;
  if (b.kind === "monitor" && b.timeout && !b.persistent && new Date(b.start).getTime() + b.timeout < nowish) return "timed out";
  return "running";
}
const bgMs = b => (b.end ? new Date(b.end) : (bgState(b) === "timed out" ? new Date(new Date(b.start).getTime() + b.timeout) : nowish)) - new Date(b.start);
/* the shell or monitor card expanded to its command and summary (one at a time; kept in the UI state) */
export let openBg = null;
export function setOpenBg(key) { openBg = key || null; }
/* every subagent, shell and monitor the panels show, with whether it runs, for the finish grace (tween.js) */
export function scanGrace() {
  graceScan([...store.sessions.values()].flatMap(s => [
    ...agentsOf(s).map(a => [s.id + "|" + a.id, !a.finished]),
    ...bgOf(s).map(b => [s.id + "|" + b.toolUseId, bgState(b) === "running"]),
  ]));
}
/* No Stop row (author, 2026-11-24): it moved the panel when switching subagents. A key comes when it's
   needed; until then a runaway background task ends with its session. */
export function railHTML(s, A) { // exported for the escape test
  if (!hasBackground(s)) return "";
  scanGrace();
  const all = [
    ...agentsOf(s).map(a => ({ key: a.id, agent: a, name: a.description, kind: a.fork ? "fork" : (a.type || "subagent"), start: a.start, end: a.finished ? a.end : null, running: !a.finished, failed: false, st: a.stopped ? "stopped" : "done", ms: agentMs(a) })),
    ...bgOf(s).map(b => { const st = bgState(b); return { key: b.toolUseId, bg: b, name: b.description || b.command, kind: b.kind, start: b.start,
      end: st === "running" ? null : (b.end || new Date(new Date(b.start).getTime() + (b.timeout || 0)).toISOString()), running: st === "running", failed: st === "failed", st, ms: bgMs(b) }; })
  ];
  for (const x of all) x.shown = x.running || inGrace(s.id, x.key); // one that just finished stays in the tree for its grace
  const past = all.filter(x => !x.shown).sort((p, q) => new Date(q.end) - new Date(p.end));
  const KIND_ORDER = { fork: 0, sub: 1, shell: 2, mon: 3 };
  const running = all.filter(x => x.shown).sort((p, q) => (KIND_ORDER[kindKey(p)] - KIND_ORDER[kindKey(q)]) || (new Date(p.start) - new Date(q.start)));
  /* a subagent's own shells and monitors hang under its card; the main thread's (or an orphan's) under Main conversation */
  const parentOf = x => x.bg && x.bg.agentId && running.some(y => y.agent && y.agent.id === x.bg.agentId) ? x.bg.agentId : null;
  const now = running.filter(x => !parentOf(x)), kidsOf = x => x.agent ? running.filter(y => parentOf(y) === x.agent.id) : [];
  const nameOfAgent = id => agentsOf(s).find(a => a.id === id)?.description || "a subagent";
  const attrs = x => x.agent ? `data-agent="${esc(x.agent.id)}" aria-current="${!!(A && A.id === x.agent.id)}"` : `data-bg="${esc(x.key)}" aria-expanded="${openBg === x.key}"`;
  const detail = x => {
    if (openBg !== x.key) return "";
    if (x.agent) return ""; // a subagent's card opens its transcript, nothing expands
    return `<div class="bw-detail">${x.bg.summary ? esc(x.bg.summary) : x.running ? "No report yet." : esc(x.st)}<code>${esc(x.bg.command)}</code></div>`;
  };
  return `<aside class="rail panel" aria-label="Background work" data-sid="${esc(s.id)}">
    <div class="now">
      <button class="main-row" data-back-main data-state="${s.state.light}" aria-current="${!A}">${sessionMark(s)}<b>Main conversation</b><span class="m">${(n => n ? `${n} running in the background` : "Nothing running in the background")(now.filter(x => x.running).length)}</span><span class="w">${esc(s.state.word)}</span></button>
      ${(function kids(xs) { return xs.length ? `<div class="kids">${xs.map(x => { const ks = kidsOf(x); return `<div class="kid${ks.length ? " parent" : ""}" data-line="${esc(x.key)}"><i class="tg"></i><button class="card kc-${kindKey(x)}${x.running ? "" : " ended"}" ${attrs(x)}>${x.running ? ind(bgMarkKey(x)) : `<span class="pm">${ind(bgMarkKey(x))}${ind("s_" + kindKey(x))}</span>`}<span class="n">${esc(x.name)}</span><span class="m"><span class="kw">${esc(KG[kindKey(x)][0])}</span>, started ${hhmm(x.start)}</span><span class="d">${x.running ? live(x.start, x.ms) : took(x.ms)}</span></button>${detail(x)}${kids(ks)}</div>`; }).join("")}</div>` : ""; })(now)}
    </div>
    ${(rv => rv.length ? `<div class="review"><h3>To review <span class="cnt">${rv.length}</span></h3>
      ${rv.map(x => `<div class="rv"><button class="rv-open" ${attrs(x)}>${ind("review")}<span class="n">${esc(x.name.replace(/^for review:\s*/i, ""))}</span><span class="m">${kind(kindKey(x))} finished ${hhmm(x.end)}</span></button>
        <button class="btn quiet rv-done" data-reviewed="${esc(x.agent.id)}">Mark reviewed</button></div>`).join("")}</div>` : "")(past.filter(x => bgMarkKey(x) === "review"))}
    <div class="past" id="past">
      ${past.length ? `<h3>Past <span class="cnt">${past.length}</span></h3>` : ""}
      ${past.filter(x => bgMarkKey(x) !== "review").map(x => `<button class="pr ${x.failed ? "failed" : ""}" ${attrs(x)}><span class="pm">${ind(bgMarkKey(x))}${ind("s_" + kindKey(x))}</span><span class="n">${esc(x.name)}${x.st === "timed out" ? ` <span class="k">timed out</span>` : x.failed ? ` <span class="k">failed</span>` : ""}${x.bg && x.bg.agentId ? ` <span class="in">in ${esc(nameOfAgent(x.bg.agentId))}</span>` : ""}</span><span class="d">${took(x.ms)}</span></button>${detail(x)}`).join("")}
    </div>
  </aside>`;
}
/* running items coming into and leaving the tree tween like the sidebar's sub-lines (tween.js); each child holds
   its own guide, so the guides follow its height on every frame */
const railTw = lineTweens({
  sel: ".kid", groups: el => new Map([[el.dataset.sid, el]]), id: "rail-line", cls: { tw: "tw", gone: "gone" },
  box: (n, h) => ({ open: { height: h, paddingTop: "5.5px" }, shut: { height: "0px", paddingTop: "0px" } }),
  fade: n => [...n.children].filter(c => !c.classList.contains("tg")),
  place: (g, n, after, parent, find) => {
    if (after) { after.after(n); return; }
    const host = parent ? find(parent) : g.querySelector(".now"); if (!host) return;
    let ks = host.querySelector(":scope > .kids");
    if (!ks) { ks = document.createElement("div"); ks.className = "kids"; host.append(ks); }
    ks.prepend(n);
  },
});

export function renderRail() {
  const s = cur(), conv = document.getElementById("conv"); if (!s || !mounted) return;
  const A = view && agentById(s, view);
  const old = conv.querySelector(".rail"), html = railHTML(s, A), before = old ? railTw.snap(old) : new Map();
  if (old && html) old.outerHTML = html; else if (old) old.remove(); else if (html) conv.insertAdjacentHTML("beforeend", html);
  conv.classList.toggle("no-rail", !hasBackground(s));
  const rail = conv.querySelector(".rail"); if (rail) railTw.run(rail, before); // its children tween in and out
}
