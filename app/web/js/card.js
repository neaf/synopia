/* Card: the needs-you card for questions, permissions and plans, and its keys (split from prototype/app.html).
   It renders the oldest pending request of the session (`pending` from the server), turned into the ask shape the card reads. */
/* ---------- Claude's pending question ---------- */
/* ---------- Claude's questions: one at a time, steps on top, j/k + Space, h/l between questions ---------- */
const qstate = {}; // ask key -> { qi, oi, picks: {qi: [labels]}, own: {qi: text}, target: qi|null }
/* ---------- pending requests to asks: {id, kind, toolName, toolUseId, since, input, cwd, suggestions, …} ---------- */
const WHERE = { session: "in this session", localSettings: "in this project (.claude/settings.local.json)", projectSettings: "in this project (.claude/settings.json)", userSettings: "everywhere (~/.claude/settings.json)", cliArg: "for this run" };
const ruleText = r => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
/* what "Always allow" remembers, and for how long: one clause per update entry */
function alwaysText(suggestions) {
  return suggestions.map((u, i) => {
    const where = WHERE[u.destination] || "";
    if (/Rules$/.test(u.type)) return `${i ? "and " : ""}${u.behavior === "deny" ? "Always deny" : "Always allow"} ${(u.rules || []).map(ruleText).join(", ")} ${where}`.trim();
    if (u.type === "setMode") return `${i ? "and " : ""}switch to ${u.mode === "acceptEdits" ? "accept edits" : u.mode}`;
    if (u.type === "addDirectories") return `${i ? "and " : ""}allow access to ${(u.directories || []).join(", ")}`;
    return "";
  }).filter(Boolean).join(", ") + ".";
}
function askOf(r) {
  const base = { id: r.id, k: "ask", ts: new Date(r.since).toISOString(), state: "pending", kind: r.kind === "question" ? undefined : r.kind, request: r };
  const inp = r.input || {};
  if (r.kind === "permission") {
    const cmd = inp.command || inp.file_path || inp.notebook_path || r.toolName;
    const why = inp.description || r.description || r.title || "";
    const always = !r.suppressAlwaysAllowRule && (r.suggestions || []).length;
    return { ...base, cmd, qs: [{ header: r.toolName === "Bash" ? "Run command" : r.toolName, multi: false,
      pre: `<code class="cmd"><span class="ps">$ </span>${esc(cmd)}</code><p class="why2"><span class="who">In ${esc(r.cwd || "")}. Claude says:</span> ${esc(why)}</p>`,
      opts: [["Allow once", "Runs this command now. Claude asks again next time."], ...(always ? [["Always allow", alwaysText(r.suggestions)]] : [])],
      otherLabel: "Deny", otherHint: "Press i to tell Claude why or what to do instead (optional)", otherPrefix: "Denied", otherEmptyOk: true, otherPlaceholder: "Why, or what to do instead (optional), Enter denies, Esc cancels" }] };
  }
  if (r.kind === "plan") return { ...base, plan: inp.plan || "", qs: [{ header: "Plan", multi: false, q: "Approve the plan above?",
    opts: [["Approve", "Claude starts with step 1 and follows the plan."]],
    otherLabel: "Ask for changes", otherHint: "Press i and say what to change", otherPrefix: "Changes", otherPlaceholder: "What should change, Enter sends it with your answer, Esc cancels" }] };
  return { ...base, qs: (inp.questions || []).map(q => ({ q: q.question, header: q.header, multi: !!q.multiSelect, opts: (q.options || []).map(o => [o.label, o.description || ""]) })) };
}
/* The items with the session's pending requests as asks: a request replaces the transcript's ask for the
   same tool use, the others go at the end, a plan after its text. */
