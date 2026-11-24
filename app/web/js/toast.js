/* Toast: one quiet line at the bottom for 3.6 s, the page's one way to say that something didn't happen
   or happened elsewhere. A new one replaces the one shown. */
let timer = 0;
export function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text; el.classList.add("show");
  clearTimeout(timer); timer = setTimeout(() => el.classList.remove("show"), 3600);
}
