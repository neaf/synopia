/* Card: the needs-you card for questions, permissions and plans, and its keys (split from prototype/app.html).
   It renders the oldest pending request of the session (`pending` from the server), turned into the ask shape
   the card reads, above the message box. Questions one at a time; j/k and Space, i types in place. */
import { view, cur, mounted, agentById, bgById, requestsOf } from "./state.js";
import { act } from "./connection.js";
import { esc, age, still } from "./format.js";
import { md } from "./md.js";
import { ind } from "./marks.js";
import { mode, setMode, paintMode } from "./mode.js";
import * as ui from "./ui-state.js";
import { credsHTML, wireCreds } from "./creds-line.js";

/* ask key "<sid>:<request id>" -> { qi, oi, picks: {qi: [labels]}, own: {qi: text}, notes, target: qi|null, noteRow };
   kept with the UI state (ui-state.js), so a half-answered card comes back after a reload */
export const qstate = {};
ui.useCards(qstate);
/* ---------- pending requests to asks: {id, kind, toolName, toolUseId, agentId, since, input, cwd, description, title,
   decisionReason, defaultToNo, always (the "Always allow" text, null when hidden), suggestions, own} ----------
   own: a call of one of Synopia's own tools (R3.15), worded by the backend (agent-tools.ts): {header, wants, text, once} */
const FILE_TOOLS = ["Edit", "Write", "NotebookEdit", "Read"];
/* who asks: Claude, or the subagent the request came from */
const askerOf = (s, r) => { const A = r.agentId && s && agentById(s, r.agentId); return A ? `Subagent “${esc(A.description)}”` : r.agentId ? "A subagent" : "Claude"; };
const wantsTo = r => r.own ? esc(r.own.wants) : r.toolName === "Bash" ? "run a command" : r.toolName === "Read" ? "read a file" : FILE_TOOLS.includes(r.toolName) ? "change a file" : `use ${esc(r.toolName)}`;
export function askOf(r) {
  const base = { id: r.id, k: "ask", ts: new Date(r.since).toISOString(), state: "pending", kind: r.kind === "question" ? undefined : r.kind, request: r };
  const inp = r.input || {};
  if (r.kind === "permission" && r.own) {
    const o = r.own;
    return { ...base, cmd: o.text, startOi: 0, qs: [{ header: o.header, multi: false,
      pre: `<p class="why2 own">${esc(o.text)}</p>`,
      opts: [["Allow once", o.once], ...(r.always ? [["Always allow", r.always]] : [])],
      otherLabel: "Deny", otherHint: "Press i to tell Claude why or what to do instead (optional)", otherPrefix: "Denied", otherEmptyOk: true, otherPlaceholder: "Why, or what to do instead (optional), Enter denies, Esc cancels" }] };
  }
  if (r.kind === "permission") {
    const bash = r.toolName === "Bash", cmd = inp.command || inp.file_path || inp.notebook_path || inp.url || inp.pattern || r.toolName;
    /* Claude's reason (input.description), else the CLI's (a Read's options.description is only the path) */
    const said = inp.description || "", why = said || r.decisionReason || r.title || (r.description !== cmd ? r.description : "") || "";
    return { ...base, cmd, startOi: r.defaultToNo ? (r.always ? 2 : 1) : 0, qs: [{ header: bash ? "Run command" : r.toolName, multi: false,
      pre: `<code class="cmd">${bash ? `<span class="ps">$ </span>` : ""}${esc(cmd)}</code><p class="why2"><span class="who">In ${esc(r.cwd || "")}.${said ? " Claude says:" : ""}</span> ${esc(why)}</p>`,
      opts: [["Allow once", bash ? "Runs this command now. Claude asks again next time." : "Allows it this time. Claude asks again next time."], ...(r.always ? [["Always allow", r.always]] : [])],
      otherLabel: "Deny", otherHint: "Press i to tell Claude why or what to do instead (optional)", otherPrefix: "Denied", otherEmptyOk: true, otherPlaceholder: "Why, or what to do instead (optional), Enter denies, Esc cancels" }] };
  }
  if (r.kind === "plan") return { ...base, plan: inp.plan || "", qs: [{ header: "Plan", multi: false, q: "Approve the plan above?",
    opts: [["Approve", "Claude starts with step 1 and follows the plan."]],
    otherLabel: "Ask for changes", otherHint: "Press i and say what to change", otherPrefix: "Changes", otherPlaceholder: "What should change, Enter sends it with your answer, Esc cancels" }] };
  return { ...base, qs: (inp.questions || []).map(q => ({ q: q.question, header: q.header, multi: !!q.multiSelect, opts: (q.options || []).map(o => [o.label, o.description || ""]) })) };
}
/* The items with the session's pending requests as asks: a request takes the place of its tool (or the
   transcript's ask) for the same tool use, the others go at the end, a plan after its text. */
