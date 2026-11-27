// Retried requests and the credential refresh (R8.2, FR-STAT-02, 2026-11-26), on a made-up fixture with the scripted
// SDK (its `retry` step: the transcript's api_error record, then the api_retry message) and made-up refresh commands
// that really run in a pseudo-terminal (creds.ts, pty.ts; `sh -lc` under the script). Checks: a server error retry
// reads "Retrying, attempt 4 of 10" in the sidebar with its countdown, and the live line has the CLI's sentence and
// the countdown; two sessions of one folder whose sign-in expired read "Needs you, sign-in expired", the dock line
// has the CLI's sentence and the command prefilled from the folder's executable bin/aws-login; Save runs it as a run
// like any other (2026-11-26): the dock line keeps one line over the run's preview (its last lines and state line),
// its printed code shows, the other session shows the same run; it prints a prompt and waits, so both rows and the
// dock line read "Needs you, sign-in expired" and its card has the lock, red; the preview opens its shell view (the
// lock in the gutter), where i and a typed line reach it in the box's ! band, and its exit 0 clears both (back to
// retrying) and closes the view; a later expiry in that folder runs the
// saved command by itself; a folder with no guess has an empty field, and a command that exits 1 brings the
// editable line back with its sentence; a turn whose credential retries ran out is resumed once the refresh exits 0
// (2026-11-26): the quiet "Resumed after the credential refresh" line, not your prompt band, and a new turn. Writes creds-*.png.
// usage: node creds.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node creds.mjs <url> <state-dir> <claude-dir>
import fs from 'node:fs';
import path from 'node:path';
import { records, keyTable, shot as shotTo } from './helpers.mjs';

const X = '/tmp/synopia-creds-check/repo', Y = '/tmp/synopia-creds-check/other', Z = '/tmp/synopia-creds-check/third', W = '/tmp/synopia-creds-check/fourth';
const A1 = 'cdcdcdcd-0000-4000-8000-0000000000a1', A2 = 'cdcdcdcd-0000-4000-8000-0000000000a2', A3 = 'cdcdcdcd-0000-4000-8000-0000000000a3';
const B1 = 'cdcdcdcd-0000-4000-8000-0000000000b1', R1 = 'cdcdcdcd-0000-4000-8000-0000000000c1', F1 = 'cdcdcdcd-0000-4000-8000-0000000000d1';
const EXPIRED = 'The security token included in the request is expired';
const running = (ago = 0) => ({ ago, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } });
const expired = (attempt) => ({ retry: { attempt, max: 10, delayMs: 3000, status: 403, error: 'unknown', text: EXPIRED } });
const NO_CREDS = 'Could not load credentials from any providers';
const credRetry = (attempt) => ({ after: 200, retry: { attempt, max: 2, delayMs: 1000, status: null, error: 'cloud_credential_error', text: NO_CREDS, credential: true } });
const reply = (id, text, extra = {}) => ({ append: [{ type: 'assistant', ...extra, message: { id, role: 'assistant', content: [{ type: 'text', text }] } }] });
const ended = (isError, result) => [{ after: 200, message: { type: 'result', subtype: 'success', is_error: isError, result, num_turns: 1 } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
// F1's turn fails on its credentials (both retries, then the error reply and result, docs/Agent SDK.md AR-1); the resume's turn works
const failedOnCreds = [running(6000), credRetry(1), credRetry(2), reply('msg-f1-err', NO_CREDS, { isApiErrorMessage: true }),
  { message: { type: 'assistant', error: 'cloud_credential_error', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: NO_CREDS }] } } }, ...ended(true, NO_CREDS)];
