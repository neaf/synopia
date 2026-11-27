// Markdown tables in Claude's replies (R5.10), on an invented reply with three tables, at a reply 1000px and
// 640px wide. Checks: no number or short cell breaks onto a second line, number columns align right, the
// separator row's colons win, the table is 11px with a 1px rule between rows, it never runs past the reply
// (a 10-column table scrolls in its own box when it must), and prose outside the tables still wraps a long token.
// usage: run.sh tables (or node tables.mjs <url> <state-dir>). Writes tables-<width>-<theme>.png.
import path from 'node:path';
import { shot } from './helpers.mjs';
import { connect } from './cdp.mjs';

const [url, stateDir] = process.argv.slice(2);
const theme = process.env.SYNOPIA_CDP_THEME || 'light';
const L = (n) => `https://example.com/acme/web/pull/${n}`;
const row = (cs) => `| ${cs.join(' | ')} |`;
const table = (rows, sep) => [row(rows[0]), row(sep || rows[0].map(() => '---')), ...rows.slice(1).map(row)].join('\n');
const MAIN = table([
  ['Endpoint', 'Calls', 'p50', 'p95', 'Verdict'],
  ['`sidebar/projects` (recent list + search)', '418k + 386k', '~44 ms', '210 ms', `Fine for now; the search half is the slow one and already has its own ticket, see [#271828](${L(271828)})`],
  ['Cart summary and cart list (per shop)', '341k', '65 ms', '340 ms', 'Cache it per shop for 30 seconds; nobody needs these counts fresher than that'],
  ['`inbox/unread`', '298k', '~12 ms', '41 ms', 'Fine'],
  ['`reports/export` (CSV, all rows)', '8k', '1.9 s', '14 s', 'Move it to a background job and email a link; it times out for the biggest teams'],
  ['`auth/refresh`', '1.2M', '~6 ms', '19 ms', 'Fine'],
]);
const WIDE = table([
  ['Region', 'Endpoint', 'Calls', 'p50', 'p95', 'p99', 'Errors', 'Cache hit', 'Owner', 'Last deploy'],
  ['eu-west', '`sidebar/projects`', '522k', '~44 ms', '210 ms', '610 ms', '0.02%', '91%', 'shop-backend', '2026-11-18'],
  ['us-east', '`reports/export`', '8k', '1.9 s', '14 s', '29 s', '4.80%', '0%', 'reporting', '2026-10-02'],
  ['eu-west', '`auth/refresh`', '1.2M', '~6 ms', '19 ms', '44 ms', '0.00%', 'n/a', 'identity', '2026-11-21'],
]);
// stated alignment: the Effort column centred, Risk right, though neither is numbers
const LONG = table([
  ['Option', 'Effort', 'Risk', 'What it changes'],
  ['Background job', '3 days', 'Low', 'The button starts a job and the page says the file is on its way. When it is ready we email a link that works for 24 hours.'],
  ['Cap at 50k rows', '2 hours', 'High', 'Exports stop at 50,000 rows with a note saying so. It is the quickest change, but the teams that need it most have more rows.'],
], ['---', ':---:', '---:', '---']);
const TOKEN = '/Users/fixture/dev/demo/' + 'very-long-generated-folder-name-'.repeat(8) + 'end.txt';
const TEXT = `Here are last week's numbers for the busiest endpoints:\n\n${MAIN}\n\nThe log is at ${TOKEN}\n\nBy region:\n\n${WIDE}\n\nThree ways to fix the export:\n\n${LONG}`;

const c = await connect();
const { ev, check, until } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1500, deviceScaleFactor: 2, mobile: false });
await c.load(url + '#11111111', `__synopia.current()?.startsWith('11111111')`);
await ev(`(() => { const s = __synopia.cur(); __synopia.inject({ t: 'items', sid: s.id, agent: null, total: s.total + 1, upsert: [{ id: 'tbl-1', k: 'claude', ts: new Date().toISOString(), text: ${JSON.stringify(TEXT)} }] }); })()`);
check('the reply renders three tables', await until(`document.querySelectorAll('[data-key="tbl-1"] .md .tw > table').length === 3`));
await ev('document.fonts.ready.then(() => true)');
const B = `document.querySelector('[data-key="tbl-1"] .md')`;

// the viewport that makes the reply's text `w` px wide (the sidebar and rail keep their widths)
async function widthFor(w) {
  let vw = 1500;
  for (let i = 0; i < 4; i++) {
    const got = await ev(`${B}.getBoundingClientRect().width`);
    if (Math.abs(got - w) < 0.5) return got;
    vw = Math.round(vw + w - got);
    await c.cdp('Emulation.setDeviceMetricsOverride', { width: vw, height: 1500, deviceScaleFactor: 2, mobile: false });
    await until(`(() => { const r = ${B}.getBoundingClientRect().width; return Math.abs(r - ${w}) < 1 || ${i} > 2; })()`, 2000).catch(() => {});
  }
  return ev(`${B}.getBoundingClientRect().width`);
}

