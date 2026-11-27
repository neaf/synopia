// What you last saw stays put, and a line marks what came since (R3.9, R5.12d): a view you are not looking at never
// scrolls, and coming back a 1px "New since 2:14 PM" line sits between the last item you saw and the first you
// didn't, on a made-up fixture with the scripted SDK. Session X has a long transcript, a running subagent and a
// background shell; session Y is short. Seen: an item's first line on screen for 1 s with the window focused.
// usage: node scroll.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node scroll.mjs <url> <state-dir> <claude-dir>
// Cases, each in the main conversation, the subagent view and the shell view where it applies:
//   looking at the bottom while it grows: it follows the bottom, and no line comes;
//   (a) at the bottom, or mid-way, then away on Y while X grows: back on X, the last block you saw is where it was
//       on screen (mid-way: the same anchor), and the line is in the gap under the last block you saw, above the
//       first you didn't, with that item's time; nothing moves when it comes or goes; it stays while you scroll
//       and after G; back from Y with nothing new it is gone; a quick flick through Y and back sees nothing;
//   (b) the same in X's subagent view (a shell view is a terminal since 2026-11-27, term.js, with its own scrollback:
//       no line inside its output, and it opens at its end);
//   (c) the window hidden while the shown view grows: nothing moves, no line, and when it is visible again you are
//       where you were, with the line;
//   (d) a reload while away: the same; then a reload on it keeps the line where it was.
// Writes scroll-divider.png.
// The page's state for a view it isn't on can't show the backend has read the new records, so the check asks the
// backend itself: its own socket views the same conversation and waits for the new text (backendHas).
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, keyTable, shot } from './helpers.mjs';

