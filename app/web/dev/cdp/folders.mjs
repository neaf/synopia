// New session and Open session in any folder (R3.3, R3.11-R3.14, R9.7), on a made-up fixture with the scripted SDK.
// usage: node folders.mjs make <claude-dir>   writes the fixture and its state (run.sh does this first)
//        node folders.mjs <url> <state-dir> <claude-dir>
// Checks: n opens the folder list with the folder on screen selected; the rows on screen get one gone check, a gone
// folder is dimmed and skipped; the matcher filters and marks; a typed path reads its folder once on Tab and typing
// filters what that read gave; Enter starts there; a missing path offers the create row and Enter makes it; o opens
// the Open list with its totals, searching all; a gone folder's session opens read-only with the gone line, and Enter
// continues it in a folder as a fork; the / menu and the model picker use the matcher; with no open session the
// folder list is the main area and stays. Writes folders-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, keyTable, spySent, serverSend, shot as shotTo } from './helpers.mjs';

const ROOT = '/tmp/synopia-folders';
const DEV = `${ROOT}/dev`;
const OPEN = 'f0f0f0f0-0000-4000-8000-0000000000f1'; // open, in demo-app
const NOTES = 'f0f0f0f0-0000-4000-8000-0000000000f2'; // past, in notes
const BILL = 'f0f0f0f0-0000-4000-8000-0000000000f3'; // past, in a worktree folder that is gone
const INVOICE = 'f0f0f0f0-0000-4000-8000-0000000000f4'; // past, months ago, in demo-app
const ago = (days) => (s) => new Date(Date.now() - days * 86_400_000 + s * 1000).toISOString();
const MENU = {
  models: [
    { value: 'default', displayName: 'Default', description: 'Use the default model (currently Fixture Large (Default))', supportedEffortLevels: [] },
    { value: 'fixture-large', displayName: 'Fixture Large', description: 'The larger fixture model', supportedEffortLevels: [] },
    { value: 'fixture-small', displayName: 'Fixture Small', description: 'The fast fixture model', supportedEffortLevels: [] },
  ],
  commands: [
    { name: 'clear', description: 'Clear the conversation', argumentHint: '' },
    { name: 'compact', description: 'Summarise the conversation to free context', argumentHint: '[instructions]' },
    { name: 'model', description: 'Choose the model for this session', argumentHint: '' },
    { name: 'release-notes', description: 'Draft release notes from merged work', argumentHint: '' },
  ],
};

