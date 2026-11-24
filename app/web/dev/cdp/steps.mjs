// Expanding a tool step to its command or input and its result (R5.6), on the fixture tree.
// usage: node steps.mjs <url> <state-dir>
// Checks: a step inside "2 Bash commands, …" opens with a click to its command and output, a long
// result shows 20 lines and "Show all 32 lines", which loads the rest from the server (`toolOutput`),
// a live update of the block keeps both, a click closes it, and a single inline step opens too.
// Writes steps.png.
import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from './cdp.mjs';

const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
const until = async (expr, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
await c.load(url + '#11111111', `current?.startsWith('11111111')`);
check('the tool group shows', await until(`!!document.querySelector('details.fold .body details.step')`));
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const step = (name) => `[...document.querySelectorAll('details.step')].find(d => d.querySelector('summary').textContent.includes(${JSON.stringify(name)}))`;
const click = (name) => ev(`${step(name)}.querySelector('summary').click()`);
await ev(`document.querySelector('details.fold').open = true`);
await click('List the demo folder');
await sleep(150);
const bash = await ev(`(() => { const d = ${step('List the demo folder')}; return d.open ? d.querySelector('.step-out').innerText : ''; })()`);
check('a Bash step opens to its command and output', bash.includes('ls -la /Users/fixture/dev/demo') && bash.includes('notes.md') && bash.includes('README.md'), JSON.stringify(bash));
await click('Grep(TODO)');
await sleep(150);
const lines = () => ev(`(() => { const d = ${step('Grep(TODO)')}; return d.open ? d.querySelector('.out').textContent.split('\\n').length : 0; })()`);
check('a long result shows 20 lines', await lines() === 20);
check('the input of a search shows', (await ev(`${step('Grep(TODO)')}.querySelector('.cmd').textContent`)) === 'pattern: TODO');
check('"Show all 32 lines"', (await ev(`${step('Grep(TODO)')}.querySelector('[data-full]')?.textContent`)) === 'Show all 32 lines');
await ev(`${step('Grep(TODO)')}.querySelector('[data-full]').click()`);
check('show all loads the full result', await until(`(() => { const d = ${step('Grep(TODO)')}; return d && d.open && d.querySelector('.out').textContent.split('\\n').length === 32 && !d.querySelector('[data-full]'); })()`));
check('one toolOutput message', (await ev(`JSON.stringify(__sent.filter(m => m.t === 'toolOutput'))`)) === JSON.stringify([{ t: 'toolOutput', sid: '11111111-0000-4000-8000-000000000001', agent: null, toolUseId: 'toolu_grep1' }]));
// a live update that redraws the block: the running fetch finishes
const before = await ev(`document.querySelector('details.fold').closest('[data-key]').dataset.key`);
await ev(`(() => { const s = store.sessions.get(current), it = s.items.find(i => i.id === 'toolu_fetch1'); onMessage({ t: 'items', sid: s.id, agent: null, upsert: [{ ...it, state: 'done', out: { text: 'made-up page', lines: 1, cut: false } }], total: s.total }); window.__el = document.querySelector('details.fold'); })()`);
await sleep(300);
check('the live update redrew the block', await ev(`!document.querySelector('details.fold .body').textContent.includes('running')`));
check('both steps stay open, the full result stays', await ev(`${step('List the demo folder')}.open && ${step('Grep(TODO)')}.open && ${step('Grep(TODO)')}.querySelector('.out').textContent.split('\\n').length === 32`));
check('the group stays open', await ev(`document.querySelector('details.fold').open && document.querySelector('[data-key="${before}"]') !== null`));
await ev(`document.querySelector('details.fold').closest('[data-key]').scrollIntoView({ block: 'start' })`);
await sleep(200);
const clip = await ev(`(() => { const r = document.querySelector('details.fold').closest('[data-key]').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(1000, r.width + 40), height: Math.min(800, r.height + 20), scale: 1 }; })()`);
fs.writeFileSync(path.join(stateDir, 'steps.png'), Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png', clip })).result.data, 'base64'));
await click('Grep(TODO)');
await sleep(150);
check('a click closes it', await ev(`!${step('Grep(TODO)')}.open`));
// a single step shows inline: make one by viewing a run of one tool
await ev(`(() => { const s = store.sessions.get(current); onMessage({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'toolu_one', k: 'tool', ts: '2026-11-20T10:03:00.000Z', name: 'Bash', verb: 'Ran', obj: 'Say hi', state: 'done', input: 'echo hi', out: { text: 'hi', lines: 1, cut: false } }], total: s.total + 1 }); })()`);
check('a single step is inline', await until(`(() => { const d = ${step('Say hi')}; return d && d.parentElement.matches('.ln.tool'); })()`));
await click('Say hi');
await sleep(150);
check('a single step opens', await ev(`${step('Say hi')}.open && ${step('Say hi')}.querySelector('.step-out').innerText.includes('echo hi')`));
c.print();
c.close();
