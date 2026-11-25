// Synopia's tools for agents (R3.15): a scripted session calls start_session, on a made-up fixture with the
// scripted SDK. The permission card words the call; Always allow starts the new session right under the caller
// in its group and shows it (you were looking at the caller); the caller stays open; the step reads
// "Start session(<title>)" with a link to the new session. A second call, allowed by the rule with no card while
// you look at another session, only adds the row. A caller in no group gets a new group named after it. The
// step's link opens the session. Shots go to the state folder and /tmp/synopia-start-session/.
// usage: node agenttools.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node agenttools.mjs <url> <state-dir> <claude-dir>
import fs from 'node:fs';
import path from 'node:path';
import { records, serverSend, shot as shotTo } from './helpers.mjs';

const HOME = '/Users/fixture', CWD = `${HOME}/dev/billing`;
const A = 'a7a7a7a7-0000-4000-8000-0000000000a1'; // the caller, in the group Billing
const B = 'a7a7a7a7-0000-4000-8000-0000000000b2'; // in the group Billing too
const C = 'a7a7a7a7-0000-4000-8000-0000000000c3'; // a caller in no group
const START = 'mcp__synopia__start_session';
const ago = (s) => new Date(Date.now() - 10 * 60_000 + s * 1000).toISOString();
const PROMPT1 = 'Read HANDOFF.md, then finish the CSV export.\nThe tests are in test/export.';
const PROMPT3 = 'Go through the docs TODO list.';
const RESULT = [{ message: { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1 } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
const running = { message: { type: 'system', subtype: 'session_state_changed', state: 'running' } };
const call = (toolUseId, input) => ({ call: { tool: START, input, toolUseId } });

if (process.argv[2] === 'make') {
  const claude = process.argv[3];
  const dir = path.join(claude, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const { you, said } = records(CWD, ago);
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), you(A, 'a-u1', 0, 'Add a CSV export to the billing page.') + said(A, 'a-a1', 5, 'The export is half done. I will hand the rest over.'));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), you(B, 'b-u1', 0, 'Check the invoice totals.') + said(B, 'b-a1', 5, 'The totals add up.'));
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), you(C, 'c-u1', 0, 'Clean up the docs folder.') + said(C, 'c-a1', 5, 'Most of it is done.'));
  fs.writeFileSync(path.join(claude, 'sdk-script.json'), JSON.stringify({
    about: 'agenttools.mjs: made up', home: HOME,
    onSend: [{ after: 300, ...RESULT[0] }, RESULT[1]], // the started sessions' first turns
    sessions: {
      [A]: { start: true, steps: [running, call('toolu_ss1', { prompt: PROMPT1, title: 'CSV export, part 2' }), ...RESULT],
        onSend: [call('toolu_ss2', { prompt: 'Write the release notes for the export.' }), ...RESULT] },
      [B]: { start: true, state: { status: 'idle', ago: 300_000 } },
      [C]: { start: true, steps: [running, call('toolu_ss3', { prompt: PROMPT3 }), ...RESULT] },
    },
  }));
  // Claude's titles for them, kept by the seeding (scripted-sdk.ts seedState)
  const written = (title) => ({ title, now: '', at: Date.now(), history: [] });
  fs.writeFileSync(path.join(path.dirname(claude), 'state.json'), JSON.stringify({ version: 1, written: { [A]: written('Billing export'), [B]: written('Invoice totals'), [C]: written('Docs cleanup') } }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const OUT = '/tmp/synopia-start-session';
fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => { const f = await shotTo(c, path.join(stateDir, `agenttools-${name}.png`)); fs.copyFileSync(f, path.join(OUT, `${name}-${theme}.png`)); };
// A and B in the group Billing, C in none, stored before the page loads
await serverSend(url, { t: 'newGroup', sid: B, onto: A, group: 'g-bill', name: 'Billing' });
const c = await connect();
const { ev, check, until } = c;
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
const pick = async (sid) => { await ev(`document.querySelector('.row[data-id="${sid}"]').click()`); await until(`__synopia.current() === '${sid}' && !!__synopia.mounted()`); };
const layout = () => ev('__synopia.layout()');
const group = async (name) => (await layout()).groups.find((g) => g.name === name)?.ids ?? null;
const answer = async (oi) => { await ev(`document.querySelector('.qa-card .o[data-oi="${oi}"]').click()`); await ev(`document.getElementById('qa-send').click()`); };

await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(`${url}#${A.slice(0, 8)}`, `__synopia.current() === '${A}' && __synopia.pending('${A}').length === 1 && __synopia.pending('${C}').length === 1`);

// 1. the card: what the call does, in the card's rows
check('card: Claude wants to start a new session', /^Needs you ?Claude wants to start a new session, for /.test(await text('.qa-card .nd-head')), await text('.qa-card .nd-head'));
check('card: the call in words', (await text('.qa-card .why2.own')) === 'Start a new session in ~/dev/billing with: Read HANDOFF.md, then finish the CSV export.', await text('.qa-card .why2.own'));
const rows = await ev(`[...document.querySelectorAll('.qa-card .o .l')].map(l => l.textContent)`);
check('card: Allow once, Always allow, Deny', JSON.stringify(rows) === JSON.stringify(['Allow once', 'Always allow', 'Deny']), JSON.stringify(rows));
check('card: the log says what waits', (await text('#log .waitln')) === 'Waiting for you: permission to start a new session, in the message panel', await text('#log .waitln'));
await shot('permission-card');

// 2. Always allow: the new session under the caller in its group, shown, the caller still open
const before = (await ev('__synopia.data()')).length;
await answer(1);
check('allowed: the new session shows, titled as asked', await until(`__synopia.cur()?.title === 'CSV export, part 2' && !__synopia.current().startsWith('new-')`, 8000), JSON.stringify(await ev('__synopia.cur()?.title')));
const N1 = await ev('__synopia.current()');
check('allowed: its first message is the prompt', await until(`__synopia.cur().items.some(i => i.k === 'you' && i.text.startsWith('Read HANDOFF.md, then finish the CSV export.'))`), JSON.stringify((await ev('__synopia.cur().items')).map((i) => i.k)));
check('allowed: right under the caller in Billing', JSON.stringify(await group('Billing')) === JSON.stringify([A, N1, B]), JSON.stringify(await layout()));
check('allowed: the caller stays open', (await ev('__synopia.data()')).length === before + 1 && (await ev(`__synopia.data().some(s => s.id === '${A}')`)));
check('allowed: the row in the sidebar under the caller', await ev(`(() => { const r = [...document.querySelectorAll('#groups [data-group="g-bill"] .row')].map(x => x.dataset.id); return r.indexOf('${N1}') === r.indexOf('${A}') + 1; })()`));
await shot('new-session-sidebar');

// 3. the caller's step: Start session(<title>), its result line a link to the new session
await pick(A);
const step = `[...document.querySelectorAll('#log .ln.tool')].find(l => l.textContent.includes('Start session'))`;
check('step: Start session(CSV export, part 2)', await until(`(${step})?.querySelector('.name')?.textContent === 'Start session' && (${step}).textContent.includes('Start session(CSV export, part 2)')`, 8000), await ev(`(${step})?.textContent ?? ''`));
check('step: the result line links to the new session', await until(`(${step})?.querySelector('.res button.alink[data-session="${N1}"]')?.textContent === 'CSV export, part 2'`));
check('step: the card is gone', await until(`!document.querySelector('.qa-card')`));

// 4. a second call while you look at another session: the rule allows it with no card; the row comes, the view stays
await pick(B);
await serverSend(url, { t: 'send', sid: A, text: 'Now the release notes, please.' });
check('rule: a second session under the caller', await until(`(__synopia.layout().groups.find(g => g.name === 'Billing')?.ids.length ?? 0) === 4`, 8000), JSON.stringify(await layout()));
const g2 = await group('Billing');
check('rule: right under the caller, above the first', g2[0] === A && g2[2] === N1 && g2[3] === B && g2[1] !== N1, JSON.stringify(g2));
check('rule: no card asked', (await ev(`__synopia.pending('${A}').length`)) === 0);
await sleep(300);
check('rule: the view stays on the session you look at', (await ev('__synopia.current()')) === B, await ev('__synopia.current()'));

// 5. a caller in no group: Allow once makes a group of the two, named after it
await pick(C);
check('no group: the card', (await text('.qa-card .why2.own')) === `Start a new session in ~/dev/billing with: ${PROMPT3}`, await text('.qa-card .why2.own'));
await answer(0);
check('no group: the new session shows', await until(`__synopia.cur()?.title === 'Go through the docs TODO list.' && !__synopia.current().startsWith('new-')`, 8000), JSON.stringify(await ev('__synopia.cur()?.title')));
const N3 = await ev('__synopia.current()');
check('no group: a new group "Docs cleanup" of the two', JSON.stringify(await group('Docs cleanup')) === JSON.stringify([C, N3]), JSON.stringify(await layout()));
check('no group: C is no longer under Not in a group', !(await layout()).others.includes(C));

// 6. the step's link opens the session it started
await pick(A);
await until(`!!document.querySelector('#log button.alink[data-session="${N1}"]')`);
await ev(`document.querySelector('#log button.alink[data-session="${N1}"]').click()`);
check('link: opens the new session', await until(`__synopia.current() === '${N1}'`), await ev('__synopia.current()'));
c.print();
c.close();
