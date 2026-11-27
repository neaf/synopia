// Files changed with a Bash command's edits (bashEditDiff, R5.9) on the fixture tree's tools session.
// usage: node files.mjs <url> <state-dir>
// Checks: a file edited by a tool and by the shell shows once with summed counts and both diffs, a
// file the shell created reads "new", a changed file with no diff has no counts, "and 2 more files",
// the total, and the Bash step stays a "Bash(…)" line. An expanded Edit or Write step shows its diff in
// the Files changed markup with +N −M on its line, a long one cut at 20 lines with "Show all", from a closed
// group too; a failed edit shows its error and no diff; a subagent's edit has no line numbers.
// Writes files-changed.png and files-edit-step-<theme>.png.
import path from 'node:path';
import { shot } from './helpers.mjs';
import { connect, sleep } from './cdp.mjs';

const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, until } = c;
await c.load(url + '#11111111', `__synopia.current()?.startsWith('11111111')`);
check('the files block shows', await until(`!!document.querySelector('.ln.files')`));
const rows = await ev(`[...document.querySelectorAll('.ln.files .frow')].map(r => [r.querySelector('.fp').textContent, r.querySelector('.fc')?.textContent.replace(/\\s+/g, ' ').trim() || ''])`);
const row = (f) => (rows.find((r) => r[0] === f) || [])[1];
check('notes.md once, edit and shell counts summed', rows.filter((r) => r[0] === 'notes.md').length === 1 && row('notes.md') === '+3 −2', JSON.stringify(rows));
check('the created script reads new', row('scripts/tidy.sh') === 'new +2 −0', JSON.stringify(rows));
check('a changed file with no diff has no counts', row('.tidy-stamp') === '', JSON.stringify(rows));
check('and 2 more files', await ev(`[...document.querySelectorAll('.ln.files .root')].pop().textContent`) === 'and 2 more files');
check('the total counts the more files', /^7 files,/.test(await ev(`document.querySelector('.ln.files .name + .dim').textContent`)));
check('the Bash step is a step line, Bash(…), not a run row (R5.6, 2026-11-26)', await ev(`!document.querySelector('#log .runrow') && [...document.querySelectorAll('#log details.step > summary')].some(r => r.textContent.includes('Bash(Reword the second idea and add the tidy script)'))`));
await ev(`[...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'notes.md').querySelector('.fc').click()`);
const diff = await ev(`(() => { const b = [...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'notes.md').querySelector('.fc'); const d = document.getElementById(b.getAttribute('aria-controls')); return d.hidden ? '' : d.textContent; })()`);
check('the notes.md diff has both changes', diff.includes('the first idea') && diff.includes('a second, better idea') && diff.includes('next edit'), diff.slice(0, 200));
await ev(`document.querySelector('.ln.files').scrollIntoView({ block: 'start' })`);
await sleep(200);
const clip = await ev(`(() => { const r = document.querySelector('.ln.files').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(900, r.width + 40), height: Math.min(700, r.height + 20), scale: 1 }; })()`);
await shot(c, path.join(stateDir, 'files-changed.png'), clip);

