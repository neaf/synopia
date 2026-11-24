/* Composer: the message box, pasted images, the slash menu and the model picker (split from prototype/app.html),
   bash mode, the box's one prompt line (Esc, b, x) and the terminal-held line. mountComposer runs once per
   session view (transcript.js renderConv), so data never resets what you type. */
import { store, cur, current, view, mounted } from "./state.js";
import { act } from "./connection.js";
import { esc, modelLabel } from "./format.js";
import { thumbHTML } from "./images.js";
import * as ui from "./ui-state.js";
import { closeStops, closeSession } from "./sidebar.js";
import { setMode } from "./mode.js";
import { toast } from "./toast.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./protocol.js";

/* pasted images: { id, n (its [Image #n] tag in the text), mediaType, url (an object URL, for the thumbnail), data (its data: URL, for sending) } */
export const attachments = [];
const newUuid = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const conv = () => document.getElementById("conv");
const KEPT = "Not connected to the Synopia backend. Your message is still in the box.";

/* ---------- slash commands and /model, from the menu of the session's folder (the backend leaves out internal ones, sdk.ts) ---------- */
const MENU = () => store.menu[cur()?.cwd ?? ""] || { models: [], commands: [] };
/* the session's model (its choice, else the transcript's requestedModel) matched to a menu row by value or resolved id */
const modelOf = s => { const v = s?.model; const ms = MENU().models; return (v && (ms.find(x => x.value === v) || ms.find(x => x.resolved === v))) || (!v ? ms.find(x => x.value === "default") : null) || null; };
const modelValue = () => modelOf(cur())?.value ?? cur()?.model ?? "default";
export const modelName = () => {
  const s = cur(), m = modelOf(s);
  const cm = (m?.description || "").match(/currently ([^()]+)/);
  // no menu row yet (a folder's first launch): a name from the id (format.js)
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
    if (ta.dataset.bash) { close(); return; } // bash mode: no slash menu
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m) { close(); return; }
    mode = "cmd"; items = rank(MENU().commands, m[1], c => c.name); sel = 0; draw();
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
  /* while the menu shows it has the box's keys; first of the box's listeners, so its Esc and Enter come first */
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
  });
  ta.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 120)); // the model button refocuses it
}

/* ---------- pasted images and their [Image #N] tags, as in the Claude Code CLI (R5.13) ---------- */
/* A paste puts the image's tag at the caret; the number counts up through the session, as the CLI's does
   (one more than any tag in this session's prompts or the draft). The ✕ removes the image and its tag; the
   other tags keep their numbers. An image whose tag is deleted from the text stays in the row, dimmed, and
   is not sent unless the tag comes back. */
