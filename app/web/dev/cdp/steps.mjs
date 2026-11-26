// Tool steps (R5.6), on a copy of the fixture tree: Claude's Bash steps, foreground and background, and its Monitor
// steps fold with the steps around them and expand in place (2026-11-26, the user's decision); your `!` command is a
// run row (prototype/shell-storyboard.html).
// usage: node steps.mjs make <fixture-dir> <claude-dir>   copies the fixture and adds two running steps (run.sh does this)
//        node steps.mjs <url> <state-dir> <claude-dir>
// Checks: the fixture's Bash folds with the steps around it ("2 Bash commands, read 1 file, …") and expands in place to its
// command and result in the output panel, a second click closes it. Three foreground Bash steps, a background one and a
// Monitor in a row fold into one closed "4 Bash commands, started 1 monitor" line, no run row; a click lists them, each
// expands in place, the background Bash and the Monitor too, opening no view. The background shell and the monitor have
// their cards in the panel while they run (R7.1), counted as background work, a foreground Bash none; the card opens the
// shell view, whose title line starts with "‹ <session title>", and that crumb goes back. A background run over at once
// has its Past line, which opens its view. A step inside "Searched once, …" opens to its input and result, 20 lines and
// "Show all 32 lines" (`toolOutput`), kept through a live update; a single step opens inline. A running foreground Bash
// of a driven session (the SDK's tool_progress: 42 s): its own line is an inline step that expands in place to its
// command, "Running, 42s" ticking and "Output shows when it finishes"; no card in the panel; the live line names it and
// opens its shell view ("Shell in Claude's turn", how to see more), from which K and J go back (it has no card); its
// result lands in the open shell view, and the open step turns into the finished view. A session Synopia doesn't drive:
// the command and "Running", no note. Writes steps.png and steps-running.png (and, with SYNOPIA_SHOTS,
// fold-bash-<theme>.png, bg-card-<theme>.png, crumb-<theme>.png and step-<theme>.png there).
import fs from 'node:fs';
import path from 'node:path';
import { records, fresh, shot, running, outPanel } from './helpers.mjs';
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
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light', shots = process.env.SYNOPIA_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const clipOf = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 10), width: Math.min(1000, r.width + 32), height: Math.min(800, r.height + 20), scale: 1 }; })()`);
await c.load(url + '#11111111', `__synopia.current()?.startsWith('11111111')`);
await ev('__synopia.spy()');

// ---------- an ordinary foreground Bash folds with the steps around it (R5.6, 2026-11-26) ----------
const step = (name) => `[...document.querySelectorAll('details.step')].find(d => d.querySelector('summary').textContent.includes(${JSON.stringify(name)}))`;
const click = (name) => ev(`${step(name)}.querySelector('summary').click()`);
const BASH = step('Bash(List the demo folder)'), FOLD0 = `${BASH}?.closest('details.fold')`;
check('a foreground Bash folds with the steps around it: one line, no run row', await until(`!!${FOLD0} && !document.querySelector('#log .runrow')`), await ev(`document.getElementById('log').textContent.slice(0, 300)`));
check('the fold counts it with the others: "2 Bash commands, read 1 file, …"', /^2 Bash commands, read 1 file, /.test(await ev(`${FOLD0}.querySelector('summary .name').textContent`)), await ev(`${FOLD0}.querySelector('summary').textContent`));
await ev(`${FOLD0}.querySelector('summary').click()`);
await click('Bash(List the demo folder)');
await sleep(150);
const bx = await ev(`(() => { const d = ${BASH}; return { open: d.open, cmd: d.querySelector('.step-out .cmd')?.textContent, out: d.querySelector('.step-out .out')?.textContent, view: __synopia.view() }; })()`);
check('a click on it expands it in place: its command, then its result', bx.open && bx.cmd === 'ls -la /Users/fixture/dev/demo' && bx.out === 'notes.md\nREADME.md' && bx.view === null, JSON.stringify(bx));
{ const p = await ev(`(() => { ${BASH}.querySelector('.step-out .out').id = 'st-out'; return true; })()`) && await outPanel(c, '#st-out'); check('its result sits in the output panel', !!p && p.ok, JSON.stringify(p)); }
await click('Bash(List the demo folder)');
await sleep(150);
check('a second click closes it', await ev(`!${BASH}.open`));

