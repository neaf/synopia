// The session states of R8.2 that status.ts wires (queued, compacting, retrying, sign-in expired,
// no updates, idle with background work, running a command), on the states fixture's SDK script, and your turn after a
// step auto mode blocked (2026-11-27: needs you comes only from the SDK): the sidebar's word and mark per row, the
// transcript's last line, the sign-in expired status line (creds.mjs has the refresh), and the sidebar's sub-lines nested
// as the panel's tree (R4.2, 2026-11-27). Writes states-<n>.png in the state folder.
// usage: run.sh states (or node states.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
const [url, stateDir] = process.argv.slice(2);
const want0 = 8; // sessions in the states fixture
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false });
await c.load(url, `document.querySelectorAll('#groups .row').length >= ${want0}`); // every row in
const row = (p) => ev(`(() => { const r = document.querySelector('.row[data-id^="${p}"]'); return r && { state: r.dataset.state, word: r.querySelector('.r-state').textContent.trim(), mark: r.querySelector('.r-side').innerHTML }; })()`);
const want = [
  ['a1a1', 'green', /^Thinking, 1 message queued$/, 'mk-0550AE', 'Your message is queued'],
  ['b2b2', 'green', /^Compacting context$/, 'class="cr"', 'Summing up the conversation'],
  ['c3c3', 'amber', /^Retrying, attempt 3 of 10, in \d+s$/, 'class="rl"', 'Rate limited (HTTP 429) · retrying in'],
  ['d4d4', 'red', /^Needs you, sign-in expired, \d+ min$/, 'class="bars"', null],
  ['e5e5', 'grey', /^No updates for 1[56] min$/, 'arc frozen', 'the session may be gone'],
  // its main turn is over and its background subagents run: idle, the still agent mark, no live line; the panel's Main
  // conversation card counts what runs, and only the sub-lines move (R8.2, 2026-11-27)
  ['f6f6', 'grey', /^Idle, 2 running in the background$/, 'r="4.8"', false],
  // the author's mix: a turned-down tool earlier, a subagent, a shell and a monitor running, and its main turn open in
  // another process with a foreground Bash waiting for days: running a command, the moving shell mark (2026-11-27)
  ['f7f7', 'green', /^Running a command, \d+h \d+m$/, 'class="bounce"', /^Running Bash\(Run the tests\) \d+h \d+m$/],
];
let n = 0;
for (const [p, state, word, mark, line] of want) {
  const r = await row(p);
  check(`${p}: row state ${state}`, r?.state === state, JSON.stringify(r?.state));
  check(`${p}: row word`, word.test(r?.word ?? ''), JSON.stringify(r?.word));
  check(`${p}: row mark`, (r?.mark ?? '').includes(mark), (r?.mark ?? '').slice(0, 120));
  await ev(`document.querySelector('.row[data-id^="${p}"]').click()`); await sleep(1000);
  if (line === false) {
    const f6 = await ev(`(() => { const r = document.querySelector('.row[data-id^="${p}"]'), moving = e => e ? e.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length : -1;
      return { live: !!document.querySelector('#log .liveln'), count: document.querySelector('.rail .main-row .m')?.textContent || '', word: document.querySelector('.rail .main-row .w')?.textContent || '', main: moving(document.querySelector('.rail .main-row > .ind')), side: moving(r.querySelector('.r-side')),
        subs: [...r.querySelectorAll('.r-agent[data-line^="a:"], .r-agent[data-line^="b:"]')].filter(l => !l.classList.contains('r-gone')).map(l => moving(l)) }; })()`);
    check(`${p}: idle, with the count of what runs; the main mark still, the sub-lines moving; no live line`, !f6.live && f6.count === '2 running in the background' && f6.word === 'Idle' && f6.main === 0 && f6.side === 0
      && f6.subs.length > 0 && f6.subs.every(m => m > 0), JSON.stringify(f6));
    // a subagent's own subagent and monitor sit under it, one level deeper, in the panel's order (subagents, then monitors)
    const tree = await ev(`(() => { const r = document.querySelector('.row[data-id^="${p}"]');
      const lines = [...r.querySelectorAll('.r-agent[data-line^="a:"], .r-agent[data-line^="b:"]')].map(l => ({ line: l.dataset.line, depth: +(l.style.getPropertyValue('--depth') || 0), text: l.textContent.replace(/\\s+/g, ' ').trim(), x: Math.round(l.querySelector('.el').getBoundingClientRect().left), mark: (b => b ? Math.round(b.left + b.width / 2) : null)(l.querySelector('.ind')?.getBoundingClientRect()) }));
      const panel = [...document.querySelectorAll('.rail .kid')].map(k => ({ key: k.dataset.line, depth: (function d(e) { let n = 0; for (let x = e.parentElement; x; x = x.parentElement) if (x.classList?.contains('kid')) n++; return n; })(k) }));
      return { lines, panel }; })()`);
    const at = k => tree.lines.findIndex(l => l.line === k), L = k => tree.lines[at(k)];
    const nested = L('a:aaaa0007') && L('b:toolu_ag2mon') && L('a:aaaa0002');
    check(`${p}: the sidebar nests a subagent's own subagent and monitor under it, as the panel does`, !!nested && L('a:aaaa0002').depth === 0 && L('a:aaaa0007').depth === 1 && L('b:toolu_ag2mon').depth === 1
      && at('a:aaaa0002') < at('a:aaaa0007') && at('a:aaaa0007') < at('b:toolu_ag2mon')
      && tree.panel.find(k => k.key === 'aaaa0007')?.depth === 1 && tree.panel.find(k => k.key === 'toolu_ag2mon')?.depth === 1 && tree.panel.find(k => k.key === 'aaaa0002')?.depth === 0, JSON.stringify(tree));
    check(`${p}: a nested line's corner sits under its parent's mark`, !!nested && Math.abs(L('a:aaaa0007').x - L('a:aaaa0002').mark) <= 1, JSON.stringify([L('a:aaaa0007'), L('a:aaaa0002')]));
  } else if (line) {
    const live = await ev(`document.querySelector('.liveln')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: transcript line`, typeof line === 'string' ? live.includes(line) : line.test(live), JSON.stringify(live));
    if (p === 'f7f7') {
      const cmd = await ev(`(() => { const L = document.querySelector('.liveln'), m = document.querySelector('.rail .main-row'); return { cls: L.classList.contains('cmd'), bounce: !!L.querySelector('.g .bounce'), word: getComputedStyle(L.querySelector('b')).color, card: m?.querySelector('.w')?.textContent, cardMark: !!m?.querySelector('.ind .bounce') }; })()`);
      check(`${p}: the live line and the Main conversation card take the shell mark, "Running" in the shell colour`, cmd.cls && cmd.bounce && cmd.word === 'rgb(11, 122, 130)' && cmd.card === 'Running a command' && cmd.cardMark, JSON.stringify(cmd));
    }
  } else {
    const st = await ev(`document.querySelector('.dock .status')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: sign-in expired status line above the box`, st.startsWith('Needs you, sign-in expired') && st.includes('Run to refresh credentials:') && !(await ev(`!!document.querySelector('.liveln')`)), JSON.stringify(st));
  }
  const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${stateDir}/states-${++n}.png`, Buffer.from(shot.result.data, 'base64'));
}
// a terminal session whose ended turn has a step auto mode blocked: your turn, not needs you (2026-11-27, the user: "Use it
// only when we get the actual sdk flag like it was before."), and the step still says why (R8.2)
const blk = await row('a8a8');
check('a8a8: row state amber', blk?.state === 'amber', JSON.stringify(blk?.state));
check('a8a8: row word', /^Your turn, /.test(blk?.word ?? ''), JSON.stringify(blk?.word));
check('a8a8: row mark', (blk?.mark ?? '').includes('<rect'), (blk?.mark ?? '').slice(0, 120));
await ev(`document.querySelector('.row[data-id^="a8a8"]').click()`); await sleep(1000);
const stepRes = await ev(`[...document.querySelectorAll('.ln.tool.denied .body > details > summary.res, .ln.tool.denied .body > div.res')].map(e => e.textContent.trim()).join('|')`);
check('a8a8: the step reads blocked by auto mode, not failed', /^[^|]+\(.*\), blocked by auto mode$/.test(stepRes) && !(await ev(`!!document.querySelector('.ln.tool.failed')`)), JSON.stringify(stepRes));
const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${stateDir}/states-${++n}.png`, Buffer.from(shot.result.data, 'base64'));
c.print();
c.close();
