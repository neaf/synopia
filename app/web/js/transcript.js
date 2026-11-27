/* Transcript: the session view (requirements R5): its frame, the header, and the log as keyed blocks, as the
   Claude Code CLI shows a conversation: prompts, Claude's text, tool steps and runs, subagent waves and
   reports, files changed, the turn's "Worked for" line, the live line, queued and held messages, `!`
   commands. renderLog patches the blocks by key, so open steps, diffs and folds stay as they are. */
import { store, current, view, cur, isViewed, selectView, requestsOf, waitingOf, queuedOf, mounted, setMounted, nowish, agentsOf, agentById, agentMs, ownBg, bgById } from "./state.js";
import { request, act } from "./connection.js";
import * as ui from "./ui-state.js";
import { openSteps } from "./ui-state.js";
import { esc, lineHTML, markAt, took, hhmm, day, live, age, until, still } from "./format.js";
import { md, parseAnswers, parseNotes, linkText } from "./md.js";
import { ind, kind } from "./marks.js";
import { bgOf, bgState, renderRail } from "./rail.js";
import { shownBg, bgHeaderHTML, titleWithCrumb, bgLogEntries, loadEarlierOutput, syncRunDock, runDockHTML, typesTo, applyStepOutput } from "./bg-view.js";
import { ownRowHTML, ownRun } from "./runs.js";
import { thumbsHTML } from "./images.js";
import { previewClick } from "./preview.js";
import { renderCard, resetCard, withPending, extAsk } from "./card.js";
import { mountComposer, modelName, paintBash, unattach, openModelPicker, takeSent } from "./composer.js";
import { mode, setMode } from "./mode.js";
import { syncFixed } from "./folder-list.js";
import { fitTables, watchTables } from "./table-fit.js";

/* ---------- conversation, rendered like the CLI ---------- */

/* a foreground Bash or Agent still running: b, b can send it to the background, and the first b marks it (R9) */
const isFg = t => !!t.fg && t.state === "running";
/* such a step named on the live line carries the mark there, and only there: its own row, group row or
   subagent name doesn't (R9.5). Set by logEntries before it renders. */
let onLive = null;
const fgMark = t => isFg(t) && t.id !== onLive ? " data-fg" : "";
/* a step a permission check denied with no card answer above it says who said no: auto mode, or you at a terminal */
const deniedWord = t => t.state === "denied" && !t.answer ? (t.denied === "auto" ? "Blocked by auto mode" : "Denied") : "";
/* a start_session step that started a session (R3.15): its result line links to it, as a subagent's name does */
const startedHTML = t => `<span class="started">Started <button class="alink" data-session="${esc(t.session)}" title="Open this session">${esc(t.obj || "the new session")}</button></span>`;
let showSession = () => {};
export function onSession(fn) { showSession = fn; } // main.js: selects it, or opens it again
/* Claude's Bash and Monitor steps, foreground and background, are steps like the others (R5.6, 2026-11-26, the
   user's decision; it replaces the same day's run rows): they fold with the steps around them and expand in place.
   The live line naming a Bash opens its shell view (R5.5). */
const isShell = t => t.name === "Bash" || t.name === "Monitor";
let rowOf = () => null; // the session the `!` rows are drawn for: its runs (set by itemsHTML)
/* the source the viewer names for a step's images: a Read's file path, otherwise the step as its line reads */
const imgFrom = t => t.name === "Read" && t.obj ? t.obj : `${toolName(t)}${t.obj ? `(${t.obj})` : ""}`;

/* ---------- a step, expanded (R5.6): its command or input, then its result under the drawn corner ----------
   The page has the result's first 20 lines (4 KB at most); "Show all" asks the server for the rest
   (`toolOutput`), which reads it again from the transcript file. Open steps are kept by item id. */
const fullOut = new Map();
let stepAsked = null; // the step whose full result was asked for, until the reply (or a toast)
/* a toast came instead of a reply (a failed toolOutput), or a new hello (a reply lost with the old socket never comes):
   "Show all" and "Show N earlier" may ask again (main.js) */
export function clearAsked() { stepAsked = null; earlierAsked = null; }
const stepKey = id => `${current}|${view || ""}|${id}`;
const hasStep = t => !!(t.input || t.out || editOf(t));
/* an Edit, MultiEdit or Write that went through expands to its diff (R5.6, 2026-11-25), in the view a Files
   changed row opens (diffBox), and its line shows the counts; a failed or denied one keeps its error and has no patch */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
const editOf = t => EDIT_TOOLS.has(t.name) && t.state === "done" && t.patch && !t.patch.bare && t.patch.hunks?.length ? t.patch : null;
const editCounts = t => editOf(t) ? ` <span class="dc">${countsHTML(t.patch.add, t.patch.del)}</span>` : "";
/* the diff is on the page (400 lines at most), so the 20-line cut is made here and "Show all" (key `diff:<id>`) opens it in place */
const DIFF_LINES = 20, openDiffs = new Set();
function editHTML(t) {
  const p = editOf(t), total = p.hunks.reduce((n, h) => n + h.lines.length, 0), key = `diff:${t.id}`;
  const cut = total > DIFF_LINES && !openDiffs.has(stepKey(key));
  const more = cut ? `<p class="earlier more"><button data-full="${esc(key)}">Show all ${total} lines</button></p>` : "";
  return `<div class="step-out"><div class="res"><span class="lcorner" aria-hidden="true"></span>${diffBox([p], "", cut ? DIFF_LINES : Infinity)}</div>${more}</div>`;
}
const stepOpen = t => openSteps.has(stepKey(t.id)) ? ` open data-step="${esc(t.id)}"` : ` data-step="${esc(t.id)}"`;
/* One run, expanded: a tool step (R5.6, running or finished) and a `!` command share it.
   runView({ key, input, desc, out, err, truncatedTotal, running, startedAt, note, exit, stopped })
     key            the id "Show all" asks the server for (`toolOutput`, data-full)
     input, desc    the command or input on top, and a quiet description over it ("" for none)
     out, err       the output and stderr so far (null: none yet; "" when finished: "No output")
     truncatedTotal the full line count when out is the first 20 lines (0: not cut)
     running        a live "Running, 42s" (from startedAt, ISO or ms; plain "Running" without it)
     note           a quiet line under the running one, such as "Output shows when it finishes"
     exit, stopped  "Exit code N" when non-zero, "Stopped" when interrupted
   The result rows sit under the drawn guide: the first carries the corner, the rest align with it. */