if (process.argv[2] === 'make') {
  const claude = process.argv[3];
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of ['demo-app/src', 'notes', 'blog', 'side-project']) fs.mkdirSync(`${DEV}/${d}`, { recursive: true });
  const write = (cwd, sid, body) => {
    const dir = path.join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), body);
  };
  { const { you, said } = records(`${DEV}/demo-app`, ago(1)); write(`${DEV}/demo-app`, OPEN, you(OPEN, 'o-u1', 0, 'Login form: keep the email after a failed sign-in.') + said(OPEN, 'o-a1', 1, 'Done.')); }
  { const { you, said } = records(`${DEV}/notes`, ago(6)); write(`${DEV}/notes`, NOTES, you(NOTES, 'n-u1', 0, 'Weekly notes cleanup') + said(NOTES, 'n-a1', 1, 'Cleaned.')); }
  { const { you, said } = records(`${DEV}/demo-app.billing`, ago(8)); write(`${DEV}/demo-app.billing`, BILL, you(BILL, 'b-u1', 0, 'Billing form: split into steps') + said(BILL, 'b-a1', 1, 'Done. The form is three steps now.')); }
  { const { you, said } = records(`${DEV}/demo-app`, ago(270)); write(`${DEV}/demo-app`, INVOICE, you(INVOICE, 'i-u1', 0, 'Invoice export: CSV columns') + said(INVOICE, 'i-a1', 1, 'Added the columns.')); }
  for (const [sid, days] of [[OPEN, 1], [NOTES, 6], [BILL, 8], [INVOICE, 270]]) { // listSessions() dates them by mtime
    const f = path.join(claude, 'projects', (sid === NOTES ? `${DEV}/notes` : sid === BILL ? `${DEV}/demo-app.billing` : `${DEV}/demo-app`).replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
    const t = new Date(Date.now() - days * 86_400_000); fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(claude, 'sdk-script.json'), JSON.stringify({ about: 'folders.mjs: made up', menu: MENU, sessions: {} }));
  // only OPEN is open; the rest are past sessions for the Open list (the seed opens every fixture session otherwise)
  fs.writeFileSync(path.join(path.dirname(claude), 'state.json'), JSON.stringify({ version: 1, open: [{ id: OPEN, cwd: `${DEV}/demo-app`, openedAt: Date.now(), closedAt: null }] }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, state] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(url, `__synopia.current() === '${OPEN}' && !!__synopia.mounted()`);
const sent = await spySent(c);
const K = keyTable(key);
const type = (text) => c.cdp('Input.insertText', { text });
const fl = () => ev('__synopia.folderList()');
const shot = (name) => shotTo(c, `${state}/folders-${name}.png`);
const clear = (id) => ev(`(() => { const i = document.getElementById('${id}'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
const rowsText = () => ev(`[...document.querySelectorAll('#fl-list .fl-it')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);

// ---------- n: the folder list, the folder on screen selected ----------
await K.n();
check('n opens the folder list, titled New session', await c.until(`__synopia.folderList().shown && __synopia.folderList().known >= 4 && document.getElementById('fl-title').textContent === 'New session'`));
let f = await fl();
check('the folder of the session on screen is selected', f.rows[f.sel]?.path === `${DEV}/demo-app`, JSON.stringify(f));
check('the known folders, newest first, home last', JSON.stringify(f.rows.map((r) => r.path)) === JSON.stringify([`${DEV}/demo-app`, `${DEV}/notes`, `${DEV}/demo-app.billing`, '~']), JSON.stringify(f.rows.map((r) => r.path)));
check('rows say their sessions: demo-app 2, home folder', (await rowsText())[0].includes('2 sessions') && (await rowsText())[3].includes('home folder'), JSON.stringify(await rowsText()));
check('the rows on screen got one gone check, of known paths only', await c.until(`__synopia.folderList().rows.some(r => r.gone)`)
  && JSON.stringify((await sent('checkFolders')).flatMap((m) => m.paths).sort()) === JSON.stringify([`${DEV}/demo-app`, `${DEV}/notes`, `${DEV}/demo-app.billing`, '~'].sort()), JSON.stringify(await sent('checkFolders')));
f = await fl();
check('the gone folder is dimmed and says so', f.rows.find((r) => r.path.endsWith('.billing'))?.gone === true && (await ev(`document.querySelector('#fl-list .fl-it.gone .c').textContent`)) === 'Folder gone');
await K.down(); await K.down();
f = await fl();
check('moving skips the gone row', f.rows[f.sel]?.path === '~', JSON.stringify(f.sel));
await shot('new');

// the matcher: letters in order, word starts first, marked
await type('nots');
check('typing filters with the matcher: nots finds notes', await c.until(`__synopia.folderList().rows.length === 1 && __synopia.folderList().rows[0].path.endsWith('/notes')`), JSON.stringify(await fl()));
check('the matched letters are marked, bold in the link blue', (await ev(`[...document.querySelectorAll('#fl-list .fl-it b.m')].map(b => b.textContent).join('')`)) === 'nots'
  && (await ev(`getComputedStyle(document.querySelector('#fl-list b.m')).fontWeight`)) === '700');
await K.esc();
check('Esc closes it', !(await fl()).shown);

// ---------- a path: Tab reads that one folder, typing filters what it gave ----------
await K.n();
await c.until(`__synopia.folderList().shown`);
await type(`${DEV}/`);
await K.tab();
check('Tab on a typed path: one completeFolder, its children listed', await c.until(`__synopia.folderList().rows.filter(r => r.kind === 'child').length === 4`)
  && (await sent('completeFolder')).length === 1, JSON.stringify(await fl()));
check('children read "not used yet" unless known', (await rowsText()).some((t) => t.startsWith(`${DEV}/blog/`) && t.includes('not used yet')) && (await rowsText()).some((t) => t.startsWith(`${DEV}/notes/`) && t.includes('1 session')), JSON.stringify(await rowsText()));
await type('bl');
check('typing filters that read, with no new one', await c.until(`__synopia.folderList().rows.filter(r => r.kind === 'child').length === 1`) && (await sent('completeFolder')).length === 1);
await shot('path');
await K.enter();
check('Enter sends newSession in that folder', await c.until(`__synopia.sent('newSession').length === 1`) && (await sent('newSession'))[0].cwd === `${DEV}/blog` && !(await sent('newSession'))[0].create, JSON.stringify(await sent('newSession')));
check('the new session shows, in that folder, the box in insert mode', await c.until(`__synopia.cur()?.id.startsWith('new-') && __synopia.cur().cwd === '${DEV}/blog' && __synopia.mode() === 'insert'`), JSON.stringify(await ev('[__synopia.cur()?.cwd, __synopia.mode()]')));
await K.esc();

// ---------- a path that doesn't exist: the create row ----------
await K.n();
await c.until(`__synopia.folderList().shown`);
await clear('fl-filter');
await type(`${DEV}/new-app`);
check('a missing typed path offers "Create folder <path> and start there"', await c.until(`__synopia.folderList().rows.some(r => r.kind === 'create')`)
  && (await rowsText()).includes(`Create folder ${DEV}/new-app and start there`), JSON.stringify(await rowsText()));
check('its one check was of exactly that path', (await sent('checkFolders')).some((m) => m.chosen === true && JSON.stringify(m.paths) === JSON.stringify([`${DEV}/new-app`])));
await shot('create');
await K.enter();
check('Enter sends newSession with create, and the folder is made', await c.until(`__synopia.sent('newSession').some(m => m.create === true)`) && await c.until(`__synopia.cur()?.cwd === '${DEV}/new-app'`) && fs.statSync(`${DEV}/new-app`).isDirectory());
await K.esc();

// ---------- o: the Open list, its totals, searching all ----------
await K.o();
check('o opens the Open list with its totals', await c.until(`__synopia.openList().shown && __synopia.openList().totals?.total === 3`)
  && (await ev(`document.getElementById('ol-meta').textContent`)) === '3 past sessions in 3 folders, newest first.', await ev(`document.getElementById('ol-meta').textContent`));
check('ages past 60 days read in months', await c.until(`[...document.querySelectorAll('#ol-list .ol-it .a')].some(a => a.textContent === '9 mo ago')`), JSON.stringify(await ev(`[...document.querySelectorAll('#ol-list .a')].map(a => a.textContent)`)));
check('the gone folder\'s row says "Folder gone", its folder struck through', await c.until(`[...document.querySelectorAll('#ol-list .ol-it')].some(r => r.querySelector('.term')?.textContent === 'Folder gone' && r.querySelector('.f.gone'))`));
await type('invoice csv');
check('two words, in any order, matched and marked', await c.until(`document.querySelectorAll('#ol-list .ol-it').length === 1 && document.querySelector('#ol-list .ol-it .t').textContent === 'Invoice export: CSV columns'`)
  && (await ev(`[...document.querySelectorAll('#ol-list .ol-it b.m')].map(b => b.textContent).join('')`)) === 'InvoiceCSV'
  && (await ev(`document.getElementById('ol-note').textContent`)) === '1 session matches.');
await shot('open');
await clear('ol-filter');
await type('billing');
check('billing finds the gone folder\'s session', await c.until(`document.querySelectorAll('#ol-list .ol-it').length === 1 && document.querySelector('#ol-list .ol-it .t').textContent === 'Billing form: split into steps'`));
await K.enter();
check('opening the gone folder\'s session: read-only, the gone line instead of the field', await c.until(`__synopia.cur()?.id === '${BILL}' && __synopia.cur().gone === true && !!document.querySelector('.composer.gone')`)
  && (await ev(`getComputedStyle(document.getElementById('msg')).display`)) === 'none'
  && (await ev(`document.querySelector('.gone-line').textContent`)) === 'This folder no longer exists. Enter picks a folder to continue in.'
  && (await ev(`document.querySelector('.c-meta .gone')?.textContent`)) === 'folder gone');
await K.i();
check('i does nothing there: still normal mode', (await ev('__synopia.mode()')) === 'normal');
await shot('gone');

// ---------- Enter: continue in a folder, as a fork ----------
await K.enter();
check('Enter opens "Continue in a folder", filtered on the repo name', await c.until(`__synopia.folderList().shown && __synopia.folderList().sid === '${BILL}' && __synopia.folderList().filter === 'demo-app'`)
  && (await ev(`document.getElementById('fl-title').textContent`)) === 'Continue in a folder');
await c.until(`__synopia.folderList().rows.some(r => r.gone)`);
f = await fl();
check('the gone folder is there, dimmed, not selected', f.rows[f.sel]?.path === `${DEV}/demo-app` && f.rows.some((r) => r.gone && r.path.endsWith('.billing')), JSON.stringify(f));
await shot('continue');
await K.enter();
check('Enter sends continueSession with the folder', await c.until(`__synopia.sent('continueSession').length === 1`)
  && JSON.stringify((await sent('continueSession')).map((m) => [m.sid, m.cwd])) === JSON.stringify([[BILL, `${DEV}/demo-app`]]));
check('the fork takes its place: a new id, the new folder, not gone', await c.until(`__synopia.current() !== '${BILL}' && __synopia.cur()?.cwd === '${DEV}/demo-app' && __synopia.cur().gone === false && !document.querySelector('.composer.gone')`, 8000), JSON.stringify(await ev('[__synopia.current(), __synopia.cur()?.cwd]')));
check('the transcript keeps its history and marks the move', await c.until(`[...document.querySelectorAll('#log .retitle.moved')].some(e => e.textContent === 'Continued in ${DEV}/demo-app') && document.querySelector('#log').textContent.includes('three steps now')`));
await shot('continued');

// ---------- the / menu and the model picker use the matcher ----------
await K.i();
await type('/cmp');
check('the / menu matches fuzzily, marked', await c.until(`(() => { const it = document.querySelector('#slash:not([hidden]) .it'); return !!it && it.querySelector('.n').textContent.startsWith('/compact'); })()`)
  && (await ev(`[...document.querySelector('#slash .it').querySelectorAll('b.m')].map(b => b.textContent).join('')`)) === 'cmp', await ev(`document.getElementById('slash').textContent`));
await ev(`(() => { const t = document.getElementById('msg'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);
await ev(`document.getElementById('model-label').click()`);
await c.until(`!document.getElementById('slash').hidden`);
await type('lrg');
check('the model picker filters by what follows /model', await c.until(`document.querySelectorAll('#slash .it').length === 1 && document.querySelector('#slash .it .n').textContent.includes('Fixture Large')`), await ev(`document.getElementById('slash').textContent`));
await K.esc(); await K.esc();

// ---------- no open session: the folder list is the main area ----------
const ids = await ev(`__synopia.data().map(s => s.id)`);
await serverSend(url, ...ids.map((sid) => ({ t: 'close', sid })));
check('with no open session the folder list shows, fixed', await c.until(`__synopia.data().length === 0 && __synopia.folderList().shown && __synopia.folderList().fixed`, 8000), JSON.stringify(await fl()));
await K.esc();
check('Esc leaves its filter; the list stays', (await fl()).shown && (await ev(`document.activeElement?.id !== 'fl-filter'`)));
await K.n();
check('n goes back into it', await c.until(`document.activeElement?.id === 'fl-filter'`));
await shot('none');
await sleep(50);
c.print(); c.close();
