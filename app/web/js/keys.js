/* Keys (requirements R9): the page's one keyboard dispatcher. What is on top takes the keys, and nothing under
   it sees them: the file preview, then the image viewer, the Open list, the Waiting on you list, the MCP panel, a sidebar drag; with none of them up,
   the session keys below. Text fields keep their own editing keys on the field itself (the message box and
   its menu, composer.js; a card's field, card.js; a group's name, sidebar.js; the Open list's filter types):
   the session keys leave a focused field alone, except ⌘⇧[ ] and the box's Esc (composer.js). */
import { current, cur, view, select, selectView, agentById, bgById } from "./state.js";
import { mode, setMode, paintMode } from "./mode.js";
import { KEYS, renderSide } from "./sidebar.js";
import { drag, dragKey } from "./dnd.js";
import { renderConv, loadEarlier, toEnd, openItem, dismissItem } from "./transcript.js";
import { renderRail, waitingIds } from "./rail.js";
import { focusedItem, focusItem } from "./open-items.js";
import { promptKey, askInterrupt, askBackground, askClose, askNow, writeLine } from "./composer.js";
import { qaKeys } from "./card.js";
import { openListShown, openListKey, showOpenList } from "./open-list.js";
import { waitingListShown, waitingListKey, showWaitingList, onWaitingPick } from "./waiting-list.js";
import { folderListKeys, folderListKey, openNewSession, showFolderList } from "./folder-list.js";
import { previewShown, previewKey } from "./preview.js";
import { viewer, viewerKey } from "./images.js";
import { mcpShown, mcpKey } from "./mcp-panel.js";
import { focusRunInput } from "./bg-view.js";
import { findKey } from "./find.js";

/* top first: while one is shown it has every key */
const LAYERS = [
  { shown: previewShown, key: previewKey },
  { shown: () => !!viewer, key: viewerKey },
  { shown: openListShown, key: openListKey },
  { shown: waitingListShown, key: waitingListKey },
  { shown: mcpShown, key: mcpKey },
  { shown: folderListKeys, key: folderListKey },
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
document.addEventListener("focusin", e => { if ((e.target.id === "msg" || e.target.id === "qa-own" || e.target.id === "run-in") && mode !== "insert") setMode("insert", false); });
document.addEventListener("focusout", e => { if ((e.target.id === "msg" || e.target.id === "run-in") && mode !== "normal") setMode("normal", false); });

/* the whole page, the sidebar and the conversation shown */
export function renderAll() { renderSide(); renderConv(); paintMode(); if (mode === "insert") (document.getElementById("qa-own") || document.getElementById("msg"))?.focus(); }

function sessionKey(e) {
  /* ⌘F finds in the transcript, in insert mode too; with its bar up, ⌘G and its field's Enter and Esc (find.js, R9.9) */
  if (findKey(e)) return;
  /* ⌘⇧[ and ⌘⇧] move to the previous or next session, like tabs in iTerm, in insert mode too */
  if (e.metaKey && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) { e.preventDefault(); stepSession(e.code === "BracketRight" ? 1 : -1); return; }
  /* Ctrl+J / Ctrl+K: the next or previous session, in insert mode too (it takes Ctrl+K from a text field) */
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "k")) { e.preventDefault(); stepSession(e.key === "j" ? 1 : -1); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || inField(e.target)) return;
  if (e.target.closest && e.target.closest("button") && e.key === " ") e.preventDefault();
  /* Esc, Esc interrupts a running turn; b, b sends its foreground steps to the background; x, x closes the
     session; f, f sends the queued messages now; under the prompt any other key dismisses it, and another
     prompt's first key replaces it (composer.js) */
  if (promptKey(e)) return;
  if ((e.key === "Escape" && askInterrupt()) || (e.key === "b" && askBackground()) || (e.key === "x" && askClose()) || (e.key === "f" && askNow())) { e.preventDefault(); return; }
  if (qaKeys(e)) return;
  const log = document.getElementById("log"), gone = Boolean(cur()?.gone);
  if (gone && /^[ia/]$/.test(e.key)) { e.preventDefault(); return; } // its folder is gone: no field to type in (R3.11)
  if (!document.getElementById("msg") && /^[ia]$/.test(e.key) && focusRunInput()) { e.preventDefault(); return; } // a run's shell view: its `!` band types into it (2026-11-26)
  if (!document.getElementById("msg") && /^[ia/!]$/.test(e.key)) { e.preventDefault(); return; } // a view with no box (R5.12): normal mode stays
  switch (e.key) {
    case "n": e.preventDefault(); openNewSession(); break; // New session (R9.7)
    case "o": e.preventDefault(); showOpenList(); break; // Open session (R9.7)
    case "w": e.preventDefault(); showWaitingList(); break; // the Waiting on you list (R9.10)
    case "Enter": // Continue in a folder (R3.11); else the focused open item, as a click on its text (R9.1); a focused button acts itself
      if (gone) { e.preventDefault(); showFolderList({ sid: cur().id }); }
      else if (!view && focusedItem(current) && !(e.target.closest && e.target.closest("button"))) { e.preventDefault(); openItem(focusedItem(current)); }
      break;
    case "d": e.preventDefault(); if (dismissItem()) renderRail(); break; // the focused open item: "Not an item" (R9.1)
    case "J": e.preventDefault(); stepView(1); break; // the next or previous conversation inside the session
    case "K": e.preventDefault(); stepView(-1); break;
    case "j": e.preventDefault(); log?.scrollBy({ top: 60 }); break;
    case "k": e.preventDefault(); log?.scrollBy({ top: -60 }); break;
    case "g": e.preventDefault(); if (log) { if (log.scrollTop <= 0) loadEarlier(); else log.scrollTop = 0; } break; // at the top: earlier items
    case "G": e.preventDefault(); toEnd(); break;
    case "i": case "a": e.preventDefault(); setMode("insert"); break;
    case "/": { // insert with the command menu open; a half-typed message stays as it is
      e.preventDefault(); setMode("insert"); const ta = document.getElementById("msg");
      if (ta && !ta.value && !ta.dataset.bash) { ta.value = "/"; ta.dispatchEvent(new Event("input")); } // no slash menu in bash mode
      break; }
    // normal mode types nothing: a letter that does nothing now (b with nothing to send, x with no session)
    // is still taken, since one left to WKWebView makes AppKit beep
    default: if (e.key.length === 1) e.preventDefault();
  }
}

