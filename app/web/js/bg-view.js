/* The view of a background shell or monitor (requirements R7.2): it opens from the background panel as a
   subagent does, in the same pane. The header says what it is and how it runs; the log is its output as a
   terminal run, the whole of it from the start (earlier output loads on asking, as earlier items do),
   growing while it runs, then how it ended. The backend sends the output (`output` frames, publisher.ts);
   this module holds what the page has of it, per shell or monitor. A `!` command of yours (state.js ownBg, R5.13)
   opens here the same way, with its whole output (stdout, then stderr apart) and, while it runs, an input line
   that types into its terminal (bangInputHTML). */
import { store, cur, view, bgById, agentById, nowish } from "./state.js";
import { request, act } from "./connection.js";
import { toast } from "./toast.js";
import { esc, live, took, hhmm } from "./format.js";
import { ind } from "./marks.js";
import { bgState } from "./rail.js";

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
  if (m.reset || !o) outs.set(key, { text: m.text, err: m.err || "", from: m.from, to: m.to, total: m.total, lost: m.lost || null });
  else if (m.prepend) {
    earlierAsked = null;
    if (m.to !== o.from) return false;
    o.text = join(m.text, o.text); o.from = m.from; o.total = Math.max(o.total, m.total);
  } else {
    if (m.from !== o.to) return false; // a part after one this page missed: the next reset has it
    o.text = join(o.text, m.text); o.to = m.to; o.total = Math.max(o.total, m.total);
  }
  const s = cur();
  return !!s && s.id === m.sid && view === m.bg;
}

/* Asks for the output before what the page has (the link, or g at the top); false when it has it all. */
export function loadEarlierOutput() {
  const s = cur(), b = shownBg(); if (!s || !b) return false;
  const o = outs.get(`${s.id}|${b.toolUseId}`); if (!o || o.from <= 0) return false;
  const key = `${s.id}|${b.toolUseId}|${o.from}`;
  if (earlierAsked !== key && request({ t: "earlierOutput", sid: s.id, bg: b.toolUseId, before: o.from })) earlierAsked = key;
  return true;
}

/* The command's output as a terminal shows it, in plain text: escape sequences (colours, cursor moves,
   titles) taken out, and a line a carriage return rewrote (a progress bar) shown as it ended. */
export function plain(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC: a title, a link
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: colours, cursor moves
    .replace(/\x1b[@-Z\\-_]/g, "")
    .split("\n").map(l => { const t = l.endsWith("\r") ? l.slice(0, -1) : l, i = t.lastIndexOf("\r"); return i < 0 ? t : t.slice(i + 1); }).join("\n");
}

const kb = n => n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const kindWord = b => b.own ? "Your shell command" : b.kind === "monitor" ? (b.persistent ? "Monitor, until the session ends" : "Monitor") : "Background shell";
/* how it ended, as the panel words it (rail.js bgState): the word, its status mark */
const ENDS = { done: ["Finished", "done"], failed: ["Failed", "failed"], stopped: ["Stopped", "stopped"], killed: ["Stopped", "stopped"], "timed out": ["Timed out", "timeout"] };
const endOf = st => ENDS[st] || ["Finished", "done"];
const msOf = (b, st) => (b.end ? new Date(b.end) : st === "timed out" ? new Date(new Date(b.start).getTime() + b.timeout) : nowish) - new Date(b.start);

/* The header: its name, how it runs, and whose it is, on the lines a subagent's header uses (R5.1). */
export function bgHeaderHTML(s, b, modelLabel) {
  const st = bgState(b), ms = msOf(b, st), owner = b.agentId && agentById(s, b.agentId);
  const now = st === "running" ? `Running, ${live(b.start, ms)}` : `${endOf(st)[0]}, ${took(ms)}`;
  const back = `<button class="link" data-back title="Back to the main conversation">‹ ${esc(s.title)}</button>`;
  const whose = owner ? `of the subagent <button class="link" data-agent="${esc(owner.id)}" title="Open its transcript">${esc(owner.description)}</button> in ${back}` : `in ${back}`;
  const hears = b.own ? "Claude gets the command and its output when it ends." : b.kind === "monitor" ? "Claude hears each event." : "Claude hears when it ends.";
  return `<h2 class="c-title" title="${esc(b.description || b.command)}">${esc(b.description || b.command)}</h2>
        <p class="c-now">${now}. ${kindWord(b)}, started ${hhmm(b.start)}.</p>
        <p class="c-meta">${hears} ${b.kind === "monitor" ? "Monitor" : "Shell"} ${whose}</p>
      <div class="c-acts"><button class="btn quiet model-btn" id="model-label" title="Change the model (same as /model)">${esc(modelLabel)}</button></div>`;
}

/* The log's blocks, [key, html] as transcript.js patches them: earlier output, the run (its command, then
   its output under the drawn guide, runView's), and the live line while it runs or how it ended. */
