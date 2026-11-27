/* Composer: the message box, pasted images, the slash menu and the model picker (split from prototype/app.html),
   bash mode, the box's one prompt line (Esc, b, x, f) and the terminal-held line. mountComposer runs once per
   session view (transcript.js renderConv), so data never resets what you type. */
import { store, cur, current, view, mounted, queuedOf, requestsOf } from "./state.js";
import { act } from "./connection.js";
import { esc, modelLabel } from "./format.js";
import { thumbHTML } from "./images.js";
import * as ui from "./ui-state.js";
import { closeStops, closeSession } from "./sidebar.js";
import { setMode } from "./mode.js";
import { toast } from "./toast.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./protocol.js";
import { rank, marked } from "./fuzzy.js";
import { showFolderList } from "./folder-list.js";
import { showMcp } from "./mcp-panel.js";
import { shownBg } from "./bg-view.js";
import { bgState } from "./runs.js";

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
/* the commands by name, then the one matcher (fuzzy.js, R3.14): ties keep that order */
/* Synopia's own commands (R5.15): Synopia runs them, the message goes nowhere; a session's row of the same name gives way */
const OWN = [{ name: "mcp", description: "Sign in to MCP servers, reconnect, enable or disable them", hint: "" }];
const commandsOf = () => [...OWN, ...MENU().commands.filter(c => !OWN.some(o => o.name === c.name))];
const commandsFor = q => rank(commandsOf().sort((a, b) => a.name.localeCompare(b.name)), q, c => c.name);
/* A typed `/name` the session can't run (R5.16): not Synopia's, not in the session's command list (the menu; the
   backend leaves out only `__` names and server-side ones, sdk.ts toCommands). A path (`/Users/…`) is no command,
   and with no menu read yet nothing is refused. Returns the name refused, else null. */
