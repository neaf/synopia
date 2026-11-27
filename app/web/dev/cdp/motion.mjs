// Motion and mark geometry (R8.1, R8.2, R8.5, R8.6), on the scripted SDK.
// Draws every mark in marks.js's table in the three colour sets (light panel, dark sidebar, open row), then:
// every running mark (CSS animations, anything in a mark) is linear, infinite, never alternates and never animates opacity; it moves only
// shapes; the sidebar sub-line tween (R8.1) is one run, height then a linear fade, and none with reduced motion; with prefers-reduced-motion: reduce (CDP emulation) nothing
// plays and every mark keeps its painted size; squares stay square at 9 to 64 px; marks centre in the sidebar
// box and on the transcript's ● gutter. Also reads app.css for words the rules forbid.
// usage: run.sh motion (or node motion.mjs <url> <state-dir>); writes motion-reduced.png in the state folder
import { connect, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
const reduce = (on) => c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });

// the stylesheet's animations (all of them are running marks; layout tweens are sidebar.js's, checked below):
// no easing, no alternate, no pulse or blink, no opacity in a keyframe
const css = readFileSync(fileURLToPath(new URL('../../css/app.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const decls = (css.match(/\banimation(-timing-function|-direction)?\s*:[^;}]*/g) || []).join('\n');
const badWord = /\bease(-in|-out|-in-out)?\b|\balternate\b|\bpulse\b|\bblink\b/i;
check('app.css animations have no ease, alternate, pulse or blink', !badWord.test(decls) && !/@keyframes\s+[\w-]*(pulse|blink)/i.test(css), String(decls.match(badWord)));
const frames = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
check('app.css keyframes found, every one parsed', frames.length > 0 && frames.length === (css.match(/@keyframes\b/g) || []).length, String(frames.length));
check('no keyframe animates opacity, visibility or a colour', frames.every((f) => !/opacity|visibility|color|background-color|fill:|stroke:/.test(f[2])), frames.filter((f) => /opacity|visibility|color|fill:|stroke:/.test(f[2])).map((f) => f[1]).join(' '));
// a running shell comes to a row that has no background line, then goes (as a server message would put it)
const tweenOf = () => `(async () => { const row = [...document.querySelectorAll('#groups .row')].find(r => !r.querySelector('[data-line^="b:"]')), s = __synopia.data().find(s => s.id === row.dataset.id);
  __synopia.inject({ t: 'background', sid: s.id, upsert: [{ toolUseId: 'mt-bg', kind: 'shell', status: 'running', start: new Date().toISOString() }] });
  const a = document.getAnimations().find(a => a.id === 'side-line'); const r = a && { duration: a.effect.getComputedTiming().duration, iterations: a.effect.getComputedTiming().iterations, kf: a.effect.getKeyframes().map(k => ({ o: k.computedOffset, e: k.easing, op: +k.opacity, h: k.height })) };
  __synopia.inject({ t: 'session', id: s.id, background: s.background || [] }); await new Promise(r => setTimeout(r, 400)); return r || null; })()`;

await reduce(false);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.load(url + '#44444444', `__synopia.current()?.startsWith('44444444')`);
// the one layout tween, a sidebar sub-line (R8.1): finite, height (eased) then opacity (linear), 150 ms each; tween.mjs checks it frame by frame
const tw = await ev(tweenOf());
check('sub-line tween: one run of 300 ms, height first (eased), then opacity (linear)', !!tw && tw.duration === 300 && tw.iterations === 1 && tw.kf.length === 3
  && tw.kf[0].op === 0 && tw.kf[1].op === 0 && tw.kf[2].op === 1 && tw.kf[0].h === '0px' && tw.kf[1].h === tw.kf[2].h && tw.kf[1].o === 0.5 && tw.kf[1].e === 'linear', JSON.stringify(tw));
const SIZES = [9, 10, 11, 12, 16, 32, 64];
await ev(`(() => {
  const keys = __synopia.marks(), sizes = ${JSON.stringify(SIZES)};
  const sets = [['light', '<div class="panel">', '</div>'], ['dark', '<div class="side">', '</div>'], ['open', '<div class="side"><div class="row" aria-current="true" style="display:block">', '</div></div>']];
  const cells = keys.map(k => '<div data-k="' + k + '">' + sizes.map(s => __synopia.mark(k, s)).join('') + '</div>').join('');
  document.body.insertAdjacentHTML('beforeend', '<div id="mt" style="position:fixed;inset:0;z-index:99;overflow:auto;background:var(--canvas);display:flex;gap:8px;align-items:start">'
    + sets.map(([n, a, b]) => a.replace('>', ' data-set="' + n + '" style="padding:6px">') + cells + b).join('') + '</div>');
})()`);
await sleep(400);

// what moves, and how
// running things: every CSS animation, and anything moving in a mark (the page draws every running thing as a mark)
const anims = await ev(`document.getAnimations().filter(a => a.playState === 'running' && (a.animationName || a.effect.target.closest('.ind'))).map(a => {
  const t = a.effect.getComputedTiming(), el = a.effect.target, kf = a.effect.getKeyframes();
  return { name: a.animationName, el: el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || ''), inMark: !!el.closest('.ind'),
    easing: [...new Set([t.easing, ...kf.map(k => k.easing)])], iterations: t.iterations, direction: t.direction, props: [...new Set(kf.flatMap(k => Object.keys(k)))].filter(p => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)) };
})`);
check('marks are animated (some animations run)', anims.length > 20, String(anims.length));
const bad = (f) => anims.filter(f).map((a) => a.name + ' on ' + a.el).slice(0, 5).join('; ');
check('every animation is linear', anims.every((a) => a.easing.every((e) => e === 'linear')), bad((a) => a.easing.some((e) => e !== 'linear')));
check('every animation is infinite', anims.every((a) => a.iterations === null || a.iterations === Infinity), bad((a) => !(a.iterations === null || a.iterations === Infinity)));
check('no animation alternates', anims.every((a) => !/alternate/.test(a.direction)), bad((a) => /alternate/.test(a.direction)));
check('animations move shapes only (transform, offsets, positions)', anims.every((a) => a.props.every((p) => /^(transform|strokeDashoffset|backgroundPosition|backgroundPositionX|backgroundPositionY)$/.test(p))), bad((a) => a.props.some((p) => !/^(transform|strokeDashoffset|backgroundPosition)/.test(p))));
check('CSS animations are on running things (marks)', anims.every((a) => a.inMark), bad((a) => !a.inMark));

// painted size of every mark at 64 px, in each set, before and after reduced motion; and the squares
const paint = `(() => { const out = {};
  document.querySelectorAll('#mt [data-set] [data-k]').forEach(row => { const k = row.dataset.k, set = row.closest('[data-set]').dataset.set;
    const el = row.lastElementChild, parts = [...el.querySelectorAll('*')].filter(p => { const s = getComputedStyle(p); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0; });
    const r = el.getBoundingClientRect();
    out[set + ' ' + k] = { parts: parts.length, w: Math.round(r.width), h: Math.round(r.height) }; });
  return out; })()`;
const before = await ev(paint);
await reduce(true);
await sleep(300);
const still = await ev(`document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName + ' on ' + a.effect.target.tagName.toLowerCase() + '.' + (a.effect.target.getAttribute('class') || ''))`);
check('reduced motion: nothing plays', still.length === 0, [...new Set(still)].slice(0, 6).join('; '));
check('reduced motion: a sub-line comes and goes without a tween', (await ev(tweenOf())) === null, 'a side-line animation ran');
const after = await ev(paint);
const changed = Object.keys(before).filter((k) => !after[k] || after[k].parts !== before[k].parts || after[k].w !== before[k].w || after[k].h !== before[k].h);
check('reduced motion: every mark keeps its parts and its box', changed.length === 0, changed.slice(0, 6).join(', '));
// a still frame is the rest pose, not a blank: every moving part is still painted
const blank = await ev(`[...document.querySelectorAll('#mt [data-set] [data-k] .ind')].filter(el => { const r = el.getBoundingClientRect(); return r.width < 1 || r.height < 1; }).length`);
check('reduced motion: no mark collapses to nothing', blank === 0, String(blank));
const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(stateDir + '/motion-reduced.png', Buffer.from(shot.result.data, 'base64'));

const squares = await ev(`[...document.querySelectorAll('#mt [data-k="stopped"] rect, #mt [data-k="failed"] rect, #mt [data-k="timeout"] rect')].map(r => { const b = r.getBoundingClientRect(); return Math.abs(b.width - b.height) < .05 ? '' : r.closest('.ind').style.fontSize + ' ' + b.width.toFixed(2) + 'x' + b.height.toFixed(2); }).filter(Boolean)`);
check('squares stay square at 9 to 64 px', squares.length === 0, squares.slice(0, 4).join(', '));
await ev(`document.getElementById('mt').remove()`);

// placement: the mark in the centre of its sidebar box, and on the ● of the transcript gutter
const off = await ev(`[...document.querySelectorAll('#groups .r-side')].map(b => { const i = b.querySelector('.ind').getBoundingClientRect(), r = b.getBoundingClientRect();
  return Math.max(Math.abs(i.left + i.width / 2 - r.left - r.width / 2), Math.abs(i.top + i.height / 2 - r.top - r.height / 2)); })`);
check('sidebar marks centred in their box', off.length > 0 && off.every((d) => d < .3), JSON.stringify(off));
const gut = await ev(`(() => { const log = document.querySelector('.log-inner');
  log.insertAdjacentHTML('afterbegin', '<div class="ln claude" id="mt-dot"><span class="g">●</span><span>a</span></div><div class="ln claude" id="mt-mark"><span class="g">' + __synopia.mark('stopped') + '</span><span>a</span></div>');
  const g = document.querySelector('#mt-dot .g'), rg = document.createRange(); rg.selectNodeContents(g);
  const d = rg.getBoundingClientRect(), gd = g.getBoundingClientRect(), m = document.querySelector('#mt-mark .ind').getBoundingClientRect(), gm = document.querySelector('#mt-mark .g').getBoundingClientRect();
  const r = { dx: (m.left + m.width / 2 - gm.left) - (d.left + d.width / 2 - gd.left) };
  document.getElementById('mt-dot').remove(); document.getElementById('mt-mark').remove(); return r; })()`);
check('gutter marks centred on the ● column', Math.abs(gut.dx) < .3, JSON.stringify(gut)); // the height: below, on real lines
// every mark on a transcript line sits where a ● would on that line: its drawn centre (an svg's first ring or
// shape, else the 1em box) against the ● glyph's ink centre over that line's own baseline, within 0.5 px. Lines:
// Claude's ●, a running Bash step, a running subagent alone and in a wave, a finished report, the done line, the live line
await ev(`(() => { const s = __synopia.cur(), ts = new Date().toISOString(), ag = (id, d) => ({ id, type: 'general-purpose', fork: false, toolUseId: id + '-t', description: d, finished: false, start: ts });
  const step = (id, name, obj, extra) => ({ id, k: 'tool', ts, name, verb: 'Ran', obj, state: 'running', toolUseId: id, ...extra });
  __synopia.inject({ t: 'agents', sid: s.id, upsert: [ag('mt-a1', 'For review: build composer option A'), ag('mt-a2', 'For review: build composer option B'), ag('mt-a3', 'For review: build composer option C')] });
  __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [step('mt-a1-t', 'Agent', 'A'), { id: 'mt-c1', k: 'claude', ts, text: 'Two more.' },
    step('mt-a2-t', 'Agent', 'B'), step('mt-a3-t', 'Agent', 'C'), { id: 'mt-c2', k: 'claude', ts, text: 'And a command.' }, step('mt-sh', 'Bash', 'Say hi', { input: 'sleep 9' })], total: s.total + 6 });
  __synopia.inject({ t: 'session', id: s.id, outbox: [{ id: 'mt-q', text: 'Then say bye.', images: 0, queued: true }] }); })()`);
await c.until(`!!document.querySelector('#log .ln.agent.one') && !!document.querySelector('#log .wgrid .ind') && !!document.querySelector('#log .ln.tool.running') && !!document.querySelector('#log .qpin .prompt > .g > .ind')`);
await ev('document.fonts.ready');
const CENTRES = `(() => { const out = [], cv = document.createElement('canvas').getContext('2d');
  const firstChar = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => /\\S/.test(n.data) ? 1 : 3 }), t = w.nextNode(); return t && [t, t.data.search(/\\S/)]; };
  const dotMid = (el, glyph = '●') => { const cs = getComputedStyle(el); cv.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; const m = cv.measureText(glyph); return (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2; };
  const baseline = (t, i) => { const p = document.createElement('span'); p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    const rest = t.splitText(i); rest.before(p); const y = p.getBoundingClientRect().bottom; p.remove(); t.parentNode.normalize(); return y; };
  const drawn = m => { const s = m.querySelector('svg > circle, svg > rect, svg > path'); return (s || m).getBoundingClientRect(); };
  const probe = (name, m, textEl) => { const fc = firstChar(textEl); if (!fc) return; const mid = dotMid(fc[0].parentElement), want = baseline(fc[0], fc[1]) - mid;
    let r; if (m.classList.contains('ind')) r = drawn(m); else { const t = m.firstChild; const cs = getComputedStyle(m); cv.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      const q = cv.measureText('●'), y = baseline(t, 0); r = { top: y - q.actualBoundingBoxAscent, height: q.actualBoundingBoxAscent + q.actualBoundingBoxDescent }; }
    out.push({ name, dy: +((r.top + r.height / 2) - want).toFixed(2) }); };
  document.querySelectorAll('#log .ln > .g').forEach(g => { const m = g.querySelector('.ind') || (g.textContent.trim() && g); if (m) probe(g.parentElement.className + ' ' + (m.querySelector?.('svg') ? 'svg' : m.textContent.trim() || m.className), m, g.nextElementSibling); });
  document.querySelectorAll('#log .wgrid > .ind').forEach(m => probe('wave row', m, m.nextElementSibling));
  /* the queued clock sits on the ❯ it stands in for: its ink centre over the band text's baseline */
  document.querySelectorAll('#log .prompt > .g > .ind').forEach(m => { const fc = firstChar(m.parentElement.nextElementSibling); if (!fc) return;
    const mid = dotMid(fc[0].parentElement, '❯'), want = baseline(fc[0], fc[1]) - mid, r = drawn(m); out.push({ name: 'queued clock', dy: +((r.top + r.height / 2) - want).toFixed(2) }); });
  return out; })()`;
const centred = async (label, need) => {
  const r = await ev(CENTRES), missing = need.filter((re) => !r.some((x) => re.test(x.name)));
  check(`${label}: every transcript mark sits on its line's ● (within 0.5 px)`, missing.length === 0 && r.every((x) => Math.abs(x.dy) <= .5),
    JSON.stringify(r.filter((x) => Math.abs(x.dy) > .5).concat(missing.length ? [{ missing: missing.map(String) }, ...r] : [])));
};
// the Working line's mark sits on its 1px rule (R5.5) and keeps moving: a running, infinite, linear animation
await reduce(false); await sleep(100);
const onRule = await ev(`(() => { const l = document.querySelector('#log .liveln.rule'); if (!l) return null; const b = getComputedStyle(l, '::before');
  const an = l.querySelector('.g .ind').getAnimations({ subtree: true }); return { rule: b.height === '1px' && b.position === 'absolute', n: an.length, running: an.every(a => a.playState === 'running' && a.effect.getTiming().iterations === Infinity && a.effect.getComputedTiming().easing === 'linear') }; })()`);
check('the Working line\'s mark on its rule keeps moving (linear, infinite)', !!onRule && onRule.rule && onRule.n > 0 && onRule.running, JSON.stringify(onRule));
await reduce(true);
const NEED = [/queued clock/, /claude ●/, /tool running ●/, /agent one svg/, /wave row/, /liveln rule svg/, /ln agent ind/];
await centred('1x', NEED);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await sleep(200);
await centred('2x', NEED);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
// the still mark of a finished turn, on an idle session
await ev(`document.querySelector('#groups .row[data-id^="11111111"]').click()`);
await c.until(`__synopia.current()?.startsWith('11111111') && !!document.querySelector('#log .doneln .ind')`);
await ev('document.fonts.ready');
await centred('done line', [/doneln/]);
await reduce(false);
console.log('reduced-motion shot: ' + stateDir + '/motion-reduced.png');

// a re-render keeps each running mark's phase (syncMarks pins startTime to the timeline origin)
const phase = () => ev(`(() => { const a = document.getAnimations().find(a => a.effect?.target?.closest?.('.side .ind')); return a ? { t: a.startTime, cur: a.currentTime } : null; })()`);
await sleep(200); const p1 = await phase();
await ev('__synopia.render("side")'); await sleep(120);
const p2 = await phase();
check('a rebuilt mark keeps its phase (startTime pinned to 0)', !!p1 && !!p2 && p1.t === 0 && p2.t === 0, JSON.stringify([p1, p2]));
c.print(); c.close();
