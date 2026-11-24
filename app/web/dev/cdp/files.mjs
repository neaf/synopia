// Files changed with a Bash command's edits (bashEditDiff, R5.9) on the fixture tree's tools session.
// usage: node files.mjs <url> <state-dir>
// Checks: a file edited by a tool and by the shell shows once with summed counts and both diffs, a
// file the shell created reads "new", a changed file with no diff has no counts, "and 2 more files",
// the total, and the Bash step stays a "Bash(…)" line. Writes files-changed.png.
import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from './cdp.mjs';

const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
await c.load(url + '#11111111', `current?.startsWith('11111111')`);
const until = async (expr, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
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
fs.writeFileSync(path.join(stateDir, 'files-changed.png'), Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png', clip })).result.data, 'base64'));
c.print();
c.close();
