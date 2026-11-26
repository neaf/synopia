/* Runs (requirements R5.6, R5.13, R7.1, R7.2, 2026-11-26; prototype/shell-storyboard.html): a shell command you or
   Synopia started, in one shape. A run is one row: its command line (yours on the pink `!` band, Synopia's refresh
   with its lock), its last 3 lines of output, and a state line with a status mark. The row opens the run's shell
   view (bg-view.js), the only place for its whole output, its input and its stop. Claude's Bash and Monitor steps
   are steps in the transcript instead (transcript.js, 2026-11-26, the user's decision); their state and the who
   sign of the panel's cards are here too. The backend owns every fact here (when a run's card shows, whether it
   waits for input); this module only words and draws them. */
import { nowish } from "./state.js";
import { esc, markAt, live, took } from "./format.js";
import { ind } from "./marks.js";
import { linkText } from "./md.js";

const TAIL = 3; // the lines a row shows

/* how a background shell or monitor stands: running, or how it ended (a monitor past its deadline timed out) */
export function bgState(b) {
  if (b.status && b.status !== "running") return b.status === "completed" ? "done" : b.status;
  if (b.kind === "monitor" && b.timeout && !b.persistent && new Date(b.start).getTime() + b.timeout < nowish) return "timed out";
  return "running";
}

/* the sign for who started a run, before a card's or Past line's name: your `!` in bash pink, Synopia's lock,
   nothing for Claude's */
export const whoHTML = who => who === "you" ? `<span class="who" aria-label="started by you">!</span>`
  : who === "synopia" ? `<span class="who lock" aria-label="started by Synopia">${ind("creds")}</span>` : "";

/* a run's card is due (runs.ts cardAt, the backend's): 3 s after its start, or once it waited for input */
export const cardDue = b => b.cardAt !== null && b.cardAt !== undefined && b.cardAt <= nowish;

const lines = t => t ? String(t).replace(/\n+$/, "").split("\n") : [];
/* the last lines of stdout and stderr together, TAIL at most, stderr's last (it says what went wrong) */
function tailOf(out, err) {
  const e = lines(err).slice(-TAIL), n = TAIL - e.length, o = n > 0 ? lines(out).slice(-n) : [];
  return { out: o.join("\n"), err: e.join("\n"), shown: o.length + e.length };
}

/* The state line: [mark, words, class, hint]. `ms` how long it ran or runs; `start` for a live timer. */
const dur = (r) => r.start && r.running ? live(new Date(r.start).toISOString(), nowish - r.start) : r.ms !== null && r.ms !== undefined ? took(r.ms) : "";
function stateOf(r) {
  const t = dur(r), at = t ? `, ${t}` : "", after = t ? ` after ${t}` : "";
  if (r.running && r.waiting) return ["pause", `Waits for input${at}`, "waits"];
  if (r.running) return ["k_shell", `Running${at}`, "", r.quiet ? "· may wait for input" : ""];
  if (r.end === "stopped") return ["stopped", `Stopped${r.byYou ? " by you" : ""}${after}`, ""];
  if (r.end === "failed") return ["failed", r.exit ? `Exit code ${esc(r.exit)}${after}` : `Failed${after}`, "failed"];
  return ["done", `Finished${at}${r.lines && r.lines > r.shown ? `, ${(+r.lines).toLocaleString("en-US")} lines` : ""}`, ""];
}

/* the preview under the command: the last lines (stderr red with its 1px rule), its notes, the state line */
function preview(r) {
  const rows = [];
  if (r.tail) rows.push([`<span class="out">${linkText(r.tail)}</span>`, ""]);
  if (r.err) rows.push([`<span class="out err">${linkText(r.err)}</span>`, ""]);
  for (const n of r.extra || []) rows.push([`<span>${esc(n)}</span>`, r.extraCls || ""]);
  const st = stateOf(r);
  rows.push([`<span>${ind(st[0])}<span>${st[1]}</span>${st[3] ? ` <span class="rhint">${st[3]}</span>` : ""}</span>`, `rst ${st[2]}`]);
  const res = ([html, cls], i) => `<div class="res${cls ? ` ${cls}` : ""}">${i === 0 ? `<span class="lcorner" aria-hidden="true"></span>` : "<span></span>"}${html}</div>`;
  return `<div class="step-out">${rows.map(res).join("")}</div>`;
}

/* your run: the command on the `!` band, the preview under it; a run over at once with nothing to say is the band alone */
export function ownRowHTML(r, { open = null, attrs = "", at = null } = {}) {
  const link = open ? ` data-bg="${esc(open)}" title="Open its shell view"` : "";
  const alone = !r.running && r.end === "done" && !r.tail && !r.err && !(r.extra || []).length;
  return `<div class="bang runrow${r.running ? " running" : ""}"${link}${attrs}><div class="prompt bang-cmd"><span class="g"${markAt(at)}>!</span><div class="cmd">${esc(r.cmd)}</div></div>`
    + `${alone ? "" : `<div class="bang-res">${preview(r)}</div>`}</div>`;
}

/* the credential refresh's run, in its dock line (creds-line.js): the same preview under its command */
export const credsRunHTML = (r, open) => `<div class="runrow step-out" data-bg="${esc(open)}" title="Open its shell view"><div class="cmd">${esc(r.cmd)}</div>${preview(r).replace(/^<div class="step-out">|<\/div>$/g, "")}</div>`;

/* your `!` run: the session's live one (session.ts BangMeta with its output), or one the transcript recorded (`sh`) */
export function ownRun(cmd, run, sh) {
  const out = sh?.out ?? run?.out ?? "", err = sh?.err ?? run?.err ?? "", running = Boolean(run?.running);
  const { out: tail, err: etail, shown } = tailOf(out, err);
  const exit = sh?.exit ?? run?.exit ?? null, stopped = Boolean(run?.interrupted || sh?.interrupted);
  const r = { tool: "", kind: "shell", desc: "", cmd, tail, err: etail, shown, running, waiting: running && Boolean(run?.waiting), quiet: running && Boolean(run?.quiet),
    start: run?.at ?? null, ms: run && run.end ? run.end - run.at : null, end: running ? null : stopped ? "stopped" : exit !== null && +exit !== 0 ? "failed" : "done",
    exit: exit !== null && +exit !== 0 ? String(exit) : "", byYou: true, lines: lines(out).length + lines(err).length, extra: [] };
  if (sh?.cut || run?.cut) r.extra.push("Output cut at 30,000 characters");
  if (run?.error) { r.extra.push(run.error); r.extraCls = "failed"; }
  return r;
}

/* the credential refresh of the session's folder (creds.ts frame), while it runs */
export function credsRun(f) {
  const { out: tail, err, shown } = tailOf(f.output, "");
  return { tool: "", kind: "shell", desc: "Refresh credentials", cmd: f.command || "the refresh command", tail, err, shown, running: true, waiting: Boolean(f.waiting), quiet: Boolean(f.quiet),
    start: f.at || null, ms: null, end: null };
}
