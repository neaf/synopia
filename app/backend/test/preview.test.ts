import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ansiToHtml, planPreview, capText, looksText, color256, themeOf, findBat, parseLanguages, langOf, batArgs, render, previewFile,
  MAX_LINES, MAX_BYTES,
} from '../src/preview.ts';
import type { RunBat, PreviewReply } from '../src/preview.ts';

const dir = mkdtempSync(join(tmpdir(), 'synopia-preview-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body: string | Buffer = 'x\n', mode = 0o644): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};
const E = '\x1b[';

test('ansi: 24-bit colours, resets and plain text', () => {
  assert.equal(ansiToHtml(`${E}38;2;167;29;93mconst${E}0m a`), '<span style="color:#a71d5d">const</span> a');
  assert.equal(ansiToHtml(`${E}38;2;1;2;3mx${E}0my${E}mz`), '<span style="color:#010203">x</span>yz');
  assert.equal(ansiToHtml(`${E}31mred${E}39m back`), '<span style="color:#cf222e">red</span> back');
});

test('ansi: bold, italic and 256 colours', () => {
  assert.equal(ansiToHtml(`${E}1;38;5;196mb${E}22mn`), '<span style="color:#ff0000;font-weight:700">b</span><span style="color:#ff0000">n</span>');
  assert.equal(ansiToHtml(`${E}3mi${E}0m`), '<span style="font-style:italic">i</span>');
  assert.equal(color256(16), '#000000');
  assert.equal(color256(231), '#ffffff');
  assert.equal(color256(232), '#080808');
  assert.equal(color256(1), '#cf222e');
  // a background colour is skipped with its parameters, not read as a foreground
  assert.equal(ansiToHtml(`${E}48;2;9;9;9mx`), 'x');
});

test('ansi: the dark theme draws the basic colours from the dark palette, still as escaped style spans', () => {
  assert.equal(ansiToHtml(`${E}31mred${E}39m <b>`, 'dark'), '<span style="color:#ff7b72">red</span> &lt;b&gt;');
  assert.equal(ansiToHtml(`${E}38;5;2mg`, 'dark'), '<span style="color:#3fb950">g</span>');
  assert.equal(color256(1, 'dark'), '#ff7b72');
  assert.equal(color256(196, 'dark'), '#ff0000'); // the cube and the greys are the same in both
  assert.equal(themeOf('dark'), 'dark');
  assert.equal(themeOf('<x>'), 'light');
  assert.ok(batArgs('/x/a.ts', false, 'dark').includes('--theme=Coldark-Dark'));
  assert.ok(batArgs('/x/a.ts', false).includes('--theme=GitHub'));
});

test('ansi: <, & and quotes inside code are escaped', () => {
  const h = ansiToHtml(`${E}38;2;24;54;145m"<a href='x'>&amp;"${E}0m`);
  assert.equal(h, '<span style="color:#183691">&quot;&lt;a href=&#39;x&#39;&gt;&amp;amp;&quot;</span>');
  assert.ok(!/<(?!\/?span)/.test(h));
});

test('ansi: spans close at the end of each line, and colour carries to the next', () => {
  const h = ansiToHtml(`${E}38;2;1;1;1ma\nb${E}0m\n\nc`);
  assert.deepEqual(h.split('\n'), ['<span style="color:#010101">a</span>', '<span style="color:#010101">b</span>', '', 'c']);
  // neighbouring runs of one style make one span
  assert.equal(ansiToHtml(`${E}38;2;1;1;1m'${E}0m${E}38;2;1;1;1mx'${E}0m`), `<span style="color:#010101">&#39;x&#39;</span>`);
  // other escapes and control characters are dropped
  assert.equal(ansiToHtml(`${E}2Kx\x07\ry\x1b`), 'xy');
});

test('preview: path checks', () => {
  assert.equal(planPreview('rel/x.ts').ok, false);
  assert.match((planPreview('rel/x.ts') as { error: string }).error, /not absolute/);
  assert.match((planPreview(join(dir, 'gone.ts')) as { error: string }).error, /no longer exists/);
  assert.equal(planPreview(undefined).ok, false);
  const ts = file('a.ts', 'const a = 1;\n');
  assert.deepEqual(planPreview(ts), { ok: true, how: 'preview', real: realpathSync(ts), size: 13 });
  assert.equal((planPreview(file('Makefile', 'all:\n')) as { how: string }).how, 'preview');
  assert.equal((planPreview(file('page.html', '<p>\n')) as { how: string }).how, 'preview'); // the page decides when
  // images and PDFs open as before; viewing runs nothing, so scripts and executables preview
  for (const p of [file('pic.png'), file('doc.pdf')]) {
    assert.equal((planPreview(p) as { how: string }).how, 'open', p);
  }
  for (const p of [file('run.sh', 'echo hi\n'), file('tool.ts', 'x', 0o755), file('build.py', 'print(1)\n')]) {
    assert.equal((planPreview(p) as { how: string }).how, 'preview', p);
  }
  const folder = join(dir, 'folder');
  mkdirSync(folder);
  assert.equal((planPreview(folder) as { how: string }).how, 'open');
  // a text name that links to an image is judged by both names
  const link = join(dir, 'notes.txt');
  symlinkSync(file('thing.png', 'x'), link);
  assert.equal((planPreview(link) as { how: string }).how, 'open');
});

test('preview: binary detection', () => {
  assert.equal(looksText(Buffer.from('hello\n')), true);
  assert.equal(looksText(Buffer.from([0x68, 0x00, 0x69])), false);
  assert.equal((planPreview(file('blob', Buffer.from([1, 2, 0, 3]))) as { how: string }).how, 'open');
  assert.equal((planPreview(file('data.json', Buffer.concat([Buffer.from('{}'), Buffer.alloc(4)]))) as { how: string }).how, 'open');
  // a NUL after the first 8 KB is not looked at
  assert.equal((planPreview(file('late', Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.alloc(1)]))) as { how: string }).how, 'preview');
});

