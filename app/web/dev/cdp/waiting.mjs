// The Waiting on you list (R9.10, FR-ITEM-13) on made-up sessions and ledgers: "Ship checkout M2" and "Checkout
// follow-ups" share the ledger /tmp/synopia-waiting/shop/.ai-notes/checkout-m2/open-items.md (the second read it
// last, so it counts it), "Norway tax rates" has its own in /tmp/synopia-waiting/tax, "Release notes" has none.
// Checks: the head's "○ 4 waiting on you" button (the shared ledger once); w opens the list over the main area with
// every open Y item grouped by session in sidebar order, an answered and a `later` item left out, each row with its
// id box, kind and age; j/k and the arrows move and wrap; typing filters on the text, the id and the session title,
// marking the letters; a reload keeps the list and its filter; Enter opens the session with `Y2 ` in its box in insert
// mode, the item focused in the panel, nothing sent; Esc closes; the button opens it and a click outside closes it;
// in insert mode w types. Shots light and dark.
// usage: node waiting.mjs make <claude-dir>   writes the tree, the script and the ledgers (run.sh does this first)
//        node waiting.mjs <url> <state-dir>   writes waiting-light.png and waiting-dark.png
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, spySent, keyTable, shot as shotTo } from './helpers.mjs';

const S1 = 'f1f1f1f1-0000-4000-8000-0000000000f1', S2 = 'f2f2f2f2-0000-4000-8000-0000000000f2';
const S3 = 'f3f3f3f3-0000-4000-8000-0000000000f3', S4 = 'f4f4f4f4-0000-4000-8000-0000000000f4';
const SHOP = '/tmp/synopia-waiting/shop', TAX = '/tmp/synopia-waiting/tax';
const LA = `${SHOP}/.ai-notes/checkout-m2/open-items.md`, LB = `${TAX}/.ai-notes/tax-rates/open-items.md`;
const now0 = Date.now();
const ts = (s) => new Date(now0 - 10 * 60_000 + s * 1000).toISOString(); // the sessions began 10 min ago
const two = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const head = (area) => `# Open items: ${area}\n\n<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. Don't edit by hand; say it in the session instead. -->\n\n## Waiting on you\n\n`;
const ledgerA = head('checkout-m2') + `- [ ] Y1 · decision · Run \`bin/schema-lint --fix\` now, or look at the 14 warnings first?
  - options: Run it | Look first
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}
- [ ] Y2 · your task · Answer the 2 review threads from Mira on #812.
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}
- [ ] Y3 · decision · Squash the fixup commits before the merge?
  - state: answered
  - answer: Yes
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 6 * 60_000)}
- [ ] Y4 · your task · Tell support about the new receipt email.
  - state: later
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 6 * 60_000)}

## Claude will check

## Closed
`;
const ledgerB = head('tax-rates') + `- [ ] Y2 · decision · Round per line or per invoice?
  - options: Per line | Per invoice
  - recommended: Per invoice
  - from: Claude, "Norway tax rates", ${stamp(now0 - 62 * 60_000)}
- [ ] Y3 · your task · Ask finance for the 2027 reduced rate.
  - from: Claude, "Norway tax rates", ${stamp(now0 - 120 * 60_000)}

## Claude will check

## Closed
`;

