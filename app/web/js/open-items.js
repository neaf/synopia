/* Open items in the background work panel (requirements R7.1, R3.16; FR-ITEM-03 to -05): To review from the
   review items, the Waiting on you, Claude will check and Closed this turn groups, and the items a running
   subagent owns under its card. The backend owns every list (open-items.ts) and sends each session's whole
   (`openItems`, state.js); this module only draws it, as HTML for rail.js. The buttons carry the line they write
   into the box (`data-write`, transcript.js hands it to composer.js writeLine); they never send. The look is
   prototype/open-items-storyboard.html's panel (scenario 1) and its subagents (scenario 10). */
import { agentById } from "./state.js";
import { esc, age, hhmm } from "./format.js";
import { ind, kind } from "./marks.js";

const EMPTY = { items: [], checks: [], closed: [], unread: 0, note: null };
export const itemsOf = s => s?.openItems || EMPTY;
/* the panel shows for open items too (R7.1): an open item, a line Synopia can't read, or why it read nothing */
export const hasItems = s => { const o = itemsOf(s); return !!(o.items.length || o.checks.length || o.unread || o.note); };
/* the open review items: To review's cards */
export const reviewsOf = s => itemsOf(s).items.filter(i => i.kind === "review");
/* the open Y items, review items apart, that no running subagent shown in the tree holds (`shown`: their ids) */
export const waitingItems = (s, shown = new Set()) => itemsOf(s).items.filter(i => i.kind !== "review" && !held(i, shown));
const held = (i, shown) => !!i.with && shown.has(i.with.agent);

/* ---------- the focused item (R9.1): one per page, never stored, so a reload has none ---------- */
let focus = null; // { sid, id }
export const focusedItem = sid => focus && focus.sid === sid ? focus.id : null;
export function focusItem(sid, id) { focus = sid && id ? { sid, id } : null; }

/* ---------- pieces ---------- */
/* an item's text: plain, with its `code` spans as code */
const text = t => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
const idBox = id => `<span class="oi-id">${esc(id)}</span>`;
/* how old: from its `from` stamp, to the minute, or to the day for a stamp with no time (docs/Open items.md) */
function ageOf(i) {
  if (typeof i.at !== "number") return "";
  if (i.minute !== false) return age(i.at);
  const d = Math.floor((Date.now() - i.at) / 86_400_000);
  return d < 1 ? "today" : `${d} d`;
}
/* the buttons: a decision's options (the recommended one marked), Done for your task, Object for a default */
function chips(i) {
  if (i.state === "answered") return "";
  const b = (line, label, rec) => `<button class="oi-chip" data-write="${esc(line)}">${esc(label)}${rec ? `<span class="rc">Recommended</span>` : ""}</button>`;
  const out = i.kind === "decision" ? (i.options || []).map(o => b(`${i.id} ${o}`, o, o === i.recommended))
    : i.kind === "your task" ? [b(`${i.id} done`, "Done")]
      : i.kind === "default" ? [b(`${i.id} wait: `, "Object")] : [];
  return out.length ? `<span class="oi-acts">${out.join("")}</span>` : "";
}
const goesAhead = w => { const t = `Goes ahead ${w.trim()}`; return /unless you object/i.test(t) ? t : `${t}, unless you object`; };

/* one Waiting on you item: its id box, the kind word, the age; the text in up to two lines; when it goes ahead
   or what you answered; its buttons */