const X = 'e5e5e5e5-0000-4000-8000-0000000000e5', Y = 'e6e6e6e6-0000-4000-8000-0000000000e6';
const AGENT = 'cccc0001', SHELL = 'toolu_ssh', CWD = '/tmp/synopia-scroll';
const R = records(CWD);
const part = (n, what) => `${what} part ${n}.\n\n${Array.from({ length: 5 }, (_, i) => `- point ${i + 1} of part ${n}, made up to fill a line or two of the log`).join('\n')}`;
const now = () => new Date().toISOString();
const projDir = (claudeDir) => path.join(claudeDir, 'projects', '-tmp-synopia-scroll');
const agentFile = (claudeDir) => path.join(projDir(claudeDir), X, 'subagents', `agent-${AGENT}.jsonl`);
const tasksDir = (claudeDir) => path.join(path.dirname(claudeDir), 'tasks');
const side = (uuid, o) => R.rec(X, { isSidechain: true, agentId: AGENT, uuid, ...o });
const sideSaid = (uuid, ts, text) => side(uuid, { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

if (process.argv[2] === 'make') {
  const claudeDir = process.argv[3], dir = projDir(claudeDir), tasks = tasksDir(claudeDir);
  fs.mkdirSync(path.dirname(agentFile(claudeDir)), { recursive: true });
  fs.mkdirSync(tasks, { recursive: true });
  let x = R.you(X, 'x-u0', 0, 'Write the release notes, with a helper and a build in the background.')
    + R.tool(X, 'x-a0', 1, 'toolu_s1', 'Agent', { description: 'Check the changelog', subagent_type: 'general-purpose', prompt: 'made-up', run_in_background: true })
    + R.tool(X, 'x-a0b', 1, SHELL, 'Bash', { command: 'npm run build -- --watch', description: 'Build in watch mode', run_in_background: true })
    + R.rec(X, { type: 'user', uuid: 'x-r1', timestamp: new Date(Date.now() - 58_000).toISOString(), toolUseResult: { status: 'async_launched', agentId: AGENT, description: 'd', prompt: 'p', outputFile: '/tmp/o' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Async agent launched successfully.' }] } })
    + R.rec(X, { type: 'user', uuid: 'x-r2', timestamp: new Date(Date.now() - 58_000).toISOString(), toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bscroll1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SHELL, content: `Command running in background with ID: bscroll1. Output is being written to: ${tasks}/bscroll1.output You will be notified when it completes.` }] } });
  for (let i = 1; i <= 12; i++) x += R.said(X, `x-a${i}`, 2 + i, part(i, 'Release notes'));
  fs.writeFileSync(path.join(dir, `${X}.jsonl`), x);
  fs.writeFileSync(path.join(dir, `${Y}.jsonl`), R.you(Y, 'y-u1', 0, 'Rename the demo folder.') + R.said(Y, 'y-a1', 3, 'Renamed it.'));
  let a = side('c-u1', { type: 'user', timestamp: new Date(Date.now() - 58_000).toISOString(), message: { role: 'user', content: 'Check the changelog.' } });
  for (let i = 1; i <= 12; i++) a += sideSaid(`c-a${i}`, new Date(Date.now() - 50_000 + i * 1000).toISOString(), part(i, 'Changelog check'));
  fs.writeFileSync(agentFile(claudeDir), a);
  fs.writeFileSync(path.join(path.dirname(agentFile(claudeDir)), `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Check the changelog', toolUseId: 'toolu_s1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(tasks, 'bscroll1.output'), Array.from({ length: 120 }, (_, i) => `built page ${i + 1} of the demo site\n`).join(''));
  writeScript(claudeDir, 'scroll.mjs: made up', {
    [X]: { start: true, steps: [{ ago: 60000, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } }] },
    [Y]: { state: { status: 'idle', ago: 60000 } },
  });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url0, stateDir, claudeDir] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
const K = keyTable(c.key);
const wait = (expr, ms = 6000) => c.until(expr, ms);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 480, deviceScaleFactor: 1, mobile: false });

// ---------- writing to X, as its CLI would, and knowing the backend has it ----------
let n = 0;
const xFile = path.join(projDir(claudeDir), `${X}.jsonl`), outFile = path.join(tasksDir(claudeDir), 'bscroll1.output');
// what it wrote: its tag, the id the first new item starts with, the output's last line before it
function grow(where, count) {
  const tag = `grown ${++n}`, last = fs.readFileSync(outFile, 'utf8').trimEnd().split('\n').pop();
  const first = where === 'main' ? `x-g${n}-0` : where === 'agent' ? `c-g${n}-0` : null;
  grew(where, count, tag);
  return { tag, first, last, where };
}
function grew(where, count, tag) {
  if (where === 'main') fs.appendFileSync(xFile, Array.from({ length: count }, (_, i) => R.said(X, `x-g${n}-${i}`, 0, part(i + 1, `${tag},`)).replace(/"timestamp":"[^"]*"/, `"timestamp":"${now()}"`)).join(''));
  else if (where === 'agent') fs.appendFileSync(agentFile(claudeDir), Array.from({ length: count }, (_, i) => sideSaid(`c-g${n}-${i}`, now(), part(i + 1, `${tag},`))).join(''));
  else fs.appendFileSync(outFile, Array.from({ length: count * 6 }, (_, i) => `${tag}, line ${i + 1}\n`).join(''));
  return tag;
}
// the backend has read the new records: a socket of the check's own views the conversation and waits for the text
async function backendHas(where, tag) {
  const { WebSocket } = await import('../../../backend/node_modules/ws/wrapper.mjs');
  const u = new URL(url0), ws = new WebSocket(`ws://${u.host}/ws`, { origin: u.origin });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const got = new Promise((r) => {
    const t = setTimeout(() => r(false), 8000);
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') ws.send(JSON.stringify(where === 'shell' ? { t: 'view', sid: X, agent: null, bg: SHELL } : { t: 'view', sid: X, agent: where === 'agent' ? AGENT : null }));
      else if ((m.t === 'items' || m.t === 'output') && String(d).includes(tag)) { clearTimeout(t); r(true); }
      else if (m.t === 'items' || m.t === 'output') setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(where === 'shell' ? { t: 'view', sid: X, agent: null, bg: SHELL } : { t: 'view', sid: X, agent: where === 'agent' ? AGENT : null })), 300);
    });
  });
  ws.send(JSON.stringify({ t: 'auth', token: u.searchParams.get('token') }));
  const ok = await got;
  await new Promise((r) => { ws.on('close', r); ws.close(); });
  return ok;
}