export function withPending(items, requests, ext = null) {
  if (!requests.length && !ext) return items;
  const asks = ext ? [ext] : requests.map(askOf), byTool = new Map(asks.map(a => [a.request.toolUseId, a]));
  const ids = new Set(items.map(it => it.id));
  const plans = new Map(asks.filter(a => a.plan).map(a => [`plan:${a.request.toolUseId}`, a.plan]));
  /* the plan as the request has it: the CLI reads it from the plan file, which a revision may have changed */
  const out = items.map(it => (it.k === "ask" && it.state === "pending" || it.k === "tool" && it.state === "running") && byTool.has(it.id) ? byTool.get(it.id) : plans.has(it.id) ? { ...it, text: plans.get(it.id) } : it);
  for (const a of asks) {
    if (out.includes(a)) continue;
    if (a.plan && !ids.has(`plan:${a.request.toolUseId}`)) out.push({ id: `plan:${a.id}`, k: "claude", ts: a.ts, text: a.plan });
    out.push(a);
  }
  return out;
}
export const pendingAsk = s => { const r = requestsOf(s)[0]; return r ? askOf(r) : null; };
/* A question or plan another Claude Code process asks (R6.8): the server's `ask` fact, sent only while
   it is why the session needs you and no request of ours waits. Shown read-only: no cursor, no keys. */
