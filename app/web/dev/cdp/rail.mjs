// The background panel's tree (R7.1) on the rail fixture: Main conversation with its running children, a
// subagent's own shells and monitors one level deeper, guides on every mark, the corner on each last child,
// opening a subagent moving nothing, Past naming the subagent, and none of them on the main side.
// usage: run.sh rail (or node rail.mjs <url> <state-dir>); writes rail-tree.png and rail-open.png
import { writeFileSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';
const [url, state] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(url);
await ev(`document.querySelector('#groups .row[data-id^="66666666"]').click()`);
await sleep(500);
const shot = async (name) => writeFileSync(`${state}/${name}.png`, Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
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
check('a subagent card has no Stop row and no expansion', await ev(`!document.querySelector('.bw-stop') && !document.querySelector('.kid.parent > .bw-detail')`));
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
check('the selected edge is the same 1px ink line on every kind and state', seenSel.every((x) => edgeOf(x) === 'border rgb(31, 35, 40) 1px'), JSON.stringify(seenSel.map((x) => [x.label, x.edges])));
const g0 = seenSel[0].geo, moved = seenSel.filter((x) => x.geo.length !== g0.length || x.geo.some((b, i) => b.some((v, j) => Math.abs(v - g0[i][j]) > 0.5)));
check('selecting changes no geometry: every card, row, mark and guide keeps its place and size', moved.length === 0, JSON.stringify(moved.map((x) => x.label)));
await ev(`document.querySelector('[data-back-main]').click()`);
await sleep(300);
check("the sidebar counts only the main thread's shells", (await ev(`document.querySelector('#groups .row[data-id^="66666666"] [data-line="bg"]')?.textContent.trim()`)) === '1 shell or monitor running');
check("the main transcript doesn't show them", await ev(`!/Resize the images|Watch the resize log|Optimise the images/.test(document.getElementById('log').textContent)`));
c.print();
c.close();
process.exit(0);
