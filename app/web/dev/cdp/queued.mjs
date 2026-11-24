// Messages sent while a turn runs show pending (R5.5), on a made-up fixture with the fake driver.
// usage: node queued.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node queued.mjs <url> <state-dir> <claude-dir>
// Checks: two messages sent during a turn show in order as dimmed prompt bands with "Queued" and the
// moving queued mark, between the last step and the live line, which no longer says "queued"; the
// first lands (its prompt record appended to the fixture file) and turns into the normal prompt in its
// place, with no duplicate; Esc, Esc interrupts, the second disappears and its text is back in the box.
// A message sent while nothing runs isn't queued. Writes queued-two.png and queued-landed.png.
import fs from 'node:fs';
import path from 'node:path';

const A = 'a9a9a9a9-0000-4000-8000-0000000000a1'; // driven, working
const B = 'a9a9a9a9-0000-4000-8000-0000000000b2'; // driven, idle
const dirOf = (claude) => path.join(claude, 'projects', '-tmp-synopia-queued');
const line = (o) => JSON.stringify(o) + '\n';
const ts = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const rec = (sid, o) => line({ cwd: '/tmp/synopia-queued', sessionId: sid, ...o });
const you = (sid, uuid, s, text) => rec(sid, { type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: text } });
const said = (sid, uuid, s, text) => rec(sid, { type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (sid, uuid, s, id, command) => rec(sid, { type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run the demo tests' } }] } });
const FIRST = 'Also check the **demo** notes when you are done.';
const SECOND = 'And then rename the demo folder.';

if (process.argv[2] === 'make') {
  const dir = dirOf(process.argv[3]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), you(A, 'q-u1', 0, 'Run the demo tests.') + said(A, 'q-a1', 1, 'Running them now.') + tool(A, 'q-a2', 2, 'toolu_q1', 'npm test'));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), you(B, 'b-u1', 0, 'Read the demo notes.') + said(B, 'b-a1', 1, 'Read them.'));
  fs.writeFileSync(path.join(process.argv[3], 'fake-script.json'), JSON.stringify({ about: 'queued.mjs: made up', steps: [
    { at: 0, sid: A, status: 'busy', ago: 58000 },
    { at: 0, sid: B, status: 'idle', ago: 58000 },
  ] }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir, claude] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
const shot = (name) => c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, name), Buffer.from(r.result.data, 'base64')));
await c.load(`${url}#${A.slice(0, 8)}`, `current === '${A}' && !!mounted && cur().driven === true && cur().status === 'busy' && cur().items.length === 3`);
const sendText = (t) => ev(`(() => { const ta = document.getElementById('msg'); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
// the log's blocks in order: queued bands as q, your prompts as you, the live line as live
const order = () => ev(`[...document.querySelectorAll('#log .log-inner > *')].map(e => e.matches('.prompt.queued') ? 'q:' + e.querySelector('.md').textContent.replace('Queued, goes to Claude at its next step', '').trim()
  : e.matches('.prompt') ? 'you:' + e.textContent.replace('❯', '').trim() : e.matches('.liveln') ? 'live' : '').filter(Boolean)`);
const queuedRows = () => ev(`document.querySelectorAll('#log .prompt.queued').length`);

await sendText(FIRST);
await sendText(SECOND);
check('two queued bands show', await c.until(`document.querySelectorAll('#log .prompt.queued').length === 2`), String(await queuedRows()));
const o1 = await order();
check('in the order sent, after the last prompt and just above the live line',
  JSON.stringify(o1.slice(-3)) === JSON.stringify(['q:Also check the demo notes when you are done.', 'q:And then rename the demo folder.', 'live']), JSON.stringify(o1));
check('the band is the prompt band (❯, markdown rendered) with a quiet Queued label',
  await ev(`(() => { const q = document.querySelector('#log .prompt.queued'); return q.querySelector('.g').textContent === '❯' && !!q.querySelector('.md b') && q.querySelector('.qlabel').textContent === 'Queued, goes to Claude at its next step'; })()`));
check('no ALL CAPS in the label', await ev(`getComputedStyle(document.querySelector('#log .qlabel')).textTransform === 'none'`));
check('dimmed: its text in the faint ink, unlike a sent prompt', await ev(`(() => { const q = getComputedStyle(document.querySelector('#log .prompt.queued .md')).color, p = getComputedStyle(document.querySelector('#log .prompt:not(.queued) .md')).color; return q !== p && q === getComputedStyle(document.querySelector('#log .prompt.queued .qlabel')).color; })()`));
check('shape, not only colour: a dashed edge, no fill', await ev(`(() => { const st = getComputedStyle(document.querySelector('#log .prompt.queued')); return st.borderLeftStyle === 'dashed' && st.backgroundColor === 'rgba(0, 0, 0, 0)'; })()`));
const anim = await ev(`(() => { const r = document.querySelector('#log .qlabel .ind .rot'); if (!r) return 'no mark'; const a = r.getAnimations()[0]; const st = getComputedStyle(r); return a ? [st.animationIterationCount, st.animationTimingFunction, a.playState].join(' ') : 'still'; })()`);
check('the queued mark (blue centre) turns: linear, infinite, running', anim === 'infinite linear running', anim);
check('the label mark is the queued one', await ev(`!!document.querySelector('#log .qlabel .ind circle[fill="var(--mk-0550AE)"]')`));
check('the live line keeps Working, without the "queued" sentence', await ev(`(() => { const l = document.querySelector('#log .liveln'); return /Working/.test(l.textContent) && !/queued/.test(l.textContent); })()`), await ev(`document.querySelector('#log .liveln')?.textContent`));
check('the sidebar mark says queued (blue centre)', await ev(`!!document.querySelector('.row[data-id="${A}"] .ind circle[fill="var(--mk-0550AE)"]')`));
await shot('queued-two.png');

// the first lands: the CLI writes it as a queued_command attachment of its own uuid
const file = path.join(dirOf(claude), `${A}.jsonl`);
fs.appendFileSync(file, rec(A, { type: 'attachment', uuid: 'q-land1', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: FIRST, commandMode: 'prompt' } }));
check('the first landed: one queued band left', await c.until(`document.querySelectorAll('#log .prompt.queued').length === 1 && cur().items.some(i => i.id === 'q-land1')`, 8000), String(await queuedRows()));
const o2 = await order();
check('it became the normal prompt in its place, once, the second still queued below it',
  JSON.stringify(o2.slice(-3)) === JSON.stringify(['you:Also check the demo notes when you are done.', 'q:And then rename the demo folder.', 'live'])
  && o2.filter((x) => x.includes('Also check')).length === 1, JSON.stringify(o2));
// never both at once, never neither: watch every log change from here while the backend drops it
await ev(`(() => { window.__seen = []; const f = () => { const n = [...document.querySelectorAll('#log .prompt')].filter(p => /Also check/.test(p.textContent)).length; __seen.push(n); };
  new MutationObserver(f).observe(document.getElementById('log'), { childList: true, subtree: true }); })()`);
await sleep(1500);
check('after the backend drops it from the outbox: still exactly one, never two or none', await ev(`__seen.every(n => n === 1) && document.querySelectorAll('#log .prompt.queued').length === 1 && cur().outbox.length === 1`), await ev(`JSON.stringify(__seen)`));
await shot('queued-landed.png');

// Esc, Esc interrupts: the second disappears and its text goes back to the box
await ev('document.activeElement.blur()');
await key('Escape', { code: 'Escape', vk: 27 }); await key('Escape', { code: 'Escape', vk: 27 });
check('interrupted: no queued band left', await c.until(`document.querySelectorAll('#log .prompt.queued').length === 0`), String(await queuedRows()));
check('its text is back in the message box', await c.until(`document.getElementById('msg').value === ${JSON.stringify(SECOND)}`), await ev(`document.getElementById('msg').value`));
check('the landed prompt stays', (await order()).filter((x) => x === 'you:Also check the demo notes when you are done.').length === 1);

// nothing runs: a message isn't queued
await ev(`document.querySelector('.row[data-id="${B}"]').click()`);
await c.until(`current === '${B}' && !!mounted`);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
await sendText('Read them again.');
await sleep(400);
check('idle session: sent, nothing shows queued', (await ev(`__sent.filter(m => m.t === 'send').length`)) === 1 && (await queuedRows()) === 0 && (await ev(`cur().outbox.length`)) === 0);
c.print(); c.close();
