/* Composer: the message box, pasted images, the slash menu and the model picker (split from prototype/app.html).
   mountComposer runs once per session view (renderConv), so data never resets what you type. */
const attachments = []; // pasted images: { url (an object URL, for the thumbnail), data (its data: URL, for sending) }
const newUuid = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

/* ---------- slash commands and /model, from the menu of the session's folder ---------- */
const MENU = () => store.menu[cur()?.cwd ?? ""] || { models: [], commands: [] };
const COMMANDS = () => MENU().commands.filter(c => !c.name.startsWith("__"));
/* the session's model (its choice, else the transcript's requestedModel) matched to a menu row by value or resolved id */
const modelOf = s => { const v = s?.model; const ms = MENU().models; return (v && (ms.find(x => x.value === v) || ms.find(x => x.resolved === v))) || (!v ? ms.find(x => x.value === "default") : null) || null; };
const modelValue = () => modelOf(cur())?.value ?? cur()?.model ?? "default";
const modelName = () => {
  const s = cur(), m = modelOf(s);
  const cm = (m?.description || "").match(/currently ([^()]+)/);
  // no menu row yet (a folder's first launch): a name from the id (md.js)
  const name = !m ? modelLabel(s?.model) : m.value === "default" && cm ? `Default (${cm[1].trim()})` : m.name;
  return s?.effort ? `${name}, ${s.effort} effort` : name;
};
function rank(list, q, key) {
  q = q.toLowerCase();
  const scored = list.map(x => {
    const n = key(x).toLowerCase();
    const i = n.indexOf(q);
    const parts = n.split(/[-:_]/);
    const word = parts.some(p => p.startsWith(q));
    return { x, s: !q ? 1 : n.startsWith(q) ? 0 : word ? 1 : i >= 0 ? 2 : 9 };
  }).filter(r => r.s < 9);
  return scored.sort((a, b) => a.s - b.s || key(a.x).localeCompare(key(b.x))).map(r => r.x);
}
function attachSlash(ta, onModel) {
  const box = document.getElementById("slash");
  let mode = null, items = [], sel = 0, eff = null; // eff: the effort level picked on the selected model row
  const close = () => { box.hidden = true; mode = null; };
  const draw = () => {
    if (!items.length) { box.innerHTML = `<div class="head">No matching command</div>`; box.hidden = false; return; }
    box.innerHTML = (mode === "model" ? `<div class="head">Choose a model for this session${items.some(m => (m.effort || []).length) ? ", ← → for the effort" : ""}</div>` : "") + items.slice(0, 40).map((it, i) => mode === "model"
      ? `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">${it.value === modelValue() ? "❯ " : "  "}${esc(it.name)}</span><span class="d">${esc(it.description || "")}</span>${i === sel && (it.effort || []).length ? effortRow(it) : ""}</div>`
      : `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">/${esc(it.name)}${it.hint ? ` <span class="h">${esc(it.hint)}</span>` : ""}</span><span class="d">${esc(it.description)}</span></div>`).join("");
    box.hidden = false;
    box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    box.querySelectorAll(".it").forEach(el => el.onmousedown = e => {
      e.preventDefault(); const lv = e.target.closest("[data-eff]");
      if (lv && +el.dataset.i === sel) eff = lv.dataset.eff; else if (+el.dataset.i !== sel) { sel = +el.dataset.i; eff = effortFor(items[sel]); }
      pick();
    });
    /* in the model picker the pointer moves the selection, so the effort row follows it and can be clicked */
    if (mode === "model") box.querySelectorAll(".it").forEach(el => el.onmousemove = () => { const i = +el.dataset.i; if (i !== sel) { sel = i; eff = effortFor(items[sel]); draw(); } });
  };
  /* the effort levels of the selected model, a second row of choices; the chosen one is boxed */
  const effortFor = m => { const s = cur(), lv = m?.effort || []; return s?.effort && lv.includes(s.effort) ? s.effort : null; };
  const effortRow = m => `<span class="eff" role="radiogroup" aria-label="Effort"><span class="eff-l">Effort</span>${m.effort.map(l =>
    `<span class="eff-o" role="radio" data-eff="${esc(l)}" aria-checked="${l === eff}">${esc(l)}</span>`).join("")}</span>`;
  const update = () => {
    if (mode === "model") return;
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m) { close(); return; }
    mode = "cmd"; items = rank(COMMANDS(), m[1], c => c.name); sel = 0; draw();
  };
  const pick = () => {
    const it = items[sel];
    if (!it) { if (mode === "cmd" && ta.value.trim() === "/model") openModels(); return; } // a menu without the /model row
    if (mode === "model") { close(); ta.value = ""; onModel(it, (it.effort || []).includes(eff) ? eff : null); return; }
    if (it.name === "model") { openModels(); return; }
    ta.value = `/${it.name} `; close(); ta.focus();
  };
  const openModels = () => {
    mode = "model"; items = MENU().models; sel = Math.max(0, items.findIndex(m => m.value === modelValue())); eff = effortFor(items[sel]); ta.value = "/model "; draw();
  };
  ta.openModels = openModels;
  ta.addEventListener("input", update);
  ta.addEventListener("keydown", e => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; if (mode === "model") eff = effortFor(items[sel]); draw(); }
    else if (mode === "model" && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (items[sel]?.effort || []).length) {
      e.preventDefault(); e.stopImmediatePropagation();
      const lv = items[sel].effort, i = lv.indexOf(eff), step = e.key === "ArrowRight" ? 1 : -1;
      eff = i < 0 ? lv[step > 0 ? 0 : lv.length - 1] : lv[Math.min(lv.length - 1, Math.max(0, i + step))]; draw();
    }
    else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); pick(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); if (ta.value.startsWith("/model")) ta.value = ""; }
  }, true);
  ta.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 120)); // the model button refocuses it
}

