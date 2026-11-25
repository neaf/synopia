// The background panel's tree (R7.1) on the rail fixture: Main conversation with its running children, a
// subagent's own shells and monitors one level deeper, guides on every mark, the corner on each last child,
// opening a subagent moving nothing, Past naming the subagent, and none of them on the main side. Then a shell
// or monitor opened in the pane as a subagent is (R7.2): its header, its whole output, live, earlier output,
// J/K, back to Main conversation, kept over a reload.
// usage: run.sh rail (or node rail.mjs <url> <state-dir>); writes rail-tree.png, rail-open.png, rail-shell-*.png
//        node rail.mjs make <claude-dir> <tasks-dir>: the shells' made-up output files, named in the copied transcripts
import fs from 'node:fs';
import path from 'node:path';
import { shot as shotTo } from './helpers.mjs';
import { connect, sleep } from './cdp.mjs';
if (process.argv[2] === 'make') {
  const [claude, tasks] = process.argv.slice(3);
  fs.mkdirSync(tasks, { recursive: true });
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []);
  for (const f of files(claude)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('@TASKS@', tasks));
  // a dev server, with the colours and the box a terminal shows; an optimiser that runs out of memory; a long copy
  fs.writeFileSync(path.join(tasks, 'bmain1.output'), '\x1b[32m   ┌─────────────────────────────────────┐\n   │   Serving!                          │\n   │   - Local:    http://localhost:3000 │\n   └─────────────────────────────────────┘\x1b[0m\n\n \x1b[1mHTTP\x1b[0m  13:00:12 ::1 GET / 200\n');
  fs.writeFileSync(path.join(tasks, 'bsub1.output'), 'resizing 48 images\n');
  fs.writeFileSync(path.join(tasks, 'bsub2.output'), '> demo@1.0.0 optimise\n> node scripts/optimise.mjs\n\nOptimising 48 images\n  hero.png      1.2 MB -> 380 KB\n  team.jpg      860 KB -> 240 KB\n  progress 12/48\r  progress 30/48\r  progress 31/48\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
  fs.writeFileSync(path.join(tasks, 'bsub3.output'), Array.from({ length: 6000 }, (_, i) => `copied icons/icon-${String(i + 1).padStart(4, '0')}.svg -> out/icon-${String(i + 1).padStart(4, '0')}.svg\n`).join(''));
  process.exit(0);
}
const [url, state] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(url);
await ev(`document.querySelector('#groups .row[data-id^="66666666"]').click()`);
await sleep(500);
const shot = (name) => shotTo(c, `${state}/${name}.png`);
// every child: its tick (or corner) at its mark's height and its guide under its parent's mark
const tree = () => ev(`(() => {
  const mid = r => r.y + r.height / 2, box = e => e.getBoundingClientRect();
  const out = [];
  const walk = (kids, parentMark, depth) => [...kids.children].forEach(k => {
    const tg = k.querySelector(':scope > .tg'), card = k.querySelector(':scope > .card'), mark = box(card.querySelector(':scope > .ind'));
    const last = !k.nextElementSibling, b = getComputedStyle(tg, '::before'), a = getComputedStyle(tg, '::after'), t = box(tg);
    const tickY = t.y + (last ? parseFloat(b.height) - .5 : parseFloat(a.top) + .5);
    out.push({ name: card.querySelector('.n').textContent, depth, last, tick: Math.abs(tickY - mid(mark)), x: Math.abs(t.x + .5 - (parentMark.x + parentMark.width / 2)),
      reach: Math.abs(t.x + 11 - box(card).x), corner: last ? b.borderBottomStyle === 'solid' && a.content === 'none' : a.borderTopStyle === 'solid', top: t.y });
    const sub = k.querySelector(':scope > .kids'); if (sub) walk(sub, mark, depth + 1);
  });
  const k0 = document.querySelector('.rail .now > .kids');
  if (k0) walk(k0, box(document.querySelector('.main-row > .ind')), 1);
  return out;
})()`);
let t = await tree();
check('Main conversation has two children: the subagent, then the main thread shell', JSON.stringify(t.filter((x) => x.depth === 1).map((x) => x.name)) === '["Build image thumbnails","Serve the demo"]', JSON.stringify(t));
check("the subagent's shell and monitor hang under it", JSON.stringify(t.filter((x) => x.depth === 2).map((x) => x.name)) === '["Resize the images","Watch the resize log"]', JSON.stringify(t));
check('every tick sits at its mark (within 1 px)', t.length === 4 && t.every((x) => x.tick < 1), JSON.stringify(t));
check("every guide runs under its parent's mark and its tick meets the card", t.every((x) => x.x < 1 && x.reach < 1), JSON.stringify(t));
check('the last child of each level ends in a corner, the others in a tick', t.every((x) => x.corner), JSON.stringify(t));
check('the main card counts its direct children', (await ev(`document.querySelector('.main-row .m').textContent`)) === '2 running in the background');
await shot('rail-tree');
// a click on the subagent card opens its transcript and expands nothing: the panel doesn't move
const before = await tree();
await ev(`document.querySelector('.rail .card[data-agent="bbbb0001"]').click()`);
await sleep(400);
check('a subagent card has no Stop row and no expansion', await ev(`!document.querySelector('.bw-stop') && !document.querySelector('.rail .bw-detail, .rail [aria-expanded]')`));
t = await tree();
check('opening a subagent moves nothing in the tree (within 1 px)', t.length === before.length && t.every((x, i) => x.name === before[i].name && Math.abs(x.top - before[i].top) < 1), JSON.stringify([before.map(x => x.top), t.map(x => x.top)]));
await shot('rail-open');
// Past names the subagent; nothing of the subagent's on the main side
const past = await ev(`[...document.querySelectorAll('.rail .pr .n')].map(n => n.textContent)`);
check('Past names the subagent of its shells', past.includes('Optimise the images failed in Build image thumbnails') && past.includes('List old images in Check the old images') && past.includes('Copy the icons in Build image thumbnails'), JSON.stringify(past));
// the item you're viewing, of every kind: exactly one visible edge (no border plus ring), the same ink edge on each,
// over every state tint of the main card, and selecting moves and resizes nothing
const sel = (q, state) => ev(`(() => {
  document.querySelector(${JSON.stringify(q)}).click();
  return new Promise(r => setTimeout(() => {
    document.activeElement?.blur();
    const cur = [...document.querySelectorAll('.rail [aria-current="true"]')], e = cur[0];
    if (${JSON.stringify(state || '')}) e.dataset.state = ${JSON.stringify(state || '')};
    const seen = c => c && c !== 'none' && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c);
    const edges = [];
    for (const [s, pe] of [[getComputedStyle(e), ''], [getComputedStyle(e, '::before'), 'before'], [getComputedStyle(e, '::after'), 'after']]) {
      if (pe && s.content === 'none') continue;
      if (['Top', 'Right', 'Bottom', 'Left'].some(d => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none' && seen(s['border' + d + 'Color']))) edges.push((pe || 'self') + ' border ' + s.borderTopColor + ' ' + s.borderTopWidth);
      if (s.boxShadow !== 'none') edges.push((pe || 'self') + ' shadow ' + s.boxShadow);
      if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) edges.push((pe || 'self') + ' outline');
    }
    const geo = [...document.querySelectorAll('.rail .main-row, .rail .card, .rail .pr, .rail .ind, .rail .tg')].map(x => (b => [b.x, b.y, b.width, b.height].map(v => +v.toFixed(2)))(x.getBoundingClientRect()));
    r(JSON.stringify({ n: cur.length, edges, geo }));
  }, 350));
})()`).then(JSON.parse);
const items = [['main, working', '[data-back-main]'], ['main, needs you', '[data-back-main]', 'red'], ['main, idle', '[data-back-main]', 'amber'],
  ['running subagent', '.rail .card[data-agent="bbbb0001"]'], ['Past subagent', '.rail .pr[data-agent="bbbb0002"]']];
