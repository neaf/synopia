// Image thumbnails and the viewer (R5.13), on a transcript with made-up images generated at check time.
// usage: node images.mjs make <claude-dir>   writes the transcript (run.sh does this first)
//        node images.mjs <url> <state-dir> <claude-dir>
// Checks: the sizes (3 transcript lines high, aspect kept, not scaled up, 320px at most and cropped),
// sizes known before load, a tool step's images with the step closed, the quiet tile for a 404 and a 415,
// the endpoint's headers, the viewer (click, ← →, Esc, a click outside, keys kept from the page), and
// the composer: a synthetic paste, the ✕ on hover, remove, send. Writes images-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { shot as shotTo } from './helpers.mjs';
import { deflateSync, crc32 } from 'node:zlib';

const SID = 'c0c0c0c0-0000-4000-8000-0000000000c0';
// A made-up w x h RGB PNG: a hue ramp left to right, darker in a band at the centre (so a crop shows).
export function png(w, h) {
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((3 * w + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = x / Math.max(1, w - 1), mid = Math.abs(x - w / 2) < w / 10 ? 0.55 : 1, o = y * (3 * w + 1) + 1 + 3 * x;
      rows[o] = (90 + 140 * f) * mid; rows[o + 1] = (170 - 60 * f + 40 * (y / h)) * mid; rows[o + 2] = (230 - 150 * f) * mid;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const img = (mediaType, buf) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
const line = (o) => JSON.stringify(o) + '\n';
const ts = (s) => `2026-11-20T10:00:${String(s).padStart(2, '0')}.000Z`;
const base = { cwd: '/tmp/synopia-images', sessionId: SID };
const tool = (uuid, s, id, name, input) => line({ ...base, type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (uuid, s, id, content) => line({ ...base, type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

const read = (id, f, w, h, type = 'image/png') => [id, 'Read', { file_path: `/tmp/synopia-images/${f}` }, [img(type, png(w, h))]];
// [tool id, name, input, result]; the 900x300 one is labelled a GIF, so the backend can't read its size
// from the header and the page learns it from the image itself
const RUN = [
  ['toolu_e1', 'Edit', { file_path: '/tmp/synopia-images/app.css', old_string: 'a', new_string: 'b' }, 'The file has been updated.'],
  read('toolu_r1', 'home.png', 800, 400),
  ['toolu_b1', 'Bash', { command: 'ls /tmp/synopia-images', description: 'List the screens' }, 'home.png'],
  read('toolu_r2', 'settings.png', 2400, 1600),
  read('toolu_r3', 'icon.png', 30, 24),
  ['toolu_s1', 'mcp__browser__screenshot', {}, [{ type: 'text', text: 'Screenshot taken' }, img('image/png', png(1600, 200)), img('image/png', png(500, 500))]],
  read('toolu_r4', 'banner.gif', 900, 300, 'image/gif'),
  read('toolu_r5', 'phone.png', 300, 900),
];
// the run's images in order: w, h, the source the viewer names
const RUN_IMGS = [[800, 400, '/tmp/synopia-images/home.png'], [2400, 1600, '/tmp/synopia-images/settings.png'], [30, 24, '/tmp/synopia-images/icon.png'],
  [1600, 200, 'browser(screenshot)'], [500, 500, 'browser(screenshot)'], [900, 300, '/tmp/synopia-images/banner.gif'], [300, 900, '/tmp/synopia-images/phone.png']];

if (process.argv[2] === 'make') {
  const dir = path.join(process.argv[3], 'projects', '-tmp-synopia-images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`),
    line({ ...base, type: 'user', uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: [img('image/png', png(400, 100)), img('image/png', png(20, 20)), img('image/png', png(3000, 100)), { type: 'text', text: 'Three made-up images: a wide one, a tiny one and a panorama. What do they show?' }] } })
    + tool('a1', 2, 'toolu_ls', 'Bash', { command: 'ls /tmp/synopia-images', description: 'List the images' })
    + result('r1', 3, 'toolu_ls', 'chart.png')
    + tool('a2', 4, 'toolu_read', 'Read', { file_path: '/tmp/synopia-images/chart.png' })
    + result('r2', 5, 'toolu_read', [img('image/png', png(240, 160))])
    + line({ ...base, type: 'assistant', uuid: 'a3', timestamp: ts(6), message: { role: 'assistant', content: [{ type: 'text', text: 'They are colour ramps. Taking a screenshot of the page too.' }] } })
    + tool('a4', 7, 'toolu_shot', 'mcp__browser__screenshot', {})
    + result('r4', 8, 'toolu_shot', [{ type: 'text', text: 'Screenshot taken' }, img('image/png', png(640, 400)), img('image/png', png(120, 90))])
    + line({ ...base, type: 'assistant', uuid: 'a5', timestamp: ts(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
    + line({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 9000, timestamp: ts(10) })
    + line({ ...base, type: 'user', uuid: 'u2', timestamp: ts(20), message: { role: 'user', content: [img('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { type: 'text', text: 'And a drawing that is not served.' }] } })
    + line({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: ts(21) })
    // a collapsed run of eight steps with seven images from five of them (R5.12b: one row for the run)
    + line({ ...base, type: 'user', uuid: 'u3', timestamp: ts(30), message: { role: 'user', content: [{ type: 'text', text: 'Check every screen of the made-up app.' }] } })
    + RUN.map(([id, name, input, content], k) => tool(`ra${k}`, 31 + 2 * k, id, name, input) + result(`rr${k}`, 32 + 2 * k, id, content)).join('')
    + line({ ...base, type: 'assistant', uuid: 'a9', timestamp: ts(50), message: { role: 'assistant', content: [{ type: 'text', text: 'All seven screens look right.' }] } })
    + line({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 20000, timestamp: ts(51) })
    // a prompt the CLI sent with two pasted images: one text block with the tags, then the images (R5.13)
    + line({ ...base, type: 'user', uuid: 'u4', timestamp: ts(55), imagePasteIds: [1, 2], message: { role: 'user', content: [{ type: 'text', text: '[Image #1] is the old screen, [Image #2] the new one. Which reads better?' }, img('image/png', png(400, 100)), img('image/png', png(240, 160))] } })
    + line({ ...base, type: 'assistant', uuid: 'a10', timestamp: ts(56), message: { role: 'assistant', content: [{ type: 'text', text: 'The new one.' }] } })
    + line({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: ts(57) }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key, mouse, until } = c;
await c.cdp('Page.enable');
const { identifier } = await c.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => __csp.push(e.violatedDirective + ' ' + e.blockedURI));` }).then((r) => r.result);
await c.load(url + `#${SID.slice(0, 8)}`, `current === '${SID}'`);
const shot = (name, clip) => shotTo(c, path.join(stateDir, `images-${name}.png`), clip && { ...clip, scale: 1 });
const near = (a, b) => Math.abs(a - b) < 0.6;

check('the session loads with its prompt thumbnails', await until(`cur()?.id === '${SID}' && document.querySelectorAll('[data-key="you:u1"] .thumbs .thumb').length === 3`));
check('sizes come from the backend before load', await ev(`[...document.querySelectorAll('[data-key="you:u1"] .thumbs .thumb')].map(b => b.style.getPropertyValue('--iw') + 'x' + b.style.getPropertyValue('--ih')).join() === '400x100,20x20,3000x100'`));
check('no "[3 pasted images]" line', await ev(`!document.querySelector('.prompt .img')`));
check('the images load', await until(`[...document.querySelectorAll('[data-key="you:u1"] .thumbs img')].every(i => i.complete && i.naturalWidth > 0)`));
const lh = await ev(`parseFloat(getComputedStyle(document.getElementById('log')).lineHeight)`);
const sizes = await ev(`[...document.querySelectorAll('[data-key="you:u1"] .thumbs img')].map(i => { const r = i.getBoundingClientRect(), cs = getComputedStyle(i); return { w: parseFloat(cs.width), h: parseFloat(cs.height), fit: cs.objectFit, pos: cs.objectPosition, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth + ' ' + cs.borderTopStyle }; })`);
const H = 3 * lh;
check(`400x100 shows 3 lines high (${H.toFixed(1)}px at ${lh}px a line) and 4 times as wide`, near(sizes[0].h, H) && near(sizes[0].w, 4 * H), JSON.stringify(sizes[0]));
check('20x20 is not scaled up', sizes[1].w === 20 && sizes[1].h === 20, JSON.stringify(sizes[1]));
check('3000x100 is capped at 320 and cropped to the centre', sizes[2].w === 320 && near(sizes[2].h, H) && sizes[2].fit === 'cover' && sizes[2].pos === '50% 50%', JSON.stringify(sizes[2]));
check('rounded, with a 1px line', sizes.every((s) => s.border === '1px solid' && parseFloat(s.radius) > 0), JSON.stringify(sizes));
console.log(`  sizes: line ${lh}px, ${sizes.map((s) => `${s.w.toFixed(1)}x${s.h.toFixed(1)}`).join(', ')}`);

// tool steps: a run of two (closed), and a single step
check('a run shows its Read image with the run closed', await ev(`(() => { const b = [...document.querySelectorAll('.ln.tool')].find(l => l.querySelector('details.fold')); return !!b && !b.querySelector('details.fold').open && b.querySelectorAll(':scope > .thumbs .thumb').length === 1 && b.querySelector(':scope > .thumbs').offsetHeight > 0; })()`));
check('a single step shows its two screenshot images under it, closed', await ev(`(() => { const s = [...document.querySelectorAll('.ln.tool > details.step')].find(d => d.textContent.includes('screenshot')); const b = s?.parentElement; return !!b && !s.open && b.querySelectorAll(':scope > .thumbs .thumb').length === 2; })()`));
check('the thumbnails sit in the text column', await ev(`(() => { const t = document.querySelector('.ln.tool > .thumbs'), g = t.parentElement.querySelector('.g'); return t.getBoundingClientRect().left >= g.getBoundingClientRect().right - 0.5; })()`));
check('a 415 type is a quiet tile', await until(`!!document.querySelector('.prompt .thumbs .thumb.gone') && document.querySelector('.prompt .thumbs .thumb.gone').textContent === 'Image gone'`));
await ev(`(() => { const s = cur(); onMessage({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'u-missing', k: 'you', ts: '2026-11-20T10:01:00.000Z', text: 'An image whose file was rewritten', images: 1, imgs: [{ ref: 'nope:0', mediaType: 'image/png', w: 400, h: 100 }] }], total: s.total + 1 }); })()`);
check('a 404 is the same tile, the image\'s shape', await until(`(() => { const t = document.querySelector('[data-key="you:u-missing"] .thumb.gone'); return !!t && Math.abs(t.getBoundingClientRect().width - ${4 * H + 2}) < 1; })()`));

// the collapsed run: all seven images in one wrapping row under the run's line, the shapes as soon as known
const RUN_ROW = `[...document.querySelectorAll('.ln.tool')].find(l => l.querySelector('details.fold') && l.textContent.includes('read 5 files'))`;
const early = await ev(`(() => { const b = ${RUN_ROW}; return b ? [...b.querySelectorAll('.thumb')].map(t => t.style.getPropertyValue('--iw') + 'x' + t.style.getPropertyValue('--ih')).join() : 'no run'; })()`);
check('the run\'s sizes come from the backend where the header says (the GIF-labelled PNG by its bytes)', /^800x400,2400x1600,30x24,1600x200,500x500,900x300,300x900$/.test(early), early);
check('the run\'s images load', await until(`(() => { const b = ${RUN_ROW}; return !!b && [...b.querySelectorAll('.thumb img')].length === 7 && [...b.querySelectorAll('.thumb img')].every(i => i.complete && i.naturalWidth > 0); })()`, 10000));
await sleep(100);
const run = await ev(`(() => { const b = ${RUN_ROW}, rows = b.querySelectorAll('.thumbs'), fold = b.querySelector('details.fold');
  return { rows: rows.length, direct: rows.length === 1 && rows[0].parentElement === b, closed: !fold.open, below: rows[0].getBoundingClientRect().top >= fold.getBoundingClientRect().bottom - 0.5,
    imgs: [...rows[0].querySelectorAll('.thumb img')].map(i => { const r = i.getBoundingClientRect(), cs = getComputedStyle(i); return { w: +parseFloat(cs.width).toFixed(1), h: +parseFloat(cs.height).toFixed(1), top: Math.round(r.top), left: Math.round(r.left) }; }) }; })()`);
check('a collapsed run with 7 images from 5 steps is one row, a child of the run, below its closed line', run.rows === 1 && run.direct && run.closed && run.below, JSON.stringify(run));
const want = RUN_IMGS.map(([w, h]) => { const th = Math.min(h, H); return [Math.min(320, th * w / h), th]; });
check('each run image is at most 3 lines high, the width from its aspect ratio, 320px at most, small ones not scaled up', run.imgs.length === 7 && run.imgs.every((s, k) => near(s.w, want[k][0]) && near(s.h, want[k][1])), JSON.stringify({ got: run.imgs, want }));
check('the row runs side by side and wraps: the second image is on the first\'s line', run.imgs.length > 1 && run.imgs[1].top === run.imgs[0].top && run.imgs[1].left > run.imgs[0].left, JSON.stringify(run.imgs.slice(0, 2)));
console.log(`  run row: ${run.imgs.map((s) => `${s.w}x${s.h}`).join(', ')}`);
await ev(`${RUN_ROW}.scrollIntoView({ block: 'center' })`);
await sleep(150);
await shot('run-row', await ev(`(() => { const r = ${RUN_ROW}.getBoundingClientRect(); return { x: r.left - 30, y: r.top - 8, width: Math.min(1000, r.width + 38), height: r.height + 16 }; })()`));

// the endpoint, from the page
const hdr = await ev(`(async () => { const src = document.querySelector('.prompt .thumb').dataset.fullSrc; const r = await fetch(src); const n = await fetch(src.replace(/token=[^&]*/, 'token=x')); const s = await fetch(src.replace(/ref=[^&]*/, 'ref=u2%3A0')); return [r.status, r.headers.get('content-type'), r.headers.get('cache-control'), r.headers.get('x-content-type-options'), n.status, s.status].join(); })()`);
check('the endpoint: png, private cache, nosniff; 403 without the token; 415 for svg', hdr === '200,image/png,private, max-age=3600,nosniff,403,415', hdr);

await ev(`document.getElementById('log').scrollTop = 0`);
await sleep(200);
const area = await ev(`(() => { const a = document.querySelector('.prompt').getBoundingClientRect(), b = [...document.querySelectorAll('.ln.tool')].pop().getBoundingClientRect(); return { x: a.left - 4, y: a.top - 4, width: Math.min(1000, a.width + 8), height: b.bottom - a.top + 8 }; })()`);
await shot('transcript', area);

// the viewer
const centre = (sel, i = 0) => ev(`(() => { const r = document.querySelectorAll(${JSON.stringify(sel)})[${i}].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const click = async ([x, y]) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(150); };
const VN = `(document.querySelector('.viewer .v-n')?.textContent || '')`, VFROM = `(document.querySelector('.viewer .v-from')?.textContent || '')`;
const VIMG = `document.querySelector('.viewer .v-stage img')`, VST = `document.querySelector('.viewer .v-stage')`;
const loaded = () => until(`${VIMG}.complete && ${VIMG}.naturalWidth > 0`);
const modeBefore = await ev(`document.body.dataset.mode`), sessionBefore = await ev(`current`);
await ev(`document.getElementById('log').scrollTop = 0`); await sleep(100);
await click(await centre('.prompt .thumbs .thumb'));
check('a click opens the viewer on that image', await ev(`!!document.querySelector('.viewer') && ${VIMG}.getAttribute('src') === document.querySelectorAll('.prompt .thumb')[0].dataset.fullSrc`));
check('the viewer says 1 of 3, from your message', (await ev(VN)) === '1 of 3' && (await ev(VFROM)) === 'your message', await ev(`document.querySelector('.viewer .v-foot').textContent`));
check('the viewer clears the title bar', await ev(`getComputedStyle(document.querySelector('.viewer')).top === getComputedStyle(document.documentElement).getPropertyValue('--titlebar').trim()`));
await loaded();
check('a small image shows at its real size, not scaled up, and has no 100% toggle', await ev(`(() => { const r = ${VIMG}.getBoundingClientRect(); return Math.round(r.width) === 402 && Math.round(r.height) === 102 && !document.querySelector('.viewer').classList.contains('zoomable') && !document.querySelector('.viewer .v-foot').textContent.includes('actual size'); })()`));
await click(await centre('.viewer .v-stage img'));
check('a click on a small image changes nothing', await ev(`!!document.querySelector('.viewer') && !document.querySelector('.viewer.full') && Math.round(${VIMG}.getBoundingClientRect().width) === 402`));
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
await loaded();
check('→ moves to the third', (await ev(VN)) === '3 of 3');
check('a wide image is fit to the window', await ev(`(() => { const i = ${VIMG}, r = i.getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0 && r.width > 1000 && Math.abs(i.clientWidth / i.clientHeight - 30) < 0.5; })()`));
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
check('→ stops at the last', (await ev(VN)) === '3 of 3');
await key('ArrowLeft', { code: 'ArrowLeft', vk: 37 });
check('← moves back', (await ev(VN)) === '2 of 3');
await key('J', { shift: true, vk: 74 });
await key('i', { vk: 73 });
check('keys stay in the viewer: no session switch, no mode change', (await ev(`current`)) === sessionBefore && (await ev(`document.body.dataset.mode`)) === modeBefore && (await ev(`!!document.querySelector('.viewer')`)));
await key('Escape', { code: 'Escape', vk: 27 });
check('Esc closes it, the mode as before', (await ev(`!document.querySelector('.viewer')`)) && (await ev(`document.body.dataset.mode`)) === modeBefore && (await ev(`interruptAsk === null`)));
await click(await centre('.ln.tool > .thumbs .thumb', 2));
check('a tool\'s viewer has its own images: 2 of 2', (await ev(VN)) === '2 of 2');
await click([20, 400]);
check('a click outside closes it', await ev(`!document.querySelector('.viewer')`));
check('the transcript beneath did not take that click', (await ev(`current`)) === sessionBefore);

// the run's set: all seven, its sources, then fit, 100% and panning on the 2400x1600 one
await ev(`${RUN_ROW}.scrollIntoView({ block: 'center' })`); await sleep(150);
await click(await ev(`(() => { const r = ${RUN_ROW}.querySelectorAll('.thumb')[0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`));
const seen = [];
for (let k = 0; k < 7; k++) {
  seen.push(`${await ev(VN)}|${await ev(VFROM)}`);
  await key(k % 2 ? 'j' : 'ArrowRight', k % 2 ? { vk: 74 } : { code: 'ArrowRight', vk: 39 });
}
const wantSeen = RUN_IMGS.map(([, , from], k) => `${k + 1} of 7|${from}`);
check('a run\'s thumbnail steps through all 7 of the run (→ and j), with the count and each source', JSON.stringify(seen) === JSON.stringify(wantSeen), JSON.stringify(seen));
check('it stops at the 7th', (await ev(VN)) === '7 of 7');
for (let k = 0; k < 5; k++) await key(k % 2 ? 'ArrowLeft' : 'k', k % 2 ? { code: 'ArrowLeft', vk: 37 } : { vk: 75 });
check('← and k step back: 2 of 7', (await ev(VN)) === '2 of 7');
await loaded();
const fit = await ev(`(() => { const i = ${VIMG}, r = i.getBoundingClientRect(), s = ${VST}; return { w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom, sw: s.scrollWidth, cw: s.clientWidth, vw: innerWidth, vh: innerHeight }; })()`);
check('the 2400x1600 opens fit to the window, aspect kept, nothing to scroll', fit.w < 2400 && fit.r <= fit.vw && fit.b <= fit.vh && Math.abs(fit.w / fit.h - 1.5) < 0.01 && fit.sw <= fit.cw, JSON.stringify(fit));
check('the footer at fit: ← → or j k, z for actual size, Esc', await ev(`(() => { const t = document.querySelector('.viewer .v-foot .hint').textContent; return t.includes('← → or j k other images') && t.includes('z actual size') && t.includes('Esc close') && !t.includes('pan'); })()`), await ev(`document.querySelector('.viewer .v-foot .hint').textContent`));
await shot('viewer-fit');
// click at a point a quarter in from the left and top: that image point stays under the pointer
const px = fit.l + fit.w / 4, py = fit.t + fit.h / 4;
const fx = (px - fit.l - 1) / (fit.w - 2), fy = (py - fit.t - 1) / (fit.h - 2);
await click([px, py]);
const full = await ev(`(() => { const i = ${VIMG}, r = i.getBoundingClientRect(), s = ${VST}; return { cw: i.clientWidth, ch: i.clientHeight, x: r.left + 1 + ${fx} * i.clientWidth, y: r.top + 1 + ${fy} * i.clientHeight, sl: s.scrollLeft, st: s.scrollTop, full: document.querySelector('.viewer').classList.contains('full'), cursor: getComputedStyle(i).cursor }; })()`);
check('a click goes to 100%: one image pixel per CSS pixel', full.full && full.cw === 2400 && full.ch === 1600, JSON.stringify(full));
check('the clicked point stays under the pointer', Math.abs(full.x - px) < 2 && Math.abs(full.y - py) < 2, JSON.stringify({ full, px, py }));
check('at 100% the cursor is grab and the footer says pan and fit', full.cursor === 'grab' && await ev(`(() => { const t = document.querySelector('.viewer .v-foot .hint').textContent; return t.includes('drag or ← ↑ ↓ → pan') && t.includes('z fit to window') && t.includes('j k other images') && !t.includes('or j k'); })()`));
await shot('viewer-full');
// drag: press, move up-left by 200, 150, let go
const [dx0, dy0] = [640, 400];
await mouse('mouseMoved', dx0, dy0); await mouse('mousePressed', dx0, dy0);
for (let k = 1; k <= 5; k++) { await mouse('mouseMoved', dx0 - 40 * k, dy0 - 30 * k); await sleep(20); }
const grabbing = await ev(`getComputedStyle(${VIMG}).cursor`);
await mouse('mouseReleased', dx0 - 200, dy0 - 150); await sleep(150);
const dragged = await ev(`(() => { const s = ${VST}; return { sl: s.scrollLeft, st: s.scrollTop, full: document.querySelector('.viewer.full') !== null, open: !!document.querySelector('.viewer') }; })()`);
check('a drag pans: scrollLeft and scrollTop grow by the drag', Math.abs(dragged.sl - full.sl - 200) < 2 && Math.abs(dragged.st - full.st - 150) < 2, JSON.stringify({ before: full, after: dragged }));
check('the cursor is grabbing while dragging, and the drag is no click', grabbing === 'grabbing' && dragged.full && dragged.open, JSON.stringify({ grabbing, dragged }));
await c.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 120 }); await sleep(200);
check('the wheel scrolls it', (await ev(`${VST}.scrollTop`)) > dragged.st);
const before = await ev(`${VST}.scrollLeft`);
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
check('at 100%, → pans instead of changing image', (await ev(`${VST}.scrollLeft`)) > before && (await ev(VN)) === '2 of 7');
await key('z', { vk: 90 });
check('z goes back to fit', await ev(`(() => { const r = ${VIMG}.getBoundingClientRect(); return !document.querySelector('.viewer.full') && Math.abs(r.width - ${fit.w}) < 1 && ${VST}.scrollLeft === 0; })()`));
await key('0', { vk: 48, code: 'Digit0' });
check('0 goes to 100% too', await ev(`!!document.querySelector('.viewer.full') && ${VIMG}.clientWidth === 2400`));
await key('j', { vk: 74 });
check('j at 100% changes image, which opens at fit', (await ev(VN)) === '3 of 7' && await ev(`!document.querySelector('.viewer.full')`));
await loaded();
check('the 30x24 one is not scaled up', await ev(`(() => { const r = ${VIMG}.getBoundingClientRect(); return Math.round(r.width) === 32 && Math.round(r.height) === 26; })()`));
await key('Escape', { code: 'Escape', vk: 27 });
check('Esc closes the run\'s viewer', await ev(`!document.querySelector('.viewer')`));

// a size the item doesn't carry: the thumbnail takes the image's shape from the image itself
await ev(`(() => { const s = cur(); onMessage({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'u-unsized', k: 'you', ts: '2026-11-20T10:02:00.000Z', text: 'An image the backend gave no size for', images: 1, imgs: [{ ref: 'rr1:0.0', mediaType: 'image/png' }] }], total: s.total + 1 }); })()`);
check('an image with no size in the item gets its shape, not a square', await until(`(() => { const i = document.querySelector('[data-key="you:u-unsized"] .thumb.sized img'); if (!i) return false; const cs = getComputedStyle(i); return Math.abs(parseFloat(cs.width) - ${2 * H}) < 0.6 && Math.abs(parseFloat(cs.height) - ${H}) < 0.6; })()`));

// a CLI-sent prompt with tags: the text with the tags in place as plain dim tags, the thumbnails below
const cliTags = await ev(`(() => { const p = document.querySelector('[data-key="you:u4"]'); if (!p) return null; const md = p.querySelector('.md'), tags = [...md.querySelectorAll('.img-tag')];
  return { text: md.querySelector('p')?.textContent, tags: tags.map(t => t.textContent), dim: tags.every(t => getComputedStyle(t).color !== getComputedStyle(md).color && getComputedStyle(t).fontWeight === getComputedStyle(md).fontWeight && getComputedStyle(t).backgroundColor === 'rgba(0, 0, 0, 0)'),
    thumbs: p.querySelectorAll('.thumbs .thumb').length, below: p.querySelector('.thumbs').getBoundingClientRect().top >= tags[0].getBoundingClientRect().bottom - 0.5 }; })()`);
check('a CLI-sent prompt shows its [Image #N] tags in place, dim, the two thumbnails below',
  !!cliTags && cliTags.text?.startsWith('[Image #1] is the old screen, [Image #2] the new one.') && JSON.stringify(cliTags.tags) === '["[Image #1]","[Image #2]"]' && cliTags.dim && cliTags.thumbs === 2 && cliTags.below, JSON.stringify(cliTags));
await ev(`document.querySelector('[data-key="you:u4"]').scrollIntoView({ block: 'center' })`); await sleep(150);
await shot('cli-tags', await ev(`(() => { const r = document.querySelector('[data-key="you:u4"]').getBoundingClientRect(); return { x: r.left - 4, y: r.top - 4, width: Math.min(1000, r.width + 8), height: r.height + 8 }; })()`));

// the composer: paste two images at two caret places, each with its [Image #N] tag, remove one with its ✕,
// two more, delete a tag's text, reload, send: the text with its tags, then the tagged images in tag order
await ev(`document.getElementById('msg').focus()`);
const SPY = `(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`;
await ev(SPY);
const paste = (b64, name) => ev(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}, { type: 'image/png' }));
  document.getElementById('msg').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
const MSG = `document.getElementById('msg').value`;
const caret = (i) => ev(`(() => { const t = document.getElementById('msg'), i = ${i} < 0 ? t.value.length : ${i}; t.setSelectionRange(i, i); })()`);
const B64 = { a: png(400, 100).toString('base64'), b: png(3000, 100).toString('base64'), c: png(20, 20).toString('base64'), d: png(240, 160).toString('base64') };
await ev(`(() => { const t = document.getElementById('msg'); t.value = 'left right'; t.dispatchEvent(new Event('input')); })()`);
await caret(5);
await paste(B64.a, 'a.png');
check('a paste puts [Image #3] at the caret (#1 and #2 are in the session\'s prompts), a space between it and the text', (await ev(MSG)) === 'left [Image #3] right', await ev(MSG));
await caret(-1);
await paste(B64.b, 'b.png');
check('the next paste at the end is [Image #4], one more than any tag in the session', (await ev(MSG)) === 'left [Image #3] right [Image #4]', await ev(MSG));
check('pasted images show as thumbnails below the text', await until(`document.querySelectorAll('.composer .attach.thumbs .thumb img').length === 2 && [...document.querySelectorAll('.composer .attach img')].every(i => i.complete && i.naturalWidth)`) && await ev(`document.querySelector('.composer .attach').getBoundingClientRect().top >= document.getElementById('msg').getBoundingClientRect().bottom - 1`));
check('they are object URLs, not the server', await ev(`[...document.querySelectorAll('.composer .attach img')].every(i => i.src.startsWith('blob:'))`));
const comp = await ev(`[...document.querySelectorAll('.composer .attach img')].map(i => parseFloat(getComputedStyle(i).width) + 'x' + parseFloat(getComputedStyle(i).height)).join()`);
check('the same size as in the transcript', comp === `${sizes[0].w}x${sizes[0].h},${sizes[2].w}x${sizes[2].h}`, comp);
check('the ✕ is hidden until hover', await ev(`getComputedStyle(document.querySelector('.composer .unattach')).opacity === '0'`));
const [hx, hy] = await centre('.composer .thumb-wrap', 0);
await mouse('mouseMoved', hx, hy); await sleep(100);
check('hover shows the ✕', await ev(`getComputedStyle(document.querySelector('.composer .unattach')).opacity === '1'`));
const dock = await ev(`(() => { const r = document.querySelector('.dock').getBoundingClientRect(); return { x: r.left, y: r.top - 8, width: r.width, height: r.height + 8 }; })()`);
await shot('composer', dock);
const firstUrl = await ev(`document.querySelector('.composer .attach img').src`);
await click(await centre('.composer .unattach', 0));
check('the ✕ removes that image', await ev(`document.querySelectorAll('.composer .attach .thumb').length === 1 && attachments.length === 1 && document.querySelector('.composer .attach img').src !== ${JSON.stringify(firstUrl)}`));
check('and its tag, with one space; the other tag keeps its number', (await ev(MSG)) === 'left right [Image #4]', await ev(MSG));
check('its object URL is freed', (await ev(`new Promise(r => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('freed'); i.src = ${JSON.stringify(firstUrl)}; })`)) === 'freed');
check('focus stayed in the message box', await ev(`document.activeElement.id === 'msg'`));
await click(await centre('.composer .thumb', 0));
check('a pasted thumbnail opens the viewer too', await ev(`!!document.querySelector('.viewer') && document.querySelector('.viewer img').src.startsWith('blob:')`));
await key('Escape', { code: 'Escape', vk: 27 });
check('Esc closes it and the box keeps focus and insert mode', await ev(`!document.querySelector('.viewer') && document.activeElement.id === 'msg' && document.body.dataset.mode === 'insert'`));
await caret(0);
await paste(B64.c, 'c.png');
await caret(-1);
await paste(B64.d, 'd.png');
check('numbers count up and are not reused: #5 at the start, #6 at the end', (await ev(MSG)) === '[Image #5] left right [Image #4] [Image #6]', await ev(MSG));
await ev(`(() => { const t = document.getElementById('msg'); t.value = t.value.replace(' [Image #6]', ''); t.dispatchEvent(new Event('input')); })()`);
const untagged = `[...document.querySelectorAll('.composer .attach .thumb-wrap')].map(f => f.dataset.n + (f.classList.contains('untagged') ? '-' : '+')).join()`;
check('deleting a tag\'s text dims its thumbnail, with a dashed line; it stays in the row', (await ev(untagged)) === '4+,5+,6-' && await ev(`getComputedStyle(document.querySelector('.composer .thumb-wrap.untagged .thumb img')).borderTopStyle === 'dashed'`), await ev(untagged));
await shot('composer-tags', dock);
// the draft, its tags and its images survive a reload (R3.9)
await until(`attachments.every(a => a.data)`);
await ev(`uiFlush()`); await sleep(500);
await ev(`window.__before = 1`);
await c.load(url, `current === '${SID}' && typeof __before === 'undefined'`); // no hash: a real reload, the restored state picks the session
check('after a reload: the text with its tags, the three images with their numbers, #6 still dimmed',
  await until(`document.getElementById('msg')?.value === '[Image #5] left right [Image #4]' && attachments.length === 3 && attachments.every(a => a.data) && (${untagged}) === '4+,5+,6-'`, 8000),
  JSON.stringify(await ev(`({ text: document.getElementById('msg')?.value, n: attachments.map(a => a.n), marks: ${untagged} })`)));
await ev(SPY);
await ev(`document.getElementById('msg').focus()`);
await key('Enter', { code: 'Enter', vk: 13 });
const sentMsg = await ev(`JSON.stringify(__sent.filter(m => m.t === 'send').map(m => ({ text: m.text, images: m.images })))`);
const sent = JSON.parse(sentMsg);
const which = (data) => Object.keys(B64).find((k) => B64[k] === data) || '?';
check('Enter sends the text with its tags and the tagged images as base64 with their numbers, not the untagged one',
  sent.length === 1 && sent[0].text === '[Image #5] left right [Image #4]' && JSON.stringify(sent[0].images.map((i) => [i.mediaType, i.n, which(i.data)])) === JSON.stringify([['image/png', 4, 'b'], ['image/png', 5, 'c']]),
  JSON.stringify(sent.map((m) => ({ text: m.text, images: m.images.map((i) => [i.mediaType, i.n, which(i.data)]) }))));
// the blocks the backend makes of that message (content.ts): one text block with the tags, then the images in tag order
const { execFileSync } = await import('node:child_process');
const { pathToFileURL } = await import('node:url');
const contentTs = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../backend/src/content.ts')).href;
const blocks = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
  `import { userContent } from ${JSON.stringify(contentTs)}; import fs from 'node:fs'; const m = JSON.parse(fs.readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify(userContent(m.text, m.images)));`],
{ input: JSON.stringify(sent[0] || { text: '', images: [] }) }).toString());
const shape = Array.isArray(blocks) ? blocks.map((b) => b.type === 'text' ? `text:${b.text}` : `image:${which(b.source.data)}`) : [blocks];
check('the send\'s blocks: the text with its tags, then #5\'s image, then #4\'s', JSON.stringify(shape) === JSON.stringify(['text:[Image #5] left right [Image #4]', 'image:c', 'image:b']), JSON.stringify(shape));
check('the box is empty after sending', await ev(`document.querySelectorAll('.composer .attach .thumb').length === 0 && attachments.length === 0`));
check('no CSP violation', (await ev(`__csp.length`)) === 0, JSON.stringify(await ev(`__csp`)));
await c.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });
c.print();
c.close();