const resumedTurn = [running(), { after: 600, ...reply('msg-f1-ok', 'Picking up the changelog where it stopped.') }, { after: 1500, message: { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1 } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];

if (process.argv[2] === 'make') {
  const claude = process.argv[3];
  const write = (cwd, sid, ask, answer) => {
    const { you, said } = records(cwd);
    const dir = path.join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), you(sid, `${sid}-u1`, 0, ask) + said(sid, `${sid}-a1`, 1, answer));
  };
  write(X, A1, 'Draft the release notes.', 'Reading the changelog.');
  write(X, A2, 'Check the invoice totals.', 'Summing them now.');
  write(X, A3, 'Rename the helper.', 'Done.');
  write(Y, B1, 'Translate the readme.', 'Starting.');
  write(Z, R1, 'Summarise the meeting notes.', 'On it.');
  write(W, F1, 'Sort the changelog.', 'Sorting it.');
  fs.writeFileSync(path.join(claude, 'sdk-script.json'), JSON.stringify({
    about: 'creds.mjs: made up',
    sessions: {
      [A1]: { start: true, steps: [running(20000), expired(4)] },
      [A2]: { start: true, steps: [running(15000), expired(2)] },
      [A3]: { start: true, state: { status: 'idle', ago: 60000 }, onSend: [running(), expired(1)] },
      [B1]: { start: true, steps: [running(10000), { retry: { attempt: 1, max: 2, delayMs: 1000, status: null, error: 'cloud_credential_error', text: 'Could not load credentials from any providers', credential: true } }] },
      [F1]: { start: true, steps: failedOnCreds, onSend: resumedTurn },
      [R1]: { start: true, steps: [running(8000), { retry: { attempt: 4, max: 10, delayMs: 600000, status: 503, error: 'server_error', text: 'Service Unavailable' } }] },
    },
  }));
  for (const d of [X, Y, Z, W]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(W, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(W, 'bin/aws-login'), '#!/bin/sh\necho "Signed in to the invented profile."\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(X, '.git'), { recursive: true });
  fs.mkdirSync(path.join(X, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(X, 'bin/aws-login'), '#!/bin/sh\necho "Open the browser and enter the code WXYZ-0001"\nprintf "Press Enter when you are done: "\nread line\necho "Signed in ($line)."\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(Y, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(Y, 'bin/fail-login'), '#!/bin/sh\necho "Error: the invented profile is not set up"\nexit 1\n', { mode: 0o755 });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const c = await connect();
const { ev, check, until, key } = c;
const K = keyTable(key);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
const shot = (name) => shotTo(c, path.join(stateDir, `creds-${name}-${theme}.png`));
await c.load(url, `document.querySelectorAll('#groups .row').length >= 5`);
const word = (sid) => ev(`document.querySelector('.row[data-id="${sid}"] .r-state')?.textContent.trim() ?? ''`);
const pick = async (sid) => { await ev(`document.querySelector('.row[data-id="${sid}"]').click()`); return until(`__synopia.current() === '${sid}' && !!__synopia.mounted()`, 4000); };
const dock = () => ev(`document.querySelector('.dock .status')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
const live = () => ev(`document.querySelector('.liveln')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
const field = (id) => ev(`document.getElementById('${id}')?.value ?? null`);
const typeInto = async (id, text) => { await ev(`document.getElementById('${id}').focus()`); await c.cdp('Input.insertText', { text }); };

// 1. a retry that isn't about the sign-in: the attempt in the sidebar, the CLI's sentence and the countdown in the live line
check('retry: sidebar word', await until(`/^Retrying, attempt 4 of 10, in \\d+s$/.test(document.querySelector('.row[data-id="${R1}"] .r-state')?.textContent.trim() ?? '')`, 6000), JSON.stringify(await word(R1)));
await pick(R1);
await until(`!!document.querySelector('.liveln')`, 4000);
const ln = await live();
check('retry: live line has the word, the sentence and the countdown', /Retrying, attempt 4 of 10 Service Unavailable · retrying in \d+s/.test(ln), JSON.stringify(ln));
check('retry: amber dashes', await ev(`!!document.querySelector('.row[data-id="${R1}"] .r-side .rl')`));
await shot('retry');

// 2. two sessions of one folder signed out: needs you, the sentence, the guessed command
check('expired: both rows need you', await until(`['${A1}', '${A2}'].every(id => /^Needs you, sign-in expired, /.test(document.querySelector('.row[data-id="' + id + '"] .r-state')?.textContent.trim() ?? ''))`, 6000), JSON.stringify([await word(A1), await word(A2)]));
check('expired: the red pause mark', await ev(`!!document.querySelector('.row[data-id="${A1}"] .r-side .bars')`));
await pick(A1);
check('expired: dock line', await until(`!!document.getElementById('creds-cmd')`, 4000));
const d1 = await dock();
check('expired: dock line words', d1.startsWith('Needs you, sign-in expired') && d1.includes(EXPIRED) && d1.includes('Run to refresh credentials:'), JSON.stringify(d1));
check('expired: the command guessed from bin/aws-login', (await field('creds-cmd')) === 'bin/aws-login', JSON.stringify(await field('creds-cmd')));
await shot('expired');

// 3. Save runs it, shared by the folder's sessions; a run like any other: the preview in the dock, its card with
// the lock, waiting for input is needs you, and its shell view types into it; exit 0 clears both
const preview = () => ev(`(() => { const r = document.querySelector('.dock .status.creds .runrow'); return r ? { cmd: r.querySelector('.cmd')?.textContent, out: r.querySelector('.out')?.textContent || '', st: r.querySelector('.res.rst')?.textContent || '', waits: !!r.querySelector('.res.rst.waits'), link: r.dataset.bg || '' } : null; })()`);
const typeRun = async (text) => {
  await ev(`document.querySelector('.dock .status.creds .runrow').click()`);
  check('refresh: the preview opens its shell view, the lock in the gutter, its terminal, the mode line in the box\'s place', await until(`(__synopia.view() || '').startsWith('creds:') && !!document.querySelector('#log .bg-run > .g .lock') && __synopia.term()?.writable === true && /Press Enter when you are done/.test(__synopia.term().lines.join('\\n')) && !!document.querySelector('.dock [data-term-mode]')`, 4000), await ev(`document.getElementById('conv').textContent.slice(0, 300)`));
  check('refresh: its header says Synopia started it', /Refresh credentials/.test(await ev(`document.querySelector('.c-head').textContent`)) && /started by Synopia/.test(await ev(`document.querySelector('.c-head').textContent`)), await ev(`document.querySelector('.c-head').textContent`));
  await key('i', { code: 'KeyI', vk: 73 });
  await until(`__synopia.term()?.focused === true`, 2000);
  await ev('__synopia.spy()');
  await c.cdp('Input.insertText', { text });
  await K.enter();
  check('refresh: what you type goes to its terminal as typed', await until(`__synopia.sent('termInput').map(m => m.data).join('') === ${JSON.stringify(text + '\r')}`, 3000), JSON.stringify(await ev(`__synopia.sent('termInput')`)));
};
await ev(`document.querySelector('[data-creds="save"]').click()`);
check('refresh: it runs, one run for the folder', await until(`__synopia.creds().filter(f => f.phase === 'running').length === 1`, 6000));
check('refresh: the dock line keeps one line, with the run\'s preview under it: its command and its printed code', await until(`(() => { const r = document.querySelector('.dock .status.creds .runrow'); return !!r && r.querySelector('.cmd').textContent === 'bin/aws-login' && /WXYZ-0001/.test(r.textContent); })()`, 6000), JSON.stringify(await dock()));
check('refresh: no field and no Cancel in the dock any more', await ev(`!document.getElementById('creds-in') && !document.querySelector('[data-creds="cancel"]')`));
check('refresh: it prints a prompt and waits: both rows need you again', await until(`['${A1}', '${A2}'].every(id => /^Needs you, sign-in expired, /.test(document.querySelector('.row[data-id="' + id + '"] .r-state')?.textContent.trim() ?? ''))`, 6000), JSON.stringify([await word(A1), await word(A2)]));
const pv = await preview();
check('refresh: the dock line says so, and the preview reads "Waits for input" in red', /^Needs you, sign-in expired/.test(await dock()) && !!pv && pv.waits && /^Waits for input, \d+s$/.test(pv.st) && /Press Enter when you are done/.test(pv.out), JSON.stringify([await dock(), pv]));
check('refresh: its card has the lock, red, "waits for input"', await until(`(() => { const r = document.querySelector('.rail .now [data-bg^="creds:"]'); return !!r && !!r.querySelector('.who.lock .lock') && r.classList.contains('waits') && /shell, waits for input/.test(r.textContent); })()`, 4000), await ev(`document.querySelector('.rail')?.textContent || 'no panel'`));
await shot('running');
await pick(A2);
check('refresh: the other session shows the same run', await until(`/Press Enter when you are done/.test(document.querySelector('.dock .status.creds .runrow')?.textContent ?? '')`, 4000), JSON.stringify(await dock()));
await typeRun('ok');
check('refresh: exit 0 clears both', await until(`['${A1}', '${A2}'].every(id => /^Retrying, attempt \\d+ of 10/.test(document.querySelector('.row[data-id="' + id + '"] .r-state')?.textContent.trim() ?? ''))`, 8000), JSON.stringify([await word(A1), await word(A2)]));
check('refresh: its shell view goes with the run, and the dock line closed', await until(`__synopia.view() === null && !document.querySelector('.dock .status.creds')`, 4000), JSON.stringify([await ev('__synopia.view()'), await dock()]));

// 4. a later expiry in that folder runs the saved command by itself
await sleep(1600); // past the scripted gap after a refresh that succeeded (creds.ts againMs)
await pick(A3);
await ev(`document.getElementById('msg').focus()`);
await c.cdp('Input.insertText', { text: 'Rename it again.' });
await K.enter();
check('auto: it runs with no Save', await until(`__synopia.creds().some(f => f.phase === 'running' && f.sids.includes('${A3}'))`, 6000), JSON.stringify(await ev('__synopia.creds()')));
check('auto: its output shows', await until(`/WXYZ-0001/.test(document.querySelector('.dock .status.creds .runrow')?.textContent ?? '')`, 6000), JSON.stringify(await dock()));
await typeRun('done');
check('auto: exit 0 clears it', await until(`/^Retrying, attempt 1 of 10/.test(document.querySelector('.row[data-id="${A3}"] .r-state')?.textContent.trim() ?? '')`, 8000), JSON.stringify(await word(A3)));

// 5. no guess: an empty field; a command that exits 1 brings the editable line back with its sentence
await pick(B1);
check('fail: dock line', await until(`!!document.getElementById('creds-cmd')`, 4000), JSON.stringify(await dock()));
check('fail: no guess, an empty field', (await field('creds-cmd')) === '', JSON.stringify(await field('creds-cmd')));
await typeInto('creds-cmd', 'bin/fail-login');
await K.enter();
const failed = `The refresh command ended with exit code 1: Error: the invented profile is not set up.`;
check('fail: the sentence', await until(`(document.querySelector('.dock .status.creds')?.textContent ?? '').includes(${JSON.stringify(failed)})`, 8000), JSON.stringify(await dock()));
check('fail: the command editable again', (await field('creds-cmd')) === 'bin/fail-login', JSON.stringify(await field('creds-cmd')));
check('fail: needs you again', /^Needs you, sign-in expired, /.test(await word(B1)), JSON.stringify(await word(B1)));
await shot('failed');

// 6. a turn whose credential retries ran out: once the refresh exits 0 Synopia resumes it, once, with its own quiet line
const logText = () => ev(`document.getElementById('log')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
check('resume: the turn failed on the credentials, needs you', await until(`/^Needs you, sign-in expired, /.test(document.querySelector('.row[data-id="${F1}"] .r-state')?.textContent.trim() ?? '')`, 8000), JSON.stringify(await word(F1)));
await pick(F1);
check('resume: the failure is in the transcript', await until(`(document.getElementById('log')?.textContent ?? '').includes(${JSON.stringify(NO_CREDS)})`, 6000), JSON.stringify((await logText()).slice(-300)));
check('resume: the dock line has the guessed command', await until(`document.getElementById('creds-cmd')?.value === 'bin/aws-login'`, 4000), JSON.stringify(await dock()));
await ev(`document.querySelector('[data-creds="save"]').click()`);
check('resume: the quiet "Resumed after the credential refresh" line', await until(`document.querySelector('#log .retitle.resumed')?.textContent.trim() === 'Resumed after the credential refresh'`, 8000), JSON.stringify((await logText()).slice(-300)));
check('resume: no prompt band of yours, and not your prompt sent again', await ev(`(() => { const bands = [...document.querySelectorAll('#log .prompt')].map(b => b.textContent); return bands.length === 1 && /Sort the changelog/.test(bands[0]) && !document.getElementById('log').textContent.includes('Continue: the model'); })()`), JSON.stringify(await ev(`[...document.querySelectorAll('#log .prompt')].map(b => b.textContent)`)));
check('resume: a new turn starts: thinking, then Claude\'s reply under the line', await until(`(() => { const l = document.querySelector('#log .retitle.resumed'), r = [...document.querySelectorAll('#log .ln.claude')].find(x => /Picking up the changelog/.test(x.textContent)); return !!l && !!r && !!(l.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING); })()`, 6000) && /^Thinking/.test(await word(F1)), JSON.stringify(await word(F1)));
await shot('resumed');
check('resume: the turn ends as your turn, the line stays once', await until(`/^Your turn/.test(document.querySelector('.row[data-id="${F1}"] .r-state')?.textContent.trim() ?? '') && document.querySelectorAll('#log .retitle.resumed').length === 1`, 6000), JSON.stringify(await word(F1)));
c.print();
c.close();