const imageTag = n => `[Image #${n}]`;
const tagged = (a, text) => a.n > 0 && text.includes(imageTag(a.n));
function nextImageNumber(s, text) {
  let max = 0;
  for (const t of [text, ...(s?.items || []).filter(it => it.k === "you").map(it => it.text || "")])
    for (const m of String(t).matchAll(/\[Image #(\d+)\]/g)) max = Math.max(max, +m[1]);
  for (const a of attachments) max = Math.max(max, a.n || 0);
  return max + 1;
}
/* the tag goes in at the caret, a space between it and any text it touches */
function insertTag(ta, n) {
  const v = ta.value, i = ta.selectionStart, j = ta.selectionEnd;
  const tag = (i > 0 && !/\s/.test(v[i - 1]) ? " " : "") + imageTag(n) + (j < v.length && !/\s/.test(v[j]) ? " " : "");
  ta.setRangeText(tag, i, j, "end");
  ta.dispatchEvent(new Event("input"));
}
/* the ✕: the image goes, with its tag and one space beside it */
export function unattach(i) {
  const [a] = attachments.splice(i, 1), ta = document.getElementById("msg");
  if (a && ta && a.n) {
    const v = ta.value, k = v.indexOf(imageTag(a.n));
    if (k >= 0) {
      let from = k, to = k + imageTag(a.n).length;
      if (v[to] === " ") to++; else if (from > 0 && v[from - 1] === " ") from--;
      ta.value = v.slice(0, from) + v.slice(to); ta.setSelectionRange(from, from);
      ta.dispatchEvent(new Event("input"));
    }
  }
  renderAttachments(); ui.changed();
}
/* a draft kept before tags (its images without a number): each gets one, its tag at the end of the text */
function tagLoose(s, ta) {
  const loose = attachments.filter(a => !(a.n > 0)); if (!loose.length) return;
  for (const a of loose) { a.n = nextImageNumber(s, ta.value); ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + imageTag(a.n); }
  ta.dispatchEvent(new Event("input")); renderAttachments(); ui.changed();
}
/* the thumbnails of images whose tag is gone from the text: dimmed, a dashed line, not sent */
function markUntagged() {
  const ta = document.getElementById("msg"); if (!ta) return;
  conv().querySelectorAll(".composer .attach .thumb-wrap").forEach((f, i) => {
    const a = attachments[i], off = Boolean(a) && !tagged(a, ta.value);
    f.classList.toggle("untagged", off);
    f.title = off ? `Not sent: ${imageTag(a.n)} is no longer in the message` : "";
  });
}
/* Object URLs: freed once no box shows the image, no draft holds it (ui-state.js) and no send waits for its
   ack (a refused send gives it back) */
let shown = [];
const flying = new Set();
const free = list => { for (const a of list) if (!attachments.includes(a) && !flying.has(a) && !ui.held(a.url)) URL.revokeObjectURL(a.url); };
/* the pasted images as thumbnails (images.js), each with a ✕ on hover */
function renderAttachments() {
  free(shown); shown = attachments.slice();
  const box = conv().querySelector(".composer .attach"); if (!box) return;
  box.classList.add("thumbs");
  box.innerHTML = attachments.map((a, i) => `<figure class="thumb-wrap" data-n="${a.n || 0}">${thumbHTML(a.url, 0, 0, `Pasted image ${a.n || i + 1}`)}<button class="unattach" data-unattach="${i}" aria-label="Remove pasted image ${a.n || i + 1}" title="Remove">✕</button></figure>`).join("");
  markUntagged();
}
/* the box's text as a draft keeps it: with the `!` of bash mode */
const boxValue = ta => (ta.dataset.bash ? "!" : "") + ta.value;
ui.useBox({ attachments, value: boxValue, render: renderAttachments });
/* the header's model button and /model open the same picker */
export function openModelPicker() {
  const ta = document.getElementById("msg"); if (!ta) return;
  ta.focus(); ta.openModels?.();
}

/* ---------- the box's one prompt line (R9.4-R9.6): Esc, Esc interrupts; b, b sends to the background; x, x closes ----------
   The first key asks in the box, the same key again does it; any other key or a click dismisses it, and
   another prompt's first key replaces it. A view switch, the turn's end or the steps' end take it away too. */
let ask = null; // { kind: "interrupt" | "background" | "close", sid }
export const prompt = () => ask?.kind || null;
const AGAIN = { interrupt: "Escape", background: "b", close: "x" };
/* a running turn, or one waiting on a card, or a running `!` command (sessions.ts ends it first); never for
   a session another process runs */
const canInterrupt = s => Boolean(s) && s.state.driven && !termPid(s) && (s.state.light === "green" || s.state.light === "red" && s.state.status === "waiting" || bangRunning(s));
const bangRunning = s => Boolean(s?.bang?.running);
/* the main conversation's steps that can go: a running foreground Bash or Agent (the backend's `fg`), in a
   running turn of a session Synopia drives */
const bgSteps = s => !s || !s.state.driven || termPid(s) || view || s.state.light !== "green" ? [] : s.items.filter(it => it.k === "tool" && it.fg && it.state === "running");
function askInBox(kind, html) {
  const box = conv().querySelector(".dock .composer"); if (!box) return false;
  dismiss();
  ask = { kind, sid: current };
  const p = box.querySelector(".int-ask") || box.appendChild(Object.assign(document.createElement("p"), { className: "int-ask" }));
  p.setAttribute("role", "alert"); p.innerHTML = html;
  box.classList.add("asking");
  return true;
}
function dismiss() {
  ask = null;
  document.getElementById("log")?.classList.remove("bg-asking");
  conv().querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
/* the first Esc */
export function askInterrupt() {
  return canInterrupt(cur()) && askInBox("interrupt", `<b>Interrupt?</b> <kbd>Esc</kbd> again to stop. Any other key to keep working.`);
}
/* the first b: the steps that can go are marked in the transcript; false when nothing can go */
export function askBackground() {
  const log = document.getElementById("log");
  if (!log || !bgSteps(cur()).length || !askInBox("background", `<b>Send to background?</b> <kbd>b</kbd> again. Any other key to keep it in front.`)) return false;
  log.classList.add("bg-asking");
  return true;
}
/* the first x: with what will stop; a session another process drives is only removed from Synopia */
export function askClose() {
  const s = cur(); if (!s) return false;
  const other = !s.state.driven || Boolean(termPid(s)), stops = other ? "" : closeStops(s);
  return askInBox("close", other
    ? `<b>Remove it from Synopia?</b> <kbd>x</kbd> again. Its other process keeps running.`
    : `<b>Close this session?</b> <kbd>x</kbd> again. Any other key to keep it.${stops ? ` ${esc(stops)}` : ""}`);
}
/* the second key: interrupt (the foreground turn only), background (backgroundTasks() on the session's
   process; the backend says so only when nothing moved), or close (the header's `close`: the session keeps
   its place and comes back from the Open list) */
function confirm() {
  const a = ask; dismiss();
  const s = cur(); if (!a || a.sid !== current || !s) return;
  if (a.kind === "interrupt" && canInterrupt(s)) act({ t: "interrupt", sid: s.id });
  else if (a.kind === "background" && bgSteps(s).length) act({ t: "background", sid: s.id });
  else if (a.kind === "close") closeSession(s);
}
/* a key while the prompt shows (keys.js); true when it took the key */
export function promptKey(e) {
  if (!ask) return false;
  if (/^(Shift|Meta|Control|Alt|CapsLock)$/.test(e.key)) return true;
  e.preventDefault();
  if (e.key === AGAIN[ask.kind]) confirm();
  else if (!((e.key === "Escape" && askInterrupt()) || (e.key === "b" && askBackground()) || (e.key === "x" && askClose()))) dismiss();
  return true;
}
/* each session or items frame (main.js): the turn ended, the steps finished or the view changed under the prompt */
export function syncPrompt() {
  if (!ask) return;
  const s = cur(), log = document.getElementById("log");
  if (ask.sid !== current || !conv().querySelector(".composer.asking")
    || ask.kind === "interrupt" && !canInterrupt(s)
    || ask.kind === "background" && (!bgSteps(s).length || !log?.classList.contains("bg-asking"))) dismiss();
}
document.addEventListener("mousedown", () => { if (ask) dismiss(); }, true);

/* ---------- what didn't go comes back to its session's box, before what you typed since ----------
   Messages an interrupt cancelled (the server's `restore`), and a send or `!` command the backend refused
   or whose ack the connection lost, with its pasted images (requirements Q9). */
const returned = new Map(); // sid -> { texts, atts }
function giveBack(sid, texts, atts = []) {
  const r = returned.get(sid) || { texts: [], atts: [] };
  r.texts.push(...texts); r.atts.push(...atts);
  returned.set(sid, r);
  if (mounted && mounted.startsWith(sid + "|")) takeReturned(sid);
}
export function restoreTexts(sid, texts, images = []) {
  if (!texts?.length) return;
  // the backend's restore carries a queued message's images as base64 (protocol.js): back into pasted-image form
  const atts = (images || []).map(im => { const url = `data:${im.mediaType};base64,${im.data}`; return { id: ui.newId(), n: im.n, mediaType: im.mediaType, url, data: url }; });
  giveBack(sid, texts, atts);
  toast(texts.length === 1 ? "Your queued message is back in the message box." : `Your ${texts.length} queued messages are back in the message box.`);
}
function takeReturned(sid) {
  const r = returned.get(sid), ta = document.getElementById("msg");
  if (!r || !ta) return;
  returned.delete(sid);
  ta.bashBefore = ta.value; // a `!` command back in an empty box is bash mode again (mountBash)
  ta.value = [...r.texts, ta.value].filter(t => t.trim()).join("\n\n");
  for (const a of r.atts) { flying.delete(a); if (!attachments.includes(a)) attachments.push(a); }
  ta.dispatchEvent(new Event("input"));
  renderAttachments(); ui.changed();
}

/* ---------- sending: Enter sends the text and the tagged images (R5.13) ---------- */
/* the images a send carries, in the shape the backend reads (sdk.ts userContent: the text, then these in tag
   order), or null after a toast when one can't go; the backend checks the same caps (sdk.ts imageError), but
   a frame over the socket's cap would close the socket instead of answering */
function imagesOf(going) {
  const images = []; let total = 0;
  for (const a of going) {
    if (!a.data) { toast("An image is still being read. Press Enter again in a moment."); return null; }
    const m = /^data:([^;,]+);base64,(.*)$/.exec(a.data);
    if (!m || !IMAGE_TYPES.includes(m[1])) { toast("Only PNG and JPEG images can be sent. Remove the others first."); return null; }
    const bytes = m[2].length * 3 / 4;
    if (bytes > MAX_IMAGE_BYTES) { toast("An image is over 5 MB. Remove it, or paste a smaller one."); return null; }
    total += bytes;
    images.push({ mediaType: m[1], data: m[2], n: a.n });
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) { toast(`These images are ${Math.ceil(total / 1048576)} MB together, over ${MAX_TOTAL_IMAGE_BYTES / 1048576} MB. Send fewer at a time.`); return null; }
  return images;
}
function clearBox(ta) {
  ta.value = ""; ta.style.height = "auto";
  attachments.length = 0; renderAttachments();
  ui.flush(); // the sent draft is gone from the backend at once, its images too
}
/* s.id follows the session when its id changes (a new session's real id), so the message reaches it */
function sendMsg(s, ta) {
  if (ta.dataset.bash) { runBang(s, ta); return; }
  const going = attachments.filter(a => tagged(a, ta.value)); // an image whose tag was deleted stays behind
  if (!ta.value.trim() && !going.length) return;
  if (ta.value.trim() === "/model" && !going.length) { openModelPicker(); return; } // typed in full: the picker, not a message
  const images = imagesOf(going); if (!images) return;
  const text = ta.value, held = Boolean(termPid(cur())) || takeoverWait?.sid === s.id;
  const done = ok => {
    if (held) { if (!ok && takeoverWait?.sid === s.id && takeoverWait.text === text) { takeoverWait = null; syncTakeover(); } return; }
    for (const a of going) flying.delete(a);
    if (ok) free(going); else giveBack(s.id, [text], going);
  };
  if (!act({ t: "send", sid: s.id, text, images, uuid: newUuid() }, { done, refused: KEPT })) return;
  if (held) { takeoverWait = { sid: s.id, text, seen: false }; syncTakeover(); return; } // the box keeps it until the session is back from the terminal
  for (const a of going) flying.add(a);
  clearBox(ta);
}

export function mountComposer(s) {
  const ta = document.getElementById("msg");
  ask = null; // switching sessions or views cancels a prompt
  renderAttachments();
  /* a pick is stored per session (the backend's session message updates the header) and applied to a running process (setModel, the effort through applyFlagSettings) */
  attachSlash(ta, (m, effort) => {
    act({ t: "setModel", sid: s.id, model: m.value, effort }); // the header shows it once stored; a running CLI also writes "/model …" to the transcript
  });
  /* Enter sends, Shift+Enter breaks the line; Esc goes back to normal mode (the menu above takes the first one) */
  ta.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(s, ta); }
    else if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (takeoverWait?.sid === s.id) cancelTakeBack(); setMode("normal"); }
  });
  mountBash(s, ta);
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(240, ta.scrollHeight) + "px"; markUntagged(); });
  /* the whole box is the touch target: a press anywhere in it that isn't on a control focuses the field,
     with the caret at the end when it lands outside the text */
  const box = ta.closest(".composer");
  box.addEventListener("mousedown", e => {
    if (e.target === ta || e.target.closest("button, a, input, .slash, .attach img")) return;
    e.preventDefault(); ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n);
  });
  ta.addEventListener("paste", e => {
    for (const item of e.clipboardData?.items || []) if (item.type.startsWith("image/")) {
      e.preventDefault(); const file = item.getAsFile(), a = { id: ui.newId(), n: nextImageNumber(cur(), ta.value), mediaType: file.type, url: URL.createObjectURL(file), data: null };
      attachments.push(a); insertTag(ta, a.n); renderAttachments();
      /* then kept with the draft; an image removed (or sent away) before the read ends leaves nothing to keep */
      const r = new FileReader(); r.onload = () => { a.data = r.result; if (attachments.includes(a) || ui.held(a.url)) ui.changed(); }; r.readAsDataURL(file);
    }
  });
  ui.enterComposer(s, ta); // this session's draft: its text, cursor and pasted images (ui-state.js)
  tagLoose(s, ta);
  takeReturned(s.id);
  mountTakeover(s, ta);
}