export function extAsk(s) {
  const x = s.ask; if (!x || requestsOf(s).length) return null;
  const r = { id: `ext:${x.toolUseId}`, kind: x.kind, toolName: x.kind === "plan" ? "ExitPlanMode" : "AskUserQuestion", toolUseId: x.toolUseId, agentId: x.agentId, since: x.since || s.state.since, input: { plan: x.plan || "" } };
  const a = { ...askOf(r), ext: true };
  if (x.kind !== "plan") a.qs = (x.qs || []).map(q => ({ q: q.q, header: q.header, multi: !!q.multi, opts: q.opts || [] }));
  return a;
}
/* the read-only card: the prototype's card with every question open, its rows inert, and one quiet line for the footer */
function extHTML(s, a) {
  const n = a.qs.length;
  const item = (q, qi) => {
    const rows = [...q.opts.map(([l, d]) => ({ l, d })), ...(a.kind === "plan" ? [{ l: q.otherLabel, d: "Claude replans and asks again.", other: true }] : [])];
    return `<div class="acc open">${n > 1 ? `<div class="acc-h"><span class="am">○</span><span class="hd">${esc(q.header || `Question ${qi + 1}`)}</span></div>` : ""}<div class="acc-b">
      ${q.q ? `<div class="qt md">${md(q.q)}</div>` : ""}<div class="opts">${rows.map(r => {
        const rec = /\(recommended\)\s*$/i.test(r.l), label = r.l.replace(/\s*\(recommended\)\s*$/i, "");
        return `<div class="o ${r.other ? "other" : ""}"><span class="k"></span><span class="${r.other ? "pen" : q.multi ? "box" : "radio"}"></span>
          <span class="l">${esc(label)}${rec ? `<span class="rc-t">Recommended</span>` : ""}</span><span class="d">${esc(r.d)}</span></div>`; }).join("")}</div></div></div>`;
  };
  return `<div class="qa-card ro" aria-label="Claude's questions, asked in another process">
    <div class="nd-head"><b>${ind("pause")} Needs you</b><span class="why">${askerOf(s, a.request)} ${a.kind === "plan" ? "wrote a plan and waits for your approval" : `asks ${n === 1 ? "a question" : `${n} questions`}`}, for ${age(a.request.since)}</span></div>
    <div class="qbody">${a.qs.map(item).join("")}</div>
    <div class="nd-foot"><span class="ext-note">Asked in another Claude Code process. Answer it there.</span></div>
  </div>`;
}
export const askKey = (s, a) => `${s.id}:${a.id}`;
const qs = (s, a) => (qstate[askKey(s, a)] ||= { qi: 0, oi: a.startOi || 0, picks: {}, own: {}, notes: {}, target: null, noteRow: null });
const answered = (st, qi) => (st.picks[qi] || []).length > 0 || !!(st.own[qi] || "").trim();
const answerOf = (st, qi) => (st.own[qi] || "").trim() || (st.picks[qi] || []).map(l => l.replace(/\s*\(recommended\)\s*$/i, "")).join(", ") + ((st.notes || {})[qi] ? `, note: ${st.notes[qi]}` : "");
const allAnswered = (st, a) => a.qs.every((q, qi) => answered(st, qi));
/* "1 of 3" when several requests wait (the card shows the oldest), and "k of N answered" for several questions */
function prog(s, a, done, n) {
  const all = requestsOf(s).length, t = [all > 1 ? `1 of ${all}` : "", n > 1 ? `${done} of ${n} answered` : ""].filter(Boolean).join(", ");
  return t ? `<span class="prog">${t}</span>` : "";
}
export function qaHTML(s, a) { // exported for the escape test
  const st = qs(s, a), n = a.qs.length, done = a.qs.filter((q, qi) => answered(st, qi)).length;
  if (st.qi >= n) st.qi = n - 1;
  const item = (q, qi) => {
    const open = qi === st.qi, hd = esc(q.header || `Question ${qi + 1}`);
    const mark = answered(st, qi) ? `<span class="am ok">✓</span>` : open ? `<span class="am cur">●</span>` : `<span class="am">○</span>`;
    if (!open) return `<button class="acc" data-qi="${qi}">${mark}<span class="hd">${hd}</span><span class="${answered(st, qi) ? "ans" : "miss"}">${answered(st, qi) ? esc(answerOf(st, qi)) : "Not answered"}</span></button>`;
    const picked = st.picks[qi] || [], own = (st.own[qi] || "").trim();
    const editing = st.target === qi && st.noteRow == null;
    const noting = st.target === qi && st.noteRow != null ? st.noteRow : -1, note = (st.notes || {})[qi] || "";
    const otherL = q.otherLabel || "Something else", otherH = q.otherHint || "Press i to type your own answer";
    const rows = [...q.opts.map(([l, d], oi) => ({ l, d, oi, on: picked.includes(l), noting: noting === oi, note: picked.includes(l) && !q.multi ? note : "" })), { l: otherL, d: own ? `“${own}”` : otherH, oi: q.opts.length, on: !!own || (st.otherPicked || {})[qi], other: true, editing }];
    return `<div class="acc open">${n > 1 ? `<div class="acc-h">${mark}<span class="hd">${hd}</span></div>` : ""}<div class="acc-b">
      ${q.pre || ""}${q.q ? `<p class="qt md">${md(q.q)}</p>` : ""}<div class="opts">${rows.map(r => {
        const rec = /\(recommended\)\s*$/i.test(r.l), label = r.l.replace(/\s*\(recommended\)\s*$/i, "");
        return `<button class="o ${r.on ? "on" : ""} ${r.oi === st.oi ? "focus" : ""} ${r.other ? "other" : ""}" data-oi="${r.oi}">
          <span class="k">${r.oi === st.oi ? "›" : ""}</span><span class="${r.other ? "pen" : q.multi ? "box" : "radio"}"></span>
          <span class="l">${esc(label)}${rec ? `<span class="rc-t">Recommended</span>` : ""}</span>${r.editing
            ? `<span class="d"><input class="qa-own" id="qa-own" value="${esc(own)}" placeholder="${esc(q.otherPlaceholder || "Type your answer, Enter saves, Esc cancels")}" aria-label="${esc(otherL)}"></span>`
            : `<span class="d">${esc(r.d)}${r.noting ? `<input class="qa-own qa-note" id="qa-own" value="${esc(note)}" placeholder="Add a note to this answer, Enter saves, Esc cancels" aria-label="Note">` : r.note ? `<span class="qnote">Note: ${esc(r.note)}</span>` : ""}</span>`}</button>`; }).join("")}</div></div></div>`;
  };
  return `<div class="qa-card" aria-label="Claude's questions">
    <div class="nd-head"><b>${ind("pause")} Needs you</b><span class="why">${askerOf(s, a.request)} ${a.kind === "permission" ? `wants to ${wantsTo(a.request)}` : a.kind === "plan" ? "wrote a plan and waits for your approval" : `asks ${n === 1 ? "a question" : `${n} questions`}`}, for ${age(a.request.since)}</span>${prog(s, a, done, n)}</div>
    <div class="qbody">${a.qs.map(item).join("")}</div>
    <div class="nd-foot"><span class="hint"><span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>Space</kbd> pick</span><span><kbd>i</kbd> type</span><span><kbd>Enter</kbd> send</span></span>
      <button class="btn ${allAnswered(st, a) ? "primary" : ""}" id="qa-send" ${allAnswered(st, a) ? "" : "disabled"}>${a.kind ? "Send" : `Send answer${n > 1 ? "s" : ""}`}</button></div>
  </div>`;
}
function qaMove(s, a, how) {
  const st = qs(s, a), n = a.qs.length;
  if (how === "down" || how === "up") {
    const last = a.qs[st.qi].opts.length; // "Something else" is the last row
    if (how === "down") { if (st.oi < last) st.oi++; else if (st.qi < n - 1) { st.qi++; st.oi = 0; } }
    else { if (st.oi > 0) st.oi--; else if (st.qi > 0) { st.qi--; st.oi = a.qs[st.qi].opts.length; } }
  }
  if (how === "next") { st.qi = Math.min(n - 1, st.qi + 1); st.oi = 0; }
  if (how === "prev") { st.qi = Math.max(0, st.qi - 1); st.oi = 0; }
  if (how === "nextOpen") { const nx = a.qs.findIndex((q, qi) => qi > st.qi && !answered(st, qi)); const any = a.qs.findIndex((q, qi) => !answered(st, qi)); st.qi = nx >= 0 ? nx : any >= 0 ? any : st.qi; if (nx >= 0 || any >= 0) st.oi = 0; }
}
function qaPick(s, a) {
  const st = qs(s, a); if (st.qi >= a.qs.length) return;
  const q = a.qs[st.qi];
  if (st.oi >= q.opts.length) { st.target = st.qi; setMode("insert", false); return; } // Something else: type it in place
  const l = q.opts[st.oi][0], cur = st.picks[st.qi] || [];
  delete st.own[st.qi];
  if (q.multi) st.picks[st.qi] = cur.includes(l) ? cur.filter(x => x !== l) : [...cur, l];
  else st.picks[st.qi] = [l];
}
/* The answer goes to the server, which turns it into the canUseTool result (cards.ts): one shape per card. */
function cardAnswer(st, a) {
  const pick = (st.picks[0] || [])[0], own = st.own[0] || "", after = p => own.startsWith(p + ": ") ? own.slice(p.length + 2) : "";
  if (a.kind === "permission") return pick === "Allow once" ? { choice: "once" } : pick === "Always allow" ? { choice: "always" } : { choice: "deny", text: after("Denied") };
  if (a.kind === "plan") return pick === "Approve" ? { choice: "approve" } : { choice: "changes", text: after("Changes") };
  return { questions: a.qs.map((q, qi) => ({ picks: st.picks[qi] || [], own: (st.own[qi] || "").trim(), note: (st.notes || {})[qi] || "" })) };
}
/* the picks stay until the backend acks the answer: refused while disconnected, or not taken, the card
   keeps them for another Enter (requirements Q9) */