function runView({ key = "", input = "", desc = "", out = null, err = "", truncatedTotal = 0, running = false, startedAt = null, note = "", exit = null, stopped = false } = {}) {
  const rows = [], row = (html, cls = "") => rows.push([html, cls]);
  if (out) row(`<span class="out">${linkText(out)}</span>`); // a URL in it is a link (an MCP server's sign-in link)
  if (err) row(`<span class="out err">${linkText(err)}</span>`);
  const more = truncatedTotal ? `<p class="earlier more"><button data-full="${esc(key)}">Show all ${+truncatedTotal} lines</button></p>` : "";
  const after = [];
  if (running) {
    const at = startedAt === null || startedAt === undefined || startedAt === "" ? null : new Date(startedAt);
    after.push([`<span class="run">Running${at && !isNaN(at) ? `, ${live(at.toISOString(), Date.now() - at)}` : ""}</span>`, "running"]);
    if (note) after.push([`<span class="note">${esc(note)}</span>`, "note"]);
  } else {
    if (out === "" && !err) row(`<span>No output</span>`);
    if (stopped) after.push([`<span>Stopped</span>`, ""]);
    else if (exit !== null && exit !== undefined && +exit !== 0) after.push([`<span>Exit code ${esc(exit)}</span>`, "failed"]);
  }
  const all = [...rows, ...after];
  const res = ([html, cls], i) => `<div class="res${cls ? ` ${cls}` : ""}">${i === 0 ? `<span class="lcorner" aria-hidden="true"></span>` : "<span></span>"}${html}</div>`;
  const head = `${desc ? `<div class="desc">${esc(desc)}</div>` : ""}${input ? `<div class="cmd">${esc(input)}</div>` : ""}`;
  return `<div class="step-out${running ? " running" : ""}">${head}${rows.map(res).join("")}${more}${after.map((r, i) => res(r, rows.length + i)).join("")}</div>`;
}
function stepHTML(t) {
  if (editOf(t)) return editHTML(t);
  const o = t.out, full = fullOut.get(stepKey(t.id)), running = t.state === "running" && !o;
  /* the SDK's tool_progress carries only the elapsed time (sdk.d.ts SDKToolProgressMessage), so a
     driven session's step says its output comes at the end; a session Synopia doesn't drive has no progress */
  return runView({
    key: t.id, input: t.input || "", out: o ? (full !== undefined ? full : o.text || "") : null,
    truncatedTotal: o && o.cut && full === undefined ? +o.lines : 0,
    running, startedAt: t.since || null, note: running && cur()?.state.driven ? "Output shows when it finishes" : "", stopped: !!(o && o.interrupted),
  });
}
function showAll(id) {
  const key = stepKey(id);
  if (id.startsWith("diff:")) { openDiffs.add(key); renderLog(); return; } // so is an edit's diff
  if (stepAsked === key) return;
  if (request({ t: "toolOutput", sid: current, agent: view || null, toolUseId: id })) stepAsked = key;
}
export function applyToolOutput(m) {
  applyStepOutput(m); // a step's shell view has its whole result too (bg-view.js)
  const key = `${m.sid}|${m.agent || ""}|${m.toolUseId}`;
  if (stepAsked === key) stepAsked = null;
  fullOut.set(key, String(m.text ?? ""));
  if (isViewed(m.sid, m.agent)) renderLog();
}
/* Steps fold into one line, a single step too ("1 Bash command", R5.6, 2026-11-26, the user's decision); a click lists
   them, each on its own line, which expands to its command and result. Every such line is one line (lineHTML). */