// An expanded Edit or Write step shows its diff (R5.6, 2026-11-25): the Files changed markup, +N −M on its line.
const STEP = (id) => `document.querySelector('details.step[data-step="${id}"]')`;
const openStep = async (id) => { await ev(`(() => { const d = ${STEP(id)}, f = d.closest('details.fold'); if (f) f.open = true; d.querySelector('summary').click(); })()`); return until(`${STEP(id)}.open`); };
// it sits in a collapsed group ("Edited 1 file, wrote 2 files"): the group opens to its steps, then the step to its diff
const grp = await ev(`(() => { const f = ${STEP('toolu_edit1')}?.closest('details.fold'); return !!f && !f.open && f.querySelector('summary').textContent; })()`);
check('the Edit sits in a closed group', typeof grp === 'string' && /edited 1 file/i.test(grp), JSON.stringify(grp));
check('the Edit step expands from its group', await openStep('toolu_edit1'));
const ed = await ev(`(() => { const d = ${STEP('toolu_edit1')}, b = d.querySelector('.step-out .diff'), f = [...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'notes.md').nextElementSibling;
  const rows = e => [...e.children].map(x => x.outerHTML), fr = rows(f), cut = fr.findIndex(h => h.includes('next edit'));
  return b && { same: JSON.stringify(rows(b)) === JSON.stringify(fr.slice(0, cut)), cls: b.className, out: !!d.querySelector('.step-out .out'), counts: d.querySelector('summary .dc')?.textContent,
    colors: ['add', 'del'].map(k => getComputedStyle(d.querySelector('summary .dc .' + k)).color === getComputedStyle(document.querySelector('.ln.files .fc .' + k)).color),
    look: ['.dl.a', '.dl.d', '.dl .no'].every(s => ['backgroundColor', 'color', 'fontFamily'].every(p => getComputedStyle(b.querySelector(s))[p] === getComputedStyle(f.querySelector(s))[p])),
    border: getComputedStyle(b).borderTopWidth }; })()`);
check('the expanded Edit shows the diff with the Files changed markup', !!ed && ed.same && ed.cls === 'diff' && !ed.out && ed.look && ed.border === '1px', JSON.stringify(ed));
check('its line shows +2 −1 in the Files changed colours', !!ed && ed.counts === '+2 −1' && ed.colors.every(Boolean), JSON.stringify(ed));
check('the Edit step closes', await ev(`(() => { ${STEP('toolu_edit1')}.querySelector('summary').click(); return !${STEP('toolu_edit1')}.open; })()`));
// big.md, a Write of a long made-up file, in the same group
check('the long Write expands', await openStep('toolu_write2'));
const big = () => ev(`(() => { const d = ${STEP('toolu_write2')}; return { rows: d.querySelectorAll('.step-out .diff .dl').length, more: d.querySelector('.step-out [data-full]')?.textContent || '', counts: d.querySelector('summary .dc')?.textContent || '' }; })()`);
const b1 = await big();
check('a long diff shows 20 lines and "Show all N lines"', b1.rows === 20 && /^Show all \d+ lines$/.test(b1.more) && +b1.more.match(/\d+/)[0] > 20, JSON.stringify(b1));
check('the group row shows the counts', /^\+\d+ −0$/.test(b1.counts), JSON.stringify(b1));
await ev(`${STEP('toolu_write2')}.querySelector('[data-full]').click()`);
check('show all opens the whole diff in place', await until(`(() => { const d = ${STEP('toolu_write2')}; return d.open && d.querySelectorAll('.step-out .diff .dl').length === ${+(b1.more.match(/\d+/) || [0])[0]} && !d.querySelector('[data-full]'); })()`));
await ev(`${STEP('toolu_edit1')}.querySelector('summary').click()`);
await ev(`${STEP('toolu_edit1')}.closest('.ln').scrollIntoView({ block: 'start' })`);
await sleep(200);
const eclip = await ev(`(() => { const r = ${STEP('toolu_edit1')}.closest('.ln').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(900, r.width + 40), height: Math.min(700, r.height + 20), scale: 1 }; })()`);
await shot(c, path.join(stateDir, `files-edit-step-${process.env.SYNOPIA_CDP_THEME === 'dark' ? 'dark' : 'light'}.png`), eclip);
// a failed edit (invented): its error as today, no diff, no counts
await ev(`(() => { const s = __synopia.cur(); __synopia.inject({ t: 'items', sid: s.id, agent: null, upsert: [{ id: 'toolu_editfail', k: 'tool', ts: '2026-11-20T10:09:00.000Z', name: 'Edit', verb: 'Edited', obj: 'notes.md', state: 'failed', out: { text: 'String to replace not found in file.', lines: 1, cut: false } }], total: s.total + 1 }); })()`);
check('the failed Edit shows', await until(`!!${STEP('toolu_editfail')}`));
await openStep('toolu_editfail');
const fe = await ev(`(() => { const d = ${STEP('toolu_editfail')}; return { open: d.open, diff: !!d.querySelector('.diff'), counts: !!d.querySelector('.dc'), text: d.querySelector('.step-out').innerText }; })()`);
check('a failed edit shows its error and no diff', fe.open && !fe.diff && !fe.counts && fe.text.includes('String to replace not found'), JSON.stringify(fe));