for (const w of [1000, 640]) {
  const got = await widthFor(w);
  check(`${w}: the reply is ${w}px wide`, Math.abs(got - w) < 1, got);
  // the fit runs on the log's resize; give it a frame
  await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const m = await ev(`(() => {
    const md = ${B}, mr = md.getBoundingClientRect(), log = document.getElementById('log');
    const lines = td => { const r = document.createRange(); r.selectNodeContents(td); return r.getBoundingClientRect().height / parseFloat(getComputedStyle(td).lineHeight); };
    const tables = [...md.querySelectorAll('.tw > table')].map(t => {
      const tds = [...t.querySelectorAll('tbody td')], short = tds.filter(td => td.matches('.num, .short'));
      const nums = tds.filter(td => td.matches('.num:not(.al, .ac)'));
      const rightGap = td => { const r = document.createRange(); r.selectNodeContents(td); const cs = getComputedStyle(td); return td.getBoundingClientRect().right - parseFloat(cs.paddingRight) - r.getBoundingClientRect().right; };
      const rows = [...t.tBodies[0].rows];
      return {
        broken: short.filter(td => lines(td) > 1.5).map(td => td.textContent),
        shortCells: short.length,
        numLeft: nums.filter(td => getComputedStyle(td).textAlign !== 'right' || Math.abs(rightGap(td)) > 1).map(td => td.textContent),
        nums: nums.length,
        sizes: [...new Set([...t.querySelectorAll('th, td')].map(e => getComputedStyle(e).fontSize))],
        rules: rows.slice(0, -1).every(r => [...r.cells].every(td => { const cs = getComputedStyle(td); return cs.borderBottomWidth === '1px' && cs.borderBottomStyle === 'solid'; })),
        lastRule: getComputedStyle(rows.at(-1).cells[0]).borderBottomWidth,
        boxRight: t.parentElement.getBoundingClientRect().right - mr.right,
        scrolls: t.parentElement.scrollWidth > t.parentElement.clientWidth + 1,
        scrollClass: t.parentElement.classList.contains('scrolls'),
        wrap1: t.classList.contains('wrap1'),
        aligns: [...t.tHead.rows[0].cells].map(th => getComputedStyle(th).textAlign),
        proseLines: Math.max(0, ...tds.filter(td => td.matches('.prose')).map(lines)),
      };
    });
    const p = [...md.querySelectorAll(':scope > p')].find(p => p.textContent.includes('very-long-generated'));
    const pr = p.getBoundingClientRect();
    return { tables, logOver: log.scrollWidth - log.clientWidth, token: { right: pr.right - mr.right, lines: lines(p) } };
  })()`);
  const [main, wide, long] = m.tables;
  m.tables.forEach((t, i) => {
    const n = ['endpoints', 'wide', 'long text'][i];
    check(`${w}, ${n}: no number or short cell on two lines`, t.broken.length === 0 && t.shortCells > 0, t.broken);
    check(`${w}, ${n}: the table is 11px`, t.sizes.length === 1 && t.sizes[0] === '11px', t.sizes);
    check(`${w}, ${n}: a 1px rule between rows, none under the last`, t.rules && t.lastRule === '0px', t.lastRule);
    check(`${w}, ${n}: the table stays inside the reply`, t.boxRight <= 0.5, t.boxRight);
  });
  check(`${w}: number cells align right to their column's edge`, main.numLeft.length === 0 && wide.numLeft.length === 0 && main.nums === 15 && wide.nums === 18, [main.numLeft, wide.numLeft, main.nums, wide.nums]);
  check(`${w}: number headers right, text headers left`, main.aligns.join() === 'left,right,right,right,left', main.aligns);
  check(`${w}: the separator row's colons win`, long.aligns.join() === 'left,center,right,left', long.aligns);
  check(`${w}: the long text column wraps`, long.proseLines > 1.5, long.proseLines);
  check(`${w}: the log never scrolls sideways`, m.logOver <= 0, m.logOver);
  check(`${w}: prose outside a table wraps a long token`, m.token.right <= 0.5 && m.token.lines > 1.5, m.token);
  if (w === 1000) check('1000: the endpoint table fits without wrapping its first column', !main.wrap1 && !main.scrolls, main);
  if (w === 640) {
    check('640: the endpoint table wraps its first column and does not scroll', main.wrap1 && !main.scrolls, main);
    check('640: the 10-column table scrolls in its own box', wide.scrolls && wide.scrollClass, wide);
  }
  await ev(`document.querySelector('[data-key="tbl-1"]').scrollIntoView({ block: 'start' })`);
  const clip = await ev(`(() => { const r = document.querySelector('[data-key="tbl-1"]').getBoundingClientRect(); return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 10), width: r.width + 32, height: Math.min(1480, r.height + 20) }; })()`);
  await shot(c, path.join(stateDir, `tables-${w}-${theme}.png`), clip);
}
c.print();
c.close();
