/* The terminal emulator of a shell view (requirements R7.2, 2026-11-27): xterm.js 6.0.0 (vendor/xterm, its
   documented API only) draws a run's raw output, escape sequences and all: colours, cursor moves, progress
   bars, a cleared line, with its own scrollback. One terminal at a time, for the view on screen. This module
   holds the raw stream the page has of each run (`term` frames for a run Synopia holds a pty for, `output`
   frames for Claude's background shells and monitors), draws it, and hands what you type and the size the
   view gives it to the caller (bg-view.js). Its colours are the palette's (css/app.css, css/dark.css) and
   follow the theme; the font is the transcript's mono. A terminal you can't type to (Claude's shells) takes
   no keys and shows no cursor. */
import { Terminal } from "../vendor/xterm/xterm.js";
import { FitAddon } from "../vendor/xterm/addon-fit.js";
import { findIn } from "./preview.js";

const KEEP = 1024 * 1024; // the raw characters kept per run; the backend keeps the last 512 KB of a pty's
const SCROLLBACK = 10_000;
/* id -> { data, eol }: what the page has of a run's raw stream; `eol`: its line ends are bare LF (a file,
   not a terminal) */
const streams = new Map();
let shown = null; // { id, box, term, fit, writable, ro, onKeys, onSize, size }

