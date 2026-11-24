/* Theme (requirements section 11): light or dark, on <html data-theme>. With nothing chosen the page follows
   the system's appearance (prefers-color-scheme, live). The switch in the sidebar footer picks the other
   theme and keeps it; Alt-click goes back to following the system. The choice is UI state (ui.js `theme`:
   "light", "dark" or null), stored by the backend and applied from the first hello; localStorage holds a
   copy only so the first paint before that hello is already in the right theme. Loaded in <head>. */
let themePref = null; // "light" | "dark" | null: follow the system
const themeMq = matchMedia("(prefers-color-scheme: dark)");
const themeNow = () => themePref || (themeMq.matches ? "dark" : "light");
try { const h = localStorage.getItem("synopia.theme"); if (h === "light" || h === "dark") themePref = h; } catch { /* no storage */ }

function themeApply() {
  const t = themeNow(), root = document.documentElement, was = root.dataset.theme;
  root.dataset.theme = t;
  const b = document.getElementById("theme");
  if (b) {
    const label = t === "dark" ? "Light mode" : "Dark mode";
    b.setAttribute("aria-label", label);
    b.title = themePref ? `${label} (Alt-click follows the system)` : label;
  }
  if (was && was !== t && typeof previewRetheme === "function") previewRetheme(); // bat's colours come from the backend
}
/* a choice: "light", "dark" or null; `quiet` when it comes from the stored state (nothing to send back) */
function themeSet(pref, quiet) {
  themePref = pref === "light" || pref === "dark" ? pref : null;
  try { if (themePref) localStorage.setItem("synopia.theme", themePref); else localStorage.removeItem("synopia.theme"); } catch { /* no storage */ }
  themeApply();
  if (!quiet && typeof uiChanged === "function") uiChanged();
}
themeMq.addEventListener("change", themeApply);
themeApply();
document.addEventListener("DOMContentLoaded", () => {
  themeApply();
  document.getElementById("theme")?.addEventListener("click", e => themeSet(e.altKey ? null : themeNow() === "dark" ? "light" : "dark"));
});
