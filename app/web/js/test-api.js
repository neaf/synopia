/* Test API: window.__synopia, the one surface the page checks read besides the DOM (docs/Page checks.md).
   Getters return copies, so a check cannot change the page through them; inject() hands a message to the
   page as if the server sent it, and render(), redraw() and resetTweens() re-render on demand. Nothing is
   recorded until a check calls spy(), so in use it costs nothing. A classic script: it reads the other scripts' globals when called. bridge.js calls testSent and testGot. */
let testSpy = null; // { sent, got } since spy()
const testCopy = x => x === undefined || x === null ? null : structuredClone(x);
function testSent(m) { if (testSpy) testSpy.sent.push(testCopy(m)); }
function testGot(m) { if (testSpy) testSpy.got.push(testCopy(m)); }
const testOf = (list, types) => testCopy(types.length ? list.filter(m => types.includes(m.t)) : list);

/* the parts of ready(): the first hello applied, the sidebar drawn, the message box there, the current view
   mounted, no UI restore in flight (the harness adds the socket counts, visibility and focus) */
const testReadiness = () => ({
  connected: store.ui.connected, uiLoaded, restoring: !!uiRestoring,
  rows: document.querySelectorAll("#groups .row").length, box: !!document.getElementById("msg"),
  current, mounted,
});

window.__synopia = Object.freeze({
  ready: () => { const r = testReadiness(); return r.connected && r.uiLoaded && !r.restoring && r.rows > 0 && r.box && (!r.current || !!r.mounted); },
  readiness: testReadiness,
  current: () => current, // the shown session's id
  view: () => view, // the subagent shown, null for the main conversation
  mode: () => mode, // "normal" | "insert"
  mounted: () => mounted, // "<sid>|<agent>" of the view on screen
  restoring: () => !!uiRestoring, // a restored view still waits for its items
  cur: () => testCopy(store.sessions.get(current)),
  data: () => testCopy(data), // every session, in the server's order
  pending: sid => testCopy(store.pending.get(sid) || []), // the session's requests, oldest first
  layout: () => testCopy(layout), // the sidebar's groups, hidden (closed) ids included
  spy: () => { testSpy = { sent: [], got: [] }; },
  sent: (...types) => testOf(testSpy?.sent || [], types), // frames the page sent since spy(), of these types
  received: (...types) => testOf(testSpy?.got || [], types), // frames the server sent since spy()
  inject: m => { onMessage(testCopy(m)); },
  /* the UI around the transcript */
  anchor: () => testCopy(uiAnchor(document.getElementById("log"))), // the log's scroll anchor: {id, off} or {bottom: true}
  from: (sid, agent) => uiFrom(sid, agent), // the oldest item id that view had loaded, or null
  attachments: () => attachments.map(a => ({ id: a.id, n: a.n, mediaType: a.mediaType, url: a.url, data: a.data })), // pasted images
  prompt: () => interruptAsk ? "interrupt" : bgAsk ? "background" : closeAsk ? "close" : null, // the Esc, b or x prompt shown
  card: sid => { const s = store.sessions.get(sid ?? current), a = s && pendingAsk(s); return a ? testCopy(qstate[askKey(s, a)]) : null; },
  cards: () => testCopy(qstate), // every card's state, by "<sid>:<request id>"
  preview: () => ({ shown: previewShown(), path: pv.path }),
  openList: () => ({ shown: openListShown(), filter: openList.filter }),
  marks: () => Object.keys(P), // every mark kind
  mark: (kind, size) => ind(kind, size), // a mark's markup
  /* renders on demand, as a server message would: for checks that a render keeps something */
  render: (...parts) => { render(...parts); }, // "side", "conv", "header", "log", "card", "rail"
  redraw: () => { document.querySelectorAll("#log .log-inner > *").forEach(e => { e._sig = ""; }); renderLog(); }, // every log block replaced
  resetTweens: () => { tweens.clear(); }, // the sidebar forgets its sub-line tweens
});
