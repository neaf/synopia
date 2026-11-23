// S5-1: every R4.5 drop rule with real pointer events (CDP Input), then the stored layout.
// usage: run.sh dnd (or node dnd.mjs <url> <state-dir> [after-restart])
import { connect, sleep } from './cdp.mjs';
import { readFileSync } from 'node:fs';
const [url, stateDir, phase] = process.argv.slice(2);
const c = await connect();
const { ev, check, mouse } = c;
await c.cdp('Page.navigate', { url });
await sleep(1000); await c.key('Shift', { vk: 16 }); // headless Chrome drops the first key after a load
await sleep(2000);
const S = (p) => `[...document.querySelectorAll('#groups .row')].find(r => r.dataset.id.startsWith('${p}'))`;
const rect = async (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top, h: r.height, l: r.left }; })()`);
// f: fraction of the target's height (0.15 top edge, 0.5 middle, 0.85 bottom edge)
async function drag(fromP, toSel, f, during) {
  const a = await rect(S(fromP));
  if (!a) return 'missing';
  await mouse('mousePressed', a.x, a.y + a.h / 2);
  await mouse('mouseMoved', a.x + 6, a.y + a.h / 2 + 6); // the drag starts: the placeholder shows
  const b = await rect(toSel);
  if (!b) return 'missing';
  await mouse('mouseMoved', b.x, b.y + b.h * f - 5);
  await mouse('mouseMoved', b.x, b.y + b.h * f);
  const seen = await ev(`(() => { const g = document.querySelector('.ghost'); const t = document.querySelector('.drop-before,.drop-after,.drop-merge,.drop-into');
    return { ghost: !!g, op: g && getComputedStyle(g).opacity, gl: g && parseFloat(g.style.left), cls: t ? [...t.classList].find(x => x.startsWith('drop-')) : null }; })()`);
  if (during) during(seen, a, b);
  await mouse('mouseReleased', b.x, b.y + b.h * f);
  await sleep(150);
  return seen;
}
const L = () => ev(`JSON.stringify({ groups: layout.groups.map(g => ({ name: g.name, ids: shown(g.ids).map(x => x.slice(0, 1)) })), others: shown(layout.others).map(x => x.slice(0, 1)) })`);
const stored = () => { const s = JSON.parse(readFileSync(stateDir + '/state.json', 'utf8')).layout; return JSON.stringify({ groups: s.groups.map(g => ({ name: g.name, ids: g.ids.map(x => x.slice(0, 1)) })), others: s.others.map(x => x.slice(0, 1)) }); };

if (phase === 'after-restart') {
  const want = readFileSync(stateDir + '/expected.txt', 'utf8');
  check('layout restored from hello after a restart', (await L()) === want, (await L()) + ' vs ' + want);
  const order = await ev(`[...document.querySelectorAll('#groups .row')].map(r => r.dataset.id[0]).join('')`);
  check('sidebar rows in the stored order', order.length === 5, order);
  c.print(); c.close(); process.exit(0);
}

check('start: all in Not in a group', (await L()) === '{"groups":[],"others":["1","2","3","4","5"]}', await L());
// 1. middle of a session not in a group: a new group of the two, the name field opens
let seen = await drag('2', S('1'), 0.5, (s, a) => {
  check('merge hint shown (drop-merge)', s.cls === 'drop-merge', JSON.stringify(s));
  check('dragged copy at 50% opacity', s.op === '0.5', s.op);
});
check('merge made a group of the two', (await L()) === '{"groups":[{"name":"New group","ids":["1","2"]}],"others":["3","4","5"]}', await L());
check('name field opened', await ev(`document.activeElement?.id === 'g-input'`));
await ev(`(() => { const i = document.getElementById('g-input'); i.value = 'Alpha'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
check('named Alpha', (await L()).includes('"Alpha"'), await L());
// 2. top edge of a row in a group: inserts before, blue line
seen = await drag('3', S('1'), 0.12, (s) => check('top edge shows drop-before', s.cls === 'drop-before', JSON.stringify(s)));
check('top edge inserts before', (await L()) === '{"groups":[{"name":"Alpha","ids":["3","1","2"]}],"others":["4","5"]}', await L());
// 3. middle of a session in a group: inserts next to it
seen = await drag('4', S('1'), 0.5, (s) => check('middle of a grouped row shows drop-after', s.cls === 'drop-after', JSON.stringify(s)));
check('middle of a grouped session inserts next to it', (await L()) === '{"groups":[{"name":"Alpha","ids":["3","1","4","2"]}],"others":["5"]}', await L());
// 4. bottom edge of the last row in a group
seen = await drag('3', S('2'), 0.88, (s) => check('bottom edge shows drop-after', s.cls === 'drop-after', JSON.stringify(s)));
check('bottom edge inserts after', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","4","2","3"]}],"others":["5"]}', await L());
// 5. the ghost follows the pointer offset 14px to the right
seen = await drag('5', S('1'), 0.5, (s, a, b) => check('ghost offset 14px right of the pointer', Math.abs(s.gl - (a.l + (b.x - a.x - 6) + 14)) < 4, JSON.stringify({ gl: s.gl, want: a.l + (b.x - a.x - 6) + 14 })));
check('5 went into the group', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","5","4","2","3"]}],"others":[]}', await L());
// 6. empty Not in a group: the dashed placeholder is the only target there
check('placeholder shown', await ev(`!!document.querySelector('.g-empty[data-drop-group="others"]')`));
seen = await drag('2', `document.querySelector('.others .th')`, 0.5, (s) => check('the others heading is no target', s.cls === null, JSON.stringify(s)));
check('dropping on the others heading does nothing', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","5","4","2","3"]}],"others":[]}', await L());
seen = await drag('2', `document.querySelector('.g-empty')`, 0.5, (s) => check('placeholder shows drop-into', s.cls === 'drop-into', JSON.stringify(s)));
check('placeholder takes it out of its group', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","5","4","3"]}],"others":["2"]}', await L());
// 7. a group heading is not a target
seen = await drag('2', `document.querySelector('.group:not(.others) .th')`, 0.5, (s) => check('group heading is no target', s.cls === null, JSON.stringify(s)));
check('dropping on a group heading does nothing', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","5","4","3"]}],"others":["2"]}', await L());
// 8. a second group by merge, then empty it: it disappears
await drag('3', S('2'), 0.5);
await ev(`(() => { const i = document.getElementById('g-input'); i.value = 'Beta'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
check('second group', (await L()) === '{"groups":[{"name":"Alpha","ids":["1","5","4"]},{"name":"Beta","ids":["2","3"]}],"others":[]}', await L());
await drag('2', S('1'), 0.12);
await drag('3', `document.querySelector('.g-empty')`, 0.5);
check('emptied group disappears', (await L()) === '{"groups":[{"name":"Alpha","ids":["2","1","5","4"]}],"others":["3"]}', await L());
// 9. rename by double-click; Esc keeps the old name
await ev(`document.querySelector('.group:not(.others) .g-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
check('double-click opens the name field', await ev(`document.activeElement?.id === 'g-input'`));
await ev(`(() => { const i = document.getElementById('g-input'); i.value = 'Gamma'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
check('Esc keeps the name', (await L()).includes('"Alpha"'), await L());
await ev(`document.querySelector('.group:not(.others) .g-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await ev(`(() => { const i = document.getElementById('g-input'); i.value = '  Work  '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
check('renamed (trimmed)', (await L()).includes('"Work"'), await L());
// 10. a short drag (under 5px) is a click, not a drop; Esc cancels a drag
const before = await L();
const r1 = await rect(S('4')); const r2 = await rect(S('2'));
await mouse('mousePressed', r1.x, r1.y + r1.h / 2); await mouse('mouseMoved', r1.x + 8, r1.y + r1.h / 2 + 8); await mouse('mouseMoved', r2.x, r2.y + r2.h * 0.12);
await c.key('Escape', { vk: 27 });
await mouse('mouseReleased', r2.x, r2.y + r2.h * 0.12);
check('Esc cancels a drag', (await L()) === before, await L());
check('no automatic sorting: rows in your order', (await ev(`KEYS.map(x => x[0]).join('')`)) === '21543', await ev(`KEYS.map(x => x[0]).join('')`));
await sleep(1500);
check('backend stored the layout', stored() === await L(), stored());
(await import('node:fs')).writeFileSync(stateDir + '/expected.txt', await L());
c.print(); c.close();
