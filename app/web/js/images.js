/* Images (R5.12b, R5.13): a row of thumbnails under a prompt, a tool step, a collapsed run or the message
   box, and the viewer. A thumbnail is at most 3 transcript lines high (--thumb-h in app.css), as wide as
   its aspect ratio gives, 320px at most (cropped to the centre); smaller images keep their size. Transcript
   images load from GET /api/image (the backend reads the record line again); pasted ones are object URLs.
   The size comes from the item (the backend reads the image header); when it doesn't, the image takes its
   own shape while it loads (app.css), and its size is set as soon as the browser has read the header. */
import { TOKEN } from "./connection.js";
import { esc } from "./format.js";

const imageSizes = new Map(); // src -> [w, h], once known, so a redrawn block keeps the shape
const failedImages = new Set(); // src that gave a 404 (file gone or rewritten): a quiet tile instead
export const imageUrl = (sid, agent, ref) => `/api/image?token=${encodeURIComponent(TOKEN)}&sid=${encodeURIComponent(sid)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}&ref=${encodeURIComponent(ref)}`;
/* from: where the image came from, named in the viewer (a Read's file path, a tool, "your message") */
export function thumbHTML(src, w, h, label, from = "") {
  const [iw, ih] = imageSizes.get(src) || [w, h];
  const sized = iw > 0 && ih > 0, size = sized ? ` style="--iw:${+iw};--ih:${+ih}"` : "";
  if (failedImages.has(src)) return `<span class="thumb gone${sized ? " sized" : ""}"${size} title="The image is no longer in the transcript file">Image gone</span>`;
  return `<button class="thumb${sized ? " sized" : ""}" type="button"${size} data-full-src="${esc(src)}"${from ? ` data-from="${esc(from)}"` : ""} aria-label="${esc(label)}, open full size"><img src="${esc(src)}" alt="" draggable="false"></button>`;
}
/* one row of thumbnails (a prompt's, a step's or a whole run's): the viewer steps through that row.
   imgs: [{ ref, w, h, from? }]; from names the source of the images that don't carry their own */
export function thumbsHTML(imgs, sid, agent, from = "") {
  if (!imgs || !imgs.length) return "";
  return `<div class="thumbs">${imgs.map((m, i) => thumbHTML(imageUrl(sid, agent, m.ref), m.w, m.h, `Image ${i + 1} of ${imgs.length}`, m.from || from)).join("")}</div>`;
}
/* a thumbnail of unknown size takes its real shape once the header is read: each frame while some wait */
function sizeThumb(b, im) {
  if (!im.naturalWidth || !im.naturalHeight) return false;
  imageSizes.set(b.dataset.fullSrc, [im.naturalWidth, im.naturalHeight]);
  b.style.setProperty("--iw", im.naturalWidth); b.style.setProperty("--ih", im.naturalHeight); b.classList.add("sized");
  return true;
}
let sizing = 0;
function sizeWaiting() {
  sizing = 0;
  // an image that failed while off the document never reached the error listener below: it ends complete with no pixels
  const waiting = [...document.querySelectorAll("button.thumb:not(.sized) > img")].filter(im => {
    if (im.complete && !im.naturalWidth) { failThumb(im.parentElement); return false; }
    return !sizeThumb(im.parentElement, im);
  });
  if (waiting.length) sizing = requestAnimationFrame(sizeWaiting);
}
new MutationObserver(() => { if (!sizing && document.querySelector("button.thumb:not(.sized)")) sizing = requestAnimationFrame(sizeWaiting); })
  .observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("load", e => {
  const im = e.target, b = im.parentElement;
  if (im.tagName === "IMG" && b && b.classList.contains("thumb")) sizeThumb(b, im);
}, true);
/* a thumbnail that failed turns into the tile */
document.addEventListener("error", e => {
  const im = e.target, b = im.parentElement;
  if (im.tagName !== "IMG" || !b || !b.classList.contains("thumb")) return;
  failThumb(b);
}, true);
function failThumb(b) {
  failedImages.add(b.dataset.fullSrc);
  const tpl = document.createElement("template"); tpl.innerHTML = thumbHTML(b.dataset.fullSrc, 0, 0, "");
  const tile = tpl.content.firstElementChild; tile.style.cssText = b.style.cssText; if (b.classList.contains("sized")) tile.classList.add("sized"); b.replaceWith(tile);
}