test('preview: truncation at 5,000 lines and 2 MB', () => {
  const small = capText(Buffer.from('a\nb\n'), 4);
  assert.deepEqual(small, { text: 'a\nb', lines: 2, truncated: false });
  const many = Buffer.from(Array.from({ length: MAX_LINES + 10 }, (_, i) => `l${i}`).join('\n') + '\n');
  const c = capText(many, many.length);
  assert.equal(c.lines, MAX_LINES);
  assert.equal(c.truncated, true);
  assert.ok(c.text.endsWith(`l${MAX_LINES - 1}`));
  // a byte cut ends at the last whole line
  const cut = capText(Buffer.from('one\ntwo\nthr'), 100);
  assert.deepEqual(cut, { text: 'one\ntwo', lines: 2, truncated: true });
  assert.ok(batArgs('/x/a.ts', true).includes(`--line-range=:${MAX_LINES}`));
  assert.ok(!batArgs('/x/a.ts', false).some((a) => a.startsWith('--line-range')));
  assert.equal(MAX_BYTES, 2097152);
});

test('preview: bat missing gives plain escaped text', async () => {
  assert.equal(findBat({ PATH: dir }, []), null);
  const p = file('b.ts', 'if (a < b && c) "q"\n');
  const r = await render(p, p, 20, { bat: null });
  assert.equal(r.html, 'if (a &lt; b &amp;&amp; c) &quot;q&quot;');
  assert.equal(r.lang, 'Plain text');
  assert.equal(r.lines, 1);
});

test('preview: bat output is converted, and a failing bat falls back to plain', async () => {
  const p = file('c.ts', 'x <y>\n');
  const langs = parseLanguages('TypeScript:ts,mts\nMakefile:make,Makefile,*.mk\n');
  assert.equal(langOf('/a/Makefile', { file: '/b', langs }), 'Makefile');
  assert.equal(langOf('/a/x.TS', { file: '/b', langs }), 'TypeScript');
  let seen: string[] = [], input = '';
  const ok: RunBat = (_f, args, inp, done) => { seen = args; input = inp; done(null, `${E}38;2;1;2;3mx${E}0m &lt;y>\n`); };
  const r = await render(p, p, 6, { bat: { file: '/bin/bat', langs }, run: ok, display: (s) => s.replace(dir, '~') });
  assert.equal(r.html, '<span style="color:#010203">x</span> &amp;lt;y&gt;');
  assert.equal(r.lang, 'TypeScript');
  assert.equal(r.display, '~/c.ts');
  assert.equal(input, 'x <y>');
  assert.ok(seen.includes('--theme=GitHub') && seen.includes('--file-name=c.ts') && seen.includes('--paging=never'));
  const bad: RunBat = (_f, _a, _i, done) => done(Object.assign(new Error('timeout'), { killed: true }), '');
  assert.equal((await render(p, p, 6, { bat: { file: '/bin/bat', langs }, run: bad })).html, 'x &lt;y&gt;');
});

test('preview: the message replies, opens what is not text, or toasts', async () => {
  const got: { reply?: PreviewReply; open?: string; toast?: string } = {};
  const opts = { bat: null, reply: (r: PreviewReply) => { got.reply = r; }, open: (p: string) => { got.open = p; }, toast: (t: string) => { got.toast = t; } };
  await previewFile(file('d.md', '# hi\n'), opts);
  assert.equal(got.reply?.t, 'preview');
  const png = file('e.png');
  await previewFile(png, opts);
  assert.equal(got.open, png);
  await previewFile('nope', opts);
  assert.match(got.toast ?? '', /not absolute/);
});
