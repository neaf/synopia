/* Theme switch (requirements section 11): light or dark, on <html data-theme>. With nothing chosen the page
   follows the system's appearance (prefers-color-scheme, live). The footer's switch picks the other theme and
   keeps it; Alt-click goes back to following the system. The choice is UI state (ui-state.js `theme`:
   "light", "dark" or null), stored by the backend and applied from the first hello; localStorage holds a copy
   only for theme.js, which paints the first frame before that hello. */
const KEY = "synopia.theme";
const mq = matchMedia("(prefers-color-scheme: dark)");
let pref = null; // "light" | "dark" | null: follow the system
try { const h = localStorage.getItem(KEY); if (h === "light" || h === "dark") pref = h; } catch { /* no storage */ }
let onChange = () => {};

export const themePref = () => pref;
export const themeNow = () => pref || (mq.matches ? "dark" : "light");
/* called when the theme shown changes (main.js: the preview asks bat for the other colours) */
export function onThemeChange(fn) { onChange = fn; }

function apply() {
  const t = themeNow(), root = document.documentElement, was = root.dataset.theme;
  root.dataset.theme = t;
  const b = document.getElementById("theme"), label = t === "dark" ? "Light mode" : "Dark mode";
  b.setAttribute("aria-label", label);
  b.title = pref ? `${label} (Alt-click follows the system)` : label;
  if (was && was !== t) onChange();
}
/* a choice: "light", "dark" or null (the stored one from hello, or the switch; ui-state.js sends it with
   the next patch, as it does after every click) */
export function themeSet(p) {
  pref = p === "light" || p === "dark" ? p : null;
  try { if (pref) localStorage.setItem(KEY, pref); else localStorage.removeItem(KEY); } catch { /* no storage */ }
  apply();
}
mq.addEventListener("change", apply);
document.getElementById("theme").addEventListener("click", e => themeSet(e.altKey ? null : themeNow() === "dark" ? "light" : "dark"));
apply();
