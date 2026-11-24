// Expanding a tool step to its command or input and its result (R5.6), on a copy of the fixture tree.
// usage: node steps.mjs make <fixture-dir> <claude-dir>   copies the fixture and adds two running steps (run.sh does this)
//        node steps.mjs <url> <state-dir> <claude-dir>
// Checks: a step inside "2 Bash commands, …" opens with a click to its command and output, a long
// result shows 20 lines and "Show all 32 lines", which loads the rest from the server (`toolOutput`),
// a live update of the block keeps both, a click closes it, and a single inline step opens too.
// A running Bash step of a driven session (the SDK's tool_progress: 42 s) expands from the live line
// and from its own line, one open state: the command, a ticking "Running, 42s" and "Output shows when
// it finishes"; it stays open through a redraw and a reload, and turns into the finished view in place
// when its result lands. A session Synopia doesn't drive shows the command and "Running".
// Writes steps.png and steps-running.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, fresh, shot, running } from './helpers.mjs';
import { connect, sleep } from './cdp.mjs';

const S = 'b7b7b7b7-0000-4000-8000-0000000000c1'; // driven, its Bash runs
const N = 'c8c8c8c8-0000-4000-8000-0000000000c2'; // not driven: its Bash runs by the transcript alone
const DESC = 'Inspect feature based ability builder';
const CMD = 'npm run build\nnpm test -- --grep "ability builder"';
const fileOf = (claude, sid) => path.join(claude, 'projects', '-tmp-synopia-steps', `${sid}.jsonl`);
const { rec, you, tool } = records('/tmp/synopia-steps');
const bashRec = (sid, uuid, s, id, command, description) => tool(sid, uuid, s, id, 'Bash', { command, description });

