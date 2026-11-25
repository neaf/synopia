// Files changed with a Bash command's edits (bashEditDiff, R5.9) on the fixture tree's tools session.
// usage: node files.mjs <url> <state-dir>
// Checks: a file edited by a tool and by the shell shows once with summed counts and both diffs, a
// file the shell created reads "new", a changed file with no diff has no counts, "and 2 more files",
// the total, and the Bash step stays a "Bash(…)" line. Writes files-changed.png.
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
check('the Bash step is a Bash(…) line', await ev(`[...document.querySelectorAll('.ln.tool .body .res')].some(r => r.textContent.includes('Bash(Reword the second idea and add the tidy script)'))`));
await ev(`[...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'notes.md').querySelector('.fc').click()`);
const diff = await ev(`(() => { const b = [...document.querySelectorAll('.ln.files .frow')].find(r => r.querySelector('.fp').textContent === 'notes.md').querySelector('.fc'); const d = document.getElementById(b.getAttribute('aria-controls')); return d.hidden ? '' : d.textContent; })()`);
check('the notes.md diff has both changes', diff.includes('the first idea') && diff.includes('a second, better idea') && diff.includes('next edit'), diff.slice(0, 200));
await ev(`document.querySelector('.ln.files').scrollIntoView({ block: 'start' })`);
await sleep(200);
const clip = await ev(`(() => { const r = document.querySelector('.ln.files').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(900, r.width + 40), height: Math.min(700, r.height + 20), scale: 1 }; })()`);
await shot(c, path.join(stateDir, 'files-changed.png'), clip);

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
for (const theme of ['light', 'dark']) {
  await c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await ev(`document.querySelector('.ln.files').scrollIntoView({ block: 'start' })`);
  await sleep(200);
  const box = await ev(`(() => { const r = document.querySelector('.ln.files').getBoundingClientRect(); return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 10), width: Math.min(900, r.width + 40), height: Math.min(700, r.height + 20), scale: 1 }; })()`);
  await shot(c, path.join(stateDir, `files-subagent-${theme}.png`), box);
}
c.print();
c.close();
