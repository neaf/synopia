/* The view of a background shell or monitor (requirements R7.2): it opens from the background panel as a
   subagent does, in the same pane. The header says what it is and how it runs; the log is its command, then its
   output in a terminal (term.js, 2026-11-27: colours, cursor moves and progress bars drawn, its own scrollback;
   earlier output loads on asking, as earlier items do), growing while it runs, then how it ended. The backend
   sends the output (`output` frames for Claude's shells and monitors, `term` frames for a run Synopia holds a
   pty for, publisher.ts); this module holds what the page has of it, per shell or monitor. Every run opens here
   (2026-11-26, runs.js): a `!` command of yours (state.js ownBg, R5.13), Claude's foreground Bash step
   (state.js stepBg) with its result, and the credential refresh (state.js credsBg). Yours and the refresh are
   a real terminal while they run (2026-11-27, the user: "It should behave more like normal terminal"): in
   insert mode (i, a, a click in it) every key goes to the program as typed, Ctrl-C too; one Esc goes to normal
   mode, where an Esc goes to the program as ESC. The box's place says which mode it is (runDockHTML). Claude's
   shells and monitors are read-only. Claude's command line has the grey `$` in the gutter. */
import { store, cur, view, bgById, agentById, nowish, credsOf } from "./state.js";
import { request, send } from "./connection.js";
import { esc, lineHTML, markAt, live, took, hhmm } from "./format.js";
import { ind } from "./marks.js";
import { bgState } from "./runs.js";
import { feed, mountTerm, unmountTerm, termOn, focusTerm, sendKeys, scrollTerm, termTop, termEnd } from "./term.js";

/* "<sid>|<tool use id>" -> { text, from, to, total, lost }: the part of the output the page has, [from, to)
   of total (bytes for a shell, events for a monitor) */
const outs = new Map();
let earlierAsked = null; // "<sid>|<bg>|<before>" until its reply, so a second click sends nothing

/* the shell or monitor on screen, or null */
export const shownBg = () => { const s = cur(); return s && view ? bgById(s, view) || null : null; };
/* where the output the page has of it begins, for the view request after a reload (ui-state.js) */
export const outFrom = (sid, bg) => outs.get(`${sid}|${bg}`)?.from ?? null;

/* Where each line of the output the page has ends: the offset after its line feed (bytes for a shell, events for
   a monitor), for what you saw of it (ui-state.js). The line still being written ends at `to`. */
export function outEnds(sid, bg) {
  const o = outs.get(`${sid}|${bg}`); if (!o) return [];
  if (o.ends && o.endsOf === `${o.from}|${o.text.length}`) return o.ends;
  const mon = bgById(store.sessions.get(sid), bg)?.kind === "monitor", ends = [];
  let at = o.from;
  for (let i = 0; i < o.text.length; i++) {
    const c = o.text.charCodeAt(i);
    if (mon) { if (c === 10) ends.push(o.from + ends.length + 1); continue; }
    at += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xDC00 && c < 0xE000 ? 2 : c >= 0xD800 && c < 0xDC00 ? 2 : 3; // UTF-8: a surrogate pair is 4
    if (c === 10) ends.push(at);
  }
  o.ends = ends; o.endsOf = `${o.from}|${o.text.length}`;
  return ends;
}
/* the line of the output the page has that begins at `at`; -1 when that isn't on the page */
export function lineAt(sid, bg, at) {
  const o = outs.get(`${sid}|${bg}`); if (!o || at < o.from || at > o.to) return -1;
  const ends = outEnds(sid, bg); let n = 0;
  while (n < ends.length && ends[n] <= at) n++;
  return n;
}

/* an `output` frame; returns whether it is the view on screen */
export function applyOutput(m) {
  const key = `${m.sid}|${m.bg}`, o = outs.get(key);
  const mon = bgById(store.sessions.get(m.sid), m.bg)?.kind === "monitor";
  const join = (a, b) => mon && a && b ? `${a}\n${b}` : a + b; // a monitor's events are lines
  if (m.reset || !o) { outs.set(key, { text: m.text, err: m.err || "", from: m.from, to: m.to, total: m.total, lost: m.lost || null }); feed(m.bg, m.text, { reset: true, eol: true }); }
  else if (m.prepend) {
    earlierAsked = null;
    if (m.to !== o.from) return false;
    o.text = join(m.text, o.text); o.from = m.from; o.total = Math.max(o.total, m.total);
    feed(m.bg, o.text, { reset: true, eol: true, keep: true }); // a terminal draws from the start: all of it again, the place kept
  } else {
    if (m.from !== o.to) return false; // a part after one this page missed: the next reset has it
    feed(m.bg, mon && o.text && m.text ? `\n${m.text}` : m.text, { eol: true });
    o.text = join(o.text, m.text); o.to = m.to; o.total = Math.max(o.total, m.total);
  }
  const s = cur();
  return !!s && s.id === m.sid && view === m.bg;
}

