// The exact UI state comes back after a page reload and after a backend restart (R3.9), on the fixture tree.
// usage: node restore.mjs <url> <state-dir> <claude-dir>
// Sets up: session 1 scrolled mid-way with a tool group and a step open, a diff open, a draft with its
// cursor and a pasted image; session 2's card half answered; session 4's subagent view on screen with the
// file preview open, scrolled, with a find query. Then: a reload, a backend restart (stop, start on the same
// state folder), a second restart in insert mode, and a send that removes the draft's files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, sleep } from './cdp.mjs';

const [url0, stateDir, claudeDir] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../../..');
const c = await connect();
const { ev, check, key } = c;
const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S4 = '44444444-0000-4000-8000-000000000004';
const AGENT = 'aaaa0001';
const PREVIEW = path.join(repo, 'app/backend/src/open.ts');
// a small viewport, so session 1's log scrolls
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 480, deviceScaleFactor: 1, mobile: false });
let url = url0;
const load = () => c.load(url);
const goTo = async (sid) => { await ev(`document.querySelector('.side .row[data-id="${sid}"]').click()`); return until(`current === '${sid}' && mounted === '${sid}|' && !uiRestoring && cur().items.length > 0`); };
const anchor = () => ev(`JSON.stringify(uiAnchor(document.getElementById('log')))`);
const near = (a, b) => { const x = JSON.parse(a), y = JSON.parse(b); return !x.bottom && x.id === y.id && Math.abs(x.off - y.off) <= 2; };
const flush = async () => { await ev('uiFlush()'); await sleep(300); };
async function restart() {
  await flush();
  const pid = +fs.readFileSync(path.join(stateDir, 'pid'), 'utf8');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await sleep(100); } catch { break; } }
  const port = new URL(url0).port;
  execFileSync(path.join(here, 'backend.sh'), [port, stateDir, '--fake', '--claude-dir', claudeDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = fs.readFileSync(path.join(stateDir, 'url'), 'utf8').trim();
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFTEMWwkAWi4/wW2YgD8AAAAASUVORK5CYII=';
const paste = () => ev(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'a.png', { type: 'image/png' }));
  document.getElementById('msg').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
const stepOpen = (name) => ev(`(() => { const d = [...document.querySelectorAll('#log details.step')].find(d => d.querySelector('summary').textContent.includes(${JSON.stringify(name)})); return !!d && d.open; })()`);
const diffOpen = () => ev(`(() => { const d = document.querySelector('#log .diff'); return !!d && !d.hidden && document.querySelector('#log .frow .fc').getAttribute('aria-expanded') === 'true'; })()`);
const foldOpen = () => ev(`!!document.querySelector('#log details.fold') && document.querySelector('#log details.fold').open`);
const card = () => ev(`JSON.stringify((({ typing, ...x }) => x)(qstate['${S2}:req-question-1'] || {}))`);

// ---------- set up ----------
check('the page loads', await load());
check('session 1 shows', await goTo(S1));
await ev(`document.querySelector('#log details.fold').open = true`);
await sleep(100);
await ev(`[...document.querySelectorAll('#log details.step')].find(d => d.querySelector('summary').textContent.includes('List the demo folder')).querySelector('summary').click()`);
await ev(`document.querySelector('#log .frow .fc').click()`);
await sleep(200);
await ev(`(() => { const l = document.getElementById('log'); l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) / 2); })()`);
await sleep(200);
const mid = await anchor();
check('session 1 is scrolled mid-way', !JSON.parse(mid).bottom && await ev(`document.getElementById('log').scrollTop > 40`), mid);
await ev(`(() => { const t = document.getElementById('msg'); t.value = 'a draft to keep'; t.dispatchEvent(new Event('input')); t.setSelectionRange(15, 15); })()`);
await paste(); // its [Image #1] tag at the caret (R5.13)
await ev(`document.getElementById('msg').setSelectionRange(2, 7)`);
check('the pasted image is read', await until(`attachments.length === 1 && !!attachments[0].data`));
check('session 2 shows its card', await goTo(S2) && await until(`!!document.querySelector('.qa-card')`));
for (const k of ['j', ' ', 'Enter', 'j', ' ']) await key(k);
const card0 = await card();
check('the card is half answered', /"picks":\{"0":\["No"\],"1":\["Docs"\]\}/.test(card0) && /"qi":1/.test(card0), card0);
check('session 4 shows', await goTo(S4));
await ev(`document.querySelector('[data-agent="${AGENT}"]').click()`);
check('its subagent view opens', await until(`view === '${AGENT}' && mounted === '${S4}|${AGENT}'`));
await ev(`(() => { pv.want = { path: ${JSON.stringify(PREVIEW)}, back: null, added: new Set(), cut: new Set(), first: 0 }; send({ t: 'preview', path: ${JSON.stringify(PREVIEW)} }); })()`);
check('the preview opens', await until(`previewShown()`));
await ev(`(() => { pvOpenFind(); const q = document.getElementById('pv-q'); q.value = 'export'; pvFind('export'); document.getElementById('pv-code').scrollTop = 300; })()`);
await sleep(150);
const pvScroll = await ev(`document.getElementById('pv-code').scrollTop`);
await flush();

// ---------- 1. reload the page ----------
async function checkSession1(tag, firstLoad) {
  if (!firstLoad) check(`${tag}: session 1 shows`, await goTo(S1));
  else check(`${tag}: session 1 is the one shown`, await until(`current === '${S1}' && mounted === '${S1}|' && !uiRestoring`));
  check(`${tag}: the scroll lands on the same item within 2 px`, near(await anchor(), mid), `${await anchor()} vs ${mid}`);
  check(`${tag}: the draft text and cursor`, await ev(`(() => { const t = document.getElementById('msg'); return t.value === 'a draft to keep [Image #1]' && t.selectionStart === 2 && t.selectionEnd === 7; })()`), await ev(`document.getElementById('msg').value`));
  check(`${tag}: the pasted image is back`, await until(`attachments.length === 1 && document.querySelectorAll('.composer .attach .thumb img').length === 1 && document.querySelector('.composer .attach .thumb img').naturalWidth === 8`));
  check(`${tag}: its bytes are back for sending`, await until(`/^data:image\\/png;base64,/.test(attachments[0].data || '')`));
  check(`${tag}: the step is open`, await stepOpen('List the demo folder'));
  check(`${tag}: the tool group is unfolded`, await foldOpen());
  check(`${tag}: the diff is open`, await diffOpen());
}
async function checkCard(tag) {
  check(`${tag}: session 2 shows its card`, await goTo(S2) && await until(`!!document.querySelector('.qa-card')`));
  check(`${tag}: the card's picks and cursor`, (await card()) === card0, await card());
  check(`${tag}: the card shows them`, await ev(`document.querySelector('.qa-card .acc[data-qi="0"] .ans')?.textContent === 'No' && !!document.querySelector('.qa-card .o.on[data-oi="1"]')`));
}
check('1: reloaded', await load());
check('1: the subagent view is back, with no default view first', await ev(`current === '${S4}' && view === '${AGENT}' && mounted === '${S4}|${AGENT}'`));
check('1: the preview is back, scrolled, with its find query', await until(`previewShown() && pv.path === ${JSON.stringify(PREVIEW)}`)
  && await ev(`document.getElementById('pv-q').value === 'export' && !document.getElementById('pv-find').hidden && Math.abs(document.getElementById('pv-code').scrollTop - ${pvScroll}) <= 1`), await ev(`document.getElementById('pv-code').scrollTop`));
await ev('hidePreview()');
await checkSession1('1', false);
await checkCard('1');

// ---------- 2. restart the backend, on a card with half a typed answer ----------
for (const k of ['j', 'j', 'i']) await key(k);
check('2: typing into the card', await until(`document.activeElement?.id === 'qa-own'`));
for (const ch of 'half') await key(ch);
const card1 = await card();
await restart();
check('2: reloaded on the restarted backend', await load());
check('2: session 2 and insert mode are back', await until(`current === '${S2}' && document.body.dataset.mode === 'insert'`));
check('2: the typed answer is back in its field', await until(`document.getElementById('qa-own')?.value === 'half' && document.activeElement?.id === 'qa-own'`), await ev(`document.getElementById('qa-own')?.value`));
check('2: the card state is back', (await card()) === card1, `${await card()} vs ${card1}`);
await ev(`document.getElementById('qa-own').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await checkSession1('2', false);

// ---------- 3. restart again, in session 1 in insert mode ----------
await key('i');
check('3: insert mode in the message box', await until(`document.body.dataset.mode === 'insert' && document.activeElement?.id === 'msg'`));
await ev(`document.getElementById('msg').setSelectionRange(2, 7)`);
await restart();
check('3: reloaded on the restarted backend', await load());
await checkSession1('3', true);
check('3: insert mode, in the message box', await ev(`document.body.dataset.mode === 'insert' && document.activeElement?.id === 'msg'`));
const drafts = path.join(stateDir, 'drafts', S1);
check('3: the draft image is a file', fs.existsSync(drafts) && fs.readdirSync(drafts).length === 1);
await key('Enter', { vk: 13 });
await sleep(400);
check('3: a send clears the draft and removes its file', await ev(`document.getElementById('msg').value === '' && attachments.length === 0`) && !fs.existsSync(drafts),
  `${await ev(`JSON.stringify([document.getElementById('msg').value, attachments.length])`)} ${fs.existsSync(drafts)}`);
const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
check('state.json has the ui field, no image bytes', st.ui && st.ui.current === S1 && !JSON.stringify(st).includes(png.slice(0, 40)));
// an anchor whose item is gone (a rewritten file) lands at the bottom
await goTo(S2);
await ev(`uiS['${S1}'].scroll[''] = { id: 'gone:item', off: 30 }`);
check('a stale anchor falls back to the bottom', await goTo(S1) && (await anchor()) === '{"bottom":true}', await anchor());
// the Open list, with its filter
await ev(`(() => { showOpenList(); const i = document.getElementById('ol-filter'); i.value = 'demo'; i.dispatchEvent(new Event('input')); })()`);
await flush();
check('the Open list comes back with its filter', await load() && await until(`openListShown() && document.getElementById('ol-filter').value === 'demo' && openList.filter === 'demo'`));
await c.cdp('Emulation.clearDeviceMetricsOverride');
c.print();
c.close();