// ---------- the page ----------
const NOT_ANCHOR = `/^(earlier|day:|live|stream|held:|queue)/`;
// the last block on screen (not the live line, the stream or the queue) and its top, from the log's top; `seen`, the
// furthest block whose first line is on screen (the seen rule's)
const lastSeen = () => ev(`(() => { const l = document.getElementById('log'), top = l.getBoundingClientRect().top, bot = l.getBoundingClientRect().bottom;
  const all = [...l.querySelector('.log-inner').children].filter(e => !${NOT_ANCHOR}.test(e.dataset.key || ''));
  const el = all.filter(e => e.getBoundingClientRect().top < bot).pop(), s = all.filter(e => e.getBoundingClientRect().top >= top - 1 && e.getBoundingClientRect().top < bot - 8).pop();
  return el ? { key: el.dataset.key, y: Math.round(el.getBoundingClientRect().top - top), seen: s?.dataset.key } : null; })()`);
const posOf = (key) => ev(`(() => { const l = document.getElementById('log'), el = [...l.querySelector('.log-inner').children].find(e => e.dataset.key === ${JSON.stringify(key)});
  return el ? Math.round(el.getBoundingClientRect().top - l.getBoundingClientRect().top) : null; })()`);
const atBottom = () => ev(`(() => { const l = document.getElementById('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; })()`);
const below = () => ev(`(() => { const l = document.getElementById('log'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`);
const toBottom = async () => { await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`); await sleep(150); };
const restored = (key) => `__synopia.mounted() === '${key}' && !__synopia.restoring() && document.querySelectorAll('#log .log-inner > [data-key]').length > 1`;
const goTo = async (sid) => { await ev(`document.querySelector('#groups .row[data-id="${sid}"]').click()`); return wait(`__synopia.current() === '${sid}' && ` + restored(`${sid}|`)); }; // a session opens on its main conversation
const openView = async (sel, key) => { await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); return wait(restored(key)); };
const flush = async () => { await ev(`dispatchEvent(new Event('pagehide'))`); await sleep(300); };
const SEE = 1300; // an item is seen after 1 s on screen with the window focused: wait a little more
const clock = (ms) => ev(`new Date(${ms}).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`); // as format.js hhmm
// where it lands: "kept" (the block you last saw where it was), "end" (the new end) or the pixels it moved
const where = async (seen) => { const y = await posOf(seen.key); return y == null ? 'gone' : Math.abs(y - seen.y) <= 2 ? 'kept' : (await atBottom()) ? `end (moved ${seen.y - y} px)` : `moved ${seen.y - y} px`; };
// the "New since" line: on a block (its key, the block before, the gap between them and the label's middle), or in
// a run's output (the lines either side); null when there is none
const divider = () => ev(`(() => { const l = document.getElementById('log'), lt = l.getBoundingClientRect().top, NA = ${NOT_ANCHOR};
  const all = l.querySelectorAll('.new-at, .nl-at'), m = l.querySelector('.nl-at'), b = l.querySelector('.log-inner > .new-at');
  if (!m && !b) return null;
  const lab = (m || b).querySelector('.nlab'), lr = lab.getBoundingClientRect(), mid = Math.round((lr.top + lr.bottom) / 2 - lt);
  const line = getComputedStyle(m || b, '::before'), color = line.backgroundColor, height = line.height;
  if (m) return { shell: true, n: all.length, label: lab.textContent, at: m.dataset.at, color, height, mid, y: Math.round(m.getBoundingClientRect().top - lt),
    before: (m.previousSibling?.data || '').replace(/\\n$/, '').split('\\n').pop(), after: (m.nextSibling?.data || '').split('\\n')[0] };
  const kids = [...l.querySelector('.log-inner').children], i = kids.indexOf(b), prevEl = kids[i - 1], prev = kids.slice(0, i).filter(e => !NA.test(e.dataset.key || '')).pop();
  const d = __synopia.cur(), items = [...(d.items || []), ...(d.agents || []).flatMap(a => a.items || [])], it = items.find(x => x.id === b.dataset.key);
  return { n: all.length, label: lab.textContent, key: b.dataset.key, prev: prev?.dataset.key, color, height, mid, ts: it?.ts || null,
    gap: [Math.round(prevEl.getBoundingClientRect().bottom - lt), Math.round(b.getBoundingClientRect().top - lt)] }; })()`);
// drawing or taking away the line moves nothing: every block, row and the scroll the same without it, and after it is back
const noMove = () => ev(`(() => { const l = document.getElementById('log');
  const snap = () => JSON.stringify([l.scrollTop, l.scrollHeight, ...[...l.querySelectorAll('.log-inner > *, .log-inner .res, .log-inner .out')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top * 10), Math.round(r.height * 10), Math.round(r.width * 10)]; })]);
  const a = snap();
  l.querySelectorAll('.nl-at').forEach(m => { const p = m.parentNode; m.remove(); p.normalize(); });
  l.querySelectorAll('.new-at').forEach(e => { e.classList.remove('new-at'); e.querySelector(':scope > .nlab')?.remove(); });
  const gone = !l.querySelector('.new-at, .nl-at'), b = snap();
  __synopia.render('log');
  return { same: a === b && b === snap(), gone, back: !!l.querySelector('.new-at, .nl-at') }; })()`);
// the view's last block: everything above the furthest item you saw counts as seen, so after G that is it
const lastKey = () => ev(`[...document.querySelectorAll('#log .log-inner > [data-key]')].map(e => e.dataset.key).filter(k => !${NOT_ANCHOR}.test(k)).pop()`);
const report = [];

check('the page loads', await c.load(url0));
check('X shows', await goTo(X));

// ---------- looking at the bottom while it grows: it follows, and no line ----------
await toBottom();
let g = grow('main', 3);
check('looking: the new records arrive', await wait(`document.getElementById('log').textContent.includes(${JSON.stringify(g.tag)})`, 8000));
await sleep(SEE);
check('looking at the bottom: it follows the bottom', await atBottom(), `${await below()} px below`);
check('looking at the bottom: no line', (await divider()) === null, await divider());

// ---------- away and back ----------
async function away(name, whereTo, count, viewSel, viewKey, setup) {
  if (viewSel) check(`${name}: the view opens`, await openView(viewSel, viewKey));
  await setup();
  await sleep(SEE);
  const t0 = Date.now(), seen = await lastSeen(), anc = await ev('JSON.stringify(__synopia.anchor())'), last = await lastKey();
  check(`${name}: Y shows`, await goTo(Y));
  const gg = grow(whereTo, count);
  check(`${name}: the backend has the new records`, await backendHas(whereTo, gg.tag));
  return { seen, anc, last, g: gg, t0, t1: Date.now() };
}
// back on X: the place you left, and the line exactly between the last block you saw and the first you didn't
async function back(name, r, viewKey, viewSel) {
  check(`${name}: X shows again`, await goTo(X) && (!viewSel || await openView(viewSel, viewKey)));
  await sleep(200);
  const w = await where(r.seen);
  report.push(`${name}: ${w}`);
  check(`${name}: the block you last saw is where it was`, w === 'kept', `${w}; ${JSON.stringify(r.seen)}`);
  check(`${name}: not at the new end`, (await atBottom()) === false);
  return lineAfter(name, r);
}
async function lineAfter(name, r) {
  const d = await divider();
  check(`${name}: one line`, d?.n === 1, d);
  if (!d) return null;
  check(`${name}: a 1px line in the link blue`, d.height === '1px' && /^rgb\(/.test(d.color), `${d.height} ${d.color}`);
  if (r.g.where === 'shell') {
    const okTime = [await clock(r.t0), await clock(r.t1)].map(t => `New since ${t}`).includes(d.label);
    check(`${name}: "New since" the time you last saw it`, okTime, d.label);
    check(`${name}: between the last line you saw and the first you didn't`, d.after === `${r.g.tag}, line 1` && d.before === r.g.last, `${JSON.stringify(d.before)} | ${JSON.stringify(d.after)}`);
    return d;
  }
  check(`${name}: above the first item you hadn't seen`, d.key.startsWith(r.g.first), `${d.key} vs ${r.g.first}`);
  check(`${name}: below the last one you saw`, d.prev === r.last, `${d.prev} vs ${r.last}`);
  check(`${name}: in the gap between them`, d.gap[0] <= d.mid && d.mid <= d.gap[1], `${d.mid} in ${d.gap}`);
  check(`${name}: "New since" that item's time`, d.label === `New since ${await clock(Date.parse(d.ts))}`, `${d.label}, item at ${d.ts}`);
  return d;
}
async function stays(name, d) {
  const same = (x) => x && x.n === 1 && (d.shell ? x.at === d.at : x.key === d.key) && x.label === d.label;
  const m = await noMove();
  check(`${name}: nothing moves when the line comes or goes`, m.same && m.gone && m.back, m);
  await ev(`document.getElementById('log').scrollTop = 0`); await sleep(SEE);
  check(`${name}: it stays when you scroll up`, same(await divider()), await divider());
  await K.G(); await sleep(SEE);
  check(`${name}: G goes to the end, and the line stays`, await atBottom() && same(await divider()), `${await below()} px below, ${JSON.stringify(await divider())}`);
}

