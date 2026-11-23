/* Composer: the message box, pasted images, the slash menu and the model picker (split from prototype/app.html).
   mountComposer runs once per session view (renderConv), so data never resets what you type. */
const attachments = [];
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
  const name = !m ? (s?.model || "Default") : m.value === "default" && cm ? `Default (${cm[1].trim()})` : m.name;
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

function renderAttachments() {
  const box = conv.querySelector(".composer .attach"); if (!box) return;
  box.innerHTML = attachments.map((src, i) => `<figure><img src="${src}" alt="Pasted image ${i + 1}"><button data-unattach="${i}" aria-label="Remove image">×</button></figure>`).join("");
}
/* the header's model button and /model open the same picker */
function openModelPicker() {
  const ta = document.getElementById("msg"); if (!ta) return;
  ta.focus(); ta.openModels?.();
}
/* ---------- Esc, Esc: the message box turns into "Interrupt?" while a turn runs (R9.4) ---------- */
let interruptAsk = null; // the session id the prompt is for
/* a running turn, or one waiting on a card (Esc with no in-place field open, plan section 6) */
const canInterrupt = s => Boolean(s) && (stateOf(s) === "green" || stateOf(s) === "red" && s.status === "waiting");
function askInterrupt() {
  const box = conv.querySelector(".dock .composer"); if (!box) return;
  interruptAsk = current;
  if (!box.querySelector(".int-ask")) box.insertAdjacentHTML("beforeend", `<p class="int-ask" role="alert"><b>Interrupt?</b> <kbd>Esc</kbd> again to stop. Any other key to keep working.</p>`);
  box.classList.add("asking");
}
function dismissInterrupt() {
  interruptAsk = null;
  conv.querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
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
  interruptAsk = null;
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
    for (const url of attachments) {
      const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(url);
      if (!m) { toast("Only PNG and JPEG images can be sent. Remove the others first."); return; }
      if (m[2].length * 3 / 4 > 5 * 1024 * 1024) { toast("An image is over 5 MB. Remove it, or paste a smaller one."); return; }
      images.push({ mediaType: m[1], data: m[2] });
    }
    if (!store.ui.connected) { toast("Not connected to the Synopia backend. Your message is still in the box."); return; }
    send({ t: "send", sid: s.id, text: ta.value, images, uuid: newUuid() });
    ta.value = ""; ta.style.height = "auto";
    attachments.length = 0; renderAttachments();
  };
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(240, ta.scrollHeight) + "px"; });
  ta.addEventListener("paste", e => {
    for (const item of e.clipboardData?.items || []) if (item.type.startsWith("image/")) {
      e.preventDefault(); const r = new FileReader();
      r.onload = () => { attachments.push(r.result); renderAttachments(); };
      r.readAsDataURL(item.getAsFile());
    }
  });
  takeRestored(s.id);
}
