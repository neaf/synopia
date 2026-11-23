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
  const res = t.state === "failed" ? `<div class="res failed"><span>⎿</span><span>Failed</span></div>`
    : t.state === "running" ? `<div class="res"><span>⎿</span><span>Running${t.name === "Agent" || t.name === "Task" ? " in the background" : ""}</span></div>` : "";
  return `<div class="ln tool ${t.state}"><span class="g">●</span><div><span class="name">${esc(t.verb)}</span>${t.obj ? `(${esc(t.obj)})` : ""}${res}</div></div>`;
}
function toolsHTML(run) {
  if (run.length === 1) return toolLine(run[0]);
  const counts = {}; run.forEach(t => counts[t.verb] = (counts[t.verb] || 0) + 1);
  const label = { Plan: n => `showed ${n} plans`, "Loaded tools": n => "loaded tools", Ran: n => `ran ${n} commands`, Read: n => `read ${n} files`, Edited: n => `edited ${n} files`, Wrote: n => `wrote ${n} files`,
    Searched: n => `searched ${n} times`, Subagent: n => `started ${n} subagents`, Fetched: n => `fetched ${n} pages`, Skill: n => `used ${n} skills` };
  const one = { Plan: "showed a plan", "Loaded tools": "loaded tools", Ran: "ran 1 command", Read: "read 1 file", Edited: "edited 1 file", Wrote: "wrote 1 file", Searched: "searched once", Subagent: "started 1 subagent", Fetched: "fetched 1 page", Skill: "used 1 skill" };
  let text = Object.entries(counts).map(([v, n]) => n === 1 ? (one[v] || `used ${v} once`) : (label[v] || (n => `used ${v} ${n} times`))(n)).join(", ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const fails = run.filter(t => t.state === "failed").length, running = run.filter(t => t.state === "running").length;
  const cls = fails ? "failed" : "";
  return `<div class="ln tool ${cls}"><span class="g">●</span><details class="fold"><summary><span class="name">${esc(text)}</span>${fails ? ` <span style="color:var(--red)">${fails} failed</span>` : ""}${running ? ` <span style="color:var(--green)">${running} running</span>` : ""} <span class="hint">(click to expand)</span></summary>
    <div class="body">${run.map(t => `<div class="res ${t.state === "failed" ? "failed" : ""}"><span>⎿</span><span><span class="name" style="font-weight:400;color:inherit">${esc(t.verb)}</span>${t.obj ? `(${esc(t.obj)})` : ""}${t.state === "failed" ? ", failed" : t.state === "running" ? ", running" : ""}</span></div>`).join("")}</div></details></div>`;
}

/* ---------- files changed ---------- */
function splitPath(f) {
  const m = f.match(/^(~\/dev\/[^/]+)\/(.*)$/) || f.match(/^(~\/\.claude\/[^/]+(?:\/[^/]+)?)\/([^/]+)$/) || f.match(/^(.*)\/([^/]+)$/);
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
  if (p.cut) out.push(`<div class="dgap">⋯ diff cut at 400 lines in this prototype</div>`);
  return out.join("");
}
let fileSeq = 0;
/* files a browser can show get an "open" link; the live app would open any file with its default app */
const OPENABLE = /\.(html?|svg|png|jpe?g|gif|webp|pdf)$/i;
const absOf = f => f.list.find(p => p.abs)?.abs || "";
const openable = f => absOf(f).startsWith("/");
const fileUrl = f => "file://" + absOf(f).split("/").map(encodeURIComponent).join("/");
function filesHTML(patches) {
  if (!patches.length) return "";
  const byFile = new Map();
  for (const p of patches) {
    const f = byFile.get(p.file) || { file: p.file, add: 0, del: 0, created: false, list: [] };
    f.add += p.add; f.del += p.del; f.created = f.created || p.created; f.list.push(p); byFile.set(p.file, f);
  }
  const roots = new Map();
  for (const f of byFile.values()) { const [r, rel] = splitPath(f.file); (roots.get(r) || roots.set(r, []).get(r)).push({ ...f, rel }); }
  const total = byFile.size;
  let body = "";
  for (const [root, files] of roots) {
    body += `<div class="root">${esc(root)}</div><div class="flist">`;
    for (const f of files) {
      const id = `diff-${fileSeq++}`;
      body += `<div class="frow"><span class="dim">⎿</span><a class="fp" href="${esc(fileUrl(f))}" target="_blank" rel="noreferrer" title="Open ${esc(f.file)}">${esc(f.rel)}</a>
        <button class="fc" aria-expanded="false" aria-controls="${id}" title="Show the diff">${f.created ? `<span class="new">new </span>` : ""}<span class="add">+${f.add}</span> <span class="del">−${f.del}</span></button></div>
        <div class="diff" id="${id}" hidden>${f.list.map(diffHTML).join(`<div class="dgap">⋯ next edit</div>`)}</div>`;
    }
    body += `</div>`;
  }
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
const live = (startIso, ms) => `<span data-live="${startIso}">${tookLive(ms)}</span>`;
let view = null; // null = the session; otherwise an agent id inside the current session
const agentsOf = s => s.agents || [];
const agentById = (s, id) => agentsOf(s).find(a => a.id === id);
const agentByTool = (s, tid) => agentsOf(s).find(a => a.toolUseId === tid);
const agentMs = a => a.start ? (a.finished ? new Date(a.end) : NOWISH) - new Date(a.start) : 0;
const agentType = a => a.fork ? "fork" : (a.type || "agent");
function waveHTML(tools, s) {
  const rows = tools.map(t => ({ t, a: agentByTool(s, t.toolUseId) }));
  const markOf = a => !a ? "done" : !a.finished ? (a.fork ? "k_fork" : "k_sub") : (isReview(a) && !reviewed.has(a.id)) ? "review" : (a.fork ? "s_fork" : "s_sub");
  const nameOf = (t, a) => a ? `<button class="alink" data-agent="${a.id}" title="Open this ${a.fork ? "fork" : "subagent"}'s transcript">${esc(a.description)}</button>` : `<span>${esc(t.obj)}</span>`;
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

function itemsHTML(items, sessionBusy, s) {
  const out = []; let run = []; let turnStart = null; let lastTs = null; let lastDay = null; let turnPatches = []; let waiting = false;
  const flush = () => {
    if (!run.length) return;
    const agents = run.filter(t => t.name === "Agent" || t.name === "Task"), other = run.filter(t => !(t.name === "Agent" || t.name === "Task"));
    if (other.length) out.push(toolsHTML(other));
    if (agents.length) out.push(waveHTML(agents, s));
    run = [];
  };
  const flushFiles = () => { flush(); out.push(filesHTML(turnPatches)); turnPatches = []; };
  const endTurn = () => { flushFiles(); if (turnStart && lastTs && new Date(lastTs) > new Date(turnStart)) out.push(`<div class="ln doneln"><span class="g">${ind("s_agent")}</span><div>Worked for ${took(new Date(lastTs) - new Date(turnStart))}, done ${hhmm(lastTs)}</div></div>`); };
  const prompt = (html, ts) => {
    flush(); endTurn();
    if (ts && day(ts) !== lastDay) { out.push(`<div class="done">${day(ts)}</div>`); lastDay = day(ts); }
    out.push(`<div class="prompt"><span class="g">❯</span><div class="md">${html}</div></div>`); turnStart = ts;
  };
  for (const it of items) {
    if (it.k === "tool") { run.push(it); if (it.patch) turnPatches.push(it.patch); if (it.ts) lastTs = it.ts; continue; }
    if (it.k === "you") { prompt(`${it.images ? `<p class="img">[${it.images} pasted image${it.images > 1 ? "s" : ""}]</p>` : ""}${md(it.text)}`, it.ts); lastTs = it.ts; continue; }
    flush();
    if (it.k === "claude") out.push(`<div class="ln claude"><span class="g">●</span><div class="md">${md(it.text)}</div></div>`);
    else if (it.k === "report") {
      const first = (it.text.split("\n").find(l => l.trim()) || "Report").replace(/[#*`]/g, "").slice(0, 160);
      const a = s && agentById(s, it.agent);
      out.push(`<div class="ln agent"><span class="g">${a ? ind(isReview(a) && !reviewed.has(a.id) ? "review" : a.fork ? "s_fork" : "s_sub") : "●"}</span><details class="fold"><summary><span class="name">Report from ${a ? esc(a.description) : "a subagent"}</span>${a ? ` <span class="dim">${took(agentMs(a))}</span>` : ""} <span class="hint">(click to read)</span></summary><div class="body md">${md(it.text)}</div>${a ? `<p><button class="alink" data-agent="${a.id}">Open its transcript</button></p>` : ""}</details></div>`);
    } else if (it.k === "ask" && it.state === "pending") {
      flushFiles();
      out.push(`<div class="ln waitln"><span class="g">${ind("pause")}</span><div><b>Waiting for you:</b> <span class="dim">${it.kind === "permission" ? `permission to run ${esc(it.cmd || "a command")}` : it.kind === "plan" ? "your approval of the plan above" : `${it.qs.length === 1 ? "a question" : `${it.qs.length} questions`} from Claude`}, in the message panel</span></div></div>`);
      waiting = true; continue;
    } else if (it.k === "ask") {
      const picked = it.kind ? [answerText(it)] : parseAnswers(it.answer);
      out.push(`<div class="ln ask"><span class="g">●</span><div>${it.qs.map((q, qi) => `<div class="md" style="margin-bottom:.4em">${md(q.q)}</div>
        <div style="margin-bottom:.85em">${q.opts.map(([l], oi) => `<div class="opt-line ${picked[qi] === l ? "picked" : ""}">${picked[qi] === l ? "❯" : " "} ${oi + 1}. ${esc(l)}</div>`).join("")}</div>`).join("")}</div></div>`);
      if (it.state === "answered") {
        const txt = picked.length ? picked.map((p, i) => `<p>${it.qs.length > 1 ? `${i + 1}. ` : ""}${esc(p)}</p>`).join("") : md(it.answer);
        lastTs = it.ts; prompt(txt, it.ts); continue;
      }
    }
    if (it.ts) lastTs = it.ts;
  }
  flush();
  if (waiting) flushFiles(); else if (!sessionBusy) endTurn(); else flushFiles();
  return out.join("");
}
/* the "working" line closes the transcript, like the CLI's spinner line */
function liveLine(s, A) {
  const line = (mark, t) => `<div class="ln liveln"><span class="g">${ind(mark)}</span><div><b>Working</b> <span class="dim">${t ? `${esc(t.verb)}${t.obj ? `(${esc(t.obj)})` : ""}` : ""}</span></div></div>`;
  if (A) return A.finished ? "" : line(A.fork ? "k_fork" : "k_sub", A.items.filter(x => x.k === "tool").pop());
  return stateOf(s) === "green" ? line("work", [...s.items].reverse().find(x => x.k === "tool")) : "";
}
function statusLine(s) {
  const st = stateOf(s);
  const last = [...s.items].reverse();
  if (st === "green") {
    const t = last.find(x => x.k === "tool");
    return `<div class="status" data-state="green"><b>${ind("work")} Working</b><span>${t ? `${esc(t.verb)}${t.obj ? `(${esc(t.obj)})` : ""}` : ""}</span></div>`;
  }
  if (st === "red") {
    const why = { plan: "Claude wrote a plan and is waiting for your approval", question: "Claude is asking you something" }[pending(s)] || "Claude is waiting for a permission";
    return `<div class="status" data-state="red"><b>${ind("pause")} Needs you</b><span>${why}, for ${dur(s.statusAt)}</span></div>`;
  }
  return `<div class="status" data-state="amber"><b>${sessionMark(s)} ${interrupted(s) ? "Stopped" : "Your turn"}</b><span>${interrupted(s) ? "You interrupted it" : `Claude finished ${dur(s.statusAt)} ago`}${bgRunning(s) ? ", background work still running" : ""}</span></div>`;
}
function renderConv() {
  const s = data.find(x => x.id === current); const conv = document.getElementById("conv");
  if (!s) { conv.innerHTML = `<div class="missing"><p>No transcripts loaded. Run <code>python3 -I export_transcripts.py</code> in the synopia folder, then reload.</p></div>`; return; }
  const A = view && agentById(s, view);
  if (view && !A) view = null;
  const hidden = A ? A.total - A.items.length : s.total - s.items.length;
  conv.innerHTML = `
    <header class="c-head panel">
      ${A ? `<p class="c-crumb"><button class="link" data-back>‹ ${esc(s.title)}</button></p>
        <h2 class="c-title">${esc(A.description)}</h2>
        <p class="c-now">${A.finished ? "Finished" : "Running"}, ${took(agentMs(A))}. ${esc(agentType(A))}${A.model ? `, model ${esc(A.model)}` : ""}${A.fork ? ", started with a copy of the session's context" : ""}</p>
        <p class="c-meta">Subagent of “${esc(s.title)}”. Its report goes back to that session.</p>`
      : `<h2 class="c-title">${esc(s.title)}</h2>
        <p class="c-now">Now: ${esc(s.now)}</p>
        <p class="c-meta">Folder <span class="mono">${esc(s.cwd)}</span>${s.prs.length ? `, PRs ${s.prs.slice(-4).map(p => `#${p}`).join(" ")}` : ""}. Tab “${esc(s.name)}”.</p>`}
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)"></button>${A ? "" : `<button class="btn" data-close>Close session</button>`}</div>
    </header>
    <div class="log panel" id="log"><div class="log-inner">
      ${hidden > 0 ? `<p class="earlier">… ${hidden} earlier items not shown in this prototype</p>` : ""}
      ${view ? itemsHTML(agentById(s, view).items, !agentById(s, view).finished, s) : itemsHTML(s.items, stateOf(s) === "green", s)}
      ${liveLine(s, A)}
    </div></div>
    <div class="dock panel"><div class="dock-inner">
      ${!A && stateOf(s) === "red" && !pendingAsk(s) ? statusLine(s) : ""}
      ${!A && pendingAsk(s) ? qaHTML(s, pendingAsk(s)) : ""}
      <div class="composer"><div class="slash" id="slash" role="listbox" hidden></div>
        <div class="attach" style="grid-column:2">${attachments.map((src, i) => `<figure><img src="${src}" alt="Pasted image ${i + 1}"><button data-unattach="${i}" aria-label="Remove image">×</button></figure>`).join("")}</div>
        <span class="g">❯</span><textarea id="msg" rows="1" placeholder="${A ? `Message ${esc(s.title)} about this subagent` : `Message ${esc(s.title)}`}, / for commands" aria-label="Message"></textarea>
      </div>
    </div></div>
    ${railHTML(s, A)}`;
  conv.classList.toggle("no-rail", !hasBackground(s));
  const log = document.getElementById("log"); log.scrollTop = log.scrollHeight;
  log.querySelectorAll(".frow .fc").forEach(b => b.onclick = () => {
    const d = document.getElementById(b.getAttribute("aria-controls")); d.hidden = !d.hidden; b.setAttribute("aria-expanded", !d.hidden);
  });

  const proto = t => () => toast(t);
  conv.querySelectorAll("[data-agent]").forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); view = b.dataset.agent; renderConv(); });
  conv.querySelector("[data-back]")?.addEventListener("click", () => { view = null; renderConv(); });
  conv.querySelector("[data-back-main]")?.addEventListener("click", () => { view = null; renderConv(); });
  conv.querySelectorAll("[data-reviewed]").forEach(b => b.onclick = e => { e.stopPropagation(); reviewed.add(b.dataset.reviewed); localStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])); renderAll(); });
  conv.querySelectorAll("[data-bg]").forEach(b => b.onclick = () => { openBg = openBg === b.dataset.bg ? null : b.dataset.bg; renderConv(); });
  conv.querySelector("[data-close]") && (conv.querySelector("[data-close]").onclick = proto("Next step: the close flow from the earlier prototype, fed by this transcript."));
  conv.querySelectorAll("[data-unattach]").forEach(b => b.onclick = () => { attachments.splice(+b.dataset.unattach, 1); renderConv(); });
  const ta = document.getElementById("msg");
  const pa = !A && pendingAsk(s);
  if (pa) {
    const st = qs(s, pa);
    conv.querySelectorAll(".acc[data-qi]").forEach(b => b.onclick = () => { st.qi = +b.dataset.qi; st.oi = 0; renderConv(); });
    conv.querySelectorAll(".qa-card .o").forEach(b => b.onclick = () => { st.oi = +b.dataset.oi; qaPick(s, pa); if (mode !== "insert") renderConv(); });
    document.getElementById("qa-send").onclick = () => answerAsk(s, pa);
    const own = document.getElementById("qa-own");
    if (own) { const q0 = pa.qs[st.target]; if (st.noteRow == null && q0.otherPrefix && own.value.startsWith(q0.otherPrefix + ": ")) own.value = own.value.slice(q0.otherPrefix.length + 2); else if (own.value === q0.otherPrefix) own.value = "";
      const stop = save => {
        const q = pa.qs[st.target];
        if (st.noteRow != null) { if (save) { if (own.value.trim()) st.notes[st.target] = own.value.trim(); else delete st.notes[st.target]; } st.target = null; st.noteRow = null; mode = "normal"; renderConv(); paintMode(); return; }
        if (save && own.value.trim()) { delete st.notes[st.target]; st.own[st.target] = q.otherPrefix ? `${q.otherPrefix}: ${own.value.trim()}` : own.value.trim(); delete st.picks[st.target]; }
        else if (save && q.otherEmptyOk) { st.own[st.target] = q.otherPrefix || q.otherLabel; delete st.picks[st.target]; }
        st.target = null; mode = "normal"; renderConv(); paintMode(); };
      own.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); stop(true); } if (e.key === "Escape") { e.preventDefault(); stop(false); } });
      own.addEventListener("blur", () => { if (st.target != null) stop(true); });
      own.addEventListener("click", e => e.stopPropagation());
      const end = own.value.length; own.focus(); own.setSelectionRange(end, end);
    }
  }
  const setModelLabel = () => document.getElementById("model-label").textContent = modelName();
  setModelLabel();
  document.getElementById("model-label").onclick = () => { ta.value = "/model"; ta.focus(); ta.dispatchEvent(new Event("input")); const it = [...document.querySelectorAll("#slash .it")].find(x => x.textContent.startsWith("/model")); it?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); };
  attachSlash(ta, s, m => { setModelLabel(); s.items.push({ k: "tool", ts: new Date().toISOString(), verb: "Model", obj: `set to ${m.name}`, name: "model", state: "done" }); toast(`Model set to ${m.name} for this session. The live app calls setModel().`); renderConv(); });
  const send = () => {
    const t = ta.value.trim(); if (!t && !attachments.length) return;
    s.items.push({ k: "you", ts: new Date().toISOString(), text: t, images: attachments.length });
    attachments.length = 0; s.status = "busy"; s.statusAt = Date.now();
    toast("Prototype: not sent to Claude. The live app sends this through the Agent SDK.");
    renderAll();
  };
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(240, ta.scrollHeight) + "px"; });
  ta.addEventListener("paste", e => {
    for (const item of e.clipboardData?.items || []) if (item.type.startsWith("image/")) {
      e.preventDefault(); const r = new FileReader(); const v = ta.value;
      r.onload = () => { attachments.push(r.result); renderConv(); document.getElementById("msg").value = v; };
      r.readAsDataURL(item.getAsFile());
    }
  });
}
