/* Main: the page's entry module (index.html loads it after theme.js). It applies each server message to the
   store (state.js), renders the panels that changed, runs the 1 s ticker for live times, wires the hooks
   that would otherwise be import cycles, and connects. Nothing here or in the modules it imports publishes
   on `window` except the test API (test-api.js). */
import * as state from "./state.js";
import { store, isCurrent, isViewed } from "./state.js";
import { connect, hooks } from "./connection.js";
import * as ui from "./ui-state.js";
import * as format from "./format.js";
import * as rail from "./rail.js";
import * as sidebar from "./sidebar.js";
import * as preview from "./preview.js";
import * as transcript from "./transcript.js";
import { renderCard, qstate } from "./card.js";
import { syncPrompt, syncTakeover, restoreTexts } from "./composer.js";
import { want, applyRecent, recentAgain } from "./open-list.js";
import { renderAll } from "./keys.js";
import { setMode } from "./mode.js";
import { toast } from "./toast.js";
import { onThemeChange } from "./theme-switch.js";
import { onGraceEnd } from "./tween.js";
import { installTestApi } from "./test-api.js";

/* render(part): side, header, log, card, rail, or conv (all of the view) */
function render(...parts) {
  for (const p of new Set(parts)) {
    if (p === "side") sidebar.renderSide();
    else if (p === "conv") transcript.renderConv();
    else if (p === "header") transcript.renderHeader();
    else if (p === "log") transcript.renderLog();
    else if (p === "card") renderCard();
    else if (p === "rail") rail.renderRail();
  }
}

function onMessage(m) {
  switch (m.t) {
    case "hello": {
      state.applyHello(m); ui.applyHello(m.ui); state.pickCurrent(); // the stored ui state first: no default view flashes
      transcript.clearAsked(); recentAgain(); // requests sent before a drop get no reply: ask again
      showUpdate(m.update);
      /* a reconnect onto the view on screen: it keeps its log until its reset comes, so the log never blanks
         for a frame (hello has no items) and the message box stays as it was */
      const before = state.mounted, stays = !!before && before === `${state.current}|${state.view || ""}`;
      if (stays) ui.expectReset();
      renderAll(); // mounting another view asks the server for it
      if (stays && state.mounted === before) ui.requestView(state.current, state.view);
      ui.afterRender();
      break;
    }
    case "session": {
      const had = store.sessions.has(m.id) || store.sessions.has(m.replaces);
      if (m.replaces) renamed(m.replaces, m.id);
      state.applySession(m);
      if (!had && want.new && m.id.startsWith("new-")) { want.new = false; state.select(m.id); setMode("insert", false); renderAll(); break; }
      if (want.open === m.id) { want.open = null; state.select(m.id); renderAll(); break; } // opened from the Open list
      if (!state.current) state.pickCurrent();
      syncPrompt(); syncTakeover(); // the turn ended under the "Interrupt?" or "Send to background?" prompt
      if (!had || !state.mounted) { renderAll(); break; }
      render("side", ...(isCurrent(m.id) ? ["header", "log", "card", "rail"] : []));
      break;
    }
    case "removed": {
      if (state.applyRemoved(m)) renderAll(); else render("side");
      break;
    }
    case "items": {
      if (!state.applyItems(m)) break;
      if (!isViewed(m.sid, m.agent)) break;
      ui.resetIn(m); // the log a view switch held back renders now, once
      if (m.prepend) { transcript.renderLogKeepingPlace(); ui.items(m); break; } // earlier items: the card and header don't change
      render("log", "card", "header"); // the header drops its Now line while a new session is empty
      syncPrompt(); // the marked steps ended or went to the background
      ui.items(m); // a restored scroll waits for these
      runHooks(m);
      break;
    }
    case "agents": {
      if (!state.applyAgents(m)) break;
      render("side", ...(isCurrent(m.sid) ? ["header", "log", "rail"] : []));
      break;
    }
    case "background": {
      if (!state.applyBackground(m)) break;
      render("side", ...(isCurrent(m.sid) ? ["rail", "card"] : []));
      break;
    }
    case "pending": {
      state.applyPending(m);
      render("side", ...(isCurrent(m.sid) ? ["log", "card", "rail"] : []));
      break;
    }
    case "stream": {
      if (state.applyStream(m) && isViewed(m.sid, null)) render("log");
      break;
    }
    case "layout": {
      state.applyLayout(m);
      render("side");
      break;
    }
    case "menu": {
      state.applyMenu(m);
      render("header");
      break;
    }
    case "toast": transcript.clearAsked(); toast(m.text); break; // a failed toolOutput replies with a toast
    case "toolOutput": transcript.applyToolOutput(m); break;
    case "recent": applyRecent(m); break;
    case "preview": preview.showPreview(m); break;
    case "restore": restoreTexts(m.sid, m.texts, m.images); break;
    case "update": showUpdate(m.pending); break;
    default: break;
  }
}

/* a session's id changed (a new session got its real id, or a reset): the page's state for it follows, so
   the message box keeps what you typed (the store moves the session, its card and `current` itself, and
   takes the frame's layout, state.js applySession) */
function renamed(from, to) {
  /* the view on screen keeps its frame: renderConv sees the same key under the new id */
  if (state.mounted && state.mounted.startsWith(from + "|")) state.setMounted(to + state.mounted.slice(from.length));
  // a card still up moves with what you picked on it
  for (const k of Object.keys(qstate)) if (k.startsWith(from + ":")) { qstate[to + k.slice(from.length)] = qstate[k]; delete qstate[k]; }
  ui.rekey(from, to); // its scroll, draft, open steps and the rest
}

/* a backend update waits for the running work to end: one quiet footer line, until the daemon hands over */
function showUpdate(pending) { document.getElementById("upd").hidden = !pending; }

/* the ?agent= and ?open= hooks, once the view they need has its items */
function runHooks(m) {
  if (hooks.agent && !m.agent) {
    const s = state.cur(); if (s && state.agentById(s, hooks.agent)) { state.selectView(hooks.agent); hooks.agent = null; transcript.renderConv(); }
    return;
  }
  if (hooks.open) {
    const r = [...document.querySelectorAll(".frow .fc")].pop();
    if (r) { hooks.open = null; r.click(); r.scrollIntoView({ block: "start" }); }
  }
}

ui.useLog(transcript.renderLog, transcript.loadEarlier);
sidebar.onPick(renderAll); // a row's click shows its session
onThemeChange(preview.previewRetheme); // bat's colours come from the backend
onGraceEnd(() => render("side", "rail")); // a finished line's grace is over: it leaves
installTestApi({ inject: onMessage, render });

/* live durations and ages tick once a second, in place */
setInterval(() => {
  const now = Date.now(); state.tick(now);
  document.querySelectorAll("[data-live]").forEach(el => { el.textContent = format.tookLive(now - new Date(el.dataset.live)); });
  document.querySelectorAll("[data-age]").forEach(el => { el.textContent = format.dur(+el.dataset.age); });
  document.querySelectorAll("[data-until]").forEach(el => { el.textContent = format.left(+el.dataset.until); });
}, 1000);

renderAll();
connect({
  message: onMessage,
  open: () => state.setConnected(true),
  close: () => state.setConnected(false),
  refused: () => toast("The page's token was refused. Open Synopia again."),
  toast,
});
