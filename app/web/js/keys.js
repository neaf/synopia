/* Keys (requirements R9): the page's one keyboard dispatcher. What is on top takes the keys, and nothing under
   it sees them: the file preview, then the image viewer, the Open list, a sidebar drag; with none of them up,
   the session keys below. Text fields keep their own editing keys on the field itself (the message box and
   its menu, composer.js; a card's field, card.js; a group's name, sidebar.js; the Open list's filter types):
   the session keys leave a focused field alone, except ⌘⇧[ ] and the box's Esc (composer.js). */
import { current, cur, view, select, selectView, agentById } from "./state.js";
import { mode, setMode, paintMode } from "./mode.js";
import { KEYS, renderSide } from "./sidebar.js";
import { setOpenBg } from "./rail.js";
import { drag, dragKey } from "./dnd.js";
import { renderConv, loadEarlier } from "./transcript.js";
import { promptKey, askInterrupt, askBackground, askClose } from "./composer.js";
import { qaKeys } from "./card.js";
import { openListShown, openListKey } from "./open-list.js";
import { previewShown, previewKey } from "./preview.js";
import { viewer, viewerKey } from "./images.js";

/* top first: while one is shown it has every key */
const LAYERS = [
  { shown: previewShown, key: previewKey },
  { shown: () => !!viewer, key: viewerKey },
  { shown: openListShown, key: openListKey },
  { shown: () => !!drag?.started, key: dragKey },
];
const inField = t => /INPUT|TEXTAREA|SELECT/.test(t.tagName);

/* the window in the capture phase: before any element's own listener, so a layer's keys never reach the
   field under it */
window.addEventListener("keydown", e => {
  const top = LAYERS.find(l => l.shown());
  if (top) top.key(e); else sessionKey(e);
}, true);

/* mode follows the focus: the message box or a card's field is insert, leaving the box is normal */
document.addEventListener("focusin", e => { if ((e.target.id === "msg" || e.target.id === "qa-own") && mode !== "insert") setMode("insert", false); });
document.addEventListener("focusout", e => { if (e.target.id === "msg" && mode !== "normal") setMode("normal", false); });

/* the whole page, the sidebar and the conversation shown */
export function renderAll() { renderSide(); renderConv(); paintMode(); if (mode === "insert") (document.getElementById("qa-own") || document.getElementById("msg"))?.focus(); }

function sessionKey(e) {
  /* ⌘⇧[ and ⌘⇧] move to the previous or next session, like tabs in iTerm, in insert mode too */
  if (e.metaKey && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) { e.preventDefault(); stepSession(e.code === "BracketRight" ? 1 : -1); return; }
  /* Ctrl+J / Ctrl+K: the next or previous conversation inside the session; normal mode only, so Ctrl+K never fights a text field */
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "k")) {
    if (mode !== "insert" && !inField(e.target)) { e.preventDefault(); stepView(e.key === "j" ? 1 : -1); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || inField(e.target)) return;
  if (e.target.closest && e.target.closest("button") && e.key === " ") e.preventDefault();
  /* Esc, Esc interrupts a running turn; b, b sends its foreground steps to the background; x, x closes the
     session; under the prompt any other key dismisses it, and another prompt's first key replaces it (composer.js) */
  if (promptKey(e)) return;
  if ((e.key === "Escape" && askInterrupt()) || (e.key === "b" && askBackground()) || (e.key === "x" && askClose())) { e.preventDefault(); return; }
  if (qaKeys(e)) return;
  const log = document.getElementById("log");
  switch (e.key) {
    case "J": e.preventDefault(); stepSession(1); break;
    case "K": e.preventDefault(); stepSession(-1); break;
    case "j": e.preventDefault(); log?.scrollBy({ top: 60 }); break;
    case "k": e.preventDefault(); log?.scrollBy({ top: -60 }); break;
    case "g": e.preventDefault(); if (log) { if (log.scrollTop <= 0) loadEarlier(); else log.scrollTop = 0; } break; // at the top: earlier items
    case "G": e.preventDefault(); if (log) log.scrollTop = log.scrollHeight; break;
    case "i": case "a": e.preventDefault(); setMode("insert"); break;
    case "/": { // insert with the command menu open; a half-typed message stays as it is
      e.preventDefault(); setMode("insert"); const ta = document.getElementById("msg");
      if (ta && !ta.value && !ta.dataset.bash) { ta.value = "/"; ta.dispatchEvent(new Event("input")); } // no slash menu in bash mode
      break; }
  }
}

/* J/K and ⌘⇧[ ]: the next or previous shown session, in sidebar order (KEYS, from renderSide) */
function stepSession(step) {
  if (!KEYS.length) return;
  const i = KEYS.indexOf(current);
  select(i < 0 ? KEYS[step > 0 ? 0 : KEYS.length - 1] : KEYS[(i + step + KEYS.length) % KEYS.length]); setOpenBg(null); renderAll();
}
/* Ctrl+J / Ctrl+K: Main conversation, then the subagents and forks as the background panel shows them, top
   to bottom; past the last one it wraps to Main conversation */
function stepView(step) {
  const s = cur(); if (!s) return;
  const ids = [...new Set([...document.querySelectorAll(".rail [data-agent]")].map(el => el.dataset.agent))].filter(id => agentById(s, id));
  const order = [null, ...ids];
  if (order.length < 2) return;
  const i = Math.max(0, order.indexOf(view || null));
  selectView(order[(i + step + order.length) % order.length]); renderConv();
}
