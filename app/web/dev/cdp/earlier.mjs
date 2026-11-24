// Loading earlier items (plan sections 5 and 7) on a generated long transcript, never committed.
// usage: node earlier.mjs make <claude-dir>   writes the transcript (run.sh does this first)
//        node earlier.mjs <url> <state-dir> <claude-dir>
// Checks: the link's text, the place kept on screen, items in order with no duplicates, `g` at the
// top, the end of history with no link, a live append after loading, a subagent view, a reset.
import fs from 'node:fs';
import path from 'node:path';

const SID = 'e0e0e0e0-0000-4000-8000-0000000000e0', AID = 'e1e1e1e1', MAIN = 600, SUB = 250;
const line = (o) => JSON.stringify(o) + '\n';
const ts = (i) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + i * 7000).toISOString();
const words = (i) => Array.from({ length: 1 + (i * 7) % 23 }, (_, w) => `word${(i + w) % 97}`).join(' ');
// Item i: a prompt (even) or Claude's reply (odd), of varied lengths. Ids are their uuids.
function rec(i, side = false) {
  const base = { uuid: `${side ? 's' : 'm'}${i}`, timestamp: ts(i), cwd: '/tmp/synopia-earlier', sessionId: SID, ...(side ? { isSidechain: true, agentId: AID } : {}) };
  return line(i % 2 === 0 && !side
    ? { ...base, type: 'user', message: { role: 'user', content: `Prompt ${i}: ${words(i)}` } }
    : { ...base, type: 'assistant', message: { id: `msg_${side ? 's' : 'm'}${i}`, role: 'assistant', content: [{ type: 'text', text: `Reply ${i}. ${words(i)}${i % 5 ? '' : '\n\n' + words(i + 1)}` }] } });
}
const mainFile = (dir) => path.join(dir, 'projects', '-tmp-synopia-earlier', `${SID}.jsonl`);
const body = (n, side = false) => Array.from({ length: n }, (_, i) => rec(i, side)).join('');

