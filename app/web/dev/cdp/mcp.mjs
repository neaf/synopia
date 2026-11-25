// /mcp (R5.15) and terminal-only commands (R5.16), on a made-up fixture with the scripted SDK (its MCP servers
// and its pretend `claude mcp login|logout`, dev/scripted-sdk.ts). Checks: /mcp typed in the box opens the MCP
// panel instead of sending, and so does /mcp from the / menu; each server's status word and mark (Connected,
// Needs sign-in, Failed, Connecting, Disabled), a moving mark only while connecting; Sign in shows "Waiting for
// the browser…" with a moving mark, then Connected; Sign out gives Needs sign-in; Reconnect; Disable and Enable;
// a failed sign-in's one sentence in the panel; ↑↓ j k, ← →, Enter, Esc; a session a terminal holds says to use
// /mcp there; /unknowncmd is not sent, the box keeps it, a toast says it works only in a terminal; a command in
// the session's list is still sent. Writes mcp-*.png (also to /tmp/synopia-mcp/shots/).
// usage: node mcp.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node mcp.mjs <url> <state-dir> <claude-dir>
import fs from 'node:fs';
import path from 'node:path';
import { records, terminal, keyTable, spySent, shot as shotTo } from './helpers.mjs';

const CWD = '/tmp/synopia-mcp-check';
const D = 'c5c5c5c5-0000-4000-8000-0000000000d1'; // driven: its process runs
const T = 'c5c5c5c5-0000-4000-8000-0000000000e2'; // a terminal's Claude Code holds it
const { you, said } = records(CWD);