function withPending(items, requests) {
  if (!requests.length) return items;
  const asks = requests.map(askOf), byTool = new Map(asks.map(a => [a.request.toolUseId, a]));
  const out = items.map(it => it.k === "ask" && it.state === "pending" && byTool.has(it.id) ? byTool.get(it.id) : it);
  for (const a of asks) {
    if (out.includes(a)) continue;
    if (a.plan) out.push({ id: `plan:${a.id}`, k: "claude", ts: a.ts, text: a.plan });
    out.push(a);
  }
  return out;
}
const pendingAsk = s => { const r = requestsOf(s)[0]; return r ? askOf(r) : null; };
const askKey = (s, a) => `${s.id}:${a.id}`;
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
    <div class="nd-head"><b>${ind("pause")} Needs you</b><span class="why">${a.kind === "permission" ? "Claude wants to run a command" : a.kind === "plan" ? "Claude wrote a plan and waits for your approval" : `Claude asks ${n === 1 ? "a question" : `${n} questions`}`}, for ${age(s.statusAt)}</span>${n > 1 ? `<span class="prog">${done} of ${n} answered</span>` : ""}</div>
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
/* The answer goes to the server, which settles the request (slice 3 turns it into the canUseTool result). */
function answerAsk(s, a) {
  const st = qs(s, a);
  send({ t: "answer", sid: s.id, requestId: a.id, answer: { answers: a.qs.map((q, qi) => answerOf(st, qi)), picks: st.picks, own: st.own, notes: st.notes } });
  delete qstate[askKey(s, a)];
  mode = "normal"; paintMode();
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
  e.preventDefault(); renderCard(); paintMode(); document.getElementById("qa-own")?.focus();
  return true;
}
/* The dock above the composer: the card for the oldest pending request, or the status line when Claude
   needs you without one. Redrawn only when its HTML changed, so a half-typed answer stays. */
let lastCard = null;
function renderCard() {
  const s = cur(); if (!s || !mounted) return;
  const A = view && agentById(s, view);
  const pa = !A && pendingAsk(s);
  const html = pa ? qaHTML(s, pa) : !A && stateOf(s) === "red" ? statusLine(s) : "";
  if (still(html) === lastCard) return;
  lastCard = still(html);
  const dock = conv.querySelector(".dock-inner"), composer = dock.querySelector(".composer");
  [...dock.children].forEach(el => { if (el !== composer) el.remove(); });
  if (html) composer.insertAdjacentHTML("beforebegin", html);
  if (!pa) return;
  const st = qs(s, pa);
  conv.querySelectorAll(".acc[data-qi]").forEach(b => b.onclick = () => { st.qi = +b.dataset.qi; st.oi = 0; renderCard(); });
  conv.querySelectorAll(".qa-card .o").forEach(b => b.onclick = () => { st.oi = +b.dataset.oi; qaPick(s, pa); if (mode !== "insert") renderCard(); });
  document.getElementById("qa-send").onclick = () => answerAsk(s, pa);
  const own = document.getElementById("qa-own");
  if (own) { const q0 = pa.qs[st.target]; if (st.noteRow == null && q0.otherPrefix && own.value.startsWith(q0.otherPrefix + ": ")) own.value = own.value.slice(q0.otherPrefix.length + 2); else if (own.value === q0.otherPrefix) own.value = "";
    const stop = save => {
      const q = pa.qs[st.target];
      if (st.noteRow != null) { if (save) { if (own.value.trim()) st.notes[st.target] = own.value.trim(); else delete st.notes[st.target]; } st.target = null; st.noteRow = null; mode = "normal"; renderCard(); paintMode(); return; }
      if (save && own.value.trim()) { delete st.notes[st.target]; st.own[st.target] = q.otherPrefix ? `${q.otherPrefix}: ${own.value.trim()}` : own.value.trim(); delete st.picks[st.target]; }
      else if (save && q.otherEmptyOk) { st.own[st.target] = q.otherPrefix || q.otherLabel; delete st.picks[st.target]; }
      st.target = null; mode = "normal"; renderCard(); paintMode(); };
    own.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); stop(true); } if (e.key === "Escape") { e.preventDefault(); stop(false); } });
    own.addEventListener("blur", () => { if (st.target != null) stop(true); });
    own.addEventListener("click", e => e.stopPropagation());
    const end = own.value.length; own.focus(); own.setSelectionRange(end, end);
  }
}