if (process.argv[2] === 'make') {
  const claudeDir = process.argv[3];
  fs.mkdirSync(path.dirname(LA), { recursive: true }); fs.mkdirSync(path.dirname(LB), { recursive: true });
  fs.writeFileSync(LA, ledgerA); fs.writeFileSync(LB, ledgerB);
  const session = (sid, cwd, title, ask, ledger, at) => {
    const R = records(cwd, ts), dir = path.join(claudeDir, 'projects', cwd.replace(/[/.]/g, '-'));
    const rec = (o) => R.rec(sid, o), id = `toolu_${sid.slice(0, 4)}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), R.you(sid, `${sid}-u1`, 0, ask) + rec({ type: 'ai-title', aiTitle: title })
      + (ledger ? R.tool(sid, `${sid}-a1`, at, id, 'Read', { file_path: ledger })
        + rec({ type: 'user', uuid: `${sid}-r1`, timestamp: ts(at + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '# Open items' }] } }) : '')
      + R.said(sid, `${sid}-a2`, at + 30, 'Done. The open items are in the panel.')
      + rec({ type: 'system', subtype: 'turn_duration', durationMs: (at + 30) * 1000, timestamp: ts(at + 31) })); // the turn ended: your turn
  };
  session(S1, SHOP, 'Ship checkout M2', 'Rebase the M2 stack on main.', LA, 20);
  session(S2, SHOP, 'Checkout follow-ups', 'Pick up the checkout follow-ups.', LA, 200); // read it last: it counts the shared list
  session(S3, TAX, 'Norway tax rates', 'Update the Norway tax rates.', LB, 100);
  session(S4, SHOP, 'Release notes', 'Draft the release notes.', null, 50);
  const idle = { state: { status: 'idle', ago: 60_000 } };
  writeScript(claudeDir, 'waiting.mjs: made up', { [S1]: idle, [S2]: idle, [S3]: idle, [S4]: idle });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, until, key } = c;
const K = keyTable(key);
const J = (expr) => ev(`JSON.stringify(${expr})`).then(JSON.parse);
const shot = (name) => shotTo(c, `${stateDir}/${name}.png`);
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
const COUNTED = `(() => { const d = __synopia.data(), w = id => d.find(s => s.id === id)?.state.waiting; return w('${S2}') === 2 && w('${S3}') === 2 && w('${S1}') === 0; })()`;
await c.load(`${url}#${S4.slice(0, 8)}`, COUNTED, 20_000);
const WL = () => J(`__synopia.waitingList()`);
const ROWS = (r) => r.rows.map((x) => `${x.sid.slice(0, 2)}:${x.id}`).join(' ');

// ---------- the head's button ----------
const btn = await J(`(b => ({ hidden: b.hidden, text: b.textContent.trim(), ring: !!b.querySelector('.ind.o-open circle'), inHead: !!b.closest('.side-head'), line: getComputedStyle(b).borderTopWidth }))(document.getElementById('waiting'))`);
check('the head: "○ 4 waiting on you", the hollow circle, a 1px line; the shared ledger counts once', !btn.hidden && btn.text === '4 waiting on you' && btn.ring && btn.inHead && btn.line === '1px', JSON.stringify(btn));

// ---------- w opens the list ----------
await K.w();
check('w opens the list over the main area, the filter focused, normal mode', await until(`__synopia.waitingList().shown && document.activeElement.id === 'wl-filter' && __synopia.mode() === 'normal'`, 2000));
let wl = await WL();
check('every open Y item in sidebar order, under the session that counts the ledger; answered and later left out', ROWS(wl) === 'f2:Y1 f2:Y2 f3:Y2 f3:Y3', ROWS(wl));
const groups = await J(`[...document.querySelectorAll('#wl-list .wl-h')].map(h => h.textContent)`);
check('grouped by session: its title and state words', groups.length === 2 && /^Checkout follow-upsYour turn, /.test(groups[0]) && /^Norway tax ratesYour turn, /.test(groups[1]), JSON.stringify(groups));
check('the header says how many, in how many sessions', (await ev(`document.getElementById('wl-meta').textContent`)) === '4 items in 2 sessions, in sidebar order.');
const row = await J(`(r => ({ id: r.querySelector('.oi-id').textContent, box: getComputedStyle(r.querySelector('.oi-id')).borderTopStyle, t: r.querySelector('.x-t').textContent, f: r.querySelector('.f').textContent, a: r.querySelector('.a').textContent, sel: r.getAttribute('aria-selected') }))(document.querySelector('#wl-list .ol-it'))`);
check('a row: its solid id box, its text (code as plain text), its kind and age; the first selected', row.id === 'Y1' && row.box === 'solid' && row.t === 'Run bin/schema-lint --fix now, or look at the 14 warnings first?' && row.f === 'decision' && /^\d+ min$/.test(row.a) && row.sel === 'true', JSON.stringify(row));
await shot('waiting-light');

// ---------- moving ----------
const selIs = (k) => until(`__synopia.waitingList().sel === ${JSON.stringify(k)} && document.querySelector('#wl-list [aria-selected="true"]')?.dataset.oi === ${JSON.stringify(k.split('\n')[1])}`, 1000);
await K.j();
check('j moves down', await selIs(`${S2}\nY2`));
await K.down(); await K.down();
check('↓ moves on, across sessions', await selIs(`${S3}\nY3`));
await K.j();
check('past the last it wraps to the first', await selIs(`${S2}\nY1`));
await K.k();
check('k from the first wraps to the last', await selIs(`${S3}\nY3`));
await K.up();
check('↑ moves up', await selIs(`${S3}\nY2`));

// ---------- typing filters ----------
for (const ch of 'invoice') await key(ch, { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) });
wl = await WL();
check('typing filters on the item\'s text', wl.filter === 'invoice' && ROWS(wl) === 'f3:Y2', ROWS(wl));
check('the matched letters are marked', (await ev(`[...document.querySelectorAll('#wl-list .ol-it b.m')].map(b => b.textContent).join('')`)) === 'invoice');
await ev(`(i => { i.value = 'norway'; i.dispatchEvent(new Event('input')); })(document.getElementById('wl-filter'))`);
check('on the session title', ROWS(await WL()) === 'f3:Y2 f3:Y3', ROWS(await WL()));
await ev(`(i => { i.value = 'y1'; i.dispatchEvent(new Event('input')); })(document.getElementById('wl-filter'))`);
check('on the id', (await WL()).rows[0]?.id === 'Y1' && (await WL()).rows[0]?.sid === S2, ROWS(await WL()));
await ev(`(i => { i.value = 'zzqx'; i.dispatchEvent(new Event('input')); })(document.getElementById('wl-filter'))`);
check('nothing matches: it says so', (await ev(`document.querySelector('#wl-list .ol-empty')?.textContent`)) === 'No item matches “zzqx”.');
await ev(`(i => { i.value = 'norway'; i.dispatchEvent(new Event('input')); })(document.getElementById('wl-filter'))`);

// ---------- a reload keeps it ----------
const stored = () => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).ui?.waitingList ?? null; } catch { return 'unread'; } };
let ok = false; for (let t = 0; t < 40 && !ok; t++) { ok = JSON.stringify(stored()) === '{"filter":"norway"}'; if (!ok) await sleep(100); }
check('the list and its filter are stored with the UI state', ok, JSON.stringify(stored()));
await c.load(`${url}#${S4.slice(0, 8)}`, `${COUNTED} && __synopia.waitingList().shown`, 20_000);
wl = await WL();
check('after a reload: the list is back, with its filter and rows', wl.shown && wl.filter === 'norway' && ROWS(wl) === 'f3:Y2 f3:Y3' && (await ev(`document.getElementById('wl-filter').value`)) === 'norway', JSON.stringify(wl));