function answerAsk(s, a) {
  const st = qs(s, a), key = askKey(s, a);
  const sent = act({ t: "answer", sid: s.id, requestId: a.id, answer: cardAnswer(st, a) }, {
    done: ok => { if (ok && qstate[key] === st) delete qstate[key]; },
    refused: "Not connected to the Synopia backend, so the answer wasn't sent. Your picks are kept.",
  });
  if (!sent) return;
  setMode("normal", false);
}
/* normal-mode keys while a card waits (keys.js); returns true when handled */
export function qaKeys(e) {
  const s = cur(); if (!s || view) return false;
  const a = pendingAsk(s); if (!a) return false;
  const st = qs(s, a);
  const k = e.key;
  if (k === "j" || k === "ArrowDown") qaMove(s, a, "down"); // the arrows too, as everyone expects
  else if (k === "k" || k === "ArrowUp") qaMove(s, a, "up");
  else if (k === " ") qaPick(s, a);
  else if (k === "i" && st.qi < a.qs.length) {
    const q = a.qs[st.qi];
    if (st.oi >= q.opts.length) { st.target = st.qi; st.noteRow = null; }
    else { const l = q.opts[st.oi][0]; if (!q.multi) { st.picks[st.qi] = [l]; delete st.own[st.qi]; } else if (!(st.picks[st.qi] || []).includes(l)) st.picks[st.qi] = [...(st.picks[st.qi] || []), l]; st.target = st.qi; st.noteRow = st.oi; }
    setMode("insert", false);
  }
  else if (k === "Enter") {
    e.preventDefault(); // before the returns below: an Enter left to WKWebView makes AppKit beep
    const q = a.qs[st.qi];
    if (q && st.oi >= q.opts.length) { // the last row: Deny sends (its reason is optional), else it opens the field as i does
      if (!q.otherEmptyOk && st.own[st.qi]?.trim()) { // typed already: Enter takes that answer, as on a picked row
        delete st.picks[st.qi]; if (allAnswered(st, a)) { answerAsk(s, a); return true; } qaMove(s, a, "nextOpen"); }
      else if (!q.otherEmptyOk) { st.target = st.qi; st.noteRow = null; setMode("insert", false); }
      else { if (!st.own[st.qi]) st.own[st.qi] = q.otherPrefix || q.otherLabel; delete st.picks[st.qi]; if (allAnswered(st, a)) { answerAsk(s, a); return true; } }
    } else {
      if (q && !q.multi) qaPick(s, a); // single choice: Enter picks the row under the cursor
      if (allAnswered(st, a)) { answerAsk(s, a); return true; } qaMove(s, a, "nextOpen");
    } }
  else return false;
  e.preventDefault(); renderCard(); paintMode(); document.getElementById("qa-own")?.focus();
  return true;
}
/* The dock's line when Claude needs you without a card: the sign-in expired or its credentials are being
   refreshed (creds-line.js), a red state whose request isn't here, or a turn that failed with a sentence.
   Working and your turn have no status line (R5.5); nor does a command of yours that waits for input: its row, its
   card and the sidebar say so, and its shell view takes the input (R5.13, 2026-11-26). */
