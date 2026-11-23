/* Card: the needs-you card for questions, permissions and plans, and its keys (split from prototype/app.html).
   It renders any pending ask item; kind "permission" and "plan" asks come from the backend from slice 3 on. */
/* ---------- Claude's pending question ---------- */
/* ---------- Claude's questions: one at a time, steps on top, j/k + Space, h/l between questions ---------- */
const qstate = {}; // ask key -> { qi, oi, picks: {qi: [labels]}, own: {qi: text}, target: qi|null }
const pendingAsk = s => { const a = [...s.items].reverse().find(x => x.k === "ask"); return a && a.state === "pending" ? a : null; };
const askKey = (s, a) => `${s.id}:${a.ts}`;
const qs = (s, a) => (qstate[askKey(s, a)] ||= { qi: 0, oi: 0, picks: {}, own: {}, notes: {}, target: null, noteRow: null });
const answered = (st, qi) => (st.picks[qi] || []).length > 0 || !!(st.own[qi] || "").trim();
const answerOf = (st, qi) => (st.own[qi] || "").trim() || (st.picks[qi] || []).map(l => l.replace(/\s*\(recommended\)\s*$/i, "")).join(", ") + ((st.notes || {})[qi] ? `, note: ${st.notes[qi]}` : "");
const allAnswered = (st, a) => a.qs.every((q, qi) => answered(st, qi));
function qaHTML(s, a) {
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
    const noteHint = q.kind === "permission" ? "" : "";
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
    <div class="nd-head"><b>${ind("pause")} Needs you</b><span class="why">${a.kind === "permission" ? "Claude wants to run a command" : a.kind === "plan" ? "Claude wrote a plan and waits for your approval" : `Claude asks ${n === 1 ? "a question" : `${n} questions`}`}, for ${dur(s.statusAt)}</span>${n > 1 ? `<span class="prog">${done} of ${n} answered</span>` : ""}</div>
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
  if (st.oi >= q.opts.length) { st.target = st.qi; mode = "insert"; return; } // Something else: type it in place
  const l = q.opts[st.oi][0], cur = st.picks[st.qi] || [];
  delete st.own[st.qi];
  if (q.multi) st.picks[st.qi] = cur.includes(l) ? cur.filter(x => x !== l) : [...cur, l];
  else st.picks[st.qi] = [l];
}
const answerText = a => a.plainAnswer || "";
function answerAsk(s, a) {
  const st = qs(s, a);
  a.plainAnswer = answerOf(st, 0);
  a.answer = "Your questions have been answered: " + a.qs.map((q, qi) => `"${(q.q || q.header || "").replace(/"/g, '\\"')}"="${answerOf(st, qi).replace(/"/g, '\\"')}"`).join(", ");
  a.state = "answered"; delete qstate[askKey(s, a)];
  s.status = "busy"; s.statusAt = Date.now();
  toast("Prototype: not sent. The live app answers through canUseTool with updatedInput.answers.");
  renderAll();
}
/* normal-mode keys while a question waits; returns true when handled */
function qaKeys(e) {
  const s = data.find(x => x.id === current); if (!s || view) return false;
  const a = pendingAsk(s); if (!a) return false;
  const st = qs(s, a);
  const k = e.key;
  if (k === "j") qaMove(s, a, "down");
  else if (k === "k") qaMove(s, a, "up");
  else if (k === " ") qaPick(s, a);
  else if (k === "i" && st.qi < a.qs.length) {
    const q = a.qs[st.qi];
    if (st.oi >= q.opts.length) { st.target = st.qi; st.noteRow = null; }
    else { const l = q.opts[st.oi][0]; if (!q.multi) { st.picks[st.qi] = [l]; delete st.own[st.qi]; } else if (!(st.picks[st.qi] || []).includes(l)) st.picks[st.qi] = [...(st.picks[st.qi] || []), l]; st.target = st.qi; st.noteRow = st.oi; }
    mode = "insert";
  }
  else if (k === "Enter") { if (allAnswered(st, a)) { answerAsk(s, a); return true; } qaMove(s, a, "nextOpen"); }
  else return false;
  e.preventDefault(); renderConv(); paintMode(); document.getElementById("qa-own")?.focus();
  return true;
}
