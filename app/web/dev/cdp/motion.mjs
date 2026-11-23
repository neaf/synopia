// Motion and mark geometry (R8.1, R8.2, R8.5, R8.6), on the fake driver.
// Draws every mark in marks.js's table in the three colour sets (light panel, dark sidebar, open row), then:
// every running animation is linear, infinite, never alternates and never animates opacity; it moves only
// marks, the running duration bar or the spinner; with prefers-reduced-motion: reduce (CDP emulation) nothing
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

// the stylesheet itself: no easing, no alternate, no pulse or blink, no opacity in a keyframe
const css = readFileSync(fileURLToPath(new URL('../../css/app.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
check('app.css has no ease, alternate, pulse or blink', !/\bease(-in|-out|-in-out)?\b|\balternate\b|\bpulse\b|\bblink\b/i.test(css), String(css.match(/\bease(-in|-out|-in-out)?\b|\balternate\b|\bpulse\b|\bblink\b/i)));
const frames = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
check('app.css keyframes found', frames.length > 5, String(frames.length));
check('no keyframe animates opacity, visibility or a colour', frames.every((f) => !/opacity|visibility|color|background-color|fill:|stroke:/.test(f[2])), frames.filter((f) => /opacity|visibility|color|fill:|stroke:/.test(f[2])).map((f) => f[1]).join(' '));

await reduce(false);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.cdp('Page.navigate', { url: 'about:blank' }); await sleep(200);
await c.cdp('Page.navigate', { url: url + '#44444444' });
await sleep(2500);
const SIZES = [9, 10, 11, 12, 16, 32, 64];
await ev(`(() => {
  const keys = Object.keys(P), sizes = ${JSON.stringify(SIZES)};
  const sets = [['light', '<div class="panel">', '</div>'], ['dark', '<div class="side">', '</div>'], ['open', '<div class="side"><div class="row" aria-current="true" style="display:block">', '</div></div>']];
  const cells = keys.map(k => '<div data-k="' + k + '">' + sizes.map(s => ind(k, s)).join('') + '</div>').join('');
  document.body.insertAdjacentHTML('beforeend', '<div id="mt" style="position:fixed;inset:0;z-index:99;overflow:auto;background:var(--canvas);display:flex;gap:8px;align-items:start">'
    + sets.map(([n, a, b]) => a.replace('>', ' data-set="' + n + '" style="padding:6px">') + cells + b).join('') + '</div>');
})()`);
await sleep(400);

// what moves, and how
const anims = await ev(`document.getAnimations().filter(a => a.playState === 'running').map(a => {
  const t = a.effect.getComputedTiming(), el = a.effect.target, kf = a.effect.getKeyframes();
  return { name: a.animationName, el: el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || ''), inMark: !!el.closest('.ind'), bar: !!el.closest('.bar.st-running'), spinner: el.classList.contains('spinner'),
    easing: [...new Set([t.easing, ...kf.map(k => k.easing)])], iterations: t.iterations, direction: t.direction, props: [...new Set(kf.flatMap(k => Object.keys(k)))].filter(p => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)) };
})`);
check('marks are animated (some animations run)', anims.length > 20, String(anims.length));
const bad = (f) => anims.filter(f).map((a) => a.name + ' on ' + a.el).slice(0, 5).join('; ');
check('every animation is linear', anims.every((a) => a.easing.every((e) => e === 'linear')), bad((a) => a.easing.some((e) => e !== 'linear')));
check('every animation is infinite', anims.every((a) => a.iterations === null || a.iterations === Infinity), bad((a) => !(a.iterations === null || a.iterations === Infinity)));
check('no animation alternates', anims.every((a) => !/alternate/.test(a.direction)), bad((a) => /alternate/.test(a.direction)));
check('animations move shapes only (transform, offsets, positions)', anims.every((a) => a.props.every((p) => /^(transform|strokeDashoffset|backgroundPosition|backgroundPositionX|backgroundPositionY)$/.test(p))), bad((a) => a.props.some((p) => !/^(transform|strokeDashoffset|backgroundPosition)/.test(p))));
check('motion only on running things (marks, the running bar, the spinner)', anims.every((a) => a.inMark || a.bar || a.spinner), bad((a) => !(a.inMark || a.bar || a.spinner)));

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
  log.insertAdjacentHTML('afterbegin', '<div class="ln claude" id="mt-dot"><span class="g">●</span><span>a</span></div><div class="ln claude" id="mt-mark"><span class="g">' + ind('stopped') + '</span><span>a</span></div>');
  const g = document.querySelector('#mt-dot .g'), rg = document.createRange(); rg.selectNodeContents(g);
  const d = rg.getBoundingClientRect(), gd = g.getBoundingClientRect(), m = document.querySelector('#mt-mark .ind').getBoundingClientRect(), gm = document.querySelector('#mt-mark .g').getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(g).lineHeight);
  const r = { dx: (m.left + m.width / 2 - gm.left) - (d.left + d.width / 2 - gd.left), dy: (m.top + m.height / 2 - gm.top) - lh / 2 };
  document.getElementById('mt-dot').remove(); document.getElementById('mt-mark').remove(); return r; })()`);
check('gutter marks centred on the ● column and the first line', Math.abs(gut.dx) < .3 && Math.abs(gut.dy) < .3, JSON.stringify(gut));
await reduce(false);
console.log('reduced-motion shot: ' + stateDir + '/motion-reduced.png');
c.print(); c.close();