// ---------- Enter ----------
const sent = await spySent(c);
await K.enter();
check('Enter closes the list and opens that session', await until(`!__synopia.waitingList().shown && __synopia.current() === '${S3}'`, 2000), JSON.stringify(await WL()));
check('its box holds "Y2 ", in insert mode, the cursor at its end', await until(`document.getElementById('msg')?.value === 'Y2 ' && __synopia.mode() === 'insert' && document.activeElement.id === 'msg' && document.getElementById('msg').selectionStart === 3`, 2000), await ev(`JSON.stringify({ v: document.getElementById('msg')?.value, m: __synopia.mode() })`));
check('the item is focused in the panel', await until(`!!document.querySelector('.rail .oi.focus[data-oi="Y2"]')`, 2000));
check('nothing was sent', (await sent('send', 'item')).length === 0, JSON.stringify(await sent()));
await ev(`(m => { m.value = ''; m.dispatchEvent(new Event('input')); })(document.getElementById('msg'))`);

// ---------- insert mode types w; Esc closes the list ----------
await key('w', { code: 'KeyW', vk: 87 });
check('in insert mode w types into the box', (await ev(`document.getElementById('msg').value`)) === 'w' && !(await WL()).shown);
await ev(`(m => { m.value = ''; m.dispatchEvent(new Event('input')); })(document.getElementById('msg'))`);
await K.esc();
await K.w();
check('w opens it again, its filter empty', await until(`__synopia.waitingList().shown && __synopia.waitingList().filter === ''`, 2000));
await K.esc();
check('Esc closes it', await until(`!__synopia.waitingList().shown`, 1000));

// ---------- the button; a click outside ----------
await ev(`document.getElementById('waiting').click()`);
check('the head button opens it', await until(`__synopia.waitingList().shown`, 1000));
const out = await J(`(r => ({ x: r.x + 20, y: r.bottom - 20 }))(document.querySelector('.side').getBoundingClientRect())`);
await c.mouse('mousePressed', out.x, out.y); await c.mouse('mouseReleased', out.x, out.y);
check('a click outside closes it', await until(`!__synopia.waitingList().shown`, 1000));

// ---------- dark ----------
await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await until(`document.documentElement.dataset.theme === 'dark'`, 2000);
await K.w(); await until(`__synopia.waitingList().shown`, 1000); await K.j();
const dark = await J(`(() => { const p = getComputedStyle(document.querySelector('#waiting-list .ol-panel')).backgroundColor, s = getComputedStyle(document.querySelector('#wl-list [aria-selected="true"]')).backgroundColor; return { p, s }; })()`);
const light = (rgb) => { const m = /(\d+), (\d+), (\d+)/.exec(rgb); return !!m && (+m[1] + +m[2] + +m[3]) / 3 > 128; };
check('dark: the list and its selection on dark surfaces', !light(dark.p) && !light(dark.s), JSON.stringify(dark));
await shot('waiting-dark');
c.print();
c.close();
