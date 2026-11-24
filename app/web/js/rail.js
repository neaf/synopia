/* Rail: the background work panel (split from prototype/app.html). */
/* ---------- background work: forks, subagents, shells, monitors ---------- */
const bgOf = s => s.background || [];
const hasBackground = s => agentsOf(s).length || bgOf(s).length;
function bgState(b) {
  if (b.status && b.status !== "running") return b.status === "completed" ? "done" : b.status;
  if (b.kind === "monitor" && b.timeout && !b.persistent && new Date(b.start).getTime() + b.timeout < NOWISH) return "timed out";
  return "running";
}
const bgMs = b => (b.end ? new Date(b.end) : (bgState(b) === "timed out" ? new Date(new Date(b.start).getTime() + b.timeout) : NOWISH)) - new Date(b.start);
let openBg = null;
/* No Stop row (author, 2026-11-24): it moved the panel when switching subagents. A key comes when it's
   needed; until then a runaway background task ends with its session. */
function railHTML(s, A) {
  if (!hasBackground(s)) return "";
  graceScan();
  const kindOf = x => x.kind ? x.kind : agentType(x);
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
  const label = { shell: "shell", monitor: "monitor", fork: "fork", "general-purpose": "subagent", Explore: "explore", Plan: "plan" };
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
