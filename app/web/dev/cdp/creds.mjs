// Retried requests and the credential refresh (R8.2, FR-STAT-02, 2026-11-26), on a made-up fixture with the scripted
// SDK (its `retry` step: the transcript's api_error record, then the api_retry message) and made-up refresh commands
// that really run in a pseudo-terminal (creds.ts, pty.ts; `sh -lc` under the script). Checks: a server error retry
// reads "Retrying, attempt 4 of 10" in the sidebar with its countdown, and the live line has the CLI's sentence and
// the countdown; two sessions of one folder whose sign-in expired read "Needs you, sign-in expired", the dock line
// has the CLI's sentence and the command prefilled from the folder's executable bin/aws-login; Save runs it: both
// rows read "Refreshing credentials…", the other session shows the same live run, its printed code shows, a line
// typed into it reaches it, and its exit 0 clears both (back to retrying); a later expiry in that folder runs the
// saved command by itself; a folder with no guess has an empty field, and a command that exits 1 brings the
// editable line back with its sentence. Writes creds-*.png.
// usage: node creds.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node creds.mjs <url> <state-dir> <claude-dir>
import fs from 'node:fs';
import path from 'node:path';
import { records, keyTable, shot as shotTo } from './helpers.mjs';

const X = '/tmp/synopia-creds-check/repo', Y = '/tmp/synopia-creds-check/other', Z = '/tmp/synopia-creds-check/third';
const A1 = 'cdcdcdcd-0000-4000-8000-0000000000a1', A2 = 'cdcdcdcd-0000-4000-8000-0000000000a2', A3 = 'cdcdcdcd-0000-4000-8000-0000000000a3';
const B1 = 'cdcdcdcd-0000-4000-8000-0000000000b1', R1 = 'cdcdcdcd-0000-4000-8000-0000000000c1';
const EXPIRED = 'The security token included in the request is expired';
const running = (ago = 0) => ({ ago, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } });
const expired = (attempt) => ({ retry: { attempt, max: 10, delayMs: 3000, status: 403, error: 'unknown', text: EXPIRED } });

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
  fs.writeFileSync(path.join(claude, 'sdk-script.json'), JSON.stringify({
    about: 'creds.mjs: made up',
    sessions: {
      [A1]: { start: true, steps: [running(20000), expired(4)] },
      [A2]: { start: true, steps: [running(15000), expired(2)] },
      [A3]: { start: true, state: { status: 'idle', ago: 60000 }, onSend: [running(), expired(1)] },
      [B1]: { start: true, steps: [running(10000), { retry: { attempt: 1, max: 2, delayMs: 1000, status: null, error: 'cloud_credential_error', text: 'Could not load credentials from any providers', credential: true } }] },
      [R1]: { start: true, steps: [running(8000), { retry: { attempt: 4, max: 10, delayMs: 600000, status: 503, error: 'server_error', text: 'Service Unavailable' } }] },
    },
  }));
  for (const d of [X, Y, Z]) fs.mkdirSync(d, { recursive: true });
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

// 3. Save runs it, shared by the folder's sessions; its output live; a typed line reaches it; exit 0 clears both
await ev(`document.querySelector('[data-creds="save"]').click()`);
check('refresh: both rows refreshing', await until(`['${A1}', '${A2}'].every(id => document.querySelector('.row[data-id="' + id + '"] .r-state')?.textContent.trim() === 'Refreshing credentials…')`, 6000), JSON.stringify([await word(A1), await word(A2)]));
check('refresh: the printed code shows', await until(`(document.getElementById('creds-out')?.textContent ?? '').includes('WXYZ-0001')`, 6000), JSON.stringify(await dock()));
check('refresh: a moving mark on the line', await ev(`!!document.querySelector('.dock .status.creds .rot, .dock .status.creds [class*="rot"]')`), await ev(`document.querySelector('.dock .status.creds b')?.innerHTML.slice(0, 200)`));
await shot('running');
await pick(A2);
check('refresh: the other session shows the same run', await until(`(document.getElementById('creds-out')?.textContent ?? '').includes('Press Enter when you are done')`, 4000), JSON.stringify(await dock()));
check('refresh: one run for the folder', (await ev(`__synopia.creds().filter(f => f.phase === 'running').length`)) === 1);
await typeInto('creds-in', 'ok');
await K.enter();
check('refresh: exit 0 clears both', await until(`['${A1}', '${A2}'].every(id => /^Retrying, attempt \\d+ of 10/.test(document.querySelector('.row[data-id="' + id + '"] .r-state')?.textContent.trim() ?? ''))`, 8000), JSON.stringify([await word(A1), await word(A2)]));
check('refresh: the dock line closed', await until(`!document.querySelector('.dock .status.creds')`, 4000), JSON.stringify(await dock()));

// 4. a later expiry in that folder runs the saved command by itself
await sleep(1600); // past the scripted gap after a refresh that succeeded (creds.ts againMs)
await pick(A3);
await ev(`document.getElementById('msg').focus()`);
await c.cdp('Input.insertText', { text: 'Rename it again.' });
await K.enter();
check('auto: refreshing with no Save', await until(`document.querySelector('.row[data-id="${A3}"] .r-state')?.textContent.trim() === 'Refreshing credentials…'`, 6000), JSON.stringify(await word(A3)));
check('auto: its output shows', await until(`(document.getElementById('creds-out')?.textContent ?? '').includes('WXYZ-0001')`, 6000), JSON.stringify(await dock()));
await typeInto('creds-in', 'done');
await K.enter();
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
c.print();
c.close();
