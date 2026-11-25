// A long reply with three markdown tables streamed into a long session (R5.10, R5.5): the page never hangs.
// usage: node stream.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node stream.mjs <url> <state-dir>
// The scripted SDK streams the reply in small text deltas (6 to 14 characters every 20 ms, so rows are cut
// before their closing pipe), after a message sent from the box (the send tween). While it streams the check
// resizes the viewport, scrolls up and back to the end, and switches to another session and back. Checks: no
// long task over 200 ms, an evaluate answers within 500 ms all through, the streamed tables show as tables
// while they stream, and the landed reply holds its three tables. Then a reload of the long session read from its
// oldest item: it comes back there, and no long task over 200 ms either. Made-up data only.
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript } from './helpers.mjs';

const S = 'a7a7a7a7-0000-4000-8000-0000000000a1'; // driven, idle: a message starts the streamed turn
const T = 'a7a7a7a7-0000-4000-8000-0000000000b2'; // another session to switch to
const dirOf = (claude) => path.join(claude, 'projects', '-tmp-synopia-stream');
const { you, said } = records('/tmp/synopia-stream');
const HISTORY = 80; // earlier turns, a table in every fifth reply

const row = (cs) => `| ${cs.join(' | ')} |`;
const table = (rows) => [row(rows[0]), row(rows[0].map((_, j) => (j ? '--:' : ':--'))), ...rows.slice(1).map(row)].join('\n');
const wide = (n) => table([['Region', 'Endpoint', 'Calls', 'p50', 'p95', 'p99', 'Errors', 'Cache hit', 'Owner', 'Last deploy'],
  ...Array.from({ length: n }, (_, i) => [`demo-${i}`, `\`demo/endpoint-${i}\``, `${100 + i}k`, `~${4 + i} ms`, `${20 + i} ms`, `${60 + i} ms`, '0.02%', '91%', 'demo-team', '2026-11-18'])]);
const prose = (i) => `Paragraph ${i} of the demo notes: the parser reads each record once, the cache keeps the last hundred, and the command line prints a short summary per file.`;
const REPLY = [
  'Here is what the demo run found.', '',
  table([['Step', 'Time', 'Notes'], ...Array.from({ length: 8 }, (_, i) => [`step ${i}`, `${i * 3 + 1} ms`, `Reads the demo file ${i} and keeps its header for the next step`])]), '',
  ...Array.from({ length: 6 }, (_, i) => prose(i)), '',
  wide(12), '',
  '- the slow step is the export', '- the cache works', '', '> nothing failed', '',
  table([['Option', 'Effort', 'Risk', 'What it changes'], ...Array.from({ length: 5 }, (_, i) => [`Option ${i}`, `${i + 1} days`, 'Low', 'The demo button starts a job and the page says the file is on its way; a link follows.'])]), '',
  ...Array.from({ length: 6 }, (_, i) => prose(i + 6)),
].join('\n');

if (process.argv[2] === 'make') {
  const dir = dirOf(process.argv[3]);
  fs.mkdirSync(dir, { recursive: true });
  const ts = (s) => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();
  const r = records('/tmp/synopia-stream', ts);
  let log = '';
  for (let i = 0; i < HISTORY; i++) log += r.you(S, `s-u${i}`, i * 10, `Demo question ${i}?`) + r.said(S, `s-a${i}`, i * 10 + 5, i % 5 ? prose(i) : `Numbers ${i}:\n\n${wide(4)}`);
  fs.writeFileSync(path.join(dir, `${S}.jsonl`), log);
  fs.writeFileSync(path.join(dir, `${T}.jsonl`), you(T, 't-u1', 0, 'Rename the demo folder.') + said(T, 't-a1', 1, 'Renamed it.'));
  // the deltas: deterministic sizes from 6 to 14 characters
  const deltas = []; let seed = 7;
  for (let at = 0; at < REPLY.length;) { seed = (seed * 1103515245 + 12345) % 2147483648; const n = 6 + (seed % 9); deltas.push(REPLY.slice(at, at + n)); at += n; }
  const ev = (event) => ({ message: { type: 'stream_event', parent_tool_use_id: null, event } });
  const onSend = [
    { message: { type: 'system', subtype: 'session_state_changed', state: 'running' } },
    { after: 300, ...ev({ type: 'message_start', message: { id: 'msg_stream_demo' } }) },
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...deltas.map((text) => ({ after: 20, ...ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) })),
    { after: 200, append: [{ type: 'assistant', message: { id: 'msg_stream_demo', role: 'assistant', content: [{ type: 'text', text: REPLY }] } }] },
    { after: 200, message: { type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 9000, num_turns: 1 } },
    { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } },
  ];
  writeScript(process.argv[3], 'stream.mjs: made up', { [S]: { start: true, state: { status: 'idle', ago: 58000 }, onSend }, [T]: { start: true, state: { status: 'idle', ago: 58000 } } });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url] = process.argv.slice(2);