function toolsHTML(run) {
  const counts = {}; run.forEach(t => counts[t.verb] = (counts[t.verb] || 0) + 1);
  const label = { Plan: n => `showed ${n} plans`, "Loaded tools": n => "loaded tools", Ran: n => `${n} Bash commands`, Read: n => `read ${n} files`, Edited: n => `edited ${n} files`, Wrote: n => `wrote ${n} files`,
    Searched: n => `searched ${n} times`, Subagent: n => `started ${n} subagents`, Fetched: n => `fetched ${n} pages`, Skill: n => `used ${n} skills`, Watched: n => `started ${n} monitors`, "Start session": n => `started ${n} sessions` };
  const one = { Plan: "showed a plan", "Loaded tools": "loaded tools", Ran: "1 Bash command", Read: "read 1 file", Edited: "edited 1 file", Wrote: "wrote 1 file", Searched: "searched once", Subagent: "started 1 subagent", Fetched: "fetched 1 page", Skill: "used 1 skill", Watched: "started 1 monitor", "Start session": "started 1 session" };
  let text = Object.entries(counts).map(([v, n]) => n === 1 ? (one[v] || `used ${v} once`) : (label[v] || (n => `used ${v} ${n} times`))(n)).join(", ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const fails = run.filter(t => t.state === "failed").length, running = run.filter(t => t.state === "running").length;
  /* one step's dot reads its state, as the step's own. "done" adds no class: it is the day separator's (.done, its
     margin and grey), which made a single done step's line 3.5px taller and grey, so it jumped when a second step came
     (2026-11-27, the user: "Changing from 1 Bash command to 2 Bash commands changes the row height by a pixel or two") */
  const cls = run.length === 1 ? (run[0].state !== "done" ? esc(run[0].state) : "") : fails ? "failed" : "";
  return `<div class="ln tool ${cls}"><span class="g"${markAt(run[0].ts)}>●</span><details class="fold"><summary${run.some(fgMark) ? " data-fg" : ""}>${lineHTML("", `<span class="name">${esc(text)}</span>`, `${fails ? ` <span style="color:var(--red)">${fails} failed</span>` : ""}${running ? ` <span style="color:var(--green)">${running} running</span>` : ""} <span class="hint">(click to expand)</span>`)}</summary>
    <div class="body">${run.map(t => {
      const o = objOf(t), row = `<span class="lcorner" aria-hidden="true"></span>${lineHTML(`<span class="name" style="font-weight:400;color:inherit">${esc(toolName(t))}</span>${o ? "(" : ""}`, o, `${o ? ")" : ""}${editCounts(t)}${t.state === "failed" ? ", failed" : deniedWord(t) ? `, ${deniedWord(t).toLowerCase()}` : t.state === "stopped" ? ", stopped" : t.state === "running" ? ", running" : ""}${t.session ? `: ${startedHTML(t)}` : ""}`)}`, cls = `res ${t.state === "failed" ? "failed" : ""}`;
      return hasStep(t) ? `<details class="step"${stepOpen(t)}><summary class="${cls}"${fgMark(t)}>${row}</summary>${stepHTML(t)}</details>` : `<div class="${cls}"${fgMark(t)} data-item="${esc(t.id)}">${row}</div>`;
    }).join("")}</div></details>${thumbsHTML(run.flatMap(t => (t.imgs || []).map(m => ({ ...m, from: imgFrom(t) }))), current, view)}</div>`; // one row for the run's images (R5.12b)
}

/* a step's display name: the tool's Claude Code CLI name, as in the terminal; MCP tools read "server tool" */
function toolName(t) { return t.name && !t.name.startsWith("mcp__") ? (t.name === "Task" ? "Agent" : t.name) : t.verb; }
/* a step's target, the part of its line in brackets. SendMessage names whom it went to (the subagent's name, from its id) and
   its summary, so it reads as a message to that subagent */
function objOf(t) {
  if (t.name === "SendMessage" && t.to) {
    const a = cur() && agentById(cur(), t.to), who = a ? a.description : t.to;
    return `to “${esc(who)}”${t.obj ? `: ${esc(t.obj)}` : ""}`;
  }
  return t.obj ? esc(t.obj) : "";
}
/* ---------- files changed ---------- */
function splitPath(f) {
  const m = f.match(/^(~\/dev\/[^/]+\/\.claude\/worktrees\/[^/]+)\/(.*)$/) || f.match(/^(~\/dev\/[^/]+)\/(.*)$/) || f.match(/^(~\/\.claude\/[^/]+(?:\/[^/]+)?)\/([^/]+)$/) || f.match(/^(.*)\/([^/]+)$/);
  return m ? [m[1], m[2]] : ["", f];
}
/* the digits of the largest line number in these patches, so the diff's number column fits them */
function diffDigits(ps) {
  let max = 1;
  for (const p of ps) if (!p.unnumbered) for (const h of p.hunks || []) max = Math.max(max, (h.o || 0) + h.lines.length, (h.n || 0) + h.lines.length);
  return String(max).length;
}
/* unnumbered: a diff from the tool's input (a subagent's edit), whose place in the file isn't known: no numbers */
/* max: the rows to show, for an expanded step's cut (editHTML) */
function diffHTML(p, max = Infinity) {
  const out = [], num = k => p.unnumbered ? "" : k;
  let left = max;
  p.hunks.forEach((h, hi) => {
    if (left <= 0) return;
    if (hi) out.push(`<div class="dgap">⋯</div>`);
    let o = h.o, n = h.n;
    for (const l of h.lines) {
      if (left-- <= 0) break;
      const sg = l[0], txt = esc(l.slice(1));
      if (sg === "+") out.push(`<div class="dl a"><span class="no">${num(n++)}</span><span class="sg">+</span><span>${txt}</span></div>`);
      else if (sg === "-") out.push(`<div class="dl d"><span class="no">${num(o++)}</span><span class="sg">-</span><span>${txt}</span></div>`);
      else { out.push(`<div class="dl c"><span class="no">${num(n)}</span><span class="sg"> </span><span>${txt}</span></div>`); o++; n++; }
    }
  });
  if (p.cut && max === Infinity) out.push(`<div class="dgap">⋯ diff cut at 400 lines</div>`);
  return out.join("");
}
/* one diff view, for a Files changed row and an expanded edit step: attrs are the row's id and hidden */
const diffBox = (ps, attrs = "", max = Infinity) => `<div class="diff"${attrs} style="--dn:${diffDigits(ps)}ch">${ps.map(p => diffHTML(p, max)).join(`<div class="dgap">⋯ next edit</div>`)}</div>`;
const countsHTML = (add, del) => `<span class="add">+${add}</span> <span class="del">−${del}</span>`;
/* every file is a link: a click sends its path to the preview or to `open` (the click handler at the end),
   so the href is only for the status bar and copying */
const absOf = f => f.list.find(p => p.abs)?.abs || "";
const fileUrl = f => "file://" + absOf(f).split("/").map(encodeURIComponent).join("/");
/* The patches of a turn's steps (each an Edit's or Write's `patch`, or a Bash command's `patches`) with the files that
   have no net change left out (2026-11-27). Why such files came out as "+16 −16" or with no counts: Files changed adds up
   each step's diff of a file, and a command that undoes an earlier one (a git merge, then `git merge --abort`) records
   the reverse diff, so the counts add up to the same number both ways; a file both list as changed with no diff (bare)
   shows no counts. So: a step whose files are an earlier step's and whose diffs are its exact reverse undid it, and both
   go, their bare files too. Of the rest, a file with several diffs whose added and removed lines cancel has no net
   change. */
const diffed = p => !p.bare;
/* a patch's changed lines as counts per line (+1 added, -1 removed); null when the patch is cut and they aren't all here */
function lineCounts(p, into = new Map()) {
  if (p.cut) return null;
  for (const h of p.hunks || []) for (const l of h.lines) if (l[0] === "+" || l[0] === "-") into.set(l.slice(1), (into.get(l.slice(1)) || 0) + (l[0] === "+" ? 1 : -1));
  return into;
}
const balanced = m => !!m && [...m.values()].every(n => n === 0);
/* whether b's diff of a file is a's reversed: the counts swapped, and the lines cancel when both are whole */
function reverses(a, b) {
  if (a.add !== b.del || a.del !== b.add || a.add + a.del === 0) return false;
  if (a.cut || b.cut) return true; // a long diff is cut on the page: the counts are its whole
  return balanced(lineCounts(b, lineCounts(a)));
}
export function netPatches(steps) {
  const lists = steps.map(t => (t.patches || [t.patch]).filter(Boolean)), gone = new Set();
  const files = ps => [...new Set(ps.map(p => p.abs || p.file))].sort().join("\n");
  const undoes = (a, b) => files(a) === files(b) && a.some(diffed) && b.filter(diffed).every(q => { const p = a.find(x => (x.abs || x.file) === (q.abs || q.file) && diffed(x)); return p ? reverses(p, q) : true; })
    && a.filter(diffed).some(p => b.some(q => diffed(q) && (q.abs || q.file) === (p.abs || p.file)));
  for (let j = 0; j < lists.length; j++) {
    if (!lists[j].length) continue;
    for (let i = j - 1; i >= 0; i--) if (!gone.has(i) && lists[i].length && undoes(lists[i], lists[j])) { gone.add(i); gone.add(j); break; }
  }
  const left = lists.filter((_, i) => !gone.has(i)).flat(), byFile = new Map();
  for (const p of left) { const k = p.abs || p.file; (byFile.get(k) || byFile.set(k, []).get(k)).push(p); }
  const none = new Set([...byFile].filter(([, ps]) => ps.length > 1 && ps.every(diffed) && balanced(ps.reduce((m, p) => m && lineCounts(p, m), new Map()))).map(([k]) => k));
  return left.filter(p => !none.has(p.abs || p.file));
}
/* patches: an Edit's or Write's, and those of a Bash command (bashEditDiff). A bare one is a file the
   shell changed with no diff: its path shows without counts. more: files the shell changed past its list. */
export function filesHTML(patches, key, more = 0, ts = null) { // key: stable diff ids, so an open diff stays open when the block is redrawn
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
        ${diffs.length ? `<button class="fc" aria-expanded="false" aria-controls="${id}" title="Show the diff">${f.created ? `<span class="new">new </span>` : ""}${countsHTML(f.add, f.del)}</button></div>
        ${diffBox(diffs, ` id="${id}" hidden`)}` : `<span></span></div>`}`;
    }
    body += `</div>`;
  }
  if (more) body += `<div class="root">and ${more} more file${more > 1 ? "s" : ""}</div>`;
  /* folded by default, like a run of steps (R5.9, 2026-11-27: "Should be collapsed by default") */
  return `<div class="ln tool files"><span class="g"${markAt(ts)}>●</span><details class="fold"><summary><span class="name">Files changed</span> <span class="dim">${total} file${total > 1 ? "s" : ""}</span> <span class="hint">(click to expand)</span></summary>${body}</details></div>`;
}

/* ---------- subagents ---------- */
const agentByTool = (s, tid) => agentsOf(s).find(a => a.toolUseId === tid);
const agentType = a => a.fork ? "fork" : (a.type || "agent");
function waveHTML(tools, s) {
  const rows = tools.map(t => ({ t, a: agentByTool(s, t.toolUseId) }));
  // A subagent whose turn ended but whose own background shell or monitor still runs isn't done: it
  // resumes when that work reports, so it reads as running.
  const busy = a => a && (!a.finished || bgOf(s).some(b => b.agentId === a.id && bgState(b) === "running"));
  // motion means it is doing something itself (2026-11-26): one waiting on its own background work is still
  const markOf = a => !a ? "done" : busy(a) && !a.waiting ? (a.fork ? "k_fork" : "k_sub") : a.review && !busy(a) ? "review" : (a.fork ? "s_fork" : "s_sub");
  // in a wave the name carries the b, b mark (R9); a single line carries it on the whole line
  const nameOf = (t, a, mark = fgMark(t)) => a ? `<button class="alink"${mark} data-agent="${esc(a.id)}" data-item="${esc(t.id)}" title="Open this ${a.fork ? "fork" : "subagent"}'s transcript">${esc(a.description)}</button>` : `<span${mark} data-item="${esc(t.id)}">${esc(t.obj)}</span>`;
  const time = a => a ? (busy(a) ? live(a.start, a.finished ? nowish - new Date(a.start) : agentMs(a)) : took(agentMs(a))) : "";
  if (rows.length === 1) {
    const { t, a } = rows[0];
    return `<div class="ln agent one"${fgMark(t)}><span class="g"${markAt(t.ts)}>${ind(markOf(a))}</span><div>${nameOf(t, a, "")} <span class="adur">${time(a)}</span></div></div>`;
  }
  // No duration bars (author, 2026-11-24): each row is its mark, its name and its time.
  const t0 = Math.min(...rows.map(r => r.a?.start ? +new Date(r.a.start) : Infinity));
  const forks = rows.every(r => r.a?.fork);
  const parallel = rows.every(r => r.a) && Math.max(...rows.map(r => +new Date(r.a.start))) - t0 < 120000;
  return `<div class="ln agent wave"><span class="g"></span><div><span class="name">${rows.length} ${forks ? "forks" : "subagents"}${parallel ? " in parallel" : ""}</span>
    <div class="wgrid">${rows.map(({ t, a }) => {
      return `${ind(markOf(a))}${nameOf(t, a)}<span class="adur">${time(a)}</span>`;
    }).join("")}</div></div></div>`;
}


/* The log as keyed blocks: [key, html], one root element each. Keys come from item ids, so renderLog
   can keep the blocks that didn't change and replace the ones that did. */
export function itemsHTML(items, sessionBusy, s) {
  rowOf = () => s;
  const out = []; let run = []; let turnStart = null; let turnKey = null; let turnMs = null; let lastTs = null; let lastDay = null; let turnPatches = []; let waiting = false;
  /* title changes (R5.x) wait for the next block: one between turns goes after the turn's "Worked for" line */
  let titles = [];
  const putTitles = () => { out.push(...titles); titles = []; };
  const flush = () => {
    if (!run.length) return;
    const agents = run.filter(t => t.name === "Agent" || t.name === "Task"), other = run.filter(t => !(t.name === "Agent" || t.name === "Task"));
    if (other.length) out.push([`run:${other[0].id}`, toolsHTML(other)]);
    if (agents.length) out.push([`wave:${agents[0].id}`, waveHTML(agents, s)]);
    run = [];
  };
  const flushFiles = () => {
    flush();
    const patches = netPatches(turnPatches), more = turnPatches.reduce((n, t) => n + (+t.moreFiles || 0), 0);
    if (patches.length || more) { const key = turnPatches[0].id; out.push([`files:${key}`, filesHTML(patches, key, more, lastTs)]); }
    turnPatches = [];
  };
  const endTurn = () => { flushFiles(); if (turnStart && lastTs && (turnMs || new Date(lastTs) > new Date(turnStart))) out.push([`done:${turnKey}`, `<div class="ln doneln"><span class="g"${markAt(lastTs)}>${ind("s_agent")}</span><div>Worked for ${took(turnMs || new Date(lastTs) - new Date(turnStart))}, done ${hhmm(lastTs)}</div></div>`]); };
  /* `mid`: a message the running turn took in from its queue (R5.5): the turn goes on through it, so no
     "Worked for" line before it */
  const prompt = (html, ts, key, whole, mid = false) => {
    flush(); if (!mid) endTurn(); putTitles();
    if (ts && day(ts) !== lastDay) { out.push([`day:${key}`, `<div class="done">${day(ts)}</div>`]); lastDay = day(ts); }
    out.push(whole ? [`bang:${key}`, whole] : [`you:${key}`, band(html, ts)]);
    if (!mid) { turnStart = ts; turnKey = key; turnMs = null; }
  };
  for (const it of items) {
    /* your answer to a permission or plan card shows as your turn, before the tool it let run (R6.7) */
    if (it.k === "tool" && it.answer) { prompt(esc(it.answer), it.ts, `ans:${it.id}`); lastTs = it.ts; }
    /* a plan whose process ended before you answered reads "Not answered (Synopia quit)", as a question does */
    if (it.k === "tool" && it.name === "ExitPlanMode" && it.state === "running" && !sessionBusy) { flush(); out.push([`na:${it.id}`, notAnswered(it.ts)]); continue; }
    if (it.k === "tool") { run.push(it); if (it.patch || it.patches) turnPatches.push(it); if (it.ts) lastTs = it.ts; continue; }
    /* Synopia resumed a turn the credentials failed (R8.2, 2026-11-26): a quiet line, not your band, that opens Claude's turn */
    if (it.k === "resumed") { prompt(null, it.ts, it.id, `<div class="done retitle resumed">Resumed after the credential refresh</div>`); turnMs = it.workedMs || null; lastTs = it.ts; continue; }
    if (it.k === "you") { const mid = !!it.queued && !!turnStart && !turnMs; prompt(youBody(it, view), it.ts, it.id, null, mid); turnMs = it.workedMs || (mid ? turnMs : null); lastTs = it.ts; continue; }
    /* a bash-mode command: on your prompt's band. Synopia's end of one starts Claude's turn (R5.13, 2026-11-27),
       so its row is that turn's start; one a running turn took in from its queue (or that runs during a turn)
       is `mid`, as a queued message is: the turn goes on through it */
    if (it.k === "bang") {
      const b = it.live && s?.bang;
      if (b) { // the run Synopia shows until its records land (placeBangs put it where it started)
        const mid = !!sessionBusy && !!turnStart && !turnMs;
        prompt(null, it.ts, it.id, bangHTML(b.id, b.cmd, { out: b.out, err: b.err, cut: b.cut, exit: b.exit }, b, !!ownOf(s, b.id), it.ts), mid);
        lastTs = it.ts; continue;
      }
      if (!it.sh && bangLiveOf(s)?.id === it.id) continue; // its output isn't in yet: the live run shows it
      const mid = !!it.queued && !!turnStart && !turnMs;
      prompt(null, it.ts, it.id, bangHTML(it.id, it.cmd || "", it.sh, null, !!ownOf(s, it.id), it.ts), mid);
      turnMs = it.workedMs || (mid ? turnMs : null); lastTs = it.ts; continue;
    }
    /* the shown title changed (R5.x): a quiet line in place, like a day separator */
    if (it.k === "title") { titles.push([it.id, `<div class="done retitle">Retitled “<span class="t">${esc(it.title)}</span>”${it.by === "you" ? " by you" : ""}</div>`]); continue; }
    if (titles.length && it.k !== "you" && !(it.k === "tool" && it.answer)) { flush(); putTitles(); }
    flush();
    /* it continued in another folder (R3.11): a quiet line in place, as a title change */
    if (it.k === "moved") { out.push([it.id, `<div class="done retitle moved">Continued in <span class="t">${esc(it.cwd || "another folder")}</span></div>`]); continue; }
    /* f, f set the turn aside for your messages (R9.8, 2026-11-26): its live line, as it was, still and struck through */
    if (it.k === "aside") { out.push([it.id, asideHTML(it, s, items)]); continue; }
    if (it.k === "claude") out.push([it.id, `<div class="ln claude${it.aside ? " aside" : ""}"><span class="g"${markAt(it.ts)}>●</span><div class="md">${md(it.text)}</div></div>`]);
    else if (it.k === "report") {
      const a = s && agentById(s, it.agent);
      out.push([it.id, `<div class="ln agent"><span class="g"${markAt(it.ts)}>${a ? ind(a.review ? "review" : a.fork ? "s_fork" : "s_sub") : "●"}</span><details class="fold"><summary><span class="name">Report from ${a ? esc(a.description) : "a subagent"}</span>${a ? ` <span class="dim">${took(agentMs(a))}</span>` : ""} <span class="hint">(click to read)</span></summary><div class="body md">${md(it.text)}</div>${a ? `<p><button class="alink" data-agent="${esc(a.id)}">Open its transcript</button></p>` : ""}</details></div>`]);
    } else if (it.k === "ask" && it.state === "pending" && (it.request || sessionBusy)) {
      flushFiles();
      out.push([`wait:${it.id}`, `<div class="ln waitln"><span class="g"${markAt(it.ts)}>${ind("pause")}</span><div><b>Waiting for you:</b> <span class="dim">${it.kind === "permission" ? (it.request.own ? `permission to ${esc(it.request.own.wants)}` : it.request.toolName === "Bash" ? `permission to run ${esc(it.cmd || "a command")}` : `permission to use ${esc(it.request.toolName)} on ${esc(it.cmd)}`) : it.kind === "plan" ? "your approval of the plan above" : `${it.qs.length === 1 ? "a question" : `${it.qs.length} questions`} from Claude`}, ${it.ext ? "asked in another process" : "in the message panel"}</span></div></div>`]);
      waiting = true; continue;
    } else if (it.k === "ask") {
      /* the transcript's question (a card's ask is always pending with its request, above) */
      const picked = parseAnswers(it.answer);
      out.push([it.id, `<div class="ln ask"><span class="g"${markAt(it.ts)}>●</span><div>${it.qs.map((q, qi) => `<div class="md" style="margin-bottom:.4em">${md(q.q)}</div>
        <div style="margin-bottom:.85em">${q.opts.map(([l], oi) => `<div class="opt-line ${picked[qi] === l ? "picked" : ""}">${picked[qi] === l ? "❯" : " "} ${oi + 1}. ${esc(l)}</div>`).join("")}</div>`).join("")}</div></div>`]);
      if (it.state === "pending") { out.push([`na:${it.id}`, notAnswered(it.ts)]); continue; }
      if (it.state === "answered") {
        const notes = parseNotes(it.answer); // your note on an answer stays visible (R6.4)
        const txt = picked.length ? picked.map((p, i) => `<p>${it.qs.length > 1 ? `${i + 1}. ` : ""}${esc(p)}${notes[i] ? `<span class="dim">, note: ${esc(notes[i])}</span>` : ""}</p>`).join("") : md(it.answer);
        lastTs = it.ts; prompt(txt, it.ts, `ans:${it.id}`); continue;
      }
    }
    if (it.ts) lastTs = it.ts;
  }
  flush();
  /* a message sent while idle (R5.5) starts the next turn: the one before it is over, so its "Worked for" stays
     while the send waits for its record, which then lands below it, with nothing moving */
  const ended = !sessionBusy || (!!s && !view && waitingOf(s).some(q => q.queued === false));
  if (waiting) flushFiles(); else if (ended) endTurn(); else flushFiles();
  putTitles();
  return out;
}
/* ---------- bash mode (R5.13): a `!` command, as the CLI shows it ----------
   The command on the prompt band with `!` for `❯`, then the run row's preview under it (runs.js, 2026-11-26): its
   last 3 lines and its state line. The same for a command run from Synopia (while
   it runs and until its records land: the session's `bang`) or recorded by the CLI. A click on the row opens its
   shell view (bg-view.js), the only place for its whole output, its input and its stop. `opens`: a run the
   session lists (state.js ownBg); one the CLI recorded has its row only. */
function bangHTML(id, cmd, sh, run, opens = false, ts = null) {
  const s = rowOf(), meta = run || (s?.bangs || []).find(r => r.id === id || r.landed === id) || null;
  return ownRowHTML(ownRun(cmd, meta, sh || (run ? null : { out: "", err: "", cut: false, exit: null })), { open: opens ? (run?.id || meta?.id || id) : null, attrs: ` data-bang="${esc(id)}" data-item="${esc(id)}"`, at: ts });
}
/* the panel's run for a bash item: by the run's id, or the item it landed as */
const ownOf = (s, id) => s ? ownBg(s).find(b => b.toolUseId === id || b.landed === id) : null;
/* The line f, f's interrupt set aside (R9.8): the still mark, "Thinking" and the step it named then, struck
   through, and why. Not a running mark: it doesn't move. */
function asideHTML(it, s, items) {
  const t = it.step ? items.find(x => x.k === "tool" && x.id === it.step) : null;
  return `<div class="ln asideln"><span class="g"${markAt(it.ts)}>${ind("s_agent")}</span><div><s><b>Thinking</b>${t ? ` ${liveName(s, t).join("")}` : ""}</s> <span class="why">set aside for your messages</span></div></div>`;
}
/* the reply an aside cut short goes above it, greyed with it, though its partial record lands after */
function placeAsides(items) {
  if (!items.some(i => i.k === "aside")) return items;
  const list = items.slice();
  for (const a of items.filter(i => i.k === "aside")) {
    const last = list.findLastIndex(i => i.k === "claude" && i.aside === a.id), at = list.indexOf(a);
    if (last > at) { list.splice(at, 1); list.splice(last, 0, a); }
  }
  return list;
}
/* Your `!` runs stay where they ran, in time order (R5.13, 2026-11-26): the live one (an item `live`), and one
   whose records landed after messages sent while it ran, go before the first item stamped after its start. */
function placeBangs(items, s) {
  const runs = s.bangs || [], live = bangLiveOf(s); if (!runs.length && !live) return items;
  const startOf = new Map(runs.map(r => [r.landed || r.id, r.at]));
  const moved = items.filter(i => i.k === "bang" && i.sh && startOf.has(i.id) && i.id !== live?.id).map(i => [i, startOf.get(i.id)]);
  if (live) moved.push([{ id: live.id, k: "bang", ts: new Date(live.at).toISOString(), cmd: live.cmd, live: true }, live.at]);
  if (!moved.length) return items;
  const list = items.filter(i => !moved.some(([m]) => m === i));
  for (const [m, at] of moved.sort((p, q) => p[1] - q[1])) {
    const n = list.findIndex(i => i.ts && !i.live && Date.parse(i.ts) > at);
    list.splice(n < 0 ? list.length : n, 0, m);
  }
  return list;
}
/* the command that runs or just ran, until its records are in the transcript */
const bangLiveOf = s => { const b = s.bang; return b && !s.items.some(i => i.id === (b.landed || b.id) && i.k === "bang" && i.sh) ? b : null; };
const notAnswered = ts => `<div class="ln"><span class="g dim"${markAt(ts)}>○</span><div class="dim">Not answered (Synopia quit)</div></div>`;
/* messages sent while a card waits: held behind it, sent once you answer */
export const heldHTML = s => (s.held || []).map((t, i) => [`held:${i}:${t.length}`, `<div class="prompt"><span class="g">❯</span><div class="md">${md(t)}<p class="dim">Queued until you answer the card above</p></div></div>`]);
/* Your message on the prompt band (R5.5, R5.13), one way for all: a posted prompt item, or a sent one
   (the outbox) until its record lands. Its text, then its images as thumbnails (an outbox message's
   from the backend, `queued:<id>:<n>`), or a count when the transcript holds none of them. A queued one
   is the same band with a still clock in place of `❯` and lighter text: it waits, it doesn't run. */
const band = (body, ts = null) => `<div class="prompt"><span class="g"${markAt(ts)}>❯</span><div class="md">${body}</div></div>`;
const youBody = (m, agent) => `${m.images && !m.imgs?.length ? `<p class="img">[${m.images} pasted image${m.images > 1 ? "s" : ""}]</p>` : ""}${md(m.text || "")}${thumbsHTML(m.imgs, current, agent, "your message")}`;
/* messages you sent while the turn runs, oldest first, below the live line (what's working began before
   it), as the CLI shows queued input. Once its prompt item is in, that shows instead, above the live line. */
/* a message sent while idle shows at once as your normal prompt, until its own record replaces it */
const sentHTML = s => waitingOf(s).filter(q => q.queued === false).map(q => [`q:${q.id}`, band(youBody(q, null))]);
/* The queue (R5.5): the messages you sent while the turn runs, oldest first, as one block at the log's end,
   below the live line (what's working began before you sent them; the author, 2026-11-24), as the CLI shows
   queued input. The block ends the transcript and scrolls with it, not pinned (2026-11-25). A message Claude takes leaves the block and
   lands above the live line as your band, on Claude's side of it: the band and the line swap places, and nothing else
   moves (2026-11-25). */
const queuedHTML = s => { const q = queuedOf(s); return q.length ? [["queue", `<div class="qpin">${q.map(m =>
  `<div class="prompt qc" data-key="q:${esc(m.id)}"><span class="g">${ind("waiting")}</span><div class="md">${youBody(m, null)}</div></div>`).join("")}</div>`]] : []; };
/* the "working" line closes the transcript, like the CLI's spinner line. Inside a turn it can read
   compacting, rate limited or no updates instead, and say a message you sent is queued. When it names
   the newest step and that step runs, a click expands it: the same open state as the step's own line
   (openSteps, by item id), so opening either opens both (R5.6). */
const isAgent = t => t.name === "Agent" || t.name === "Task";
const liveStep = t => !!t && t.state === "running" && hasStep(t) && !isAgent(t);
/* the step named on the live line: the turn's own newest step only while it runs, as the CLI's spinner line.
   Once it's done (Claude writing, thinking, between steps) the line just says Thinking, rather than naming a
   finished step. Background work (`bg`, a background subagent) is never the turn's step: the panel shows it. */
const runningStep = items => { const last = [...(items || [])].reverse().find(x => x.k === "tool" && !x.bg); return last && last.state === "running" ? last : null; };
/* the main conversation's step the live line names, when b, b could send it */
const liveFg = s => { const t = s.state.light === "green" && !phaseText(s) ? runningStep(s.items) : null; return t && isFg(t) ? t.id : null; };
/* what the live line names: a subagent or fork by the panel's kind tag and its name; any other tool by its
   CLI name, Bash(…) */
const liveName = (s, t) => { if (!isAgent(t)) { const o = objOf(t); return [`${esc(toolName(t))}${o ? "(" : ""}`, o, o ? ")" : ""]; } const a = agentByTool(s, t.toolUseId); return [`${kind(a?.fork ? "fork" : "sub")} `, esc(a ? a.description : t.obj || ""), ""]; };
/* MCP and web tools keep the arc while they run, with their timer on the line (R8.2, 2026-11-27): their time goes to a server */
const isRemote = t => !!t && t.state === "running" && (t.name?.startsWith("mcp__") || t.name === "WebFetch" || t.name === "WebSearch");
const stepTimer = t => { const at = new Date(t.since || t.ts); return isNaN(at) ? "" : ` ${live(at.toISOString(), nowish - at)}`; };
function liveLine(s, A) {
  const line = (mark, t, word = "Thinking", extra = "", state = A ? "green" : s.state.tone, cls = "") => {
    const [pre, mid, post0] = extra ? ["", extra, ""] : t ? liveName(s, t) : ["", "", ""];
    const post = !extra && (isRemote(t) || (cls && t)) ? `${post0}${stepTimer(t)}` : post0;
    const head = lineHTML(`<b>${esc(word)}</b>${pre || mid ? " " : ""}<span class="dim">${pre}</span>`, mid && `<span class="dim">${mid}</span>`, post && `<span class="dim">${post}</span>`); // one line (R5.6)
    /* a Bash step named here opens its shell view (R5.5, 2026-11-26), even while its own line folds and expands in
       place; a step with no view (a subagent's own Bash, any other tool) expands from here as from its line */
    const opens = !A && !extra && t && isShell(t) && bgById(s, t.id) ? ` data-bg="${esc(t.id)}" title="Open its shell view"` : "";
    const body = !extra && liveStep(t) && !opens ? `<details class="step live"${stepOpen(t)}><summary>${head}</summary>${stepHTML(t)}</details>` : `<div><span class="lh">${head}</span></div>`;
    return `<div class="ln liveln rule${cls}" data-state="${state}"${!A && !extra && t && t.id === onLive ? " data-fg" : ""}${opens}><span class="g"${markAt(t ? t.since || t.ts : A ? A.start : s.state.since)}>${ind(mark)}</span>${body}</div>`;
  };
  // a subagent waiting on its own background work: still, it runs nothing itself (its shells move in the panel)
  if (A) return A.finished ? "" : A.waiting ? line(A.fork ? "s_fork" : "s_sub", null, "Waiting", "on its own background work") : line(A.fork ? "k_fork" : "k_sub", runningStep(A.items));
  /* the main turn over: no live line, even while background work runs (2026-11-26): the panel and the sidebar show it */
  if (s.state.light !== "green") return "";
  /* a command on your machine (R8.2, 2026-11-27): the moving shell mark and "Running Bash(…) 2m 14s", the word in the shell
     colour; a foreground subagent's own command names it: "Running Bash(Build the docs) 4s in Draft the release notes" */
  const c = s.state.command;
  if (c && c.agent) return line("k_shell", null, "Running", `Bash(${esc(c.obj)}) ${live(new Date(c.since).toISOString(), nowish - c.since)} in ${esc(c.agent)}`, s.state.tone, " cmd");
  if (c) return line("k_shell", runningStep(s.items), "Running", "", s.state.tone, " cmd");
  return line(s.state.mark, runningStep(s.items), s.state.word, phaseText(s));
}
/* what the state means, after its word (status.ts: the source of each) */
function phaseText(s) {
  const st = s.state.status, d = s.state.detail;
  if (st === "compacting") return "Summing up the conversation to free space";
  if (st === "retrying") return d.retry ? `${d.retry.text ? `${esc(d.retry.text)} · ` : ""}retrying ${until(d.retry.at)}` : "Retrying by itself";
  if (st === "refreshing") return "Running the folder's refresh command";
  if (st === "stale") return `Nothing for ${age(s.state.since)}; the session may be gone`;
  if (st === "busy" && d.queued && !queuedOf(s).length) return queuedText(d.queued); // shown as themselves above
  return "";
}
const queuedText = n => `${n === 1 ? "Your message is" : `${esc(n)} messages are`} queued and ${n === 1 ? "goes" : "go"} to Claude at its next step`;
/* ---------- the session view: one panel (header, log, queue, the box as its last row), and the rail ---------- */
export const conv = document.getElementById("conv");
/* Builds the view's frame when the session or the subagent changed (the composer is made here, once
   per view, so data never resets typing, focus or attachments), then renders every panel. */
export function renderConv() {
  const s = cur();
  if (!s) {
    setMounted(null);
    conv.innerHTML = `<div class="missing"><p>${store.ui.connected ? "No open sessions." : "Connecting to the Synopia backend…"}</p></div>`;
    if (store.ui.connected) syncFixed(true); // no open session: the folder list is the main area (R3.12)
    return;
  }
  syncFixed(false);
  if (view) selectView(view); // dropped when the session no longer has that subagent, shell or monitor
  const key = `${s.id}|${view || ""}`;
  if (mounted !== key) {
    ui.leave(); // the draft of the view going away is kept (ui-state.js)
    setMounted(key);
    /* one panel from the title down (R5): the header, the log, and the box as its last row, under a 1px line */
    conv.innerHTML = `
    <div class="thread panel">
    <header class="c-head"></header>
    <div class="log" id="log"><div class="log-inner"></div></div>
    <div class="dock${view ? (typesTo(shownBg()) ? " runbox" : " nobox") : ""}"><div class="dock-inner">${view
      /* a subagent, shell or monitor view has no message box (R5.12): the dock shows only the prompt of a key
         that acts on the session (Esc, Esc; x, x), on the box's line. A run you or Synopia started has, while it
         runs, a `!` band in the box's place that types into it (bg-view.js runDockHTML, 2026-11-26). */
      ? (typesTo(shownBg()) ? runDockHTML(shownBg()) : `<div class="composer noinput"><span class="g">❯</span></div>`)
      : `<div class="composer"><div class="slash" id="slash" role="listbox" hidden></div>
        <div class="attach" style="grid-column:2"></div>
        <span class="g">❯</span><textarea id="msg" rows="1" aria-label="Message"></textarea>
      </div>`}
    </div></div>
    </div>`;
    if (view && mode === "insert") setMode("normal", false); // nothing to type in
    resetCard(); // the new dock has no card yet (card.js)
    mountComposer(s);
    watchTables(document.getElementById("log")); // markdown tables fit their reply (table-fit.js)
    ui.requestView(s.id, view);
    ui.expectReset(); // its stored scroll goes on once the items are in
  }
  renderHeader(); renderLog(); renderCard(); renderRail();
}
export function renderHeader() {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view), B = !A && shownBg();
  conv.querySelector(".c-head").innerHTML = B ? bgHeaderHTML(s, B, modelName()) // a shell or monitor (bg-view.js)
    : A
    ? `${titleWithCrumb(s, A.description)}
        <p class="c-now">${A.finished ? `${A.stopped ? "Stopped" : "Finished"}, ${took(agentMs(A))}` : `Running, ${live(A.start, agentMs(A))}`}. ${esc(agentType(A))}${A.model ? `, model ${esc(A.model)}` : ""}${A.fork ? ", started with a copy of the session's context" : ""}</p>
        <p class="c-meta">Subagent of “${esc(s.title)}”. Its report goes back to that session.</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelName())}</button></div>`
    : `<h2 class="c-title" title="${esc(s.title)}">${esc(s.title)}</h2>
        <p class="c-now"${s.now ? ` title="${esc(s.now)}"` : ""}>${isEmpty(s) || !s.now ? "&nbsp;" : `Now: ${esc(s.now)}`}</p>
        <p class="c-meta">Folder <span class="mono">${esc(s.cwd)}</span>${s.gone ? ', <span class="gone">folder gone</span>' : ""}${s.prs.length ? `, PRs ${s.prs.slice(-4).map(p => `#${esc(p)}`).join(" ")}` : ""}.${s.name ? ` Tab “${esc(s.name)}”.` : ""}</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelName())}</button></div>`;
  /* the subagent view's composer still sends to the main conversation, so it names the session */
  paintBash(s); // the placeholder: the message's, or bash mode's (composer.js)
}
/* a new session before its first turn: the header has the title and folder, the transcript nothing yet */
const isEmpty = s => !s.total && !s.items.length && !s.stream && !s.now;
function logEntries(s, A) {
  const items = A ? (A.items || []) : placeBangs(placeAsides(withPending(s.items, requestsOf(s), extAsk(s))), s);
  const hidden = A ? (A.total || 0) - (A.items || []).length : s.total - s.items.length;
  const out = [];
  onLive = A ? null : liveFg(s);
  if (hidden > 0) out.push(["earlier", earlierHTML(hidden)]);
  out.push(...itemsHTML(items, A ? !A.finished : s.state.light === "green", s));
  if (!A) out.push(...heldHTML(s));
  if (!A && s.stream) out.push(["stream", `<div class="ln claude"><span class="g">●</span><div class="md">${md(s.stream)}</div></div>`]);
  if (!A) out.push(...sentHTML(s)); // sent while idle: the new turn's prompt, at once, until its record lands
  /* the live line closes the transcript: a message the turn took in from its queue lands above it (R5.5) */
  out.push(["live", liveLine(s, A)]);
  if (!A) out.push(...queuedHTML(s)); // last: the block sticks to the log's bottom
  return out;
}
/* Earlier items: the server sends the page's last 160; the link asks for the 160 before the oldest
   shown (`earlier`, R5.12a), and they come back as `items` with `prepend`. */
