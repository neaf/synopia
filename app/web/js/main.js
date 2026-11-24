/* Main: the page's entry module (index.html loads it after the classic scripts). It applies each server
   message to the store (state.js), renders the panels that changed, runs the 1 s ticker for live times,
   and connects. The classic scripts reach the modules through window accessors (legacy.js). */
import { publish, classic as C } from "./legacy.js";
import * as state from "./state.js";
import { store, isCurrent, isViewed } from "./state.js";
import { connect, send, hooks, TOKEN } from "./connection.js";
import * as ui from "./ui-state.js";
import { installTestApi } from "./test-api.js";

/* render(part): side, header, log, card, rail, or conv (all of the view) */
function render(...parts) {
  for (const p of new Set(parts)) {
    if (p === "side") C.renderSide();
    else if (p === "conv") C.renderConv();
    else if (p === "header") C.renderHeader();
    else if (p === "log") C.renderLog();
    else if (p === "card") C.renderCard();
    else if (p === "rail") C.renderRail();
  }
}

function onMessage(m) {
  switch (m.t) {
    case "hello": {
      state.applyHello(m); ui.applyHello(m.ui); C.layout = null; state.pickCurrent(); // the stored ui state first: no default view flashes
      showUpdate(m.update);
      /* a reconnect onto the view on screen: it keeps its log until its reset comes, so the log never blanks
         for a frame (hello has no items) and the message box stays as it was */
      const before = C.mounted, stays = !!before && before === `${state.current}|${state.view || ""}`;
      if (stays) ui.expectReset();
      C.renderAll(); // mounting another view asks the server for it
      if (stays && C.mounted === before) ui.requestView(state.current, state.view);
      ui.afterRender();
      break;
    }
    case "session": {
      const had = store.sessions.has(m.id) || store.sessions.has(m.replaces);
      if (m.replaces) renamed(m.replaces, m.id);
      state.applySession(m);
      if (!had && C.wantNew && m.id.startsWith("new-")) { C.wantNew = false; state.select(m.id); C.mode = "insert"; C.renderAll(); break; }
      if (C.wantOpen === m.id) { C.wantOpen = null; state.select(m.id); C.renderAll(); break; } // opened from the Open list
      if (!state.current) state.pickCurrent();
      C.syncInterrupt(); C.syncBackground(); C.syncTakeover(); // the turn ended under the "Interrupt?" or "Send to background?" prompt
      if (!had || !C.mounted) { C.renderAll(); break; }
      render("side", ...(isCurrent(m.id) ? ["header", "log", "card", "rail"] : []));
      break;
    }
    case "removed": {
      if (state.applyRemoved(m)) C.renderAll(); else render("side");
      break;
    }
    case "items": {
      if (!state.applyItems(m)) break;
      if (!isViewed(m.sid, m.agent)) break;
      ui.resetIn(m); // the log a view switch held back renders now, once
      if (m.prepend) { C.renderLogKeepingPlace(); ui.items(m); break; } // earlier items: the card and header don't change
      render("log", "card", "header"); // the header drops its Now line while a new session is empty
      C.syncBackground(); // the marked steps ended or went to the background
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
    case "menu": {
      state.applyMenu(m);
      render("header");
      break;
    }
    case "toast": C.stepAsked = null; C.toast(m.text); break; // a failed toolOutput replies with a toast
    case "toolOutput": C.applyToolOutput(m); break;
    case "recent": C.applyRecent(m); break;
    case "preview": C.showPreview(m); break;
    case "restore": C.restoreTexts(m.sid, m.texts); break;
    case "update": showUpdate(m.pending); break;
    default: break;
  }
}

/* a session's id changed (a new session got its real id, or a reset): the layout and the page's state
   for it follow, so the message box keeps what you typed (the store moves the session, its card and
   `current` itself, state.js applySession) */
function renamed(from, to) {
  const swap = ids => ids.map(x => x === from ? to : x);
  for (const l of [C.layout, store.layout]) if (l) { l.groups.forEach(g => g.ids = swap(g.ids)); l.others = swap(l.others); }
  /* the view on screen keeps its frame: renderConv sees the same key under the new id */
  if (C.mounted && C.mounted.startsWith(from + "|")) C.mounted = to + C.mounted.slice(from.length);
  const qstate = C.qstate; // a card still up moves with what you picked on it
  for (const k of Object.keys(qstate)) if (k.startsWith(from + ":")) { qstate[to + k.slice(from.length)] = qstate[k]; delete qstate[k]; }
  ui.rekey(from, to); // its scroll, draft, open steps and the rest
}

/* a backend update waits for the running work to end: one quiet footer line, until the daemon hands over */
function showUpdate(pending) { document.getElementById("upd").hidden = !pending; }

/* the ?agent= and ?open= hooks, once the view they need has its items */
function runHooks(m) {
  if (hooks.agent && !m.agent) {
    const s = state.cur(); if (s && C.agentById(s, hooks.agent)) { state.selectView(hooks.agent); hooks.agent = null; C.renderConv(); }
    return;
  }
  if (hooks.open) {
    const r = [...document.querySelectorAll(".frow .fc")].pop();
    if (r) { hooks.open = null; r.click(); r.scrollIntoView({ block: "start" }); }
  }
}

publish({
  store: () => state.store, data: () => state.data, current: () => state.current, view: () => state.view,
  cur: () => state.cur, requestsOf: () => state.requestsOf, isViewed: () => state.isViewed,
  select: () => state.select, selectView: () => state.selectView,
  send: () => send, TOKEN: () => TOKEN, render: () => render,
  requestView: () => ui.requestView, uiChanged: () => ui.changed, uiFlush: () => ui.flush,
  uiPreviewRestored: () => ui.previewRestored, uiTakeTyping: () => ui.takeTyping, uiLeave: () => ui.leave,
  uiEnterComposer: () => ui.enterComposer, uiHeld: () => ui.held, uiExpectReset: () => ui.expectReset,
  uiHolding: () => ui.holding, uiAfterLog: () => ui.afterLog, uiNewId: () => ui.newId,
});
installTestApi({ inject: onMessage, render });

/* live durations and ages tick once a second, in place */
setInterval(() => {
  const now = C.liveNow(); C.NOWISH = now;
  document.querySelectorAll("[data-live]").forEach(el => { el.textContent = C.tookLive(now - new Date(el.dataset.live)); });
  document.querySelectorAll("[data-age]").forEach(el => { el.textContent = C.dur(+el.dataset.age); });
  document.querySelectorAll("[data-until]").forEach(el => { el.textContent = C.left(+el.dataset.until); });
}, 1000);

C.renderAll();
connect({
  message: onMessage,
  open: () => state.setConnected(true),
  close: () => state.setConnected(false),
  refused: () => C.toast("The page's token was refused. Open Synopia again."),
});