/* Enter in the Waiting on you list: its session shown, then the item's id started in the box (R9.10) */
onWaitingPick((sid, line) => { renderAll(); writeLine(sid, line); });

/* Ctrl+J/K and ⌘⇧[ ]: the next or previous shown session, in sidebar order (KEYS, from renderSide); from
   insert mode the next session's box takes the focus (the render blurs the old one) */
function stepSession(step) {
  if (!KEYS.length) return;
  const i = KEYS.indexOf(current), was = mode;
  select(i < 0 ? KEYS[step > 0 ? 0 : KEYS.length - 1] : KEYS[(i + step + KEYS.length) % KEYS.length]); renderAll();
  if (was === "insert" && mode !== "insert" && document.getElementById("msg")) setMode("insert");
}
/* J/K: Main conversation, then the subagents, forks, shells and monitors as the background panel shows
   them, top to bottom (each opens in the pane, R7.2), then the Waiting on you items (R9.1: focused, with
   Main conversation shown); past the last one it wraps to Main conversation */
function stepView(step) {
  const s = cur(); if (!s) return;
  const ids = [...new Set([...document.querySelectorAll(".rail [data-agent], .rail [data-bg]")].map(el => el.dataset.agent || el.dataset.bg))].filter(id => agentById(s, id) || bgById(s, id));
  const items = waitingIds().map(id => ({ item: id }));
  const order = [null, ...ids, ...items];
  const f = !view && focusedItem(s.id), at = f ? order.findIndex(x => x?.item === f) : -1;
  const i = at >= 0 ? at : order.indexOf(view || null);
  /* a view with no row in the panel (a `!` run under 3 s opened from its row, Claude's foreground Bash opened from
     the live line) steps back to Main conversation either way, as its header's crumb does (2026-11-26) */
  if (i < 0) { focusItem(null); selectView(null); renderConv(); return; }
  if (order.length < 2) return;
  const next = order[(i + step + order.length) % order.length];
  if (next && next.item) { focusItem(s.id, next.item, true); if (view) { selectView(null); renderConv(); } else renderRail(); return; }
  focusItem(null); selectView(next); renderConv();
}
