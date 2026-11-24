// Bash mode (R5.13): `!` in the message box runs a shell command, as in the Claude Code CLI, on a made-up
// fixture with the scripted SDK (the command runs for real through bang.ts; the scripted SDK appends the CLI's
// records Synopia shares with it to the fixture file, so they land as a real session's do).
// usage: node bang.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node bang.mjs <url> <state-dir> <claude-dir>
// Checks: `!` as the first character turns the mark into a pink `!` and the placeholder into "Run a shell
// command in <folder>", the `!` leaves the text, no slash menu; Backspace on the empty box leaves the mode;
// `echo hi; echo err >&2; exit 3` runs: the command on the band, stdout, stderr apart, "Exit code 3", landed
// once as the transcript's item; 45 lines cut at 20 with "Show all 45 lines"; one command at a time; Esc, Esc
// ends a `sleep 30` ("Stopped"); a session Synopia doesn't drive gets no bash mode. Writes bang-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, terminal } from './helpers.mjs';

const D = 'b4b4b4b4-0000-4000-8000-0000000000d1'; // driven, idle
const N = 'b4b4b4b4-0000-4000-8000-0000000000e2'; // not driven: a terminal's Claude Code holds it
const dirOf = (claude) => path.join(claude, 'projects', '-tmp-synopia-bang');
const { rec, you, said } = records('/tmp/synopia-bang');

if (process.argv[2] === 'make') {
  const dir = dirOf(process.argv[3]);
  fs.mkdirSync(dir, { recursive: true });
  // D also holds one bash-mode command the CLI recorded: it shows the same as one run from Synopia
  fs.writeFileSync(path.join(dir, `${D}.jsonl`), you(D, 'd-u1', 0, 'Read the demo notes.') + said(D, 'd-a1', 1, 'Read them.')
    + you(D, 'd-b1', 2, '<bash-input>ls demo</bash-input>') + you(D, 'd-b2', 2, '<bash-stdout>notes.md\n</bash-stdout><bash-stderr></bash-stderr>'));
  fs.writeFileSync(path.join(dir, `${N}.jsonl`), you(N, 'n-u1', 0, 'Rename the demo folder.') + said(N, 'n-a1', 1, 'Renamed it.'));
  writeScript(process.argv[3], 'bang.mjs: made up', { [D]: { start: true, state: { status: 'idle', ago: 58000 } } });
  terminal(process.argv[3], 90002, N, '/tmp/synopia-bang'); // N: a terminal's Claude Code holds it
  fs.mkdirSync('/tmp/synopia-bang', { recursive: true }); // the command really runs in the session's folder
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
const shot = (name) => c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, name), Buffer.from(r.result.data, 'base64')));
await c.load(`${url}#${D.slice(0, 8)}`, `__synopia.current() === '${D}' && !!__synopia.mounted() && __synopia.cur().driven === true && __synopia.cur().items.length === 3`);
const type = (t) => c.cdp('Input.insertText', { text: t });
const box = () => ev(`(() => { const ta = document.getElementById('msg'), b = ta.closest('.composer'); return { value: ta.value, mark: b.querySelector(':scope > .g').textContent, bash: b.classList.contains('bash'), ph: ta.placeholder, slash: !document.getElementById('slash').hidden }; })()`);
const enter = () => key('Enter', { code: 'Enter', vk: 13 });
const esc = () => key('Escape', { code: 'Escape', vk: 27 });
const bangs = () => ev(`[...document.querySelectorAll('#log .bang')].length`);
const lastBang = () => ev(`(() => { const b = [...document.querySelectorAll('#log .bang')].pop(); if (!b) return null; return { mark: b.querySelector('.bang-cmd .g').textContent, cmd: b.querySelector('.bang-cmd .cmd').textContent, out: [...b.querySelectorAll('.step-out .out:not(.err)')].map(x => x.textContent).join(''), err: [...b.querySelectorAll('.step-out .out.err')].map(x => x.textContent).join(''), text: b.querySelector('.bang-res').textContent, failed: !!b.querySelector('.res.failed') }; })()`);

// the CLI-recorded command reads as bash mode
const cli = await ev(`(() => { const b = document.querySelector('#log .bang[data-bang="d-b1"]'); return b ? b.querySelector('.bang-cmd .g').textContent + '|' + b.querySelector('.bang-cmd .cmd').textContent + '|' + b.querySelector('.step-out .out').textContent : null; })()`);
check('a command the CLI recorded shows as bash mode: ! on the band, its output under it', cli === '!|ls demo|notes.md', String(cli));

