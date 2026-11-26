// Find in the transcript (R5.12e, R9.9) on a generated long transcript, invented data only, never committed.
// usage: node find.mjs make <claude-dir>   writes the transcript and its subagent (run.sh does this first)
//        node find.mjs <url> <state-dir> <claude-dir>
// Checks: ⌘F opens the bar in normal and insert mode; the count; Enter, Shift+Enter, ⌘G and Shift+⌘G move;
// a match in an earlier page the page hadn't loaded is found and shown; one inside a collapsed group opens it;
// Esc closes the bar and keeps the place; a subagent's view searches its own transcript; no long task over 200 ms.
import fs from 'node:fs';
import path from 'node:path';
import { records, keyTable, shot, spySent } from './helpers.mjs';

const SID = 'f1f1f1f1-0000-4000-8000-0000000000f1', AID = 'f2f2f2f2', N = 1200, CWD = '/tmp/synopia-find';
const ts = (s) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + s * 7000).toISOString();
const R = records(CWD, ts);
const words = (i) => Array.from({ length: 4 + (i * 7) % 19 }, (_, w) => `word${(i + w) % 89}`).join(' ');
// The matches of "quokka": a reply in the first page (an earlier page, not loaded at first), a step's output in a
// run of three searches near the end (a collapsed group), and twice in a reply after it. 4 in all.
function mainBody() {
  let out = '';
  for (let i = 0; i < N; i++) {
    if (i === N - 10) {
      for (const [n, text] of [[1, 'build ok'], [2, 'counted 1 quokka on the trail'], [3, 'tests ok']]) {
        out += R.tool(SID, `t${n}`, i, `toolu_q${n}`, 'Grep', { pattern: `step ${n}` }); // three steps in one group
        out += R.rec(SID, { type: 'user', uuid: `r${n}`, timestamp: ts(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_q${n}`, content: text }] } });
      }
      continue;
    }
    if (i % 2 === 0) out += R.you(SID, `m${i}`, i, `Prompt ${i}: ${words(i)}`);
    else out += R.said(SID, `m${i}`, i, i === 3 ? `Reply 3. A Quokka near the start. ${words(i)}` : i === N - 3 ? `Reply ${i}. One quokka, then a second quokka. ${words(i)}` : `Reply ${i}. ${words(i)}`);
  }
  return out;
}
const side = (o) => R.rec(SID, { isSidechain: true, agentId: AID, ...o });
function subBody() {
  let out = side({ type: 'user', uuid: 's-start', timestamp: ts(0), message: { role: 'user', content: 'Count the wallabies.' } });
  for (let i = 1; i < 40; i++) out += side({ type: 'assistant', uuid: `s${i}`, timestamp: ts(i), message: { id: `msg_s${i}`, role: 'assistant', content: [{ type: 'text', text: i % 13 === 0 ? `Step ${i}: one wallaby here.` : `Step ${i}: ${words(i)}` }] } });
  return out;
}

if (process.argv[2] === 'make') {
  const dir = process.argv[3], proj = path.join(dir, 'projects', '-tmp-synopia-find'), sub = path.join(proj, SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), mainBody());
  fs.writeFileSync(path.join(sub, `agent-${AID}.jsonl`), subBody());
  fs.writeFileSync(path.join(sub, `agent-${AID}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Count the wallabies', finished: true }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key, until, cdp } = c;
const K = keyTable(key);
const LONG = 200, THEME = process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light';
const enter = (shift = false) => key('Enter', { code: 'Enter', vk: 13, shift });
const cmdG = (shift = false) => key('g', { meta: true, shift, code: 'KeyG', vk: 71 });
const type = async (t) => { await cdp('Input.insertText', { text: t }); };
const F = () => ev('__synopia.find()');
const countIs = (t) => until(`__synopia.find().count === ${JSON.stringify(t)}`, 8000);
// the current match: its text, whether it is inside the log's visible part, and the item it is in
const cur = () => ev(`(() => { const h = CSS.highlights.get('tf-cur'); if (!h || !h.size) return null; const r = [...h][0], rr = r.getBoundingClientRect(), lr = document.getElementById('log').getBoundingClientRect();
  const el = r.startContainer.parentElement; return { text: r.toString(), seen: rr.top >= lr.top && rr.bottom <= lr.bottom && rr.height > 0, top: Math.round(rr.top - lr.top),
    block: el.closest('.log-inner > [data-key]')?.dataset.key || null }; })()`);
const marks = () => ev(`CSS.highlights.get('tf-find')?.size ?? 0`);
// long tasks from now until stopLong, kept in the page (a check's own global, not the page's)
const long = () => ev(`(() => { const l = window.__findLong = []; const o = new PerformanceObserver(x => l.push(...x.getEntries().map(e => Math.round(e.duration))));
  o.observe({ type: 'longtask' }); window.__findLongStop = () => { o.disconnect(); return l; }; return true; })()`);
const stopLong = () => ev(`window.__findLongStop()`);

await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await c.load(`${url}#${SID.slice(0, 8)}`, `__synopia.current() === '${SID}' && __synopia.cur().items.length === 160`);
await ev('document.fonts.ready.then(() => true)');
const sent = await spySent(c);
await long();

// ⌘F in normal mode: the bar, its field focused
check('normal mode to start', (await ev('__synopia.mode()')) === 'normal');
await K.cmdF();
check('⌘F in normal mode opens the find bar, its field focused', await until(`__synopia.find().shown && document.activeElement?.id === 'tf-q'`));
check('the bar sits under the header, over the log', await ev(`(() => { const b = document.getElementById('tf-find'); return b.previousElementSibling.matches('.c-head') && b.nextElementSibling.id === 'log'; })()`));
// from the top of what is loaded, the first match below it is the step in the collapsed group
await ev(`document.getElementById('log').scrollTop = 0`);
await type('quokka');
check('the count: 2 of 4 (the first match below the top of the view)', await countIs('2 of 4'), JSON.stringify(await F()));
const asked = (await sent('find')).pop();
check('one find, debounced, for the whole main conversation', (await sent('find')).length === 1 && asked?.view === null && asked?.q === 'quokka' && asked?.sid === SID, JSON.stringify(await sent('find')));
check('a match inside a collapsed group opens the group and the step', await ev(`(() => { const r = document.querySelector('[data-step="toolu_q2"]'); return !!r && r.open && r.closest('details.fold').open; })()`));
let m = await cur();
check('the current match is marked and on screen, in the step', m?.text === 'quokka' && m.seen && m.block === 'run:toolu_q1', JSON.stringify(m));
check('the loaded matches are marked (3 of the 4)', (await marks()) === 3, String(await marks()));

await enter();
check('Enter: the next match, 3 of 4', await countIs('3 of 4'));
m = await cur();
check('it is in the reply, on screen', m?.seen && m.block === `m${N - 3}:0` && m.text === 'quokka', JSON.stringify(m));
fs.mkdirSync('/tmp/synopia-find', { recursive: true });
await sleep(150);
await shot(c, path.join(stateDir, `find-${THEME}.png`));
fs.copyFileSync(path.join(stateDir, `find-${THEME}.png`), `/tmp/synopia-find/find-${THEME}.png`);
await enter(true);
check('Shift+Enter: the one before, 2 of 4', await countIs('2 of 4'));

// the first match is in the first page, not loaded: Shift+Enter loads earlier pages until it is there
await enter(true);
check('Shift+Enter to a match in an earlier page: 1 of 4', await countIs('1 of 4'));
check('its page and those after it load', await until(`__synopia.cur().items.length >= ${N - 160} && !__synopia.restoring()`, 15000), String(await ev('__synopia.cur().items.length')));
check('the earlier match is shown, near the top, marked current', await until(`(() => { const h = CSS.highlights.get('tf-cur'); if (!h?.size) return false; const r = [...h][0], rr = r.getBoundingClientRect(), lr = document.getElementById('log').getBoundingClientRect();
  return rr.top >= lr.top && rr.top < lr.top + 120 && r.toString() === 'Quokka' && r.startContainer.parentElement.closest('[data-key]').dataset.key === 'm3:0'; })()`, 8000), JSON.stringify(await cur()));
await cmdG(true);
check('Shift+⌘G wraps to the last, 4 of 4', await countIs('4 of 4'));
await cmdG();
check('⌘G wraps to the first, 1 of 4', await countIs('1 of 4'));
await cmdG();
check('⌘G: 2 of 4', await countIs('2 of 4'));

// Esc closes it; the view stays at the match
await sleep(300);
const before = await ev(`document.getElementById('log').scrollTop`), anchor = await ev('JSON.stringify(__synopia.anchor())');
await K.esc();
check('Esc closes the bar, its marks gone', await until(`!__synopia.find().shown && !document.getElementById('tf-find') && !CSS.highlights.get('tf-cur')`));
await sleep(300);
check('the view stays where the match put it', (await ev(`document.getElementById('log').scrollTop`)) === before && (await ev('JSON.stringify(__synopia.anchor())')) === anchor && (await ev('__synopia.mode()')) === 'normal');

// No matches; then from insert mode
await K.cmdF();
await until(`document.activeElement?.id === 'tf-q'`);
await ev(`(() => { const q = document.getElementById('tf-q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
await type('no such animal');
check('"No matches"', await countIs('No matches'));
await K.esc();
await K.i();
check('insert mode', await until(`__synopia.mode() === 'insert' && document.activeElement?.id === 'msg'`));
await K.cmdF();
check('⌘F in insert mode opens the bar too', await until(`__synopia.find().shown && document.activeElement?.id === 'tf-q'`));
await K.esc();
check('Esc from it goes back to the message box', await until(`!__synopia.find().shown && __synopia.mode() === 'insert' && document.activeElement?.id === 'msg'`));
await K.esc();

const lt = await stopLong();
check(`no long task over ${LONG} ms on the long transcript`, Math.max(0, ...lt) <= LONG, `long tasks ${JSON.stringify(lt)}`);

// a subagent's view searches its own transcript
await ev(`document.querySelector('#conv [data-agent="${AID}"], .rail [data-agent="${AID}"]').click()`);
check('the subagent view', await until(`__synopia.view() === '${AID}' && __synopia.mounted() === '${SID}|${AID}'`));
await K.cmdF();
await until(`document.activeElement?.id === 'tf-q'`);
await ev(`document.getElementById('log').scrollTop = 0`);
await type('wallaby');
check('the subagent view finds its own matches: 1 of 3', await countIs('1 of 3'), JSON.stringify(await F()));
check('the find names the subagent', (await sent('find')).pop()?.view === AID);
await ev(`(() => { const q = document.getElementById('tf-q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
await type('quokka');
check('and not the main conversation: "No matches" for quokka', await countIs('No matches'));
await K.esc();

console.log(`long tasks ${JSON.stringify(lt)}`);
c.print();
c.close();