const seenSel = [];
for (const [label, q, state] of items) seenSel.push({ label, ...(await sel(q, state)) });
const edgeOf = (x) => x.edges[0]?.replace(/^\w+ /, '');
check('every selected item has exactly one visible edge, no border plus ring', seenSel.every((x) => x.n === 1 && x.edges.length === 1), JSON.stringify(seenSel.map((x) => [x.label, x.n, x.edges])));
check('the selected edge is the same 1px ink line on every kind and state', seenSel.every((x) => edgeOf(x) === (process.env.SYNOPIA_CDP_THEME === 'dark' ? 'border rgb(230, 237, 243) 1px' : 'border rgb(31, 35, 40) 1px')), JSON.stringify(seenSel.map((x) => [x.label, x.edges])));
const g0 = seenSel[0].geo, moved = seenSel.filter((x) => x.geo.length !== g0.length || x.geo.some((b, i) => b.some((v, j) => Math.abs(v - g0[i][j]) > 0.5)));
check('selecting changes no geometry: every card, row, mark and guide keeps its place and size', moved.length === 0, JSON.stringify(moved.map((x) => x.label)));
// the session header has one shape in every view: the same height and line tops, the text on the same baselines
const head = () => ev(`(() => {
  const h = document.querySelector('.c-head'), top = h.getBoundingClientRect().top, r = (e) => e.getBoundingClientRect();
  const lines = [...h.querySelectorAll(':scope > .c-title, :scope > .c-now, :scope > .c-meta')];
  // a text line's baseline: the bottom of a zero-height inline-block sitting on it
  const base = (p) => { const s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0'; p.prepend(s); const y = r(s).bottom - top; s.remove(); return y; };
  return JSON.stringify({ h: r(h).height, tops: lines.map((l) => r(l).top - top), hs: lines.map((l) => r(l).height), bases: lines.map(base),
    acts: [...h.querySelectorAll('.c-acts .btn')].map((b) => r(b).top - top) });
})()`).then(JSON.parse);
await ev(`document.querySelector('.rail .card[data-agent="bbbb0001"]').click()`);
await sleep(300);
const hSub = await head();
await ev(`document.querySelector('[data-back-main]').click()`);
await sleep(300);
const hMain = await head();
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.5);
check('the header has the same height and line tops in the main and the subagent view (within 0.5 px)',
  Math.abs(hMain.h - hSub.h) <= 0.5 && near(hMain.tops, hSub.tops) && near(hMain.hs, hSub.hs) && near(hMain.bases, hSub.bases) && near(hMain.acts, hSub.acts), JSON.stringify({ hMain, hSub }));