// entering and leaving the mode
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
let b = await box();
check('! as the first character: the mark is ! and the ! leaves the text', b.bash && b.mark === '!' && b.value === '', JSON.stringify(b));
check('the placeholder names the folder', b.ph === 'Run a shell command in /tmp/synopia-bang', b.ph);
check('the mark is the bash pink, not the link blue', await ev(`(() => { const g = document.querySelector('.composer > .g'); const c = getComputedStyle(g).color; return c === 'rgb(191, 57, 137)' || c === 'rgb(247, 120, 186)'; })()`), await ev(`getComputedStyle(document.querySelector('.composer > .g')).color`));
await type('/usr');
b = await box();
check('no slash menu in bash mode', !b.slash && b.value === '/usr', JSON.stringify(b));
for (let i = 0; i < 4; i++) await key('Backspace', { code: 'Backspace', vk: 8 });
b = await box();
check('still in bash mode while text is left to delete', b.bash && b.value === '', JSON.stringify(b));
await shot('bang-mode.png');
await key('Backspace', { code: 'Backspace', vk: 8 });
b = await box();
check('Backspace on the empty box leaves the mode', !b.bash && b.mark === '❯' && /\/ for commands$/.test(b.ph), JSON.stringify(b));
await type('see !this');
b = await box();
check('a ! later in a message is text', !b.bash && b.value === 'see !this', JSON.stringify(b));
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.dispatchEvent(new Event('input')); })()`);

// running a command: output, stderr apart, the exit code, landed once
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('echo hi; echo err >&2; exit 3');
await enter();
b = await box();
check('Enter runs it: the box is empty and back to ❯', !b.bash && b.value === '' && b.mark === '❯', JSON.stringify(b));
const landed = await c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'echo hi; echo err >&2; exit 3' && i.sh)`, 8000);
check('its records land in the transcript', landed);
await c.until(`!__synopia.cur().bang || !!__synopia.cur().bang.landed`, 3000);
await sleep(200);
const r = await lastBang();
check('the command on the band with !', r?.mark === '!' && r?.cmd === 'echo hi; echo err >&2; exit 3', JSON.stringify(r));
check('stdout, and stderr apart', r?.out === 'hi' && r?.err === 'err', JSON.stringify(r));
check('the non-zero exit is noted', r?.failed && /Exit code 3/.test(r?.text ?? ''), JSON.stringify(r));
check('stderr has its own shape (a 1px rule), not only its colour', await ev(`(() => { const e = [...document.querySelectorAll('#log .bang .step-out .out.err')].pop(); const st = getComputedStyle(e); return st.borderLeftWidth === '1px' && st.borderLeftStyle === 'solid'; })()`));
check('shown once (the live run gave way to the item)', (await ev(`[...document.querySelectorAll('#log .bang')].filter(x => x.querySelector('.bang-cmd .cmd').textContent === 'echo hi; echo err >&2; exit 3').length`)) === 1);
check('no ALL CAPS', await ev(`[...document.querySelectorAll('#log .bang *')].every(x => getComputedStyle(x).textTransform === 'none')`));
await shot('bang-exit.png');

// a long output: 20 lines, then Show all
const n0 = await bangs();
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('seq 1 45');
await enter();
check('the long one lands', await c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'seq 1 45' && i.sh) && document.querySelectorAll('#log .bang').length === ${n0 + 1} && !!document.querySelector('#log [data-full^="bang:"]')`, 8000));
const cutText = await ev(`[...document.querySelectorAll('#log .bang')].pop().querySelector('.step-out .out').textContent.split('\\n').length + '|' + document.querySelector('#log [data-full^="bang:"]').textContent`);
check('20 lines, then "Show all 45 lines"', cutText === '20|Show all 45 lines', cutText);
await ev(`document.querySelector('#log [data-full^="bang:"]').click()`);
check('Show all shows the 45', await c.until(`[...document.querySelectorAll('#log .bang')].pop().querySelector('.step-out .out').textContent.split('\\n').length === 45 && !document.querySelector('#log [data-full^="bang:"]')`));

// Esc, Esc ends a sleep 30; one at a time
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('sleep 30');
await enter();
check('it runs: "Running, Ns" live, and how to end it', await c.until(`!!__synopia.cur().bang?.running && /^Running, \\d+s$/.test(document.querySelector('#log .bang .step-out .res.running')?.textContent || '') && /Esc, Esc/.test(document.querySelector('#log .bang .step-out .res.note')?.textContent || '')`, 3000), await ev(`document.querySelector('#log .bang .bang-res')?.textContent`));
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('echo second');
await ev('__synopia.spy()');
await enter();
check('a second command while one runs: a toast, and it stays in the box', (await ev(`__synopia.sent('bang').length`)) === 0 && /still running/.test(await ev(`document.getElementById('toast').textContent`)) && (await box()).value === 'echo second');
await shot('bang-running.png');
await esc(); // insert to normal
await esc();
check('Esc, Esc asks "Interrupt?"', await c.until(`!!document.querySelector('.composer.asking') && /Interrupt\\?/.test(document.querySelector('.int-ask').textContent)`, 2000));
const t0 = Date.now();
await esc();
check('the second Esc ends it: Stopped', await c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'sleep 30' && i.sh) && /Stopped/.test([...document.querySelectorAll('#log .bang')].pop().textContent)`, 6000), await ev(`[...document.querySelectorAll('#log .bang')].pop().textContent`));
check('it ended at once (SIGTERM), not after 30 s', Date.now() - t0 < 4000);
await shot('bang-stopped.png');

// a session Synopia doesn't drive: no bash mode
await ev(`document.querySelector('.row[data-id="${N}"]').click()`);
await c.until(`__synopia.current() === '${N}' && !!__synopia.mounted()`);
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.focus(); })()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
b = await box();
check('not driven by Synopia: ! is text, no bash mode', !b.bash && b.value === '!' && b.mark === '❯', JSON.stringify(b));
c.print(); c.close();
