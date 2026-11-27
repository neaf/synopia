// The background panel's tree (R7.1) on the rail fixture: Main conversation with its running children, a
// subagent's own shells and monitors one level deeper, guides on every mark, the corner on each last child,
// opening a subagent moving nothing, Past naming the subagent, and none of them on the main side. Then a shell
// or monitor opened in the pane as a subagent is (R7.2): its header, its whole output, live, earlier output,
// J/K, back to Main conversation, kept over a reload. Then "To review" cards (R7.1) on a made-up session: a click or
// Enter goes to the subagent's report in Main conversation (earlier pages loaded, near the top, marked, kept over a
// reload), "Mark reviewed" only marks, no report falls back to the subagent's view.
// usage: run.sh rail (or node rail.mjs <url> <state-dir>); writes rail-tree.png, rail-open.png, rail-shell-*.png
//        node rail.mjs make <claude-dir> <tasks-dir>: the shells' made-up output files, named in the copied transcripts
import fs from 'node:fs';
import path from 'node:path';
import { shot as shotTo, spySent, outPanel, elsewhere } from './helpers.mjs';
import { connect, sleep } from './cdp.mjs';
const RV = '77777777-0000-4000-8000-000000000007';
// a background subagent waiting on its own background work (docs/Claude Code transcripts.md, made up)
const WT = '88888888-0000-4000-8000-000000000008', WA = 'dddd0001';
const wj = (o) => JSON.stringify(o) + '\n', wat = (n) => new Date(Date.UTC(2026, 10, 20, 15, 0, 0) + n * 60_000).toISOString();
const wnote = (n, summary, result) => wj({ type: 'user', uuid: `wt-n${n}`, timestamp: wat(n), origin: { kind: 'task-notification' }, message: { role: 'user', content:
  `<task-notification>\n<task-id>${WA}</task-id>\n<tool-use-id>toolu_dag</tool-use-id>\n<status>completed</status>\n<summary>Agent "Run the page bench" ${summary}</summary>\n<note>made up</note>\n<result>${result}</result>\n</task-notification>` } });
