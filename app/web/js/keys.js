/* Keys: vim-like modes, session keys, the toast and renderAll (split from prototype/app.html). */
/* ---------- vim-like modes: normal (keys navigate) and insert (keys type) ---------- */
let mode = "normal";
function paintMode() {
  document.body.dataset.mode = mode;
}
function setMode(m) {
  mode = m; paintMode();
  const ta = document.getElementById("msg");
  if (!ta) return;
  if (m === "insert" && document.activeElement !== ta) ta.focus();
  if (m === "normal" && document.activeElement === ta) ta.blur();
}
/* J/K and Cmd+Shift+[ ]: the next or previous shown session, in sidebar order (KEYS, from renderSide) */
function stepSession(step) {
  if (!KEYS.length) return;
  const i = KEYS.indexOf(current);
  select(i < 0 ? KEYS[step > 0 ? 0 : KEYS.length - 1] : KEYS[(i + step + KEYS.length) % KEYS.length]); openBg = null; renderAll();
}
document.addEventListener("focusin", e => { if ((e.target.id === "msg" || e.target.id === "qa-own") && mode !== "insert") { mode = "insert"; paintMode(); } });
document.addEventListener("focusout", e => { if (e.target.id === "msg" && mode !== "normal") { mode = "normal"; paintMode(); } });
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inMsg = e.target.id === "msg";
  if (inMsg) { if (e.key === "Escape") { e.preventDefault(); setMode("normal"); } return; }  // the slash menu takes the first Esc itself
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;  // group rename, the Open list's filter, a card's field
  if (drag?.started) return; // dnd.js takes Esc; nothing else moves under a drag
  if (e.target.closest && e.target.closest("button") && e.key === " ") e.preventDefault();
  /* Esc, Esc interrupts a running turn; b, b sends its foreground steps to the background; x, x closes the
     session; any other key dismisses the prompt, and another prompt's first key replaces it (composer.js) */
  if (interruptAsk || bgAsk || closeAsk) {
    if (/^(Shift|Meta|Control|Alt|CapsLock)$/.test(e.key)) return;
    e.preventDefault();
    const again = interruptAsk ? "Escape" : bgAsk ? "b" : "x";
    if (e.key === again) interruptAsk ? confirmInterrupt() : bgAsk ? confirmBackground() : confirmClose();
    else if (e.key === "Escape" && canInterrupt(cur())) askInterrupt();
    else if (e.key === "b" && askBackground()) ;
    else if (e.key === "x") askClose();
    else if (interruptAsk) dismissInterrupt(); else if (bgAsk) dismissBackground(); else dismissClose();
    return;
  }
  if (e.key === "Escape" && canInterrupt(cur())) { e.preventDefault(); askInterrupt(); return; }
  if (e.key === "b" && !openListShown() && askBackground()) { e.preventDefault(); return; }
  if (e.key === "x" && !openListShown() && askClose()) { e.preventDefault(); return; }
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
});

function toast(t) { const el = document.getElementById("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 3600); }
/* New session: the backend adds an empty one in its folder; main.js shows it when it arrives */
let wantNew = false;
document.getElementById("new").onclick = () => { wantNew = true; send({ t: "newSession" }); };
/* Cmd+Shift+[ and ] move to the previous / next session, like tabs in iTerm (works once Synopia runs in its own app window) */
document.addEventListener("keydown", e => {
  if (!(e.metaKey && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight"))) return;
  e.preventDefault();
  if (openListShown() || drag?.started) return; // the Open list and a drag keep the session behind them
  stepSession(e.code === "BracketRight" ? 1 : -1);
});
/* Ctrl+J / Ctrl+K: the next or previous conversation inside the session: Main conversation, then the subagents
   and forks as the background panel shows them, top to bottom; past the last one it wraps to Main conversation.
   Normal mode only, so Ctrl+K never fights a text field. */
function stepView(step) {
  const s = cur(); if (!s) return;
  // the order you see: the panel's subagent and fork cards top to bottom (running tree, then Past), once each
  const ids = [...new Set([...document.querySelectorAll(".rail [data-agent]")].map(el => el.dataset.agent))].filter(id => agentById(s, id));
  const order = [null, ...ids];
  if (order.length < 2) return;
  const i = Math.max(0, order.indexOf(view || null));
  selectView(order[(i + step + order.length) % order.length]); renderConv();
}
document.addEventListener("keydown", e => {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || (e.key !== "j" && e.key !== "k")) return;
  if (mode === "insert" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || openListShown() || drag?.started) return;
  e.preventDefault(); stepView(e.key === "j" ? 1 : -1);
});
function renderAll() { renderSide(); renderConv(); paintMode(); if (mode === "insert") (document.getElementById("qa-own") || document.getElementById("msg"))?.focus(); }
