// b, b (R9): send the running foreground steps to the background, on a made-up fixture with the scripted SDK.
// usage: node background.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node background.mjs <url> <state-dir> <claude-dir>
// Checks: the first b marks the steps that can go (a foreground Bash, a foreground Agent; not a background
// one) and turns the message box into the prompt; another key, a click or the turn ending cancels it; the
// second b sends `background {sid}`; Esc and b replace each other's prompt; nothing in a session Synopia
// doesn't drive; b types in insert mode; a step the live line names is marked there only, not on its group
// run row, also after a redraw and when the live line re-renders; the live line names a subagent by its kind tag and
// name, a Bash as Bash(…), never a background subagent while the turn runs; once the main turn is over there is no
// live line at all, even with a background shell and subagent running: the transcript ends with "Worked for"
// (2026-11-26). Writes background-asking.png and background-live.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, fresh, keyTable, spySent, writeScript, running, shot } from './helpers.mjs';

const A = 'b0b0b0b0-0000-4000-8000-0000000000b1'; // driven: Synopia's process runs its turn
const B = 'b0b0b0b0-0000-4000-8000-0000000000b2'; // not driven: its turn runs in another process (the transcript)
const ts = fresh; // fresh: the turn reads running
const { rec, you, tool } = records('/tmp/synopia-background');

if (process.argv[2] === 'make') {
  const dir = path.join(process.argv[3], 'projects', '-tmp-synopia-background');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${A}.jsonl`),
    you(A, 'a-u1', 0, 'Wait for the build, then look around the demo folder.')
    + tool(A, 'a-a1', 1, 'toolu_bsleep', 'Bash', { command: 'sleep 40; echo done', description: 'Wait for the build' })
    + rec(A, { type: 'assistant', uuid: 'a-a2', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'text', text: 'Two subagents meanwhile.' }] } })
    + tool(A, 'a-a3', 3, 'toolu_bfg', 'Agent', { description: 'Look around the demo folder', subagent_type: 'Explore', prompt: 'made-up' })
    + tool(A, 'a-a4', 3, 'toolu_bbg', 'Agent', { description: 'Draft the notes', prompt: 'made-up', run_in_background: true }));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`),
    you(B, 'b-u1', 0, 'Run the slow tests.')
    + tool(B, 'b-a1', 1, 'toolu_bother', 'Bash', { command: 'sleep 60', description: 'Run the slow tests' }));
  const task = (tool_use_id, task_id) => ({ message: { type: 'system', subtype: 'task_started', tool_use_id, task_id, description: 'made-up' } });
  // the CLI registers a foreground step as a task about 2 s in: only then can it go
  writeScript(process.argv[3], 'background.mjs: made up', { [A]: { start: true, steps: [running(60000), task('toolu_bsleep', 'bsl1'), task('toolu_bfg', 'abfg1')] } });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(`${url}#${A.slice(0, 8)}`, `__synopia.current() === '${A}' && __synopia.cur().items.some(i => i.id === 'toolu_bfg') && __synopia.cur().state.driven === true`);
const sentOf = await spySent(c);
const K = keyTable(key); // b, l (x has its own prompt, close.mjs), j, i, esc
const asking = () => ev(`(() => { const p = document.querySelector('.composer.asking .int-ask'); return p && getComputedStyle(p).display !== 'none' ? p.textContent : null; })()`);
const marked = () => ev(`document.getElementById('log').classList.contains('bg-asking') ? [...document.querySelectorAll('#log [data-fg]')].map(el => el.textContent.trim().split('\\n')[0]) : []`);
const sent = () => sentOf('background', 'interrupt');
const PROMPT = 'Send to background? b again. Any other key to keep it in front.';

