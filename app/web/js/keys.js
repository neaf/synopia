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
function stepSession(step) {
  const i = KEYS.indexOf(current);
  current = KEYS[(i + step + KEYS.length) % KEYS.length]; view = null; renderAll();
}
document.addEventListener("focusin", e => { if ((e.target.id === "msg" || e.target.id === "qa-own") && mode !== "insert") { mode = "insert"; paintMode(); } });
document.addEventListener("focusout", e => { if (e.target.id === "msg" && mode !== "normal") { mode = "normal"; paintMode(); } });
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inMsg = e.target.id === "msg";
  if (inMsg) { if (e.key === "Escape") { e.preventDefault(); setMode("normal"); } return; }  // the slash menu takes the first Esc itself
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;  // group rename etc.
  if (e.target.closest && e.target.closest("button") && e.key === " ") e.preventDefault();
  if (qaKeys(e)) return;
  const log = document.getElementById("log");
  switch (e.key) {
    case "J": e.preventDefault(); stepSession(1); break;
    case "K": e.preventDefault(); stepSession(-1); break;
    case "j": e.preventDefault(); log?.scrollBy({ top: 60 }); break;
    case "k": e.preventDefault(); log?.scrollBy({ top: -60 }); break;
    case "g": e.preventDefault(); if (log) log.scrollTop = 0; break;
    case "G": e.preventDefault(); if (log) log.scrollTop = log.scrollHeight; break;
    case "i": case "a": e.preventDefault(); setMode("insert"); break;
    case "/": { e.preventDefault(); setMode("insert"); const ta = document.getElementById("msg"); ta.value = "/"; ta.dispatchEvent(new Event("input")); break; }
  }
});

function toast(t) { const el = document.getElementById("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 3600); }
/* New session: the backend adds an empty one in its folder; bridge.js opens it when it arrives */
let wantNew = false;
document.getElementById("new").onclick = () => { wantNew = true; send({ t: "newSession" }); };
/* Cmd+Shift+[ and ] move to the previous / next session, like tabs in iTerm (works once Synopia runs in its own app window) */
document.addEventListener("keydown", e => {
  if (!(e.metaKey && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight"))) return;
  e.preventDefault();
  const i = KEYS.indexOf(current); const step = e.code === "BracketRight" ? 1 : -1;
  current = KEYS[(i + step + KEYS.length) % KEYS.length]; view = null; renderAll();
});
function renderAll() { renderSide(); renderConv(); paintMode(); if (mode === "insert") (document.getElementById("qa-own") || document.getElementById("msg"))?.focus(); }