const EARLIER = 160;
let earlierAsked = null; // "<sid>|<agent>|<before>" until its reply, so a second click sends nothing
const earlierHTML = hidden => `<p class="earlier"><button data-earlier>Show ${Math.min(EARLIER, +hidden)} earlier</button>${hidden > EARLIER ? ` (${+hidden} more)` : ""}</p>`;
export function loadEarlier() {
  const s = cur(); if (!s || !mounted) return false;
  if (shownBg()) return loadEarlierOutput(); // a shell's or monitor's earlier output (bg-view.js)
  const A = view && agentById(s, view), t = A || s, items = t.items || [];
  if (!items.length || (t.total || 0) <= items.length) return false;
  const key = `${s.id}|${view || ""}|${items[0].id}`;
  if (earlierAsked !== key && request({ t: "earlier", sid: s.id, agent: view || null, before: items[0].id })) earlierAsked = key;
  return true;
}
/* Renders the log after a prepend so the block you were reading stays where it was on screen. */
export function renderLogKeepingPlace() {
  earlierAsked = null;
  const log = document.getElementById("log"); if (!log) return renderLog();
  const inner = log.querySelector(".log-inner"), top = log.getBoundingClientRect().top;
  // a day separator's key moves with the first item of its day, so the anchor is an item's block
  const anchor = [...inner.children].find(el => !/^(earlier|day:|queue)/.test(el.dataset.key) && el.getBoundingClientRect().bottom > top);
  const key = anchor?.dataset.key, off = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const height = log.scrollHeight, was = log.scrollTop;
  renderLog();
  const el = key && [...inner.children].find(c => c.dataset.key === key);
  if (el) log.scrollTop += el.getBoundingClientRect().top - top - off;
  else log.scrollTop = was + log.scrollHeight - height; // the block was regrouped: keep the distance from the end
}
/* Appends new blocks and replaces changed ones by key; keeps the scroll at the bottom when it was within 40 px of it
   and you are looking (the window visible): a hidden window doesn't follow, so you come back to what you saw. */
