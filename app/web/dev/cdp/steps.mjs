// Tool steps (R5.6), on a copy of the fixture tree: a Bash step is a run row (2026-11-26, prototype/shell-storyboard.html),
// other steps expand to their input and result.
// usage: node steps.mjs make <fixture-dir> <claude-dir>   copies the fixture and adds two running steps (run.sh does this)
//        node steps.mjs <url> <state-dir> <claude-dir>
// Checks: a Bash step is one row of the same shape as your `!` command: ● Bash(description), the command under a grey $
// in the gutter (no band), the last 3 lines in the output panel, a state line with its mark; no expansion, no input
// field. A click on it opens its shell view (the command, its whole result, how it ended); with no card in the
// panel, "‹ <session title>" at the start of the title line, K, J or that crumb go back to Main conversation. A step inside "Searched
// once, …" opens to its input and result, 20 lines and "Show all 32 lines" (`toolOutput`), kept through a live
// update; a single non-shell step opens inline. A running Bash step of a driven session (the SDK's tool_progress:
// 42 s): its row says "Output shows when it finishes" and "Running, 42s" ticking; the live line names it and opens
// its shell view ("Shell in Claude's turn", how to see more); its card is in the panel (3 s on) without a sign, not
// counted as background; its result lands in the open shell view and in the row in place. A session Synopia doesn't
// drive: the command and "Running", no note. Writes steps.png and steps-running.png (and, with SYNOPIA_SHOTS,
// dollar-row-<theme>.png and step-<theme>.png there).
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

// ---------- a Bash step is a run row ----------
const ROW = `[...document.querySelectorAll('#log .ln.tool.runrow')].find(r => r.textContent.includes('List the demo folder'))`;
check('a Bash step is a run row of its own, not folded with the other steps', await until(`!!${ROW} && !${ROW}.closest('details.fold')`), await ev(`document.getElementById('log').textContent.slice(0, 300)`));
const shape = await ev(`(() => { const r = ${ROW}, kids = [...r.children]; const ps = r.querySelector(':scope > .g.ps'), cmd = r.querySelector(':scope > .step-out > .cmd'), st = r.querySelector('.res.rst');
  return { kids: kids.map(k => k.className), dot: kids[0].textContent, head: kids[1].textContent, ps: ps?.textContent, psColor: ps ? getComputedStyle(ps).color : '', ink3: getComputedStyle(document.body).getPropertyValue('--ink-3').trim(),
    cmd: cmd?.textContent, cmdOneLine: cmd ? getComputedStyle(cmd).whiteSpace : '', out: r.querySelector('.step-out .out')?.textContent, st: st?.textContent, mark: !!st?.querySelector('.ind .chk'), details: !!r.querySelector('details'), input: !!r.querySelector('input, textarea'), link: r.dataset.bg, band: !!r.querySelector('.prompt') }; })()`);
check('the row: ● Bash(description), then a grey $ in the gutter and the command, on one line', shape.dot === '●' && shape.head === 'Bash(List the demo folder)' && shape.ps === '$' && shape.cmd === 'ls -la /Users/fixture/dev/demo' && shape.cmdOneLine === 'nowrap', JSON.stringify(shape));
check('the $ has no band and no fill: the gutter text in grey', !shape.band && await ev(`(() => { const ps = ${ROW}.querySelector('.g.ps'), st = getComputedStyle(ps); return st.backgroundColor === 'rgba(0, 0, 0, 0)' && st.color === getComputedStyle(document.querySelector('.qbody .cmd .ps') || ps).color; })()`), JSON.stringify(shape));
check('the $ is grey, not the step dot\'s green', await ev(`getComputedStyle(${ROW}.querySelector('.g.ps')).color !== getComputedStyle(${ROW}.querySelector(':scope > .g')).color`));
check('its last lines in the output panel, then "Finished" with the check mark', shape.out === 'notes.md\nREADME.md' && /^Finished/.test(shape.st || '') && shape.mark, JSON.stringify(shape));
{ const p = await ev(`(() => { ${ROW}.querySelector('.step-out .out').id = 'st-out'; return true; })()`) && await outPanel(c, '#st-out'); check('its output sits in the output panel', !!p && p.ok, JSON.stringify(p)); }
check('no expansion and no input field in the row', !shape.details && !shape.input && !!shape.link, JSON.stringify(shape));
// the same shape as your ! run: a recorded one, put in after it
await ev(`(() => { const s = __synopia.cur(); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'bang-shape', k: 'bang', ts: '2026-11-20T10:03:30.000Z', cmd: 'ls demo', sh: { out: 'notes.md\\nREADME.md\\n', err: '', cut: false, exit: 0 } }], total: s.total + 1 }); })()`);
await until(`!!document.querySelector('#log .bang[data-bang="bang-shape"]')`);
const same = await ev(`(() => { const a = ${ROW}, b = document.querySelector('#log .bang[data-bang="bang-shape"]');
  const sig = r => { const o = r.querySelector('.step-out .out'), st = r.querySelector('.res.rst'), so = getComputedStyle(o); return { rows: [...r.querySelectorAll('.step-out > .res')].map(x => x.className.replace(/\\s*(failed|waits)/, '')), corner: !!r.querySelector('.step-out > .res > .lcorner'), panel: [so.backgroundColor, so.borderTopWidth, so.borderRadius, so.paddingLeft].join(), mark: !!st.querySelector('.ind'), font: getComputedStyle(st).fontSize }; };
  return { claude: sig(a), yours: sig(b), bang: b.querySelector('.bang-cmd > .g').textContent, bangColor: getComputedStyle(b.querySelector('.bang-cmd > .g')).color, bandEdge: getComputedStyle(b.querySelector('.bang-cmd')).borderLeftColor }; })()`);