// Claude's Bash steps in a row, foreground and background, and its Monitor fold into one line; your ! command is a run row
const T = (s) => `2026-11-20T10:05:${String(s).padStart(2, '0')}.000Z`;
const fgBash = (n, desc, cmd, out) => ({ id: `toolu_fg${n}`, k: 'tool', ts: T(n), name: 'Bash', verb: 'Ran', obj: desc, state: 'done', input: cmd, out: { text: out, lines: out.split('\n').length, cut: false, at: T(n) } });
await ev(`(() => { const s = __synopia.cur();
  __synopia.inject({ t: 'background', sid: s.id, upsert: [{ toolUseId: 'toolu_bgb', kind: 'shell', status: 'running', start: '${T(10)}', end: null, description: 'Serve the demo', command: 'npm run serve' },
    { toolUseId: 'toolu_bgm', kind: 'monitor', status: 'running', start: '${T(12)}', end: null, persistent: true, description: 'Watch the server log', command: 'tail -f server.log' }] });
  __synopia.inject({ t: 'items', sid: s.id, agent: null, total: s.total + 6, upsert: [
    ${JSON.stringify(fgBash(1, 'Count the notes', 'ls notes | wc -l', '12'))},
    ${JSON.stringify(fgBash(2, 'Show the branch', 'git branch --show-current', 'main'))},
    ${JSON.stringify(fgBash(3, 'Check the demo builds', 'npm run build', 'built 3 modules'))},
    { id: 'toolu_bgb', k: 'tool', ts: '${T(10)}', name: 'Bash', verb: 'Ran', obj: 'Serve the demo', state: 'done', input: 'npm run serve', out: { text: 'Command running in background with ID: bgb1.', lines: 1, cut: false } },
    { id: 'toolu_bgm', k: 'tool', ts: '${T(12)}', name: 'Monitor', verb: 'Watched', obj: 'Watch the server log', state: 'done', input: 'command: tail -f server.log', out: { text: 'Monitor started (task bgm1).', lines: 1, cut: false } },
    { id: 'bang-shape', k: 'bang', ts: '${T(20)}', cmd: 'ls demo', sh: { out: 'notes.md\\nREADME.md\\n', err: '', cut: false, exit: 0 } }] }); })()`);
const FOLD3 = `${step('Bash(Count the notes)')}?.closest('details.fold')`;
check('three foreground Bash steps, a background one and a Monitor fold into one line: "4 Bash commands, started 1 monitor"', await until(`!!${FOLD3} && /^4 Bash commands, started 1 monitor$/.test(${FOLD3}.querySelector('summary .name').textContent)`),
  await ev(`[...document.querySelectorAll('details.fold > summary')].map(s => s.textContent.replace(/\\s+/g, ' ')).join(' | ')`));
check('the fold is closed and holds all five; no run row for Claude\'s steps', await ev(`!${FOLD3}.open && ${FOLD3}.querySelectorAll('.body details.step').length === 5 && ${FOLD3}.closest('.ln.tool').getBoundingClientRect().height < 30 && !document.querySelector('#log .ln.tool.runrow, #log .g.ps')`));
await ev(`${FOLD3}.querySelector('summary').click()`);
check('a click expands it: the five steps, each by its description', await until(`${FOLD3}.open && [...${FOLD3}.querySelectorAll('.body details.step > summary')].map(s => s.textContent).join('|') === 'Bash(Count the notes)|Bash(Show the branch)|Bash(Check the demo builds)|Bash(Serve the demo)|Monitor(Watch the server log)'`),
  await ev(`[...${FOLD3}.querySelectorAll('.body > *')].map(s => s.textContent).join('|')`));
