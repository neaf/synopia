// The background panel's tree (R7.1) on the rail fixture: Main conversation with its running children, a
// subagent's own shells and monitors one level deeper, guides on every mark, the corner on each last child,
// the guide past an expanded Stop row, Past naming the subagent, and none of them on the main side.
// usage: run.sh rail (or node rail.mjs <url> <state-dir>); writes rail-tree.png and rail-open.png
import { writeFileSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';
const [url, state] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.cdp('Page.navigate', { url });
await sleep(2500);
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
// expand the subagent to its Stop row: its children's guide runs past the row, all still aligned
await ev(`document.querySelector('.rail .card[data-agent="bbbb0001"]').click()`);
await sleep(400);
check('the subagent card shows its Stop row', await ev(`!!document.querySelector('.kid.parent > .bw-detail .bw-stop')`));
const gap = await ev(`(() => { const d = document.querySelector('.kid.parent > .bw-detail'), r = d.getBoundingClientRect(), s = getComputedStyle(d, '::before');
  const card = d.previousElementSibling.getBoundingClientRect(), next = d.nextElementSibling.querySelector('.kid > .tg').getBoundingClientRect();
  return { top: Math.abs(r.y + parseFloat(s.top) - card.bottom), bottom: Math.abs(r.bottom - parseFloat(s.bottom) - next.y), x: r.x + parseFloat(s.left) }; })()`);
t = await tree();
check('the guide runs from the subagent card past its Stop row to its first child', gap.top < 1 && gap.bottom < 1, JSON.stringify(gap));
check('with the Stop row open, ticks and guides stay aligned', t.length === 4 && t.every((x) => x.tick < 1 && x.x < 1 && x.corner), JSON.stringify(t));
await shot('rail-open');
// Past names the subagent; nothing of the subagent's on the main side
const past = await ev(`[...document.querySelectorAll('.rail .pr .n')].map(n => n.textContent)`);
check('Past names the subagent of its shells', past.includes('Optimise the images failed in Build image thumbnails') && past.includes('List old images in Check the old images') && past.includes('Copy the icons in Build image thumbnails'), JSON.stringify(past));
await ev(`document.querySelector('[data-back-main]').click()`);
await sleep(300);
check("the sidebar counts only the main thread's shells", (await ev(`document.querySelector('#groups .row[data-id^="66666666"] [data-line="bg"]')?.textContent.trim()`)) === '1 shell or monitor running');
check("the main transcript doesn't show them", await ev(`!/Resize the images|Watch the resize log|Optimise the images/.test(document.getElementById('log').textContent)`));
c.print();
c.close();
process.exit(0);
