// Bash mode (R5.13): `!` in the message box runs a shell command, as in the Claude Code CLI, on a made-up
// fixture with the scripted SDK (the command runs for real through bang.ts; the scripted SDK appends the CLI's
// records Synopia shares with it to the fixture file, so they land as a real session's do).
// usage: node bang.mjs make <claude-dir>   writes the fixture (run.sh does this first)
//        node bang.mjs <url> <state-dir> <claude-dir>
// Checks: `!` as the first character turns the mark into a pink `!` and the placeholder into "Run a shell
// command in <folder>", the `!` leaves the text, no slash menu; Backspace on the empty box leaves the mode;
// `echo hi; echo err >&2; exit 3` runs: the command on the band, stdout, stderr apart, "Exit code 3", landed
// once as the transcript's item. The run row (2026-11-26, prototype/shell-storyboard.html): the last 3 lines and a
// state line ("Finished, …, 45 lines"), no input field and no "Show all"; a click on the row opens its shell view
// with all of it. A command over at once with no output is the band alone, and gets no card nor Past line; a
// `sleep 30` gets its card with the pink ! after 3 s, not before; Esc, Esc in the main view leaves it running and in
// its shell view stops it ("Stopped by you"). A `!` followed by a prompt stays above it, over a reload, two in a
// row, and one a running turn takes in (two queued_command records) is one row, not a queued message, with nothing
// left at the end; a session Synopia doesn't drive gets no bash mode; a command that waits for Enter runs in a
// terminal (isatty), stays in place while a message goes after it, waits for input as needs you (the row, its red
// card, the sidebar), opens in the shell view where i and an empty Enter in the box's ! band end it, and moves to
// Past with its !. Writes bang-*.png (and, with SYNOPIA_SHOTS, row, waiting, view and panel shots there).
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, terminal, outPanel, shot as shotTo } from './helpers.mjs';

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
  // each message D gets starts a short turn: a reply, then the result 1.5 s later (a `!` during it is taken in by the turn)
  const onSend = [{ append: [{ type: 'assistant', message: { id: 'msg-bang-reply', role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } }] },
    { after: 1500, message: { type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 1500, num_turns: 1 } },
    { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
  writeScript(process.argv[3], 'bang.mjs: made up', { [D]: { start: true, state: { status: 'idle', ago: 58000 }, onSend } });
  terminal(process.argv[3], 90002, N, '/tmp/synopia-bang'); // N: a terminal's Claude Code holds it
  fs.mkdirSync('/tmp/synopia-bang', { recursive: true }); // the command really runs in the session's folder
  // a made-up sign-in helper that prints what to do and waits for Enter (R5.13, 2026-11-26: a terminal for the run)
  fs.writeFileSync('/tmp/synopia-bang/wait-enter.mjs', [
    'console.log("Open the demo page and sign in as demo-user.");',
    'console.log(`isatty ${process.stdin.isTTY === true} ${process.stdout.isTTY === true}`);',
    'for (let i = 1; i <= 6; i++) console.log(`step ${i} of 6 noted`);',
    'process.stdout.write("Press Enter when the sign-in is done... ");',
    'process.stdin.once("data", () => { console.log("Thanks, carrying on."); process.exit(0); });',
  ].join("\n") + "\n");
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
const shot = (name) => c.cdp('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(stateDir, name), Buffer.from(r.result.data, 'base64')));
await c.load(`${url}#${D.slice(0, 8)}`, `__synopia.current() === '${D}' && !!__synopia.mounted() && __synopia.cur().state.driven === true && __synopia.cur().items.length === 3`);
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
{ const p = await outPanel(c, "#log .bang .step-out .out:not(.err)"); check("its output sits in the output panel, stderr beside it with its rule", !!p && p.ok, JSON.stringify(p)); }
await shot('bang-exit.png');
if (process.env.SYNOPIA_SHOTS) { fs.mkdirSync(process.env.SYNOPIA_SHOTS, { recursive: true }); await shotTo(c, path.join(process.env.SYNOPIA_SHOTS, `bang-${process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light'}.png`)); }

// a long output: the row has its last 3 lines and the count; the shell view has all 45
const n0 = await bangs();
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('seq 1 45');
await enter();
check('the long one lands', await c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'seq 1 45' && i.sh) && document.querySelectorAll('#log .bang').length === ${n0 + 1}`, 8000));
const longRow = await ev(`(() => { const b = [...document.querySelectorAll('#log .bang')].pop(); return { out: b.querySelector('.step-out .out').textContent, st: b.querySelector('.res.rst')?.textContent || '', more: !!b.querySelector('[data-full]') }; })()`);
check('the row: the last 3 lines, then "Finished, …, 45 lines", no Show all', longRow.out === '43\n44\n45' && /^Finished, .*45 lines$/.test(longRow.st) && !longRow.more, JSON.stringify(longRow));
check('no input field in any transcript row', await ev(`!document.querySelector('#log input, #log textarea, #log .bang-in')`));
const longId = await ev(`(__synopia.cur().bangs || []).find(r => r.cmd === 'seq 1 45')?.id || ''`);
await ev(`[...document.querySelectorAll('#log .bang')].pop().querySelector('.bang-res').click()`);
check('a click on the row opens its shell view, with all 45 lines', await c.until(`__synopia.view() === '${longId}' && (document.querySelector('#log .bang .step-out .out')?.textContent || '').split('\\n').length === 45`, 5000), await ev(`document.getElementById('log').textContent.slice(0, 200)`));
check('an ended run\'s view has no box to type in', await ev(`!document.getElementById('run-in')`));
await ev(`document.querySelector('[data-back]').click()`);
await c.until(`__synopia.view() === null && !!document.getElementById('msg')`, 3000);

// a command over at once, with no output: the band alone, and no card nor Past line, ever (R7.1: none under 3 s)
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('true');
await enter();
check('an instant command lands', await c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'true' && i.sh) && (!__synopia.cur().bang || !!__synopia.cur().bang.landed)`, 8000));
const trueId = await ev(`(__synopia.cur().bangs || []).find(r => r.cmd === 'true')?.id || ''`);
await sleep(3500);
const alone = await ev(`(() => { const b = [...document.querySelectorAll('#log .bang')].find(x => x.querySelector('.bang-cmd .cmd').textContent === 'true'); return b ? { res: !!b.querySelector('.bang-res'), text: b.textContent } : null; })()`);
check('done at once with no output: the band alone, no "No output"', !!alone && !alone.res && !/No output/.test(alone.text), JSON.stringify(alone));
check('no card and no Past line for it, 3.5 s on', !!trueId && await ev(`!document.querySelector('.rail [data-bg="${trueId}"]')`), await ev(`document.querySelector('.rail')?.textContent || ''`));

// sleep 30: its card after 3 s, not before; Esc, Esc in the main view leaves it; in its shell view it stops it
await ev(`document.getElementById('msg').focus()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('sleep 30');
await enter();
check('it runs: the state line "Running, Ns" with the shell mark', await c.until(`!!__synopia.cur().bang?.running && /^Running, \\d+s$/.test(document.querySelector('#log .bang.running .res.rst')?.textContent || '') && !!document.querySelector('#log .bang.running .res.rst .ind')`, 3000), await ev(`document.querySelector('#log .bang .bang-res')?.textContent`));
const sleepId = await ev(`__synopia.cur().bang.id`);
await sleep(800);
check('no card in its first 3 s', await ev(`!document.querySelector('.rail .now [data-bg="${sleepId}"]')`));
check('its card after 3 s, with the pink ! before the command, "shell, started by you"', await c.until(`(() => { const r = document.querySelector('.rail .now [data-bg="${sleepId}"]'); return !!r && r.querySelector('.n .who')?.textContent === '!' && /shell, started by you/.test(r.textContent); })()`, 4000), await ev(`document.querySelector('.rail')?.textContent || ''`));
check('the ! is in the bash pink', await ev(`(() => { const c = getComputedStyle(document.querySelector('.rail .now [data-bg="${sleepId}"] .who')).color; return c === 'rgb(191, 57, 137)' || c === 'rgb(247, 120, 186)'; })()`));
check('the sidebar does not count it with Claude\'s background work', await ev(`!/shells? or monitors? running/.test(document.querySelector('.row[aria-current="true"]').textContent)`));
await key('!', { code: 'Digit1', shift: true, vk: 49 });
await type('echo second');
await ev('__synopia.spy()');
await enter();
check('a second command while one runs: a toast, and it stays in the box', (await ev(`__synopia.sent('bang').length`)) === 0 && /still running/.test(await ev(`document.getElementById('toast').textContent`)) && (await box()).value === 'echo second');
await shot('bang-running.png');
await esc(); // insert to normal
await esc();
await esc();
await sleep(400);
check('Esc, Esc in the main view leaves your command running', await ev(`!!__synopia.cur().bang?.running && __synopia.cur().bang.id === '${sleepId}'`));
await ev(`document.querySelector('#log .bang.running .bang-res').click()`);
check('the row opens its shell view, with the ! band in the box\'s place', await c.until(`__synopia.view() === '${sleepId}' && !!document.getElementById('run-in')`, 3000));
await esc();
check('Esc in its shell view asks "Stop this shell?"', await c.until(`!!document.querySelector('.composer.asking') && /Stop this shell\\?/.test(document.querySelector('.int-ask').textContent)`, 2000), await ev(`document.querySelector('.dock')?.textContent`));
const t0 = Date.now();
await ev('__synopia.spy()');
await esc();
check('the second Esc sends bangStop for it', await c.until(`__synopia.sent('bangStop').length === 1 && __synopia.sent('bangStop')[0].bg === '${sleepId}'`, 2000));
check('it ends: Stopped, and the box goes with the run', await c.until(`/Stopped after/.test(document.getElementById('log').textContent) && !document.getElementById('run-in')`, 6000), await ev(`document.getElementById('log').textContent`));
check('it ended at once (SIGTERM), not after 30 s', Date.now() - t0 < 4000);
await ev(`document.querySelector('[data-back]').click()`);
check('its row reads "Stopped by you after Ns" with the grey square', await c.until(`__synopia.view() === null && __synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'sleep 30' && i.sh) && /^Stopped by you after \\d+s$/.test([...document.querySelectorAll('#log .bang')].find(x => x.querySelector('.bang-cmd .cmd').textContent === 'sleep 30')?.querySelector('.res.rst')?.textContent || '')`, 6000), await ev(`[...document.querySelectorAll('#log .bang')].pop().textContent`));
await shot('bang-stopped.png');

// in place in time: the CLI writes the command and its output as one record (docs/Claude Code transcripts.md,
// "Bash mode records"); the row stays where it ran, above the next prompt, and nothing is left at the end
const runCmd = async (cmd) => {
  await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.dispatchEvent(new Event('input')); ta.focus(); })()`);
  if ((await box()).bash) await key('Backspace', { code: 'Backspace', vk: 8 }); // the box can still be in bash mode
  await key('!', { code: 'Digit1', shift: true, vk: 49 });
  await type(cmd);
  await enter();
  return c.until(`__synopia.cur().items.some(i => i.k === 'bang' && i.cmd === ${JSON.stringify(cmd)} && i.sh) && (!__synopia.cur().bang || !!__synopia.cur().bang.landed)`, 8000);
};
const sendText = async (t) => {
  await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.dispatchEvent(new Event('input')); ta.focus(); })()`);
  await type(t);
  await enter();
};
const rowsOf = (cmd) => ev(`[...document.querySelectorAll('#log .bang')].filter(x => x.querySelector('.bang-cmd .cmd').textContent === ${JSON.stringify(cmd)}).length`);
// the bang row of cmd comes before the prompt band holding text, and the log's last row is no bang
const order = (cmd, text) => ev(`(() => { const b = [...document.querySelectorAll('#log .bang')].find(x => x.querySelector('.bang-cmd .cmd').textContent === ${JSON.stringify(cmd)});
  const p = [...document.querySelectorAll('#log .prompt:not(.bang-cmd)')].find(x => x.textContent.includes(${JSON.stringify(text)}));
  const all = [...document.querySelectorAll('#log .prompt, #log .bang')]; const lastBang = all.length && all[all.length - 1].classList.contains('bang');
  return { found: !!b && !!p, before: !!b && !!p && !!(b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING), lastBang }; })()`);
const idle = () => c.until(`__synopia.cur().state.status !== 'busy'`, 8000);
await idle();
check('a ! with stdout, run while idle, lands', await runCmd('echo before'), await ev(`JSON.stringify({ bang: __synopia.cur().bang, last: __synopia.cur().items.slice(-3).map(i => [i.k, i.cmd || i.text, !!i.sh]), box: document.getElementById('msg').value, toast: document.getElementById('toast').textContent })`));
check('two ! in a row land, each once', (await runCmd('echo second')) && (await rowsOf('echo before')) === 1 && (await rowsOf('echo second')) === 1);
await c.load(`${url}#${D.slice(0, 8)}`, `__synopia.current() === '${D}' && !!__synopia.mounted() && __synopia.cur().items.some(i => i.k === 'bang' && i.cmd === 'echo second')`);
check('after a reload before the next prompt: each row once, no live run', (await rowsOf('echo before')) === 1 && (await rowsOf('echo second')) === 1 && !(await ev(`__synopia.cur().bang && !__synopia.cur().bang.landed`)));
await sendText('After the commands.');
check('the next prompt lands and its turn ends', await c.until(`__synopia.cur().items.some(i => i.k === 'you' && i.text === 'After the commands.') && __synopia.cur().state.status !== 'busy'`, 8000));
await sleep(300);
let o = await order('echo second', 'After the commands.');
check('the ! rows stay above the prompt that followed, nothing left at the end of the log', o.before && !o.lastBang && (await rowsOf('echo second')) === 1, JSON.stringify(o));
await shot('bang-order.png');
// during a turn: the CLI takes it in as two queued_command records
await sendText('Keep going.');
await c.until(`__synopia.cur().state.status === 'busy'`, 3000);
check('a ! during a turn lands as one row', await runCmd('echo mid'), await ev(`JSON.stringify(__synopia.cur().items.slice(-4).map(i => [i.k, i.cmd || i.text]))`));
check('not a queued message: no prompt of its tags, none waiting', await ev(`!__synopia.cur().items.some(i => i.k === 'you' && /^<bash-/.test(i.text || '')) && !(__synopia.cur().outbox || []).length`));
await idle();
await sendText('And after that.');
check('the turn after it lands', await c.until(`__synopia.cur().items.some(i => i.k === 'you' && i.text === 'And after that.') && __synopia.cur().state.status !== 'busy'`, 8000));
await sleep(300);
o = await order('echo mid', 'And after that.');
check('the mid-turn ! stays in place, once, nothing left at the end', o.before && !o.lastBang && (await rowsOf('echo mid')) === 1, JSON.stringify(o));

