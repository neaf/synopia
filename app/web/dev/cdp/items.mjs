// Open items in the background panel (R7.1, R3.16, R10.1; FR-ITEM-03 to -05), on a made-up session whose main
// conversation Reads and Edits the ledger /tmp/synopia-items/shop/.ai-notes/checkout-m2/open-items.md (the format
// example, with one bad line and a review item that came over in a handoff), with a finished `For review: Receipt
// email copy` subagent and a running subagent whose brief owns Y5.
// Checks: the groups in order and their counts; solid id boxes; an option, Done and Object write their line into
// the box in insert mode and send nothing; Y5 under its subagent's card, "with <name>", not in its group; the line
// Synopia can't read; the handed-over review item with its id and Mark reviewed, a click only focusing it; Mark
// reviewed sends one `item` and the card leaves; J/K into the items, Enter and a click on an item's text going to the reply it
// came from, the sidebar line's click focusing the first item, an item with no reply only focused (R9.1, FR-ITEM-07);
// a rewritten ledger shows within 3 s; an item Synopia found has a dashed box and "found by Synopia", `d` on it
// sends `notItem` and it moves to Closed this turn with Undo, which sends `undo` and brings it back (FR-ITEM-10);
// shots light and dark.
// usage: node items.mjs make <claude-dir>   writes the tree, the script and the ledger (run.sh does this first)
//        node items.mjs <url> <state-dir>   writes items-light.png and items-dark.png
import fs from 'node:fs';
import path from 'node:path';
import { records, writeScript, line, spySent, keyTable, shot as shotTo, elsewhere } from './helpers.mjs';

const S = 'e1e1e1e1-0000-4000-8000-0000000000e1';
const CWD = '/tmp/synopia-items/shop';
const LEDGER = `${CWD}/.ai-notes/checkout-m2/open-items.md`;
const RCPT = 'eeee0001', REBASE = 'eeee0002';
const now0 = Date.now();
const ts = (s) => new Date(now0 - 10 * 60_000 + s * 1000).toISOString(); // the turn began 10 min ago
const two = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
// the format example (docs/Open items.md, checkout-m2.md), stamped from now, with one wrapped line and a handed-over review item
export const ledger = (extra = '') => `# Open items: checkout-m2

<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. Don't edit by hand; say it in the session instead. -->

## Waiting on you

- [ ] Y1 · decision · Run \`bin/schema-lint --fix\` now, or look at the 14 warnings first?
  - options: Run it | Look first
  - recommended: Look first
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}, "Should I run \`bin/schema-lint --fix\`"
- [ ] Y2 · your task · Answer the 2 review threads from Mira on #812.
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}
- [ ] Y4 · default · Mark #812 to #815 ready in this order: #812, #814, #813, #815.
  - goes ahead: when CI is green on all four, unless you object
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}
- [ ] Y5 · decision · Can I remove the worktrees ~/dev/shop-wt-cart and ~/dev/shop-wt-tax?
  - options: Remove both | Keep them
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}, "Can I remove these two worktrees"
- [ ] Y9 · review · Review: Pricing page copy
  - subagent: Pricing page copy
  - from: Claude, "Ship checkout M1", ${stamp(now0 - 26 * 3600_000)}
- Y8 ask Mira about the refund flow??
${extra}
## Claude will check

- [ ] A1 · follow-up · Re-check #820, which GitHub shows as conflicting.
  - trigger: after the M2 stack merges
  - from: Claude, "Ship checkout M2", ${stamp(now0 - 4 * 60_000)}

## Closed

- [x] Y3 · answered ${stamp(now0 - 2 * 60_000)} · "Run it" · done: 14 entries added to the todo file
- [-] Y6 · dropped ${stamp(now0 - 60_000)} · #818 was closed
- [>] Y7 · superseded by Y5 · ${stamp(now0 - 26 * 3600_000)}
`;