/* ---------- bash mode (R5.13): `!` as the first character runs a shell command, as in the Claude Code CLI ----------
   The `!` itself leaves the text and becomes the box's mark; Backspace on the empty box leaves the mode. Enter
   runs the command in the session's folder (`bang`); its output shows in the transcript and goes to Claude as
   context, with no turn. Not in a session another process runs, nor one a terminal holds. */
const bashOk = s => Boolean(s) && s.state.driven && !termPid(s);
function setBash(ta, on) {
  if (on) ta.dataset.bash = "1"; else delete ta.dataset.bash;
  paintBash(cur());
}
export function paintBash(s) {
  const ta = document.getElementById("msg"), box = ta?.closest(".composer"); if (!ta || !s) return;
  if (ta.dataset.bash && !bashOk(s)) { delete ta.dataset.bash; ta.value = "!" + ta.value; } // it became read-only: the text stays as typed
  const on = Boolean(ta.dataset.bash);
  box.classList.toggle("bash", on);
  box.querySelector(":scope > .g").textContent = on ? "!" : "❯";
  ta.setAttribute("aria-label", on ? "Shell command" : "Message");
  ta.placeholder = on ? `Run a shell command in ${s.cwd}` : `Message ${s.title}, / for commands`;
}
function mountBash(s, ta) {
  ta.addEventListener("beforeinput", () => { ta.bashBefore = ta.value; });
  /* the first character typed (or pasted, or a kept draft) is a `!`: the mode, and the `!` leaves the text */
  ta.addEventListener("input", () => {
    if (ta.dataset.bash || (ta.bashBefore ?? "") !== "" || !ta.value.startsWith("!") || !bashOk(cur())) return;
    const c = ta.selectionStart; ta.value = ta.value.slice(1); ta.setSelectionRange(Math.max(0, c - 1), Math.max(0, c - 1));
    ta.bashBefore = ta.value;
    setBash(ta, true); ui.changed();
  });
  ta.addEventListener("keydown", e => {
    if (e.key === "Backspace" && ta.dataset.bash && !ta.value) { e.preventDefault(); setBash(ta, false); ui.changed(); }
  });
}
/* Enter in bash mode: one command at a time per session */
function runBang(s, ta) {
  const cmd = ta.value; if (!cmd.trim()) return;
  if (bangRunning(cur())) { toast("A shell command is still running in this session. Wait for it, or Esc, Esc to end it."); return; }
  const done = ok => { if (!ok) giveBack(s.id, ["!" + cmd]); };
  if (!act({ t: "bang", sid: s.id, command: cmd, uuid: newUuid() }, { done, refused: "Not connected to the Synopia backend. Your command is still in the box." })) return;
  ta.value = ""; ta.style.height = "auto"; setBash(ta, false);
  ui.flush();
}

