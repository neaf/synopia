// f, f (R9.8): send the queued messages now, on a made-up fixture with the scripted SDK.
// usage: node sendnow.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node sendnow.mjs <url> <state-dir> <claude-dir>
// Checks: with nothing queued and no draft f does nothing, silently; with two queued, the first f marks both
// queued bands (selection tint, 1px blue ring) and turns the box into the prompt; another key keeps them queued
// and sends nothing; Esc and f replace each other's prompt; with a draft, f, f sends one `sendNow` with it and
// the box empties; the backend's route (a foreground Bash: backgroundTasks) takes the queue in, and the bands
// land, and the Bash stays a step whose shell runs on in the background with its card, not struck through; insert mode types f; a
// session Synopia doesn't drive asks nothing. The interrupt route (2026-11-26, Claude only writing): the live
// line stays as a still record, struck through and greyed, "set aside for your messages", the reply it cut
// short greyed above it, and the queued message lands below it. Writes sendnow-asking-<theme>.png and
// sendnow-aside-<theme>.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, keyTable, spySent, writeScript, running, shot } from './helpers.mjs';

const A = 'f0f0f0f0-0000-4000-8000-0000000000a1'; // driven: Synopia's process runs its turn, a foreground Bash
const B = 'f0f0f0f0-0000-4000-8000-0000000000b2'; // not driven: its turn runs in another process
const C = 'f0f0f0f0-0000-4000-8000-0000000000c3'; // driven: Claude only writes a reply (the interrupt route)
const CUT = 'The notes cover the build, and the demo';
const LATER = 'Skip the notes, list the demo folders.';
const { you, said, tool } = records('/tmp/synopia-sendnow');
const FIRST = 'Also check the demo notes when you are done.';
const SECOND = 'And then rename the demo folder.';
const DRAFT = 'Then open a draft PR for the demo.';

if (process.argv[2] === 'make') {
  const dir = path.join(process.argv[3], 'projects', '-tmp-synopia-sendnow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), you(A, 'n-u1', 0, 'Build the demo, then run its tests.') + said(A, 'n-a1', 1, 'Building it first.')
    + tool(A, 'n-a2', 2, 'toolu_nbuild', 'Bash', { command: 'sleep 40; npm run build', description: 'Build the demo' }));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), you(B, 'm-u1', 0, 'Run the slow tests.') + tool(B, 'm-a1', 1, 'toolu_mother', 'Bash', { command: 'sleep 60', description: 'Run the slow tests' }));
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), you(C, 'w-u1', 0, 'Write up the demo notes.'));
  const se = (event) => ({ message: { type: 'stream_event', parent_tool_use_id: null, event } });
  const task = { message: { type: 'system', subtype: 'task_started', tool_use_id: 'toolu_nbuild', task_id: 'nbl1', description: 'made-up' } };
  writeScript(process.argv[3], 'sendnow.mjs: made up', { [A]: { start: true, steps: [running(58000), task] },
    [C]: { start: true, steps: [running(9000), se({ type: 'message_start', message: { id: 'msg_wcut' } }), se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CUT } })] } });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const c = await connect();
