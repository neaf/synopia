// Sidebar sub-line tweens (R8.1, R4.3, R4.4), on the scripted SDK. Puts two sessions in a group (so the guides
// show), then adds and removes a running background shell and a "to review" subagent on the first one, and
// samples every frame (requestAnimationFrame) while the sidebar re-renders every 40 ms. Asserts: coming, the
// height opens first and the line stays transparent until it is full, then it fades in; going, the line fades
// out at full height, then the height closes; no jump (the first frame keeps the old height, no frame steps
// far, the row below moves only by the row's own change); the guide spans the row on every frame; afterwards
// the geometry is the same as a fresh render; with prefers-reduced-motion: reduce, both are instant; a row
// being dragged keeps its dimmed state through a tween.
// usage: run.sh tween (or node tween.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
import { serverSend } from './helpers.mjs';
const [url] = process.argv.slice(2);
const c = await connect();
const { check, mouse } = c;
const ev = c.ev;
// a background tab gets no animation frames: bring it to front first
const sample = async (change, key, ms) => { await c.cdp('Page.bringToFront');
  const r = await ev(`Promise.race([TW_SAMPLE('${change}', '${key}', ${ms}), new Promise(r => setTimeout(() => r({ before: TW_GEO(), frames: [], anims: -1, hidden: document.visibilityState }), ${ms} + 3000))])`);
  if (!r.frames?.length) console.log('no frames sampled: ' + JSON.stringify(r).slice(0, 200));
  return r; };
const reduce = (on) => c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
await reduce(false);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.load(url);

// a group of two sessions, the first one under test: made as a drop would make it, then a reload
const ids = await ev(`[...document.querySelectorAll('#groups .row')].slice(0, 2).map(r => r.dataset.id)`);
await serverSend(url, { t: 'newGroup', sid: ids[1], onto: ids[0], group: 'gtw', name: 'Tween' });
await c.load(url);
const setup = ids.length < 2 ? 'need two sessions' : await ev(`(() => {
  const g = [...document.querySelectorAll('#groups .group')].find(g => g.querySelector('.g-name')?.textContent === 'Tween');
  if (JSON.stringify(g ? [...g.querySelectorAll('.row')].map(r => r.dataset.id) : null) !== ${JSON.stringify(JSON.stringify(ids))}) return 'no group of the two';
  window.TWID = ${JSON.stringify(ids[0])}; return 'ok'; })()`);
check('setup: a group of two', setup === 'ok', setup);

