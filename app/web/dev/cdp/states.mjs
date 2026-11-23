// The session states of R8.2 that status.ts wires (queued, compacting, rate limited, signed out,
// no updates), on the states fixture's fake script: the sidebar's word and mark per row, the
// transcript's last line, and the signed-out status line. Writes states-<n>.png in the state folder.
// usage: run.sh states (or node states.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
const [url, stateDir] = process.argv.slice(2);
const want0 = 7; // sessions in the states fixture
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false });
await c.cdp('Page.navigate', { url });
await sleep(2000);
for (let i = 0; i < 40 && (await ev(`document.querySelectorAll('#groups .row').length`)) < want0; i++) await sleep(250); // every row in
await sleep(500);
const row = (p) => ev(`(() => { const r = document.querySelector('.row[data-id^="${p}"]'); return r && { state: r.dataset.state, word: r.querySelector('.r-state').textContent.trim(), mark: r.querySelector('.r-side').innerHTML }; })()`);
const want = [
  ['a1a1', 'green', /^Working, 1 message queued$/, 'mk-0550AE', 'Your message is queued'],
  ['b2b2', 'green', /^Compacting context$/, 'class="cr"', 'Summing up the conversation'],
  ['c3c3', 'amber', /^Rate limited, retrying in \d+s$/, 'class="rl"', 'attempt 3 of 10'],
  ['d4d4', 'red', /^Signed out, \d+ min$/, 'class="lock"', null],
  ['e5e5', 'grey', /^No updates for 1[56] min$/, 'arc frozen', 'the session may be gone'],
  // no driver status: the main turn is over and background subagents run, so it is working (R8.2)
  ['f6f6', 'green', /^Working$/, 'class="rot"', 'Working'],
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
  if (line) {
    const live = await ev(`document.querySelector('.liveln')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: transcript line`, live.includes(line), JSON.stringify(live));
  } else {
    const st = await ev(`document.querySelector('.dock .status')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(`${p}: signed-out status line above the box`, st.startsWith('Signed out') && !(await ev(`!!document.querySelector('.liveln')`)), JSON.stringify(st));
  }
  const shot = await c.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${stateDir}/states-${++n}.png`, Buffer.from(shot.result.data, 'base64'));
}
c.print();
c.close();
