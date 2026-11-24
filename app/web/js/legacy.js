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
  get wantNew() { return wantNew; }, set wantNew(v) { wantNew = v; },
  get wantOpen() { return wantOpen; }, set wantOpen(v) { wantOpen = v; },
  get themePref() { return themePref; },
  get qstate() { return qstate; },
  get attachments() { return attachments; },
  get openList() { return openList; },
  get interruptAsk() { return interruptAsk; },
  get bgAsk() { return bgAsk; },
  get closeAsk() { return closeAsk; },
  /* functions */
  renderAll: () => renderAll(), renderCard: () => renderCard(), resetCard: () => { lastCard = null; },
  renderAttachments: () => renderAttachments(), mountComposer: s => mountComposer(s), paintBash: s => paintBash(s),
  modelName: () => modelName(), openModelPicker: () => openModelPicker(), unattach: i => unattach(i),
  withPending: (items, requests, ext) => withPending(items, requests, ext), extAsk: s => extAsk(s),
  toast: text => toast(text), setMode: m => setMode(m),
  applyRecent: m => applyRecent(m), restoreTexts: (sid, texts) => restoreTexts(sid, texts),
  syncInterrupt: () => syncInterrupt(), syncBackground: () => syncBackground(), syncTakeover: () => syncTakeover(),
  themeSet: (pref, quiet) => themeSet(pref, quiet), themeNow: () => themeNow(),
  showOpenList: () => showOpenList(), openListShown: () => openListShown(), askRecent: () => askRecent(),
  boxValue: ta => boxValue(ta),
  pendingAsk: s => pendingAsk(s), askKey: (s, a) => askKey(s, a),
};