await click('Bash(Show the branch)');
check('a step in it expands in place to its command and result', await until(`(() => { const d = ${step('Bash(Show the branch)')}; return d.open && d.querySelector('.cmd')?.textContent === 'git branch --show-current' && d.querySelector('.out')?.textContent === 'main'; })()`));
await click('Bash(Serve the demo)');
check('the background Bash expands in place too, to its command and result, and opens no view', await until(`(() => { const d = ${step('Bash(Serve the demo)')}; return d.open && d.querySelector('.cmd')?.textContent === 'npm run serve' && /^Command running in background/.test(d.querySelector('.out')?.textContent || '') && __synopia.view() === null; })()`),
  await ev(`${step('Bash(Serve the demo)')}?.outerHTML.slice(0, 400)`));
await click('Monitor(Watch the server log)');
check('so does the Monitor', await until(`(() => { const d = ${step('Monitor(Watch the server log)')}; return d.open && /tail -f server\\.log/.test(d.querySelector('.cmd')?.textContent || '') && __synopia.view() === null; })()`));
check('your ! command is a run row on its ! band', await until(`(() => { const b = document.querySelector('#log .bang.runrow[data-bang="bang-shape"]'); return !!b && !b.closest('details.fold') && b.querySelector('.bang-cmd > .g').textContent === '!'; })()`));
await ev(`${FOLD3}.closest('.ln.tool').scrollIntoView({ block: 'start' })`);
await sleep(150);
if (shots) { await ev(`(${FOLD3}).closest('.ln.tool').id = 'fold3'`); await shot(c, path.join(shots, `fold-bash-${theme}.png`), await clipOf('#fold3')); }
// the panel (R7.1): the background shell and the monitor have their cards while they run, counted as background work
const CARD = (id) => `document.querySelector('.rail .now [data-bg="${id}"]')`;
check('the background shell and the monitor have their cards in the panel, counted', await until(`!!${CARD('toolu_bgb')} && !!${CARD('toolu_bgm')} && /^Serve the demo/.test(${CARD('toolu_bgb')}.querySelector('.n').textContent) && !${CARD('toolu_bgb')}.querySelector('.who') && /2 running in the background/.test(document.querySelector('.rail .main-row').textContent)`, 3000),
  await ev(`document.querySelector('.rail')?.textContent.replace(/\\s+/g, ' ') ?? 'no panel'`));
