// The file preview (R5.9) on a generated session whose Files changed point at a real repo file, a binary
// and an HTML file, never committed. The backend runs with --dry-open, so `open` only logs its branch.
// usage: node preview.mjs make <claude-dir>   writes the session and the files (run.sh does this first)
//        node preview.mjs <url> <state-dir> <claude-dir>
// Checks: the overlay, bat's colours, aligned line numbers, the diff's first changed line, j/k/g/G, find
// with / and Cmd+F, n and Enter, Esc first, a click outside, the modes and keys after it, Open in app,
// a binary and an HTML file falling back to `open`, and Alt-click on HTML showing its source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SID = 'f0f0f0f0-0000-4000-8000-0000000000f0';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = path.join(REPO, 'app/backend/src/open.ts');
const line = (o) => JSON.stringify(o) + '\n';
const ts = (i) => new Date(Date.UTC(2026, 10, 24, 9, 0, i)).toISOString();
const extra = (dir) => ({ bin: path.join(dir, 'files', 'blob'), html: path.join(dir, 'files', 'report.html') });

if (process.argv[2] === 'make') {
  const dir = process.argv[3], proj = path.join(dir, 'projects', '-tmp-synopia-preview');
  const { bin, html } = extra(dir);
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2]));
  fs.writeFileSync(html, '<!doctype html>\n<p class="x">Report &amp; notes</p>\n');
  const base = (i) => ({ uuid: `p${i}`, timestamp: ts(i), cwd: REPO, sessionId: SID });
  const edit = (id, file, patch) => [
    { ...base(id), type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } },
    { ...base(id + 1), type: 'user', toolUseResult: { filePath: file, structuredPatch: patch }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: 'ok' }] } },
  ];
  const recs = [
    { ...base(0), type: 'user', message: { role: 'user', content: 'Tidy the open allow-list.' } },
    ...edit(10, SRC, [{ oldStart: 24, oldLines: 3, newStart: 24, newLines: 3, lines: [' export type OpenRequest = { path?: unknown; url?: unknown };', '-export type OpenPlan =', '+export type OpenPlan =', ' '] }]),
    ...edit(20, bin, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }]),
    ...edit(30, html, [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-<p>', '+<p class="x">Report &amp; notes</p>'] }]),
    { ...base(40), type: 'assistant', message: { id: 'msg_40', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), recs.map(line).join(''));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir, claudeDir] = process.argv.slice(2);
const { bin, html } = extra(claudeDir);
const c = await connect();
const { ev, check, key } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.cdp('Page.navigate', { url: url + `#${SID.slice(0, 8)}` });
await sleep(1000); await key('Shift', { vk: 16 }); // headless Chrome drops the first key after a load
await sleep(1500);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const until = async (expr, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
const logText = () => fs.readFileSync(path.join(stateDir, 'backend.log'), 'utf8');
const K = {
  j: () => key('j', { code: 'KeyJ', vk: 74 }), k: () => key('k', { code: 'KeyK', vk: 75 }),
  g: () => key('g', { code: 'KeyG', vk: 71 }), G: () => key('G', { shift: true, code: 'KeyG', vk: 71 }),
  n: () => key('n', { code: 'KeyN', vk: 78 }), J: () => key('J', { shift: true, code: 'KeyJ', vk: 74 }),
  slash: () => key('/', { code: 'Slash', vk: 191 }), esc: () => key('Escape', { code: 'Escape', vk: 27 }),
  enter: () => key('Enter', { code: 'Enter', vk: 13 }), cmdF: () => key('f', { meta: true, code: 'KeyF', vk: 70 }),
  i: () => key('i', { code: 'KeyI', vk: 73 }),
};
const type = async (s) => { for (const ch of s) await c.cdp('Input.insertText', { text: ch }); };
const shown = () => ev(`previewShown()`);
const row = (p) => `[...document.querySelectorAll('.frow .fp')].find(a => a.dataset.path === ${JSON.stringify(p)})`;
const clickAt = async (sel, opts = {}) => {
  const r = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(20, b.width / 2), y: b.top + b.height / 2 }; })()`);
  const mod = opts.alt ? 1 : 0;
  await c.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1, modifiers: mod });
  await c.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1, modifiers: mod });
};

check('the session shows its files changed', await until(`document.querySelectorAll('.frow .fp').length === 3`), await ev(`document.querySelectorAll('.frow .fp').length`));
await clickAt(row(SRC));
check('a source file opens the preview', await until(`previewShown()`));
check('it asked for a preview, not open', await ev(`__sent.some(m => m.t === 'preview') && !__sent.some(m => m.t === 'open')`));
const meta = await ev(`document.getElementById('pv-meta').textContent`);
check('header: path, language and line count', (await ev(`document.getElementById('pv-path').textContent`)).endsWith('app/backend/src/open.ts') && /^TypeScript, \d+ lines, read-only$/.test(meta), meta);
const lines = fs.readFileSync(SRC, 'utf8').split('\n').length - 1;
check('one row per line', (await ev(`document.querySelectorAll('#pv-lines .pl').length`)) === lines, String(lines));
const colours = await ev(`[...new Set([...document.querySelectorAll('#pv-lines .tx span')].map(s => getComputedStyle(s).color))]`);
check('highlighted with several GitHub colours', Array.isArray(colours) && colours.length >= 4 && colours.includes('rgb(167, 29, 93)'), JSON.stringify(colours));
check('mono 12px, no wrap', await ev(`(() => { const s = getComputedStyle(document.querySelector('#pv-lines .tx')); return s.fontSize === '12px' && /JetBrains/.test(s.fontFamily) && getComputedStyle(document.querySelector('#pv-lines .pl')).whiteSpace === 'pre'; })()`));
check('line numbers aligned: one gutter width, right-aligned', await ev(`(() => { const n = [...document.querySelectorAll('#pv-lines .no')]; const w = new Set(n.map(x => Math.round(x.getBoundingClientRect().right))); return w.size === 1 && getComputedStyle(n[0]).textAlign === 'right'; })()`));
check('a long line scrolls sideways', await ev(`(() => { const c = document.getElementById('pv-code'); return c.scrollWidth > c.clientWidth; })()`));
check('opens at the top, changes marked in the gutter only', await ev(`document.getElementById('pv-code').scrollTop === 0 && !!document.querySelector('#pv-lines .pl.chg, #pv-lines .pl.cut') && getComputedStyle(document.querySelector('#pv-lines .pl.chg, #pv-lines .pl.cut')).backgroundColor === 'rgba(0, 0, 0, 0)'`));
check('escaped: no element but spans in the code', await ev(`document.querySelectorAll('#pv-lines .tx *:not(span)').length === 0`));
await c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, 'preview-open.png'), Buffer.from(r.result.data, 'base64')));

const top = () => ev(`document.getElementById('pv-code').scrollTop`);
await K.g(); await sleep(50);
check('g: top', (await top()) === 0);
await K.j(); await sleep(50); const t1 = await top();
check('j: one line down', t1 > 10 && t1 < 25, String(t1));
await K.k(); await sleep(50);
check('k: one line up', (await top()) === 0);
await K.G(); await sleep(50);
check('G: bottom', await ev(`(() => { const c = document.getElementById('pv-code'); return c.scrollHeight - c.clientHeight - c.scrollTop < 2; })()`));
check('keys stay in the preview: mode normal, same session', (await ev('document.body.dataset.mode')) === 'normal');
const before = await ev('current');
await K.J(); await sleep(100);
check('J does not switch sessions under it', (await ev('current')) === before && (await shown()));

await K.g(); await K.slash();
check('/ opens the find box', await ev(`!document.getElementById('pv-find').hidden && document.activeElement.id === 'pv-q'`));
await type('execFile');
await sleep(100);
const cnt = await ev(`document.getElementById('pv-count').textContent`);
check('find counts the matches', /^1 of [3-9]$/.test(cnt), cnt);
check('matches are highlighted', await ev(`CSS.highlights.get('pv-find')?.size >= 3 && CSS.highlights.get('pv-cur')?.size === 1`));
await K.enter(); await sleep(50);
check('Enter: next match', (await ev(`document.getElementById('pv-count').textContent`)).startsWith('2 of'));
await K.esc();
check('Esc in the find box closes the box only', (await shown()) && (await ev(`document.getElementById('pv-find').hidden`)));
await K.n(); await sleep(50);
check('n: next match', (await ev(`document.getElementById('pv-count').textContent`)).startsWith('3 of'));
await K.cmdF();
check('Cmd+F opens the find box', await ev(`!document.getElementById('pv-find').hidden && document.activeElement.id === 'pv-q'`));
await c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, 'preview-find.png'), Buffer.from(r.result.data, 'base64')));
await K.esc(); await K.esc();
check('Esc closes the preview', !(await shown()));
check('Esc did not reach the composer or other keys', (await ev('document.body.dataset.mode')) === 'normal' && (await ev('current')) === before);
await K.i();
check('keys work again after it: i enters insert', (await ev('document.body.dataset.mode')) === 'insert');
await K.esc();

// a click outside closes it; Open in app sends `open`
await clickAt(row(SRC)); await until(`previewShown()`);
await ev(`__sent.length = 0`);
await ev(`document.getElementById('pv-open').click()`);
check('Open in app sends open', await ev(`__sent.some(m => m.t === 'open' && m.path === ${JSON.stringify(SRC)})`));
await c.mouse('mousePressed', 140, 400); await c.mouse('mouseReleased', 140, 400);
check('a click outside closes it', !(await shown()));

// a binary falls back to `open` (revealed, with the dry run); HTML opens in the browser, Alt-click shows its source
await ev(`__sent.length = 0`);
const logLen = logText().length;
await clickAt(row(bin)); await sleep(600);
check('a binary: no preview, the backend opens it', !(await shown()) && / preview\.open/.test(logText().slice(logLen)) && / open how=reveal dry=true/.test(logText().slice(logLen)));
await clickAt(row(html)); await sleep(400);
check('HTML: sent as open, no preview', !(await shown()) && (await ev(`__sent.some(m => m.t === 'open' && m.path === ${JSON.stringify(html)})`)) && !(await ev(`__sent.some(m => m.t === 'preview' && m.path === ${JSON.stringify(html)})`)));
await clickAt(row(html), { alt: true });
check('HTML with Alt: its source in the preview', await until(`previewShown() && /^HTML, 2 lines/.test(document.getElementById('pv-meta').textContent)`));
check('HTML source is shown as text', (await ev(`document.querySelector('#pv-lines .pl:nth-child(2) .tx').textContent`)) === '<p class="x">Report &amp; notes</p>');
await K.esc();
c.print();
c.close();
