/* Test API: window.__synopia, the one surface the page checks read besides the DOM (docs/Page checks.md).
   Getters return copies, so a check cannot change the page through them; inject() hands a message to the
   page as if the server sent it, and render(), redraw() and resetTweens() re-render on demand. Nothing is
   recorded until a check calls spy(), so in use it costs nothing. The only module that writes `window`;
   main.js installs it with the message handler and the panel render. */
import * as state from "./state.js";
import { tap, acting } from "./connection.js";
import { MARKS, ind } from "./marks.js";
import { tweens } from "./sidebar.js";
import * as ui from "./ui-state.js";
import { renderLog } from "./transcript.js";
import { pv, previewShown } from "./preview.js";
import { mode } from "./mode.js";
import { attachments, prompt } from "./composer.js";
import { qstate, pendingAsk, askKey } from "./card.js";
import { openList, openListShown } from "./open-list.js";
import { fl, folderListShown } from "./folder-list.js";

const copy = x => x === undefined || x === null ? null : structuredClone(x);
const of = (list, types) => copy(types.length ? list.filter(m => types.includes(m.t)) : list);
let spied = null; // { sent, got } since spy()

/* the parts of ready(): the first hello applied, the sidebar drawn, the message box there, the current view
   mounted, no UI restore in flight (the harness adds the socket counts, visibility and focus) */
const readiness = () => ({
  connected: state.store.ui.connected, uiLoaded: ui.loaded(), restoring: ui.isRestoring(),
  rows: document.querySelectorAll("#groups .row").length, box: !!document.querySelector(".dock .composer"), // a subagent, shell or monitor view has only the prompt line (R5.12)
  current: state.current, mounted: state.mounted,
});

export function installTestApi({ inject, render }) {
  window.__synopia = Object.freeze({
    ready: () => { const r = readiness(); return r.connected && r.uiLoaded && !r.restoring && r.rows > 0 && r.box && (!r.current || !!r.mounted); },
    readiness,
    current: () => state.current, // the shown session's id
    view: () => state.view, // the subagent shown, null for the main conversation
    mode: () => mode, // "normal" | "insert"
    mounted: () => state.mounted, // "<sid>|<agent>" of the view on screen
    restoring: () => ui.isRestoring(), // a restored view still waits for its items
    cur: () => copy(state.cur()),
    data: () => copy(state.data), // every session, in the server's order
    pending: sid => copy(state.store.pending.get(sid) || []), // the session's requests, oldest first
    layout: () => copy(state.store.layout), // the sidebar's groups, the backend's, hidden (closed) ids included
    acting: () => acting(), // actions sent and not acked yet (0: every intent's result is in)
    spy: () => {
      spied = { sent: [], got: [] };
      tap.sent = m => spied.sent.push(copy(m)); tap.got = m => spied.got.push(copy(m));
    },
    sent: (...types) => of(spied?.sent || [], types), // frames the page sent since spy(), of these types
    received: (...types) => of(spied?.got || [], types), // frames the server sent since spy()
    inject: m => { inject(copy(m)); },
    /* the UI around the transcript */
    anchor: () => copy(ui.anchor(document.getElementById("log"))), // the log's scroll anchor: {id, off} or {bottom: true}
    from: (sid, agent) => ui.from(sid, agent), // the oldest item id that view had loaded, or null
    attachments: () => attachments.map(a => ({ id: a.id, n: a.n, mediaType: a.mediaType, url: a.url, data: a.data })), // pasted images
    prompt: () => prompt(), // the Esc, b or x prompt shown: "interrupt" | "background" | "close" | null
    card: sid => { const s = state.store.sessions.get(sid ?? state.current), a = s && pendingAsk(s); return a ? copy(qstate[askKey(s, a)]) : null; },
    cards: () => copy(qstate), // every card's state, by "<sid>:<request id>"
    preview: () => ({ shown: previewShown(), path: pv.path }),
    openList: () => ({ shown: openListShown(), filter: openList.filter, totals: openList.totals }),
    folderList: () => ({ shown: folderListShown(), fixed: fl.fixed, sid: fl.sid, filter: fl.filter, rows: fl.rows.map(r => ({ kind: r.kind, path: r.path, gone: r.gone })), sel: fl.sel, known: fl.known.length }),
    marks: () => Object.keys(MARKS), // every mark kind
    mark: (kind, size) => ind(kind, size), // a mark's markup
    /* renders on demand, as a server message would: for checks that a render keeps something */
    render: (...parts) => { render(...parts); }, // "side", "conv", "header", "log", "card", "rail"
    redraw: () => { document.querySelectorAll("#log .log-inner > *").forEach(e => { e._sig = ""; }); renderLog(); }, // every log block replaced
    resetTweens: () => { tweens.clear(); }, // the sidebar forgets its sub-line tweens
  });
}