/* ---------- a terminal holds the session (R3.2): the box's one line, and the message that takes it back ----------
   Enter sends as usual (sendMsg); the backend takes the session back once the terminal is idle, and the box
   keeps the text until then. Any edit, or Esc, cancels the wait. */
let takeoverWait = null; // { sid, text, seen }
const termPid = s => s?.state?.detail?.terminal || 0;
function cancelTakeBack() {
  if (!takeoverWait) return;
  if (!act({ t: "cancelTakeover", sid: takeoverWait.sid })) return; // still waiting, as the backend is
  takeoverWait = null; syncTakeover();
}
function mountTakeover(s, ta) {
  ta.closest(".composer").insertAdjacentHTML("beforeend", `<p class="term-line"></p><p class="term-wait" role="status"></p>`);
  ta.addEventListener("input", () => { if (takeoverWait?.sid === s.id && ta.value !== takeoverWait.text) cancelTakeBack(); });
  syncTakeover();
}
/* each session message: the line, the mark, and the box emptied once the message went to Claude */
export function syncTakeover() {
  const s = cur(), ta = document.getElementById("msg"), box = ta?.closest(".composer");
  if (!s || !box) return;
  const d = s.state.detail, pid = termPid(s), w = takeoverWait?.sid === s.id ? takeoverWait : null;
  if (w && d.takeover) w.seen = true;
  else if (w && (w.seen || !pid)) {
    if (!pid && s.state.light === "green") { // it went, as after any send
      if (ta.value === w.text) clearBox(ta);
      takeoverWait = null;
    } else if (w.seen) takeoverWait = null; // it didn't: the text stays, and the toast said why
  }
  const line = box.querySelector(".term-line"), mark = box.querySelector(".term-wait");
  if (line) line.textContent = pid ? `Open in a terminal (pid ${pid}). Type there, or send here to bring it back.` : "";
  if (mark) mark.textContent = d.takeover === "taking" ? "Bringing it back from the terminal…" : d.takeover || takeoverWait?.sid === s.id ? "Waiting for the terminal to finish…" : "";
  box.classList.toggle("held", Boolean(pid));
  if (ta.dataset.bash && !bashOk(s)) paintBash(s); // no bash mode in a session a terminal holds
  box.classList.toggle("taking", Boolean(mark?.textContent));
}