const credsState = s => s.state.status === "signedout" || s.state.status === "refreshing"; // status.ts: a card wins over both
function statusLine(s) {
  if (credsState(s)) return credsHTML(s);
  if (s.state.needsYou === "input") return "";
  if (s.state.status === "failed" && s.state.light !== "red") return `<div class="status" data-state="amber"><b>${ind("failed")} Failed</b><span>${esc(s.state.detail.error)}</span></div>`;
  const why = { plan: "Claude wrote a plan and is waiting for your approval", question: "Claude is asking you something" }[s.state.needsYou] || "Claude is waiting for a permission";
  return `<div class="status" data-state="red"><b>${ind("pause")} Needs you</b><span>${why}, for ${age(s.state.since)}</span></div>`;
}
/* The credential line's fields (creds-line.js) across a redraw (its output grows while you type): what you
   typed, the caret and the focus come back on the field with the same id. */
function keepFields(dock) {
  const was = [...dock.querySelectorAll("#creds-cmd")].map(el => ({ id: el.id, value: el.value, focus: document.activeElement === el, a: el.selectionStart, b: el.selectionEnd, typed: el.dataset.typed === "1" }));
  return () => { for (const w of was) { const el = document.getElementById(w.id); if (!el || !w.typed && !w.focus) continue;
    el.value = w.value; el.dataset.typed = "1"; if (w.focus) { el.focus(); el.setSelectionRange(w.a, w.b); } } };
}
/* The dock above the composer: the card for the oldest pending request, or the status line when Claude
   needs you without one. Redrawn only when its HTML changed, so a half-typed answer stays. */