// (a) at the bottom: the line above the first new item
let r = await away('a, at the bottom', 'main', 6, null, null, toBottom);
let d = await back('a, at the bottom', r, `${X}|`);
await shot(c, path.join(stateDir, 'scroll-divider.png'));
if (d) await stays('a', d);
// leave and come back with nothing new: it goes
check('a: Y shows', await goTo(Y));
check('a: X shows again', await goTo(X));
await sleep(200);
check('a: back with nothing new, no line', (await divider()) === null, await divider());

// (a) mid-way: the end was seen before, so the line is still under it; quick flicks see nothing
r = await away('a, mid-way', 'main', 4, null, null, async () => { await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) / 2); })()`); });
check('a, mid-way: X shows again', await goTo(X));
await sleep(200);
const ancNow = await ev('JSON.stringify(__synopia.anchor())');
const ancOk = (() => { const a = JSON.parse(r.anc), b = JSON.parse(ancNow); return !a.bottom && a.id === b.id && Math.abs(a.off - b.off) <= 2; })();
report.push(`a, mid-way: ${ancOk ? 'kept' : `${ancNow} vs ${r.anc}`}`);
check('a, mid-way: the same anchor', ancOk, `${ancNow} vs ${r.anc}`);
d = await lineAfter('a, mid-way', r);
check('a, mid-way: Y shows, quickly', await goTo(Y));
check('a, mid-way: X shows, quickly', await goTo(X));
await sleep(200);
const d2 = await divider();
check('a, mid-way: a flick through sees nothing, so the line is back in the same place', d2?.key === d?.key, d2);
await K.G(); await sleep(SEE);

// (b) the subagent view
r = await away('b, subagent', 'agent', 5, `.rail .card[data-agent="${AGENT}"]`, `${X}|${AGENT}`, toBottom);
d = await back('b, subagent', r, `${X}|${AGENT}`, `.rail .card[data-agent="${AGENT}"]`);
if (d) await stays('b, subagent', d);
await ev(`document.querySelector('#conv [data-back]').click()`);
check('back in the main conversation', await wait(restored(`${X}|`)));

// (c) the window hidden while the shown view grows
await K.G(); await sleep(SEE);
const seenC = await lastSeen(), lastC = await lastKey();
// the window in the background: chrome-headless-shell keeps a tab visible under another one in front (tried,
// 2026-11-25), so the document's visibilityState stands in, with its visibilitychange event, as WKWebView sends them
await ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))`);
g = grow('main', 5);
check('c: the new records arrive while hidden', await wait(`document.getElementById('log').textContent.includes(${JSON.stringify(g.tag)})`, 8000));
await sleep(SEE);
const wHidden = await where(seenC);
check('c: hidden, nothing moves', wHidden === 'kept', wHidden);
check('c: hidden, no line yet', (await divider()) === null, await divider());
await ev(`delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
check('c: visible again', await wait(`document.visibilityState === 'visible'`, 3000));
await sleep(200);
const wC = await where(seenC);
report.push(`c, hidden: ${wC}`);
check('c: visible again, the block you last saw is where it was', wC === 'kept', `${wC}; ${JSON.stringify(seenC)}`);
d = await lineAfter('c', { seen: seenC, last: lastC, g });
if (d) await stays('c', d);

// (e) what you wrote is never new (2026-11-27): a prompt of yours while away, then Claude's reply; the line goes
// under your prompt, and with only your prompt there is no line
{
  await K.G(); await sleep(SEE);
  const stamp = (s) => s.replace(/"timestamp":"[^"]*"/, `"timestamp":"${now()}"`);
  check('e: Y shows', await goTo(Y));
  const tagE = `grown ${++n}`;
  fs.appendFileSync(xFile, stamp(R.you(X, `x-e${n}-u`, 0, `${tagE}, your question`)));
  check('e: the backend has your prompt', await backendHas('main', tagE));
  check('e: X shows again', await goTo(X)); await sleep(200);
  check('e: only your prompt came: no line', (await divider()) === null, await divider());
  await K.G(); await sleep(SEE);
  check('e: Y shows', await goTo(Y));
  fs.appendFileSync(xFile, stamp(R.you(X, `x-e${n}-u2`, 0, `${tagE}, your next question`)) + stamp(R.said(X, `x-e${n}-a`, 0, `${tagE}, Claude's answer`)));
  check('e: the backend has the answer', await backendHas('main', `${tagE}, Claude's answer`));
  check('e: X shows again', await goTo(X)); await sleep(200);
  const de = await divider();
  check('e: the line sits under your prompt, above the answer', de?.n === 1 && de.key.startsWith(`x-e${n}-a`) && /^you:/.test(de.prev || ''), de);
}

// (d) a reload while away; then a reload while it shows keeps it where it was
async function reloadCase(name, whereTo, count, viewSel, viewKey) {
  if (viewSel) check(`${name}: the view opens`, await openView(viewSel, viewKey));
  await toBottom(); await sleep(SEE);
  const t0 = Date.now(), seen = await lastSeen(), last = await lastKey();
  check(`${name}: Y shows`, await goTo(Y));
  await flush();
  const gg = grow(whereTo, count);
  check(`${name}: the backend has the new records`, await backendHas(whereTo, gg.tag));
  check(`${name}: reloaded`, await c.load(url0));
  const rr = { seen, last, g: gg, t0, t1: Date.now() };
  const dd = await back(name, rr, viewKey, viewSel);
  await flush();
  check(`${name}: reloaded on it`, await c.load(url0));
  const again = await divider();
  check(`${name}: after a reload the line is where it was`, !!dd && again?.n === 1 && again.label === dd.label && (dd.shell ? again.at === dd.at : again.key === dd.key), again);
  await K.G(); await sleep(SEE);
}
await reloadCase('d, main', 'main', 6, null, `${X}|`);


console.log(report.join('\n'));
await c.cdp('Emulation.clearDeviceMetricsOverride');
c.print();
c.close();