/* the ANSI colours, on each palette: GitHub's, as the rest of the page's */
const ANSI = {
  light: ["#24292F", "#CF222E", "#116329", "#4D2D00", "#0969DA", "#8250DF", "#1B7C83", "#6E7781",
    "#57606A", "#A40E26", "#1A7F37", "#633C01", "#218BFF", "#A475F9", "#3192AA", "#8C959F"],
  dark: ["#484F58", "#FF7B72", "#3FB950", "#D29922", "#58A6FF", "#BC8CFF", "#39C5CF", "#B1BAC4",
    "#6E7681", "#FFA198", "#56D364", "#E3B341", "#79C0FF", "#D2A8FF", "#56D4DD", "#F0F6FC"],
};
const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
function theme() {
  const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.theme === "dark", a = ANSI[dark ? "dark" : "light"], t = {};
  NAMES.forEach((n, i) => { t[n] = a[i]; t[`bright${n[0].toUpperCase()}${n.slice(1)}`] = a[i + 8]; });
  return { ...t, background: v("--sub"), foreground: v("--ink"), cursor: v("--ink"), cursorAccent: v("--sub"),
    selectionBackground: v("--sel") || (dark ? "#264F78" : "#DDF4FF"), selectionInactiveBackground: v("--line-2"),
    scrollbarSliderBackground: dark ? "rgba(230,237,243,.2)" : "rgba(31,35,40,.2)", scrollbarSliderHoverBackground: dark ? "rgba(230,237,243,.35)" : "rgba(31,35,40,.35)",
    scrollbarSliderActiveBackground: dark ? "rgba(230,237,243,.45)" : "rgba(31,35,40,.45)" };
}
new MutationObserver(() => { if (shown) shown.term.options.theme = theme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/* What came for a run: `reset` replaces what the page had (a view's first frame); `keep` with it: earlier output
   loaded before what the page had, so the line you read stays where it is on screen. */
export function feed(id, data, { reset = false, eol = false, keep = false } = {}) {
  let s = streams.get(id);
  if (!s || reset) streams.set(id, s = { data: "", eol });
  s.data += data;
  const cut = s.data.length > KEEP * 1.25;
  if (cut) s.data = s.data.slice(-KEEP);
  if (shown?.id !== id) return;
  if (!reset && !cut) { write(data); return; }
  const b = shown.term.buffer.active, fromEnd = keep ? b.length - b.viewportY : null, term = shown.term;
  term.reset();
  if (shown.ro) term.write("\x1b[?25l");
  write(s.data, fromEnd === null ? undefined : () => term.scrollToLine(Math.max(0, term.buffer.active.length - fromEnd)));
}
const write = (d, done) => { if (d) shown.term.write(shown.eol ? d.replace(/\r?\n/g, "\r\n") : d, done); else done?.(); };

/* The terminal in `box` (a shell view's `.term-box`), mounted once per box. `writable`: it takes keys
   (onKeys(data)); onSize(cols, rows) when its size changes. */
export function mountTerm(box, { id, writable = false, eol = false, onKeys = () => {}, onSize = () => {} }) {
  if (shown && shown.box === box && shown.id === id) {
    if (shown.writable && !writable) { // the run ended: no keys, no cursor, and the keys go back to the page
      shown.term.blur(); shown.term.options.disableStdin = true; shown.term.options.cursorInactiveStyle = "none"; shown.term.write("\x1b[?25l");
    }
    shown.writable = writable;
    return;
  }
  unmountTerm();
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontFamily: css.getPropertyValue("--mono").trim() || "monospace", fontSize: 12, lineHeight: 1.2,
    scrollback: SCROLLBACK, cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: writable ? "outline" : "none",
    disableStdin: !writable, theme: theme(), allowProposedApi: false, drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  shown = { id, box, term, fit, writable, ro: !writable, eol, onKeys, onSize, size: "" };
  if (writable && term.textarea) { term.textarea.id = "term-in"; term.textarea.setAttribute("aria-label", "Input to the command"); }
  /* Esc leaves insert mode (the blur; keys.js follows the focus); the program gets an Esc from normal mode instead */
  term.attachCustomKeyEventHandler(e => {
    if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return true;
    if (e.type === "keydown") { e.preventDefault(); term.blur(); }
    return false;
  });
  term.onData(d => { if (shown?.term === term && shown.writable) shown.onKeys(d); });
  const s = streams.get(id);
  if (shown.ro) term.write("\x1b[?25l");
  if (s) write(s.data);
  shown.obs = new ResizeObserver(() => fitNow());
  shown.obs.observe(box);
  fitNow();
}
function fitNow() {
  if (!shown || !shown.box.isConnected || !shown.box.clientHeight) return;
  try { shown.fit.fit(); } catch { return; }
  const size = `${shown.term.cols}x${shown.term.rows}`;
  if (size !== shown.size) { shown.size = size; shown.onSize(shown.term.cols, shown.term.rows); }
}
export function unmountTerm() {
  if (!shown) return;
  shown.obs?.disconnect();
  shown.term.dispose();
  shown = null;
}
/* the terminal on screen, while its box is on the page */
export const termOn = () => (shown && shown.box.isConnected ? shown : null);

export function focusTerm() { const t = termOn(); if (!t || !t.writable) return false; t.term.focus(); return true; }
export function blurTerm() { termOn()?.term.blur(); }
export function sendKeys(d) { const t = termOn(); if (!t || !t.writable) return false; t.onKeys(d); return true; }
/* j/k, g/G in normal mode: its scrollback */
export function scrollTerm(n) { termOn()?.term.scrollLines(n); }
export function termTop() { const t = termOn(); if (!t) return false; const at = t.term.buffer.active.viewportY === 0; t.term.scrollToTop(); return at; }
export function termEnd() { termOn()?.term.scrollToBottom(); }

/* the lines it shows, scrollback and screen, as text (the find bar, the test API) */
export function termLines() {
  const t = termOn(); if (!t) return [];
  const b = t.term.buffer.active, out = [];
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (!l) continue; const s = l.translateToString(true); if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s); }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}
/* ⌘F: the match `i` of `total` (the backend counts the whole output; the terminal has its end, so its matches are
   the last ones) selected and scrolled to; false when the terminal doesn't have it */
export function termFind(q, i, total) {
  const t = termOn(); if (!t || !q) return false;
  const b = t.term.buffer.active, hits = [];
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l) for (const [from, to] of findIn(l.translateToString(false), q)) hits.push([y, from, to - from]); }
  const h = hits[i - (total - hits.length)]; if (!h) return false;
  t.term.select(h[1], h[0], h[2]);
  if (h[0] < b.viewportY || h[0] >= b.viewportY + t.term.rows) t.term.scrollToLine(Math.max(0, h[0] - 2));
  return true;
}
export function termFindClear() { termOn()?.term.clearSelection(); }
/* for the test API: the terminal on screen, its size, whether it takes keys and has them, and its lines */
export function termState() {
  const t = termOn(); if (!t) return null;
  const b = t.term.buffer.active;
  return { id: t.id, writable: t.writable, cols: t.term.cols, rows: t.term.rows, focused: document.activeElement === t.term.textarea, lines: termLines(),
    top: b.getLine(b.viewportY)?.translateToString(true) ?? "", atTop: b.viewportY === 0, atEnd: b.viewportY === b.baseY };
}
