/* Layout tweens and the finish grace, shared by the sidebar's sub-lines and the background panel's tree. */
/* ---------- keyed line tweens (R8.1): a line that comes opens its height, then fades in; one that goes fades out,
   then closes; TW ms a step, instant with reduced motion. The panels rebuild their markup on every render, so
   each tween is keyed by its group (a session id) and line (data-line) and re-applied at its elapsed time on
   the document timeline after every render. A line whose text changes keeps its key and doesn't move. ---------- */
const TW = 150;
/* o: { sel: a line, inside a group; groups: el => Map(group key -> group element); id: the animations' id;
   cls: { tw: class while it tweens, gone: class of a going line put back };
   box: n => { open, shut }: keyframe values of the tweened box; fade: n => the elements that fade (default n);
   place: (group, n, after, parent, find) => puts a going line back, after the line before it or first under its parent } */
function lineTweens(o) {
  const tweens = new Map(); // "group|line" -> { dir: 1 comes, -1 goes, t0, node: a going line's last element, after, parent }
  const live = g => [...g.querySelectorAll(o.sel)].filter(n => !n.classList.contains(o.cls.gone));
  const prevKey = n => { let p = n.previousElementSibling; while (p && !(p.matches(o.sel) && !p.classList.contains(o.cls.gone))) p = p.previousElementSibling; return p ? p.dataset.line : null; };
  const parentKey = (g, n) => { const p = n.parentElement.closest("[data-line]"); return p && g.contains(p) ? p.dataset.line : null; };
  function snap(el) {
    const m = new Map();
    o.groups(el).forEach((g, gk) => m.set(gk, live(g).map(n => ({ k: n.dataset.line, node: n, after: prevKey(n), parent: parentKey(g, n) }))));
    return m;
  }
  function start(key, dir, now, x) {
    const t = tweens.get(key), e = t ? Math.min(now - t.t0, 2 * TW) : 2 * TW; // turning round mid-way goes back from where it was
    tweens.set(key, { dir, t0: now - (2 * TW - e), node: x?.node || t?.node, after: x ? x.after : t?.after, parent: x ? x.parent : t?.parent });
  }
  function run(el, before) {
    const now = document.timeline.currentTime ?? performance.now(); // the animations' clock, so a re-render in the same frame lands on the same point
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { tweens.clear(); return; }
    const gs = o.groups(el);
    gs.forEach((g, gk) => {
      const old = before.get(gk); if (!old) return; // a group that appears whole doesn't tween its lines
      const ks = new Set(live(g).map(n => n.dataset.line));
      for (const k of ks) if (!old.some(x => x.k === k)) start(gk + "|" + k, 1, now);
      for (const x of old) if (!ks.has(x.k)) start(gk + "|" + x.k, -1, now, x);
    });
    for (const [key, t] of tweens) {
      const i = key.indexOf("|"), g = gs.get(key.slice(0, i)), k = key.slice(i + 1), at = now - t.t0;
      if (!g || at >= 2 * TW) { tweens.delete(key); continue; }
      const find = x => x == null ? null : [...g.querySelectorAll(o.sel)].find(n => n.dataset.line === x);
      let n = find(k);
      if (t.dir < 0) {
        if (n || !t.node) { tweens.delete(key); continue; }
        n = t.node; n.classList.add(o.cls.gone); n.setAttribute("aria-hidden", "true"); n.inert = true;
        o.place(g, n, find(t.after), t.parent, find);
        n.getAnimations({ subtree: true }).forEach(a => { if (a.id === o.id) a.cancel(); }); // in the page again, so its last tween is listed
      }
      if (!n) { tweens.delete(key); continue; }
      n.classList.add(o.cls.tw);
      const fade = o.fade ? o.fade(n) : [n], { open, shut } = o.box(n, n.getBoundingClientRect().height + "px");
      const own = fade.includes(n), op = v => own ? { opacity: v } : {};
      const kf = t.dir > 0
        ? [{ ...shut, ...op(0), easing: "ease-in-out" }, { ...open, ...op(0), offset: .5, easing: "linear" }, { ...open, ...op(1) }]
        : [{ ...open, ...op(1), easing: "linear" }, { ...open, ...op(0), offset: .5, easing: "ease-in-out" }, { ...shut, ...op(0) }];
      const fk = t.dir > 0 ? [{ opacity: 0 }, { opacity: 0, offset: .5, easing: "linear" }, { opacity: 1 }] : [{ opacity: 1, easing: "linear" }, { opacity: 0, offset: .5 }, { opacity: 0 }];
      const place = a => { if (document.timeline.currentTime != null) a.startTime = t.t0; else a.currentTime = at; return a; }; // on the timeline from its start: no pending frame
      const a = place(n.animate(kf, { duration: 2 * TW, fill: "both", id: o.id }));
      const fades = fade.filter(f => f !== n).map(f => place(f.animate(fk, { duration: 2 * TW, fill: "both", id: o.id })));
      a.onfinish = () => { if (tweens.get(key) === t) tweens.delete(key); if (t.dir < 0) n.remove(); else { n.classList.remove(o.cls.tw); a.cancel(); fades.forEach(f => f.cancel()); } };
    }
  }
  return { snap, run, tweens };
}

/* ---------- the finish grace: a running item that finishes (done, failed, stopped, timed out) stays where it was
   for GRACE ms with its final status, then leaves with the tween. Kept per item in the page, by "session|item",
   from when the page saw it stop running, so a session switch or a re-render neither restarts nor cuts it. ---------- */
const GRACE = 5000;
const graceSeen = new Set(), graceAt = new Map(); // seen running; "sid|key" -> when the page saw it finish (ms)
let graceTimer = null;
function graceScan() {
  const now = Date.now();
  for (const s of store.sessions.values()) {
    const items = [...agentsOf(s).map(a => [a.id, !a.finished]), ...bgOf(s).map(b => [b.toolUseId, bgState(b) === "running"])];
    for (const [key, run] of items) {
      const k = s.id + "|" + key;
      if (run) { graceSeen.add(k); graceAt.delete(k); }
      else if (graceSeen.delete(k)) graceAt.set(k, now);
    }
  }
  let next = Infinity;
  for (const [k, t] of graceAt) { if (now - t >= GRACE) graceAt.delete(k); else next = Math.min(next, t + GRACE); }
  if (next < Infinity && !graceTimer) graceTimer = setTimeout(() => { graceTimer = null; renderSide(); renderRail(); }, next - now + 10);
}
const inGrace = (sid, key) => { const t = graceAt.get(sid + "|" + key); return t != null && Date.now() - t < GRACE; };