function itemHTML(i, focused) {
  const ans = i.state === "answered";
  const k = `${esc(i.kind)}${i.raisedBy ? `, from ${esc(i.raisedBy)}` : ""}${i.state === "later" ? ", later" : ""}`;
  const w = ans ? `Answered${i.answer ? `: “${esc(i.answer)}”` : ""}` : i.kind === "default" && i.goesAhead ? esc(goesAhead(i.goesAhead)) : "";
  return `<div class="oi${ans ? " ans" : ""}${focused ? " focus" : ""}" data-oi="${esc(i.id)}">${idBox(i.id)}<span class="oi-k">${k}</span><span class="oi-age">${ageOf(i)}</span>`
    + `<button class="oi-t" data-oi-open="${esc(i.id)}">${text(i.text)}</button>${w ? `<span class="oi-w">${w}</span>` : ""}${chips(i)}</div>`;
}
/* the watcher's run when the panel shows it running: a shell or monitor whose description or command names the `watch` */
const watcherOf = (watch, runs) => { const w = (watch || "").trim(); return w ? runs.find(b => { const n = (b.description || b.command || "").trim(); return n && (n.includes(w) || w.includes(n)); }) : null; };
/* one Claude will check line: its id, the text, its trigger, or "Due" once due; the watcher's moving mark */
function checkHTML(a, runs, focused) {
  const run = a.state !== "due" && watcherOf(a.watch, runs);
  const w = a.state === "due" ? `<b>Due:</b> ${esc(a.trigger || "now")}` : `${run ? ind(run.kind === "monitor" ? "k_mon" : "k_shell") : ""}<span>${esc(a.trigger || "")}</span>`;
  return `<div class="oi-fu${a.state === "due" ? " due" : ""}${focused ? " focus" : ""}" data-oi="${esc(a.id)}">${idBox(a.id)}<button class="oi-t" data-oi-open="${esc(a.id)}">${text(a.text)}</button><span class="oi-w">${w}</span></div>`;
}
/* what closed it, as the closed line says: "Answered: “Run it” · done: …", "Marked reviewed", "Removed from the ledger" */
const HOW = { answered: "Answered", done: "Done", "went ahead": "Went ahead", dropped: "Dropped", superseded: "Superseded" };
const cap = t => t ? t[0].toUpperCase() + t.slice(1) : "";
const closedWhy = c => c.how === "superseded" || c.by === "synopia" ? cap(c.note) || HOW[c.how] || cap(c.how) : `${HOW[c.how] || cap(c.how)}${c.note ? `: ${c.note}` : c.text ? `: ${c.text}` : ""}`;
/* a closed line: dim like a Past line; the check for done, the grey square for dropped and superseded */
const closedHTML = c => `<div class="pr oi-cl" title="${esc(c.text || "")}"><span class="pm">${ind(c.how === "dropped" || c.how === "superseded" ? "stopped" : "done")}</span><span class="n">${idBox(c.id)}${esc(closedWhy(c))}</span><span class="d">${hhmm(c.at)}</span></div>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ---------- the panel's parts ---------- */
/* To review (R7.1, R10.1): a card per open review item, with its id box. One whose subagent is in this transcript
   goes to its report (data-agent, transcript.js toReport); one that came over in a handoff only focuses. `hide`:
   agent ids whose card is still in the tree, for its finish grace (it moves here after, as before). */
export function reviewHTML(s, hide = new Set()) {
  const sid = s.id, rv = reviewsOf(s).filter(i => !(i.agent && hide.has(i.agent)));
  if (!rv.length) return "";
  return `<div class="review"><h3>To review <span class="cnt">${rv.length}</span></h3>${rv.map(i => {
    const a = i.agent && agentById(s, i.agent), name = i.subagent || i.text.replace(/^review:\s*/i, "");
    const m = a ? `${kind(a.fork ? "fork" : "sub")} finished ${a.end ? hhmm(a.end) : ""}` : `${kind("sub")} handed over`;
    return `<div class="rv${focusedItem(sid) === i.id ? " focus" : ""}" data-oi="${esc(i.id)}"><button class="rv-open"${a ? ` data-agent="${esc(a.id)}" aria-current="false"` : ""}>${ind("review")}<span class="n">${idBox(i.id)}${esc(name)}</span><span class="m">${m}</span></button>
      <button class="btn quiet rv-done" data-reviewed="${esc(i.id)}">Mark reviewed</button></div>`;
  }).join("")}</div>`;
}
/* the items a running subagent owns, under its card (R7.1, FR-ITEM-04): id box, text, "with <name>" and its moving mark */
export function ownedHTML(s, agent) {
  const o = itemsOf(s), mine = [...o.items, ...o.checks].filter(i => i.kind !== "review" && i.with?.agent === agent.id);
  return mine.map(i => `<div class="oi-on" data-oi="${esc(i.id)}">${idBox(i.id)}<button class="oi-t" data-oi-open="${esc(i.id)}">${text(i.text)}</button><span class="oi-w">${ind(agent.fork ? "k_fork" : "k_sub")}<span>with ${esc(i.with.name)}</span></span></div>`).join("");
}
/* Waiting on you, Claude will check, Closed this turn (R7.1). `shown`: the running subagents with a card, whose items
   hang under it instead; `runs`: the running shells and monitors, for a check's watcher */
export function groupsHTML(s, shown = new Set(), runs = []) {
  const o = itemsOf(s), f = focusedItem(s.id), wait = waitingItems(s, shown), checks = o.checks.filter(a => !held(a, shown));
  const bad = [...(o.unread ? [plural(o.unread, "line Synopia can't read", "lines Synopia can't read") + ", in open-items.md"] : []), ...(o.note ? [o.note] : [])]
    .map(t => `<div class="oi bad"><span class="oi-id q">?</span><span class="oi-k">${esc(t)}</span></div>`).join("");
  return (wait.length || bad ? `<section class="oi-group oi-wait"><h3>Waiting on you <span class="cnt">${wait.length}</span></h3>${wait.map(i => itemHTML(i, f === i.id)).join("")}${bad}</section>` : "")
    + (checks.length ? `<section class="oi-group oi-check"><h3>Claude will check <span class="cnt">${checks.length}</span></h3>${checks.map(a => checkHTML(a, runs, f === a.id)).join("")}</section>` : "")
    + (o.closed.length ? `<section class="oi-group oi-closed"><h3>Closed this turn <span class="cnt">${o.closed.length}</span></h3>${o.closed.map(closedHTML).join("")}</section>` : "");
}
