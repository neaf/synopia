/* Mark times (2026-11-26, the user's decision): the marks in the transcript's bullet column (a dot, a spinner, the red
   square, a check, ❯ or ! on a band) are not text: not selectable, not clickable, the default cursor (app.css). Hovering
   one shows when its row appeared, its `data-at` (format.js markAt, from the row's transcript `timestamp`), in one small
   tip: "16:34:12", or "25 Nov, 16:34:12" on another day. */
import { markTime } from "./format.js";

const MARK = "#log .ln > .g, #log .prompt > .g";
const DELAY = 300; // ms on a mark before its tip shows
let tip = null, on = null, timer = 0;

function show(g) {
  const text = markTime(g.dataset.at); if (!text) return;
  if (!tip) { tip = document.createElement("div"); tip.className = "mark-time"; tip.setAttribute("role", "tooltip"); document.body.append(tip); }
  tip.textContent = text; tip.hidden = false;
  const r = g.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const above = r.top - t.height - 4;
  tip.style.left = `${Math.max(4, Math.min(r.left - 2, innerWidth - t.width - 4))}px`;
  tip.style.top = `${above >= 4 ? above : r.bottom + 4}px`;
}
function hide() { clearTimeout(timer); on = null; if (tip) tip.hidden = true; }

export function installMarkTimes() {
  document.addEventListener("mouseover", e => {
    const g = e.target.closest?.(MARK);
    if (g === on) return;
    hide();
    if (!g || !g.dataset.at) return;
    on = g; timer = setTimeout(() => show(g), DELAY);
  });
  document.addEventListener("mouseleave", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", hide, true);
  /* a mark is not a control: a click on it does nothing, also inside a row that opens something (a run row, the live line) */
  document.addEventListener("click", e => { if (e.target.closest?.(MARK)) { e.stopPropagation(); e.preventDefault(); } }, true);
}