check('no card for a foreground Bash', await ev(`!document.querySelector('.rail [data-bg^="toolu_fg"]')`));
if (shots) await shot(c, path.join(shots, `bg-card-${theme}.png`), await clipOf('.rail .now'));
const sid1 = await ev(`__synopia.current()`);
await ev(`${CARD('toolu_bgb')}.click()`);
check('its card opens its shell view', await until(`__synopia.view() === 'toolu_bgb' && !!document.querySelector('#log .bg-run')`, 3000));
// the way back (2026-11-26): "‹ <session title>" at the start of the title line, the one back link there
const CRUMB = `document.querySelector('.c-head > .c-title > .c-crumb[data-back]')`;
const crumbOf = (bid) => ev(`(() => { const b = ${CRUMB}, t = document.querySelector('.c-head > .c-title'); if (!b) return null; const br = b.getBoundingClientRect(), nr = t.querySelector('.c-name').getBoundingClientRect();
  return { text: b.textContent, first: t.firstElementChild === b, sameLine: br.top >= t.getBoundingClientRect().top - 0.5 && br.bottom <= t.getBoundingClientRect().bottom + 0.5 && br.right <= nr.left,
    card: !!document.querySelector('.rail [data-bg="${bid}"]'), backs: document.querySelectorAll('.c-head [data-back]').length, title: __synopia.cur().title }; })()`);
{ const b = await crumbOf('toolu_bgb'); check('its header starts with "‹ <session title>" on the title line, the one back link there', !!b && b.first && b.sameLine && b.text === '‹ ' + b.title && b.backs === 1, JSON.stringify(b)); }
if (shots) await shot(c, path.join(shots, `crumb-${theme}.png`), await clipOf('.c-head'));
await ev(`${CRUMB}.click()`);
check('the crumb goes back to Main conversation, with its message box', await until(`__synopia.view() === null && __synopia.current() === '${sid1}' && !!document.getElementById('msg')`, 3000));
// one that ended at once still has its Past line (cards from the start, R7.1), which opens its view
await ev(`(() => { const s = __synopia.cur();
  __synopia.inject({ t: 'background', sid: s.id, upsert: [{ toolUseId: 'toolu_bgq', kind: 'shell', status: 'completed', start: '${T(30)}', end: '${T(30)}', description: 'Touch the marker', command: 'touch marker' }] });
  __synopia.inject({ t: 'items', sid: s.id, agent: null, total: s.total + 1, upsert: [{ id: 'toolu_bgq', k: 'tool', ts: '${T(30)}', name: 'Bash', verb: 'Ran', obj: 'Touch the marker', state: 'done', input: 'touch marker', out: { text: 'Command running in background', lines: 1, cut: false } }] }); })()`);
const QPAST = `document.querySelector('.rail .past .pr[data-bg="toolu_bgq"]')`;
check('a background run over at once has its Past line', await until(`!!${QPAST}`, 8000), await ev(`document.querySelector('.rail')?.textContent.replace(/\\s+/g, ' ') ?? 'no panel'`));
await ev(`${QPAST}.click()`);
check('its Past line opens its shell view, with the crumb', await until(`__synopia.view() === 'toolu_bgq'`, 3000) && (await crumbOf('toolu_bgq'))?.text?.startsWith('‹ '));
await ev(`${CRUMB}.click()`);
await until(`__synopia.view() === null`, 3000);

// ---------- the other steps expand the same way ----------
const FOLD = `${step('Grep(TODO)')}.closest('details.fold')`;
check('the search group shows', await until(`!!${step('Grep(TODO)')}`));
await ev(`${FOLD}.open = true`);
await click('Grep(TODO)');
await sleep(150);
const lines = () => ev(`(() => { const d = ${step('Grep(TODO)')}; return d.open ? d.querySelector('.out').textContent.split('\\n').length : 0; })()`);
check('a long result shows 20 lines', await lines() === 20);
check('the input of a search shows', (await ev(`${step('Grep(TODO)')}.querySelector('.cmd').textContent`)) === 'pattern: TODO');
check('"Show all 32 lines"', (await ev(`${step('Grep(TODO)')}.querySelector('[data-full]')?.textContent`)) === 'Show all 32 lines');
await ev(`${step('Grep(TODO)')}.querySelector('[data-full]').click()`);
check('show all loads the full result', await until(`(() => { const d = ${step('Grep(TODO)')}; return d && d.open && d.querySelector('.out').textContent.split('\\n').length === 32 && !d.querySelector('[data-full]'); })()`));
check('one toolOutput message', (await ev(`JSON.stringify(__synopia.sent('toolOutput'))`)) === JSON.stringify([{ t: 'toolOutput', sid: '11111111-0000-4000-8000-000000000001', agent: null, toolUseId: 'toolu_grep1' }]));
const before = await ev(`${FOLD}.closest('[data-key]').dataset.key`);
await ev(`(() => { const s = __synopia.cur(), it = s.items.find(i => i.id === 'toolu_fetch1'); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ ...it, state: 'done', out: { text: 'made-up page', lines: 1, cut: false } }], total: s.total }); })()`);
await sleep(300);
check('the live update redrew the block', await ev(`!${FOLD}.querySelector('.body').textContent.includes('running')`));
check('the step and the full result stay open, and the group', await ev(`${step('Grep(TODO)')}.open && ${step('Grep(TODO)')}.querySelector('.out').textContent.split('\\n').length === 32 && ${FOLD}.open && document.querySelector('[data-key="${before}"]') !== null`));
await ev(`(d => { d.id = 'grep-fold'; d.closest('[data-key]').scrollIntoView({ block: 'start' }); })(${FOLD})`);
await sleep(200);
const clip = await clipOf('#grep-fold');
await shot(c, path.join(stateDir, 'steps.png'), clip);
if (shots) await shot(c, path.join(shots, `step-${theme}.png`), clip);
await click('Grep(TODO)');
await sleep(150);
check('a click closes it', await ev(`!${step('Grep(TODO)')}.open`));
await ev(`(() => { const s = __synopia.cur(); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'toolu_one', k: 'tool', ts: '2026-11-20T10:04:00.000Z', name: 'Grep', verb: 'Searched', obj: 'hello', state: 'done', input: 'pattern: hello', out: { text: 'hello.md', lines: 1, cut: false } }], total: s.total + 2 }); })()`);
check('a single step is inline', await until(`(() => { const d = ${step('Grep(hello)')}; return d && d.parentElement.matches('.ln.tool'); })()`));
await click('Grep(hello)');
await sleep(150);
check('a single step opens', await ev(`${step('Grep(hello)')}.open && ${step('Grep(hello)')}.querySelector('.step-out').innerText.includes('pattern: hello')`));

