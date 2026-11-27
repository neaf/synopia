// The session states of R8.2 that status.ts wires (queued, compacting, retrying, sign-in expired,
// no updates), on the states fixture's SDK script, and needs you after a step auto mode blocked: the sidebar's word and mark per row, the
// transcript's last line, and the sign-in expired status line (creds.mjs has the refresh). Writes states-<n>.png in the state folder.
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
  ['a1a1', 'green', /^Working, 1 message queued$/, 'mk-0550AE', 'Your message is queued'],
  ['b2b2', 'green', /^Compacting context$/, 'class="cr"', 'Summing up the conversation'],
  ['c3c3', 'amber', /^Retrying, attempt 3 of 10, in \d+s$/, 'class="rl"', 'Rate limited (HTTP 429) · retrying in'],
  ['d4d4', 'red', /^Needs you, sign-in expired, \d+ min$/, 'class="bars"', null],
  ['e5e5', 'grey', /^No updates for 1[56] min$/, 'arc frozen', 'the session may be gone'],
  // its main turn is over and its background subagents run: your turn, still, with no live line; the panel's Main
  // conversation card counts what runs (R8.2, 2026-11-26: motion means the main turn runs)
  ['f6f6', 'amber', /^Your turn, \d+ \w+$/, '<rect', false],
  // the author's mix: a turned-down tool earlier, a subagent, a shell and a monitor running, and
  // its main turn open in another process (a foreground tool waiting): working, not stopped
  ['f7f7', 'green', /^Working$/, 'class="rot"', 'Working Bash(Run the tests)'],
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
      return { live: !!document.querySelector('#log .liveln'), count: document.querySelector('.rail .main-row .m')?.textContent || '', word: document.querySelector('.rail .main-row .w')?.textContent || '', main: moving(document.querySelector('.rail .main-row > .ind')), side: moving(r.querySelector('.r-side')) }; })()`);
    check(`${p}: your turn, with the count of what runs and no moving mark; no live line`, !f6.live && /^\d+ running in the background$/.test(f6.count) && f6.word === 'Your turn' && f6.main === 0 && f6.side === 0, JSON.stringify(f6));
  } else if (line) {
    const live = await ev(`document.querySelector('.liveln')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: transcript line`, live.includes(line), JSON.stringify(live));
  } else {
    const st = await ev(`document.querySelector('.dock .status')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: sign-in expired status line above the box`, st.startsWith('Needs you, sign-in expired') && st.includes('Run to refresh credentials:') && !(await ev(`!!document.querySelector('.liveln')`)), JSON.stringify(st));
  }
  const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${stateDir}/states-${++n}.png`, Buffer.from(shot.result.data, 'base64'));
}
// a terminal session whose ended turn has a step auto mode blocked: needs you, and the step says why (R8.2)
const blk = await row('a8a8');
check('a8a8: row state red', blk?.state === 'red', JSON.stringify(blk?.state));
check('a8a8: row word', /^Needs you, blocked, /.test(blk?.word ?? ''), JSON.stringify(blk?.word));
check('a8a8: row mark', (blk?.mark ?? '').includes('class="bars"'), (blk?.mark ?? '').slice(0, 120));
await ev(`document.querySelector('.row[data-id^="a8a8"]').click()`); await sleep(1000);
const stepRes = await ev(`[...document.querySelectorAll('.ln.tool.denied .body > details > summary.res, .ln.tool.denied .body > div.res')].map(e => e.textContent.trim()).join('|')`);
check('a8a8: the step reads blocked by auto mode, not failed', /^[^|]+\(.*\), blocked by auto mode$/.test(stepRes) && !(await ev(`!!document.querySelector('.ln.tool.failed')`)), JSON.stringify(stepRes));
const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${stateDir}/states-${++n}.png`, Buffer.from(shot.result.data, 'base64'));
c.print();
c.close();
