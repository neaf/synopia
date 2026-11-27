/* Table fit (R5.10): a markdown table in the log fits its reply in up to three steps and stops at the first
   that fits: 1. only the long text column wraps (app.css: short and number cells and the first column keep
   to one line); 2. the first column may wrap too, never inside its code (`wrap1`); 3. the table scrolls
   sideways in its own box (`scrolls`). md.js marks the columns. A table is fitted again when its box's
   width changes: the log resized, a fold opened, the fonts arrived. */
const over = tw => tw.firstElementChild.getBoundingClientRect().width > tw.clientWidth + .5;

export function fitTables(root) {
  for (const tw of root.querySelectorAll(".md .tw")) {
    const w = tw.clientWidth; if (!w || tw._fitW === w) continue; // hidden in a closed fold, or fitted at this width
    const t = tw.firstElementChild;
    t.classList.remove("wrap1"); tw.classList.remove("scrolls");
    if (over(tw)) { t.classList.add("wrap1"); if (over(tw)) tw.classList.add("scrolls"); }
    tw._fitW = w;
  }
}

/* one observer for the mounted log: its width, and a fold opened in it */
let ro = null;
export function watchTables(log) {
  ro?.disconnect();
  ro = new ResizeObserver(() => fitTables(log)); ro.observe(log);
  log.addEventListener("toggle", () => fitTables(log), true);
  document.fonts?.ready.then(() => { log.querySelectorAll(".md .tw").forEach(tw => { tw._fitW = 0; }); fitTables(log); });
}