export function renderLog() {
  const s = cur(); if (!s || !mounted || ui.holding()) return; // a view just mounted waits for its reset (ui-state.js)
  const log = document.getElementById("log");
  const follow = ui.atEnd(log) && document.visibilityState === "visible";
  const B = shownBg(); // a shell or monitor shows its output (bg-view.js)
  patchChildren(log.querySelector(".log-inner"), B ? bgLogEntries(s, B, runView) : logEntries(s, view && agentById(s, view)));
  if (B) syncRunDock(B); // the box's place follows the run: its `!` band while it can type
  ui.afterLog(); // open diffs and folds stay open (ui-state.js)
  fitTables(log);
  const sent = follow && takeSent(id => log.querySelector(`[data-key="q:${CSS.escape(id)}"]`) || landedBlock(id));
  if (sent) toEnd({ smooth: true }); // a message you sent at the end: you see it and the Working line (R5.5)
  else if (performance.now() < chasing) toEnd({ smooth: true }); // the end it scrolls to grew meanwhile
  else if (follow) log.scrollTop = log.scrollHeight;
  ui.note(log); // where you are and what you saw (ui-state.js)
  paintBash(s); // the placeholder counts the messages that wait
}
/* a sent message's prompt block, once its record replaced the sent band */
const landedBlock = id => { const o = (cur()?.outbox || []).find(q => q.id === id); return o?.landed ? conv.querySelector(`#log [data-key="you:${CSS.escape(o.landed)}"]`) : null; };
/* G, and a message you send: the end of the log. `smooth` scrolls there (a jump with reduced motion), and for a
   moment after, a render that makes the log longer scrolls on to its new end */