/* the pasted images as thumbnails (images.js), each with a ✕ on hover; a removed one's object URL is freed */
let attachedUrls = [];
function renderAttachments() {
  for (const u of attachedUrls) if (!attachments.some(a => a.url === u) && !uiHeld(u)) URL.revokeObjectURL(u); // another session's draft may still show it
  attachedUrls = attachments.map(a => a.url);
  const box = conv.querySelector(".composer .attach"); if (!box) return;
  box.classList.add("thumbs");
  box.innerHTML = attachments.map((a, i) => `<figure class="thumb-wrap">${thumbHTML(a.url, 0, 0, `Pasted image ${i + 1}`)}<button class="unattach" data-unattach="${i}" aria-label="Remove pasted image ${i + 1}" title="Remove">✕</button></figure>`).join("");
}
/* the header's model button and /model open the same picker */
function openModelPicker() {
  const ta = document.getElementById("msg"); if (!ta) return;
  ta.focus(); ta.openModels?.();
}
/* ---------- Esc, Esc: the message box turns into "Interrupt?" while a turn runs (R9.4) ---------- */
let interruptAsk = null; // the session id the prompt is for
/* a running turn, or one waiting on a card (Esc with no in-place field open, plan section 6) */
const canInterrupt = s => Boolean(s) && s.driven !== false && !termPid(s) && (stateOf(s) === "green" || stateOf(s) === "red" && s.status === "waiting"); // never for a session another process runs
/* the message box's one prompt line: Esc, Esc's or b, b's, whichever came last */
function askInBox(box, html) {
  const p = box.querySelector(".int-ask") || box.appendChild(Object.assign(document.createElement("p"), { className: "int-ask" }));
  p.setAttribute("role", "alert"); p.innerHTML = html;
  box.classList.add("asking");
}
function askInterrupt() {
  const box = conv.querySelector(".dock .composer"); if (!box) return;
  if (bgAsk) dismissBackground(); // the newest prompt replaces the other
  if (closeAsk) dismissClose();
  interruptAsk = current;
  askInBox(box, `<b>Interrupt?</b> <kbd>Esc</kbd> again to stop. Any other key to keep working.`);
}
function dismissInterrupt() {
  interruptAsk = null;
  conv.querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
/* ---------- b, b: the turn's foreground Bash commands and subagents go to the background, as Ctrl+B in the CLI (R9) ---------- */
let bgAsk = null; // the session id the prompt is for
/* the main conversation's steps that can go: a running foreground Bash or Agent (the backend's `fg`), in a running
   turn of a session Synopia drives */
const bgSteps = s => !s || !s.driven || termPid(s) || view || stateOf(s) !== "green" ? [] : s.items.filter(it => it.k === "tool" && it.fg && it.state === "running");
/* the first b: those steps are marked in the transcript and the box asks; false when nothing can go */
function askBackground() {
  const box = conv.querySelector(".dock .composer"), log = document.getElementById("log");
  if (!box || !log || !bgSteps(cur()).length) return false;
  if (interruptAsk) dismissInterrupt();
  if (closeAsk) dismissClose();
  bgAsk = current;
  askInBox(box, `<b>Send to background?</b> <kbd>b</kbd> again. Any other key to keep it in front.`);
  log.classList.add("bg-asking");
  return true;
}
function dismissBackground() {
  bgAsk = null;
  document.getElementById("log")?.classList.remove("bg-asking");
  conv.querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
/* the second b: the backend calls backgroundTasks() on the session's process, and says so only when nothing moved */
function confirmBackground() {
  const sid = bgAsk; dismissBackground();
  if (sid && sid === current && bgSteps(cur()).length) send({ t: "background", sid });
}
/* the turn ended, the steps finished or the view changed under the prompt */
function syncBackground() {
  if (bgAsk && (bgAsk !== current || !bgSteps(cur()).length || !document.getElementById("log")?.classList.contains("bg-asking"))) dismissBackground();
}
document.addEventListener("mousedown", () => { if (bgAsk) dismissBackground(); }, true);
/* the second Esc: stop the turn, if it still runs */
function confirmInterrupt() {
  const sid = interruptAsk; dismissInterrupt();
  if (sid && sid === current && canInterrupt(cur())) send({ t: "interrupt", sid });
}
/* the turn ended or the view changed under the prompt */
function syncInterrupt() {
  if (interruptAsk && (interruptAsk !== current || !canInterrupt(cur()) || !conv.querySelector(".composer.asking"))) dismissInterrupt();
}
document.addEventListener("mousedown", () => { if (interruptAsk) dismissInterrupt(); }, true);

/* ---------- x, x: close the session (R3.6, R9); the prompt is the only confirm ---------- */
let closeAsk = null; // the session id the prompt is for
/* the first x: the box asks, with what will stop; a session another process drives is only removed from Synopia */
function askClose() {
  const s = cur(), box = conv.querySelector(".dock .composer"); if (!s || !box) return false;
  if (interruptAsk) dismissInterrupt(); // the newest prompt replaces the other
  if (bgAsk) dismissBackground();
  closeAsk = current;
  const other = s.driven === false || Boolean(termPid(s));
  const stops = other ? "" : closeStops(s);
  askInBox(box, other
    ? `<b>Remove it from Synopia?</b> <kbd>x</kbd> again. Its other process keeps running.`
    : `<b>Close this session?</b> <kbd>x</kbd> again. Any other key to keep it.${stops ? ` ${esc(stops)}` : ""}`);
  return true;
}
function dismissClose() {
  closeAsk = null;
  conv.querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
/* the second x: the same `close` the header button sent; the session keeps its place and comes back from the Open list */
function confirmClose() {
  const sid = closeAsk; dismissClose();
  if (sid && sid === current) closeSession(cur());
}
document.addEventListener("mousedown", () => { if (closeAsk) dismissClose(); }, true);

/* messages an interrupt cancelled come back to their session's box, before what you typed since */
const restoredTexts = new Map();
function restoreTexts(sid, texts) {
  if (!texts?.length) return;
  restoredTexts.set(sid, [...(restoredTexts.get(sid) || []), ...texts]);
  if (mounted && mounted.startsWith(sid + "|")) takeRestored(sid);
  toast(texts.length === 1 ? "Your queued message is back in the message box." : `Your ${texts.length} queued messages are back in the message box.`);
}
function takeRestored(sid) {
  const texts = restoredTexts.get(sid), ta = document.getElementById("msg");
  if (!texts || !ta) return;
  restoredTexts.delete(sid);
  ta.value = [...texts, ta.value].filter(t => t.trim()).join("\n\n");
  ta.dispatchEvent(new Event("input"));
}

function mountComposer(s) {
  const ta = document.getElementById("msg");
  interruptAsk = null; bgAsk = null; closeAsk = null; // switching sessions or views cancels a prompt
  renderAttachments();
  /* a pick is stored per session (the backend's session message updates the header) and applied to a running process (setModel, the effort through applyFlagSettings) */
  attachSlash(ta, (m, effort) => {
    send({ t: "setModel", sid: s.id, model: m.value, effort }); // the header shows it once stored; a running CLI also writes "/model …" to the transcript
  });
  /* Enter sends the text and the pasted images (base64 PNG or JPEG, 5 MB each) to the session's input.
     s.id follows the session when its id changes (a new session's real id), so the message reaches it. */
  const sendMsg = () => {
    if (!ta.value.trim() && !attachments.length) return;
    if (ta.value.trim() === "/model" && !attachments.length) { openModelPicker(); return; } // typed in full: the picker, not a message
    const images = [];
    for (const a of attachments) {
      if (!a.data) { toast("An image is still being read. Press Enter again in a moment."); return; }
      const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(a.data);
      if (!m) { toast("Only PNG and JPEG images can be sent. Remove the others first."); return; }
      if (m[2].length * 3 / 4 > 5 * 1024 * 1024) { toast("An image is over 5 MB. Remove it, or paste a smaller one."); return; }
      images.push({ mediaType: m[1], data: m[2] });
    }
    if (!store.ui.connected) { toast("Not connected to the Synopia backend. Your message is still in the box."); return; }
    if (termPid(cur()) || takeoverWait?.sid === s.id) { takeBack(s, ta, images); return; } // the box keeps it until the session is back
    send({ t: "send", sid: s.id, text: ta.value, images, uuid: newUuid() });
    ta.value = ""; ta.style.height = "auto";
    attachments.length = 0; renderAttachments();
    uiFlush(); // the sent draft is gone from the backend at once, its images too
  };
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(240, ta.scrollHeight) + "px"; });
  /* the whole box is the touch target: a press anywhere in it that isn't on a control focuses the field,
     with the caret at the end when it lands outside the text */
  const box = ta.closest(".composer");
  box.addEventListener("mousedown", e => {
    if (e.target === ta || e.target.closest("button, a, input, .slash, .attach img")) return;
    e.preventDefault(); ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n);
  });
  ta.addEventListener("paste", e => {
    for (const item of e.clipboardData?.items || []) if (item.type.startsWith("image/")) {
      e.preventDefault(); const file = item.getAsFile(), a = { id: uiNewId(), mediaType: file.type, url: URL.createObjectURL(file), data: null };
      attachments.push(a); renderAttachments();
      const r = new FileReader(); r.onload = () => { a.data = r.result; uiChanged(); }; r.readAsDataURL(file); // then kept with the draft
    }
  });
  uiEnterComposer(s, ta); // this session's draft: its text, cursor and pasted images (ui.js)
  takeRestored(s.id);
  mountTakeover(s, ta);
}

