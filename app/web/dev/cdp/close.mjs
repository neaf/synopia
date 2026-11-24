// x, x closes the session (R3.6, R9), on a made-up fixture with the fake driver.
// usage: node close.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node close.mjs <url> <state-dir> <claude-dir>
// Checks: no Close button; the first x turns the message box into the prompt, with what will stop, or the
// "Remove it from Synopia?" prompt for a session another process drives; another key, a click and a session
// switch cancel it; Esc and x replace each other's prompt; x types in insert mode; the second x sends
// `close {sid}` with no dialog, the row goes, and the Open list brings it back in its place in its group.
// The fake driver doesn't close or list sessions: the check answers `close`, `listRecent` and `openSession`
// in the page as the real backend does (`removed`, `recent`, `session`). Writes close-asking.png.
import fs from 'node:fs';
import path from 'node:path';

const A = 'c1c1c1c1-0000-4000-8000-0000000000c1'; // driven, working: a turn, two subagents and a shell
const C = 'c1c1c1c1-0000-4000-8000-0000000000c2'; // driven, idle
const B = 'c1c1c1c1-0000-4000-8000-0000000000c3'; // not driven: its status comes from the transcript
const line = (o) => JSON.stringify(o) + '\n';
const ts = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const rec = (sid, o) => line({ cwd: '/tmp/synopia-close', sessionId: sid, ...o });
const you = (sid, uuid, s, text) => rec(sid, { type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: text } });
const said = (sid, uuid, s, text) => rec(sid, { type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (sid, uuid, s, id, toolUseResult, content) => rec(sid, { type: 'user', uuid, timestamp: ts(s), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

if (process.argv[2] === 'make') {
  const dir = path.join(process.argv[3], 'projects', '-tmp-synopia-close');
  fs.mkdirSync(path.join(dir, A, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${A}.jsonl`),
    you(A, 'a-u1', 0, 'Tidy the demo folder with two helpers.')
    + rec(A, { type: 'assistant', uuid: 'a-a1', timestamp: ts(1), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_c1', name: 'Agent', input: { description: 'Sort the demo images', subagent_type: 'general-purpose', prompt: 'made-up', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_c2', name: 'Agent', input: { description: 'List the old notes', subagent_type: 'Explore', prompt: 'made-up', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_csh', name: 'Bash', input: { command: 'npx serve demo', description: 'Serve the demo', run_in_background: true } }] } })
    + result(A, 'a-u2', 2, 'toolu_c1', { status: 'async_launched', agentId: 'cccc0001', description: 'd', prompt: 'p', outputFile: '/tmp/o1' }, 'Async agent launched successfully.')
    + result(A, 'a-u3', 2, 'toolu_c2', { status: 'async_launched', agentId: 'cccc0002', description: 'd', prompt: 'p', outputFile: '/tmp/o2' }, 'Async agent launched successfully.')
    + result(A, 'a-u4', 3, 'toolu_csh', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'csh1' }, 'Started in the background.'));
  for (const [id, desc, tu] of [['cccc0001', 'Sort the demo images', 'toolu_c1'], ['cccc0002', 'List the old notes', 'toolu_c2']]) {
    fs.writeFileSync(path.join(dir, A, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc, toolUseId: tu, spawnDepth: 1 }));
    fs.writeFileSync(path.join(dir, A, 'subagents', `agent-${id}.jsonl`), line({ type: 'user', uuid: `${id}-u1`, timestamp: ts(2), isSidechain: true, agentId: id, message: { role: 'user', content: `${desc}.` } }));
  }
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), you(C, 'c-u1', 0, 'Rename the demo notes.') + said(C, 'c-a1', 1, 'Renamed them.'));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), you(B, 'b-u1', 0, 'Read the demo notes.') + said(B, 'b-a1', 1, 'Read them.'));
  fs.writeFileSync(path.join(process.argv[3], 'fake-script.json'), JSON.stringify({ about: 'close.mjs: made up', steps: [
    { at: 0, sid: A, status: 'busy', ago: 60000 },
    { at: 0, sid: C, status: 'idle', ago: 60000 },
  ] }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
const dialogs = [];
c.onEvent((m) => { if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.type); c.cdp('Page.handleJavaScriptDialog', { accept: false }); } });
await c.load(`${url}#${A.slice(0, 8)}`, `current === '${A}' && cur().driven === true && agentsOf(cur()).length === 2 && store.sessions.has('${B}') && store.sessions.has('${C}')`);
// the backend's side of close and the Open list, as the real one answers (the fake driver doesn't)
await ev(`(() => {
  window.__sent = []; window.__saved = {}; const o = send;
  send = m => {
    __sent.push(m); o(m);
    if (m.t === 'close') { const { items, ...rest } = store.sessions.get(m.sid); __saved[m.sid] = JSON.parse(JSON.stringify(rest)); setTimeout(() => onMessage({ t: 'removed', id: m.sid }), 20); }
    if (m.t === 'listRecent') setTimeout(() => onMessage({ t: 'recent', filter: m.filter, sessions: Object.values(__saved).map(s => ({ id: s.id, title: s.title, cwd: s.cwd, lastModified: Date.now() })) }), 20);
    if (m.t === 'openSession' && __saved[m.id]) setTimeout(() => { onMessage({ t: 'session', ...__saved[m.id] }); delete __saved[m.id]; }, 20);
  };
  // a group with all three, the working session in the middle
  layout = { groups: [{ id: 'g-close', name: 'Demo work', ids: ['${C}', '${A}', '${B}'] }], others: [] }; saveLayout(); renderAll();
})()`);
const K = {
  x: () => key('x', { code: 'KeyX', vk: 88 }), j: () => key('j', { code: 'KeyJ', vk: 74 }), i: () => key('i', { code: 'KeyI', vk: 73 }),
  b: () => key('b', { code: 'KeyB', vk: 66 }), esc: () => key('Escape', { code: 'Escape', vk: 27 }),
  next: () => key(']', { code: 'BracketRight', vk: 221, meta: true, shift: true }), prev: () => key('[', { code: 'BracketLeft', vk: 219, meta: true, shift: true }),
};
const asking = () => ev(`(() => { const p = document.querySelector('.composer.asking .int-ask'); return p && getComputedStyle(p).display !== 'none' ? p.textContent : null; })()`);
const closes = () => ev(`__sent.filter(m => m.t === 'close')`);
const ASK = 'Close this session? x again. Any other key to keep it.';
const group = () => ev(`[...document.querySelectorAll('#groups [data-group="g-close"] .row')].map(r => r.dataset.id)`);

check('no Close button in the header, nothing with data-close on the page', await ev(`!document.querySelector('[data-close]') && ![...document.querySelectorAll('.c-head button')].some(b => /close/i.test(b.textContent))`));
check('starts in normal mode, nothing asked', (await ev('document.body.dataset.mode')) === 'normal' && (await asking()) === null);
check('the group holds the three sessions in order', JSON.stringify(await group()) === JSON.stringify([C, A, B]), JSON.stringify(await group()));

await K.x();
check('first x on a working session: the prompt names what will stop', (await asking()) === `${ASK} Claude's turn, 2 subagents and 1 shell will stop.`, await asking());
await c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, 'close-asking.png'), Buffer.from(r.result.data, 'base64')));
await K.j();
check('another key cancels it, nothing sent, still normal', (await asking()) === null && (await closes()).length === 0 && (await ev('document.body.dataset.mode')) === 'normal');

await K.x();
await ev(`(() => { const r = document.querySelector('#log .log-inner').getBoundingClientRect(); document.querySelector('#log').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
check('a click cancels it', (await asking()) === null && (await closes()).length === 0);

await K.x(); await K.next();
check('switching sessions cancels it', await c.until(`current !== '${A}'`) && (await asking()) === null && (await closes()).length === 0, await ev('current'));
await K.prev();
check('back on the working session', await c.until(`current === '${A}' && !!mounted`));
await K.x();
check('the prompt there again, not carried over: one x asks', (await asking())?.startsWith(ASK), await asking());
await K.esc();
check('Esc under it: "Interrupt?" replaces it', /^Interrupt\?/.test(await asking() || ''));
await K.x();
check('x under "Interrupt?": the close prompt replaces it', (await asking())?.startsWith(ASK) && (await ev('interruptAsk === null')));
await K.b();
check('b with nothing to send to the background cancels it', (await asking()) === null && (await closes()).length === 0);

await K.i(); await K.x();
check('insert mode: x types, nothing asked', (await ev('document.getElementById("msg").value')) === 'x' && (await asking()) === null);
await ev('document.getElementById("msg").value = ""'); await K.esc();
check('Esc back to normal', (await ev('document.body.dataset.mode')) === 'normal' && (await asking()) === null);

// an idle session: nothing to stop
await ev(`document.querySelector('.row[data-id="${C}"]').click()`); await ev('document.activeElement.blur()');
await c.until(`current === '${C}' && !!mounted`);
await K.x();
check('an idle session: the prompt alone', (await asking()) === ASK, await asking());
await K.j();
// a session another process drives: only removed from Synopia
await ev(`document.querySelector('.row[data-id="${B}"]').click()`); await ev('document.activeElement.blur()');
check('the other session is not driven', await c.until(`current === '${B}' && !!mounted && cur().driven === false`));
await K.x();
check('not driven: "Remove it from Synopia?"', (await asking()) === 'Remove it from Synopia? x again. Its other process keeps running.', await asking());
await K.j();
check('cancelled, nothing sent', (await asking()) === null && (await closes()).length === 0);

// the second x closes the working session, with no dialog
await ev(`document.querySelector('.row[data-id="${A}"]').click()`); await ev('document.activeElement.blur()');
await c.until(`current === '${A}' && !!mounted`);
await ev(`window.confirm = () => { window.__confirmed = true; return true; }`);
await K.x(); await K.x();
const s1 = await closes();
check('second x: sends close {sid}', s1.length === 1 && s1[0].sid === A, JSON.stringify(s1));
check('no confirm dialog', dialogs.length === 0 && (await ev('window.__confirmed === undefined')), JSON.stringify(dialogs));
check('the row is gone from the sidebar and another session shows', await c.until(`!document.querySelector('.row[data-id="${A}"]') && current && current !== '${A}'`));
check('the group keeps its place for it', JSON.stringify(await group()) === JSON.stringify([C, B]) && (await ev(`layout.groups[0].ids.includes('${A}')`)));

// back through the Open list, in its place in its group
await ev(`document.getElementById('open').click()`);
check('the Open list lists it', await c.until(`[...document.querySelectorAll('#ol-list .ol-it .n')].some(n => n.textContent === __saved['${A}']?.title)`));
await key('Enter', { code: 'Enter', vk: 13 });
check('opening it shows it', await c.until(`current === '${A}' && !!mounted`));
check('it is back between the same two sessions', JSON.stringify(await group()) === JSON.stringify([C, A, B]), JSON.stringify(await group()));
await sleep(50);
c.print(); c.close();
