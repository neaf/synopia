// Messages sent while a turn runs wait (R5.5), and the conversation pane as one panel (R5), on a made-up
// fixture with the scripted SDK.
// usage: node queued.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node queued.mjs <url> <state-dir> <claude-dir>
// Checks: the pane is one panel (header, log and box are rows of it, none a panel of its own); the box is its
// last row under a 1px line, in the default state too; a posted band's 2.5px left edge shows whole. Two
// messages sent during a turn show in order below the live line, each the posted band with a still clock in
// place of ❯ and lighter text; no veil; the box's placeholder counts them. Scrolled up, the queue and the box
// stay pinned to the panel's bottom, at most half of it, with a 1px line at the queue's top. The first lands
// (its queued_command appended to the fixture file): it becomes the posted prompt in place and nothing moves;
// the second lands: none waits. A third, then Esc, Esc: it disappears and its text is back in the box. A message
// sent while nothing runs isn't queued and shows at once: its band moves up from the box (a copy, fixed on
// screen), ends in place, the band itself never moves; with reduced motion nothing moves. A queued message
// with a pasted (made-up) image: its thumbnail opens the viewer; landed, the same size. Writes queued-two.png,
// queued-landed.png, queued-image.png, and in $SYNOPIA_SHOTS when that is set default-, typed-, queued-typed-
// and scrolled-<theme>.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, running, png, shot as shotTo } from './helpers.mjs';

const A = 'a9a9a9a9-0000-4000-8000-0000000000a1'; // driven, working
const B = 'a9a9a9a9-0000-4000-8000-0000000000b2'; // driven, idle
const C = 'a9a9a9a9-0000-4000-8000-0000000000c3'; // driven, working: a queued message with an image
const dirOf = (claude) => path.join(claude, 'projects', '-tmp-synopia-queued');
const { rec, you, said, tool: toolUse } = records('/tmp/synopia-queued');
const tool = (sid, uuid, s, id, command) => toolUse(sid, uuid, s, id, 'Bash', { command, description: 'Run the demo tests' });
const FIRST = 'Also check the **demo** notes when you are done.';
const SECOND = 'And then rename the demo folder.';
const THIRD = 'Then tidy the demo readme.';
const DRAFT = 'Then open a draft PR for the demo.';
const PIC = 'Make the header look like this: [Image #1]';
const PNG = png(240, 160).toString('base64');
const LONG = Array.from({ length: 12 }, (_, i) => `mcp__demo__portal_list_servers_${i}`).join(',');
const FILL = 14; // Claude's notes before the step, so A's log scrolls