check("the main conversation's header has the model button only", (await ev(`[...document.querySelectorAll('.c-head .c-acts button')].map((b) => b.id).join()`)) === 'model-label');
check("the sidebar counts only the main thread's shells", (await ev(`document.querySelector('#groups .row[data-id^="66666666"] [data-line="bg"]')?.textContent.trim()`)) === '1 shell or monitor running');
check("the main transcript doesn't show them", await ev(`!/Resize the images|Watch the resize log|Optimise the images/.test(document.getElementById('log').textContent)`));
// ---------- R7.2: a shell or monitor opens in the pane, as a subagent does ----------
const tasks = path.join(state, 'tasks');
const open = async (q) => { await ev(`document.querySelector(${JSON.stringify(q)}).click()`); await sleep(400); };
const logText = () => ev(`document.querySelector('#log .bg-run')?.textContent || ''`);
const view = () => ev(`(() => { const h = document.querySelector('.c-head'), t = (q) => h.querySelector(q)?.textContent || '';
  return { view: __synopia.view(), title: t('.c-title'), now: t('.c-now'), meta: t('.c-meta'), cur: [...document.querySelectorAll('.rail [aria-current="true"]')].map((e) => e.dataset.bg || e.dataset.agent || 'main'),
    expanded: !!document.querySelector('.rail .bw-detail, .rail [aria-expanded]'), cmd: document.querySelector('#log .bg-run .cmd')?.textContent || '', out: document.querySelector('#log .bg-run .out')?.textContent || '',
    live: !!document.querySelector('#log .liveln'), moving: (document.querySelector('#log .liveln .g')?.getAnimations({ subtree: true }) || []).filter((a) => a.playState === 'running').length,
    end: document.querySelector('#log .bg-end')?.textContent || '', earlier: document.querySelector('#log [data-earlier]')?.textContent || '' }; })()`);