const { ev, check, key } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(`${url}#${A.slice(0, 8)}`, `__synopia.current() === '${A}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().state.status === 'busy' && __synopia.cur().items.some(i => i.id === 'toolu_nbuild' && i.fg)`);
await ev('document.fonts.ready.then(() => true)');
const sentOf = await spySent(c);
const K = keyTable(key);
const sent = () => sentOf('sendNow');
const asking = () => ev(`(() => { const p = document.querySelector('.composer.asking .int-ask'); return p && getComputedStyle(p).display !== 'none' ? p.textContent : null; })()`);
const Q = '#log .qpin > .prompt.qc';
const marked = () => ev(`document.getElementById('log').classList.contains('now-asking') ? [...document.querySelectorAll('${Q}')].filter(e => /inset/.test(getComputedStyle(e).boxShadow)).map(e => e.textContent.trim()) : []`);
const box = () => ev('document.getElementById("msg").value');
const mode = () => ev('document.body.dataset.mode');
const sendText = (t) => ev(`(() => { const ta = document.getElementById('msg'); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
const PROMPT = 'Send all now? f again. Any other key to keep them queued.';

check('starts in normal mode, nothing queued, nothing asked', (await mode()) === 'normal' && (await asking()) === null && (await ev(`document.querySelectorAll('${Q}').length`)) === 0);
await K.f();
check('nothing queued and no draft: f asks nothing, sends nothing, types nothing', (await asking()) === null && (await sent()).length === 0 && (await box()) === '' && (await mode()) === 'normal');

await sendText(FIRST); await sendText(SECOND);
await ev('document.activeElement?.blur()');
check('two queued bands show', await c.until(`document.querySelectorAll('${Q}').length === 2`), String(await ev(`document.querySelectorAll('${Q}').length`)));

await K.f();
check('first f: the prompt in the message box', (await asking()) === PROMPT, await asking());
const m = await marked();
check('first f: both queued bands are marked', m.length === 2 && m[0] === FIRST && m[1] === SECOND, JSON.stringify(m));
const look = await ev(`(() => { const e = document.querySelector('${Q}'), cs = getComputedStyle(e); return { bg: cs.backgroundColor, sh: cs.boxShadow, op: cs.opacity, anim: e.getAnimations().length }; })()`);
const dark = theme === 'dark';
check('the mark: selection tint and a 1px blue ring, no animation', look.bg === (dark ? 'rgb(31, 59, 92)' : 'rgb(221, 244, 255)') && (dark ? /rgb\(68, 147, 248\) 0px 0px 0px 1px inset/ : /rgb\(84, 174, 255\) 0px 0px 0px 1px inset/).test(look.sh) && look.anim === 0, JSON.stringify(look));
await shot(c, path.join(stateDir, `sendnow-asking-${theme}.png`));

await K.l();
check('another key: the prompt and the marks go, nothing sent, the bands still wait at half strength', (await asking()) === null && (await marked()).length === 0 && (await sent()).length === 0
  && (await ev(`[...document.querySelectorAll('${Q}')].every(e => getComputedStyle(e).opacity === '0.5')`)) && (await mode()) === 'normal' && (await box()) === '');

// one prompt at a time
await K.f(); await K.esc();
check('Esc under it only cancels it (2026-11-27), the marks go', (await asking()) === null && (await marked()).length === 0);
await K.esc();
check('a second Esc asks "Interrupt?"', /^Interrupt\?/.test(await asking() || ''));
await K.f();
check('f under "Interrupt?": this prompt replaces it', (await asking()) === PROMPT && (await marked()).length === 2);
await K.b();
check('b under it: "Send to background?" replaces it, nothing sent', /^Send to background\?/.test(await asking() || '') && (await marked()).length === 0 && (await sent()).length === 0);
await K.j();

// insert mode: f types
await K.i(); await K.f();
check('insert mode: f types', (await box()) === 'f' && (await asking()) === null);
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ${JSON.stringify(DRAFT)}; ta.dispatchEvent(new Event('input')); })()`);
await K.esc();
check('back in normal mode with the draft in the box', (await mode()) === 'normal' && (await box()) === DRAFT);

await K.f(); await K.f();
const s1 = await sent();
check('f, f: one sendNow with the draft', s1.length === 1 && s1[0].sid === A && s1[0].draft?.text === DRAFT && Array.isArray(s1[0].draft.images) && /^[0-9a-f-]{36}$/.test(s1[0].draft.uuid || ''), JSON.stringify(s1));
check('f, f: the prompt goes, the box empties', (await asking()) === null && (await marked()).length === 0 && (await box()) === '', JSON.stringify([await asking(), await marked(), await box()]));
const acked = await c.until(`__synopia.received('ack').some(a => a.id === ${JSON.stringify(s1[0]?.id ?? '')} && a.ok === true)`);
check('the backend did it: acked, no toast', acked && (await ev(`__synopia.received('toast').length`)) === 0, JSON.stringify(await ev(`__synopia.received('ack', 'toast')`)));
check('the queued messages land as your prompts', await c.until(`(s => [${JSON.stringify(FIRST)}, ${JSON.stringify(SECOND)}].every(t => s.items.some(i => i.k === 'you' && i.text === t)))(__synopia.cur())`));
check('their bands leave the queue; the draft waits as a queued band', await c.until(`(b => b.length === 1 && b[0].textContent.trim() === ${JSON.stringify(DRAFT)})([...document.querySelectorAll('${Q}')])`),
  JSON.stringify(await ev(`[...document.querySelectorAll('${Q}')].map(e => e.textContent.trim())`)));

