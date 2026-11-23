// Sidebar sub-line tweens (R8.1, R4.3, R4.4), on the fake driver. Puts two sessions in a group (so the guides
// show), then adds and removes a running background shell and a "to review" subagent on the first one, and
// samples every frame (requestAnimationFrame) while renderSide re-renders every 40 ms. Asserts: coming, the
// height opens first and the line stays transparent until it is full, then it fades in; going, the line fades
// out at full height, then the height closes; no jump (the first frame keeps the old height, no frame steps
// far, the row below moves only by the row's own change); the guide spans the row on every frame; afterwards
// the geometry is the same as a fresh render; with prefers-reduced-motion: reduce, both are instant; a row
// being dragged keeps its dimmed state through a tween.
// usage: run.sh tween (or node tween.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
const [url] = process.argv.slice(2);
const c = await connect();
const { check, mouse } = c;
const ev = c.ev;
// a background tab gets no animation frames (this Chrome sometimes opens a settings tab over the page): bring it to front first
const sample = async (change, key, ms) => { await c.cdp('Page.bringToFront');
  const r = await ev(`Promise.race([TW_SAMPLE('${change}', '${key}', ${ms}), new Promise(r => setTimeout(() => r({ before: TW_GEO(), frames: [], anims: -1, hidden: document.visibilityState }), ${ms} + 3000))])`);
  if (!r.frames?.length) console.log('no frames sampled: ' + JSON.stringify(r).slice(0, 200));
  return r; };
const reduce = (on) => c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
await reduce(false);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.cdp('Page.navigate', { url });
await sleep(2500);

// a group of two sessions, the first one under test
const setup = await ev(`(() => {
  const ids = KEYS.slice(0, 2); if (ids.length < 2) return 'need two sessions';
  layout.groups.forEach(g => g.ids = g.ids.filter(x => !ids.includes(x))); layout.others = layout.others.filter(x => !ids.includes(x));
  layout.groups.unshift({ id: 'gtw', name: 'Tween', proc: '', ids }); renderSide();
  window.TWID = ids[0]; return 'ok'; })()`);
check('setup: a group of two', setup === 'ok', setup);

// page helpers: change the session, re-render, and sample the row each frame
await ev(`(() => {
  const S = () => store.sessions.get(TWID);
  const row = () => [...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID);
  window.TW_CHANGE = { bgOn: () => { const s = S(); s.background = [...(s.background || []), { toolUseId: 'tw-bg', kind: 'shell', status: 'running', start: new Date().toISOString(), description: 'tween check' }]; },
    bgOff: () => { const s = S(); s.background = (s.background || []).filter(b => b.toolUseId !== 'tw-bg'); },
    revOn: () => { const s = S(); s.agents = [...(s.agents || []), { id: 'tw-rev', toolUseId: 'tw-rev-t', description: 'For review: tween check', finished: true, start: new Date().toISOString() }]; },
    revOff: () => { const s = S(); s.agents = (s.agents || []).filter(a => a.id !== 'tw-rev'); } };
  const geo = () => { const r = row(); if (!r) return null; const b = r.getBoundingClientRect(), tg = r.querySelector('.tg').getBoundingClientRect(), nx = r.nextElementSibling?.getBoundingClientRect();
    return { top: b.top, h: b.height, tgTop: tg.top - b.top, tgBot: tg.bottom - b.bottom, gapNext: nx ? nx.top - b.bottom : null, dragging: r.classList.contains('dragging') }; };
  window.TW_GEO = geo;
  window.TW_SAMPLE = (change, key, ms) => new Promise(done => {
    const out = [], t0 = performance.now(), b = geo();
    TW_CHANGE[change](); renderSide();
    const iv = setInterval(() => renderSide(), 40); // full re-renders mid-tween must neither restart nor skip it
    const f = () => { const r = row(), ln = r && r.querySelector('.r-main > [data-line="' + key + '"]'), g = geo();
      out.push({ t: performance.now() - t0, ...g, line: !!ln, lh: ln ? ln.getBoundingClientRect().height : 0, op: ln ? +getComputedStyle(ln).opacity : null });
      if (performance.now() - t0 < ms) requestAnimationFrame(f); else { clearInterval(iv); done({ before: b, frames: out, anims: document.getAnimations().filter(a => a.id === 'side-line').length }); } };
    requestAnimationFrame(f); });
  // the row's geometry, lines and L corners included, to compare with a fresh render
  window.TW_SHAPE = () => { const r = row(), o = r.getBoundingClientRect();
    return JSON.stringify([...r.querySelectorAll('.r-main > *, .el, .tg, .r-side')].map(e => { const b = e.getBoundingClientRect(); return [e.className, Math.round(b.left - o.left), Math.round((b.top - o.top) * 2) / 2, Math.round(b.width), Math.round(b.height * 2) / 2]; })); };
})()`);