/* ---------- the viewer ----------
   Opens fit to the window, never scaled up. A click on the image, z or 0 switch between fit and 100%
   (one image pixel to one CSS pixel, as the thumbnails and the browser count it); the clicked point
   stays under the pointer. At 100% a larger image pans by dragging, scrolling and the arrow keys.
   ← → (at fit) and j k (always) step through the row the thumbnail is in, stopping at its ends.
   Esc or a click outside the image closes it. */
export let viewer = null; // { srcs, froms, i, el, full, back }
function openViewer(thumb) {
  const row = [...thumb.closest(".thumbs").querySelectorAll(".thumb[data-full-src]")];
  showViewer(row.map(b => b.dataset.fullSrc), row.indexOf(thumb), row.map(b => b.dataset.from || ""));
}
/* the viewer on these images at i (also how a reload puts it back, ui-state.js) */
export function showViewer(srcs, i, froms = []) {
  closeViewer();
  const el = document.createElement("div");
  el.className = "viewer"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.tabIndex = -1;
  el.innerHTML = `<div class="v-stage"></div><div class="v-foot"></div>`;
  document.body.append(el);
  viewer = { srcs, froms, i: Math.min(srcs.length - 1, Math.max(0, i)), el, full: false, back: document.activeElement };
  drawViewer(); el.focus({ preventScroll: true });
}
const vStage = () => viewer.el.querySelector(".v-stage");
const vImg = () => viewer.el.querySelector(".v-stage img");
/* 100% only means something when the image is larger than the window at fit */
const vZoomable = () => { const im = vImg(); return !!im && im.naturalWidth > 0 && (im.naturalWidth > im.clientWidth + 0.5 || im.naturalHeight > im.clientHeight + 0.5); };
function drawViewer() {
  const { srcs, froms, i, el } = viewer, n = srcs.length;
  const name = n > 1 ? `Image ${i + 1} of ${n}` : "Image";
  el.setAttribute("aria-label", name);
  viewer.full = false; el.classList.remove("full", "panning");
  el.querySelector(".v-stage").innerHTML = `<img src="${esc(srcs[i])}" alt="${name}" draggable="false">`;
  vImg().addEventListener("load", drawFoot);
  drawFoot();
}
function drawFoot() {
  if (!viewer) return;
  const { srcs, froms, i, el, full } = viewer, n = srcs.length, from = froms[i] || "";
  const zoom = full || vZoomable();
  el.classList.toggle("zoomable", zoom);
  el.querySelector(".v-foot").innerHTML = `<span class="v-where">${n > 1 ? `<span class="v-n">${i + 1} of ${n}</span>` : ""}${from ? `<span class="v-from${from.startsWith("/") || from.startsWith("~") ? " mono" : ""}" title="${esc(from)}">${esc(from)}</span>` : ""}</span>
    <span class="hint">${n > 1 ? `<span>${full ? "" : `<kbd>←</kbd> <kbd>→</kbd> or `}<kbd>j</kbd> <kbd>k</kbd> other images</span>` : ""}${full ? `<span>drag or <kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> pan</span>` : ""}${zoom ? `<span><kbd>z</kbd> ${full ? "fit to window" : "actual size"}</span>` : ""}<span><kbd>Esc</kbd> close</span></span>`;
}
/* fit <-> 100%; at (x, y) in the window the image point there stays there (the image's centre otherwise) */
function zoomViewer(x, y) {
  const im = vImg(), st = vStage(); if (!im || !im.naturalWidth || (!viewer.full && !vZoomable())) return;
  const r = im.getBoundingClientRect(), b = im.clientLeft;
  if (x === undefined) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
  const fx = Math.min(1, Math.max(0, (x - r.left - b) / im.clientWidth)), fy = Math.min(1, Math.max(0, (y - r.top - b) / im.clientHeight));
  viewer.full = !viewer.full; viewer.el.classList.toggle("full", viewer.full);
  st.scrollLeft = 0; st.scrollTop = 0;
  if (viewer.full) {
    const n = im.getBoundingClientRect();
    st.scrollLeft = n.left + b + fx * im.clientWidth - x; st.scrollTop = n.top + b + fy * im.clientHeight - y;
  }
  drawFoot();
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
/* at 100%, a drag pans: the stage takes the pointer until it's let go; a drag isn't a click */
let pan = null, dragged = false;
document.addEventListener("pointerdown", e => {
  if (!viewer) return;
  dragged = false;
  if (!viewer.full || e.button !== 0 || !e.target.closest(".v-stage")) return;
  const st = vStage(); e.preventDefault(); st.setPointerCapture(e.pointerId);
  pan = { id: e.pointerId, x: e.clientX, y: e.clientY, l: st.scrollLeft, t: st.scrollTop };
});
document.addEventListener("pointermove", e => {
  if (viewer) viewer.at = [e.clientX, e.clientY];
  if (!pan || e.pointerId !== pan.id || !viewer) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  dragged = true; viewer.el.classList.add("panning");
  const st = vStage(); st.scrollLeft = pan.l - dx; st.scrollTop = pan.t - dy;
});
const endPan = e => { if (pan && e.pointerId === pan.id) { pan = null; if (viewer) viewer.el.classList.remove("panning"); } };
document.addEventListener("pointerup", endPan); document.addEventListener("pointercancel", endPan);
document.addEventListener("click", e => {
  if (viewer) {
    e.stopPropagation();
    if (dragged) { dragged = false; return; }
    if (e.target.closest(".viewer .v-stage img") || (viewer.full && e.target.closest(".viewer .v-stage"))) zoomViewer(e.clientX, e.clientY);
    else if (!e.target.closest(".viewer .v-foot")) closeViewer();
    return;
  }
  const t = e.target.closest && e.target.closest(".thumb[data-full-src]");
  if (!t) return;
  e.preventDefault(); e.stopPropagation(); openViewer(t);
}, true);
/* while it shows, the viewer has every key: nothing reaches the modes, the cards or the session keys. On
   window in the capture phase, so it comes before the classic scripts' document listeners (the Open list's),
   which were added before this module ran; the preview's comes first (ui-state.js imports it first). */
const PAN = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
window.addEventListener("keydown", e => {
  if (!viewer) return;
  if (e.metaKey && !(e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight"))) return; // ⌘C, ⌘Q stay the app's
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.key === "Escape") closeViewer();
  else if (viewer.full && PAN[e.key]) { // a tenth of the window, a whole one with shift
    const st = vStage(), [dx, dy] = PAN[e.key], f = e.shiftKey ? 0.9 : 0.1;
    st.scrollLeft += dx * f * st.clientWidth; st.scrollTop += dy * f * st.clientHeight;
  }
  else if (e.key === "ArrowLeft" || e.key === "k") stepViewer(-1);
  else if (e.key === "ArrowRight" || e.key === "j") stepViewer(1);
  else if (e.key === "z" || e.key === "0") {
    const at = viewer.at, r = vImg() && vImg().getBoundingClientRect(); // under the pointer if it's on the image
    at && r && at[0] >= r.left && at[0] <= r.right && at[1] >= r.top && at[1] <= r.bottom ? zoomViewer(at[0], at[1]) : zoomViewer();
  }
}, true);