if (process.argv[2] === 'make') {
  const claude = process.argv[3];
  const dir = path.join(claude, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${D}.jsonl`), you(D, 'd-u1', 0, 'Pull the frames from the design file.') + said(D, 'd-a1', 1, 'The Figma server needs you to sign in first.'));
  fs.writeFileSync(path.join(dir, `${T}.jsonl`), you(T, 't-u1', 0, 'Tidy the notes.') + said(T, 't-a1', 1, 'Tidied.'));
  const onSend = [{ after: 200, message: { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1 } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
  fs.writeFileSync(path.join(claude, 'sdk-script.json'), JSON.stringify({
    about: 'mcp.mjs: made up',
    menu: { commands: [{ name: 'compact', description: 'Clear the history but keep a summary', argumentHint: '' }, { name: 'review', description: 'Review a pull request', argumentHint: '' }], models: [] },
    mcp: {
      loginMs: 1500, pendingMs: 2500, failLogin: ['wiki'],
      servers: [
        { name: 'figma', status: 'needs-auth', kind: 'http', scope: 'user' },
        { name: 'portal', status: 'connected', kind: 'http', scope: 'project' },
        { name: 'localdb', status: 'failed', kind: 'stdio', scope: 'local' },
        { name: 'search', status: 'pending', kind: 'sse', scope: 'user' },
        { name: 'wiki', status: 'disabled', kind: 'http', scope: 'user' },
      ],
    },
    sessions: { [D]: { start: true, state: { status: 'idle', ago: 58000 }, onSend } },
  }));
  terminal(claude, 90007, T, CWD);
  fs.mkdirSync(CWD, { recursive: true });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const OUT = '/tmp/synopia-mcp/shots';
fs.mkdirSync(OUT, { recursive: true });
const c = await connect();
const { ev, check, until, key } = c;
const K = keyTable(key);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
const shot = async (name) => { const f = await shotTo(c, path.join(stateDir, `mcp-${name}.png`)); fs.copyFileSync(f, path.join(OUT, `${name}-${theme}.png`)); };
await c.load(`${url}#${D.slice(0, 8)}`, `__synopia.current() === '${D}' && !!__synopia.mounted() && __synopia.cur().state.driven === true`);
const type = (t) => c.cdp('Input.insertText', { text: t });
const boxValue = () => ev(`document.getElementById('msg').value`);
const panel = () => ev('__synopia.mcp()');
const row = (name) => ev(`(() => { const r = document.querySelector('#mcp-rows .mcp-it[data-name="${name}"]'); if (!r) return null;
  return { word: r.querySelector('.st .w').textContent, moving: !!r.querySelector('.st .rot'), svg: r.querySelector('.st .ind').innerHTML.slice(0, 300), lock: !!r.querySelector('.st .lock'), acts: [...r.querySelectorAll('.act')].map(a => a.textContent), pressed: r.querySelector('.act[aria-pressed="true"]')?.textContent ?? null, selected: r.getAttribute('aria-selected') === 'true' }; })()`);
const wordIs = (name, w, ms = 6000) => until(`document.querySelector('#mcp-rows .mcp-it[data-name="${name}"] .st .w')?.textContent === ${JSON.stringify(w)}`, ms);
const selectRow = async (name) => {
  for (let i = 0; i < 8; i++) { if ((await row(name))?.selected) return true; await K.j(); }
  return false;
};
const choose = async (label) => {
  for (let i = 0; i < 4; i++) await K.left();
  for (let i = 0; i < 5; i++) { const r = await row((await panel()).servers[(await panel()).sel].name); if (r.pressed === label) return true; await K.right(); }
  return false;
};

// 1. /mcp typed and sent: the panel, no message
await ev(`document.getElementById('msg').focus()`);
const sent = await spySent(c);
await type('/mcp');
await K.esc(); // closes the / menu, the text stays
await ev(`document.getElementById('msg').focus()`);
await K.enter();
check('/mcp typed: the panel opens', await until(`__synopia.mcp().shown === true`), JSON.stringify(await panel()));
check('/mcp typed: nothing is sent, the box empties', (await sent('send')).length === 0 && (await boxValue()) === '', JSON.stringify({ sent: await sent('send'), box: await boxValue() }));
check('the panel lists the servers, Synopia\'s own too', await until(`__synopia.mcp().servers.map(s => s.name).join() === 'figma,localdb,portal,search,synopia,wiki'`), JSON.stringify((await panel()).servers.map((s) => s.name)));

// 2. statuses: words, marks, shapes
const fig = await row('figma'), por = await row('portal'), db = await row('localdb'), srch = await row('search'), wk = await row('wiki');
check('Needs sign-in: the lock mark, still', fig.word === 'Needs sign-in' && fig.lock && !fig.moving, JSON.stringify(fig));
check('Connected: a still ring', por.word === 'Connected' && !por.moving, JSON.stringify(por));
check('Failed: a square', db.word === 'Failed' && /rect/.test(db.svg) && !db.moving, JSON.stringify(db));
check('Connecting: the moving mark', srch.word === 'Connecting' && srch.moving, JSON.stringify(srch));
check('Disabled: a still ring with a bar', wk.word === 'Disabled' && /circle/.test(wk.svg) && !wk.moving, JSON.stringify(wk));
check('the actions of a remote server', JSON.stringify(fig.acts) === JSON.stringify(['Sign in', 'Sign out', 'Reconnect', 'Disable']), JSON.stringify(fig.acts));
check('a local command has no sign-in', JSON.stringify(db.acts) === JSON.stringify(['Reconnect', 'Disable']), JSON.stringify(db.acts));
check('a disabled server: Sign out and Enable', JSON.stringify(wk.acts) === JSON.stringify(['Sign out', 'Enable']), JSON.stringify(wk.acts));
check('Synopia\'s own server: only Disable', JSON.stringify((await row('synopia')).acts) === JSON.stringify(['Disable']), JSON.stringify(await row('synopia')));
check('Connecting turns Connected by itself', await wordIs('search', 'Connected', 8000), JSON.stringify(await row('search')));
check('no moving mark is left once nothing connects', (await ev(`document.querySelectorAll('#mcp-rows .rot').length`)) === 0);
check('the first row is selected, its first action boxed: Sign in for figma', fig.selected && fig.pressed === 'Sign in', JSON.stringify(fig));
await shot('needs-sign-in');

// 3. Sign in: waiting for the browser, then Connected
await K.enter();
check('Sign in: Waiting for the browser…, a moving mark', await wordIs('figma', 'Waiting for the browser…', 3000) && (await row('figma')).moving, JSON.stringify(await row('figma')));
check('while it waits the row has no actions', (await row('figma')).acts.length === 0, JSON.stringify(await row('figma')));
await shot('waiting');
check('the sign-in ends Connected (reconnected, no restart)', await wordIs('figma', 'Connected', 6000), JSON.stringify(await row('figma')));
check('no error after a good sign-in', (await panel()).error === null, String((await panel()).error));

// 4. Sign out: Needs sign-in
check('figma still selected', (await row('figma')).selected === true);
check('choose Sign out with → ', await choose('Sign out'), JSON.stringify(await row('figma')));
await K.enter();
check('Sign out: Needs sign-in', await wordIs('figma', 'Needs sign-in', 4000), JSON.stringify(await row('figma')));

// 5. Reconnect a failed local server, with j to reach it
check('j moves to localdb', await selectRow('localdb'), JSON.stringify(await panel()));
check('a failed server: Reconnect is boxed first', (await row('localdb')).pressed === 'Reconnect', JSON.stringify(await row('localdb')));
await K.enter();
check('Reconnect: Connected', await wordIs('localdb', 'Connected', 4000), JSON.stringify(await row('localdb')));

// 6. Disable and Enable
check('choose Disable', await choose('Disable'), JSON.stringify(await row('localdb')));
await K.enter();
check('Disable: Disabled', await wordIs('localdb', 'Disabled', 4000), JSON.stringify(await row('localdb')));
check('Enable is boxed on a disabled server', (await row('localdb')).pressed === 'Enable', JSON.stringify(await row('localdb')));
await K.enter();
check('Enable: back', await until(`document.querySelector('#mcp-rows .mcp-it[data-name="localdb"] .st .w')?.textContent !== 'Disabled' && !document.querySelector('#mcp-rows .mcp-it[data-name="localdb"] .st .rot')`, 4000), JSON.stringify(await row('localdb')));

// 7. A sign-in that fails: one sentence in the panel; k moves up
check('k moves back up to figma', await (async () => { for (let i = 0; i < 8; i++) { if ((await row('figma')).selected) return true; await K.k(); } return false; })());
check('j reaches wiki', await selectRow('wiki'));
check('choose Enable on wiki', await choose('Enable'));
await K.enter();
await wordIs('wiki', 'Needs sign-in', 4000);
check('wiki: Sign in boxed now', (await row('wiki')).pressed === 'Sign in', JSON.stringify(await row('wiki')));
await K.enter();
check('a failed sign-in: one sentence in the panel', await until(`/^Sign-in to wiki failed: Authentication failed[^.]*\\.$/.test(__synopia.mcp().error || '')`, 5000) && await ev(`!document.getElementById('mcp-err').hidden`), String((await panel()).error));
check('wiki still needs sign-in', (await row('wiki')).word === 'Needs sign-in');

// 8. Esc closes; the / menu offers /mcp and opens the panel too
await K.esc();
check('Esc closes the panel', (await panel()).shown === false);
await ev(`document.getElementById('msg').focus()`);
await type('/mcp');
check('the / menu lists /mcp first', await until(`document.querySelector('#slash [aria-selected="true"] .n')?.textContent.trim() === '/mcp'`), await ev(`document.getElementById('slash').textContent`));
await K.enter();
check('/mcp from the menu opens the panel', await until(`__synopia.mcp().shown === true`), JSON.stringify(await panel()));
check('from the menu: nothing is sent', (await sent('send')).length === 0);
await K.esc();

// 9. terminal-only commands
await ev(`document.getElementById('msg').focus()`);
await type('/unknowncmd some args');
await K.esc();
await ev(`document.getElementById('msg').focus()`);
await K.enter();
check('/unknowncmd: a toast says it works only in a terminal', await until(`document.getElementById('toast').textContent === '/unknowncmd works only in a terminal'`, 2000), await ev(`document.getElementById('toast').textContent`));
check('/unknowncmd: not sent, the box keeps the text', (await sent('send')).length === 0 && (await boxValue()) === '/unknowncmd some args', JSON.stringify({ sent: await sent('send'), box: await boxValue() }));
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = '/Users/fixture/notes.md has the list'; ta.dispatchEvent(new Event('input')); })()`);
await K.esc();
await ev(`document.getElementById('msg').focus()`);
await K.enter();
check('a path is a message, not a command', await until(`__synopia.sent('send').length === 1`, 2000), JSON.stringify(await sent('send')));
await until(`__synopia.cur().state.status !== 'working'`, 4000);
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = '/compact'; ta.dispatchEvent(new Event('input')); })()`);
await K.esc();
await ev(`document.getElementById('msg').focus()`);
await K.enter();
check('a command in the session\'s list is still sent', await until(`__synopia.sent('send').length === 2 && __synopia.sent('send')[1].text === '/compact'`, 2000), JSON.stringify(await sent('send')));

// 10. a session a terminal holds: the panel says to use /mcp there
await ev(`document.querySelector('.row[data-id="${T}"]').click()`);
await until(`__synopia.current() === '${T}' && !!__synopia.mounted()`);
await ev(`document.getElementById('msg').focus()`);
await type('/mcp');
await K.esc();
await ev(`document.getElementById('msg').focus()`);
await K.enter();
check('in a terminal\'s session: the panel says to use /mcp there', await until(`__synopia.mcp().shown && /Type \\/mcp in that terminal/.test(document.querySelector('#mcp-rows').textContent)`, 3000), await ev(`document.querySelector('#mcp-rows')?.textContent`));
await K.esc();
await sleep(50);
c.print();
process.exit(0);
