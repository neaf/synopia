/* Legacy: the seam between the ES modules and the classic page scripts, while both exist (removed in
   Phase 19, when the last classic file is a module). Two directions, nothing else:
   - publish() puts module exports on `window` as read-only accessors, so classic code keeps calling
     `send(...)` or reading `current`; assigning one throws, so a missed writer shows at once.
   - `classic` reads and writes the classic scripts' globals for the modules. Their `let` and `const`
     bindings are in the global scope but not on `window`, so each one is named here once.
   Classic scripts run before any module (modules are deferred), so all of these exist when a module runs. */
export function publish(names) {
  for (const [name, get] of Object.entries(names)) {
    Object.defineProperty(window, name, {
      get, configurable: true,
      set() { throw new Error(`${name} belongs to a module (js/legacy.js): call its function instead`); },
    });
  }
}

export const classic = {
  /* values the modules read or set */
  get mode() { return mode; }, set mode(v) { mode = v; },
  get mounted() { return mounted; }, set mounted(v) { mounted = v; },
  get layout() { return layout; }, set layout(v) { layout = v; },
  get wantNew() { return wantNew; }, set wantNew(v) { wantNew = v; },
  get wantOpen() { return wantOpen; }, set wantOpen(v) { wantOpen = v; },
  get openBg() { return openBg; }, set openBg(v) { openBg = v; },
  get stepAsked() { return stepAsked; }, set stepAsked(v) { stepAsked = v; },
  set NOWISH(v) { NOWISH = v; },
  get themePref() { return themePref; },
  get openSteps() { return openSteps; },
  get qstate() { return qstate; },
  get attachments() { return attachments; },
  get pv() { return pv; },
  get openList() { return openList; },
  get viewer() { return viewer; },
  get interruptAsk() { return interruptAsk; },
  get bgAsk() { return bgAsk; },
  get closeAsk() { return closeAsk; },
  get marks() { return P; },
  get tweens() { return tweens; },
  /* functions */
  renderAll: () => renderAll(), renderSide: () => renderSide(), renderConv: () => renderConv(),
  renderHeader: () => renderHeader(), renderLog: () => renderLog(), renderCard: () => renderCard(),
  renderRail: () => renderRail(), renderLogKeepingPlace: () => renderLogKeepingPlace(),
  renderAttachments: () => renderAttachments(),
  agentById: (s, id) => agentById(s, id),
  toast: text => toast(text),
  applyToolOutput: m => applyToolOutput(m), applyRecent: m => applyRecent(m),
  showPreview: m => showPreview(m), restoreTexts: (sid, texts) => restoreTexts(sid, texts),
  syncInterrupt: () => syncInterrupt(), syncBackground: () => syncBackground(), syncTakeover: () => syncTakeover(),
  liveNow: () => liveNow(), tookLive: ms => tookLive(ms), dur: ms => dur(ms), left: at => left(at),
  themeSet: (pref, quiet) => themeSet(pref, quiet), themeNow: () => themeNow(),
  imageUrl: (sid, agent, ref) => imageUrl(sid, agent, ref),
  showOpenList: () => showOpenList(), openListShown: () => openListShown(), askRecent: () => askRecent(),
  showViewer: (srcs, i, froms) => showViewer(srcs, i, froms),
  previewShown: () => previewShown(), pvOpenFind: () => pvOpenFind(), pvFind: text => pvFind(text),
  loadEarlier: () => loadEarlier(), boxValue: ta => boxValue(ta),
  pendingAsk: s => pendingAsk(s), askKey: (s, a) => askKey(s, a), ind: (kind, size) => ind(kind, size),
};