check('the same row shape for your ! run and Claude\'s Bash: output panel, guide, state line with its mark', JSON.stringify(same.claude) === JSON.stringify(same.yours), JSON.stringify(same));
check('yours on the pink ! band, Claude\'s with the $: the sign tells them apart', same.bang === '!' && /^rgb\((191, 57, 137|247, 120, 186)\)$/.test(same.bangColor) && same.bandEdge === same.bangColor, JSON.stringify(same));
await ev(`${ROW}.scrollIntoView({ block: 'center' })`);
await sleep(150);
if (shots) await shot(c, path.join(shots, `dollar-row-${theme}.png`), await clipOf('#log .ln.tool.runrow'));
// the click opens its shell view
const sid1 = await ev(`__synopia.current()`), bid = await ev(`${ROW}.dataset.bg`);
await ev(`${ROW}.querySelector('.step-out .out').click()`);
check('a click on the row opens its shell view', await until(`__synopia.view() === '${bid}' && !!document.querySelector('#log .bg-run')`, 3000));
const view = await ev(`(() => { const r = document.querySelector('#log .bg-run'); return { ps: r.querySelector(':scope > .g.ps')?.textContent, cmd: r.querySelector('.step-out .cmd')?.textContent, out: r.querySelector('.step-out .out')?.textContent, end: document.querySelector('#log .bg-end')?.textContent.trim(), head: document.querySelector('.c-head').textContent.replace(/\\s+/g, ' '), box: !!document.getElementById('run-in') || !!document.getElementById('msg') }; })()`);
check('its shell view: the $ and the command, its whole result, how it ended, no box', view.ps === '$' && view.cmd === 'ls -la /Users/fixture/dev/demo' && /notes\.md/.test(view.out || '') && /^Finished after/.test(view.end || '') && /Shell in Claude's turn/.test(view.head) && !view.box, JSON.stringify(view));
// the way back (2026-11-26): a run this short has no card in the panel, so the crumb at the title is the way
const CRUMB = `document.querySelector('.c-head > .c-title > .c-crumb[data-back]')`;
const back = await ev(`(() => { const b = ${CRUMB}, t = document.querySelector('.c-head > .c-title'); if (!b) return null; const br = b.getBoundingClientRect(), nr = t.querySelector('.c-name').getBoundingClientRect();
  return { text: b.textContent, first: t.firstElementChild === b, sameLine: br.top >= t.getBoundingClientRect().top - 0.5 && br.bottom <= t.getBoundingClientRect().bottom + 0.5 && br.right <= nr.left, color: getComputedStyle(b).color, link: getComputedStyle(document.body).getPropertyValue('--link').trim(),
    card: !!document.querySelector('.rail [data-bg="${bid}"]'), backs: document.querySelectorAll('.c-head [data-back]').length, title: __synopia.cur().title }; })()`);
check('the run has no card in the panel', !!back && !back.card, JSON.stringify(back));
check('its header starts with "‹ <session title>" on the title line, the one back link there', !!back && back.first && back.sameLine && back.text === '‹ ' + back.title && back.backs === 1, JSON.stringify(back));
if (shots) await shot(c, path.join(shots, `crumb-${theme}.png`), await clipOf('.c-head'));
await c.key('K', { shift: true, code: 'KeyK', vk: 75 });
check('K from a view with no card goes back to Main conversation', await until(`__synopia.view() === null`, 3000), await ev('__synopia.view()'));
await until(`!!${ROW}`, 3000); await ev(`${ROW}.click()`); await until(`__synopia.view() === '${bid}'`, 3000);
await c.key('J', { shift: true, code: 'KeyJ', vk: 74 });
check('J from it too', await until(`__synopia.view() === null`, 3000), await ev('__synopia.view()'));
await until(`!!${ROW}`, 3000); await ev(`${ROW}.click()`); await until(`__synopia.view() === '${bid}'`, 3000);
await ev(`${CRUMB}.click()`);
check('the crumb goes back to Main conversation, with its message box', await until(`__synopia.view() === null && __synopia.current() === '${sid1}' && !!document.getElementById('msg')`, 3000));

// ---------- the other steps still expand ----------
check('the search group shows', await until(`!!document.querySelector('details.fold .body details.step')`));
const step = (name) => `[...document.querySelectorAll('details.step')].find(d => d.querySelector('summary').textContent.includes(${JSON.stringify(name)}))`;
const click = (name) => ev(`${step(name)}.querySelector('summary').click()`);
await ev(`document.querySelector('details.fold').open = true`);
await click('Grep(TODO)');
await sleep(150);
const lines = () => ev(`(() => { const d = ${step('Grep(TODO)')}; return d.open ? d.querySelector('.out').textContent.split('\\n').length : 0; })()`);
check('a long result shows 20 lines', await lines() === 20);
check('the input of a search shows', (await ev(`${step('Grep(TODO)')}.querySelector('.cmd').textContent`)) === 'pattern: TODO');
check('"Show all 32 lines"', (await ev(`${step('Grep(TODO)')}.querySelector('[data-full]')?.textContent`)) === 'Show all 32 lines');
await ev(`${step('Grep(TODO)')}.querySelector('[data-full]').click()`);
check('show all loads the full result', await until(`(() => { const d = ${step('Grep(TODO)')}; return d && d.open && d.querySelector('.out').textContent.split('\\n').length === 32 && !d.querySelector('[data-full]'); })()`));
check('one toolOutput message', (await ev(`JSON.stringify(__synopia.sent('toolOutput'))`)) === JSON.stringify([{ t: 'toolOutput', sid: '11111111-0000-4000-8000-000000000001', agent: null, toolUseId: 'toolu_grep1' }]));
const before = await ev(`document.querySelector('details.fold').closest('[data-key]').dataset.key`);
await ev(`(() => { const s = __synopia.cur(), it = s.items.find(i => i.id === 'toolu_fetch1'); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ ...it, state: 'done', out: { text: 'made-up page', lines: 1, cut: false } }], total: s.total }); })()`);
await sleep(300);
check('the live update redrew the block', await ev(`!document.querySelector('details.fold .body').textContent.includes('running')`));
check('the step and the full result stay open, and the group', await ev(`${step('Grep(TODO)')}.open && ${step('Grep(TODO)')}.querySelector('.out').textContent.split('\\n').length === 32 && document.querySelector('details.fold').open && document.querySelector('[data-key="${before}"]') !== null`));
await ev(`document.querySelector('details.fold').closest('[data-key]').scrollIntoView({ block: 'start' })`);
await sleep(200);
const clip = await clipOf('details.fold');
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

// ---------- a running Bash step (R5.6, R7.1, R7.2) ----------
const reload = async (u, extra) => { await c.cdp('Page.navigate', { url: 'about:blank' }); await sleep(200); return c.load(u, extra); };
const LIVE = `document.querySelector('#log .liveln')`;
const OWN = `document.querySelector('#log .ln.tool.runrow[data-bg="toolu_live1"]')`;
await reload(`${url}#${S.slice(0, 8)}`, `__synopia.current() === '${S}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().items.some(i => i.id === 'toolu_live1' && i.since)`);
check('the live line names the running step', (await ev(`${LIVE}?.textContent.replace(/\\s+/g, ' ').trim()`)) === `Working Bash(${DESC})`, await ev(`${LIVE}?.outerHTML`));
const timer = () => ev(`${OWN}?.querySelector('.res.rst')?.textContent ?? ''`);
const t1 = await timer();
check('its row: "Output shows when it finishes", then "Running, 42s" from the SDK\'s elapsed time', /^Running, ((4|5)\ds|1m \d\ds)$/.test(t1) && (await ev(`${OWN}.querySelector('.res.note')?.textContent`)) === 'Output shows when it finishes', t1);
check('its command on one line under the $: the first line of a two-line command', (await ev(`${OWN}.querySelector('.step-out .cmd').textContent`)).startsWith('npm run build'));
await sleep(2100);
const t2 = await timer();
check('the timer ticks', t2 !== t1 && t2.startsWith('Running, '), `${t1} -> ${t2}`);
check('its card is in the panel (3 s on), without a sign, not counted as background work', await until(`(() => { const r = document.querySelector('.rail .now [data-bg="toolu_live1"]'); return !!r && !r.querySelector('.who') && /shell, started/.test(r.textContent) && /Nothing running in the background/.test(document.querySelector('.rail .main-row').textContent); })()`, 3000), await ev(`JSON.stringify([document.querySelector('.rail')?.textContent || 'no panel', __synopia.cur().items.map(i => [i.id, i.ts, i.cardAt, i.state])])`));
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
await sleep(100);
await shot(c, path.join(stateDir, 'steps-running.png'));
await ev(`${LIVE}.click()`);
check('a click on the live line opens its shell view', await until(`__synopia.view() === 'toolu_live1'`, 3000));
const rv = await ev(`({ head: document.querySelector('.c-head').textContent.replace(/\\s+/g, ' '), note: document.querySelector('#log .bg-run .res.note')?.textContent, cmd: document.querySelector('#log .bg-run .cmd')?.textContent, live: document.querySelector('#log .liveln')?.textContent.trim() })`);
check('its view: "Shell in Claude\'s turn", what it can show and how to see more, Running', /Running, .*\. Shell in Claude's turn, started/.test(rv.head) && /Claude waits for it/.test(rv.head) && /^Output shows when it finishes\. b, b sends it to the background/.test(rv.note || '') && /npm test/.test(rv.cmd || '') && /^Running/.test(rv.live || ''), JSON.stringify(rv));
await ev(`document.querySelector('.rail .main-row').click()`);
await until(`__synopia.view() === null`, 3000);
await ev(`${OWN}.click()`);
check('its row opens the same view', await until(`__synopia.view() === 'toolu_live1'`, 3000));
// the result lands while its view is open
fs.appendFileSync(fileOf(claude, S), rec(S, { timestamp: fresh(60), type: 'user', uuid: 's-r1', toolUseResult: { stdout: 'built 3 modules\n12 passing', stderr: '', interrupted: false },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live1', content: 'built 3 modules\n12 passing' }] } }));
check('its result lands in the open shell view: the output, then how it ended', await until(`/12 passing/.test(document.querySelector('#log .bg-run')?.textContent || '') && /^Finished after/.test(document.querySelector('#log .bg-end')?.textContent.trim() || '')`, 8000), await ev(`document.getElementById('log').textContent`));
await ev(`document.querySelector('[data-back]').click()`);
await until(`__synopia.view() === null`, 3000);
await sleep(200);
const done = await ev(`(() => { const r = ${OWN}; return r && { out: r.querySelector('.step-out .out')?.textContent, st: r.querySelector('.res.rst')?.textContent, note: !!r.querySelector('.res.note') }; })()`);
check('the row ends in place: its last lines and "Finished"', !!done && done.out === 'built 3 modules\n12 passing' && /^Finished/.test(done.st || '') && !done.note, JSON.stringify(done));
check('the live line no longer names it', !/Bash\(/.test(await ev(`${LIVE}?.textContent || ''`)));
// a session Synopia doesn't drive: the command and "Running", no note
await reload(`${url}#${N.slice(0, 8)}`, `__synopia.current() === '${N}' && !!__synopia.mounted() && __synopia.cur().items.some(i => i.id === 'toolu_ext1')`);
const EXT = `document.querySelector('#log .ln.tool.runrow[data-bg="toolu_ext1"]')`;
check('not driven: the command and "Running", no note', await until(`!!${EXT} && ${EXT}.querySelector('.cmd').textContent === 'sleep 30; echo built' && /^Running/.test(${EXT}.querySelector('.res.rst').textContent) && !${EXT}.querySelector('.res.note')`, 3000), await ev(`${EXT}?.textContent`));
c.print();
c.close();