function terminalOnly(text) {
  const m = /^\/([^\s/]+)(?:\s|$)/.exec(text.trimStart()); if (!m) return null;
  const name = m[1], cmds = MENU().commands;
  if (!cmds.length || name.startsWith("__") || OWN.some(o => o.name === name) || cmds.some(c => c.name === name)) return null;
  return name;
}
/* /mcp: the panel, and the box empties as after a send */
function runOwn(ta) {
  const s = cur(); if (!s) return;
  ta.value = ""; ta.style.height = "auto"; ta.dispatchEvent(new Event("input")); ui.changed();
  showMcp(s.id);
}
function attachSlash(ta, onModel) {
  const box = document.getElementById("slash");
  let mode = null, items = [], ats = [], sel = 0, eff = null; // eff: the effort level picked on the selected model row; ats: each row's matched letters
  const fill = hits => { items = hits.map(h => h.row); ats = hits.map(h => h.at); };
  const close = () => { box.hidden = true; mode = null; };
  const draw = () => {
    if (!items.length) { box.innerHTML = `<div class="head">${mode === "model" ? "No matching model" : "No matching command"}</div>`; box.hidden = false; return; }
    box.innerHTML = (mode === "model" ? `<div class="head">Choose a model for this session${items.some(m => (m.effort || []).length) ? ", ← → for the effort" : ""}</div>` : "") + items.slice(0, 40).map((it, i) => mode === "model"
      ? `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">${it.value === modelValue() ? "❯ " : "  "}${marked(it.name, ats[i])}</span><span class="d">${esc(it.description || "")}</span>${i === sel && (it.effort || []).length ? effortRow(it) : ""}</div>`
      : `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">/${marked(it.name, ats[i])}${it.hint ? ` <span class="h">${esc(it.hint)}</span>` : ""}</span><span class="d">${esc(it.description)}</span></div>`).join("");
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
    if (mode === "model") { // typing after "/model " filters the models
      if (!ta.value.startsWith("/model ")) { close(); return; }
      fill(rank(MENU().models, ta.value.slice(7), m => m.name || m.value)); sel = 0; eff = effortFor(items[sel]); draw();
      return;
    }
    if (ta.dataset.bash) { close(); return; } // bash mode: no slash menu
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m) { close(); return; }
    mode = "cmd"; fill(commandsFor(m[1])); sel = 0; draw();
  };
  const pick = () => {
    const it = items[sel];
    if (!it) { if (mode === "cmd" && ta.value.trim() === "/model") openModels(); return; } // a menu without the /model row
    if (mode === "model") { close(); ta.value = ""; onModel(it, (it.effort || []).includes(eff) ? eff : null); return; }
    if (it.name === "model") { openModels(); return; }
    if (it.name === "mcp") { close(); runOwn(ta); return; }
    ta.value = `/${it.name} `; close(); ta.focus();
  };
  const openModels = () => {
    mode = "model"; items = MENU().models; ats = []; sel = Math.max(0, items.findIndex(m => m.value === modelValue())); eff = effortFor(items[sel]); ta.value = "/model "; draw();
  };
  ta.openModels = openModels;
  ta.addEventListener("input", update);
  /* while the menu shows it has the box's keys; first of the box's listeners, so its Esc and Enter come first */
  ta.addEventListener("keydown", e => {
    if (box.hidden) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !items.length) { e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; if (mode === "model") eff = effortFor(items[sel]); draw(); }
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
/* the tag goes in at the caret, a space before it when it touches text, and a space after it unless one
   follows already, so typing goes on as a new word */
function insertTag(ta, n) {
  const v = ta.value, i = ta.selectionStart, j = ta.selectionEnd;
  const tag = (i > 0 && !/\s/.test(v[i - 1]) ? " " : "") + imageTag(n) + (/\s/.test(v[j] || "") ? "" : " ");
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

/* ---------- the box's one prompt line (R9.4-R9.6, R9.8): Esc, Esc interrupts (in a run's shell view it stops that
   run, 2026-11-26); b, b sends to the background; x, x closes; f, f sends the queued messages now ----------
   The first key asks in the box, the same key again does it; any other key or a click dismisses it, and
   another prompt's first key replaces it. A view switch, the turn's end or the steps' end take it away too. */
let ask = null; // { kind: "interrupt" | "stop" | "background" | "close" | "now", sid, bg }
export const prompt = () => ask?.kind || null;
const AGAIN = { interrupt: "Escape", stop: "Escape", background: "b", close: "x", now: "f" };
/* a running turn, or one waiting on a card; never for a session another process runs. Your `!` command keeps
   running: it stops in its shell view (2026-11-26) */
const canInterrupt = s => Boolean(s) && s.state.driven && !termPid(s) && (s.state.light === "green" || s.state.light === "red" && s.state.status === "waiting");
/* the run whose shell view is shown and that Esc, Esc stops there (R9.4, 2026-11-26): your `!` command, the
   refresh, or Claude's background shell or monitor in a session Synopia drives. Claude's foreground step is the
   turn: its view asks "Interrupt?" */
const stoppable = s => { const b = shownBg(); return b && !b.step && bgState(b) === "running" && (b.own || b.creds || (s.state.driven && !termPid(s))) ? b : null; };
/* the main conversation's steps that can go: a running foreground Bash or Agent (the backend's `fg`), in a
   running turn of a session Synopia drives */
const bgSteps = s => !s || !s.state.driven || termPid(s) || view || s.state.light !== "green" ? [] : s.items.filter(it => it.k === "tool" && it.fg && it.state === "running");
/* the box's draft as a message: text or a tagged image, not a `!` command (that runs, it isn't sent) */
const draftIn = ta => Boolean(ta) && !ta.dataset.bash && Boolean(ta.value.trim() || attachments.some(a => tagged(a, ta.value)));
/* f, f: the main turn of a session Synopia drives runs, no card waits (it comes first), and messages are queued
   or a draft is in the box; the backend picks how the turn changes (session.ts nowRoute) */
const canSendNow = s => Boolean(s) && s.state.driven && !termPid(s) && !view && s.state.light === "green" && !requestsOf(s).length
  && (queuedOf(s).length > 0 || draftIn(document.getElementById("msg")));
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
  document.getElementById("log")?.classList.remove("bg-asking", "now-asking");
  conv().querySelectorAll(".composer.asking").forEach(b => b.classList.remove("asking"));
}
/* the first Esc */
export function askInterrupt() {
  const s = cur(), b = s && stoppable(s);
  if (b) { const what = b.kind === "monitor" ? "monitor" : "shell"; if (!askInBox("stop", `<b>Stop this ${what}?</b> <kbd>Esc</kbd> again to stop it. Any other key to keep it running.`)) return false; ask.bg = b.toolUseId; return true; }
  if (view && !shownBg()?.step) return false; // a subagent's or an ended run's view: nothing of its own to stop
  return canInterrupt(s) && askInBox("interrupt", `<b>Interrupt?</b> <kbd>Esc</kbd> again to stop. Any other key to keep working.`);
}
/* the first b: the steps that can go are marked in the transcript; false when nothing can go */
export function askBackground() {
  const log = document.getElementById("log");
  if (!log || !bgSteps(cur()).length || !askInBox("background", `<b>Send to background?</b> <kbd>b</kbd> again. Any other key to keep it in front.`)) return false;
  log.classList.add("bg-asking");
  return true;
}
/* the first f: the queued bands that will go are marked; false when there is nothing to send */
export function askNow() {
  const log = document.getElementById("log");
  if (!log || !canSendNow(cur()) || !askInBox("now", `<b>Send all now?</b> <kbd>f</kbd> again. Any other key to keep them queued.`)) return false;
  log.classList.add("now-asking");
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
  else if (a.kind === "stop") { const b = stoppable(s); if (b && b.toolUseId === a.bg) act(b.own ? { t: "bangStop", sid: s.id, bg: b.toolUseId } : b.creds ? { t: "credsCancel", sid: s.id } : { t: "stopTask", sid: s.id, bg: b.toolUseId }, { done: (ok, error) => { if (!ok && error) toast(error); } }); }
  else if (a.kind === "background" && bgSteps(s).length) act({ t: "background", sid: s.id });
  else if (a.kind === "close") closeSession(s);
  else if (a.kind === "now" && canSendNow(s)) sendNow(s);
}
/* a key while the prompt shows (keys.js); true when it took the key */
export function promptKey(e) {
  if (!ask) return false;
  if (/^(Shift|Meta|Control|Alt|CapsLock)$/.test(e.key)) return true;
  e.preventDefault();
  if (e.key === AGAIN[ask.kind]) confirm();
  else if (!((e.key === "Escape" && askInterrupt()) || (e.key === "b" && askBackground()) || (e.key === "x" && askClose()) || (e.key === "f" && askNow()))) dismiss();
  return true;
}
/* each session or items frame (main.js): the turn ended, the steps finished or the view changed under the prompt */
export function syncPrompt() {
  if (!ask) return;
  const s = cur(), log = document.getElementById("log");
  if (ask.sid !== current || !conv().querySelector(".composer.asking")
    || ask.kind === "interrupt" && !canInterrupt(s)
    || ask.kind === "stop" && stoppable(s)?.toolUseId !== ask.bg
    || ask.kind === "background" && (!bgSteps(s).length || !log?.classList.contains("bg-asking"))
    || ask.kind === "now" && (!canSendNow(s) || !log?.classList.contains("now-asking"))) dismiss();
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
/* An open item's button (R7.1, open-items.js): `text` on a new line of the session's draft, the caret after it, in
   insert mode. Nothing is sent: you add more, or send with Enter. A `!` command in the box stays one, its `!` back
   in the text. False when the box isn't on screen (a view with no box, a gone folder). */
export function writeLine(sid, text) {
  const ta = document.getElementById("msg"); if (!ta || sid !== current || ta.readOnly) return false;
  if (ta.dataset.bash) { ta.value = ta.value ? "!" + ta.value : ""; setBash(ta, false); }
  ta.bashBefore = ta.value;
  ta.value = ta.value && !ta.value.endsWith("\n") ? `${ta.value}\n${text}` : ta.value + text;
  ta.dispatchEvent(new Event("input"));
  setMode("insert");
  const n = ta.value.length; ta.setSelectionRange(n, n);
  ui.changed();
  return true;
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
  if (ta.value.trim() === "/mcp" && !going.length) { runOwn(ta); return; } // Synopia's panel, not a message (R5.15)
  const only = terminalOnly(ta.value);
  if (only) { toast(`/${only} works only in a terminal`); return; } // the box keeps it (R5.16)
  const images = imagesOf(going); if (!images) return;
  const text = ta.value, held = Boolean(termPid(cur())) || takeoverWait?.sid === s.id;
  const done = ok => {
    if (held) { if (!ok && takeoverWait?.sid === s.id && takeoverWait.text === text) { takeoverWait = null; syncTakeover(); } return; }
    for (const a of going) flying.delete(a);
    if (ok) free(going); else giveBack(s.id, [text], going);
  };
  const uuid = newUuid();
  if (!act({ t: "send", sid: s.id, text, images, uuid }, { done, refused: KEPT })) return;
  if (held) { takeoverWait = { sid: s.id, text, seen: false }; syncTakeover(); return; } // the box keeps it until the session is back from the terminal
  for (const a of going) flying.add(a);
  const log = document.getElementById("log"); // sent at the end, the log scrolls on to show it; scrolled up, it stays where you read
  sent = log && ui.atEnd(log) ? { id: uuid, at: performance.now() } : null;
  clearBox(ta);
}
/* The message just sent (R5.5): once its band shows (its `q:<uuid>` block, or its prompt once landed), transcript.js
   scrolls the log smoothly to the end, so you see it and the Working line below it. `shown(id)`: its block is in the log. */
let sent = null; // { id, at }
export function takeSent(shown) {
  if (!sent) return null;
  if (performance.now() - sent.at > 3000) { sent = null; return null; } // refused, or another view: no scroll
  if (!shown(sent.id)) return null;
  const s = sent; sent = null; return s;
}

/* f, f (R9.8): one `sendNow`; the draft goes with it as a send's would (its band shows as queued), and comes
   back to the box when the backend couldn't do it */
function sendNow(s) {
  const ta = document.getElementById("msg");
  if (!draftIn(ta)) { act({ t: "sendNow", sid: s.id }); return; }
  const going = attachments.filter(a => tagged(a, ta.value));
  const images = imagesOf(going); if (!images) return;
  const text = ta.value, uuid = newUuid();
  const done = ok => { for (const a of going) flying.delete(a); if (ok) free(going); else giveBack(s.id, [text], going); };
  if (!act({ t: "sendNow", sid: s.id, draft: { text, images, uuid } }, { done, refused: KEPT })) return;
  for (const a of going) flying.add(a);
  const log = document.getElementById("log"); // as a send: at the end, the log scrolls on to show its band (takeSent)
  sent = log && ui.atEnd(log) ? { id: uuid, at: performance.now() } : null;
  clearBox(ta);
}

export function mountComposer(s) {
  const ta = document.getElementById("msg");
  ask = null; // switching sessions or views cancels a prompt
  if (!ta) return; // a subagent, shell or monitor view has no box (R5.12); the draft waits for Main conversation
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
  mountGone(s, ta);
}

/* ---------- its folder is gone (R3.11): the box's one line instead of the field ----------
   Enter in normal mode (keys.js) or a click on the line opens "Continue in a folder" (folder-list.js). */
function mountGone(s, ta) {
  const box = ta.closest(".composer");
  box.insertAdjacentHTML("beforeend", `<p class="gone-line" role="status">This folder no longer exists. <b>Enter</b> picks a folder to continue in.</p>`);
  box.querySelector(".gone-line").addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); const c = cur(); if (c?.gone) showFolderList({ sid: c.id }); });
  syncGone();
}
export function syncGone() {
  const s = cur(), ta = document.getElementById("msg"), box = ta?.closest(".composer");
  if (!s || !box) return;
  const gone = Boolean(s.gone);
  box.classList.toggle("gone", gone);
  if (gone && document.activeElement === ta) { ta.blur(); setMode("normal"); }
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
  /* while messages wait for the turn (R5.5) the empty box says how many; the queue above the box shows which */
  const waiting = queuedOf(s).length;
  ta.placeholder = on ? `Run a shell command in ${s.cwd}` : waiting ? `${waiting} waiting for Claude's next step` : `Message ${s.title}, / for commands`;
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
  if (cur()?.bang?.running) { toast("A shell command is still running in this session. Wait for it, or stop it in its shell view."); return; }
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
