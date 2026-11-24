// b, b (R9): send the running foreground steps to the background, on a made-up fixture with the fake driver.
// usage: node background.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node background.mjs <url> <state-dir> <claude-dir>
// Checks: the first b marks the steps that can go (a foreground Bash, a foreground Agent; not a background
// one) and turns the message box into the prompt; another key, a click or the turn ending cancels it; the
// second b sends `background {sid}`; Esc and b replace each other's prompt; nothing in a session Synopia
// doesn't drive; b types in insert mode. Writes background-asking.png.
import fs from 'node:fs';
import path from 'node:path';

const A = 'b0b0b0b0-0000-4000-8000-0000000000b1'; // driven: the fake driver gives it a status
const B = 'b0b0b0b0-0000-4000-8000-0000000000b2'; // not driven: its status comes from the transcript
const line = (o) => JSON.stringify(o) + '\n';
const ts = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString(); // fresh: the turn reads running
const rec = (sid, o) => line({ cwd: '/tmp/synopia-background', sessionId: sid, ...o });
const you = (sid, uuid, s, text) => rec(sid, { type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: text } });
const tool = (sid, uuid, s, id, name, input) => rec(sid, { type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

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
  fs.writeFileSync(path.join(process.argv[3], 'fake-script.json'), JSON.stringify({ about: 'background.mjs: made up', steps: [
    { at: 0, sid: A, status: 'busy', ago: 60000 },
    // the CLI registers a foreground step as a task about 2 s in: only then can it go
    { at: 0, sid: A, task: { toolUseId: 'toolu_bsleep', taskId: 'bsl1' } },
    { at: 0, sid: A, task: { toolUseId: 'toolu_bfg', taskId: 'abfg1' } },
    { at: 0, sid: B, task: { toolUseId: 'toolu_bother', taskId: 'bot1' } },
  ] }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(`${url}#${A.slice(0, 8)}`, `current === '${A}' && cur().items.some(i => i.id === 'toolu_bfg') && cur().driven === true`);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const K = {
  b: () => key('b', { code: 'KeyB', vk: 66 }), x: () => key('x', { code: 'KeyX', vk: 88 }),
  j: () => key('j', { code: 'KeyJ', vk: 74 }), i: () => key('i', { code: 'KeyI', vk: 73 }),
  esc: () => key('Escape', { code: 'Escape', vk: 27 }),
};
const asking = () => ev(`(() => { const p = document.querySelector('.composer.asking .int-ask'); return p && getComputedStyle(p).display !== 'none' ? p.textContent : null; })()`);
const marked = () => ev(`document.getElementById('log').classList.contains('bg-asking') ? [...document.querySelectorAll('#log [data-fg]')].map(el => el.textContent.trim().split('\\n')[0]) : []`);
const sent = () => ev(`__sent.filter(m => m.t === 'background' || m.t === 'interrupt')`);
const PROMPT = 'Send to background? b again. Any other key to keep it in front.';

check('starts in normal mode, nothing asked', (await ev('document.body.dataset.mode')) === 'normal' && (await asking()) === null);
check('the steps that can go carry the mark, the background Agent not', (await ev(`document.querySelectorAll('#log [data-fg]').length`)) === 2
  && (await ev(`!!document.querySelector('#log .ln.tool[data-fg]') && !!document.querySelector('#log .wgrid [data-fg]')`)), await ev(`document.querySelectorAll('#log [data-fg]').length`));
check('no highlight before b', (await marked()).length === 0);

await K.b();
check('first b: the prompt in the message box', (await asking()) === PROMPT, await asking());
const m = await marked();
check('first b: the Bash line and the foreground subagent are highlighted', m.length === 2 && /Bash/.test(m[0]) && /Look around/.test(m[1]), JSON.stringify(m));
const look = await ev(`(() => { const el = document.querySelector('#log .ln.tool[data-fg]'), cs = getComputedStyle(el); return { bg: cs.backgroundColor, sh: cs.boxShadow, anim: el.getAnimations().length, h: el.getBoundingClientRect().height }; })()`);
check('the highlight: selection tint and a 1px blue ring, no animation of its own', look.bg === 'rgb(221, 244, 255)' && /rgb\(84, 174, 255\) 0px 0px 0px 4px/.test(look.sh) && look.anim === 0, JSON.stringify(look));
check('the background Agent is not highlighted', !(await ev(`[...document.querySelectorAll('#log .wgrid [data-fg]')].some(el => /Draft the notes/.test(el.textContent))`)));
await c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, 'background-asking.png'), Buffer.from(r.result.data, 'base64')));
const before = await ev(`document.querySelector('#log .ln.tool[data-fg]').getBoundingClientRect().top`);

await K.x();
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
await K.esc(); await K.x();
check('Esc then x: the interrupt prompt alone, still nothing sent', (await asking()) === null && (await sent()).length === 1);

// the turn ending, or the steps going to the background some other way, cancels it
await K.b();
await ev(`onMessage({ t: 'session', id: '${A}', status: 'idle', statusAt: Date.now() })`);
check('the turn ending cancels it', (await asking()) === null && (await marked()).length === 0);
await K.b();
check('with the turn over, b asks nothing', (await asking()) === null);
await ev(`onMessage({ t: 'session', id: '${A}', status: 'busy', statusAt: Date.now() })`);
await K.b();
await ev(`onMessage({ t: 'items', sid: '${A}', agent: null, total: cur().total, upsert: cur().items.filter(i => i.fg).map(i => { const { fg, ...rest } = i; return rest; }) })`);
check('the steps no longer foreground: cancelled', (await asking()) === null && (await marked()).length === 0);
await K.b();
check('with nothing that can go, b asks nothing', (await asking()) === null && (await sent()).length === 1);

// insert mode: b types
await K.i(); await K.b();
check('insert mode: b types', (await ev('document.getElementById("msg").value')) === 'b' && (await asking()) === null);
await ev('document.getElementById("msg").value = ""'); await K.esc();

// a session Synopia doesn't drive: the first b does nothing
await ev(`document.querySelector('.row[data-id="${B}"]').click()`); await ev('document.activeElement.blur()');
check('the other session: not driven, its Bash runs in the foreground', await c.until(`current === '${B}' && cur().driven === false && cur().items.some(i => i.id === 'toolu_bother' && i.fg && i.state === 'running')`),
  JSON.stringify(await ev(`({ current, driven: cur()?.driven, items: cur()?.items.map(i => [i.id, i.fg, i.state]) })`)));
await K.b();
check('not driven: b asks nothing and sends nothing', (await asking()) === null && (await marked()).length === 0 && (await sent()).length === 1);
await sleep(50);
c.print(); c.close();
