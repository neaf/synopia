// S5-3 and S5-4 on the page: the slash menu (R5.14) and the model picker with its effort row (R3.7),
// with real key events, on the fake driver's menu. Writes menu-picker.png in the state folder.
// usage: run.sh menu (or node menu.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(url);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const type = async (t) => { for (const ch of t) await key(ch, { vk: ch.toUpperCase().charCodeAt(0) }); };
const K = {
  slash: () => key('/', { code: 'Slash', vk: 191 }), esc: () => key('Escape', { code: 'Escape', vk: 27 }),
  down: () => key('ArrowDown', { code: 'ArrowDown', vk: 40 }), up: () => key('ArrowUp', { code: 'ArrowUp', vk: 38 }),
  right: () => key('ArrowRight', { code: 'ArrowRight', vk: 39 }), left: () => key('ArrowLeft', { code: 'ArrowLeft', vk: 37 }),
  tab: () => key('Tab', { code: 'Tab', vk: 9 }), enter: () => key('Enter', { code: 'Enter', vk: 13, text: '\r' }),
};
const box = () => ev(`(() => { const b = document.getElementById('slash'); return b.hidden ? null : [...b.querySelectorAll('.it .n')].map(n => n.textContent.trim()); })()`);
const val = () => ev(`document.getElementById('msg').value`);
await ev(`document.querySelector('.row[data-id^="1111"]').click()`); await ev('document.activeElement.blur()'); await sleep(300);

// the slash menu
await sleep(300);
await K.slash();
let names = await box(); if (!Array.isArray(names)) console.log('box:', names);
check('/ lists the folder\'s commands', names && names.length === 7, JSON.stringify(names));
check('internal __ commands left out', names && !names.some((n) => n.includes('__')));
check('argument hints shown', await ev(`[...document.querySelectorAll('#slash .it .h')].map(h => h.textContent).includes('<number>')`));
check('descriptions aligned in one column', await ev(`(() => { const xs = [...document.querySelectorAll('#slash .it .d')].map(d => Math.round(d.getBoundingClientRect().left)); return xs.length > 1 && xs.every(x => x === xs[0]); })()`));
await type('pr');
names = await box();
check('typing filters, prefix first', names && names[0].startsWith('/pr-review') && names.length >= 1, JSON.stringify(names));
await K.down(); await K.up();
check('↑↓ move the selection', await ev(`document.querySelector('#slash [aria-selected="true"] .n').textContent.startsWith('/pr-review')`));
await K.tab();
check('Tab fills the command', (await val()) === '/pr-review ' && (await box()) === null, JSON.stringify(await val()));
await ev(`(() => { const t = document.getElementById('msg'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);
await type('/dep');
check('a word inside a name matches', JSON.stringify(await box()) === JSON.stringify(['/fixture:deploy <env>']), JSON.stringify(await box()));
await K.esc();
check('Esc closes the menu, text stays', (await box()) === null && (await val()) === '/dep');
await K.esc();
await ev(`(() => { const t = document.getElementById('msg'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);

// /model opens the model picker; ↓ moves, → picks the effort, Enter sets both
await c.cdp('Input.insertText', { text: '' });
await ev(`document.getElementById('msg').focus()`);
await type('/model');
await K.enter();
check('/model + Enter opens the picker', await ev(`document.querySelector('#slash .head')?.textContent.startsWith('Choose a model')`));
check('picker lists the models', JSON.stringify((await box())?.map((n) => n.replace(/^❯\s*/, ''))) === JSON.stringify(['Default', 'Fixture Large', 'Fixture Small']), JSON.stringify(await box()));
check('the effort row under the selected model', await ev(`document.querySelectorAll('#slash .eff').length === 1 && !!document.querySelector('#slash [aria-selected="true"] .eff')`));
await K.down();
check('effort row follows the selection', await ev(`[...document.querySelectorAll('#slash [aria-selected="true"] .eff-o')].map(o => o.textContent).join(',') === 'low,medium,high'`));
await K.left(); await K.left(); await K.left(); await K.right(); // low, then medium
check('← and → move along the levels', await ev(`document.querySelector('#slash .eff-o[aria-checked="true"]')?.textContent === 'medium'`));
const shot = await c.cdp('Page.captureScreenshot', { format: 'png', clip: await ev(`(() => { const r = document.querySelector('.dock').getBoundingClientRect(); return { x: r.left - 20, y: r.top - 200, width: r.width + 40, height: r.height + 220, scale: 1 }; })()`) });
writeFileSync(stateDir + '/menu-picker.png', Buffer.from(shot.result.data, 'base64'));
await K.enter();
await sleep(400);
const sm = await ev(`JSON.stringify(__sent.filter(m => m.t === 'setModel'))`);
check('Enter sends setModel with the effort', /"model":"fixture-large","effort":"medium"/.test(sm), sm);
check('the picker closed and the box is empty', (await box()) === null && (await val()) === '');
check('header shows the model and effort', (await ev(`document.getElementById('model-label').textContent`)) === 'Fixture Large, medium effort', await ev(`document.getElementById('model-label').textContent`));
await sleep(1200);
const st = JSON.parse(readFileSync(stateDir + '/state.json', 'utf8'));
check('stored per session', JSON.stringify(st.models['11111111-0000-4000-8000-000000000001']) === '{"model":"fixture-large","effort":"medium"}', JSON.stringify(st.models));

// the header button opens the same picker, on the current model; a model without effort has no row
await K.esc();
await ev(`document.getElementById('model-label').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await ev(`document.getElementById('model-label').click()`);
await sleep(300);
check('the model button opens the picker', await ev(`document.querySelector('#slash .head')?.textContent.startsWith('Choose a model')`));
check('the current model is marked and selected', await ev(`document.querySelector('#slash [aria-selected="true"] .n').textContent.startsWith('❯') && document.querySelector('#slash [aria-selected="true"] .n').textContent.includes('Fixture Large')`));
check('its stored effort is the boxed one', await ev(`document.querySelector('#slash .eff-o[aria-checked="true"]')?.textContent === 'medium'`));
await K.down();
check('a model without effort levels has no effort row', await ev(`!document.querySelector('#slash .eff')`));
await ev(`document.querySelectorAll('#slash .it')[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`);
await ev(`document.querySelector('#slash [aria-selected="true"] [data-eff="high"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await sleep(300);
check('hover moves the effort row, a click on a level picks both', /"model":"default","effort":"high"/.test(await ev(`JSON.stringify(__sent.filter(m => m.t === 'setModel').at(-1))`)), await ev(`JSON.stringify(__sent.filter(m => m.t === 'setModel').at(-1))`));
check('Default shows the CLI\'s current model', (await ev(`document.getElementById('model-label').textContent`)) === 'Default (Fixture Large), high effort', await ev(`document.getElementById('model-label').textContent`));
c.print(); c.close();