check('starts in normal mode, nothing asked', (await ev('document.body.dataset.mode')) === 'normal' && (await asking()) === null);
// the live line names the turn's own step, the foreground subagent, as the panel does: kind tag and name, no Agent(…)
const liveText = () => ev(`document.querySelector('#log .liveln')?.textContent.trim().replace(/\\s+/g, ' ') ?? null`);
const liveKind = () => ev(`[...document.querySelectorAll('#log .liveln .kind')].map(k => k.className + ':' + k.textContent)`);
check('the live line names the running foreground subagent by its kind tag and name, not Agent(…)', (await liveText()) === 'Working subagent Look around the demo folder'
  && JSON.stringify(await liveKind()) === JSON.stringify(['kind kd-sub:subagent']), JSON.stringify([await liveText(), await liveKind()]));
// The rule breaks only for the mark and the words: on a wide and a narrow panel, nothing opaque between the
// live line and the point a few px past the label's last glyph, the middle of the rest, and the panel's right edge,
// while the last glyph itself sits on the break. Measured against the words' own range rect, through elementFromPoint.
const ruleClear = async (what) => {
  for (const width of [2000, 760]) {
    await c.cdp('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    const m = await ev(`(() => { const L = document.querySelector('#log .liveln'); L.scrollIntoView({ block: 'center' });
      const words = L.querySelector('summary, .lh'), r = document.createRange(); r.selectNodeContents(words);
      const rs = [...r.getClientRects()].filter(x => x.width), last = rs[rs.length - 1], box = L.getBoundingClientRect();
      const y = rs[0].top + parseFloat(getComputedStyle(words).lineHeight) / 2; // the rule's line: the first line's middle
      const opaque = x => { for (let el = document.elementFromPoint(x, y); el && el !== L; el = el.parentElement) { const bg = getComputedStyle(el).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true; } return false; };
      const pts = [last.right + 10, (last.right + box.right) / 2, box.right - 3];
      return { onGlyph: opaque(last.right - 2), clear: pts.map(x => !opaque(x)), lines: rs.length, right: Math.round(last.right), edge: Math.round(box.right) }; })()`);
    check(`${what}, ${width}px: the rule shows from a few px past the words to the panel's edge`, m.onGlyph && m.clear.length === 3 && m.clear.every(Boolean), JSON.stringify(m));
  }
  await c.cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(120);
};
await ruleClear('a subagent named');
check('the background subagent is flagged as background work', await ev(`__synopia.cur().items.some(i => i.id === 'toolu_bbg' && i.bg === true && i.state === 'running') && !__synopia.cur().items.find(i => i.id === 'toolu_bfg').bg`));
check('the steps that can go carry the mark, the background Agent not', (await ev(`document.querySelectorAll('#log [data-fg]').length`)) === 2
  && (await ev(`!!document.querySelector('#log .ln.tool[data-fg]') && !!document.querySelector('#log .liveln[data-fg]')`)), await ev(`document.querySelectorAll('#log [data-fg]').length`));
check('no highlight before b', (await marked()).length === 0);

await K.b();
check('first b: the prompt in the message box', (await asking()) === PROMPT, await asking());
const m = await marked();
check('first b: the Bash line and the foreground subagent are highlighted', m.length === 2 && /Bash/.test(m[0]) && /Look around/.test(m[1]), JSON.stringify(m));
const look = await ev(`(() => { const el = document.querySelector('#log .ln.tool[data-fg]'), cs = getComputedStyle(el); return { bg: cs.backgroundColor, sh: cs.boxShadow, anim: el.getAnimations().length, h: el.getBoundingClientRect().height }; })()`);
const dark = process.env.SYNOPIA_CDP_THEME === 'dark'; // the tint and ring of the theme the check runs in
check('the highlight: selection tint and a 1px blue ring, no animation of its own', look.bg === (dark ? 'rgb(31, 59, 92)' : 'rgb(221, 244, 255)') && (dark ? /rgb\(68, 147, 248\) 0px 0px 0px 4px/ : /rgb\(84, 174, 255\) 0px 0px 0px 4px/).test(look.sh) && look.anim === 0, JSON.stringify(look));
check('the background Agent is not highlighted', !(await ev(`[...document.querySelectorAll('#log .wgrid [data-fg]')].some(el => /Draft the notes/.test(el.textContent))`)));
await c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, 'background-asking.png'), Buffer.from(r.result.data, 'base64')));
const before = await ev(`document.querySelector('#log .ln.tool[data-fg]').getBoundingClientRect().top`);