const c = await connect();
const { ev, check, cdp } = c;
const LONG = 200, SLOW = 500;
const size = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
// long tasks on the page from now until `stop` resolves (buffered: those of the load too)
const watchLong = (buffered) => ev(`new Promise(r => { const l = []; const o = new PerformanceObserver(x => l.push(...x.getEntries().map(e => Math.round(e.duration))));
  o.observe({ type: 'longtask', buffered: ${buffered} }); document.addEventListener('synopia-stream-stop', () => { o.disconnect(); r(l); }, { once: true }); })`);
const stopLong = () => ev(`document.dispatchEvent(new Event('synopia-stream-stop'))`);
const rowOf = (id) => `[...document.querySelectorAll('#groups .row')].find(r => r.dataset.id === '${id}')`;
const click = (sel) => ev(`(${sel}).click()`);

await size(1280, 820);
const ready = `__synopia.current() === '${S}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().items.length > 0`;
await c.load(`${url}#${S.slice(0, 8)}`, ready);
await ev('document.fonts.ready.then(() => true)');

// the page answers: an evaluate's round trip, every 100 ms, until the stream has landed
let slowest = 0, pinging = true;
const pings = (async () => { while (pinging) { const t = Date.now(); await ev('__synopia.mode()'); slowest = Math.max(slowest, Date.now() - t); await sleep(100); } })();
const long = watchLong(false);
await ev(`(() => { const ta = document.getElementById('msg'); ta.focus(); ta.value = 'Summarise the demo run.'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
check('the reply streams', await c.until(`!!__synopia.cur().stream`, 5000));
const tablesWhile = async () => ev(`document.querySelectorAll('#log [data-key="stream"] .tw table').length`);
let most = 0;
// while it streams: resize, scroll up and back, switch away and back
for (const [w, h] of [[900, 820], [1280, 600], [1500, 900], [1280, 820]]) { await size(w, h); await sleep(400); most = Math.max(most, await tablesWhile()); }
await ev(`document.getElementById('log').scrollTop = 0`); await sleep(400);
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`); await sleep(300);
most = Math.max(most, await tablesWhile());
await click(rowOf(T)); await c.until(`__synopia.current() === '${T}' && !!__synopia.mounted()`); await sleep(500);
await click(rowOf(S)); await c.until(`__synopia.current() === '${S}' && !!__synopia.mounted()`);
while (await ev(`!!__synopia.cur().stream`)) { most = Math.max(most, await tablesWhile()); await sleep(250); }
const landed = await c.until(`__synopia.cur().state.status !== 'busy' && __synopia.cur().items.some(i => i.k === 'claude' && i.text.startsWith('Here is what the demo run found.'))`, 20000);
await sleep(300);
await stopLong(); const during = await long;
pinging = false; await pings;
check('the reply lands', landed);
check('tables show as tables while they stream', most >= 2, `most ${most}`);
check('the landed reply holds three tables', await ev(`[...document.querySelectorAll('#log .ln.claude')].pop().querySelectorAll('.tw table').length`) === 3);
check(`no long task over ${LONG} ms while it streams`, Math.max(0, ...during) <= LONG, `long tasks ${JSON.stringify(during)}`);
check(`the page answers within ${SLOW} ms all through`, slowest <= SLOW, `slowest ${slowest} ms`);

// a reload of the long session, read from its oldest item: the restore loads the earlier items to find it
await ev(`document.querySelector('#log [data-earlier]')?.click()`);
await c.until(`__synopia.cur().items.length === __synopia.cur().total`);
await ev(`document.getElementById('log').scrollTop = 0`); await sleep(300);
await ev(`dispatchEvent(new Event('pagehide'))`); // the UI state is stored (ui-state.js)
await cdp('Page.navigate', { url: 'about:blank' });
await c.load(`${url}#${S.slice(0, 8)}`, ready);
check('the reload restores the oldest item', await c.until(`!__synopia.restoring() && document.getElementById('log').scrollTop < 400`), JSON.stringify(await ev('__synopia.anchor()')));
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
await sleep(500);
const reload = watchLong(true); await sleep(100); await stopLong();
const atLoad = await reload;
check(`no long task over ${LONG} ms at a reload`, Math.max(0, ...atLoad) <= LONG, `long tasks ${JSON.stringify(atLoad)}`);
console.log(`long tasks while streaming ${JSON.stringify(during)}, at the reload ${JSON.stringify(atLoad)}; slowest answer ${slowest} ms`);
c.print(); c.close();