if (process.argv[2] === 'make') {
  const dir = dirOf(process.argv[3]);
  fs.mkdirSync(dir, { recursive: true });
  const notes = Array.from({ length: FILL }, (_, i) => said(A, `q-n${i}`, 1, `Note ${i + 1} on the demo: the tests cover the parser, the cache and the demo command line.`)).join('');
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), you(A, 'q-u1', 0, 'Run the demo tests.') + notes + said(A, 'q-a1', 1, 'Running them now.') + tool(A, 'q-a2', 2, 'toolu_q1', 'npm test'));
  // three reads of files whose names are one long token each: a run of steps, no spaces to wrap at
  const reads = [1, 2, 3].map((n) => toolUse(B, `b-r${n}`, 1, `toolu_br${n}`, 'Read', { file_path: `/tmp/synopia-queued/${LONG}_${n}.md` })
    + rec(B, { type: 'user', uuid: `b-rr${n}`, timestamp: new Date(Date.now() - 59_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_br${n}`, content: 'notes' }] } })).join('');
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), you(B, 'b-u1', 0, 'Read the demo notes.') + reads + said(B, 'b-a1', 1, 'Read them.'));
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), you(C, 'c-u1', 0, 'Restyle the demo header.') + said(C, 'c-a1', 1, 'Looking at it.') + tool(C, 'c-a2', 2, 'toolu_c1', 'npm run build'));
  // A's turn runs in Synopia's process; B's process waits idle, so a message to it starts a turn
  writeScript(process.argv[3], 'queued.mjs: made up', { [A]: { start: true, steps: [running(58000)] }, [B]: { start: true, state: { status: 'idle', ago: 58000 } }, [C]: { start: true, steps: [running(58000)] } });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir, claude] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const c = await connect();
const { ev, check, key } = c;
const shot = async (name) => { await shotTo(c, path.join(stateDir, name)); };
const keep = async (name) => { if (!process.env.SYNOPIA_SHOTS) return; fs.mkdirSync(process.env.SYNOPIA_SHOTS, { recursive: true }); await shotTo(c, path.join(process.env.SYNOPIA_SHOTS, `${name}-${theme}.png`)); };
// at 2x, as on a Retina screen: at 1x Chrome draws a 2.5px border 2px wide
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(`${url}#${A.slice(0, 8)}`, `__synopia.current() === '${A}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().state.status === 'busy' && __synopia.cur().items.length === ${FILL + 3}`);
await ev('document.fonts.ready.then(() => true)');
const sendText = (t) => ev(`(() => { const ta = document.getElementById('msg'); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
const typeDraft = (t) => ev(`(() => { const ta = document.getElementById('msg'); ta.focus(); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new Event('input')); return document.body.dataset.mode; })()`);
const Q = `#log .qpin > [data-key^="q:"]`; // a message that waits: the page's key for an outbox entry
const BLOCKS = `#log .log-inner > :not(.qpin), #log .qpin > *`;
// the pane's blocks in order: waiting bands as q, posted prompts as you, the live line as live
const order = () => ev(`[...document.querySelectorAll('${BLOCKS}')].map(e => e.matches('${Q}') ? 'q:' + e.textContent.trim()
  : e.matches('.prompt') ? 'you:' + e.textContent.replace('❯', '').trim() : e.matches('.liveln') ? 'live' : '').filter(Boolean)`);
const queuedRows = () => ev(`document.querySelectorAll('${Q}').length`);
// every block's top, keyed by its text (a band keeps its text when it lands), and the box's
const tops = () => ev(`[...document.querySelectorAll('${BLOCKS}'), document.querySelector('.dock .composer')].map(e => [e.matches('.liveln') ? 'live' : e.matches('.composer') ? 'box' : e.textContent.replace('❯', '').trim().slice(0, 60), e.getBoundingClientRect().top])`);
const moved = (a, b) => { const m = new Map(b); return a.filter(([k, t]) => !m.has(k) || Math.abs(m.get(k) - t) > 0.5).map(([k, t]) => `${k}: ${t} -> ${m.get(k)}`); };
const placeholder = () => ev(`document.getElementById('msg').placeholder`);
const varColor = (name) => `(() => { const i = document.createElement('i'); i.style.color = getComputedStyle(document.documentElement).getPropertyValue('${name}'); document.body.append(i); const v = getComputedStyle(i).color; i.remove(); return v; })()`;

// one panel: the header, the log and the box are rows of it, none a panel of its own
const one = await ev(`(() => { const t = document.querySelectorAll('#conv > .thread.panel'), th = t[0];
  const parts = ['.c-head', '#log', '.dock'].map(q => document.querySelector('#conv ' + q));
  return { n: t.length, inside: parts.every(p => p && th.contains(p)), own: parts.filter(p => p.matches('.panel') || getComputedStyle(p).borderLeftWidth !== '0px' || getComputedStyle(p).borderRadius !== '0px').map(p => p.className),
    panels: [...document.querySelectorAll('#conv .panel')].map(p => p.className) }; })()`);
check('one panel: header, log and box are rows of it, with no panel or frame of their own', one.n === 1 && one.inside && one.own.length === 0 && one.panels.every(c => /thread|rail/.test(c)), JSON.stringify(one));
const line = await ev(`(() => { const b = document.querySelector('.dock .composer'), st = getComputedStyle(b); return { w: st.borderTopWidth, style: st.borderTopStyle, color: st.borderTopColor, mode: document.body.dataset.mode, last: b.getBoundingClientRect().bottom, panel: document.querySelector('.thread').getBoundingClientRect().bottom }; })()`);
check('the box is the panel\'s last row, a 1px line above it in the default state', line.w === '1px' && line.style === 'solid' && line.color === await ev(varColor('--line-2')) && line.mode === 'normal' && Math.abs(line.panel - 1 - line.last) <= 0.5, JSON.stringify(line));
// Chrome computes a 2.5px border as 2px (it snaps border widths), WebKit at 2x draws 2.5px: the stylesheet's
// width, and the band's edge at the log's own edge, so nothing of it is clipped
const edge = await ev(`(() => { const log = document.getElementById('log'), b = log.querySelector('.prompt'), r = b.getBoundingClientRect(), lr = log.getBoundingClientRect();

  const hit = document.elementFromPoint(r.left + 0.5, r.top + r.height / 2), hit2 = document.elementFromPoint(r.left + 2, r.top + r.height / 2);
  return { painted: b.clientLeft, from: r.left - lr.left, hit: !!hit && b.contains(hit), hit2: !!hit2 && b.contains(hit2) }; })()`);
check('a posted band\'s left edge is 2.5px, whole: it starts at the log\'s edge, not clipped', /(^|\n)\.prompt \{[^}]*border-left: 2\.5px solid/.test(fs.readFileSync(new URL('../../css/app.css', import.meta.url), 'utf8')) && edge.painted >= 2 && Math.abs(edge.from) <= 0.01 && edge.hit && edge.hit2, JSON.stringify(edge));

await sendText(FIRST);
await sendText(SECOND);
check('two waiting bands show', await c.until(`document.querySelectorAll('${Q}').length === 2`), String(await queuedRows()));
const o1 = await order();
check('in the order sent, below the live line',
  JSON.stringify(o1.slice(-3)) === JSON.stringify(['live', 'q:Also check the demo notes when you are done.', 'q:And then rename the demo folder.']), JSON.stringify(o1));
// the posted band with a still clock in place of ❯, and lighter text
const look = (sel) => `(() => { const e = document.querySelector('${sel}'), st = getComputedStyle(e), md = getComputedStyle(e.querySelector('.md'));
  return { cls: e.className, bg: st.backgroundColor, edge: [st.borderLeftStyle, st.borderLeftColor, st.borderLeftWidth].join(' '), pad: [st.paddingTop, st.paddingBottom, st.paddingLeft].join(' '), ink: md.color, op: st.opacity,
    g: e.querySelector(':scope > .g').textContent.trim(), clock: !!e.querySelector(':scope > .g .ind svg circle') && !!e.querySelector(':scope > .g .ind svg path'), moving: e.getAnimations({ subtree: true }).length, h: e.getBoundingClientRect().height }; })()`;
const ql = await ev(look(Q)), pl = await ev(look('#log .log-inner > [data-key="you:q-u1"]'));
check('a waiting band keeps the posted band\'s fill, edge and padding, at half opacity as a whole', ql.bg === pl.bg && ql.edge === pl.edge && ql.pad === pl.pad && ql.op === '0.5' && pl.op === '1', JSON.stringify([ql, pl]));
check('a still clock in place of ❯: no ❯, a clock mark, nothing moving', ql.g === '' && ql.clock && ql.moving === 0 && pl.g === '❯' && !/\bqc\b/.test(pl.cls), JSON.stringify(ql));
check('its text is the lighter grey, the posted band\'s is not', ql.ink === await ev(varColor('--ink-3')) && pl.ink !== ql.ink, `${ql.ink} vs ${pl.ink}`);
check('no veil', await ev(`!document.querySelector('.qveil')`));
check('the live line keeps Working, without the "queued" sentence', await ev(`(() => { const l = document.querySelector('#log .liveln'); return /Working/.test(l.textContent) && !/queued/i.test(l.textContent); })()`), await ev(`document.querySelector('#log .liveln')?.textContent`));
check('the sidebar says how many wait, its mark queued (blue centre)', await ev(`/Working, 2 messages queued/.test(document.querySelector('.row[data-id="${A}"]').textContent) && !!document.querySelector('.row[data-id="${A}"] .ind circle[fill="var(--mk-0550AE)"]')`),
  await ev(`document.querySelector('.row[data-id="${A}"]').textContent`));
check('the empty box says how many wait', (await placeholder()) === "2 waiting for Claude's next step", await placeholder());
await c.until(`!document.querySelector('.send-ghost')`);
await shot('queued-two.png');
check('a draft goes in the box, insert mode', (await typeDraft(DRAFT)) === 'insert');
await keep('queued-typed');

// scrolled up: the box stays; the queue is the transcript's end and scrolls away with it, not pinned
const pinAt = () => ev(`(() => { const q = document.querySelector('#log .qpin'), d = document.querySelector('.dock'), t = document.querySelector('.thread'), log = document.getElementById('log');
  const qr = q.getBoundingClientRect(), first = q.firstElementChild.getBoundingClientRect(), prev = q.previousElementSibling.getBoundingClientRect();
  return { qTop: qr.top, qBot: qr.bottom, dTop: d.getBoundingClientRect().top, box: d.querySelector('.composer').getBoundingClientRect().top, edge: q.classList.contains('edge'), shadow: getComputedStyle(q).boxShadow, gap: first.top - prev.bottom, line: first.top - qr.top,
    half: qr.height + d.getBoundingClientRect().height <= t.clientHeight / 2 + 0.5, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 1, logBot: log.getBoundingClientRect().bottom }; })()`);
const p0 = await pinAt();
check('at the bottom: the queue ends the transcript, 11px under the live line, no line at its top, the box\'s line right under it', !p0.edge && p0.shadow === 'none' && p0.atEnd && Math.abs(p0.gap - 11) <= 0.5 && Math.abs(p0.qBot - p0.dTop) <= 0.5, JSON.stringify(p0));
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight - l.clientHeight - 200; })()`);
await sleep(150);
const p1 = await pinAt();
check('scrolled up: the log scrolls, the box stays where it was', !p1.atEnd && Math.abs(p1.box - p0.box) <= 0.5, JSON.stringify([p0, p1]));
check('scrolled up: the queue scrolled down with the transcript, under the box\'s line, no line at its top', !p1.edge && p1.shadow === 'none' && p1.qTop > p0.qTop + 1 && p1.qBot > p1.dTop + 1, JSON.stringify([p0, p1]));
check('a waiting band is at half opacity as a whole', await ev(`getComputedStyle(document.querySelector('${Q}')).opacity === '0.5'`));
await keep('scrolled');
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
await sleep(150);
await typeDraft('');
await ev('document.activeElement.blur()');

// the first lands: the CLI writes it as a queued_command attachment of its own uuid
const before = await tops();
const file = path.join(dirOf(claude), `${A}.jsonl`);
fs.appendFileSync(file, rec(A, { type: 'attachment', uuid: 'q-land1', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: FIRST, commandMode: 'prompt' } }));
check('the first landed: one waiting band left', await c.until(`document.querySelectorAll('${Q}').length === 1 && __synopia.cur().items.some(i => i.id === 'q-land1')`, 8000), String(await queuedRows()));
const o2 = await order();
check('it became the posted prompt in its place, once, under the live line, the second still waiting below it',
  JSON.stringify(o2.slice(-3)) === JSON.stringify(['live', 'you:Also check the demo notes when you are done.', 'q:And then rename the demo folder.'])
  && o2.filter((x) => x.includes('Also check')).length === 1, JSON.stringify(o2));
const m1 = moved(before, await tops());
check('nothing moved when it landed: not the log, the queue or the box', m1.length === 0, m1.join('; '));
check('the box says one waits', (await placeholder()) === "1 waiting for Claude's next step", await placeholder());
// never both at once, never neither: watch every change from here while the backend drops it
await ev(`(() => { window.__seen = []; const f = () => { const n = [...document.querySelectorAll('#log .prompt')].filter(p => /Also check/.test(p.textContent)).length; __seen.push(n); };
  new MutationObserver(f).observe(document.querySelector('.thread'), { childList: true, subtree: true }); })()`);
await sleep(1500);
check('after the backend drops it from the outbox: still exactly one, never two or none', await ev(`__seen.every(n => n === 1) && document.querySelectorAll('${Q}').length === 1 && __synopia.cur().outbox.length === 1`), await ev(`JSON.stringify(__seen)`));
await shot('queued-landed.png');

// the second lands: nothing moves, none waits
const before2 = await tops();
fs.appendFileSync(file, rec(A, { type: 'attachment', uuid: 'q-land2', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: SECOND, commandMode: 'prompt' } }));
check('the second landed: none waits', await c.until(`document.querySelectorAll('${Q}').length === 0 && __synopia.cur().items.some(i => i.id === 'q-land2')`, 8000), String(await queuedRows()));
const m2 = moved(before2, await tops());
check('nothing moved when the last landed', m2.length === 0, m2.join('; '));
check('the queue is gone, the log runs down to the box\'s line', await ev(`!document.querySelector('.qpin') && Math.abs(document.getElementById('log').getBoundingClientRect().bottom - document.querySelector('.dock').getBoundingClientRect().top) <= 0.5`));
check('the box says Message <title> again', /^Message .*, \/ for commands$/.test(await placeholder()), await placeholder());

// a third, then Esc, Esc interrupts: it disappears and its text goes back to the box
await sendText(THIRD);
check('a third waits', await c.until(`document.querySelectorAll('${Q}').length === 1`), String(await queuedRows()));
await ev('document.activeElement.blur()');
await key('Escape', { code: 'Escape', vk: 27 }); await key('Escape', { code: 'Escape', vk: 27 });
check('interrupted: no waiting band left', await c.until(`document.querySelectorAll('${Q}').length === 0`), String(await queuedRows()));
check('its text is back in the message box', await c.until(`document.getElementById('msg').value === ${JSON.stringify(THIRD)}`), await ev(`document.getElementById('msg').value`));
check('the landed prompts stay', (await order()).filter((x) => x === 'you:Also check the demo notes when you are done.' || x === 'you:And then rename the demo folder.').length === 2);
await typeDraft(''); await ev('document.activeElement.blur()');

// nothing runs: a message isn't queued, but shows at once as the new turn's prompt, moving up from the box
await ev(`document.querySelector('.row[data-id="${B}"]').click()`);
await c.until(`__synopia.current() === '${B}' && !!__synopia.mounted() && __synopia.mode() === 'normal'`);
await c.until(`!document.getElementById('toast').classList.contains('show')`, 6000);
await keep('default');
await typeDraft('Read them again.');
await keep('typed');
await ev('__synopia.spy()');
// every frame for 600 ms: the copy that moves, and the band in its place
const SAMPLE = (text) => `new Promise(res => { const out = [], t0 = performance.now(), ta = document.getElementById('msg'), from = ta.closest('.composer').getBoundingClientRect().top;
  const f = () => { const g = document.querySelector('.send-ghost'), b = [...document.querySelectorAll('#log .prompt')].find(p => !p.matches('.send-ghost') && p.textContent.includes(${JSON.stringify(text)}));
    out.push({ g: g ? g.getBoundingClientRect().top : null, b: b ? b.getBoundingClientRect().top : null, hid: b ? getComputedStyle(b).visibility === 'hidden' : null });
    if (performance.now() - t0 < 600) requestAnimationFrame(f); else res({ from, out }); };
  ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); requestAnimationFrame(f); })`;
const tw = await ev(SAMPLE('Read them again.'));
const withBand = tw.out.filter((x) => x.b !== null), ghosts = tw.out.filter((x) => x.g !== null), last = tw.out[tw.out.length - 1];
check('idle session: sent, nothing waits, the prompt shows at once', (await ev(`__synopia.sent('send').length`)) === 1
  && (await ev(`__synopia.cur().outbox.length >= 1 && __synopia.cur().outbox[0].queued === false`)) && withBand.length > 0 && (await queuedRows()) === 0);
check('send tween: a copy moves up from the box to the band\'s place, never down', ghosts.length >= 3 && ghosts[0].g > withBand[0].b + 5 && ghosts.every((x, i) => i === 0 || x.g <= ghosts[i - 1].g + 0.01)
  && Math.abs(ghosts[ghosts.length - 1].g - withBand[0].b) < 8, JSON.stringify(tw).slice(0, 600));
check('send tween: the band itself never moves, is hidden only while the copy moves, and ends in place, shown', withBand.every((x) => Math.abs(x.b - withBand[0].b) <= 0.5) && withBand.every((x) => x.hid === (x.g !== null))
  && last.g === null && last.hid === false && await ev(`!document.querySelector('.send-ghost')`), JSON.stringify(tw).slice(0, 600));
check('the box empties at once', await ev(`document.getElementById('msg').value === ''`));
await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const tr = await ev(SAMPLE('And list the demo files.'));
check('reduced motion: no tween, the band shows in place at once', tr.out.every((x) => x.g === null) && tr.out.some((x) => x.b !== null) && tr.out.every((x) => !x.hid), JSON.stringify(tr).slice(0, 400));
await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

// a queued message with a pasted image: the waiting band with its thumbnail
await ev(`document.querySelector('.row[data-id="${C}"]').click()`);
check('C: working', await c.until(`__synopia.current() === '${C}' && !!__synopia.mounted() && __synopia.cur().state.status === 'busy' && __synopia.cur().items.length === 3`));
await ev(`(() => { const t = document.getElementById('msg'); t.focus(); t.value = 'Make the header look like this: '; t.dispatchEvent(new Event('input')); t.setSelectionRange(t.value.length, t.value.length);
  const b = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0)), dt = new DataTransfer(); dt.items.add(new File([b], 'header.png', { type: 'image/png' }));
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
check('the paste put its tag in the box, a space after it', await c.until(`document.getElementById('msg').value === ${JSON.stringify(PIC + ' ')} && !!document.querySelector('.composer .attach .thumb')`), await ev(`document.getElementById('msg').value`));
await ev(`(() => { const t = document.getElementById('msg'); t.value = t.value.trimEnd(); t.dispatchEvent(new Event('input')); })()`); // the transcript's record below has no trailing space
await key('Enter', { code: 'Enter', vk: 13 });
const QI = `[...document.querySelectorAll('${Q}')].find(p => p.textContent.includes('Make the header'))`;
check('queued with its image: the thumbnail shows, loaded from the backend', await c.until(`(() => { const q = ${QI}, i = q && q.querySelector('.thumbs .thumb.sized img'); return !!i && i.complete && i.naturalWidth === 240 && /ref=queued%3A/.test(i.src); })()`, 8000),
  await ev(`${QI}?.outerHTML.slice(0, 400) || 'none'`));
await c.until(`!document.querySelector('.send-ghost')`);
const shape = (row) => `(() => { const p = ${row}; if (!p) return 'none';
  const t = p.querySelector('.thumb').getBoundingClientRect(), r = p.getBoundingClientRect(); return JSON.stringify({ thumb: [Math.round(t.width), Math.round(t.height)], width: Math.round(r.width), height: Math.round(r.height * 2) / 2 }); })()`;
const qShape = await ev(shape(QI));
await ev(`(() => { const t = ${QI}.querySelector('.thumb'), r = t.getBoundingClientRect(); document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).click(); })()`);
check('a click on its thumbnail opens the viewer on it', await c.until(`!!document.querySelector('.viewer img') && /ref=queued%3A/.test(document.querySelector('.viewer img').src)`));
await key('Escape', { code: 'Escape', vk: 27 });
await c.until(`!document.querySelector('.viewer')`);
await shot('queued-image.png');

// it lands as the CLI writes a queued message with an image: prompt as text and image blocks
const beforeC = await tops();
const fileC = path.join(dirOf(claude), `${C}.jsonl`);
fs.appendFileSync(fileC, rec(C, { type: 'attachment', uuid: 'c-land1', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt',
  prompt: [{ type: 'text', text: PIC }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } }));
const PI = `document.querySelector('#log .log-inner > [data-key="you:c-land1"]')`;
check('landed: the posted band, once, none waiting', await c.until(`!!(${PI}) && !document.querySelector('${Q}') && __synopia.cur().items.some(i => i.id === 'c-land1')`, 8000));
check('landed: its thumbnail from the transcript', await c.until(`(() => { const i = ${PI}.querySelector('.thumb img'); return i.complete && i.naturalWidth === 240 && !/ref=queued/.test(i.src); })()`));
const pShape = await ev(shape(PI));
check('the same thumbnail size, width and height as when it waited', pShape === qShape, `${qShape} | ${pShape}`);
const m3 = moved(beforeC, await tops());
check('nothing moved when the image message landed', m3.length === 0, m3.join('; '));

// a wide window: every band's fill runs to the panel's inner right while its text keeps the 150ch measure, and a
// step line of one long token wraps inside the panel
await ev(`document.querySelector('.row[data-id="${B}"]').click()`);
await c.until(`__synopia.current() === '${B}' && !!__synopia.mounted()`);
for (const width of [2400, 900]) {
  await c.cdp('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  await ev(`document.querySelectorAll('#log details.fold:not([open]) > summary').forEach(s => s.click())`);
  await sleep(100);
  const w = await ev(`(() => { const log = document.getElementById('log'), lr = log.getBoundingClientRect(), right = lr.left + log.clientLeft + log.clientWidth;
    const bands = [...log.querySelectorAll('.prompt')].map(b => b.getBoundingClientRect().right - right), box = document.querySelector('.dock .composer').getBoundingClientRect().right - document.querySelector('.thread').getBoundingClientRect().right + 1;
    const text = Math.max(...[...log.querySelectorAll('.prompt .md')].map(m => m.getBoundingClientRect().width)), ch = (() => { const p = document.createElement('span'); p.style.cssText = 'position:absolute;width:1ch'; log.querySelector('.prompt .md').append(p); const w = p.getBoundingClientRect().width; p.remove(); return w; })();
    const over = [...log.querySelectorAll('.ln, .ln *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > right + 0.5 && !e.closest('.prompt')).map(e => e.className || e.tagName).slice(0, 4);
    return { bands, box, text, max: 148 * ch, over, folds: log.querySelectorAll('details.fold[open] .body .res').length }; })()`);
  check(`${width}px: every band runs to the log's inner right, the box to the panel's`, w.bands.length > 0 && w.bands.every((d) => Math.abs(d) <= 0.5) && Math.abs(w.box) <= 0.5, JSON.stringify(w));
  check(`${width}px: band text keeps the 150ch measure`, w.text <= w.max * 1.005, JSON.stringify(w));
  check(`${width}px: no step line runs past the log's inner right (one long token wraps)`, w.folds >= 3 && w.over.length === 0, JSON.stringify(w));
  if (width === 2400) await shot('queued-wide.png');
}

c.print(); c.close();