if (process.argv[2] === 'make') {
  const claudeDir = process.argv[3];
  const dir = path.join(claudeDir, 'projects', '-tmp-synopia-items-shop'), sub = path.join(dir, S, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, ledger());
  elsewhere(claudeDir, 7109, S, CWD); // the other process its running subagent lives in
  const R = records(CWD, ts), rec = (o) => R.rec(S, o), you = (u, s, t) => R.you(S, u, s, t), said = (u, s, t) => R.said(S, u, s, t), tool = (u, s, id, n, i) => R.tool(S, u, s, id, n, i);
  const result = (u, s, tid, content, extra = {}) => rec({ type: 'user', uuid: u, timestamp: ts(s), ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] } });
  const agent = (u, s, tid, description, prompt) => tool(u, s, tid, 'Agent', { description, subagent_type: 'general-purpose', prompt, run_in_background: true });
  const launched = (u, s, tid, id, d) => result(u, s, tid, 'Async agent launched successfully.', { toolUseResult: { status: 'async_launched', agentId: id, description: d, prompt: 'made-up', outputFile: '/tmp/o' } });
  fs.writeFileSync(path.join(dir, `${S}.jsonl`),
    you('i-u1', 0, 'Rebase the M2 stack on main and push. Tell me what is left for me.')
    + tool('i-a1', 20, 'toolu_ir', 'Read', { file_path: LEDGER }) + result('i-r1', 21, 'toolu_ir', '# Open items: checkout-m2')
    + tool('i-a2', 40, 'toolu_ie', 'Edit', { file_path: LEDGER, old_string: '## Claude will check', new_string: '## Claude will check' }) + result('i-r2', 41, 'toolu_ie', 'The file has been updated.')
    + said('i-a3', 300, 'Rebased #812 to #823 on main and pushed. Should I run `bin/schema-lint --fix` now, or look at the 14 warnings first? Can I remove these two worktrees? They are both merged.')
    + agent('i-a4', 320, 'toolu_ia1', 'For review: Receipt email copy', 'Draft the receipt email copy.') + launched('i-r4', 321, 'toolu_ia1', RCPT, 'Receipt email copy')
    + agent('i-a5', 330, 'toolu_ia2', 'Rebase #820 on main', 'Rebase #820 on main and push.\nOpen items: Y5 (remove the worktrees once #820 is rebased)') + launched('i-r5', 331, 'toolu_ia2', REBASE, 'Rebase #820 on main')
    + rec({ type: 'user', uuid: 'i-rp', timestamp: ts(420), isMeta: true, message: { role: 'user', content: `Another Claude session sent a message.\n<agent-message from="${RCPT}">\nThe report follows:\n  The receipt email copy is in receipt.md.\n</agent-message>` } }));
  const sc = (id, o) => line({ ...o, isSidechain: true, agentId: id, cwd: CWD, sessionId: S });
  fs.writeFileSync(path.join(sub, `agent-${RCPT}.jsonl`), sc(RCPT, { type: 'user', uuid: 'rc-u1', timestamp: ts(321), message: { role: 'user', content: 'Draft the receipt email copy.' } })
    + sc(RCPT, { type: 'assistant', uuid: 'rc-a1', timestamp: ts(400), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }));
  fs.writeFileSync(path.join(sub, `agent-${RCPT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'For review: Receipt email copy', toolUseId: 'toolu_ia1', spawnDepth: 1, finished: true }));
  fs.writeFileSync(path.join(sub, `agent-${REBASE}.jsonl`), sc(REBASE, { type: 'user', uuid: 'rb-u1', timestamp: ts(331), message: { role: 'user', content: 'Rebase #820 on main and push.' } })
    + sc(REBASE, { type: 'assistant', uuid: 'rb-a1', timestamp: ts(560), message: { role: 'assistant', content: [{ type: 'text', text: 'Rebasing.' }] } }));
  fs.writeFileSync(path.join(sub, `agent-${REBASE}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Rebase #820 on main', toolUseId: 'toolu_ia2', spawnDepth: 1, finished: false }));
  writeScript(claudeDir, 'items.mjs: made up', { [S]: { state: { status: 'idle', ago: 60_000 } } });
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
await c.load(`${url}#${S.slice(0, 8)}`, `__synopia.current() === '${S}' && !!document.querySelector('.rail .oi-wait') && document.querySelectorAll('.rail .rv').length === 2`);
const shot = (name) => shotTo(c, `${stateDir}/${name}.png`);
const J = (expr) => ev(`JSON.stringify(${expr})`).then(JSON.parse);

// ---------- the groups ----------
const groups = await J(`[...document.querySelectorAll('.rail .rail-mid > *, .rail > .past')].map(g => [g.querySelector('h3')?.firstChild?.textContent.trim() || '', g.querySelector('h3 .cnt')?.textContent || ''])`);
check('the groups in order with their counts: To review 2, Waiting on you 3, Claude will check 1, Closed this turn 2', JSON.stringify(groups.slice(0, 4)) === JSON.stringify([['To review', '2'], ['Waiting on you', '3'], ['Claude will check', '1'], ['Closed this turn', '2']]), JSON.stringify(groups));
const wait = await J(`[...document.querySelectorAll('.rail .oi-wait .oi[data-oi]')].map(e => [e.dataset.oi, e.querySelector('.oi-k').textContent])`);
check('Waiting on you: Y1 decision, Y2 your task, Y4 default; no review item', JSON.stringify(wait) === JSON.stringify([['Y1', 'decision'], ['Y2', 'your task'], ['Y4', 'default']]), JSON.stringify(wait));
const ids = await J(`[...document.querySelectorAll('.rail .oi-id:not(.q)')].map(e => { const s = getComputedStyle(e); return s.borderTopStyle + ' ' + s.borderTopWidth; })`);
check('every id box is solid and 1px', ids.length >= 8 && ids.every((b) => b === 'solid 1px'), JSON.stringify(ids));
const y1 = await J(`(e => ({ chips: [...e.querySelectorAll('.oi-chip')].map(b => b.textContent), code: !!e.querySelector('.oi-t code'), age: e.querySelector('.oi-age').textContent }))(document.querySelector('.rail .oi[data-oi="Y1"]'))`);
check('a decision: its options as buttons, the recommended one marked, code as code, its age', JSON.stringify(y1.chips) === JSON.stringify(['Run it', 'Look firstRecommended']) && y1.code && /^\d+ min$/.test(y1.age), JSON.stringify(y1));
const y4 = await ev(`document.querySelector('.rail .oi[data-oi="Y4"] .oi-w')?.textContent || ''`);
check('a default says when it goes ahead', y4 === 'Goes ahead when CI is green on all four, unless you object', y4);
const a1 = await ev(`document.querySelector('.rail .oi-check .oi-fu[data-oi="A1"]')?.textContent || ''`);
check('Claude will check: A1 with its trigger', a1.includes('A1') && a1.includes('after the M2 stack merges'), a1);
const closed = await J(`[...document.querySelectorAll('.rail .oi-closed .oi-cl .n')].map(e => e.textContent)`);
check('Closed this turn: dim lines with what closed them', JSON.stringify(closed) === JSON.stringify(['Y3Answered: "Run it" · done: 14 entries added to the todo file', 'Y6Dropped: #818 was closed']), JSON.stringify(closed));
const bad = await ev(`document.querySelector('.rail .oi-wait .oi.bad')?.textContent || ''`);
check('the line Synopia can\'t read', bad === "?1 line Synopia can't read, in open-items.md", bad);

// ---------- the sidebar's line (R4.2, FR-ITEM-06) ----------
const side = await J(`(l => l ? { text: l.textContent.trim(), after: l.previousElementSibling?.dataset.line, still: (l.querySelector('.ind')?.getAnimations({ subtree: true }) || []).length === 0, ring: !!l.querySelector('.ind.o-open circle') } : null)(document.querySelector('#groups .row[data-id="${S}"] [data-line="waiting"]'))`);
check('the sidebar: "○ 4 waiting on you" under "2 to review", its hollow circle still (open Y items, review items aside, the owned Y5 counted)', !!side && side.text === '4 waiting on you' && side.after === 'review' && side.still && side.ring, JSON.stringify(side));

// ---------- a subagent's item under its card ----------
const owned = await J(`(k => k ? { on: k.querySelector('.oi-on')?.textContent || '', moves: (k.querySelector('.oi-on .ind')?.getAnimations({ subtree: true }) || []).filter(a => a.playState === 'running').length } : null)(document.querySelector('.rail .kid:has(.card[data-agent="${REBASE}"])'))`);
check('Y5 shows under its subagent\'s card, "with <name>", with the moving mark', !!owned && owned.on.startsWith('Y5') && owned.on.endsWith('with Rebase #820 on main') && owned.moves > 0, JSON.stringify(owned));
check('Y5 is not in Waiting on you while the subagent holds it', !wait.some(([id]) => id === 'Y5'));

// ---------- To review ----------
const rv = await J(`[...document.querySelectorAll('.rail .rv')].map(e => ({ id: e.dataset.oi, n: e.querySelector('.n').textContent, agent: e.querySelector('.rv-open').dataset.agent || null, done: !!e.querySelector('[data-reviewed]') }))`);
const handed = rv.find((r) => r.id === 'Y9'), mine = rv.find((r) => r.agent === RCPT);
check('To review: the handed-over review item with its id box and Mark reviewed, no report to go to', !!handed && handed.n === 'Y9Pricing page copy' && handed.agent === null && handed.done, JSON.stringify(rv));
check('To review: the finished For review subagent\'s item, with its id box', !!mine && /^Y\d+Receipt email copy$/.test(mine.n) && mine.done, JSON.stringify(rv));
let sent = await spySent(c);
await ev(`document.querySelector('.rail .rv[data-oi="Y9"] .rv-open .n').click()`); await sleep(200);
const after = await J(`({ view: __synopia.view(), focus: document.querySelector('.rail .rv[data-oi="Y9"]').classList.contains('focus'), sent: __synopia.sent().length })`);
check('a click on the handed-over card only focuses it: the same view, nothing sent', after.view === null && after.focus && after.sent === 0, JSON.stringify(after));

// ---------- the buttons write into the box and send nothing ----------
await ev(`(m => { m.value = 'About the stack:'; m.dispatchEvent(new Event('input')); })(document.getElementById('msg'))`);
sent = await spySent(c);
await ev(`[...document.querySelectorAll('.rail .oi[data-oi="Y1"] .oi-chip')].find(b => b.textContent.startsWith('Run it')).click()`); await sleep(100);
let box = await J(`({ v: document.getElementById('msg').value, mode: __synopia.mode(), focus: document.activeElement?.id })`);
check('an option writes "Y1 Run it" on a new line of the box, in insert mode', box.v === 'About the stack:\nY1 Run it' && box.mode === 'insert' && box.focus === 'msg', JSON.stringify(box));
await ev(`document.querySelector('.rail .oi[data-oi="Y2"] .oi-chip').click()`); await sleep(50);
await ev(`document.querySelector('.rail .oi[data-oi="Y4"] .oi-chip').click()`); await sleep(50);
box = await J(`({ v: document.getElementById('msg').value, mode: __synopia.mode() })`);
check('Done writes "Y2 done" and Object "Y4 wait: ", each on a new line', box.v === 'About the stack:\nY1 Run it\nY2 done\nY4 wait: ' && box.mode === 'insert', JSON.stringify(box));
check('the buttons send nothing', (await ev(`__synopia.sent('send', 'item', 'sendNow').length`)) === 0);
await ev(`(m => { m.value = ''; m.dispatchEvent(new Event('input')); m.blur(); })(document.getElementById('msg'))`);
await c.key('Escape', { vk: 27 });

// ---------- shots, light and dark ----------
const railClip = () => J(`(r => ({ x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 860) }))(document.querySelector('.rail').getBoundingClientRect())`);
await sleep(300);
await shot('items-light');
await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await c.until(`document.documentElement.dataset.theme === 'dark'`, 2000);
await sleep(300);
const darkBg = await J(`[...document.querySelectorAll('.rail .oi, .rail .oi-chip, .rail .rv')].map(e => getComputedStyle(e).backgroundColor).filter(b => { const [r, g, bl] = b.match(/[\\d.]+/g).map(Number); return (r + g + bl) / 3 > 110; })`);
check('dark: no item, button or review card keeps a light background', darkBg.length === 0, JSON.stringify(darkBg));
await shotTo(c, `${stateDir}/items-dark.png`, await railClip());
await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// ---------- Mark reviewed ----------
sent = await spySent(c);
await ev(`document.querySelector('.rail .rv[data-oi="Y9"] [data-reviewed]').click()`);
check('Mark reviewed: the card leaves', await c.until(`!document.querySelector('.rail .rv[data-oi="Y9"]') && document.querySelectorAll('.rail .rv').length === 1`, 5000));
const marks = await sent('item');
check('Mark reviewed sends one item act, by the item\'s id', marks.length === 1 && marks[0].item === 'Y9' && marks[0].act === 'reviewed', JSON.stringify(marks));

// ---------- focus, J/K into the items, Enter and a click to the reply it came from (R9.1, FR-ITEM-07) ----------
const K = keyTable(c.key);
const REPLY = 'i-a3:0'; // Claude's reply that asks Y1 and Y5: its block key
const at = () => J(`({ view: __synopia.view(), focus: document.querySelector('.rail [data-oi].focus')?.dataset.oi || null, mark: document.querySelector('#log .jump-mark')?.dataset.key || null })`);
const reply = (id) => ev(`__synopia.cur().openItems.items.find(i => i.id === '${id}')?.reply || null`);
check('the backend puts the reply each item came from in it: the quote for Y1, the minute for Y2', (await reply('Y1')) === REPLY && (await reply('Y2')) === REPLY, JSON.stringify([await reply('Y1'), await reply('Y2')]));
await ev(`document.querySelector('.rail [data-back-main]').click()`); await sleep(200);
await K.K(); await sleep(150);
let p = await at();
check('K from Main conversation focuses the last Waiting on you item, Main conversation still shown', p.view === null && p.focus === 'Y4', JSON.stringify(p));
await K.J(); await sleep(150);
p = await at();
check('J past the last item wraps to Main conversation, no item focused', p.view === null && p.focus === null, JSON.stringify(p));
await K.J(); await sleep(250); const v1 = (await at()).view;
await K.J(); await sleep(250); const v2 = (await at()).view;
await K.J(); await c.until(`__synopia.view() === null && !!document.querySelector('.rail .oi.focus')`, 3000);
p = await at();
check('J goes through the cards (the subagent, the To review card), then on to the first item', v1 === REBASE && v2 === RCPT && p.view === null && p.focus === 'Y1', JSON.stringify({ v1, v2, p }));
await K.enter();
check('Enter on the focused item scrolls Main conversation to its reply and marks it', await c.until(`!!document.querySelector('#log [data-key="${REPLY}"].jump-mark')`, 5000), JSON.stringify(await at()));
await c.until(`!document.querySelector('#log .jump-mark')`, 4000);
await ev(`document.querySelector('.rail .oi[data-oi="Y2"] .oi-t').click()`);
check('a click on an item\'s text focuses it and jumps to its reply', await c.until(`!!document.querySelector('#log [data-key="${REPLY}"].jump-mark') && document.querySelector('.rail .oi.focus')?.dataset.oi === 'Y2'`, 5000), JSON.stringify(await at()));
await ev(`document.querySelector('#groups .row[data-id="${S}"] [data-line="waiting"]').click()`); await sleep(300);
p = await at();
check('a click on the sidebar\'s line opens the session with its first Waiting on you item focused', p.view === null && p.focus === 'Y1', JSON.stringify(p));

// ---------- the ledger changes: the panel follows ----------
fs.writeFileSync(LEDGER, ledger().replace('- Y8 ask Mira about the refund flow??\n', '').replace('## Claude will check', `- [ ] Y11 · your task · Approve the copy change on the receipt email.\n  - from: Claude, "Ship checkout M2", ${stamp(now0 - 2 * 86400_000)}\n\n## Claude will check`));
const t0 = Date.now();
const follows = await c.until(`!!document.querySelector('.rail .oi[data-oi="Y11"]') && !document.querySelector('.rail .oi.bad')`, 3000);
check('a rewritten ledger shows in the panel within 3 s', follows, `${Date.now() - t0} ms`);
check('the sidebar line follows: 5 waiting on you', await c.until(`(document.querySelector('#groups .row[data-id="${S}"] [data-line="waiting"]')?.textContent || '').trim() === '5 waiting on you'`, 3000));
await c.until(`!document.querySelector('#log .jump-mark')`, 4000);
const top = await ev(`document.getElementById('log').scrollTop`);
await ev(`document.querySelector('.rail .oi[data-oi="Y11"] .oi-t').click()`); await sleep(400);
p = await at();
check('an item with no reply in this transcript: a click only focuses it', (await reply('Y11')) === null && p.focus === 'Y11' && p.mark === null && p.view === null && (await ev(`document.getElementById('log').scrollTop`)) === top, JSON.stringify(p));

// ---------- found by Synopia, d and Undo (R7.1, R9.1, FR-ITEM-10) ----------
fs.writeFileSync(LEDGER, ledger().replace('- Y8 ask Mira about the refund flow??\n', '').replace('## Claude will check', `- [ ] Y12 · decision · Should the tax table be cached per request?\n  - from: Synopia, "Ship checkout M2", ${stamp(now0 - 60_000)}, "Should the tax table be cached"\n\n## Claude will check`));
await c.until(`!!document.querySelector('.rail .oi[data-oi="Y12"]')`, 3000);
const y12 = await J(`(e => e && { box: getComputedStyle(e.querySelector('.oi-id')).borderTopStyle, k: e.querySelector('.oi-k').textContent })(document.querySelector('.rail .oi[data-oi="Y12"]'))`);
check('an item Synopia found: a dashed id box and "found by Synopia"', !!y12 && y12.box === 'dashed' && y12.k === 'decision, found by Synopia', JSON.stringify(y12));
sent = await spySent(c);
await ev(`document.querySelector('.rail .oi[data-oi="Y12"] .oi-k').click()`); await sleep(150);
await K.d();
const gone = await c.until(`!document.querySelector('.rail .oi-wait .oi[data-oi="Y12"]') && !!document.querySelector('.rail .oi-closed [data-oi-undo="Y12"]')`, 5000);
const dn = await sent('item');
check('d on the focused item sends notItem; it moves to Closed this turn with Undo', gone && dn.length === 1 && dn[0].item === 'Y12' && dn[0].act === 'notItem', JSON.stringify(dn));
const cl = await J(`(e => ({ text: e.querySelector('.n').textContent, box: getComputedStyle(e.querySelector('.oi-id')).borderTopStyle }))(document.querySelector('.rail .oi-closed [data-oi-undo="Y12"]').closest('.oi-cl'))`);
check('its closed line: "Not an item: you said so", still dashed', cl.text === 'Y12Not an item: you said so' && cl.box === 'dashed', JSON.stringify(cl));
await ev(`document.querySelector('.rail [data-oi-undo="Y12"]').click()`);
const back = await c.until(`!!document.querySelector('.rail .oi-wait .oi[data-oi="Y12"]') && !document.querySelector('.rail [data-oi-undo="Y12"]')`, 5000);
const un = (await sent('item')).filter((m) => m.act === 'undo');
check('Undo sends undo and the item comes back', back && un.length === 1 && un[0].item === 'Y12', JSON.stringify(un));
c.print();
c.close();