let lastCard = null;
/* the view's frame was rebuilt (transcript.js renderConv): its dock has no card yet */
export function resetCard() { lastCard = null; }
export function renderCard() {
  const s = cur(); if (!s || !mounted) return;
  const A = view && (agentById(s, view) || bgById(s, view)); // a subagent, shell or monitor view shows no card
  const pa = !A && pendingAsk(s), ea = !A && !pa && extAsk(s);
  const html = pa ? qaHTML(s, pa) : ea ? extHTML(s, ea) : !A && (s.state.light === "red" || credsState(s) || (s.state.status === "failed" && s.state.detail?.error)) ? statusLine(s) : "";
  if (still(html) === lastCard) return;
  lastCard = still(html);
  const conv = document.getElementById("conv"), dock = conv.querySelector(".dock-inner"), composer = dock.querySelector(".composer");
  const kept = keepFields(dock);
  [...dock.children].forEach(el => { if (el !== composer) el.remove(); });
  if (html) composer.insertAdjacentHTML("beforebegin", html);
  if (!pa) { kept(); if (credsState(s)) wireCreds(s); return; }
  const st = qs(s, pa);
  conv.querySelectorAll(".acc[data-qi]").forEach(b => b.onclick = () => { st.qi = +b.dataset.qi; st.oi = 0; renderCard(); });
  conv.querySelectorAll(".qa-card .o").forEach(b => b.onclick = () => { st.oi = +b.dataset.oi; qaPick(s, pa); if (mode !== "insert") renderCard(); });
  document.getElementById("qa-send").onclick = () => answerAsk(s, pa);
  const own = document.getElementById("qa-own");
  if (own) { const q0 = pa.qs[st.target]; if (st.noteRow == null && q0.otherPrefix && own.value.startsWith(q0.otherPrefix + ": ")) own.value = own.value.slice(q0.otherPrefix.length + 2); else if (own.value === q0.otherPrefix) own.value = "";
    const typed = ui.takeTyping(askKey(s, pa)); if (typed != null) own.value = typed; // what it held before a reload (ui-state.js)
    const stop = save => {
      const q = pa.qs[st.target];
      if (st.noteRow != null) { if (save) { if (own.value.trim()) st.notes[st.target] = own.value.trim(); else delete st.notes[st.target]; } st.target = null; st.noteRow = null; setMode("normal", false); renderCard(); return; }
      if (save && own.value.trim()) { delete st.notes[st.target]; st.own[st.target] = q.otherPrefix ? `${q.otherPrefix}: ${own.value.trim()}` : own.value.trim(); delete st.picks[st.target]; }
      else if (save && q.otherEmptyOk) { st.own[st.target] = q.otherPrefix || q.otherLabel; delete st.picks[st.target]; }
      st.target = null; setMode("normal", false); renderCard(); };
    own.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); stop(true); } if (e.key === "Escape") { e.preventDefault(); stop(false); } });
    own.addEventListener("blur", () => { if (st.target != null) stop(true); });
    own.addEventListener("click", e => e.stopPropagation());
    const end = own.value.length; own.focus(); own.setSelectionRange(end, end);
  }
}