await K.l();
check('another key: the prompt and the highlight go, nothing sent', (await asking()) === null && (await marked()).length === 0 && (await sent()).length === 0);
check('the highlight moved nothing', (await ev(`document.querySelector('#log .ln.tool[data-fg]').getBoundingClientRect().top`)) === before);
check('that key did nothing else (still normal, box empty)', (await ev('document.body.dataset.mode')) === 'normal' && (await ev('document.getElementById("msg").value')) === '');

await K.b(); await K.b();
const s1 = await sent();
check('second b: sends background {sid}', s1.length === 1 && s1[0].t === 'background' && s1[0].sid === A, JSON.stringify(s1));
check('second b: the prompt and the highlight go', (await asking()) === null && (await marked()).length === 0);

await K.b();
await ev(`(() => { const r = document.querySelector('#log .log-inner').getBoundingClientRect(); document.querySelector('#log').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
check('a click cancels it', (await asking()) === null && (await marked()).length === 0 && (await sent()).length === 1);

// one prompt at a time: the newest replaces the other
await K.b(); await K.esc();
check('Esc under it: "Interrupt?" replaces it, the highlight goes', /^Interrupt\?/.test(await asking() || '') && (await marked()).length === 0);
await K.b();
check('b under "Interrupt?": the background prompt replaces it', (await asking()) === PROMPT && (await marked()).length === 2);
await K.j();
check('j cancels it, nothing sent', (await asking()) === null && (await sent()).length === 1);
await K.esc(); await K.l();
check('Esc then l:the interrupt prompt alone, still nothing sent', (await asking()) === null && (await sent()).length === 1);

// the live line names a foreground Bash (the newest step, after a finished Read): the mark is on the live line
// only, not on its own run row; the earlier Bash and the subagent the live line doesn't name keep theirs where they are shown
const step = (o) => `(s => { const b = s.items.find(i => i.id === 'toolu_bsleep'); return { ...b, ...${JSON.stringify(o)} }; })(__synopia.cur())`;
const addLive = (o = {}) => ev(`(s => __synopia.inject({ t: 'items', sid: '${A}', agent: null, total: s.total + ['toolu_bread', 'toolu_blive'].filter(id => !s.items.some(i => i.id === id)).length, upsert: [${step({ id: 'toolu_bread', name: 'Read', verb: 'Read', obj: 'README.md', state: 'done', fg: false })}, ${step({ id: 'toolu_blive', obj: 'npm run build', ...o })}] }))(__synopia.cur())`);
await addLive();
await c.until(`!!document.querySelector('#log .liveln') && /Bash\\(npm run build\\)/.test(document.querySelector('#log .liveln').textContent)`);
const where = () => ev(`(() => { const g = document.querySelector('#log .runrow[data-bg="toolu_blive"]'); return {
  live: document.querySelector('#log .liveln')?.hasAttribute('data-fg'), group: !g || g.hasAttribute('data-fg') || !!g.querySelector('[data-fg]'),
  sleep: !!document.querySelector('#log .ln.tool[data-fg]:not(.liveln)') && /sleep 40/.test(document.querySelector('#log .ln.tool[data-fg]:not(.liveln)').textContent), agent: !!document.querySelector('#log .wgrid [data-fg]'),
  n: document.querySelectorAll('#log [data-fg]').length }; })()`);
const w0 = await where();
check('live line names the foreground Bash: the mark is on the live line, not its own run row', w0.live === true && w0.group === false && w0.sleep === true && w0.agent === true && w0.n === 3, JSON.stringify(w0));
await K.b();
check('first b: the prompt, the live line ringed', (await asking()) === PROMPT && (await ev(`(cs => /0px 0px 0px 4px/.test(cs.boxShadow))(getComputedStyle(document.querySelector('#log .liveln')))`)) === true);
const m2 = await marked();
check('first b: three steps marked once each, the live line one of them', m2.length === 3 && m2.filter(t => /npm run build/.test(t)).length === 1 && /^Working/.test(m2[2]), JSON.stringify(m2));
await ev(`__synopia.redraw()`);
const w1 = await where();
check('after a redraw: its run row is not marked, the live line still is', w1.live === true && w1.group === false, JSON.stringify(w1));
await addLive({ obj: 'npm run build:all' }); // the live line re-renders under the prompt
await c.until(`/build:all/.test(document.querySelector('#log .liveln')?.textContent || '')`);
const w2 = await where();
check('the live line re-rendered under the prompt: it keeps the mark, the prompt stays', w2.live === true && w2.group === false && (await asking()) === PROMPT && (await marked()).length === 3, JSON.stringify(w2));
await shot(c, path.join(stateDir, 'background-live.png'));
await K.l();
check('another key: the live line loses its ring too', (await asking()) === null && (await marked()).length === 0 && (await ev(`getComputedStyle(document.querySelector('#log .liveln')).boxShadow`)) === 'none');
await addLive({ state: 'done', fg: false }); // the step ends: the live line names nothing
check('the step done: the live line carries no mark', await c.until(`!document.querySelector('#log .liveln')?.hasAttribute('data-fg')`));

// the live line (R5.5): while the main turn runs it names only the turn's own foreground step, never the
// background subagent from before (the panel shows that)
const upsert = (list) => ev(`(s => __synopia.inject({ t: 'items', sid: '${A}', agent: null, total: s.total + ${JSON.stringify(list.map(i => i.id))}.filter(id => !s.items.some(i => i.id === id)).length, upsert: ${JSON.stringify(list)} }))(__synopia.cur())`);
const iso = new Date().toISOString();
await upsert([{ id: 'toolu_bfg', k: 'tool', ts: iso, name: 'Agent', verb: 'Agent', obj: 'Look around the demo folder', state: 'done', toolUseId: 'toolu_bfg' }]);
await upsert([{ id: 'b-u2', k: 'you', ts: iso, text: 'And the changelog?' }]);
check('a new turn thinking, a background subagent from before: just "Working"', await c.until(`document.querySelector('#log .liveln')?.textContent.trim() === 'Working'`), await liveText());
await ruleClear('"Working" alone');
await upsert([{ id: 'toolu_bnew', k: 'tool', ts: iso, name: 'Bash', verb: 'Bash', obj: 'git log -5', state: 'running', toolUseId: 'toolu_bnew' }]);
check('its foreground Bash: Bash(…), no Agent( and no kind tag', await c.until(`document.querySelector('#log .liveln')?.textContent.trim() === 'Working Bash(git log -5)'`)
  && (await liveKind()).length === 0, await liveText());
await ruleClear('a Bash named');
await upsert([{ id: 'toolu_bnew', k: 'tool', ts: iso, name: 'Bash', verb: 'Bash', obj: 'git log -5', state: 'done', toolUseId: 'toolu_bnew' }]);

// the turn ending, or the steps going to the background some other way, cancels it
await K.b();
await ev(`__synopia.inject({ t: 'session', id: '${A}', state: { ...__synopia.cur().state, status: 'idle', light: 'amber', tone: 'amber', word: 'Your turn', mark: 'stopped', since: Date.now() } })`);
check('the turn ending cancels it', (await asking()) === null && (await marked()).length === 0);
await K.b();
check('with the turn over, b asks nothing', (await asking()) === null);
await ev(`__synopia.inject({ t: 'session', id: '${A}', state: { ...__synopia.cur().state, status: 'busy', light: 'green', tone: 'green', word: 'Working', mark: 'work', since: Date.now() } })`);
await K.b();
await ev(`(s => __synopia.inject({ t: 'items', sid: '${A}', agent: null, total: s.total, upsert: s.items.filter(i => i.fg).map(i => { const { fg, ...rest } = i; return rest; }) }))(__synopia.cur())`);
check('the steps no longer foreground: cancelled', (await asking()) === null && (await marked()).length === 0);
await K.b();
check('with nothing that can go, b asks nothing', (await asking()) === null && (await sent()).length === 1);

// insert mode: b types
await K.i(); await K.b();
check('insert mode: b types', (await ev('document.getElementById("msg").value')) === 'b' && (await asking()) === null);
await ev('document.getElementById("msg").value = ""'); await K.esc();

// the main turn over, a background subagent and shell running: no live line at all (2026-11-26); the panel and
// the sidebar show them, and the transcript ends with the turn's "Worked for" line
const bgShell = { toolUseId: 'toolu_bgsh', taskId: 'bgsh1', kind: 'shell', description: 'Serve the demo', command: 'npm run dev', timeout: 0, persistent: false, start: iso, status: 'running', summary: '', end: null, cardAt: Date.parse(iso) + 3000, tail: '' };
const bgAgent = { id: 'abbg1', type: 'general-purpose', fork: false, description: 'Draft the notes', toolUseId: 'toolu_bbg', model: null, depth: 0, finished: false, running: true, review: false, stopped: false, start: iso, end: null, total: 0 };
await ev(`(s => __synopia.inject({ t: 'session', id: '${A}', agents: [...(s.agents || []).filter(a => a.toolUseId !== 'toolu_bbg'), ${JSON.stringify(bgAgent)}].map(a => a.toolUseId === 'toolu_bbg' || a.finished ? a : { ...a, finished: true, running: false }), background: [${JSON.stringify(bgShell)}],
  state: { ...s.state, status: 'idle', light: 'amber', tone: 'amber', word: 'Your turn', mark: 'stopped', since: Date.now() } }))(__synopia.cur())`);
await ev(`(s => __synopia.inject({ t: 'items', sid: '${A}', agent: null, total: s.total, upsert: [...s.items.filter(i => i.k === 'tool' && i.state === 'running').map(i => ({ ...i, state: 'done', fg: false })), { ...s.items.filter(i => i.k === 'you').pop(), workedMs: 42000 }] }))(__synopia.cur())`); // its turn_duration
check('the main turn over, a background shell and subagent running: no live line, the transcript ends with "Worked for"', await c.until(`!document.querySelector('#log .liveln') && /^Worked for /.test([...document.querySelectorAll('#log .log-inner > *')].filter(e => e.textContent.trim()).pop()?.textContent.trim() || '')`),
  JSON.stringify([await liveText(), await ev(`[...document.querySelectorAll('#log .log-inner > *')].slice(-2).map(e => e.className + ': ' + e.textContent.trim().slice(0, 80))`)]));
check('the panel shows what runs: Main conversation counts them (the shell once its card is due)', await c.until(`(document.querySelector('.rail .main-row .m')?.textContent || '') === '2 running in the background'`, 5000), await ev(`document.querySelector('.rail .main-row')?.textContent || ''`));

// a session Synopia doesn't drive: the first b does nothing. Its Bash runs in the other process's
// foreground (no SDK task of Synopia's marks it `fg`: task_started reaches only the process that runs it)
await ev(`document.querySelector('.row[data-id="${B}"]').click()`); await ev('document.activeElement.blur()');
check('the other session: not driven, its Bash runs in the foreground', await c.until(`(s => s?.id === '${B}' && s.state.driven === false && s.items.some(i => i.id === 'toolu_bother' && i.state === 'running') && !s.background.some(b => b.toolUseId === 'toolu_bother'))(__synopia.cur())`),
  JSON.stringify(await ev(`(s => ({ current: __synopia.current(), driven: s?.state.driven, items: s?.items.map(i => [i.id, i.fg, i.state]), background: s?.background.map(b => b.toolUseId) }))(__synopia.cur())`)));
await K.b();
check('not driven: b asks nothing and sends nothing', (await asking()) === null && (await marked()).length === 0 && (await sent()).length === 1);
await sleep(50);
c.print(); c.close();
