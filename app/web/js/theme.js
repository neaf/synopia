/* Theme, first paint (requirements section 11): the page's one classic script, loaded in <head>, so the first
   frame is already light or dark. It reads the copy of the choice kept in localStorage, else the system's
   appearance. The choice itself (UI state `theme`, stored by the backend) and the switch are theme-switch.js. */
{
  let pref = null;
  try { pref = localStorage.getItem("synopia.theme"); } catch { /* no storage */ }
  document.documentElement.dataset.theme = pref === "light" || pref === "dark" ? pref
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