/* A `term` frame: the raw stream of a run Synopia holds a pty for (terms.ts), for its terminal. Returns whether
   its view is on screen and the log should be drawn again (its first frame, its end). */
const termLive = new Map(); // run id -> its pty still runs
export function applyTerm(m) {
  const was = termLive.get(m.bg);
  feed(m.bg, m.data, { reset: !!m.reset });
  termLive.set(m.bg, !!m.live);
  const s = cur();
  return !!s && s.id === m.sid && view === m.bg && (!!m.reset || was !== !!m.live);
}

/* Asks for the output before what the page has (the link, or g at the top); false when it has it all. */
export function loadEarlierOutput() {
  const s = cur(), b = shownBg(); if (!s || !b) return false;
  const o = outs.get(`${s.id}|${b.toolUseId}`); if (!o || o.from <= 0) return false;
  const key = `${s.id}|${b.toolUseId}|${o.from}`;
  if (earlierAsked !== key && request({ t: "earlierOutput", sid: s.id, bg: b.toolUseId, before: o.from })) earlierAsked = key;
  return true;
}

const kb = n => n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const kindWord = b => b.own ? "Your shell command" : b.step ? "Shell in Claude's turn" : b.creds ? "Shell" : b.kind === "monitor" ? (b.persistent ? "Monitor, until the session ends" : "Monitor") : "Background shell";
/* how it ended, as the panel words it (rail.js bgState): the word, its status mark */
const ENDS = { done: ["Finished", "done"], failed: ["Failed", "failed"], stopped: ["Stopped", "stopped"], killed: ["Stopped", "stopped"], "timed out": ["Timed out", "timeout"] };
const endOf = st => ENDS[st] || ["Finished", "done"];
const msOf = (b, st) => (b.end ? new Date(b.end) : st === "timed out" ? new Date(new Date(b.start).getTime() + b.timeout) : nowish) - new Date(b.start);

/* The title line of every view but the main conversation (R5.12, R7.2, 2026-11-26): "‹ <session title>", the
   one way back to Main conversation in the header, then the view's own title. It sits on the title's line, so
   the header keeps the main conversation's three lines (R5.1). */
export const titleWithCrumb = (s, title, shown = title) => `<h2 class="c-title"><button class="link c-crumb" data-back title="Back to the main conversation">‹ ${esc(s.title)}</button><span class="c-name" title="${esc(title)}">${esc(shown)}</span></h2>`;

/* The header: its name, how it runs, and whose it is, on the lines a subagent's header uses (R5.1). */
export function bgHeaderHTML(s, b, modelLabel) {
  const st = bgState(b), ms = msOf(b, st), owner = b.agentId && agentById(s, b.agentId);
  const now = st === "running" ? `${b.waiting ? "Waits for input" : "Running"}, ${live(b.start, ms)}` : `${endOf(st)[0]}, ${took(ms)}`;
  const back = `“${esc(s.title)}”`;
  const whose = owner ? `of the subagent <button class="link" data-agent="${esc(owner.id)}" title="Open its transcript">${esc(owner.description)}</button> in ${back}` : `in ${back}`;
  const f = b.creds ? credsOf(s.id) : null, n = f ? f.sids.length : 0;
  const hears = b.own ? "Claude gets the command and its output when it ends." : b.creds ? `Synopia runs it for ${n === 1 ? "this session" : `the ${n} sessions`} in ${esc(b.creds)} when their sign-in expires.`
    : b.step ? (st === "running" ? "Claude waits for it." : "Claude read its result.") : b.kind === "monitor" ? "Claude hears each event." : "Claude hears when it ends.";
  const title = b.own || b.creds ? b.command : b.description || b.command;
  return `${titleWithCrumb(s, title, b.creds ? "Refresh credentials" : title)}
        <p class="c-now">${now}. ${kindWord(b)}, started ${b.creds ? "by Synopia " : ""}${hhmm(b.start)}.</p>
        <p class="c-meta">${hears} ${b.kind === "monitor" ? "Monitor" : "Shell"} ${whose}</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelLabel)}</button></div>`;
}

/* The log's blocks, [key, html] as transcript.js patches them: earlier output, the run (its command, then
   its output under the drawn guide, runView's), and the live line while it runs or how it ended. */