const eq = (a, b, d = 0.6) => Math.abs(a - b) <= d;
function judge(name, res, coming) {
  const fr = res.frames, b = res.before;
  if (!fr.length) return check(name + ': frames sampled', false, 'none');
  const end = fr.at(-1), full = Math.max(...fr.map((f) => f.lh));
  check(name + ': first frame keeps the old height (no jump)', eq(fr[0].h, b.h, 1.5), fr[0].h + ' vs ' + b.h);
  const steps = fr.slice(1).map((f, i) => f.h - fr[i].h), delta = Math.abs(end.h - b.h);
  check(name + ': height changes ' + (coming ? 'up' : 'down') + ' only, in small steps', delta > 8 && steps.every((s) => (coming ? s >= -0.05 : s <= 0.05) && Math.abs(s) < delta * 0.6), JSON.stringify(steps.map((s) => +s.toFixed(1))));
  check(name + ': several frames between (it tweens)', fr.filter((f) => f.h > Math.min(b.h, end.h) + 0.5 && f.h < Math.max(b.h, end.h) - 0.5).length >= 3, String(fr.length));
  const lit = fr.filter((f) => f.line && f.op > 0.01 && f.op < 0.99);
  check(name + ': the line fades over several frames', lit.length >= 3, String(lit.length));
  if (coming) {
    check(name + ': transparent while the height opens', fr.every((f) => !f.line || f.lh >= full - 0.5 || f.op <= 0.01), JSON.stringify(fr.filter((f) => f.lh < full - 0.5 && f.op > 0.01).slice(0, 3)));
    check(name + ': fades only at full height', lit.every((f) => f.lh >= full - 0.5), '');
    check(name + ': ends shown, full height', end.op === 1 && eq(end.lh, full), JSON.stringify(end));
  } else {
    check(name + ': fades at full height first', fr.every((f) => !f.line || f.op >= 0.99 || f.lh >= full - 0.5 || f.op <= 0.01) && lit.every((f) => f.lh >= full - 0.5), JSON.stringify(lit.filter((f) => f.lh < full - 0.5).slice(0, 3)));
    check(name + ': closes only once transparent', fr.every((f) => !f.line || f.lh >= full - 0.5 || f.op <= 0.01), JSON.stringify(fr.filter((f) => f.lh < full - 0.5 && f.op > 0.01).slice(0, 3)));
    check(name + ': ends removed', !end.line, JSON.stringify(end));
  }
  const firstLit = fr.findIndex((f) => f.line && f.op > 0.01 && f.op < 0.99), firstMove = fr.findIndex((f) => !eq(f.h, b.h, 0.3));
  check(name + (coming ? ': height before fade' : ': fade before height'), coming ? firstMove >= 0 && firstMove < firstLit : firstLit >= 0 && firstLit < firstMove, firstMove + ' / ' + firstLit);
  const doneAt = fr.find((f) => eq(f.h, end.h, 0.05) && (coming ? f.op === 1 : !f.line));
  check(name + ': about 150 ms a step (done in 260 to 400 ms)', doneAt && doneAt.t > 260 && doneAt.t < 400, doneAt ? doneAt.t.toFixed(0) : 'never');
  check(name + ': guide spans the row on every frame', fr.every((f) => eq(f.tgTop, b.tgTop, 0.05) && eq(f.tgBot, b.tgBot, 0.05)), JSON.stringify(fr.find((f) => !(eq(f.tgTop, b.tgTop, 0.05) && eq(f.tgBot, b.tgBot, 0.05)))));
  check(name + ': nothing else shifts (row top, gap to the next row)', fr.every((f) => eq(f.top, b.top, 0.05) && (b.gapNext === null || eq(f.gapNext, b.gapNext, 0.05))), JSON.stringify(fr.find((f) => !eq(f.top, b.top, 0.05) || !eq(f.gapNext, b.gapNext, 0.05))));
  check(name + ': tweens finish (no animation left)', res.anims === 0, String(res.anims));
}
async function aligned(name) {
  const a = await ev('TW_SHAPE()'); await ev('tweens.clear(); renderSide()'); const b = await ev('TW_SHAPE()');
  check(name + ': geometry afterwards equals a fresh render (lines, L corners, the guide and its tick, the mark box)', a === b, a + '\n  vs ' + b);
}

