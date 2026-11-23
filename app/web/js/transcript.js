/* Transcript: tool lines, files changed, subagent waves, the items, the status lines and renderConv (split from prototype/app.html). */
/* ---------- conversation, rendered like the CLI ---------- */
function took(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = ts => new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

function toolLine(t) {
  const res = t.state === "failed" ? `<div class="res failed"><span class="lcorner" aria-hidden="true"></span><span>Failed</span></div>`
    : t.state === "stopped" ? `<div class="res"><span class="lcorner" aria-hidden="true"></span><span>Stopped</span></div>`
    : t.state === "running" ? `<div class="res"><span class="lcorner" aria-hidden="true"></span><span>Running${t.name === "Agent" || t.name === "Task" ? " in the background" : ""}</span></div>` : "";
  const line = `<span class="name">${esc(toolName(t))}</span>${t.obj ? `(${esc(t.obj)})` : ""}${res}`;
  return `<div class="ln tool ${esc(t.state)}"><span class="g">●</span>${hasStep(t) ? `<details class="step"${stepOpen(t)}><summary>${line}</summary>${stepHTML(t)}</details>` : `<div>${line}</div>`}</div>`;
}

/* ---------- a step, expanded (R5.6): its command or input, then its result under ⎿ ----------
   The page has the result's first 20 lines (4 KB at most); "Show all" asks the server for the rest
   (`toolOutput`), which reads it again from the transcript file. Open steps are kept by item id. */
const openSteps = new Set(), fullOut = new Map();
let stepAsked = null; // the step whose full result was asked for, until the reply (or a toast)
const stepKey = id => `${current}|${view || ""}|${id}`;
const hasStep = t => !!(t.input || t.out);
const stepOpen = t => openSteps.has(stepKey(t.id)) ? ` open data-step="${esc(t.id)}"` : ` data-step="${esc(t.id)}"`;
function stepHTML(t) {
  const o = t.out, full = fullOut.get(stepKey(t.id));
  const text = full !== undefined ? full : o ? o.text : "";
  const cmd = t.input ? `<div class="cmd">${esc(t.input)}</div>` : "";
  const res = !o ? "" : text ? `<div class="res"><span class="lcorner" aria-hidden="true"></span><span class="out">${esc(text)}</span></div>`
    : `<div class="res"><span class="lcorner" aria-hidden="true"></span><span>No output</span></div>`;
  const more = o && o.cut && full === undefined ? `<p class="earlier more"><button data-full="${esc(t.id)}">Show all ${+o.lines} lines</button></p>` : "";
  const stop = o && o.interrupted ? `<div class="res"><span></span><span>Interrupted</span></div>` : "";
  return `<div class="step-out">${cmd}${res}${more}${stop}</div>`;
}
function showAll(id) {
  const key = stepKey(id); if (stepAsked === key) return;
  stepAsked = key; send({ t: "toolOutput", sid: current, agent: view || null, toolUseId: id });
}
function applyToolOutput(m) {
  const key = `${m.sid}|${m.agent || ""}|${m.toolUseId}`;
  if (stepAsked === key) stepAsked = null;
  fullOut.set(key, String(m.text ?? ""));
  if (isViewed(m.sid, m.agent)) renderLog();
}
function toolsHTML(run) {
  if (run.length === 1) return toolLine(run[0]);
  const counts = {}; run.forEach(t => counts[t.verb] = (counts[t.verb] || 0) + 1);
  const label = { Plan: n => `showed ${n} plans`, "Loaded tools": n => "loaded tools", Ran: n => `${n} Bash commands`, Read: n => `read ${n} files`, Edited: n => `edited ${n} files`, Wrote: n => `wrote ${n} files`,
    Searched: n => `searched ${n} times`, Subagent: n => `started ${n} subagents`, Fetched: n => `fetched ${n} pages`, Skill: n => `used ${n} skills`, Watched: n => `started ${n} monitors` };
  const one = { Plan: "showed a plan", "Loaded tools": "loaded tools", Ran: "1 Bash command", Read: "read 1 file", Edited: "edited 1 file", Wrote: "wrote 1 file", Searched: "searched once", Subagent: "started 1 subagent", Fetched: "fetched 1 page", Skill: "used 1 skill", Watched: "started 1 monitor" };
  let text = Object.entries(counts).map(([v, n]) => n === 1 ? (one[v] || `used ${v} once`) : (label[v] || (n => `used ${v} ${n} times`))(n)).join(", ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const fails = run.filter(t => t.state === "failed").length, running = run.filter(t => t.state === "running").length;
  const cls = fails ? "failed" : "";
  return `<div class="ln tool ${cls}"><span class="g">●</span><details class="fold"><summary><span class="name">${esc(text)}</span>${fails ? ` <span style="color:var(--red)">${fails} failed</span>` : ""}${running ? ` <span style="color:var(--green)">${running} running</span>` : ""} <span class="hint">(click to expand)</span></summary>
    <div class="body">${run.map(t => {
      const row = `<span class="lcorner" aria-hidden="true"></span><span><span class="name" style="font-weight:400;color:inherit">${esc(toolName(t))}</span>${t.obj ? `(${esc(t.obj)})` : ""}${t.state === "failed" ? ", failed" : t.state === "stopped" ? ", stopped" : t.state === "running" ? ", running" : ""}</span>`, cls = `res ${t.state === "failed" ? "failed" : ""}`;
      return hasStep(t) ? `<details class="step"${stepOpen(t)}><summary class="${cls}">${row}</summary>${stepHTML(t)}</details>` : `<div class="${cls}">${row}</div>`;
    }).join("")}</div></details></div>`;
}

/* a step's display name: the tool's Claude Code CLI name, as in the terminal; MCP tools read "server tool" */
function toolName(t) { return t.name && !t.name.startsWith("mcp__") ? (t.name === "Task" ? "Agent" : t.name) : t.verb; }
/* ---------- files changed ---------- */
function splitPath(f) {
  const m = f.match(/^(~\/dev\/[^/]+\/\.claude\/worktrees\/[^/]+)\/(.*)$/) || f.match(/^(~\/dev\/[^/]+)\/(.*)$/) || f.match(/^(~\/\.claude\/[^/]+(?:\/[^/]+)?)\/([^/]+)$/) || f.match(/^(.*)\/([^/]+)$/);
  return m ? [m[1], m[2]] : ["", f];
}
function diffHTML(p) {
  const out = [];
  p.hunks.forEach((h, hi) => {
    if (hi) out.push(`<div class="dgap">⋯</div>`);
    let o = h.o, n = h.n;
    for (const l of h.lines) {
      const sg = l[0], txt = esc(l.slice(1));
      if (sg === "+") out.push(`<div class="dl a"><span class="no">${n++}</span><span class="sg">+</span><span>${txt}</span></div>`);
      else if (sg === "-") out.push(`<div class="dl d"><span class="no">${o++}</span><span class="sg">-</span><span>${txt}</span></div>`);
      else { out.push(`<div class="dl c"><span class="no">${n}</span><span class="sg"> </span><span>${txt}</span></div>`); o++; n++; }
    }
  });
  if (p.cut) out.push(`<div class="dgap">⋯ diff cut at 400 lines</div>`);
  return out.join("");
}
/* files a browser can show get an "open" link; the live app would open any file with its default app */
const OPENABLE = /\.(html?|svg|png|jpe?g|gif|webp|pdf)$/i;
const absOf = f => f.list.find(p => p.abs)?.abs || "";
const openable = f => absOf(f).startsWith("/");
const fileUrl = f => "file://" + absOf(f).split("/").map(encodeURIComponent).join("/");
/* patches: an Edit's or Write's, and those of a Bash command (bashEditDiff). A bare one is a file the
   shell changed with no diff: its path shows without counts. more: files the shell changed past its list. */
function filesHTML(patches, key, more = 0) { // key: stable diff ids, so an open diff stays open when the block is redrawn
  let fileSeq = 0;
  more = Math.max(0, +more || 0);
  if (!patches.length && !more) return "";
  const byFile = new Map();
  for (const p of patches) {
    const f = byFile.get(p.file) || { file: p.file, add: 0, del: 0, created: false, list: [] };
    f.add += p.add; f.del += p.del; f.created = f.created || p.created; f.list.push(p); byFile.set(p.file, f);
  }
  const roots = new Map();
  for (const f of byFile.values()) { const [r, rel] = splitPath(f.file); (roots.get(r) || roots.set(r, []).get(r)).push({ ...f, rel }); }
  const total = byFile.size + more;
  let body = "";
  for (const [root, files] of roots) {
    body += `<div class="root">${esc(root)}</div><div class="flist">`;
    for (const f of files) {
      const id = esc(`diff-${key}-${fileSeq++}`), diffs = f.list.filter(p => !p.bare);
      body += `<div class="frow"><span class="lcorner" aria-hidden="true"></span><a class="fp" href="${esc(fileUrl(f))}" data-path="${esc(absOf(f))}" target="_blank" rel="noreferrer" title="Open ${esc(f.file)}">${esc(f.rel)}</a>
        ${diffs.length ? `<button class="fc" aria-expanded="false" aria-controls="${id}" title="Show the diff">${f.created ? `<span class="new">new </span>` : ""}<span class="add">+${f.add}</span> <span class="del">−${f.del}</span></button></div>
        <div class="diff" id="${id}" hidden>${diffs.map(diffHTML).join(`<div class="dgap">⋯ next edit</div>`)}</div>` : `<span></span></div>`}`;
    }
    body += `</div>`;
  }
  if (more) body += `<div class="root">and ${more} more file${more > 1 ? "s" : ""}</div>`;
  return `<div class="ln tool files"><span class="g">●</span><div><span class="name">Files changed</span> <span class="dim">${total} file${total > 1 ? "s" : ""}, click one to see the diff</span>${body}</div></div>`;
}

/* ---------- subagents ---------- */
const LOADED = Date.now();
const BASE = window.EXPORTED_AT || LOADED;
let NOWISH = Date.now();
const liveNow = () => Date.now();
function tookLive(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}
const live = (startIso, ms) => `<span data-live="${esc(startIso)}">${tookLive(ms)}</span>`;
let view = null; // null = the session; otherwise an agent id inside the current session
const agentsOf = s => s.agents || [];
const agentById = (s, id) => agentsOf(s).find(a => a.id === id);
const agentByTool = (s, tid) => agentsOf(s).find(a => a.toolUseId === tid);
const agentMs = a => a.start ? (a.finished ? new Date(a.end) : NOWISH) - new Date(a.start) : 0;
const agentType = a => a.fork ? "fork" : (a.type || "agent");
function waveHTML(tools, s) {
  const rows = tools.map(t => ({ t, a: agentByTool(s, t.toolUseId) }));
  const markOf = a => !a ? "done" : !a.finished ? (a.fork ? "k_fork" : "k_sub") : (isReview(a) && !reviewed.has(a.id)) ? "review" : (a.fork ? "s_fork" : "s_sub");
  const nameOf = (t, a) => a ? `<button class="alink" data-agent="${esc(a.id)}" title="Open this ${a.fork ? "fork" : "subagent"}'s transcript">${esc(a.description)}</button>` : `<span>${esc(t.obj)}</span>`;
  const time = a => a ? (a.finished ? took(agentMs(a)) : live(a.start, agentMs(a))) : "";
  if (rows.length === 1) {
    const { t, a } = rows[0];
    return `<div class="ln agent one"><span class="g">${ind(markOf(a))}</span><div>${nameOf(t, a)} <span class="adur">${time(a)}</span></div></div>`;
  }
  const ms = rows.map(r => r.a ? agentMs(r.a) : 0);
  const t0 = Math.min(...rows.map(r => r.a?.start ? +new Date(r.a.start) : Infinity));
  const tEnd = Math.max(...rows.map((r, i) => r.a?.start ? +new Date(r.a.start) + ms[i] : 0));
  const span = Math.max(1, tEnd - t0);
  const forks = rows.every(r => r.a?.fork);
  const parallel = rows.every(r => r.a) && Math.max(...rows.map(r => +new Date(r.a.start))) - t0 < 120000;
  return `<div class="ln agent wave"><span class="g"></span><div><span class="name">${rows.length} ${forks ? "forks" : "subagents"}${parallel ? " in parallel" : ""}</span>
    <div class="wgrid">${rows.map(({ t, a }, i) => {
      const st = !a ? "unknown" : a.finished ? "done" : "running";
      const left = a?.start ? (new Date(a.start) - t0) / span * 100 : 0, width = Math.max(2, ms[i] / span * 100);
      return `${ind(markOf(a))}${nameOf(t, a)}<span class="bar st-${st}"><i style="left:${left}%;width:${width}%"></i></span><span class="adur">${time(a)}</span>`;
    }).join("")}</div></div></div>`;
}


/* The log as keyed blocks: [key, html], one root element each. Keys come from item ids, so renderLog
   can keep the blocks that didn't change and replace the ones that did. */
function itemsHTML(items, sessionBusy, s) {
  const out = []; let run = []; let turnStart = null; let turnKey = null; let turnMs = null; let lastTs = null; let lastDay = null; let turnPatches = []; let waiting = false;
  const flush = () => {
    if (!run.length) return;
    const agents = run.filter(t => t.name === "Agent" || t.name === "Task"), other = run.filter(t => !(t.name === "Agent" || t.name === "Task"));
    if (other.length) out.push([`run:${other[0].id}`, toolsHTML(other)]);
    if (agents.length) out.push([`wave:${agents[0].id}`, waveHTML(agents, s)]);
    run = [];
  };
  const flushFiles = () => { flush(); if (turnPatches.length) { const key = turnPatches[0].id; out.push([`files:${key}`, filesHTML(turnPatches.flatMap(t => t.patches || [t.patch]), key, turnPatches.reduce((n, t) => n + (+t.moreFiles || 0), 0))]); } turnPatches = []; };
  const endTurn = () => { flushFiles(); if (turnStart && lastTs && (turnMs || new Date(lastTs) > new Date(turnStart))) out.push([`done:${turnKey}`, `<div class="ln doneln"><span class="g">${ind("s_agent")}</span><div>Worked for ${took(turnMs || new Date(lastTs) - new Date(turnStart))}, done ${hhmm(lastTs)}</div></div>`]); };
  const prompt = (html, ts, key) => {
    flush(); endTurn();
    if (ts && day(ts) !== lastDay) { out.push([`day:${key}`, `<div class="done">${day(ts)}</div>`]); lastDay = day(ts); }
    out.push([`you:${key}`, `<div class="prompt"><span class="g">❯</span><div class="md">${html}</div></div>`]); turnStart = ts; turnKey = key; turnMs = null;
  };
  for (const it of items) {
    /* your answer to a permission or plan card shows as your turn, before the tool it let run (R6.7) */
    if (it.k === "tool" && it.answer) { prompt(esc(it.answer), it.ts, `ans:${it.id}`); lastTs = it.ts; }
    /* a plan whose process ended before you answered (plan section 7) */
    if (it.k === "tool" && it.name === "ExitPlanMode" && it.state === "running" && !sessionBusy) { flush(); out.push([`na:${it.id}`, notAnswered()]); continue; }
    if (it.k === "tool") { run.push(it); if (it.patch || it.patches) turnPatches.push(it); if (it.ts) lastTs = it.ts; continue; }
    if (it.k === "you") { prompt(`${it.images ? `<p class="img">[${it.images} pasted image${it.images > 1 ? "s" : ""}]</p>` : ""}${md(it.text)}`, it.ts, it.id); turnMs = it.workedMs || null; lastTs = it.ts; continue; }
    flush();
    if (it.k === "claude") out.push([it.id, `<div class="ln claude"><span class="g">●</span><div class="md">${md(it.text)}</div></div>`]);
    else if (it.k === "report") {
      const a = s && agentById(s, it.agent);
      out.push([it.id, `<div class="ln agent"><span class="g">${a ? ind(isReview(a) && !reviewed.has(a.id) ? "review" : a.fork ? "s_fork" : "s_sub") : "●"}</span><details class="fold"><summary><span class="name">Report from ${a ? esc(a.description) : "a subagent"}</span>${a ? ` <span class="dim">${took(agentMs(a))}</span>` : ""} <span class="hint">(click to read)</span></summary><div class="body md">${md(it.text)}</div>${a ? `<p><button class="alink" data-agent="${esc(a.id)}">Open its transcript</button></p>` : ""}</details></div>`]);
    } else if (it.k === "ask" && it.state === "pending" && (it.request || sessionBusy)) {
      flushFiles();
      out.push([`wait:${it.id}`, `<div class="ln waitln"><span class="g">${ind("pause")}</span><div><b>Waiting for you:</b> <span class="dim">${it.kind === "permission" ? (it.request.toolName === "Bash" ? `permission to run ${esc(it.cmd || "a command")}` : `permission to use ${esc(it.request.toolName)} on ${esc(it.cmd)}`) : it.kind === "plan" ? "your approval of the plan above" : `${it.qs.length === 1 ? "a question" : `${it.qs.length} questions`} from Claude`}, in the message panel</span></div></div>`]);
      waiting = true; continue;
    } else if (it.k === "ask") {
      const picked = it.kind ? [answerText(it)] : parseAnswers(it.answer);
      out.push([it.id, `<div class="ln ask"><span class="g">●</span><div>${it.qs.map((q, qi) => `<div class="md" style="margin-bottom:.4em">${md(q.q)}</div>
        <div style="margin-bottom:.85em">${q.opts.map(([l], oi) => `<div class="opt-line ${picked[qi] === l ? "picked" : ""}">${picked[qi] === l ? "❯" : " "} ${oi + 1}. ${esc(l)}</div>`).join("")}</div>`).join("")}</div></div>`]);
      if (it.state === "pending") { out.push([`na:${it.id}`, notAnswered()]); continue; }
      if (it.state === "answered") {
        const notes = it.kind ? [] : parseNotes(it.answer); // your note on an answer stays visible (R6.4)
        const txt = picked.length ? picked.map((p, i) => `<p>${it.qs.length > 1 ? `${i + 1}. ` : ""}${esc(p)}${notes[i] ? `<span class="dim">, note: ${esc(notes[i])}</span>` : ""}</p>`).join("") : md(it.answer);
        lastTs = it.ts; prompt(txt, it.ts, `ans:${it.id}`); continue;
      }
    }
    if (it.ts) lastTs = it.ts;
  }
  flush();
  if (waiting) flushFiles(); else if (!sessionBusy) endTurn(); else flushFiles();
  return out;
}
const notAnswered = () => `<div class="ln"><span class="g dim">○</span><div class="dim">Not answered (Synopia quit)</div></div>`;
/* messages sent while a card waits: held behind it, sent once you answer */
const heldHTML = s => (s.held || []).map((t, i) => [`held:${i}:${t.length}`, `<div class="prompt"><span class="g">❯</span><div class="md">${md(t)}<p class="dim">Queued until you answer the card above</p></div></div>`]);
/* the "working" line closes the transcript, like the CLI's spinner line. Inside a turn it can read
   compacting, rate limited or no updates instead, and say a message you sent is queued. */
function liveLine(s, A) {
  const line = (mark, t, word = "Working", extra = "") => `<div class="ln liveln" data-state="${A ? "green" : toneOf(s)}"><span class="g">${ind(mark)}</span><div><b>${esc(word)}</b> <span class="dim">${extra || (t ? `${esc(toolName(t))}${t.obj ? `(${esc(t.obj)})` : ""}` : "")}</span></div></div>`;
  if (A) return A.finished ? "" : line(A.fork ? "k_fork" : "k_sub", (A.items || []).filter(x => x.k === "tool").pop());
  if (stateOf(s) !== "green") return "";
  const t = [...s.items].reverse().find(x => x.k === "tool");
  return s.status === "busy" ? line(sessionMarkKey(s), t, "Working", phaseText(s)) : line(sessionMarkKey(s), t, wordOf(s), phaseText(s));
}
/* what the state means, after its word (status.ts: the source of each) */
function phaseText(s) {
  const d = s.statusDetail || {};
  if (s.status === "compacting") return "Summing up the conversation to free space";
  if (s.status === "retrying") return d.retry ? `Retrying ${until(d.retry.at)}, attempt ${esc(d.retry.attempt)}${d.retry.max ? ` of ${esc(d.retry.max)}` : ""}` : "Retrying by itself";
  if (s.status === "stale") return `Nothing for ${age(s.statusAt)}; the session may be gone`;
  if (s.status === "signedout") return "Your sign-in expired. Sign in again (aws sso login on Bedrock), then send a message";
  if (s.status === "busy" && d.queued) return queuedText(d.queued);
  return "";
}
/* an age that the 1 s timer keeps current */
const age = ms => `<span data-age="${esc(ms)}">${dur(ms)}</span>`;
/* a countdown to a time (the rate-limit retry) that the same timer keeps current: "in 38s", then "now" */
const left = at => { const s = Math.round((at - Date.now()) / 1000); return s > 0 ? `in ${s}s` : "now"; };
const until = at => `<span data-until="${esc(at)}">${esc(left(at))}</span>`;
const queuedText = n => `${n === 1 ? "Your message is" : `${esc(n)} messages are`} queued and ${n === 1 ? "goes" : "go"} to Claude at its next step`;
function statusLine(s) {
  const st = stateOf(s);
  const last = [...s.items].reverse();
  if (st === "green") {
    const t = last.find(x => x.k === "tool");
    return `<div class="status" data-state="green"><b>${ind("work")} Working</b><span>${t ? `${esc(toolName(t))}${t.obj ? `(${esc(t.obj)})` : ""}` : ""}</span></div>`;
  }
  if (s.status === "signedout" && st !== "red") return `<div class="status" data-state="red"><b>${ind("creds")} Signed out</b><span>${phaseText(s)}</span></div>`;
  if (st === "red") {
    const why = { plan: "Claude wrote a plan and is waiting for your approval", question: "Claude is asking you something" }[pending(s)] || "Claude is waiting for a permission";
    return `<div class="status" data-state="red"><b>${ind("pause")} Needs you</b><span>${why}, for ${age(s.statusAt)}</span></div>`;
  }
  const w = wordOf(s), why = w === "Failed" ? `The last turn failed ${age(s.statusAt)} ago. Send a message to try again` : w === "Stopped" ? "You interrupted it" : `Claude finished ${age(s.statusAt)} ago`;
  return `<div class="status" data-state="amber"><b>${sessionMark(s)} ${w}</b><span>${why}${bgRunning(s) ? ", background work still running" : ""}</span></div>`;
}

/* ---------- the session view, rendered per panel: header, log, card (in the dock), rail ---------- */
const conv = document.getElementById("conv");
const cur = () => store.sessions.get(current);
let mounted = null; // "<sid>|<agent id>" of the view on screen
/* Builds the view's frame when the session or the subagent changed (the composer is made here, once
   per view, so data never resets typing, focus or attachments), then renders every panel. */
function renderConv() {
  const s = cur();
  if (!s) {
    mounted = null;
    conv.innerHTML = `<div class="missing"><p>${store.ui.connected ? "No open sessions." : "Connecting to the Synopia backend…"}</p></div>`;
    return;
  }
  if (view && !agentById(s, view)) view = null;
  const key = `${s.id}|${view || ""}`;
  if (mounted !== key) {
    mounted = key;
    conv.innerHTML = `
    <header class="c-head panel"></header>
    <div class="log panel" id="log"><div class="log-inner"></div></div>
    <div class="dock panel"><div class="dock-inner">
      <div class="composer"><div class="slash" id="slash" role="listbox" hidden></div>
        <div class="attach" style="grid-column:2"></div>
        <span class="g">❯</span><textarea id="msg" rows="1" aria-label="Message"></textarea>
      </div>
    </div></div>`;
    lastCard = null;
    mountComposer(s);
    requestView(s.id, view);
  }
  renderHeader(); renderLog(); renderCard(); renderRail();
}
function renderHeader() {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view);
  conv.querySelector(".c-head").innerHTML = A
    ? `<p class="c-crumb"><button class="link" data-back>‹ ${esc(s.title)}</button></p>
        <h2 class="c-title">${esc(A.description)}</h2>
        <p class="c-now">${A.finished ? `${A.stopped ? "Stopped" : "Finished"}, ${took(agentMs(A))}` : `Running, ${live(A.start, agentMs(A))}`}. ${esc(agentType(A))}${A.model ? `, model ${esc(A.model)}` : ""}${A.fork ? ", started with a copy of the session's context" : ""}</p>
        <p class="c-meta">Subagent of “${esc(s.title)}”. Its report goes back to that session.</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelName())}</button></div>`
    : `<h2 class="c-title">${esc(s.title)}</h2>
        ${isEmpty(s) || !s.now ? "" : `<p class="c-now">Now: ${esc(s.now)}</p>`}
        <p class="c-meta">Folder <span class="mono">${esc(s.cwd)}</span>${s.prs.length ? `, PRs ${s.prs.slice(-4).map(p => `#${esc(p)}`).join(" ")}` : ""}.${s.name ? ` Tab “${esc(s.name)}”.` : ""}</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelName())}</button><button class="btn" data-close>Close session</button></div>`;
  /* the subagent view's composer still sends to the main conversation, so it names the session */
  document.getElementById("msg").placeholder = `Message ${s.title}, / for commands`;
}
/* a new session before its first turn: the header has the title and folder, the transcript nothing yet */
const isEmpty = s => !s.total && !s.items.length && !s.stream && !s.now;
function logEntries(s, A) {
  const items = A ? (A.items || []) : withPending(s.items, requestsOf(s));
  const hidden = A ? (A.total || 0) - (A.items || []).length : s.total - s.items.length;
  const out = [];
  if (hidden > 0) out.push(["earlier", earlierHTML(hidden)]);
  out.push(...itemsHTML(items, A ? !A.finished : stateOf(s) === "green", s));
  if (!A) out.push(...heldHTML(s));
  if (!A && s.stream) out.push(["stream", `<div class="ln claude"><span class="g">●</span><div class="md">${md(s.stream)}</div></div>`]);
  out.push(["live", liveLine(s, A)]);
  return out;
}
/* Earlier items: the server sends the page's last 160; the link asks for the 160 before the oldest
   shown (`earlier`, plan section 5), and they come back as `items` with `prepend`. */
const EARLIER = 160;
let earlierAsked = null; // "<sid>|<agent>|<before>" until its reply, so a second click sends nothing
const earlierHTML = hidden => `<p class="earlier"><button data-earlier>Show ${Math.min(EARLIER, +hidden)} earlier</button>${hidden > EARLIER ? ` (${+hidden} more)` : ""}</p>`;
function loadEarlier() {
  const s = cur(); if (!s || !mounted) return false;
  const A = view && agentById(s, view), t = A || s, items = t.items || [];
  if (!items.length || (t.total || 0) <= items.length) return false;
  const key = `${s.id}|${view || ""}|${items[0].id}`;
  if (earlierAsked !== key) { earlierAsked = key; send({ t: "earlier", sid: s.id, agent: view || null, before: items[0].id }); }
  return true;
}
/* Renders the log after a prepend so the block you were reading stays where it was on screen. */
function renderLogKeepingPlace() {
  earlierAsked = null;
  const log = document.getElementById("log"); if (!log) return renderLog();
  const inner = log.querySelector(".log-inner"), top = log.getBoundingClientRect().top;
  // a day separator's key moves with the first item of its day, so the anchor is an item's block
  const anchor = [...inner.children].find(el => !/^(earlier|day:)/.test(el.dataset.key) && el.getBoundingClientRect().bottom > top);
  const key = anchor?.dataset.key, off = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const height = log.scrollHeight, was = log.scrollTop;
  renderLog();
  const el = key && [...inner.children].find(c => c.dataset.key === key);
  if (el) log.scrollTop += el.getBoundingClientRect().top - top - off;
  else log.scrollTop = was + log.scrollHeight - height; // the block was regrouped: keep the distance from the end
}
/* Appends new blocks and replaces changed ones by key; keeps the scroll at the bottom when it was within 40 px of it. */
function renderLog() {
  const s = cur(); if (!s || !mounted) return;
  const log = document.getElementById("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  patchChildren(log.querySelector(".log-inner"), logEntries(s, view && agentById(s, view)));
  if (atBottom) log.scrollTop = log.scrollHeight;
}
/* live times tick in place, so they don't count as a change */
const still = html => html.replace(/(<span data-(?:live|age)="[^"]*">)[^<]*/g, "$1").replace(/(class="bar st-running"><i style=")[^"]*/g, "$1");
function patchChildren(parent, entries) {
  const old = new Map([...parent.children].map(el => [el.dataset.key, el]));
  const seen = new Set(); let prev = null;
  for (const [key, html] of entries) {
    if (!html) continue;
    let k = key, n = 1; while (seen.has(k)) k = `${key}#${n++}`;
    seen.add(k);
    let el = old.get(k); const sig = still(html);
    if (!el || el._sig !== sig) {
      const tpl = document.createElement("template"); tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild; fresh.dataset.key = k; fresh._sig = sig;
      if (el) { carryState(el, fresh); el.replaceWith(fresh); }
      el = fresh;
    }
    const want = prev ? prev.nextElementSibling : parent.firstElementChild;
    if (want !== el) parent.insertBefore(el, want);
    prev = el;
  }
  for (const [k, el] of old) if (!seen.has(k)) el.remove();
}
/* open <details> (by position) and expanded diffs (by id) survive a redraw of their block; steps
   carry their own open state (openSteps, by item id) */
function carryState(from, to) {
  const was = [...from.querySelectorAll("details:not([data-step])")], now = [...to.querySelectorAll("details:not([data-step])")];
  was.forEach((d, i) => { if (now[i]) now[i].open = d.open; });
  from.querySelectorAll(".diff:not([hidden])").forEach(d => {
    const n = to.querySelector(`#${CSS.escape(d.id)}`); if (!n) return;
    n.hidden = false; to.querySelector(`[aria-controls="${CSS.escape(d.id)}"]`)?.setAttribute("aria-expanded", "true");
  });
}
function renderRail() {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view);
  const old = conv.querySelector(".rail"), html = railHTML(s, A);
  if (old && html) old.outerHTML = html; else if (old) old.remove(); else if (html) conv.insertAdjacentHTML("beforeend", html);
  conv.classList.toggle("no-rail", !hasBackground(s));
}

/* one click handler for the whole view, so redrawn panels need no rebinding */
conv.addEventListener("click", e => {
  const t = e.target.closest(".frow .fc, [data-earlier], [data-full], [data-agent],[data-back], [data-back-main], [data-reviewed], [data-bg], [data-stop], [data-close], [data-unattach], #model-label");
  if (!t || t.closest(".qa-card")) return;
  if (t.hasAttribute("data-earlier")) loadEarlier();
  else if (t.dataset.full) showAll(t.dataset.full);
  else if (t.matches(".fc")) {
    const d = document.getElementById(t.getAttribute("aria-controls")); d.hidden = !d.hidden; t.setAttribute("aria-expanded", !d.hidden);
  } else if (t.dataset.agent) {
    e.preventDefault(); e.stopPropagation();
    /* a running subagent's card opens its transcript and expands, like a shell's, to show its Stop row */
    if (t.matches(".rail .card")) openBg = view === t.dataset.agent && openBg === t.dataset.agent ? null : t.dataset.agent;
    view = t.dataset.agent; renderConv();
  }
  else if (t.dataset.stop) { stopping.add(t.dataset.stop); send({ t: "stopTask", sid: current, taskId: t.dataset.stop }); renderRail(); }
  else if (t.hasAttribute("data-back") || t.hasAttribute("data-back-main")) { view = null; renderConv(); }
  else if (t.dataset.reviewed) { e.stopPropagation(); reviewed.add(t.dataset.reviewed); send({ t: "reviewed", agentId: t.dataset.reviewed }); renderAll(); }
  else if (t.dataset.bg) { openBg = openBg === t.dataset.bg ? null : t.dataset.bg; renderRail(); }
  else if (t.hasAttribute("data-close")) closeSession(cur());
  else if (t.dataset.unattach) { attachments.splice(+t.dataset.unattach, 1); renderAttachments(); }
  else if (t.id === "model-label") openModelPicker();
});
/* a step opened or closed by a click: remembered by item id, so a redraw keeps it (toggle doesn't bubble) */
conv.addEventListener("toggle", e => {
  const d = e.target; if (!d.dataset || !d.dataset.step) return;
  if (d.open) openSteps.add(stepKey(d.dataset.step)); else openSteps.delete(stepKey(d.dataset.step));
}, true);
/* the page never navigates: a file goes to the backend as `open` with its path, a link with its URL
   (plan section 2), so the app and Chrome behave the same */
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest("a[href]"); if (!a) return;
  e.preventDefault();
  if (a.dataset.path) send({ t: "open", path: a.dataset.path });
  else if (/^https?:/i.test(a.getAttribute("href"))) send({ t: "open", url: a.href });
}, true);
