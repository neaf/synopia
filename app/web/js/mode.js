/* Mode (requirements R9.1, R9.2): vim-like normal (keys navigate) and insert (keys type). The message box is
   the only indicator, through <body data-mode> (app.css): its text at half strength in normal; in insert the
   box is a `❯` band being written, the band's fill and blue left edge. keys.js
   follows the focus with it; the card, the Open list and the preview set it as they take or give up keys. */
export let mode = "normal";
export function paintMode() { document.body.dataset.mode = mode; }
/* `focus`: the message box takes the focus for insert and gives it up for normal; false only paints */
export function setMode(m, focus = true) {
  mode = m; paintMode();
  const ta = focus && document.getElementById("msg");
  if (!ta) return;
  if (m === "insert" && document.activeElement !== ta) ta.focus();
  if (m === "normal" && document.activeElement === ta) ta.blur();
}
