// The exact UI state comes back after a page reload and after a backend restart (R3.9), on the fixture tree.
// usage: node restore.mjs <url> <state-dir> <claude-dir>
// Sets up: session 1 scrolled mid-way with a tool group and a step open, a diff open, a draft with its
// cursor and a pasted image; session 2's card half answered; session 4's subagent view on screen with the
// file preview open, scrolled, with a find query. Then: a reload, a backend restart (stop, start on the same
// state folder), a second restart in insert mode, and a send that removes the draft's files. Last, the card
// answered while the backend is down: refused with a toast, its picks kept, and answered once it is back.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, sleep } from './cdp.mjs';
import { keyTable, serverSend } from './helpers.mjs';

const [url0, stateDir, claudeDir] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../../..');
const c = await connect();
const { ev, check, key } = c;
const K = keyTable(key);
const wait = (expr, ms = 6000) => c.until(expr, ms);
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S4 = '44444444-0000-4000-8000-000000000004';
const AGENT = 'aaaa0001';
const PREVIEW = path.join(repo, 'app/backend/src/open.ts');
// a small viewport, so session 1's log scrolls
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 480, deviceScaleFactor: 1, mobile: false });
let url = url0;
const load = () => c.load(url);
const goTo = async (sid) => { await ev(`document.querySelector('.side .row[data-id="${sid}"]').click()`); return wait(`__synopia.current() === '${sid}' && __synopia.mounted() === '${sid}|' && !__synopia.restoring() && __synopia.cur().items.length > 0`); };
const anchor = () => ev(`JSON.stringify(__synopia.anchor())`);
const near = (a, b) => { const x = JSON.parse(a), y = JSON.parse(b); return !x.bottom && x.id === y.id && Math.abs(x.off - y.off) <= 2; };
// the UI state goes to the backend now (ui-state.js flushes on pagehide), not after its debounce
const flush = async () => { await ev(`dispatchEvent(new Event('pagehide'))`); await sleep(300); };
async function restart() {
  await flush();
  await stopBackend();
  startBackend();
}
async function stopBackend(signal = 'SIGTERM') {
  const pid = +fs.readFileSync(path.join(stateDir, 'pid'), 'utf8');
  process.kill(pid, signal);
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await sleep(100); } catch { break; } }
}
function startBackend() {
  const port = new URL(url0).port;
  execFileSync(path.join(here, 'backend.sh'), [port, stateDir, '--claude-dir', claudeDir, '--sdk-script', path.join(claudeDir, 'sdk-script.json')], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = fs.readFileSync(path.join(stateDir, 'url'), 'utf8').trim();
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFTEMWwkAWi4/wW2YgD8AAAAASUVORK5CYII=';
const paste = () => ev(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'a.png', { type: 'image/png' }));
  document.getElementById('msg').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
const stepOpen = (name) => ev(`(() => { const d = [...document.querySelectorAll('#log details.step')].find(d => d.querySelector('summary').textContent.includes(${JSON.stringify(name)})); return !!d && d.open; })()`);
const diffOpen = () => ev(`(() => { const d = document.querySelector('#log .diff'); return !!d && !d.hidden && document.querySelector('#log .frow .fc').getAttribute('aria-expanded') === 'true'; })()`);
const foldOpen = () => ev(`!!document.querySelector('#log details.fold') && document.querySelector('#log details.fold').open`);
const card = () => ev(`JSON.stringify((({ typing, ...x }) => x)(__synopia.cards()['${S2}:req-question-1'] || {}))`);

// ---------- set up ----------
check('the page loads', await load());
check('session 1 shows', await goTo(S1));
await ev(`document.querySelector('#log details.fold').open = true`);
await sleep(100);
await ev(`[...document.querySelectorAll('#log details.step')].find(d => d.querySelector('summary').textContent.includes('Grep(TODO)')).querySelector('summary').click()`);
await ev(`document.querySelector('#log .frow .fc').click()`);
await sleep(200);
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) / 2); })()`);
await sleep(200);
const mid = await anchor();
check('session 1 is scrolled mid-way', !JSON.parse(mid).bottom && await ev(`document.getElementById('log').scrollTop > 40`), mid);
await ev(`(() => { const t = document.getElementById('msg'); t.value = 'a draft to keep'; t.dispatchEvent(new Event('input')); t.setSelectionRange(15, 15); })()`);
await paste(); // its [Image #1] tag at the caret (R5.13)
await ev(`document.getElementById('msg').setSelectionRange(2, 7)`);
check('the pasted image is read', await wait(`__synopia.attachments().length === 1 && !!__synopia.attachments()[0].data`));
check('session 2 shows its card', await goTo(S2) && await wait(`!!document.querySelector('.qa-card')`));
// single choice: Enter picks the row under the cursor, replacing Space's pick, then jumps to the open question
for (const k of [' ', 'j', 'Enter']) await key(k);
const cardE = await card();
check('Enter on a single-choice row picks it and moves on', /"picks":\{"0":\["No"\]\}/.test(cardE) && /"qi":1,"oi":0/.test(cardE), cardE);
// multiple choice: Enter doesn't toggle
for (const k of ['j', 'Enter']) await key(k);
const cardM = await card();
check('Enter on a multiple-choice row leaves it', /"picks":\{"0":\["No"\]\}/.test(cardM) && /"qi":1/.test(cardM), cardM);
for (const k of ['j', ' ']) await key(k);
const card0 = await card();
check('the card is half answered', /"picks":\{"0":\["No"\],"1":\["Docs"\]\}/.test(card0) && /"qi":1/.test(card0), card0);
check('session 4 shows', await goTo(S4));
await ev(`document.querySelector('[data-agent="${AGENT}"]').click()`);
check('its subagent view opens', await wait(`__synopia.view() === '${AGENT}' && __synopia.mounted() === '${S4}|${AGENT}'`));
// a link to the file, clicked: any a[data-path] asks for the preview (transcript.js, preview.js)
await ev(`(() => { const a = document.createElement('a'); a.href = '#'; a.dataset.path = ${JSON.stringify(PREVIEW)}; document.body.append(a); a.click(); a.remove(); })()`);
check('the preview opens', await wait(`__synopia.preview().shown`));
await K.slash(); // its find box
for (const ch of 'export') await c.cdp('Input.insertText', { text: ch });
await ev(`document.getElementById('pv-code').scrollTop = 300`);
await sleep(150);
const pvScroll = await ev(`document.getElementById('pv-code').scrollTop`);
await flush();

// ---------- 1. reload the page ----------
async function checkSession1(tag, firstLoad) {
  if (!firstLoad) check(`${tag}: session 1 shows`, await goTo(S1));
  else check(`${tag}: session 1 is the one shown`, await wait(`__synopia.current() === '${S1}' && __synopia.mounted() === '${S1}|' && !__synopia.restoring()`));
  check(`${tag}: the scroll lands on the same item within 2 px`, near(await anchor(), mid), `${await anchor()} vs ${mid}`);
  check(`${tag}: the draft text and cursor`, await ev(`(() => { const t = document.getElementById('msg'); return t.value === 'a draft to keep [Image #1] ' && t.selectionStart === 2 && t.selectionEnd === 7; })()`), await ev(`document.getElementById('msg').value`));
  check(`${tag}: the pasted image is back`, await wait(`__synopia.attachments().length === 1 && document.querySelectorAll('.composer .attach .thumb img').length === 1 && document.querySelector('.composer .attach .thumb img').naturalWidth === 8`));
  check(`${tag}: its bytes are back for sending`, await wait(`/^data:image\\/png;base64,/.test(__synopia.attachments()[0].data || '')`));
  check(`${tag}: the step is open`, await stepOpen('Grep(TODO)'));
  check(`${tag}: the tool group is unfolded`, await foldOpen());
  check(`${tag}: the diff is open`, await diffOpen());
}
async function checkCard(tag) {
  check(`${tag}: session 2 shows its card`, await goTo(S2) && await wait(`!!document.querySelector('.qa-card')`));
  check(`${tag}: the card's picks and cursor`, (await card()) === card0, await card());
  check(`${tag}: the card shows them`, await ev(`document.querySelector('.qa-card .acc[data-qi="0"] .ans')?.textContent === 'No' && !!document.querySelector('.qa-card .o.on[data-oi="1"]')`));
}
check('1: reloaded', await load());
check('1: the subagent view is back, with no default view first', await ev(`__synopia.current() === '${S4}' && __synopia.view() === '${AGENT}' && __synopia.mounted() === '${S4}|${AGENT}'`));
check('1: the preview is back, scrolled, with its find query', await wait(`__synopia.preview().shown && __synopia.preview().path === ${JSON.stringify(PREVIEW)}`)
  && await ev(`document.getElementById('pv-q').value === 'export' && !document.getElementById('pv-find').hidden && Math.abs(document.getElementById('pv-code').scrollTop - ${pvScroll}) <= 1`), await ev(`document.getElementById('pv-code').scrollTop`));