// the background route: the Bash stays a step, its shell runs on in the background with its card, not struck through,
// and nothing is set aside
check('background route: the Bash stays a step and its shell runs on in the background, with its card in the panel', await c.until(`!document.querySelector('#log .ln.tool.runrow') && [...document.querySelectorAll('#log .ln.tool')].some(e => /Bash\\(Build the demo\\)/.test(e.textContent)) && /Build the demo/.test(document.querySelector('.rail .now [data-bg="toolu_nbuild"]')?.textContent || '')`),
  JSON.stringify(await ev(`[document.querySelector('.rail')?.textContent.replace(/\\s+/g, ' ') ?? 'no panel', [...document.querySelectorAll('#log .ln.tool')].map(e => e.textContent.slice(0, 80))]`)));
check('background route: no set-aside line, nothing struck through', (await ev(`document.querySelectorAll('#log .asideln').length`)) === 0
  && (await ev(`[...document.querySelectorAll('#log *')].every(e => !/line-through/.test(getComputedStyle(e).textDecorationLine))`)));

// the interrupt route: Claude only writes, one message queued
await ev(`document.querySelector('.row[data-id="${C}"]').click()`); await ev('document.activeElement?.blur()');
await c.until(`__synopia.current() === '${C}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().state.status === 'busy' && !!document.querySelector('#log .liveln.rule')`);
await c.until(`(document.querySelector('#log')?.textContent || '').includes(${JSON.stringify(CUT)})`);
await sendText(LATER); await ev('document.activeElement?.blur()');
await c.until(`document.querySelectorAll('${Q}').length === 1`);
await K.f(); await K.f();
const s2 = await sent();
check('interrupt route: f, f sends one sendNow, no draft', s2.length === 2 && s2[1].sid === C && !s2[1].draft, JSON.stringify(s2));
check('interrupt route: the queued message lands as your prompt', await c.until(`__synopia.cur().items.some(i => i.k === 'you' && i.text === ${JSON.stringify(LATER)})`));
check('interrupt route: the live line stays as a set-aside record', await c.until(`!!document.querySelector('#log .asideln')`));
const aside = await ev(`(() => { const e = document.querySelector('#log .asideln'), st = e.querySelector('s'), all = [...document.querySelectorAll('#log > .log-inner > *')];
  const txt = all.findIndex(x => x.matches('.ln.claude.aside')), you = all.findIndex(x => x.textContent.includes(${JSON.stringify(LATER)}));
  return { text: e.textContent.replace(/\\s+/g, ' ').trim(), struck: !!st && getComputedStyle(st).textDecorationLine.includes('line-through'), why: !/line-through/.test(getComputedStyle(e.querySelector('.why')).textDecorationLine),
    grey: getComputedStyle(e).color, anim: e.getAnimations({ subtree: true }).length, rule: e.classList.contains('rule'),
    reply: txt >= 0 && all[txt].textContent.includes(${JSON.stringify(CUT)}) ? getComputedStyle(all[txt].querySelector('.md')).color : null, order: [txt, all.indexOf(e), you] }; })()`);
check('interrupt route: "Thinking", struck through, then "set aside for your messages", not struck', aside.text === 'Thinking set aside for your messages' && aside.struck && aside.why, JSON.stringify(aside));
check('interrupt route: still (no animation) and greyed, not the live line\'s rule', aside.anim === 0 && !aside.rule && aside.grey === aside.reply && aside.grey === (await ev(`(() => { const x = document.createElement('i'); x.style.color = 'var(--ink-3)'; document.getElementById('log').append(x); const v = getComputedStyle(x).color; x.remove(); return v; })()`)), JSON.stringify(aside));
check('interrupt route: the cut reply greyed above it, your message below it', aside.reply !== null && aside.order[0] < aside.order[1] && aside.order[1] < aside.order[2], JSON.stringify(aside.order));
await shot(c, path.join(stateDir, `sendnow-aside-${theme}.png`));

// a session Synopia doesn't drive: f asks nothing
await ev(`document.querySelector('.row[data-id="${B}"]').click()`); await ev('document.activeElement.blur()');
await c.until(`__synopia.current() === '${B}' && __synopia.cur().state.driven === false`);
await ev(`(() => { const ta = document.getElementById('msg'); if (ta) { ta.value = 'draft'; ta.dispatchEvent(new Event('input')); ta.blur(); } })()`);
await K.f();
check('not driven: f asks nothing and sends nothing', (await asking()) === null && (await sent()).length === 2);
await sleep(50);
c.print(); c.close();