await open('.rail .card[data-bg="toolu_rsh"]');
await c.until(`(document.querySelector('#log .bg-run .out')?.textContent || '').includes('Serving!')`, 5000);
let v = await view();
check('a shell row opens its view in the pane, not in the panel: it alone is selected, nothing expands', v.view === 'toolu_rsh' && JSON.stringify(v.cur) === '["toolu_rsh"]' && !v.expanded, JSON.stringify(v));
check('its header names it, says it runs and whose it is', v.title === 'Serve the demo' && /^Running, \d+.*\. Background shell, started /.test(v.now) && /^Claude hears when it ends\. Shell in ‹ /.test(v.meta), JSON.stringify(v));
check('its log is the command, then the whole output as plain text (no escape sequences), then the moving running mark',
  v.cmd === 'npx serve demo' && v.out.startsWith('   ┌') && v.out.includes('- Local:    http://localhost:3000') && v.out.includes('HTTP  13:00:12') && !/\x1b|\[0m|\[32m/.test(v.out) && v.live && v.moving > 0 && !v.end, JSON.stringify(v));
check('its log is monospace', await ev(`getComputedStyle(document.querySelector('#log .bg-run .out')).fontFamily.includes('JetBrains Mono')`));
const hShell = await head();
check('the header has the same height and line tops as the main and the subagent view (within 0.5 px)',
  Math.abs(hShell.h - hSub.h) <= 0.5 && near(hShell.tops, hSub.tops) && near(hShell.hs, hSub.hs) && near(hShell.bases, hSub.bases) && near(hShell.acts, hSub.acts), JSON.stringify({ hShell, hSub }));
fs.appendFileSync(path.join(tasks, 'bmain1.output'), ' \x1b[1mHTTP\x1b[0m  13:05:00 ::1 GET /thumbs 200\n');
check('while it runs, what it prints appends live', await c.until(`(document.querySelector('#log .bg-run .out')?.textContent || '').includes('GET /thumbs 200')`, 5000));
await shot('rail-shell-running');
// a monitor of a subagent: its events
await open('.rail .card[data-bg="toolu_bmon1"]');
v = await view();
check("a subagent's monitor opens with its events and names the subagent", v.view === 'toolu_bmon1' && v.title === 'Watch the resize log' && /^Claude hears each event\. Monitor of the subagent Build image thumbnails in ‹ /.test(v.meta)
  && v.out === 'resized 12 of 48: hero.png, team.jpg\nresized 30 of 48\nskipped logo.svg (vector)' && v.live, JSON.stringify(v));
// a finished shell from Past: its output, a carriage-returned line as it ended, how it ended
await open('.rail .pr[data-bg="toolu_bsh2"]');
v = await view();
check('a failed shell from Past: its whole output, then how it ended, with no live line', v.view === 'toolu_bsh2' && /^Failed, /.test(v.now) && v.out.includes('heap out of memory') && v.out.includes('  progress 31/48\n') && !v.out.includes('progress 12/48')
  && /^Failed after .*Optimiser ran out of memory$/.test(v.end) && !v.live && JSON.stringify(v.cur) === '["toolu_bsh2"]', JSON.stringify(v));
await shot('rail-shell-finished');
// a long output: the last part, earlier output on asking, the place kept, down to the first line
await open('.rail .pr[data-bg="toolu_bsh3"]');
v = await view();
const lines0 = v.out.split('\n').filter(Boolean);
check('a long output shows its last part with a link to earlier output', /^Show earlier output$/.test(v.earlier) && lines0.length < 6000 && lines0.at(-1) === 'copied icons/icon-6000.svg -> out/icon-6000.svg' && /^copied /.test(lines0[0]), JSON.stringify({ earlier: v.earlier, n: lines0.length, first: lines0[0] }));
const markLine = lines0[0];
const placeOf = (t) => ev(`(() => { const log = document.getElementById('log'), out = document.querySelector('#log .bg-run .out'), r = document.createRange(), i = out.textContent.indexOf(${JSON.stringify(t)});
  const node = out.firstChild; r.setStart(node, i); r.setEnd(node, i + 1); return r.getBoundingClientRect().top - log.getBoundingClientRect().top; })()`);
await ev(`document.getElementById('log').scrollTop = 0`); await sleep(100);
const placeBefore = await placeOf(markLine);
await ev(`document.querySelector('#log [data-earlier]').click()`);
await c.until(`!(document.querySelector('#log .bg-run .out')?.textContent || '').startsWith(${JSON.stringify(markLine)})`, 5000);
check('loading earlier output keeps what you read in place (within 1 px)', Math.abs((await placeOf(markLine)) - placeBefore) < 1, JSON.stringify([placeBefore, await placeOf(markLine)]));
for (let i = 0; i < 4 && (await view()).earlier; i++) { await ev(`document.querySelector('#log [data-earlier]').click()`); await sleep(400); }
v = await view();
const all = v.out.split('\n').filter(Boolean);
check('earlier output loads down to the first line, each line once', !v.earlier && all.length === 6000 && all[0] === 'copied icons/icon-0001.svg -> out/icon-0001.svg' && new Set(all).size === 6000, JSON.stringify({ n: all.length, first: all[0], earlier: v.earlier }));
// ---------- R5.12: only Main conversation has the message box ----------
await ev(`document.querySelector('[data-back-main]').click()`); await sleep(300);
await ev(`(() => { const t = document.getElementById('msg'); t.value = 'a main draft'; t.dispatchEvent(new Event('input')); })()`);
const noBox = () => ev(`!document.getElementById('msg') && !document.querySelector('.dock textarea, .dock .slash') && getComputedStyle(document.querySelector('.dock')).display === 'none'
  && !document.querySelector('.qpin') && Math.abs(document.getElementById('log').getBoundingClientRect().bottom - (document.querySelector('.thread').getBoundingClientRect().bottom - 1)) < 0.5`);
const typeKeys = async () => { await c.key('i', { code: 'KeyI', vk: 73 }); await sleep(100); await c.key('/', { code: 'Slash', vk: 191 }); await sleep(100); await c.key('a', { code: 'KeyA', vk: 65 }); await sleep(150); };
for (const [label, q] of [['a subagent view', '.rail .card[data-agent="bbbb0001"]'], ['a shell view', '.rail .card[data-bg="toolu_rsh"]']]) {
  await open(q);
  check(`${label} has no message box, no line: the one panel ends with the log`, await noBox());
  if (process.env.SYNOPIA_SHOTS) { fs.mkdirSync(process.env.SYNOPIA_SHOTS, { recursive: true }); await shotTo(c, path.join(process.env.SYNOPIA_SHOTS, `${label.split(' ')[1]}-${process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light'}.png`)); }
  await typeKeys();
  check(`i, / and a do nothing in ${label}: normal mode, still no box`, (await ev('__synopia.mode()')) === 'normal' && await noBox() && !(await ev('document.getElementById("slash")')));
}
await c.key('Escape', { code: 'Escape', vk: 27 }); await sleep(200);
const asked = await ev(`!!document.querySelector('.dock .composer.asking .int-ask') && getComputedStyle(document.querySelector('.dock')).display !== 'none'`);
await c.key('q', { code: 'KeyQ', vk: 81 }); await sleep(200);
check('Esc still asks to interrupt the session, on the dock line, and another key takes it away', asked && await noBox());
const lastRow = await ev(`[...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map((e) => e.dataset.agent || e.dataset.bg).at(-1)`);
await open(`.rail [data-agent="${lastRow}"], .rail [data-bg="${lastRow}"]`);
await c.key('J', { shift: true, code: 'KeyJ', vk: 74 }); await sleep(300);
check('J from the last row is Main conversation, with the box and its draft', (await ev('__synopia.view()')) === null && (await ev(`document.getElementById('msg')?.value`)) === 'a main draft' && (await ev('__synopia.mode()')) === 'normal');
// J/K: Main conversation, then the panel's rows top to bottom, shells and monitors included
const rows = await ev(`[...new Set([...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map((e) => e.dataset.agent || e.dataset.bg))]`);
const seen = [];
for (let i = 0; i <= rows.length; i++) { await c.key('J', { shift: true, code: 'KeyJ', vk: 74 }); await sleep(200); seen.push(await ev('__synopia.view()')); }
check('J steps through Main conversation and every row, shells and monitors included, then wraps', JSON.stringify(seen) === JSON.stringify([...rows, null]) && rows.includes('toolu_rsh') && rows.includes('toolu_bmon1'), JSON.stringify([rows, seen]));
// back to Main conversation from a shell view, by the header's link
await open('.rail .card[data-bg="toolu_rsh"]');
await ev(`document.querySelector('.c-head [data-back]').click()`); await sleep(300);
v = await view();
check("the header's back link shows the main conversation again", v.view === null && JSON.stringify(v.cur) === '["main"]' && !(await logText()), JSON.stringify(v));
// restore (R3.9): the shown shell view comes back after a reload
await open('.rail .card[data-bg="toolu_rsh"]');
await sleep(800); // the UI state's patch goes
check('the page reloads', await c.load(url));
await c.until(`(document.querySelector('#log .bg-run .out')?.textContent || '').includes('GET /thumbs 200')`, 5000);
v = await view();
check('after a reload the shell view is back, with its output and no box', v.view === 'toolu_rsh' && v.title === 'Serve the demo' && JSON.stringify(v.cur) === '["toolu_rsh"]' && await noBox(), JSON.stringify(v));
await ev(`document.querySelector('[data-back-main]').click()`); await sleep(300);
check("Main conversation's draft is back after the reload", (await ev(`document.getElementById('msg')?.value`)) === 'a main draft');
c.print();
c.close();