// ---------- a running foreground Bash step (R5.5, R5.6, R7.1, R7.2) ----------
const reload = async (u, extra) => { await c.cdp('Page.navigate', { url: 'about:blank' }); await sleep(200); return c.load(u, extra); };
const LIVE = `document.querySelector('#log .liveln')`;
const OWN = `document.querySelector('#log details.step[data-step="toolu_live1"]:not(.live)')`;
await reload(`${url}#${S.slice(0, 8)}`, `__synopia.current() === '${S}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().items.some(i => i.id === 'toolu_live1' && i.since)`);
check('the live line names the running step', (await ev(`${LIVE}?.textContent.replace(/\\s+/g, ' ').trim()`)) === `Working Bash(${DESC})`, await ev(`${LIVE}?.outerHTML`));
check('its own line is a step, inline, not a run row: Bash(description), Running', await until(`!!${OWN} && !document.querySelector('#log .runrow') && ${OWN}.closest('.ln.tool').classList.contains('running') && ${OWN}.querySelector('summary').textContent.startsWith('Bash(${DESC})')`), await ev(`document.getElementById('log').innerHTML.slice(-800)`));
await ev(`${OWN}.querySelector('summary').click()`);
const timer = () => ev(`${OWN}?.querySelector('.step-out .res.running')?.textContent ?? ''`);
check('a click expands it in place, no view opens', await until(`${OWN}.open && __synopia.view() === null`, 2000));
const t1 = await timer();
check('expanded: its command at once, "Running, 42s" from the SDK\'s elapsed time, "Output shows when it finishes"', /^Running, ((4|5)\ds|1m \d\ds)$/.test(t1) && (await ev(`${OWN}.querySelector('.step-out .res.note')?.textContent`)) === 'Output shows when it finishes'
  && (await ev(`${OWN}.querySelector('.step-out .cmd').textContent`)) === CMD, t1);
