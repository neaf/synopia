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
/* the Stop row: stopTask takes the task id (a subagent's is its agent id); shown only while it runs */
const stopping = new Set();
const taskOf = x => x.agent ? x.agent.id : x.bg.taskId;
function stopRow(x) {
  const id = taskOf(x); if (!id) return "";
  const what = { sub: "subagent", fork: "fork", shell: "shell", mon: "monitor" }[kindKey(x)];
  return stopping.has(id) ? `<button class="btn quiet bw-stop" disabled>${ind("stopped")}Stopping</button>`
    : `<button class="btn quiet bw-stop" data-stop="${esc(id)}">${ind("stopped")}Stop this ${what}</button>`;
}
function railHTML(s, A) {
  if (!hasBackground(s)) return "";
  const kindOf = x => x.kind ? x.kind : agentType(x);
  const all = [
    ...agentsOf(s).map(a => ({ key: a.id, agent: a, name: a.description, kind: a.fork ? "fork" : (a.type || "subagent"), start: a.start, end: a.finished ? a.end : null, running: !a.finished, failed: false, st: a.stopped ? "stopped" : "done", ms: agentMs(a) })),
    ...bgOf(s).map(b => { const st = bgState(b); return { key: b.toolUseId, bg: b, name: b.description || b.command, kind: b.kind, start: b.start,
      end: st === "running" ? null : (b.end || new Date(new Date(b.start).getTime() + (b.timeout || 0)).toISOString()), running: st === "running", failed: st === "failed", st, ms: bgMs(b) }; })
  ];
  for (const x of all) if (!x.running && stopping.has(taskOf(x))) stopping.delete(taskOf(x));
  const past = all.filter(x => !x.running).sort((p, q) => new Date(q.end) - new Date(p.end));
  const KIND_ORDER = { fork: 0, sub: 1, shell: 2, mon: 3 };
  const now = all.filter(x => x.running).sort((p, q) => (KIND_ORDER[kindKey(p)] - KIND_ORDER[kindKey(q)]) || (new Date(p.start) - new Date(q.start)));
  const attrs = x => x.agent ? `data-agent="${x.agent.id}" aria-current="${!!(A && A.id === x.agent.id)}"${x.running ? ` aria-expanded="${openBg === x.key}"` : ""}` : `data-bg="${x.key}" aria-expanded="${openBg === x.key}"`;
  const detail = x => {
    if (openBg !== x.key) return "";
    if (x.agent) return x.running ? `<div class="bw-detail">${stopRow(x)}</div>` : "";
    return `<div class="bw-detail">${x.bg.summary ? esc(x.bg.summary) : x.running ? "No report yet." : esc(x.st)}<code>${esc(x.bg.command)}</code>${x.running ? stopRow(x) : ""}</div>`;
  };
  const label = { shell: "shell", monitor: "monitor", fork: "fork", "general-purpose": "subagent", Explore: "explore", Plan: "plan" };
  return `<aside class="rail panel" aria-label="Background work">
    <button class="main-row" data-back-main data-state="${stateOf(s)}" aria-current="${!A}">${sessionMark(s)}<b>Main conversation</b><span class="m">${esc(WORD[stateOf(s)])}</span></button>
    ${(rv => rv.length ? `<div class="review"><h3>To review <span class="cnt">${rv.length}</span></h3>
      ${rv.map(x => `<div class="rv"><button class="rv-open" ${attrs(x)}>${ind("review")}<span class="n">${esc(x.name.replace(/^for review:\s*/i, ""))}</span><span class="m">${kind(kindKey(x))} finished ${hhmm(x.end)}</span></button>
        <button class="btn quiet rv-done" data-reviewed="${x.agent.id}">Mark reviewed</button></div>`).join("")}</div>` : "")(past.filter(x => bgMarkKey(x) === "review"))}
    <div class="now">
      <h3>Running <span class="cnt">${now.length ? `${now.length} in the background` : ""}</span></h3>
      ${now.length ? now.map(x => `<button class="card kc-${kindKey(x)}" ${attrs(x)}>${ind(bgMarkKey(x))}<span class="n">${esc(x.name)}</span><span class="m"><span class="kw">${esc(KG[kindKey(x)][0])}</span>, started ${hhmm(x.start)}</span><span class="d">${live(x.start, x.ms)}</span></button>${detail(x)}`).join("") : `<p class="none">Nothing running in the background.</p>`}
    </div>
    <div class="past" id="past">
      ${past.length ? `<h3>Past <span class="cnt">${past.length}</span></h3>` : ""}
      ${past.filter(x => bgMarkKey(x) !== "review").map(x => `<button class="pr ${x.failed ? "failed" : ""}" ${attrs(x)}><span class="pm">${ind(bgMarkKey(x))}${ind("s_" + kindKey(x))}</span><span class="n">${esc(x.name)}${x.st === "timed out" ? ` <span class="k">timed out</span>` : x.failed ? ` <span class="k">failed</span>` : ""}</span><span class="d">${took(x.ms)}</span></button>${detail(x)}`).join("")}
    </div>
  </aside>`;
}