// a terminal for the run (R5.13, R7.1, 2026-11-26): a command that prints a prompt and waits for Enter stays where it
// ran while a message goes after it, shows in the panel as yours, opens in the shell view, and Enter in its input line
// ends it; then it moves to Past
{
  const shots = process.env.SYNOPIA_SHOTS, theme = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
  const keep = async (name, sel) => {
    await shot(`bang-pty-${name}.png`);
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const r = sel && await ev(`(() => { const es = [...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.getBoundingClientRect()); if (!es.length) return null; const x = Math.min(...es.map(b => b.left)), y = Math.min(...es.map(b => b.top)), r = Math.max(...es.map(b => b.right)), btm = Math.max(...es.map(b => b.bottom)); return { x: Math.max(0, x - 12), y: Math.max(0, y - 12), width: r - x + 24, height: btm - y + 24 }; })()`);
    await shotTo(c, path.join(shots, `${name}-${theme}.png`), r || undefined);
  };
  await idle();
  const cmd = 'node wait-enter.mjs';
  await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.dispatchEvent(new Event('input')); ta.focus(); })()`);
  if ((await box()).bash) await key('Backspace', { code: 'Backspace', vk: 8 });
  await key('!', { code: 'Digit1', shift: true, vk: 49 });
  await type(cmd);
  await enter();
  const waits = await c.until(`!!__synopia.cur().bang?.running && /Press Enter/.test(__synopia.cur().bang.out) && __synopia.cur().bang.waiting === true`, 8000);
  check('a command that prints a prompt and goes quiet waits for input', waits, await ev(`JSON.stringify(__synopia.cur().bang)`));
  const id = await ev(`__synopia.cur().bang.id`);
  check('it runs in a terminal: isatty is true for stdin and stdout', await ev(`/isatty true true/.test(__synopia.cur().bang.out)`), await ev(`__synopia.cur().bang.out`));
  check('the CRLF of the pty and escapes are gone from its output', await ev(`!/[\\r\\x1b]/.test(__synopia.cur().bang.out)`));
  const row = async () => ev(`(() => { const b = document.querySelector('#log .bang[data-bang="${id}"]'); if (!b) return null; const o = [...b.querySelectorAll('.step-out .out')].map(x => x.textContent).join('\\n'); const st = b.querySelector('.res.rst'); return { lines: o.split('\\n').length, last: o.split('\\n').pop(), st: st?.textContent, red: st?.classList.contains('waits'), pause: !!st?.querySelector('.bars'), color: st ? getComputedStyle(st).color : '', input: !!b.querySelector('input, textarea'), link: b.dataset.bg === '${id}' }; })()`);
  const w = await row();
  check('the row: the last 3 lines, then "Waits for input, Ns" in red with the pause mark', !!w && w.lines === 3 && /Press Enter/.test(w.last) && /^Waits for input, \d+s$/.test(w.st || '') && w.red && w.pause && /^rgb\((207, 34, 46|255, 123, 114|248, 81, 73)\)$/.test(w.color), JSON.stringify(w));
  check('no input field in the row; the row is the link to its shell view', !!w && !w.input && w.link && await ev(`!document.querySelector('#log input, #log textarea, #log .bang-in')`), JSON.stringify(w));
  check('waiting is needs you: the session reads "Needs you, a command waits for input"', await c.until(`__synopia.cur().state.needsYou === 'input' && __synopia.cur().state.light === 'red' && /^Needs you, a command waits for input/.test(document.querySelector('.row[aria-current="true"] .r-state').textContent)`, 3000), await ev(`JSON.stringify(__synopia.cur().state)`));
  check('the sidebar names it on a sub-line: the pause mark, ! and its command, waits', await ev(`(() => { const l = document.querySelector('.row[aria-current="true"] [data-line="wait"]'); return !!l && !!l.querySelector('.bars') && l.querySelector('.who')?.textContent === '!' && l.textContent.includes('${cmd}') && /waits$/.test(l.textContent.trim()); })()`), await ev(`document.querySelector('.row[aria-current="true"]').textContent`));
  check('its card is there at once (it waits), red, the pause mark, "shell, waits for input"', await c.until(`(() => { const r = document.querySelector('.rail .now [data-bg="${id}"]'); return !!r && r.classList.contains('waits') && !!r.querySelector('.bars') && /shell, waits for input/.test(r.textContent) && r.querySelector('.who')?.textContent === '!'; })()`, 3000), await ev(`document.querySelector('.rail')?.innerHTML.slice(0, 600)`));
  check('the Main conversation card reads Needs you, and the dock keeps the message box with no status line', await ev(`document.querySelector('.rail .main-row .w').textContent === 'Needs you' && !document.querySelector('.dock .status') && !!document.getElementById('msg')`));
  await keep('waiting', `#log .bang[data-bang="${id}"], .rail .now, .side .row[aria-current="true"]`);
  await keep('bang-row', `#log .bang[data-bang="${id}"]`);
  // a message sent after it goes below it
  await sendText('Sent while the helper waits.');
  check('the message lands', await c.until(`__synopia.cur().items.some(i => i.k === 'you' && i.text === 'Sent while the helper waits.')`, 8000));
  const top0 = await ev(`document.querySelector('#log .bang[data-bang="${id}"]').getBoundingClientRect().top + document.getElementById('log').scrollTop`);
  o = await order(cmd, 'Sent while the helper waits.');
  check('the running row stays where it ran: the later message is below it, the log does not end with it', o.before && !o.lastBang, JSON.stringify(o));
  await ev(`document.querySelector('#log .bang[data-bang="${id}"] .bang-res').click()`);
  const opened = await c.until(`__synopia.view() === '${id}' && /Press Enter/.test(document.querySelector('#log .bang .step-out')?.textContent || '') && !!document.getElementById('run-in')`, 5000);
  check('the row opens its shell view: its whole output, and the ! band in the box\'s place', opened, await ev(`document.getElementById('log').textContent.slice(0, 400)`));
  check('the view shows all of it, not the row\'s tail', await ev(`/Open the demo page/.test(document.querySelector('#log .bang .step-out').textContent) && /step 6 of 6/.test(document.querySelector('#log .bang .step-out').textContent)`));
  check('its header says it waits and is yours', await ev(`/Waits for input, \\d+s\\. Your shell command/.test(document.querySelector('.c-head').textContent)`), await ev(`document.querySelector('.c-head').textContent`));
  check('its live line: Waits for input in red with the pause mark', await ev(`(() => { const l = document.querySelector('#log .liveln'); return !!l && l.dataset.state === 'red' && /^Waits for input/.test(l.textContent.trim()) && !!l.querySelector('.bars'); })()`));
  const band = await ev(`(() => { const t = document.getElementById('run-in'), b = t.closest('.composer'); return { mark: b.querySelector(':scope > .g').textContent, bash: b.classList.contains('bash'), ph: t.placeholder }; })()`);
  check('the box\'s place is a ! band that types to the command', band.mark === '!' && band.bash && /^Type to node wait-enter\.mjs\. Enter sends the line; an empty Enter sends Enter$/.test(band.ph), JSON.stringify(band));
  await key('i', { code: 'KeyI', vk: 73 });
  check('i takes the band: insert mode, the field focused', await c.until(`document.activeElement?.id === 'run-in' && __synopia.mode() === 'insert'`, 2000));
  await keep('view-input', null);
  // Enter (empty) in the band: the helper reads it and ends
  await ev('__synopia.spy()');
  await enter();
  check('Enter sends one bangInput with an empty line', await c.until(`__synopia.sent('bangInput').length === 1 && __synopia.sent('bangInput')[0].text === ''`, 3000));
  check('the helper got its Enter and finished', await c.until(`(__synopia.cur().bangs || []).some(r => r.id === '${id}' && !r.running && r.exit === 0) && /Finished after/.test(document.getElementById('log').textContent) && /Thanks, carrying on/.test(document.getElementById('log').textContent)`, 6000), await ev(`JSON.stringify(__synopia.cur().bangs)`));
  check('the band goes with the run; the session no longer needs you', await c.until(`!document.getElementById('run-in') && __synopia.cur().state.needsYou === null`, 3000), await ev(`JSON.stringify(__synopia.cur().state)`));
  check('it moves to Past, with its !', await c.until(`!!document.querySelector('.rail .past [data-bg="${id}"] .who') && !document.querySelector('.rail .now [data-bg="${id}"]')`, 9000));
  await keep('panel', `.rail`);
  await ev(`document.querySelector('[data-back]').click()`);
  check('back in the conversation, its records land once, still above the later message', await c.until(`__synopia.view() === null && __synopia.cur().items.some(i => i.k === 'bang' && i.cmd === '${cmd}' && i.sh) && document.querySelectorAll('#log .bang .bang-cmd .cmd').length > 0`, 8000));
  await sleep(300);
  o = await order(cmd, 'Sent while the helper waits.');
  check('the landed row is where it ran, once', o.before && (await rowsOf(cmd)) === 1, JSON.stringify(o));
  check('the landed row keeps the output after Enter: the last line of the helper, Finished', await ev(`(() => { const b = [...document.querySelectorAll('#log .bang')].find(x => x.querySelector('.bang-cmd .cmd').textContent === '${cmd}'); return /Thanks, carrying on/.test(b.textContent) && /^Finished, /.test(b.querySelector('.res.rst').textContent); })()`));
  await ev(`[...document.querySelectorAll('#log .bang .bang-cmd .cmd')].find(x => x.textContent === '${cmd}')?.click()`);
  check('a click on the command opens the shell view too', await c.until(`__synopia.view() === '${id}'`, 3000));
  await ev(`document.querySelector('[data-back]').click()`);
  await c.until(`__synopia.view() === null`, 3000);
  void top0;
}

// a session Synopia doesn't drive: no bash mode
await ev(`document.querySelector('.row[data-id="${N}"]').click()`);
await c.until(`__synopia.current() === '${N}' && !!__synopia.mounted()`);
await ev(`(() => { const ta = document.getElementById('msg'); ta.value = ''; ta.focus(); })()`);
await key('!', { code: 'Digit1', shift: true, vk: 49 });
b = await box();
check('not driven by Synopia: ! is text, no bash mode', !b.bash && b.value === '!' && b.mark === '❯', JSON.stringify(b));
c.print(); c.close();