let chasing = 0;
export function toEnd({ smooth = false } = {}) {
  const log = document.getElementById("log"); if (!log) return;
  smooth &&= !matchMedia("(prefers-reduced-motion: reduce)").matches;
  chasing = smooth ? performance.now() + 600 : 0;
  if (smooth) log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }); else log.scrollTop = log.scrollHeight;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ui.note(document.getElementById("log")); });
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
  from.querySelectorAll(".diff[id]:not([hidden])").forEach(d => {
    const n = to.querySelector(`#${CSS.escape(d.id)}`); if (!n) return;
    n.hidden = false; to.querySelector(`[aria-controls="${CSS.escape(d.id)}"]`)?.setAttribute("aria-expanded", "true");
  });
}
/* one click handler for the whole view, so redrawn panels need no rebinding */
conv.addEventListener("click", e => {
  const rv = e.target.closest(".rail .rv"); // a "To review" card: anywhere on it but "Mark reviewed" goes to the report
  if (rv && !e.target.closest("[data-reviewed]")) { e.preventDefault(); e.stopPropagation(); toReport(rv.querySelector(".rv-open").dataset.agent); return; }
  const t = e.target.closest(".frow .fc, [data-earlier], [data-full], [data-agent],[data-back], [data-back-main], [data-reviewed], [data-bg], [data-unattach], [data-session], #model-label");
  if (!t || t.closest(".qa-card")) return;
  if (t.hasAttribute("data-earlier")) loadEarlier();
  else if (t.dataset.full) showAll(t.dataset.full);
  else if (t.matches(".fc")) {
    const d = document.getElementById(t.getAttribute("aria-controls")); d.hidden = !d.hidden; t.setAttribute("aria-expanded", !d.hidden);
  } else if (t.dataset.session) { e.preventDefault(); e.stopPropagation(); showSession(t.dataset.session); }
  else if (t.dataset.agent) {
    e.preventDefault(); e.stopPropagation();
    selectView(t.dataset.agent); renderConv();
  }
  else if (t.hasAttribute("data-back") || t.hasAttribute("data-back-main")) { selectView(null); renderConv(); }
  else if (t.dataset.reviewed) { e.stopPropagation(); act({ t: "reviewed", agentId: t.dataset.reviewed }); } // the backend sends the subagent back with review false
  else if (t.dataset.bg) { if (e.target.closest("a[href]")) return; selectView(t.dataset.bg); renderConv(); } // a shell or monitor opens in the pane, as a subagent does (R7.2)
  else if (t.dataset.unattach) unattach(+t.dataset.unattach); // with its [Image #N] tag (composer.js)
  else if (t.id === "model-label") { if (view) { selectView(null); renderConv(); } openModelPicker(); } // the session's model: picked in Main conversation, where the box is
});
/* A "To review" card (R7.1): Main conversation, scrolled so that subagent's "Report from" block is near the top,
   briefly marked; its own transcript when this session's transcript has no report from it. Nothing is marked
   reviewed. */