for (const [name, on, off, key] of [['background line', 'bgOn', 'bgOff', 'bg'], ['review line', 'revOn', 'revOff', 'review']]) {
  judge(name + ' coming', await sample(on, key, 480), true); await aligned(name + ' coming');
  judge(name + ' going', await sample(off, key, 480), false); await aligned(name + ' going');
}

// a turn-around mid-way goes back from where it is: no jump
const turn = await ev(`(async () => { const h0 = TW_GEO().h; TW_CHANGE.bgOn(); renderSide(); await new Promise(r => setTimeout(r, 100)); const h1 = TW_GEO().h;
  TW_CHANGE.bgOff(); renderSide(); const h2 = TW_GEO().h; await new Promise(r => setTimeout(r, 450)); return { h0, h1, h2, h3: TW_GEO().h }; })()`);
check('turning round mid-way keeps the height (no jump), then closes', turn.h1 > turn.h0 + 0.5 && eq(turn.h2, turn.h1, 0.3) && eq(turn.h3, turn.h0, 0.05), JSON.stringify(turn));

// a text-only change doesn't animate
await ev(`TW_CHANGE.bgOn(); renderSide()`); await sleep(450);
const textOnly = await ev(`(() => { const s = store.sessions.get(TWID); s.background.push({ toolUseId: 'tw-bg2', kind: 'monitor', status: 'running', start: new Date().toISOString(), description: 'two' }); renderSide();
  return document.getAnimations().filter(a => a.id === 'side-line').length; })()`);
check('a count changing on a line does not animate', textOnly === 0, String(textOnly));
await ev(`(() => { const s = store.sessions.get(TWID); s.background = s.background.filter(b => !b.toolUseId.startsWith('tw-')); renderSide(); })()`); await sleep(450);

// a row being dragged: a line comes mid-drag, the row stays dimmed and its guide aligned
const r = await ev(`(() => { const b = [...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
await mouse('mousePressed', r.x, r.y); await mouse('mouseMoved', r.x + 8, r.y + 8); await mouse('mouseMoved', r.x + 12, r.y + 40);
const dr = await sample('revOn', 'review', 420);
check('dragged row stays dimmed through the tween', dr.frames.every((f) => f.dragging), String(dr.frames.filter((f) => !f.dragging).length));
check('dragged row: guide spans the row on every frame', dr.frames.every((f) => eq(f.tgTop, dr.before.tgTop, 0.05) && eq(f.tgBot, dr.before.tgBot, 0.05)), '');
await c.key('Escape', { vk: 27 }); await mouse('mouseReleased', r.x + 12, r.y + 40);
await ev(`TW_CHANGE.revOff(); renderSide()`); await sleep(450);

// reduced motion: both steps instant
await reduce(true); await sleep(100);
for (const [ch, key, coming] of [['bgOn', 'bg', true], ['bgOff', 'bg', false]]) {
  const res = await sample(ch, key, 120), fr = res.frames, end = fr.at(-1);
  check('reduced motion ' + (coming ? 'coming' : 'going') + ': instant (first frame final, nothing animates)', fr.every((f) => eq(f.h, end.h, 0.05) && (coming ? f.op === 1 : !f.line)) && !eq(end.h, res.before.h, 4) && res.anims === 0, JSON.stringify(fr[0]) + ' ' + res.anims);
}
await reduce(false);
c.print(); c.close();