// A fork's edits in a sibling folder outside the session's cwd, whose records have no toolUseResult (an
// SDK-driven subagent, docs/Claude Code transcripts.md "Quirk: a subagent's edits have no structuredPatch"):
// they show in its Files changed, grouped by folder, and the diff has no line numbers.
await ev(`document.querySelector('.row[data-id^="44444444"]').click()`);
check('the fork is listed', await until(`__synopia.current()?.startsWith('44444444') && !!document.querySelector('#conv [data-agent="aaaa0003"]')`));
await ev(`document.querySelector('#conv [data-agent="aaaa0003"]').click()`);
check('the fork view has Files changed', await until(`__synopia.view() === 'aaaa0003' && !!document.querySelector('.ln.files')`));
const frows = await ev(`[...document.querySelectorAll('.ln.files .frow')].map(r => [r.querySelector('.fp').textContent, r.querySelector('.fc')?.textContent.replace(/\\s+/g, ' ').trim() || ''])`);
const frow = (f) => (frows.find((r) => r[0] === f) || [])[1];
check('the Edit outside cwd has its counts', frow('approach.ts') === '+1 −1', JSON.stringify(frows));
check('the Write has its counts, not new', frow('NOTES.md') === '+3 −0', JSON.stringify(frows));
const roots = await ev(`[...document.querySelectorAll('.ln.files .root')].map(r => r.textContent)`);
check('grouped under the sibling folder', roots.length > 0 && roots.every((r) => r.includes('fixture.other-approach')), JSON.stringify(roots));
await ev(`[...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'approach.ts').querySelector('.fc').click()`);
const fd = await ev(`(() => { const b = [...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'approach.ts').querySelector('.fc'); const d = document.getElementById(b.getAttribute('aria-controls')); return d.hidden ? null : { text: d.textContent, rows: d.querySelectorAll('.dl').length, nos: [...d.querySelectorAll('.dl .no')].map(n => n.textContent).join('') }; })()`);
check('the diff opens with its rows and no line numbers', !!fd && fd.rows === 4 && fd.nos === '' && fd.text.includes('Math.min(...list)') && fd.text.includes('list.sort()[0]'), JSON.stringify(fd)?.slice(0, 200));
const subId = await ev(`[...document.querySelectorAll('details.step[data-step]')].find(d => /^Edit\\(.*approach\\.ts/.test(d.querySelector('summary').textContent.trim()))?.dataset.step || ''`);
check('the subagent Edit step expands', !!subId && await openStep(subId), subId);
const sd = subId && await ev(`(() => { const d = ${STEP(subId)}; return { rows: d.querySelectorAll('.step-out .diff .dl').length, nos: [...d.querySelectorAll('.step-out .diff .dl .no')].map(n => n.textContent).join(''), counts: d.querySelector('summary .dc')?.textContent }; })()`);
check('its diff has no line numbers, as in Files changed', !!sd && sd.rows === 4 && sd.nos === '' && sd.counts === '+1 −1', JSON.stringify(sd));
for (const theme of ['light', 'dark']) {
  await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await ev(`document.querySelector('.ln.files').scrollIntoView({ block: 'start' })`);
  await sleep(200);
  const box = await ev(`(() => { const r = document.querySelector('.ln.files').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(900, r.width + 40), height: Math.min(700, r.height + 20), scale: 1 }; })()`);
  await shot(c, path.join(stateDir, `files-subagent-${theme}.png`), box);
}
c.print();
c.close();