await sleep(2100);
const t2 = await timer();
check('the timer ticks', t2 !== t1 && t2.startsWith('Running, '), `${t1} -> ${t2}`);
await sleep(1200);
check('no card for it in the panel, 3 s on and more: the turn\'s own step is not background work', await ev(`!document.querySelector('.rail [data-bg="toolu_live1"]')`), await ev(`document.querySelector('.rail')?.textContent || 'no panel'`));
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
await sleep(100);
await shot(c, path.join(stateDir, 'steps-running.png'));
await ev(`${LIVE}.click()`);
check('a click on the live line opens its shell view', await until(`__synopia.view() === 'toolu_live1'`, 3000));
// a view with no card in the panel: K and J go back to Main conversation
await c.key('K', { shift: true, code: 'KeyK', vk: 75 });
check('K from a view with no card goes back to Main conversation', await until(`__synopia.view() === null`, 3000), await ev('__synopia.view()'));
await until(`!!${LIVE}`, 3000);
await ev(`${LIVE}.click()`);
await until(`__synopia.view() === 'toolu_live1'`, 3000);
await c.key('J', { shift: true, code: 'KeyJ', vk: 74 });
check('J from it too', await until(`__synopia.view() === null`, 3000), await ev('__synopia.view()'));
await until(`!!${LIVE}`, 3000);
await ev(`${LIVE}.click()`);
await until(`__synopia.view() === 'toolu_live1'`, 3000);
const rv = await ev(`({ head: document.querySelector('.c-head').textContent.replace(/\\s+/g, ' '), note: document.querySelector('#log .bg-run .res.note')?.textContent, cmd: document.querySelector('#log .bg-run .cmd')?.textContent, live: document.querySelector('#log .liveln')?.textContent.trim() })`);
check('its view: "Shell in Claude\'s turn", what it can show and how to see more, Running', /Running, .*\. Shell in Claude's turn, started/.test(rv.head) && /Claude waits for it/.test(rv.head) && /^Output shows when it finishes\. b, b sends it to the background/.test(rv.note || '') && /npm test/.test(rv.cmd || '') && /^Running/.test(rv.live || ''), JSON.stringify(rv));
// the result lands while its view is open
fs.appendFileSync(fileOf(claude, S), rec(S, { timestamp: fresh(60), type: 'user', uuid: 's-r1', toolUseResult: { stdout: 'built 3 modules\n12 passing', stderr: '', interrupted: false },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live1', content: 'built 3 modules\n12 passing' }] } }));
check('its result lands in the open shell view: the output, then how it ended', await until(`/12 passing/.test(document.querySelector('#log .bg-run')?.textContent || '') && /^Finished after/.test(document.querySelector('#log .bg-end')?.textContent.trim() || '')`, 8000), await ev(`document.getElementById('log').textContent`));
await ev(`document.querySelector('[data-back]').click()`);
await until(`__synopia.view() === null`, 3000);
await sleep(200);
const done = await ev(`(() => { const r = ${OWN}; return r && { open: r.open, out: r.querySelector('.step-out .out')?.textContent, running: !!r.querySelector('.step-out .res.running, .step-out .res.note') }; })()`);
check('the open step turns into the finished view in place: its result, no Running', !!done && done.open && done.out === 'built 3 modules\n12 passing' && !done.running, JSON.stringify(done));
check('the live line no longer names it', !/Bash\(/.test(await ev(`${LIVE}?.textContent || ''`)));
// a session Synopia doesn't drive: the command and "Running", no note
await reload(`${url}#${N.slice(0, 8)}`, `__synopia.current() === '${N}' && !!__synopia.mounted() && __synopia.cur().items.some(i => i.id === 'toolu_ext1')`);
const EXT = `document.querySelector('#log details.step[data-step="toolu_ext1"]:not(.live)')`;
await until(`!!${EXT}`, 3000);
await ev(`${EXT}.querySelector('summary').click()`);
check('not driven: expanded, the command and "Running", no note', await until(`${EXT}.open && ${EXT}.querySelector('.step-out .cmd').textContent === 'sleep 30; echo built' && /^Running/.test(${EXT}.querySelector('.step-out .res.running')?.textContent || '') && !${EXT}.querySelector('.step-out .res.note')`, 3000), await ev(`${EXT}?.textContent`));
c.print();
c.close();