if (process.argv[2] === 'make') {
  const dir = process.argv[3], sub = path.join(dir, 'projects', '-tmp-synopia-earlier', SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(mainFile(dir), body(MAIN));
  fs.writeFileSync(path.join(sub, `agent-${AID}.jsonl`), line({ type: 'user', uuid: 's-start', timestamp: ts(0), isSidechain: true, agentId: AID, message: { role: 'user', content: 'Walk the long list.' } }) + body(SUB - 1, true));
  fs.writeFileSync(path.join(sub, `agent-${AID}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Walk the long list', finished: true }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir, claudeDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(url + `#${SID.slice(0, 8)}`, `current === '${SID}'`);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const until = async (expr, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ids = () => ev(`(() => { const s = cur(), A = view && agentById(s, view); return (A || s).items.map(i => i.id); })()`);
const link = () => ev(`document.querySelector('#log .earlier')?.textContent ?? null`);
// a reply's item id is its record uuid plus `:<block index>`
const inOrder = (got, prefix, from, to) => got.length === to - from && got.every((id, k) => id.replace(/:\d+$/, '') === `${prefix}${from + k}`);
const noDupKeys = () => ev(`(() => { const k = [...document.querySelectorAll('#log .log-inner > *')].map(e => e.dataset.key); return new Set(k).size === k.length; })()`);
// The block at the top of the screen and where it sits; after a load it must sit at the same place.
const place = () => ev(`(() => { const log = document.getElementById('log'), top = log.getBoundingClientRect().top;
  const el = [...log.querySelector('.log-inner').children].find(e => !/^(earlier|day:)/.test(e.dataset.key) && e.getBoundingClientRect().bottom > top);
  return { key: el.dataset.key, y: Math.round(el.getBoundingClientRect().top - top), text: el.textContent.slice(0, 40) }; })()`);
const where = (k) => ev(`(() => { const log = document.getElementById('log'); const el = [...log.querySelector('.log-inner').children].find(e => e.dataset.key === ${JSON.stringify(k)});
  return el ? { key: el.dataset.key, y: Math.round(el.getBoundingClientRect().top - log.getBoundingClientRect().top), text: el.textContent.slice(0, 40) } : null; })()`);
const same = (a, b) => b && a.key === b.key && a.text === b.text && Math.abs(a.y - b.y) <= 1;

check('loaded the session', await until(`cur()?.id === '${SID}' && cur().items.length === 160`));
check('the link: "Show 160 earlier (440 more)"', (await link()) === 'Show 160 earlier (440 more)', await link());
check('the last 160, in order', inOrder(await ids(), 'm', 440, 600));
await ev(`document.getElementById('log').scrollTop = 0`);
fs.writeFileSync(path.join(stateDir, 'earlier-link.png'), Buffer.from((await c.cdp('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 1280, height: 300, scale: 1 } })).result.data, 'base64'));

// Scrolled a little below the top, so the block read sits mid-screen; then a click.
// The web fonts first (index.html, display=swap): their swap rewraps the text and moves every block.
await ev(`document.fonts.ready.then(() => true)`);
await ev(`document.getElementById('log').scrollTop = 0`);
await ev(`document.getElementById('log').scrollTop = 120`);
let before = await place();
// a second click before the reply: both in one evaluate, so the reply can't land between them
await ev(`(() => { const b = () => document.querySelector('#log .earlier button'); b().click(); b()?.click(); })()`);
check('a click sends one earlier message, before the oldest id', await until(`cur().items.length === 320`)
  && JSON.stringify(await ev(`__sent.filter(m => m.t === 'earlier')`)) === JSON.stringify([{ t: 'earlier', sid: SID, agent: null, before: 'm440' }]),
  JSON.stringify(await ev(`__sent.filter(m => m.t === 'earlier')`)));
check('the place on screen is kept', same(before, await where(before.key)), JSON.stringify([before, await where(before.key)]));
check('320 items in order, no duplicates', inOrder(await ids(), 'm', 280, 600) && await noDupKeys());
check('the link: "Show 160 earlier (280 more)"', (await link()) === 'Show 160 earlier (280 more)', await link());

// g goes to the top; g at the top loads the next page, keeping the place.
await key('g', { code: 'KeyG', vk: 71 });
check('g: to the top, nothing sent', (await ev(`document.getElementById('log').scrollTop`)) === 0 && (await ev(`__sent.filter(m => m.t === 'earlier').length`)) === 1);
before = await place();
await key('g', { code: 'KeyG', vk: 71 });
check('g at the top: 160 more', await until(`cur().items.length === 480`) && inOrder(await ids(), 'm', 120, 600));
check('g at the top: the place on screen is kept', same(before, await where(before.key)), JSON.stringify([before, await where(before.key)]));
check('the last page reads "Show 120 earlier"', (await link()) === 'Show 120 earlier', await link());
await ev(`document.querySelector('#log .earlier button').click()`);
check('the whole history: 600 in order, no link', await until(`cur().items.length === 600`) && inOrder(await ids(), 'm', 0, 600) && (await link()) === null && await noDupKeys());

// A live append after loading earlier: at the end, once, with the place kept.
await ev(`document.getElementById('log').scrollTop = 2000`);
before = await place();
fs.appendFileSync(mainFile(claudeDir), rec(MAIN) + rec(MAIN + 1));
check('a live append lands at the end', await until(`cur().items.length === 602`, 5000));
const all = await ids();
check('602 in order, no duplicates', inOrder(all, 'm', 0, 602) && new Set(all).size === 602 && await noDupKeys());
check('the append keeps the place', same(before, await where(before.key)), JSON.stringify([before, await where(before.key)]));

// A subagent view pages its own transcript.
await ev(`view = '${AID}'; renderConv()`);
check('subagent: the last 160', await until(`agentById(cur(), '${AID}')?.items?.length === 160`) && (await link()) === 'Show 90 earlier', await link());
await ev(`document.querySelector('#log .earlier button').click()`);
check('subagent: all 250, no link', await until(`agentById(cur(), '${AID}').items.length === 250`) && (await link()) === null);
const sub = await ids();
check('subagent: in order, no duplicates', sub[0] === 's-start' && inOrder(sub.slice(1), 's', 0, SUB - 1) && await noDupKeys());
check('subagent: the earlier message names it', (await ev(`__sent.filter(m => m.t === 'earlier').pop().agent`)) === AID);

// Back to the main view: the earlier items it had loaded are asked for again (R3.9); a rewrite resets to the last 160.
// The store still holds the 602 items from before the subagent view: wait for the restore to finish
// (the one reset reply from the oldest item it had), not for those.
const sentBefore = await ev(`__sent.length`);
await ev(`view = null; renderConv()`);
const asked = () => ev(`__sent.slice(${sentBefore}).map(m => m.t + ' ' + m.agent + (m.before ? ' ' + m.before : ''))`);
check('back: the earlier items it had come back', await until(`!uiRestoring && cur().items.length === 602 && cur().items[0].id === 'm0'`)
  && (await link()) === null && await noDupKeys()
  // one request: the view carries the oldest item it had (from: m0), and one reset brings them all
  && JSON.stringify((await asked()).filter(x => !x.startsWith('ui '))) === JSON.stringify(['view null'])
  && (await ev(`__sent.slice(${sentBefore}).find(m => m.t === 'view')?.from`)) === 'm0',
  JSON.stringify(await asked()));
fs.writeFileSync(mainFile(claudeDir) + '.new', body(400));
fs.renameSync(mainFile(claudeDir) + '.new', mainFile(claudeDir));
check('a reset: the last 160 of the new file', await until(`cur().items.length === 160 && cur().items[0].id === 'm240'`, 5000) && (await link()) === 'Show 160 earlier (240 more)', await link());

c.print();
c.close();