await K.esc(); if (await ev(`__synopia.preview().shown`)) await K.esc(); // the find box first, if it has the focus
check('1: Esc closes the preview', (await ev(`__synopia.preview().shown`)) === false);
await checkSession1('1', false);
await checkCard('1');

// ---------- 2. restart the backend, on a card with half a typed answer ----------
for (const k of ['j', 'j', 'i']) await key(k);
check('2: typing into the card', await wait(`document.activeElement?.id === 'qa-own'`));
for (const ch of 'half') await key(ch);
const card1 = await card();
await restart();
check('2: reloaded on the restarted backend', await load());
check('2: session 2 and insert mode are back', await wait(`__synopia.current() === '${S2}' && document.body.dataset.mode === 'insert'`));
check('2: the typed answer is back in its field', await wait(`document.getElementById('qa-own')?.value === 'half' && document.activeElement?.id === 'qa-own'`), await ev(`document.getElementById('qa-own')?.value`));
check('2: the card state is back', (await card()) === card1, `${await card()} vs ${card1}`);
await ev(`document.getElementById('qa-own').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await checkSession1('2', false);

// ---------- 3. restart again, in session 1 in insert mode ----------
await key('i');
check('3: insert mode in the message box', await wait(`document.body.dataset.mode === 'insert' && document.activeElement?.id === 'msg'`));
await ev(`document.getElementById('msg').setSelectionRange(2, 7)`);
await restart();
check('3: reloaded on the restarted backend', await load());
await checkSession1('3', true);
check('3: insert mode, in the message box', await ev(`document.body.dataset.mode === 'insert' && document.activeElement?.id === 'msg'`));
const drafts = path.join(stateDir, 'drafts', S1);
check('3: the draft image is a file', fs.existsSync(drafts) && fs.readdirSync(drafts).length === 1);
await key('Enter', { vk: 13 });
await sleep(400);
check('3: a send clears the draft and removes its file', await ev(`document.getElementById('msg').value === '' && __synopia.attachments().length === 0`) && !fs.existsSync(drafts),
  `${await ev(`JSON.stringify([document.getElementById('msg').value, __synopia.attachments().length])`)} ${fs.existsSync(drafts)}`);
const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
check('state.json has the ui field, no image bytes', st.ui && st.ui.current === S1 && !JSON.stringify(st).includes(png.slice(0, 40)));
// an anchor whose item is gone (a rewritten file) lands at the bottom
// stored by another page (the last writer wins), then a reload
await goTo(S2); await flush();
await serverSend(url, { t: 'ui', patch: { sessions: { [S1]: { scroll: { '': { id: 'gone:item', off: 30 } } } } } });
check('a reload after the anchor changed', await load());
check('a stale anchor falls back to the bottom', await goTo(S1) && JSON.parse(await anchor()).bottom === true
  && await ev(`(() => { const l = document.getElementById('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 1; })()`), await anchor());
// a reconnect is a second hello (sessions without items) on the view on screen: the log keeps its blocks
// until the view's reset comes, not one frame blank, and then shows the same blocks
await goTo(S1);
const recon = await ev(`(async () => {
  const inner = document.querySelector('#log .log-inner'), keys = () => [...inner.children].map(e => e.dataset.key).join(' ');
  const k0 = keys(), first = inner.firstElementChild;
  const ss = __synopia.data().map(s => ({ ...s, items: [] }));
  __synopia.inject({ t: 'hello', sessions: ss, layout: __synopia.layout(), menu: {}, ui: null,
    pending: ss.flatMap(s => __synopia.pending(s.id).map(request => ({ sid: s.id, request }))) });
  const held = keys() === k0 && inner.firstElementChild === first && __synopia.restoring();
  for (let i = 0; i < 50 && __synopia.restoring(); i++) await new Promise(r => setTimeout(r, 100));
  return { held, after: keys() === k0 && !__synopia.restoring(), k0: k0.slice(0, 80), k1: keys().slice(0, 80) };
})()`);
check('a reconnect keeps the log as it was until its reset', recon?.held === true, JSON.stringify(recon));
check('after the reset the log shows the same blocks', recon?.after === true, JSON.stringify(recon));
// the Open list, with its filter
await ev(`(() => { document.getElementById('open').click(); const i = document.getElementById('ol-filter'); i.value = 'demo'; i.dispatchEvent(new Event('input')); })()`);
await flush();
check('the Open list comes back with its filter', await load() && await wait(`__synopia.openList().shown && document.getElementById('ol-filter').value === 'demo' && __synopia.openList().filter === 'demo'`));

// ---------- the card answered while the backend is down (requirements Q9) ----------
check('4: session 2 shows its card', await goTo(S2) && await wait(`!!document.querySelector('#qa-send')`));
const card2 = await card();
await stopBackend('SIGKILL'); // a crash: the page keeps what it showed
check('4: the page sees the socket down', await wait(`__synopia.readiness().connected === false`, 8000));
await ev('__synopia.spy()');
await ev(`document.getElementById('qa-send').click()`);
check('4: offline, the answer is refused with a toast', await wait(`/answer wasn't sent/.test(document.getElementById('toast').textContent)`), await ev(`document.getElementById('toast').textContent`));
check('4: nothing went, the picks are kept', (await ev(`__synopia.sent('answer').length`)) === 0 && (await card()) === card2 && await ev(`!!document.querySelector('.qa-card')`), `${await card()} vs ${card2}`);
startBackend();
check('4: reloaded on the backend that is back', await load());
check('4: the card keeps its picks', await goTo(S2) && await wait(`!!document.querySelector('#qa-send')`) && (await card()) === card2, `${await card()} vs ${card2}`);
await ev('__synopia.spy()');
await ev(`document.getElementById('qa-send').click()`);
check('4: online, the answer goes with an id and is acked; then its picks go', await wait(`(([a]) => !!a && __synopia.received('ack').some(k => k.id === a.id && k.ok === true))(__synopia.sent('answer')) && !__synopia.cards()['${S2}:req-question-1']`),
  JSON.stringify(await ev(`[__synopia.sent('answer'), __synopia.received('ack')]`)));
await c.cdp('Emulation.clearDeviceMetricsOverride');
c.print();
c.close();
