/* Send tween (R5.5): on Enter the box empties at once, and once your message shows as its band (the
   transcript's `q:<uuid>` block: in the log when Claude was idle, in the queue when it runs) the band moves up
   from the box into that place, a short layout tween (180 ms, eased out). The band itself takes its place at
   once and stays hidden while a copy of it moves, fixed on screen, so nothing else moves and the band never
   jumps. None with reduced motion. Imports nothing: composer.js starts it, transcript.js lands it. */
const MS = 180;
const WAIT = 3000; // a band that doesn't show by then (refused, or another view) doesn't tween
let flight = null; // { id, top, at }
let moving = null; // the tween that runs: a later render re-hides its band at once (a redraw replaces it)

/* the message's uuid and the box row it leaves from */
export function takeOff(id, box) {
  if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) { flight = null; return; }
  flight = { id, top: box.getBoundingClientRect().top + 1, at: performance.now() }; // under the box's 1px line
}

/* after each render: the band of the message in flight, when it shows, moves up from the box. `landed(id)`:
   the block of its prompt once its record is in, which replaces the sent band (transcript.js) */
export function land(root, landed) {
  moving?.();
  if (!flight) return;
  if (performance.now() - flight.at > WAIT) { flight = null; return; }
  const find = id => root.querySelector(`[data-key="q:${CSS.escape(id)}"]`) || landed(id);
  const el = find(flight.id); if (!el) return;
  const f = flight; flight = null;
  let band = el.matches(".prompt") ? el : el.querySelector(".prompt") || el, to = band.getBoundingClientRect();
  const clip = band.closest(".log, .qpin")?.getBoundingClientRect();
  if (!to.height || !clip || to.bottom > clip.bottom + 1 || to.top < clip.top - 1 || f.top - to.top < 1) return; // out of view, or already there
  const ghost = band.cloneNode(true), t0 = performance.now(); let dy = null; // from the box to the band, set on the first frame
  ghost.classList.add("send-ghost"); ghost.removeAttribute("data-key"); ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { left: `${to.left}px`, top: `${f.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  root.appendChild(ghost);
  const current = () => { const n = band.isConnected ? band : find(f.id), b = n && (n.matches(".prompt") ? n : n.querySelector(".prompt")); if (b) { band = b; b.classList.add("landing"); } return b; };
  moving = current;
  /* each frame follows the band where it is now (a render may redraw it or move what is above it) */
  const step = () => {
    const b = current(), p = Math.min(1, (performance.now() - t0) / MS);
    if (!b || p >= 1) { ghost.remove(); b?.classList.remove("landing"); if (moving === current) moving = null; return; }
    const r = b.getBoundingClientRect(), e = 1 - Math.pow(1 - p, 3); // ease out: fast from the box, slow into place
    if (dy === null) dy = f.top - r.top;
    ghost.style.top = `${r.top + dy * (1 - e)}px`; ghost.style.left = `${r.left}px`;
    requestAnimationFrame(step);
  };
  band.classList.add("landing");
  requestAnimationFrame(step);
}