const wsc = (o) => wj({ ...o, isSidechain: true, agentId: WA });
if (process.argv[2] === 'make') {
  const [claude, tasks] = process.argv.slice(3);
  fs.mkdirSync(tasks, { recursive: true });
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []);
  for (const f of files(claude)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('@TASKS@', tasks));
  // a dev server, with the colours and the box a terminal shows; an optimiser that runs out of memory; a long copy
  fs.writeFileSync(path.join(tasks, 'bmain1.output'), '\x1b[32m   ┌─────────────────────────────────────┐\n   │   Serving!                          │\n   │   - Local:    http://localhost:3000 │\n   └─────────────────────────────────────┘\x1b[0m\n\n \x1b[1mHTTP\x1b[0m  13:00:12 ::1 GET / 200\n');
  fs.writeFileSync(path.join(tasks, 'bsub1.output'), 'resizing 48 images\n');
  fs.writeFileSync(path.join(tasks, 'bsub2.output'), '> demo@1.0.0 optimise\n> node scripts/optimise.mjs\n\nOptimising 48 images\n  hero.png      1.2 MB -> 380 KB\n  team.jpg      860 KB -> 240 KB\n  progress 12/48\r  progress 30/48\r  progress 31/48\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
  fs.writeFileSync(path.join(tasks, 'bsub3.output'), Array.from({ length: 6000 }, (_, i) => `copied icons/icon-${String(i + 1).padStart(4, '0')}.svg -> out/icon-${String(i + 1).padStart(4, '0')}.svg\n`).join(''));
  // "To review" (R7.1): a session with three finished deliverables; one reported long before the last 160 items,
  // one just before the end, and one whose report isn't in the transcript
  const dir = path.join(claude, 'projects', '-tmp-fixture'), sub = path.join(dir, RV, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const at = (n) => new Date(Date.UTC(2026, 10, 20, 14, 0, 0) + n * 5000).toISOString(), j = (o) => JSON.stringify(o) + '\n';
  const agents = [['cccc0001', 'toolu_rv1', 'Write the launch post'], ['cccc0002', 'toolu_rv2', 'Sketch the pricing page'], ['cccc0003', 'toolu_rv3', 'List the open bugs']];
  const report = (n, id, text) => j({ type: 'user', uuid: `rv-r${id}`, timestamp: at(n), isMeta: true, message: { role: 'user', content: `Another Claude session sent a message.\n<agent-message from="${id}">\nThe report follows:\n  ${text}\n</agent-message>` } });
  let out = j({ type: 'user', uuid: 'rv-u1', timestamp: at(0), message: { role: 'user', content: 'Draft the launch pieces with a few helpers.' } });
  agents.forEach(([, tid, d], i) => { out += j({ type: 'assistant', uuid: `rv-a1-${i}`, timestamp: at(1), message: { id: 'msg_rv-a1', role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Agent', input: { description: `For review: ${d}`, subagent_type: 'general-purpose', prompt: 'made-up', run_in_background: true } }] } }); });
  agents.forEach(([id, tid, d], i) => { out += j({ type: 'user', uuid: `rv-u2-${i}`, timestamp: at(2), toolUseResult: { status: 'async_launched', agentId: id, description: d, prompt: 'made-up', outputFile: '/tmp/o' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'Async agent launched successfully.' }] } }); });
  out += report(3, 'cccc0001', 'The launch post is in launch.md.');
  let n = 4;
  const chat = (k) => { for (let i = 0; i < k; i++, n++) out += i % 2 ? j({ type: 'assistant', uuid: `rv-f${n}`, timestamp: at(n), message: { id: `msg_rv-f${n}`, role: 'assistant', content: [{ type: 'text', text: `Reply ${n}: made-up notes on the copy.` }] } }) : j({ type: 'user', uuid: `rv-f${n}`, timestamp: at(n), message: { role: 'user', content: `Prompt ${n}: tighten the copy.` } }); };
  chat(400);
  out += report(n++, 'cccc0003', 'Seven open bugs, listed in bugs.md.');
  chat(30);
  fs.writeFileSync(path.join(dir, `${RV}.jsonl`), out);
  // the waiting subagent: it started the bench as its own background shell, ended its turn, and was notified "waiting"
  const wsub = path.join(dir, WT, 'subagents');
  fs.mkdirSync(wsub, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'bwait1.output'), 'page 1 of 40\npage 2 of 40\n');
  elsewhere(claude, 7108, WT, '/tmp/fixture'); // the other process its subagent and shell run in
  fs.writeFileSync(path.join(dir, `${WT}.jsonl`), wj({ type: 'user', uuid: 'wt-u1', timestamp: wat(0), message: { role: 'user', content: 'Bench the pages in the background.' } })
    + wj({ type: 'assistant', uuid: 'wt-a1', timestamp: wat(1), message: { id: 'msg_wt-a1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dag', name: 'Agent', input: { description: 'Run the page bench', subagent_type: 'general-purpose', prompt: 'made-up', run_in_background: true } }] } })
    + wj({ type: 'user', uuid: 'wt-r1', timestamp: wat(1), toolUseResult: { isAsync: true, status: 'async_launched', agentId: WA, description: 'd', prompt: 'made-up', outputFile: '/tmp/o' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dag', content: 'Async agent launched successfully.' }] } })
    + wj({ type: 'assistant', uuid: 'wt-a2', timestamp: wat(2), message: { id: 'msg_wt-a2', role: 'assistant', content: [{ type: 'text', text: 'The bench runs in the background.' }] } })
    + wj({ type: 'system', subtype: 'stop_hook_summary', uuid: 'wt-s1', timestamp: wat(2), hookCount: 0, hookInfos: [], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: false })
    + wnote(5, 'is waiting on its own background work', 'The bench is running.'));
  fs.writeFileSync(path.join(wsub, `agent-${WA}.jsonl`), wsc({ type: 'user', uuid: 'wt-s0', timestamp: wat(1), message: { role: 'user', content: 'Run the page bench.' } })
    + wsc({ type: 'assistant', uuid: 'wt-s1', timestamp: wat(3), message: { id: 'msg_wt-s1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dsh', name: 'Bash', input: { command: 'node bench.mjs', description: 'Run the bench over every page', run_in_background: true } }] } })
    + wsc({ type: 'user', uuid: 'wt-s2', timestamp: wat(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dsh', content: `Command running in background with ID: bwait1. Output is being written to: ${path.join(tasks, 'bwait1.output')}. You will be notified when it completes.` }] } })
    + wsc({ type: 'assistant', uuid: 'wt-s3', timestamp: wat(4), message: { id: 'msg_wt-s3', role: 'assistant', content: [{ type: 'text', text: 'The bench is running.' }] } }));
  fs.writeFileSync(path.join(wsub, `agent-${WA}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Run the page bench', toolUseId: 'toolu_dag', spawnDepth: 1, requestShape: 'background', finished: true }));
  agents.forEach(([id, tid, d], i) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), j({ type: 'user', uuid: `${id}-u1`, timestamp: at(1), isSidechain: true, agentId: id, message: { role: 'user', content: `${d}.` } })
      + j({ type: 'assistant', uuid: `${id}-a1`, timestamp: at(3 + i), isSidechain: true, agentId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }));
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `For review: ${d}`, toolUseId: tid, spawnDepth: 1, finished: true }));
  });
  process.exit(0);
}
const [url, state, claude] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.load(url);
await ev(`document.querySelector('#groups .row[data-id^="66666666"]').click()`);
await sleep(500);
const shot = (name) => shotTo(c, `${state}/${name}.png`);
// every child: its tick (or corner) at its mark's height and its guide under its parent's mark
const tree = () => ev(`(() => {
  const mid = r => r.y + r.height / 2, box = e => e.getBoundingClientRect();
  const out = [];
  const walk = (kids, parentMark, depth) => [...kids.children].forEach(k => {
    const tg = k.querySelector(':scope > .tg'), card = k.querySelector(':scope > .card'), mark = box(card.querySelector(':scope > .ind'));
    const last = !k.nextElementSibling, b = getComputedStyle(tg, '::before'), a = getComputedStyle(tg, '::after'), t = box(tg);
    const tickY = t.y + (last ? parseFloat(b.height) - .5 : parseFloat(a.top) + .5);
    out.push({ name: card.querySelector('.n').textContent, depth, last, tick: Math.abs(tickY - mid(mark)), x: Math.abs(t.x + .5 - (parentMark.x + parentMark.width / 2)),
      reach: Math.abs(t.x + 11 - box(card).x), corner: last ? b.borderBottomStyle === 'solid' && a.content === 'none' : a.borderTopStyle === 'solid', top: t.y });
    const sub = k.querySelector(':scope > .kids'); if (sub) walk(sub, mark, depth + 1);
  });
  const k0 = document.querySelector('.rail .now > .kids');
  if (k0) walk(k0, box(document.querySelector('.main-row > .ind')), 1);
  return out;
})()`);
let t = await tree();
check('Main conversation has two children: the subagent, then the main thread shell', JSON.stringify(t.filter((x) => x.depth === 1).map((x) => x.name)) === '["Build image thumbnails","Serve the demo"]', JSON.stringify(t));
check("the subagent's shell and monitor hang under it", JSON.stringify(t.filter((x) => x.depth === 2).map((x) => x.name)) === '["Resize the images","Watch the resize log"]', JSON.stringify(t));
check('every tick sits at its mark (within 1 px)', t.length === 4 && t.every((x) => x.tick < 1), JSON.stringify(t));
check("every guide runs under its parent's mark and its tick meets the card", t.every((x) => x.x < 1 && x.reach < 1), JSON.stringify(t));
check('the last child of each level ends in a corner, the others in a tick', t.every((x) => x.corner), JSON.stringify(t));
check('the main card counts its direct children', (await ev(`document.querySelector('.main-row .m').textContent`)) === '2 running in the background');
await shot('rail-tree');
// a click on the subagent card opens its transcript and expands nothing: the panel doesn't move
const before = await tree();
await ev(`document.querySelector('.rail .card[data-agent="bbbb0001"]').click()`);
await sleep(400);
check('a subagent card has no Stop row and no expansion', await ev(`!document.querySelector('.bw-stop') && !document.querySelector('.rail .bw-detail, .rail [aria-expanded]')`));
t = await tree();
check('opening a subagent moves nothing in the tree (within 1 px)', t.length === before.length && t.every((x, i) => x.name === before[i].name && Math.abs(x.top - before[i].top) < 1), JSON.stringify([before.map(x => x.top), t.map(x => x.top)]));
await shot('rail-open');
// Past names the subagent; nothing of the subagent's on the main side
const past = await ev(`[...document.querySelectorAll('.rail .pr .n')].map(n => n.textContent)`);
check('Past names the subagent of its shells', past.includes('Optimise the images failed in Build image thumbnails') && past.includes('List old images in Check the old images') && past.includes('Copy the icons in Build image thumbnails'), JSON.stringify(past));
// the item you're viewing, of every kind: exactly one visible edge (no border plus ring), the same ink edge on each,
// over every state tint of the main card, and selecting moves and resizes nothing
const sel = (q, state) => ev(`(() => {
  document.querySelector(${JSON.stringify(q)}).click();
  return new Promise(r => setTimeout(() => {
    document.activeElement?.blur();
    const cur = [...document.querySelectorAll('.rail [aria-current="true"]')], e = cur[0];
    if (${JSON.stringify(state || '')}) e.dataset.state = ${JSON.stringify(state || '')};
    const seen = c => c && c !== 'none' && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c);
    const edges = [];
    for (const [s, pe] of [[getComputedStyle(e), ''], [getComputedStyle(e, '::before'), 'before'], [getComputedStyle(e, '::after'), 'after']]) {
      if (pe && s.content === 'none') continue;
      if (['Top', 'Right', 'Bottom', 'Left'].some(d => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none' && seen(s['border' + d + 'Color']))) edges.push((pe || 'self') + ' border ' + s.borderTopColor + ' ' + s.borderTopWidth);
      if (s.boxShadow !== 'none') edges.push((pe || 'self') + ' shadow ' + s.boxShadow);
      if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) edges.push((pe || 'self') + ' outline');
    }
    const geo = [...document.querySelectorAll('.rail .main-row, .rail .card, .rail .pr, .rail .ind, .rail .tg')].map(x => (b => [b.x, b.y, b.width, b.height].map(v => +v.toFixed(2)))(x.getBoundingClientRect()));
    r(JSON.stringify({ n: cur.length, edges, geo }));
  }, 350));
})()`).then(JSON.parse);
const items = [['main, working', '[data-back-main]'], ['main, needs you', '[data-back-main]', 'red'], ['main, idle', '[data-back-main]', 'amber'],
  ['running subagent', '.rail .card[data-agent="bbbb0001"]'], ['Past subagent', '.rail .pr[data-agent="bbbb0002"]']];
const seenSel = [];
for (const [label, q, state] of items) seenSel.push({ label, ...(await sel(q, state)) });
const edgeOf = (x) => x.edges[0]?.replace(/^\w+ /, '');
check('every selected item has exactly one visible edge, no border plus ring', seenSel.every((x) => x.n === 1 && x.edges.length === 1), JSON.stringify(seenSel.map((x) => [x.label, x.n, x.edges])));
check('the selected edge is the same 1px ink line on every kind and state', seenSel.every((x) => edgeOf(x) === (process.env.SYNOPIA_CDP_THEME === 'dark' ? 'border rgb(230, 237, 243) 1px' : 'border rgb(31, 35, 40) 1px')), JSON.stringify(seenSel.map((x) => [x.label, x.edges])));
const g0 = seenSel[0].geo, moved = seenSel.filter((x) => x.geo.length !== g0.length || x.geo.some((b, i) => b.some((v, j) => Math.abs(v - g0[i][j]) > 0.5)));
check('selecting changes no geometry: every card, row, mark and guide keeps its place and size', moved.length === 0, JSON.stringify(moved.map((x) => x.label)));
// the session header has one shape in every view: the same height and line tops, the text on the same baselines
const head = () => ev(`(() => {
  const h = document.querySelector('.c-head'), top = h.getBoundingClientRect().top, r = (e) => e.getBoundingClientRect();
  const lines = [...h.querySelectorAll(':scope > .c-title, :scope > .c-now, :scope > .c-meta')];
  // a text line's baseline: the bottom of a zero-height inline-block sitting on it
  const base = (p) => { const s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0'; p.prepend(s); const y = r(s).bottom - top; s.remove(); return y; };
  return JSON.stringify({ h: r(h).height, tops: lines.map((l) => r(l).top - top), hs: lines.map((l) => r(l).height), bases: lines.map(base),
    acts: [...h.querySelectorAll('.c-acts .btn')].map((b) => r(b).top - top) });
})()`).then(JSON.parse);
await ev(`document.querySelector('.rail .card[data-agent="bbbb0001"]').click()`);
await sleep(300);
const hSub = await head();
check('a subagent view: "‹ <session title>" at the start of the title line, the only back link in the header', await ev(`(() => { const t = document.querySelector('.c-head > .c-title'), b = t.firstElementChild; return b.matches('.c-crumb[data-back]') && b.textContent === '‹ ' + __synopia.cur().title && document.querySelectorAll('.c-head [data-back]').length === 1 && Math.abs(b.getBoundingClientRect().bottom - t.querySelector('.c-name').getBoundingClientRect().bottom) < 6; })()`));
await ev(`document.querySelector('[data-back-main]').click()`);
await sleep(300);
const hMain = await head();
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.5);
check('the header has the same height and line tops in the main and the subagent view (within 0.5 px)',
  Math.abs(hMain.h - hSub.h) <= 0.5 && near(hMain.tops, hSub.tops) && near(hMain.hs, hSub.hs) && near(hMain.bases, hSub.bases) && near(hMain.acts, hSub.acts), JSON.stringify({ hMain, hSub }));
check("the main conversation's header has the model button only", (await ev(`[...document.querySelectorAll('.c-head .c-acts button')].map((b) => b.id).join()`)) === 'model-label');
// the sidebar's sub-lines are the panel's Main conversation tree, item for item (R4.2, 2026-11-27, the user: "Render
// exactly what we have inside the right panel"): the same keys, names and depths in the same order, no count line
const sideTree = () => ev(`(() => { const r = document.querySelector('#groups .row[aria-current="true"]');
  const side = [...r.querySelectorAll('.r-main > .r-agent[data-line^="a:"], .r-main > .r-agent[data-line^="b:"]')].filter(l => !l.classList.contains('r-gone')).map(l => ({ key: l.dataset.line.slice(2),
    depth: +(l.style.getPropertyValue('--depth') || 0), name: l.querySelector('b.kw').textContent, moving: l.getAnimations({ subtree: true }).some(a => a.playState === 'running'), text: l.textContent.replace(/\\s+/g, ' ').trim() }));
  const panel = [...document.querySelectorAll('.rail .now .kid')].filter(k => !k.classList.contains('gone')).map(k => { let d = 0; for (let x = k.parentElement; x; x = x.parentElement) if (x.classList?.contains('kid')) d++;
    return { key: k.dataset.line, depth: d, name: k.querySelector(':scope > .card .n').textContent }; });
  const grouped = [...r.querySelectorAll('.r-main > *')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()).filter(t => /\\d+ (shells?|monitors?|subagents?|forks?)\\b|\\bor monitors?\\b|\\d+ more\\b/.test(t));
  return { side, panel, grouped }; })()`);
const same = (st) => st.side.length === st.panel.length && st.side.every((l, i) => l.key === st.panel[i].key && l.depth === st.panel[i].depth && l.name === st.panel[i].name);
{
  const st = await sideTree();
  check("the sidebar's sub-lines are the panel's tree: each item on its own line, named, at its depth, in its order; no count line", same(st) && st.side.length === 4 && !st.grouped.length
    && st.side.some((l) => l.name === 'Serve the demo' && l.depth === 0), JSON.stringify(st));
}
check("the main transcript doesn't show them", await ev(`!/Resize the images|Watch the resize log|Optimise the images/.test(document.getElementById('log').textContent)`));
// ---------- R7.2: a shell or monitor opens in the pane, as a subagent does ----------
const tasks = path.join(state, 'tasks');
const open = async (q) => { await ev(`document.querySelector(${JSON.stringify(q)}).click()`); await sleep(400); };
const logText = () => ev(`document.querySelector('#log .bg-run')?.textContent || ''`);
const TERM = `(__synopia.term()?.lines || []).join('\\n')`; // the output as its terminal draws it (term.js, 2026-11-27)
const view = () => ev(`(() => { const h = document.querySelector('.c-head'), t = (q) => h.querySelector(q)?.textContent || '';
  return { view: __synopia.view(), title: t('.c-title .c-name') || t('.c-title'), crumb: t('.c-title > .c-crumb[data-back]'), metaBack: !!h.querySelector('.c-meta [data-back]'), now: t('.c-now'), meta: t('.c-meta'), cur: [...document.querySelectorAll('.rail [aria-current="true"]')].map((e) => e.dataset.bg || e.dataset.agent || 'main'),
    expanded: !!document.querySelector('.rail .bw-detail, .rail [aria-expanded]'), cmd: document.querySelector('#log .bg-run .cmd')?.textContent || '', out: ${TERM},
    live: !!document.querySelector('#log .liveln'), moving: (document.querySelector('#log .liveln .g')?.getAnimations({ subtree: true }) || []).filter((a) => a.playState === 'running').length,
    end: document.querySelector('#log .bg-end')?.textContent || '', earlier: document.querySelector('#log [data-earlier]')?.textContent || '' }; })()`);
await open('.rail .card[data-bg="toolu_rsh"]');
await c.until(`${TERM}.includes('Serving!')`, 5000);
let v = await view();
check('a shell row opens its view in the pane, not in the panel: it alone is selected, nothing expands', v.view === 'toolu_rsh' && JSON.stringify(v.cur) === '["toolu_rsh"]' && !v.expanded, JSON.stringify(v));
check('its header names it, says it runs and whose it is', v.title === 'Serve the demo' && /^Running, \d+.*\. Background shell, started /.test(v.now) && /^Claude hears when it ends\. Shell in “/.test(v.meta), JSON.stringify(v));
check('its way back is the crumb at the start of the title line, as in a subagent view: "‹ <session title>"', /^‹ ./.test(v.crumb) && !v.metaBack, JSON.stringify(v));
{ const hShell = await head(); check('the shell view keeps the header shape of the main conversation (R5.1)', Math.abs(hMain.h - hShell.h) <= 0.5 && near(hMain.tops, hShell.tops) && near(hMain.hs, hShell.hs) && near(hMain.bases, hShell.bases), JSON.stringify({ hMain, hShell })); }
check('its log is the command, then the whole output in its terminal (escape sequences drawn, not shown), then the moving running mark',
  v.cmd === 'npx serve demo' && v.out.startsWith('   ┌') && v.out.includes('- Local:    http://localhost:3000') && v.out.includes('HTTP  13:00:12') && !/\x1b|\[0m|\[32m/.test(v.out) && v.live && v.moving > 0 && !v.end, JSON.stringify(v));
check('its log is monospace', await ev(`getComputedStyle(document.querySelector('#log .term-box .xterm-rows')).fontFamily.includes('JetBrains Mono')`));
check('the terminal draws its colours: the bold HTTP is bold, read-only (no keys, no cursor)', await ev(`(() => { const s = [...document.querySelectorAll('#log .term-box .xterm-rows span')].find(x => x.textContent === 'HTTP'); return !!s && getComputedStyle(s).fontWeight >= 600 && __synopia.term().writable === false; })()`));
{ const p = await outPanel(c, "#log .term-box"); check("a shell view: the command, then its output in the output panel", !!p && p.ok, JSON.stringify(p)); }
const hShell = await head();
check('the header has the same height and line tops as the main and the subagent view (within 0.5 px)',
  Math.abs(hShell.h - hSub.h) <= 0.5 && near(hShell.tops, hSub.tops) && near(hShell.hs, hSub.hs) && near(hShell.bases, hSub.bases) && near(hShell.acts, hSub.acts), JSON.stringify({ hShell, hSub }));
fs.appendFileSync(path.join(tasks, 'bmain1.output'), ' \x1b[1mHTTP\x1b[0m  13:05:00 ::1 GET /thumbs 200\n');
check('while it runs, what it prints appends live', await c.until(`${TERM}.includes('GET /thumbs 200')`, 5000));
await shot('rail-shell-running');
// a monitor of a subagent: its events
await open('.rail .card[data-bg="toolu_bmon1"]');
v = await view();
check("a subagent's monitor opens with its events and names the subagent", v.view === 'toolu_bmon1' && v.title === 'Watch the resize log' && /^Claude hears each event\. Monitor of the subagent Build image thumbnails in “/.test(v.meta)
  && v.out === 'resized 12 of 48: hero.png, team.jpg\nresized 30 of 48\nskipped logo.svg (vector)' && v.live, JSON.stringify(v));
{ const p = await outPanel(c, "#log .term-box"); check("a monitor's events go in the same output panel", !!p && p.ok, JSON.stringify(p)); }
// a finished shell from Past: its output, a carriage-returned line as it ended, how it ended
await open('.rail .pr[data-bg="toolu_bsh2"]');
v = await view();
check('a failed shell from Past: its whole output, then how it ended, with no live line', v.view === 'toolu_bsh2' && /^Failed, /.test(v.now) && v.out.includes('heap out of memory') && v.out.includes('  progress 31/48\n') && !v.out.includes('progress 12/48')
  && /^Failed after .*Optimiser ran out of memory$/.test(v.end) && !v.live && JSON.stringify(v.cur) === '["toolu_bsh2"]', JSON.stringify(v));
await shot('rail-shell-finished');
// a long output: the last part, earlier output on asking, the place kept, down to the first line
await open('.rail .pr[data-bg="toolu_bsh3"]');
v = await view();
const lines0 = v.out.split('\n').filter(Boolean);
check('a long output shows its last part with a link to earlier output', /^Show earlier output$/.test(v.earlier) && lines0.length < 6000 && lines0.at(-1) === 'copied icons/icon-6000.svg -> out/icon-6000.svg' && /^copied /.test(lines0[0]), JSON.stringify({ earlier: v.earlier, n: lines0.length, first: lines0[0] }));
const markLine = lines0[0];
// g scrolls the terminal to its top; g there loads the earlier output, and the line you read stays at the top
await c.key('g', { code: 'KeyG', vk: 71 });
check('g goes to the top of the terminal', await c.until(`__synopia.term()?.atTop === true && __synopia.term().top === ${JSON.stringify(markLine)}`, 2000), JSON.stringify(await ev(`__synopia.term()?.top`)));
await c.key('g', { code: 'KeyG', vk: 71 });
await c.until(`!${TERM}.startsWith(${JSON.stringify(markLine)})`, 5000);
await sleep(200);
check('g at the top loads earlier output and keeps what you read in place', JSON.stringify(await ev(`[__synopia.term().top, __synopia.term().atTop]`)) === JSON.stringify([markLine, false]), JSON.stringify(await ev(`[__synopia.term().top, __synopia.term().atTop]`)));
await c.key('G', { shift: true, code: 'KeyG', vk: 71 });
check('G goes to its end', await c.until(`__synopia.term()?.atEnd === true`, 2000));
for (let i = 0; i < 4 && (await view()).earlier; i++) { await ev(`document.querySelector('#log [data-earlier]').click()`); await sleep(400); }
v = await view();
const all = v.out.split('\n').filter(Boolean);
check('earlier output loads down to the first line, each line once', !v.earlier && all.length === 6000 && all[0] === 'copied icons/icon-0001.svg -> out/icon-0001.svg' && new Set(all).size === 6000, JSON.stringify({ n: all.length, first: all[0], earlier: v.earlier }));
{ const p = await outPanel(c, '#log .term-box'); check('a long output, loaded whole, is in the one output panel', !!p && p.ok && (await ev(`document.querySelectorAll('#log .term-box').length`)) === 1, JSON.stringify(p)); }
// ---------- R5.12: only Main conversation has the message box ----------
await ev(`document.querySelector('[data-back-main]').click()`); await sleep(300);
await ev(`(() => { const t = document.getElementById('msg'); t.value = 'a main draft'; t.dispatchEvent(new Event('input')); })()`);
const noBox = () => ev(`!document.getElementById('msg') && !document.querySelector('.dock textarea, .dock .slash') && getComputedStyle(document.querySelector('.dock')).display === 'none'
  && !document.querySelector('.qpin') && Math.abs(document.getElementById('log').getBoundingClientRect().bottom - (document.querySelector('.thread').getBoundingClientRect().bottom - 1)) < 0.5`);
const typeKeys = async () => { await c.key('i', { code: 'KeyI', vk: 73 }); await sleep(100); await c.key('/', { code: 'Slash', vk: 191 }); await sleep(100); await c.key('a', { code: 'KeyA', vk: 65 }); await sleep(150); };
for (const [label, q] of [['a subagent view', '.rail .card[data-agent="bbbb0001"]'], ['a shell view', '.rail .card[data-bg="toolu_rsh"]']]) {
  await open(q);
  check(`${label} has no message box, no line: the one panel ends with the log`, await noBox());
  if (process.env.SYNOPIA_SHOTS) { fs.mkdirSync(process.env.SYNOPIA_SHOTS, { recursive: true }); await shotTo(c, path.join(process.env.SYNOPIA_SHOTS, `${label.split(' ')[1]}-${process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light'}.png`)); }
  await typeKeys();
  check(`i, / and a do nothing in ${label}: normal mode, still no box`, (await ev('__synopia.mode()')) === 'normal' && await noBox() && !(await ev('document.getElementById("slash")')));
}
// a running shell's view (2026-11-27): Esc stops nothing there; x asks to stop it, on the dock line, and another key takes it away
await c.key('Escape', { code: 'Escape', vk: 27 }); await sleep(200);
const escAsked = await ev(`!!document.querySelector('.dock .composer.asking')`);
await c.key('x', { code: 'KeyX', vk: 88 }); await sleep(200);
const asked = await ev(`/^Stop this shell\\?/.test(document.querySelector('.dock .composer.asking .int-ask')?.textContent || '') && getComputedStyle(document.querySelector('.dock')).display !== 'none'`);
await c.key('q', { code: 'KeyQ', vk: 81 }); await sleep(200);
check('Esc asks nothing in a shell view; x asks "Stop this shell?" on the dock line, and another key takes it away', !escAsked && asked && await noBox());
const lastRow = await ev(`[...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map((e) => e.dataset.agent || e.dataset.bg).at(-1)`);
await open(`.rail [data-agent="${lastRow}"], .rail [data-bg="${lastRow}"]`);
await c.key('J', { shift: true, code: 'KeyJ', vk: 74 }); await sleep(300);
check('J from the last row is Main conversation, with the box and its draft', (await ev('__synopia.view()')) === null && (await ev(`document.getElementById('msg')?.value`)) === 'a main draft' && (await ev('__synopia.mode()')) === 'normal');
// J/K: Main conversation, then the panel's rows top to bottom, shells and monitors included
const rows = await ev(`[...new Set([...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map((e) => e.dataset.agent || e.dataset.bg))]`);
const seen = [];
for (let i = 0; i <= rows.length; i++) { await c.key('J', { shift: true, code: 'KeyJ', vk: 74 }); await sleep(200); seen.push(await ev('__synopia.view()')); }
check('J steps through Main conversation and every row, shells and monitors included, then wraps', JSON.stringify(seen) === JSON.stringify([...rows, null]) && rows.includes('toolu_rsh') && rows.includes('toolu_bmon1'), JSON.stringify([rows, seen]));
// back to Main conversation from a shell view, by the header's link
await open('.rail .card[data-bg="toolu_rsh"]');
await ev(`document.querySelector('.c-head [data-back]').click()`); await sleep(300);
v = await view();
check("the header's back link shows the main conversation again", v.view === null && JSON.stringify(v.cur) === '["main"]' && !(await logText()), JSON.stringify(v));
// restore (R3.9): the shown shell view comes back after a reload
await open('.rail .card[data-bg="toolu_rsh"]');
await sleep(800); // the UI state's patch goes
check('the page reloads', await c.load(url));
await c.until(`${TERM}.includes('GET /thumbs 200')`, 5000);
v = await view();
check('after a reload the shell view is back, with its output and no box', v.view === 'toolu_rsh' && v.title === 'Serve the demo' && JSON.stringify(v.cur) === '["toolu_rsh"]' && await noBox(), JSON.stringify(v));
await ev(`document.querySelector('[data-back-main]').click()`); await sleep(300);
check("Main conversation's draft is back after the reload", (await ev(`document.getElementById('msg')?.value`)) === 'a main draft');
// ---------- R7.1: a "To review" card goes to its subagent's report in Main conversation ----------
let sent = null;
const settled = `!__synopia.restoring() && __synopia.acting() === 0`;
await ev(`document.querySelector('#groups .row[data-id^="77777777"]').click()`);
await c.until(`(__synopia.current() || '').startsWith('77777777') && ${settled} && document.querySelectorAll('.rail .rv').length === 3`, 5000);
const report = (id) => ev(`(() => { const log = document.getElementById('log'), b = log.querySelector('.log-inner > [data-key="report:${id}"]'), s = b && getComputedStyle(b);
  return JSON.stringify({ view: __synopia.view(), y: b ? Math.round(b.getBoundingClientRect().top - log.getBoundingClientRect().top) : null, marked: !!b && b.classList.contains('jump-mark'),
    ring: s ? s.boxShadow : '', tint: s ? s.backgroundColor : '', top: log.scrollTop, toast: document.getElementById('toast').classList.contains('show'), rv: document.querySelectorAll('.rail .rv').length }); })()`).then(JSON.parse);
const nearTop = (r) => r.y !== null && r.y >= 0 && r.y <= 40;
const ringed = (r) => r.marked && /rgb\(\d+, \d+, \d+\) 0px 0px 0px 4px/.test(r.ring) && !/rgba\(0, 0, 0, 0\)/.test(r.tint);
const cursorOf = await ev(`getComputedStyle(document.querySelector('.rail .rv-open[data-agent="cccc0003"] .m')).cursor + ' ' + getComputedStyle(document.querySelector('.rail .rv')).cursor`);
check('a To review card shows it is a link: the pointer cursor', cursorOf === 'pointer pointer', cursorOf);
// from the subagent's own view, a click on the card's text: Main conversation, its report near the top, marked
await ev(`document.querySelector('#log .alink[data-agent="cccc0003"]').click()`);
await c.until(`__synopia.view() === 'cccc0003' && ${settled}`, 5000);
sent = await spySent(c);
await ev(`document.querySelector('.rail .rv-open[data-agent="cccc0003"] .m').click()`);
await c.until(`__synopia.view() === null && ${settled} && !!document.querySelector('#log [data-key="report:cccc0003"].jump-mark')`, 5000);
let r = await report('cccc0003');
check('a card click from a subagent view shows Main conversation with that report near the top of the log', r.view === null && nearTop(r), JSON.stringify(r));
check('the report is marked with the selection tint and the 1px blue ring of b, b', ringed(r), JSON.stringify(r));
check('a card click marks nothing reviewed', (await sent('reviewed')).length === 0 && r.rv === 3, JSON.stringify(r));
check('the mark fades and goes', await c.until(`!document.querySelector('#log .jump-mark')`, 4000));
// "Mark reviewed" only marks reviewed: no view change, no scroll, no jump
await ev(`document.getElementById('log').scrollTop -= 300`); await sleep(100);
const top0 = (await report('cccc0003')).top;
sent = await spySent(c);
await ev(`document.querySelector('.rail [data-reviewed="cccc0003"]').click()`);
await c.until(`document.querySelectorAll('.rail .rv').length === 2 && ${settled}`, 5000);
r = await report('cccc0003');
const marks = await sent('reviewed');
check('"Mark reviewed" only marks it reviewed: the same view and place, nothing marked', marks.length === 1 && marks[0].agentId === 'cccc0003' && r.view === null && r.top === top0 && !r.marked
  && (await sent('view', 'earlier')).length === 0, JSON.stringify({ r, top0, marks }));
// a Past row still opens the subagent's view
await ev(`document.querySelector('.rail .pr[data-agent="cccc0003"]').click()`);
await c.until(`__synopia.view() === 'cccc0003' && ${settled}`, 5000);
check("a Past row still opens the subagent's own transcript", (await ev('__synopia.view()')) === 'cccc0003');
// a report older than the loaded items: earlier pages load until it is there
await ev(`document.querySelector('.rail .rv-open[data-agent="cccc0001"]').click()`);
await c.until(`__synopia.view() === null && ${settled} && !!document.querySelector('#log [data-key="report:cccc0001"].jump-mark')`, 8000);
r = await report('cccc0001');
check('a report older than the loaded items is found: earlier pages load, it sits near the top, marked', nearTop(r) && ringed(r), JSON.stringify(r));
check('the earlier pages loaded through the restore, no second loader', (await sent('earlier')).length >= 2);
// the jump is a reading position like any scroll: a reload comes back to it
await sleep(800); // the UI state's patch goes
check('the page reloads after the jump', await c.load(url));
await c.until(`(__synopia.current() || '').startsWith('77777777') && ${settled} && !!document.querySelector('#log [data-key="report:cccc0001"]')`, 8000);
r = await report('cccc0001');
check('after a reload the log is back at the report: the jump updated the reading position', r.view === null && nearTop(r), JSON.stringify(r));
// a report that isn't in the transcript: the subagent's own view, no error
await ev(`document.querySelector('.rail .rv-open[data-agent="cccc0002"]').click()`);
await c.until(`__synopia.view() === 'cccc0002' && ${settled}`, 8000);
r = await report('cccc0002');
check("a card whose report isn't in the transcript opens the subagent's own view, with no toast", r.view === 'cccc0002' && !r.toast && r.rv === 2, JSON.stringify(r));
// Enter on a focused card does what a click does (rail rows are buttons)
await ev(`document.querySelector('.rail .rv-open[data-agent="cccc0001"]').focus()`);
await c.key('Shift', { code: 'ShiftLeft', vk: 16 }); // the first key after a load (cdp.mjs prime); then Enter with its text, as a keyboard sends it, so the focused button acts
for (const type of ['keyDown', 'keyUp']) await c.cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
await c.until(`__synopia.view() === null && ${settled} && !!document.querySelector('#log [data-key="report:cccc0001"].jump-mark')`, 8000);
check('Enter on a focused card goes to its report', nearTop(await report('cccc0001')));
await shot('rail-review-jump');
// ---------- a subagent waiting on its own background work: running, its shell under it, then Past after its report ----------
await ev(`document.querySelector('#groups .row[data-id^="88888888"]').click()`);
await c.until(`(__synopia.current() || '').startsWith('88888888') && ${settled} && !!document.querySelector('.rail .card[data-agent="${WA}"]')`, 5000);
const waitView = () => ev(`(() => { const card = document.querySelector('.rail .now .card[data-agent="${WA}"]'), sh = document.querySelector('.rail .kid[data-line="${WA}"] > .kids .card[data-bg="toolu_dsh"]');
  const moving = (e) => e ? (e.querySelector('.ind')?.getAnimations({ subtree: true }) || []).filter((a) => a.playState === 'running').length : -1, row = document.querySelector('#groups .row[data-id^="88888888"]');
  return JSON.stringify({ card: !!card, cardMoves: moving(card), cardM: card?.querySelector('.m')?.textContent || '', shell: !!sh, shellMoves: moving(sh), main: document.querySelector('.main-row .m')?.textContent, word: document.querySelector('.main-row .w')?.textContent,
    mainMoves: moving(document.querySelector('.rail .main-row')), sideMoves: moving(row?.querySelector('.r-side')),
    pastAgent: !!document.querySelector('.rail .pr[data-agent="${WA}"]'), pastShell: document.querySelector('.rail .pr[data-bg="toolu_dsh"]')?.innerHTML || '', side: row?.querySelector('.r-state')?.textContent || '', sub: row?.querySelector('[data-line="a:${WA}"]')?.textContent.trim() || '' }); })()`).then(JSON.parse);
let w = await waitView();
check('a subagent waiting on its own background work stays in the running part with the still kind mark and says so',
  w.card && w.cardMoves === 0 && /^subagent, started .*, waiting on its background work$/.test(w.cardM) && !w.pastAgent, JSON.stringify(w));
check('its own background shell runs under it, with the moving mark', w.shell && w.shellMoves > 0 && !w.pastShell, JSON.stringify(w));
// motion means an agent is doing something: the main turn is over and background work runs, so the session is idle,
// still (2026-11-27; your turn until then)
check('Main conversation counts it, and the session is idle with no moving mark, in the panel and the sidebar', w.main === '1 running in the background' && w.word === 'Idle' && w.side === 'Idle, 1 running in the background' && w.mainMoves === 0 && w.sideMoves === 0 && /^Run the page bench waiting, /.test(w.sub), JSON.stringify(w));
check('no live line once the main turn is over, though its subagent and shell run', await ev(`!document.querySelector('#log .liveln')`), await ev(`document.querySelector('#log .liveln')?.textContent || ''`));
await shot('rail-waiting');
// its shell ends (notified in its own file), it reports: the subagent and its shell go to Past, the shell done, not stopped
const wdir = path.join(claude, 'projects', '-tmp-fixture');
fs.appendFileSync(path.join(wdir, WT, 'subagents', `agent-${WA}.jsonl`), wsc({ type: 'attachment', uuid: 'wt-s4', timestamp: wat(30), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: `<task-notification>\n<task-id>bwait1</task-id>\n<tool-use-id>toolu_dsh</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the bench over every page" completed (exit code 0)</summary>\n</task-notification>` } })
  + wsc({ type: 'assistant', uuid: 'wt-s5', timestamp: wat(31), message: { id: 'msg_wt-s5', role: 'assistant', content: [{ type: 'text', text: 'All 40 pages benched.' }] } }));
fs.appendFileSync(path.join(wdir, `${WT}.jsonl`), wnote(32, 'finished', 'All 40 pages benched.'));
check('after its report the subagent moves to Past', await c.until(`!!document.querySelector('.rail .pr[data-agent="${WA}"]') && !document.querySelector('.rail .now .card[data-agent="${WA}"]')`, 12000));
w = await waitView();
check("its shell is in Past as done, not stopped, and Main conversation runs nothing", /class="chk"/.test(w.pastShell) && !/var\(--ink-3\)"\/><\/svg>/.test(w.pastShell) && w.main === 'Nothing running in the background' && w.word === 'Your turn', JSON.stringify(w));

// ---------- who started a run, by its sign on the card (R7.1, 2026-11-26) ----------
// your `!` runs (one running, one ended) and the folder's credential refresh waiting for input, put in as the backend
// sends them, beside Claude's background shell; the card shows from its cardAt (3 s after the start, or when it waits)
{
  const now = Date.now(), sid = await ev(`__synopia.current()`);
  const bangs = [
    { id: 'who-run', cmd: 'bin/rspec', at: now - 62000, end: null, running: true, exit: null, interrupted: false, waiting: false, quiet: false, cardAt: now - 59000 },
    { id: 'who-soon', cmd: 'git status', at: now - 1000, end: null, running: true, exit: null, interrupted: false, waiting: false, quiet: false, cardAt: now + 2000 },
    { id: 'who-done', cmd: 'npm run build', at: now - 90000, end: now - 40000, running: false, exit: 0, interrupted: false, waiting: false, quiet: false, cardAt: now - 87000 },
    { id: 'who-instant', cmd: 'open .', at: now - 30000, end: now - 29800, running: false, exit: 0, interrupted: false, waiting: false, quiet: false, cardAt: null },
  ];
  await ev(`__synopia.inject({ t: 'session', id: '${sid}', bangs: ${JSON.stringify(bangs)} })`);
  await ev(`__synopia.inject({ t: 'creds', root: '/tmp/fixture', sids: ['${sid}'], phase: 'running', command: 'bin/aws-login', output: 'Signed in in the browser.\\nEnter the MFA code for demo-admin: ', error: '', at: ${now - 20000}, waiting: true, quiet: false, cardAt: ${now - 19000} })`);
  await ev(`__synopia.render('rail')`);
  const cards = await ev(`(() => { const one = id => { const r = document.querySelector('.rail [data-bg="' + id + '"]'); if (!r) return null; const w = r.querySelector('.n .who'); return { now: !!r.closest('.now'), past: r.classList.contains('pr'), who: w ? (w.classList.contains('lock') ? 'lock' : w.textContent) : '', lockMark: !!w?.querySelector('.lock'), color: w ? getComputedStyle(w).color : '', name: r.querySelector('.n').textContent, m: r.querySelector('.m')?.textContent || '', waits: r.classList.contains('waits'), pause: !!r.querySelector(':scope > .ind .bars') }; };
    const claude = document.querySelector('.rail .now .card[data-bg="toolu_dsh"], .rail .card.kc-shell:not([data-bg^="who-"]):not([data-bg^="creds:"])');
    return { run: one('who-run'), soon: one('who-soon'), done: one('who-done'), instant: one('who-instant'), creds: one('creds:/tmp/fixture'), claude: claude ? { who: !!claude.querySelector('.who') } : 'none',
      pastClaude: [...document.querySelectorAll('.rail .past .pr[data-bg]')].filter(p => !/^(who-|creds:)/.test(p.dataset.bg)).map(p => !!p.querySelector('.who')) }; })()`);
  check('your running ! run: its card with the pink ! before the command, "shell, started by you"', !!cards.run && cards.run.now && cards.run.who === '!' && /^rgb\((191, 57, 137|247, 120, 186)\)$/.test(cards.run.color) && cards.run.name === '!bin/rspec' && /^shell, started by you /.test(cards.run.m), JSON.stringify(cards.run));
  check('a run under 3 s old has no card yet', cards.soon === null, JSON.stringify(cards.soon));
  check('your ended run: its Past line with the !', !!cards.done && cards.done.past && cards.done.who === '!', JSON.stringify(cards.done));
  check('a run over at once (no cardAt) has no card and no Past line', cards.instant === null, JSON.stringify(cards.instant));
  check('the credential refresh: the lock, red as it waits for input, "shell, waits for input"', !!cards.creds && cards.creds.who === 'lock' && cards.creds.lockMark && cards.creds.waits && cards.creds.pause && /shell, waits for input/.test(cards.creds.m), JSON.stringify(cards.creds));
  check('Claude\'s runs have no sign, on their cards and Past lines', cards.pastClaude.every(x => x === false) && (cards.claude === 'none' || cards.claude.who === false), JSON.stringify(cards));
  check('Main conversation counts only Claude\'s background work, not yours nor Synopia\'s', /^(Nothing|\d) /.test(await ev(`document.querySelector('.rail .main-row .m').textContent`)) && !/[2-9] running/.test(await ev(`document.querySelector('.rail .main-row .m').textContent`)), await ev(`document.querySelector('.rail .main-row .m').textContent`));
  check('the run under 3 s gets its card once due', await c.until(`!!document.querySelector('.rail .now [data-bg="who-soon"] .who')`, 5000));
  await ev(`__synopia.render('side')`);
  const ws = await sideTree(), wl = (k) => ws.side.find((l) => l.key === k);
  check('the sidebar shows your runs and the refresh as the panel does: "!" and the command, the refresh waiting', same(ws) && !!wl('who-run') && wl('who-run').name === '!bin/rspec'
    && !!wl('creds:/tmp/fixture') && /waits$/.test(wl('creds:/tmp/fixture').text) && !wl('who-instant'), JSON.stringify(ws));
  await shot('rail-who');
  if (process.env.SYNOPIA_SHOTS) await shotTo(c, path.join(process.env.SYNOPIA_SHOTS, `rail-who-${process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light'}.png`), await ev(`(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 520), scale: 1 }; })()`));
}
// 11 items, 3 levels deep, on the sidebar exactly as in the panel (R4.2, 2026-11-27, the user: "Even if there's 10
// items, 3 levels deep, it's fine."): each subagent, fork, shell and monitor on its own line, named by its description
// (else its command), its kind mark moving, nothing grouped, no cap. Made-up work on the current session.
{
  const sid = await ev(`__synopia.current()`), t0 = Date.now() - 600_000, at = (m) => new Date(t0 + m * 1000).toISOString();
  const ag = (id, description, m, more = {}) => ({ id, toolUseId: 'toolu_' + id, description, type: 'general-purpose', start: at(m), finished: false, ...more });
  const bg = (toolUseId, kind, m, more) => ({ toolUseId, kind, status: 'running', start: at(m), ...more });
  const agents = [ag('tr-f1', 'Draft the changelog', 1, { fork: true }), ag('tr-a1', 'Audit the export columns', 2), ag('tr-a2', 'Check the date formats', 3, { parent: 'tr-a1' }),
    ag('tr-a3', 'Read the locale tables', 4, { parent: 'tr-a2' }), ag('tr-a4', 'Record export columns docs', 5)];
  const background = [bg('tr-b1', 'shell', 6, { description: 'Serve the export preview', command: 'npm run preview' }), bg('tr-b2', 'shell', 7, { command: 'npm run watch:css' }),
    bg('tr-b3', 'monitor', 8, { description: 'Tail the server log', command: 'tail -f log/server.log' }), bg('tr-b4', 'shell', 9, { description: 'Export a sample file', command: 'node export.mjs', agentId: 'tr-a1' }),
    bg('tr-b5', 'shell', 10, { description: 'Run the date tests', command: 'npm test -- dates', agentId: 'tr-a2' }), bg('tr-b6', 'monitor', 11, { description: 'Watch the test log', command: 'tail -f test.log', agentId: 'tr-a2' })];
  await ev(`__synopia.inject({ t: 'session', id: '${sid}', agents: ${JSON.stringify(agents)}, background: ${JSON.stringify(background)}, bangs: [] })`);
  await sleep(700);
  const st = await sideTree(), mine = st.side.filter((l) => l.key.startsWith('tr-'));
  const want = [['tr-f1', 0, 'Draft the changelog'], ['tr-a1', 0, 'Audit the export columns'], ['tr-a2', 1, 'Check the date formats'], ['tr-a3', 2, 'Read the locale tables'], ['tr-b5', 2, 'Run the date tests'],
    ['tr-b6', 2, 'Watch the test log'], ['tr-b4', 1, 'Export a sample file'], ['tr-a4', 0, 'Record export columns docs'], ['tr-b1', 0, 'Serve the export preview'], ['tr-b2', 0, 'npm run watch:css'], ['tr-b3', 0, 'Tail the server log']];
  check('3 levels: a subagent under a subagent under a subagent, its own shell and monitor beside it', JSON.stringify(mine.map((l) => [l.key, l.depth, l.name])) === JSON.stringify(want), JSON.stringify(mine));
  check('11 items: every one on its own line, no cap, the same as the panel', mine.length === 11 && same(st), JSON.stringify(st));
  check('each shell and monitor named, by its description, else its command', ['tr-b1', 'tr-b2', 'tr-b3', 'tr-b4', 'tr-b5', 'tr-b6'].every((k) => st.side.find((l) => l.key === k)?.name === want.find((w) => w[0] === k)[2]), JSON.stringify(mine));
  check('nothing grouped: no count line, no "N more"', !st.grouped.length && !(await ev(`!!document.querySelector('#groups .row[aria-current="true"] [data-line="bg"]')`)), JSON.stringify(st.grouped));
  check('each line has its kind mark, moving while it runs', mine.every((l) => l.moving), JSON.stringify(mine.filter((l) => !l.moving)));
  await shot('rail-side-tree');
}
c.print();
c.close();
