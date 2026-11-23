/* Images (R5.13): a row of thumbnails under a prompt, a tool step or the message box, and the viewer.
   A thumbnail is at most 3 transcript lines high (--thumb-h in app.css), as wide as its aspect ratio
   gives, 320px at most (cropped to the centre); smaller images keep their size. Transcript images load
   from GET /api/image (the backend reads the record line again); pasted ones are object URLs. */
const imageSizes = new Map(); // src -> [w, h], once loaded, so a redrawn block keeps the shape
const failedImages = new Set(); // src that gave a 404 (file gone or rewritten): a quiet tile instead
const imageUrl = (sid, agent, ref) => `/api/image?token=${encodeURIComponent(TOKEN)}&sid=${encodeURIComponent(sid)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}&ref=${encodeURIComponent(ref)}`;
function thumbHTML(src, w, h, label) {
  const [iw, ih] = imageSizes.get(src) || [w, h];
  const size = iw > 0 && ih > 0 ? ` style="--iw:${+iw};--ih:${+ih}"` : "";
  if (failedImages.has(src)) return `<span class="thumb gone"${size} title="The image is no longer in the transcript file">Image gone</span>`;
  return `<button class="thumb" type="button"${size} data-full-src="${esc(src)}" aria-label="${esc(label)}, open full size"><img src="${esc(src)}" alt=""></button>`;
}
/* the thumbnails of one message (a prompt or a tool's result): ← → in the viewer move within them */
function thumbsHTML(imgs, sid, agent) {
  if (!imgs || !imgs.length) return "";
  return `<div class="thumbs">${imgs.map((m, i) => thumbHTML(imageUrl(sid, agent, m.ref), m.w, m.h, `Image ${i + 1} of ${imgs.length}`)).join("")}</div>`;
}
/* a loaded thumbnail takes its real shape; one that failed turns into the tile */
document.addEventListener("load", e => {
  const im = e.target, b = im.parentElement;
  if (im.tagName !== "IMG" || !b || !b.classList.contains("thumb")) return;
  imageSizes.set(b.dataset.fullSrc, [im.naturalWidth, im.naturalHeight]);
  b.style.setProperty("--iw", im.naturalWidth); b.style.setProperty("--ih", im.naturalHeight);
}, true);
document.addEventListener("error", e => {
  const im = e.target, b = im.parentElement;
  if (im.tagName !== "IMG" || !b || !b.classList.contains("thumb")) return;
  failedImages.add(b.dataset.fullSrc);
  const tpl = document.createElement("template"); tpl.innerHTML = thumbHTML(b.dataset.fullSrc, 0, 0, "");
  const tile = tpl.content.firstElementChild; tile.style.cssText = b.style.cssText; b.replaceWith(tile);
}, true);

/* ---------- the viewer: full size, fit to the window; Esc or a click outside closes, ← → move ---------- */
let viewer = null; // { srcs, i, el }
const viewerShown = () => !!viewer;
function openViewer(thumb) {
  const srcs = [...thumb.closest(".thumbs").querySelectorAll(".thumb[data-full-src]")].map(b => b.dataset.fullSrc);
  closeViewer();
  const el = document.createElement("div");
  el.className = "viewer"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.tabIndex = -1;
  document.body.append(el);
  viewer = { srcs, i: Math.max(0, srcs.indexOf(thumb.dataset.fullSrc)), el, back: document.activeElement };
  drawViewer(); el.focus({ preventScroll: true });
}
function drawViewer() {
  const { srcs, i, el } = viewer, n = srcs.length;
  el.setAttribute("aria-label", n > 1 ? `Image ${i + 1} of ${n}` : "Image");
  el.innerHTML = `<figure><img src="${esc(srcs[i])}" alt="${n > 1 ? `Image ${i + 1} of ${n}` : "Image"}"><figcaption>${n > 1 ? `${i + 1} of ${n}. <kbd>←</kbd> <kbd>→</kbd> for the others, ` : ""}<kbd>Esc</kbd> to close</figcaption></figure>`;
}
function closeViewer() {
  if (!viewer) return;
  const back = viewer.back; viewer.el.remove(); viewer = null;
  if (back && back.isConnected && back.id === "msg") back.focus({ preventScroll: true }); // insert mode stays as it was
}
function stepViewer(d) {
  const i = Math.min(viewer.srcs.length - 1, Math.max(0, viewer.i + d));
  if (i !== viewer.i) { viewer.i = i; drawViewer(); }
}
/* a thumbnail opens the viewer; its press (or a ✕'s) doesn't take focus, so the message box keeps it */
document.addEventListener("mousedown", e => { if (e.target.closest && e.target.closest(".thumb[data-full-src], .unattach")) e.preventDefault(); });
document.addEventListener("click", e => {
  if (viewer) { if (!e.target.closest(".viewer img")) closeViewer(); e.stopPropagation(); return; }
  const t = e.target.closest && e.target.closest(".thumb[data-full-src]");
  if (!t) return;
  e.preventDefault(); e.stopPropagation(); openViewer(t);
}, true);
/* while it shows, the viewer has every key: nothing reaches the modes, the cards or the session keys */
document.addEventListener("keydown", e => {
  if (!viewer) return;
  if (e.metaKey && !(e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight"))) return; // ⌘C, ⌘Q stay the app's
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") stepViewer(-1);
  else if (e.key === "ArrowRight") stepViewer(1);
}, true);