// page helpers: change the session as a server message would (the protocol has no message that drops a
// line, so a session message with the shorter list does), re-render, and sample the row each frame
await ev(`(() => {
  const S = () => __synopia.data().find(s => s.id === TWID), put = m => __synopia.inject(m), iso = () => new Date().toISOString();
  const row = () => [...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID);
  window.TW_PUT = put; window.TW_S = S;
  window.TW_CHANGE = { bgOn: () => put({ t: 'background', sid: TWID, upsert: [{ toolUseId: 'tw-bg', kind: 'shell', status: 'running', start: iso(), description: 'tween check' }] }),
    bgOff: () => put({ t: 'session', id: TWID, background: (S().background || []).filter(b => b.toolUseId !== 'tw-bg') }),
    // the backend sends a deliverable with review: true and counts it in the session's state (status.ts)
    revOn: () => { put({ t: 'agents', sid: TWID, upsert: [{ id: 'tw-rev', toolUseId: 'tw-rev-t', description: 'For review: tween check', finished: true, review: true, start: iso() }] });
      put({ t: 'session', id: TWID, state: { ...S().state, review: S().state.review + 1 } }); },
    revOff: () => put({ t: 'session', id: TWID, agents: (S().agents || []).filter(a => a.id !== 'tw-rev'), state: { ...S().state, review: S().state.review - 1 } }) };
  const geo = () => { const r = row(); if (!r) return null; const b = r.getBoundingClientRect(), tg = r.querySelector('.tg').getBoundingClientRect(), nx = r.nextElementSibling?.getBoundingClientRect();
    return { top: b.top, h: b.height, tgTop: tg.top - b.top, tgBot: tg.bottom - b.bottom, gapNext: nx ? nx.top - b.bottom : null, dragging: r.classList.contains('dragging') }; };
  window.TW_GEO = geo;
  window.TW_SAMPLE = (change, key, ms) => new Promise(done => {
    const out = [], t0 = performance.now(), b = geo();
    TW_CHANGE[change](); __synopia.render('side');
    const iv = setInterval(() => __synopia.render('side'), 40); // full re-renders mid-tween must neither restart nor skip it
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
  const a = await ev('TW_SHAPE()'); await ev(`__synopia.resetTweens(); __synopia.render('side')`); const b = await ev('TW_SHAPE()');
  check(name + ': geometry afterwards equals a fresh render (lines, L corners, the guide and its tick, the mark box)', a === b, a + '\n  vs ' + b);
}

for (const [name, on, off, key] of [['background line', 'bgOn', 'bgOff', 'b:tw-bg'], ['review line', 'revOn', 'revOff', 'review']]) {
  judge(name + ' coming', await sample(on, key, 480), true); await aligned(name + ' coming');
  judge(name + ' going', await sample(off, key, 480), false); await aligned(name + ' going');
}

// a turn-around mid-way goes back from where it is: no jump
const turn = await ev(`(async () => { const h0 = TW_GEO().h; TW_CHANGE.bgOn(); await new Promise(r => setTimeout(r, 100)); const h1 = TW_GEO().h;
  TW_CHANGE.bgOff(); const h2 = TW_GEO().h; await new Promise(r => setTimeout(r, 450)); return { h0, h1, h2, h3: TW_GEO().h }; })()`);
check('turning round mid-way keeps the height (no jump), then closes', turn.h1 > turn.h0 + 0.5 && eq(turn.h2, turn.h1, 0.3) && eq(turn.h3, turn.h0, 0.05), JSON.stringify(turn));

// a text-only change doesn't animate (the line's name changing)
await ev(`TW_CHANGE.bgOn()`); await sleep(450);
const textOnly = await ev(`(() => { TW_PUT({ t: 'background', sid: TWID, upsert: [{ ...TW_S().background.find(b => b.toolUseId === 'tw-bg'), description: 'tween check two' }] });
  return document.getAnimations().filter(a => a.id === 'side-line').length; })()`);
check('a line whose text alone changes does not animate', textOnly === 0, String(textOnly));
await ev(`TW_PUT({ t: 'session', id: TWID, background: TW_S().background.filter(b => !b.toolUseId.startsWith('tw-')) })`); await sleep(450);

// a row being dragged: a line comes mid-drag, the row stays dimmed and its guide aligned
const r = await ev(`(() => { const b = [...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
await mouse('mousePressed', r.x, r.y); await mouse('mouseMoved', r.x + 8, r.y + 8); await mouse('mouseMoved', r.x + 12, r.y + 40);
const dr = await sample('revOn', 'review', 420);
check('dragged row stays dimmed through the tween', dr.frames.every((f) => f.dragging), String(dr.frames.filter((f) => !f.dragging).length));
check('dragged row: guide spans the row on every frame', dr.frames.every((f) => eq(f.tgTop, dr.before.tgTop, 0.05) && eq(f.tgBot, dr.before.tgBot, 0.05)), '');
await c.key('Escape', { vk: 27 }); await mouse('mouseReleased', r.x + 12, r.y + 40);
await ev(`TW_CHANGE.revOff()`); await sleep(450);

// reduced motion: both steps instant
await reduce(true); await sleep(100);
for (const [ch, key, coming] of [['bgOn', 'b:tw-bg', true], ['bgOff', 'b:tw-bg', false]]) {
  const res = await sample(ch, key, 120), fr = res.frames, end = fr.at(-1);
  check('reduced motion ' + (coming ? 'coming' : 'going') + ': instant (first frame final, nothing animates)', fr.every((f) => eq(f.h, end.h, 0.05) && (coming ? f.op === 1 : !f.line)) && !eq(end.h, res.before.h, 4) && res.anims === 0, JSON.stringify(fr[0]) + ' ' + res.anims);
}
await reduce(false);

// ---------- the background panel: children tween in and out like the sub-lines, guides following (R7.1) ----------
await ev(`[...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID).click()`); // its view, the panel up
await ev(`(() => { const iso = () => new Date().toISOString();
  TW_PUT({ t: 'background', sid: TWID, upsert: [{ toolUseId: 'tw-past', kind: 'shell', status: 'completed', start: new Date(Date.now() - 60000).toISOString(), end: iso(), description: 'the panel is up', command: 'true' }] });
  const shell = { toolUseId: 'tw-rb', kind: 'shell', status: 'running', description: 'rail tween check', command: 'sleep 9' };
  window.RW = { kid: k => document.querySelector('.rail .kid[data-line="' + k + '"]'),
    shellOn: () => { shell.start = iso(); TW_PUT({ t: 'background', sid: TWID, upsert: [shell] }); },
    shellOff: () => TW_PUT({ t: 'session', id: TWID, background: TW_S().background.filter(b => b.toolUseId !== 'tw-rb') }),
    shellDone: () => TW_PUT({ t: 'background', sid: TWID, upsert: [{ ...shell, status: 'completed', end: iso() }] }),
    agentOn: () => TW_PUT({ t: 'agents', sid: TWID, upsert: [{ id: 'tw-ag', toolUseId: 'tw-ag-t', description: 'grace check', type: 'general-purpose', finished: false, start: iso() }] }),
    agentDone: () => TW_PUT({ t: 'agents', sid: TWID, upsert: [{ id: 'tw-ag', finished: true, end: iso() }] }) };
  window.RW_SAMPLE = (change, key, ms) => new Promise(done => {
    const out = [], t0 = performance.now(); RW[change](); __synopia.render('rail');
    const iv = setInterval(() => __synopia.render('rail'), 40);
    const f = () => { const k = RW.kid(key);
      if (k) { const b = k.getBoundingClientRect(), tg = k.querySelector(':scope > .tg').getBoundingClientRect(), card = k.querySelector(':scope > .card');
        out.push({ t: performance.now() - t0, h: b.height, op: +getComputedStyle(card).opacity, tgTop: tg.top - b.top, tgBot: tg.bottom - b.bottom, tgOp: +getComputedStyle(k.querySelector(':scope > .tg')).opacity }); }
      else out.push({ t: performance.now() - t0, gone: true });
      if (performance.now() - t0 < ms) requestAnimationFrame(f); else { clearInterval(iv); done({ frames: out, anims: document.getAnimations().filter(a => a.id === 'rail-line').length }); } };
    requestAnimationFrame(f); });
  return 'ok'; })()`);
await c.cdp('Page.bringToFront');
let rf = (await ev(`RW_SAMPLE('shellOn', 'tw-rb', 480)`)).frames.filter((f) => !f.gone);
const full = rf.length ? Math.max(...rf.map((f) => f.h)) : 0;
check('rail child coming: the height opens over several frames', rf.filter((f) => f.h > 0.5 && f.h < full - 0.5).length >= 3, JSON.stringify(rf.map((f) => +f.h.toFixed(1))));
check('rail child coming: the card stays transparent until full height, then fades in', rf.every((f) => f.h >= full - 0.5 || f.op <= 0.01) && rf.filter((f) => f.op > 0.01 && f.op < 0.99).length >= 3 && rf.at(-1).op === 1, JSON.stringify(rf.map((f) => [+f.h.toFixed(1), +f.op.toFixed(2)])));
check('rail child coming: its guide spans it on every frame and never fades', rf.every((f) => eq(f.tgTop, 0, 0.05) && eq(f.tgBot, 0, 0.05) && f.tgOp === 1), JSON.stringify(rf.find((f) => !eq(f.tgTop, 0, 0.05) || !eq(f.tgBot, 0, 0.05) || f.tgOp !== 1)));
rf = (await ev(`RW_SAMPLE('shellOff', 'tw-rb', 480)`)).frames;
const lit = rf.filter((f) => !f.gone);
check('rail child going: fades at full height first, then the height closes, then it is gone', lit.length >= 6 && lit.every((f) => f.h >= full - 0.5 || f.op <= 0.01) && lit.some((f) => f.op > 0.01 && f.op < 0.99) && lit.some((f) => f.h > 0.5 && f.h < full - 0.5) && rf.at(-1).gone, JSON.stringify(rf.map((f) => f.gone ? 'x' : [+f.h.toFixed(1), +f.op.toFixed(2)])));
check('rail child going: its guide spans it on every frame', lit.every((f) => eq(f.tgTop, 0, 0.05) && eq(f.tgBot, 0, 0.05)), '');

// ---------- the 5 s grace on finishing, in the panel and the sidebar ----------
const graceState = (key, line) => ev(`(() => { const k = RW.kid('${key}'), r = [...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID), ln = r && r.querySelector('.r-main > [data-line="${line}"]');
  return { kid: !!k, ended: !!k && k.querySelector('.card').classList.contains('ended'), marks: k ? k.querySelectorAll('.card > .pm > .ind').length : 0, kidLive: !!k && !!k.querySelector('[data-live]'),
    past: [...document.querySelectorAll('.rail .pr .n')].some(n => n.textContent.includes(${JSON.stringify('check')})),
    side: !!ln && !ln.classList.contains('r-gone'), sideMarks: ln ? ln.querySelectorAll('.ind').length : 0, sideLive: !!ln && !!ln.querySelector('[data-live]'), sideText: ln ? ln.textContent.trim() : '',
    order: [...document.querySelectorAll('.rail .now > .kids > .kid')].map(k => k.dataset.line), before: !!document.querySelector('.rail .now') && [...document.querySelector('.rail').children].indexOf(document.querySelector('.rail .now')) === 0 }; })()`);
for (const [name, rm] of [['', false], ['reduced motion: ', true]]) {
  await reduce(rm);
  await ev(`RW.shellOn(); RW.agentOn()`); await sleep(500);
  const t0 = Date.now();
  await ev(`RW.shellDone(); RW.agentDone()`);
  await sleep(1500);
  // a session switch and back mid-grace: neither restarts nor cuts it
  await ev(`[...document.querySelectorAll('#groups .row')].find(r => r.dataset.id !== TWID).click()`); await sleep(500);
  await ev(`[...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === TWID).click()`);
  await sleep(4000 - (Date.now() - t0));
  const g = await graceState('tw-ag', 'a:tw-ag'), gs = await graceState('tw-rb', 'b:tw-rb');
  check(name + 'grace at 4 s: the panel keeps the subagent and the shell where they were, with their final status', g.kid && g.ended && g.marks === 2 && !g.kidLive && gs.kid && gs.ended && gs.marks === 2 && !gs.kidLive && !g.past, JSON.stringify([g, gs]));
  check(name + 'grace at 4 s: the panel keeps the running order (subagent before shell), the tree first', g.order.indexOf('tw-ag') >= 0 && g.order.indexOf('tw-ag') < g.order.indexOf('tw-rb') && g.before, JSON.stringify(g.order));
  // the mark carries the state, no duration (R4.2, 2026-11-27, the user: "Let's remove all the times.")
  check(name + 'grace at 4 s: the sidebar keeps the sub-lines and their still marks, the name alone, no duration', g.side && g.sideMarks === 2 && !g.sideLive && gs.side && gs.sideMarks === 2 && gs.sideText === 'rail tween check', JSON.stringify([g.sideText, gs.sideText]));
  await sleep(5600 - (Date.now() - t0));
  const e = await graceState('tw-ag', 'a:tw-ag'), es = await graceState('tw-rb', 'b:tw-rb');
  check(name + 'after about 5.3 s: gone from the tree and the sidebar, the shell in Past', !e.kid && !es.kid && !e.side && !es.side && es.past, JSON.stringify([e, es]));
  await ev(`(() => { const s = TW_S(); TW_PUT({ t: 'session', id: TWID, background: s.background.filter(b => b.toolUseId !== 'tw-rb'), agents: s.agents.filter(a => a.id !== 'tw-ag') }); })()`); await sleep(400);
}
await reduce(false);
c.print(); c.close();
