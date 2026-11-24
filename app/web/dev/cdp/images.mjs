// Image thumbnails and the viewer (R5.13), on a transcript with made-up images generated at check time.
// usage: node images.mjs make <claude-dir>   writes the transcript (run.sh does this first)
//        node images.mjs <url> <state-dir> <claude-dir>
// Checks: the sizes (3 transcript lines high, aspect kept, not scaled up, 320px at most and cropped),
// sizes known before load, a tool step's images with the step closed, the quiet tile for a 404 and a 415,
// the endpoint's headers, the viewer (click, ← →, Esc, a click outside, keys kept from the page), and
// the composer: a synthetic paste, the ✕ on hover, remove, send. Writes images-*.png.
import fs from 'node:fs';
import path from 'node:path';
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
    + line({ ...base, type: 'user', uuid: 'u2', timestamp: ts(20), message: { role: 'user', content: [img('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { type: 'text', text: 'And a drawing that is not served.' }] } }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key, mouse } = c;
await c.cdp('Page.enable');
const { identifier } = await c.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => __csp.push(e.violatedDirective + ' ' + e.blockedURI));` }).then((r) => r.result);
await c.load(url + `#${SID.slice(0, 8)}`, `current === '${SID}'`);
const until = async (expr, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
const shot = async (name, clip) => fs.writeFileSync(path.join(stateDir, `images-${name}.png`), Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).result.data, 'base64'));
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
const modeBefore = await ev(`document.body.dataset.mode`), sessionBefore = await ev(`current`);
await click(await centre('.prompt .thumbs .thumb'));
check('a click opens the viewer on that image', await ev(`!!document.querySelector('.viewer') && document.querySelector('.viewer img').getAttribute('src') === document.querySelectorAll('.prompt .thumb')[0].dataset.fullSrc`));
check('the viewer says 1 of 3', await ev(`document.querySelector('.viewer figcaption').textContent.startsWith('1 of 3.')`));
await until(`document.querySelector('.viewer img').complete`);
check('a small image shows at its real size', await ev(`(() => { const r = document.querySelector('.viewer img').getBoundingClientRect(); return Math.round(r.width) === 402 && Math.round(r.height) === 102; })()`));
await shot('viewer');
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
await until(`document.querySelector('.viewer img').complete`);
check('→ moves to the third', await ev(`document.querySelector('.viewer figcaption').textContent.startsWith('3 of 3.')`));
check('a wide image is fit to the window', await ev(`(() => { const r = document.querySelector('.viewer img').getBoundingClientRect(); const i = document.querySelector('.viewer img'); return r.right <= innerWidth && r.left >= 0 && r.width > 1000 && Math.abs(i.clientWidth / i.clientHeight - 30) < 0.5; })()`));
await shot('viewer-wide');
await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
check('→ stops at the last', await ev(`document.querySelector('.viewer figcaption').textContent.startsWith('3 of 3.')`));
await key('ArrowLeft', { code: 'ArrowLeft', vk: 37 });
check('← moves back', await ev(`document.querySelector('.viewer figcaption').textContent.startsWith('2 of 3.')`));
await key('J', { shift: true, vk: 74 });
await key('i', { vk: 73 });
check('keys stay in the viewer: no session switch, no mode change', (await ev(`current`)) === sessionBefore && (await ev(`document.body.dataset.mode`)) === modeBefore && (await ev(`!!document.querySelector('.viewer')`)));
await key('Escape', { code: 'Escape', vk: 27 });
check('Esc closes it, the mode as before', (await ev(`!document.querySelector('.viewer')`)) && (await ev(`document.body.dataset.mode`)) === modeBefore && (await ev(`interruptAsk === null`)));
await click(await centre('.ln.tool > .thumbs .thumb', 2));
check('a tool\'s viewer has its own images: 2 of 2', await ev(`document.querySelector('.viewer figcaption')?.textContent.startsWith('2 of 2.')`));
await click([20, 400]);
check('a click outside closes it', await ev(`!document.querySelector('.viewer')`));
check('the transcript beneath did not take that click', (await ev(`current`)) === sessionBefore);

// the composer: paste two images, remove one with its ✕, send
await ev(`document.getElementById('msg').focus()`);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const paste = (b64, name) => ev(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}, { type: 'image/png' }));
  document.getElementById('msg').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await paste(png(400, 100).toString('base64'), 'a.png');
await paste(png(3000, 100).toString('base64'), 'b.png');
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
check('its object URL is freed', (await ev(`new Promise(r => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('freed'); i.src = ${JSON.stringify(firstUrl)}; })`)) === 'freed');
check('focus stayed in the message box', await ev(`document.activeElement.id === 'msg'`));
await click(await centre('.composer .thumb', 0));
check('a pasted thumbnail opens the viewer too', await ev(`!!document.querySelector('.viewer') && document.querySelector('.viewer img').src.startsWith('blob:')`));
await key('Escape', { code: 'Escape', vk: 27 });
check('Esc closes it and the box keeps focus and insert mode', await ev(`!document.querySelector('.viewer') && document.activeElement.id === 'msg' && document.body.dataset.mode === 'insert'`));
await until(`attachments.every(a => a.data)`);
await ev(`document.getElementById('msg').value = 'With a panorama'`);
await key('Enter', { code: 'Enter', vk: 13 });
const sent = await ev(`JSON.stringify(__sent.filter(m => m.t === 'send').map(m => ({ text: m.text, images: m.images.map(i => [i.mediaType, atob(i.data.slice(0, 32)).slice(1, 4)]) })))`);
check('Enter sends the text and the image as base64', sent === JSON.stringify([{ text: 'With a panorama', images: [['image/png', 'PNG']] }]), sent);
check('the box is empty after sending', await ev(`document.querySelectorAll('.composer .attach .thumb').length === 0 && attachments.length === 0`));
check('no CSP violation', (await ev(`__csp.length`)) === 0, JSON.stringify(await ev(`__csp`)));
await c.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });
c.print();
c.close();