export function bgLogEntries(s, b, runView) {
  if (b.own) return ownLogEntries(s, b, runView);
  if (b.step) return stepLogEntries(s, b, runView);
  if (b.creds) return credsLogEntries(s, b, runView);
  const o = outs.get(`${s.id}|${b.toolUseId}`), st = bgState(b), running = st === "running", out = [];
  if (o && o.from > 0) out.push(["earlier", `<p class="earlier"><button data-earlier>Show earlier output</button> (${b.kind === "monitor" ? `${+o.from} more events` : `${kb(o.from)} more`})</p>`]);
  const lost = o && o.lost ? (o.lost === "gone" ? "Its output file is gone: macOS clears temporary files." : "The transcript names no output file for it.") : "";
  const tool = b.kind === "monitor" ? "Monitor" : "Bash";
  const run = runView({ input: b.command, out: null, stopped: false });
  const lostRow = lost ? `<div class="res"><span class="lcorner" aria-hidden="true"></span><span>${esc(lost)}</span></div>` : "";
  out.push(["run", `<div class="ln tool bg-run ${running ? "running" : "done"}"><span class="g"${markAt(b.start)}>●</span><div>${lineHTML(`<span class="name">${tool}</span>(`, esc(b.description || b.command.split("\n")[0]), ")")}</div>${PS}${run.replace(/<\/div>$/, `${lostRow}</div>`)}</div>`]);
  if (o && !lost) out.push(["term", termBox(b)]);
  out.push(running ? ["live", liveRun(b, b.kind === "monitor" && o ? `, ${+o.total} event${o.total === 1 ? "" : "s"}` : "")] : ["end", endLine(b, st)]);
  return out;
}

/* The terminal's place in the log: an empty box term.js draws into, the same html each time so a redraw of the
   log keeps it (transcript.js patchChildren). `data-pty`: a run Synopia holds a pty for, which takes keys. */
const termBox = b => `<div class="term-box${b.own || b.creds ? " pty" : ""}" data-term="${esc(b.toolUseId)}"></div>`;
/* a run with a terminal that takes keys: yours or the refresh, while its pty runs */
const ptyLive = b => !!b && !!(b.own || b.creds) && bgState(b) === "running" && termLive.get(b.toolUseId) !== false;

/* Claude's command line: a grey `$` in the gutter under the step's dot, as the permission card shows a command */
const PS = `<span class="g ps" aria-hidden="true">$</span>`;
/* the live line while it runs: Running, or Waits for input in red with the pause mark of needs you */
const liveRun = (b, extra = "") => b.waiting
  ? `<div class="ln liveln" data-state="red"><span class="g"${markAt(b.start)}>${ind("pause")}</span><div><b>Waits for input</b> <span class="dim">${live(b.start, msOf(b, "running"))}</span></div></div>`
  : `<div class="ln liveln" data-state="green"><span class="g"${markAt(b.start)}>${ind(b.kind === "monitor" ? "k_mon" : "k_shell")}</span><div><b>Running</b> <span class="dim">${live(b.start, msOf(b, "running"))}${extra}</span></div></div>`;
const endLine = (b, st) => { const [word, mark] = endOf(st), sum = (b.summary || "").trim();
  return `<div class="ln doneln bg-end${st === "failed" ? " failed" : ""}"><span class="g"${markAt(b.end || b.start)}>${ind(mark)}</span><div>${word} after ${took(msOf(b, st))}${b.end ? `, ${hhmm(b.end)}` : ""}${sum ? `. ${esc(sum)}` : ""}</div></div>`; };

/* Claude's foreground Bash (a step of its turn): the command, then its result once it has one. The SDK reports only
   its elapsed time while it runs, so the view says what it can show and how to see more; a cut result is read
   again whole (`toolOutput`, the reply comes through applyStepOutput). */
const stepFull = new Map(); // "<sid>|<tool use id>" -> the whole result
let stepAsked = null;
export function applyStepOutput(m) { if (!m.agent) stepFull.set(`${m.sid}|${m.toolUseId}`, String(m.text ?? "")); if (stepAsked === `${m.sid}|${m.toolUseId}`) stepAsked = null; }
function stepLogEntries(s, b, runView) {
  const t = (s.items || []).find(i => i.id === b.toolUseId), st = bgState(b), running = st === "running", key = `${s.id}|${b.toolUseId}`;
  const o = t?.out, full = stepFull.get(key);
  if (o?.cut && full === undefined && stepAsked !== key && request({ t: "toolOutput", sid: s.id, agent: null, toolUseId: b.toolUseId })) stepAsked = key;
  const text = full ?? o?.text ?? "";
  const note = s.state.driven ? "Output shows when it finishes. b, b sends it to the background, where its output shows as it comes." : "";
  const run = running ? `<div class="step-out"><div class="cmd">${esc(b.command)}</div>${note ? `<div class="res note"><span class="lcorner" aria-hidden="true"></span><span class="note">${esc(note)}</span></div>` : ""}</div>`
    : st === "failed" ? runView({ input: b.command, err: text }) : runView({ input: b.command, out: text });
  const out = [["run", `<div class="ln tool bg-run ${running ? "running" : st === "failed" ? "failed" : "done"}"><span class="g"${markAt(b.start)}>●</span><div>${lineHTML(`<span class="name">Bash</span>(`, esc(b.description || b.command.split("\n")[0]), ")")}</div>${PS}${run}</div>`]];
  out.push(running ? ["live", liveRun(b)] : ["end", endLine(b, st)]);
  return out;
}

/* the credential refresh: its lock in the gutter says Synopia started it, as `!` says you did; then its terminal */
function credsLogEntries(s, b, runView) {
  const run = runView({ input: b.command, out: null });
  return [["run", `<div class="ln tool bg-run running"><span class="g"${markAt(b.start)}>${ind("creds")}</span><div><span class="name">Refresh credentials</span>${run}</div></div>`],
    ["term", termBox(b)], ["live", liveRun(b)]];
}

/* A `!` run of yours: the command on the prompt band as in the transcript, its terminal, then the live line while
   it runs (the box's place says the terminal's mode, runDockHTML), or how it ended. */
function ownLogEntries(s, b, runView) {
  const st = bgState(b), running = st === "running", out = [];
  out.push(["run", `<div class="bang bg-run ${running ? "running" : "done"}" data-bang="${esc(b.toolUseId)}"><div class="prompt bang-cmd"><span class="g"${markAt(b.start)}>!</span><div class="cmd">${esc(b.command)}</div></div></div>`]);
  out.push(["term", termBox(b)]);
  out.push(running ? ["live", liveRun(b)] : ["end", endLine(b, st)]);
  void runView;
  return out;
}

/* The box's place in the shell view of your running `!` command or the refresh (R5.13, R7.2, 2026-11-27): the
   terminal's mode, in the message box's mode style (R9.2): in normal mode at half strength, in insert mode the
   band's fill with bash mode's pink edge and `!`. A click there types to the command, as one in the terminal. */
export const typesTo = b => ptyLive(b);
export const runDockHTML = () => `<div class="composer bash term-mode" data-term-mode><span class="g">!</span><p class="tm-say"><span class="tm-n"><kbd>i</kbd> or a click types to the command. <kbd>Esc</kbd> sends it Esc.</span><span class="tm-i">Every key goes to the command, <kbd>Ctrl</kbd>-<kbd>C</kbd> too. <kbd>Esc</kbd> for normal mode.</span></p></div>`;
/* After each redraw of the log (renderLog calls it): the dock follows the run, its mode line while it takes keys,
   the plain line once it ended; the terminal is drawn into its box. */
export function syncRunDock(b) {
  syncTerm(b);
  const dock = document.querySelector("#conv .dock.nobox, #conv .dock.runbox"), inner = dock?.querySelector(".dock-inner"); if (!inner) return;
  const want = typesTo(b), has = !!inner.querySelector("[data-term-mode]");
  if (want === has) return;
  dock.classList.toggle("runbox", want); dock.classList.toggle("nobox", !want);
  inner.innerHTML = want ? runDockHTML(b) : `<div class="composer noinput"><span class="g">❯</span></div>`;
}
function syncTerm(b) {
  const box = document.querySelector("#log .term-box");
  if (!box) { unmountTerm(); return; }
  const s = cur(), id = b.toolUseId, writable = ptyLive(b);
  mountTerm(box, { id, writable, eol: !(b.own || b.creds),
    onKeys: d => { if (s) send({ t: "termInput", sid: s.id, bg: id, data: d }); },
    onSize: (cols, rows) => { if (s && (b.own || b.creds)) send({ t: "termSize", sid: s.id, bg: id, cols, rows }); } });
}
document.addEventListener("click", e => { if (e.target.closest?.("[data-term-mode]")) focusTerm(); });
/* i or a in the shell view: the terminal takes the keys (keys.js); false when the view has none that does */
export const focusRunInput = () => focusTerm();
/* A key in normal mode in a shell view with a terminal (keys.js, after a prompt's keys): Esc goes to the program as
   ESC (2026-11-27, the user: "Esc in normal mode sends esc sequence to terminal"), and the view stays in normal
   mode; j/k scroll its scrollback, g/G go to its top (then earlier output) or its end. True when taken. */
export function termKey(e) {
  const t = termOn(); if (!t || e.metaKey || e.ctrlKey || e.altKey) return false;
  const b = shownBg();
  if (e.key === "Escape") { if (!ptyLive(b)) return false; e.preventDefault(); sendKeys("\x1b"); return true; }
  const k = { j: () => scrollTerm(3), k: () => scrollTerm(-3), G: () => termEnd(), g: () => { if (termTop()) loadEarlierOutput(); } }[e.key];
  if (!k) return false;
  e.preventDefault(); k(); return true;
}