/* ---------- a terminal holds the session (R3.2): the box's one line, and the message that takes it back ---------- */
let takeoverWait = null; // { sid, text, seen }: a message the box keeps until the session is back from the terminal
const termPid = s => s?.statusDetail?.terminal || 0;
/* Enter: the backend takes the session back once the terminal is idle; the text stays until then */
function takeBack(s, ta, images) {
  takeoverWait = { sid: s.id, text: ta.value, seen: false };
  send({ t: "send", sid: s.id, text: ta.value, images, uuid: newUuid() });
  syncTakeover();
}
function cancelTakeBack() {
  if (!takeoverWait) return;
  send({ t: "cancelTakeover", sid: takeoverWait.sid }); takeoverWait = null; syncTakeover();
}
function mountTakeover(s, ta) {
  ta.closest(".composer").insertAdjacentHTML("beforeend", `<p class="term-line"></p><p class="term-wait" role="status"></p>`);
  ta.addEventListener("input", () => { if (takeoverWait?.sid === s.id && ta.value !== takeoverWait.text) cancelTakeBack(); }); // any edit cancels the wait
  ta.addEventListener("keydown", e => { if (e.key === "Escape" && takeoverWait?.sid === s.id) cancelTakeBack(); }, true); // and Esc
  syncTakeover();
}
/* each session message: the line, the mark, and the box emptied once the message went to Claude */
function syncTakeover() {
  const s = cur(), ta = document.getElementById("msg"), box = ta?.closest(".composer");
  if (!s || !box) return;
  const d = s.statusDetail || {}, pid = termPid(s), w = takeoverWait?.sid === s.id ? takeoverWait : null;
  if (w && d.takeover) w.seen = true;
  else if (w && (w.seen || !pid)) {
    if (!pid && stateOf(s) === "green") { // it went, as after any send
      if (ta.value === w.text) { ta.value = ""; ta.style.height = "auto"; attachments.length = 0; renderAttachments(); uiFlush(); }
      takeoverWait = null;
    } else if (w.seen) takeoverWait = null; // it didn't: the text stays, and the toast said why
  }
  const line = box.querySelector(".term-line"), mark = box.querySelector(".term-wait");
  if (line) line.textContent = pid ? `Open in a terminal (pid ${pid}). Type there, or send here to bring it back.` : "";
  if (mark) mark.textContent = d.takeover === "taking" ? "Bringing it back from the terminal…" : d.takeover || takeoverWait?.sid === s.id ? "Waiting for the terminal to finish…" : "";
  box.classList.toggle("held", Boolean(pid));
  box.classList.toggle("taking", Boolean(mark?.textContent));
}