export function bgLogEntries(s, b, runView) {
  if (b.own) return ownLogEntries(s, b, runView);
  const o = outs.get(`${s.id}|${b.toolUseId}`), st = bgState(b), running = st === "running", out = [];
  if (o && o.from > 0) out.push(["earlier", `<p class="earlier"><button data-earlier>Show earlier output</button> (${b.kind === "monitor" ? `${+o.from} more events` : `${kb(o.from)} more`})</p>`]);
  const lost = o && o.lost ? (o.lost === "gone" ? "Its output file is gone: macOS clears temporary files." : "The transcript names no output file for it.") : "";
  const text = o && !lost ? plain(o.text) : "";
  const tool = b.kind === "monitor" ? "Monitor" : "Bash";
  const run = runView({ input: b.command, out: !o || lost || (running && !text) ? null : text, stopped: false });
  const lostRow = lost ? `<div class="res"><span class="lcorner" aria-hidden="true"></span><span>${esc(lost)}</span></div>` : "";
  out.push(["run", `<div class="ln tool bg-run ${running ? "running" : "done"}" data-end="${o ? +o.to || 0 : 0}"><span class="g">●</span><div><span class="name">${tool}</span>(${esc(b.description || b.command.split("\n")[0])})${run.replace(/<\/div>$/, `${lostRow}</div>`)}</div></div>`]);
  if (running) out.push(["live", `<div class="ln liveln" data-state="green"><span class="g">${ind(b.kind === "monitor" ? "k_mon" : "k_shell")}</span><div><b>Running</b> <span class="dim">${live(b.start, msOf(b, st))}${b.kind === "monitor" && o ? `, ${+o.total} event${o.total === 1 ? "" : "s"}` : ""}</span></div></div>`]);
  else {
    const [word, mark] = endOf(st), sum = (b.summary || "").trim();
    out.push(["end", `<div class="ln doneln bg-end${st === "failed" ? " failed" : ""}"><span class="g">${ind(mark)}</span><div>${word} after ${took(msOf(b, st))}${b.end ? `, ${hhmm(b.end)}` : ""}${sum ? `. ${esc(sum)}` : ""}</div></div>`]);
  }
  return out;
}

/* A `!` run of yours: the command on the prompt band as in the transcript, its whole output, then the live
   line with the input line under it while it runs, or how it ended. */
function ownLogEntries(s, b, runView) {
  const o = outs.get(`${s.id}|${b.toolUseId}`), st = bgState(b), running = st === "running", out = [];
  const text = o ? plain(o.text) : "", err = o ? plain(o.err || "") : "";
  const res = runView({ out: !o || (running && !text) ? null : text.replace(/\n$/, ""), err: err.replace(/\n$/, "") });
  out.push(["run", `<div class="bang bg-run ${running ? "running" : "done"}" data-bang="${esc(b.toolUseId)}"><div class="prompt bang-cmd"><span class="g">!</span><div class="cmd">${esc(b.command)}</div></div><div class="bang-res">${res}</div></div>`]);
  if (running) {
    out.push(["live", `<div class="ln liveln" data-state="green"><span class="g">${ind("k_shell")}</span><div><b>Running</b> <span class="dim">${live(b.start, msOf(b, st))}, Esc, Esc to end it</span></div></div>`]);
    out.push(["input", bangInputHTML(b.toolUseId)]);
  } else {
    const [word, mark] = endOf(st), sum = (b.summary || "").trim();
    out.push(["end", `<div class="ln doneln bg-end${st === "failed" ? " failed" : ""}"><span class="g">${ind(mark)}</span><div>${word} after ${took(msOf(b, st))}${b.end ? `, ${hhmm(b.end)}` : ""}${sum ? `. ${esc(sum)}` : ""}</div></div>`]);
  }
  return out;
}

/* The input line of a running `!` command (R5.13, 2026-11-26), in the credential line's style (creds-line.js):
   Enter sends the line with a newline, an empty Enter just the newline ("Press Enter"); Esc leaves the field.
   The same markup each render, so the log keeps the element, its text and its focus while output comes. */
export const bangInputHTML = id => `<div class="creds-line bang-in" data-bang-in="${esc(id)}"><span class="g">❯</span><input spellcheck="false" autocomplete="off" placeholder="Type to the command, Enter sends" aria-label="Input to the shell command"></div>`;
document.addEventListener("keydown", e => {
  const inp = e.target, line = inp?.closest?.(".bang-in"); if (!line || inp.tagName !== "INPUT") return;
  if (e.key === "Enter") {
    e.preventDefault();
    const s = cur(); if (!s) return;
    if (act({ t: "bangInput", sid: s.id, text: inp.value }, { done: (ok, error) => { if (!ok && error) toast(error); } })) inp.value = "";
  } else if (e.key === "Escape") { e.preventDefault(); inp.blur(); }
});