if (process.argv[2] === 'make') {
  const [src, dst] = process.argv.slice(3);
  fs.cpSync(src, dst, { recursive: true });
  fs.mkdirSync(path.dirname(fileOf(dst, S)), { recursive: true });
  fs.writeFileSync(fileOf(dst, S), you(S, 's-u1', 0, 'Check the ability builder.') + bashRec(S, 's-a1', 2, 'toolu_live1', CMD, DESC));
  fs.writeFileSync(fileOf(dst, N), you(N, 'n-u1', 0, 'Wait for the demo build.') + bashRec(N, 'n-a1', 2, 'toolu_ext1', 'sleep 30; echo built', 'Wait for the build'));
  // S's turn runs in Synopia's process, its Bash 42 s in (the SDK's tool_progress); N's in another process
  const script = JSON.parse(fs.readFileSync(path.join(dst, 'sdk-script.json'), 'utf8'));
  script.sessions[S] = { start: true, steps: [running(58000), { message: { type: 'tool_progress', tool_use_id: 'toolu_live1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 42 } }] };
  fs.writeFileSync(path.join(dst, 'sdk-script.json'), JSON.stringify(script));
  process.exit(0);
}

const [url, stateDir, claude] = process.argv.slice(2);
const c = await connect();
const { ev, check, until } = c;
await c.load(url + '#11111111', `__synopia.current()?.startsWith('11111111')`);
check('the tool group shows', await until(`!!document.querySelector('details.fold .body details.step')`));
await ev('__synopia.spy()');
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
check('one toolOutput message', (await ev(`JSON.stringify(__synopia.sent('toolOutput'))`)) === JSON.stringify([{ t: 'toolOutput', sid: '11111111-0000-4000-8000-000000000001', agent: null, toolUseId: 'toolu_grep1' }]));
// a live update that redraws the block: the running fetch finishes
const before = await ev(`document.querySelector('details.fold').closest('[data-key]').dataset.key`);
await ev(`(() => { const s = __synopia.cur(), it = s.items.find(i => i.id === 'toolu_fetch1'); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ ...it, state: 'done', out: { text: 'made-up page', lines: 1, cut: false } }], total: s.total }); window.__el = document.querySelector('details.fold'); })()`);
await sleep(300);
check('the live update redrew the block', await ev(`!document.querySelector('details.fold .body').textContent.includes('running')`));
check('both steps stay open, the full result stays', await ev(`${step('List the demo folder')}.open && ${step('Grep(TODO)')}.open && ${step('Grep(TODO)')}.querySelector('.out').textContent.split('\\n').length === 32`));
check('the group stays open', await ev(`document.querySelector('details.fold').open && document.querySelector('[data-key="${before}"]') !== null`));
await ev(`document.querySelector('details.fold').closest('[data-key]').scrollIntoView({ block: 'start' })`);
await sleep(200);
const clip = await ev(`(() => { const r = document.querySelector('details.fold').closest('[data-key]').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(1000, r.width + 40), height: Math.min(800, r.height + 20), scale: 1 }; })()`);
await shot(c, path.join(stateDir, 'steps.png'), clip);
await click('Grep(TODO)');
await sleep(150);
check('a click closes it', await ev(`!${step('Grep(TODO)')}.open`));
// a single step shows inline: make one by viewing a run of one tool
await ev(`(() => { const s = __synopia.cur(); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'toolu_one', k: 'tool', ts: '2026-11-20T10:03:00.000Z', name: 'Bash', verb: 'Ran', obj: 'Say hi', state: 'done', input: 'echo hi', out: { text: 'hi', lines: 1, cut: false } }], total: s.total + 1 }); })()`);
check('a single step is inline', await until(`(() => { const d = ${step('Say hi')}; return d && d.parentElement.matches('.ln.tool'); })()`));
await click('Say hi');
await sleep(150);
check('a single step opens', await ev(`${step('Say hi')}.open && ${step('Say hi')}.querySelector('.step-out').innerText.includes('echo hi')`));

// ---------- a running step (R5.6) ----------
// a full load of the page, not a jump to its fragment
const reload = async (u, extra) => { await c.cdp('Page.navigate', { url: 'about:blank' }); await sleep(200); return c.load(u, extra); };
const LIVE = `document.querySelector('#log .liveln details.step[data-step="toolu_live1"]')`;
const OWN = `document.querySelector('#log .ln.tool details.step[data-step="toolu_live1"]')`;
await reload(`${url}#${S.slice(0, 8)}`, `__synopia.current() === '${S}' && !!__synopia.mounted() && __synopia.cur().driven === true && __synopia.cur().items.some(i => i.id === 'toolu_live1' && i.since)`);
check('the live line names the running step and can expand', (await ev(`${LIVE}?.querySelector('summary').textContent`)) === `Working Bash(${DESC})`, await ev(`document.querySelector('#log .liveln')?.outerHTML`));
check('its own line can expand too', await ev(`!!${OWN} && !${OWN}.open && !${LIVE}.open`));
await ev(`${LIVE}.querySelector('summary').click()`);
check('a click on the live line opens both', await c.until(`${LIVE}.open && ${OWN}.open`, 2000));
const body = await ev(`${LIVE}.querySelector('.step-out').innerText`);
check('it shows the full command at once', body.includes('npm run build') && body.includes('--grep "ability builder"'), JSON.stringify(body));
const timer = () => ev(`${LIVE}.querySelector('.res.running')?.textContent ?? ''`);
const t1 = await timer();
check('a quiet "Running, 42s" from the SDK\'s elapsed time', /^Running, ((4|5)\ds|1m \d\ds)$/.test(t1), t1);
check('"Output shows when it finishes"', (await ev(`${LIVE}.querySelector('.res.note')?.textContent`)) === 'Output shows when it finishes');
check('the step\'s own line shows the same', (await ev(`${OWN}.querySelector('.step-out').innerText`)).includes('npm run build') && !!(await ev(`${OWN}.querySelector('.res.running [data-live]')`)));
check('its line\'s own Running row steps aside while open', await ev(`getComputedStyle(${OWN}.querySelector('summary .res.run')).display === 'none'`));
await sleep(2100);
const t2 = await timer();
check('the timer ticks', t2 !== t1 && t2.startsWith('Running, '), `${t1} -> ${t2}`);
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
await sleep(100);
await shot(c, path.join(stateDir, 'steps-running.png'));
await ev(`${OWN}.querySelector('summary').click()`);
check('a click on its own line closes both', await c.until(`!${LIVE}.open && !${OWN}.open`, 2000));
await ev(`${OWN}.querySelector('summary').click()`);
check('and opens both', await c.until(`${LIVE}.open && ${OWN}.open`, 2000));
// a redraw replaces every block
await ev(`(() => { window.__old = [${LIVE}, ${OWN}]; __synopia.redraw(); })()`);
check('both stay open through a redraw', await ev(`${LIVE} !== __old[0] && ${OWN} !== __old[1] && ${LIVE}.open && ${OWN}.open`));
await sleep(600); // the UI state goes to the server
await reload(`${url}#${S.slice(0, 8)}`, `__synopia.current() === '${S}' && !!__synopia.mounted() && __synopia.cur().items.some(i => i.id === 'toolu_live1' && i.since)`);
check('the UI-state restore keeps it open', await c.until(`!!${LIVE} && ${LIVE}.open && ${OWN}.open`, 3000));
// the result lands: the step becomes today's finished view in place
const topOf = `${OWN}.closest('.ln').offsetTop`;
const top0 = await ev(topOf);
fs.appendFileSync(fileOf(claude, S), rec(S, { timestamp: fresh(60), type: 'user', uuid: 's-r1', toolUseResult: { stdout: 'built 3 modules\n12 passing', stderr: '', interrupted: false },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live1', content: 'built 3 modules\n12 passing' }] } }));
check('the result arrives', await c.until(`__synopia.cur().items.some(i => i.id === 'toolu_live1' && i.state === 'done')`, 8000));
await sleep(200);
const done = await ev(`${OWN}?.open ? ${OWN}.querySelector('.step-out').innerText : ''`);
check('it is the finished view: the command, then the result under the guide', done.includes('npm run build') && done.includes('12 passing') && !done.includes('Running')
  && await ev(`!!${OWN}.querySelector('.res > .lcorner + .out')`), JSON.stringify(done));
check('in place, no jump', (await ev(topOf)) === top0, `${top0} -> ${await ev(topOf)}`);
check('the live line no longer expands a finished step', await ev(`!${LIVE}`));
// a session Synopia doesn't drive: the command and "Running", no timer
await reload(`${url}#${N.slice(0, 8)}`, `__synopia.current() === '${N}' && !!__synopia.mounted() && __synopia.cur().items.some(i => i.id === 'toolu_ext1')`);
const EXT = `document.querySelector('#log .ln.tool details.step[data-step="toolu_ext1"]')`;
await ev(`${EXT}.querySelector('summary').click()`);
await sleep(150);
check('not driven: the command and "Running", nothing more', await ev(`${EXT}.open && ${EXT}.querySelector('.cmd').textContent === 'sleep 30; echo built'
  && ${EXT}.querySelector('.res.running').textContent === 'Running' && !${EXT}.querySelector('.res.note')`), await ev(`${EXT}?.querySelector('.step-out')?.innerText`));
c.print();
c.close();