function toReport(id) {
  const s = cur(); if (!s || !id) return;
  if (view) { selectView(null); renderConv(); }
  ui.jumpTo(`${s.id}|`, `report:${id}`, found => {
    if (found) markJump(`report:${id}`);
    else if (cur()?.id === s.id) { selectView(id); renderConv(); }
  });
}
/* the block a jump landed on: the selection tint with the 1px blue ring of b, b, held, then faded (css .jump-mark) */
const JUMP_HOLD = 1500, JUMP_FADE = 600;
function markJump(key) {
  const el = document.querySelector(`#log .log-inner > [data-key="${CSS.escape(key)}"]`); if (!el) return;
  clearTimeout(el._jump); el.classList.remove("fading"); el.classList.add("jump-mark");
  el._jump = setTimeout(() => { el.classList.add("fading"); el._jump = setTimeout(() => el.classList.remove("jump-mark", "fading"), JUMP_FADE); }, JUMP_HOLD);
}
/* a step opened or closed by a click: remembered by item id, so a redraw keeps it (toggle doesn't bubble) */
conv.addEventListener("toggle", e => {
  const d = e.target; if (!d.dataset || !d.dataset.step) return;
  if (d.open) openSteps.add(stepKey(d.dataset.step)); else openSteps.delete(stepKey(d.dataset.step));
  // a running step and the live line naming it are one step: both follow
  conv.querySelectorAll(`details[data-step="${CSS.escape(d.dataset.step)}"]`).forEach(o => { if (o !== d && o.open !== d.open) o.open = d.open; });
}, true);
/* the page never navigates: a file goes to the backend as `open` with its path, a link with its URL
   (docs/WKWebView and AppKit.md, "Links and navigation"), so the app and Chrome behave the same */
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest("a[href]"); if (!a) return;
  e.preventDefault();
  if (a.dataset.path) { if (!previewClick(a, e)) request({ t: "open", path: a.dataset.path }); } // text: the preview (preview.js)
  else if (/^https?:/i.test(a.getAttribute("href"))) request({ t: "open", url: a.href });
}, true);
