// folders.ts (R3.3, R3.13, NFR-13): the known folders read no disk, completion reads exactly one folder,
// gone checks stat only the paths named (protected ones only when chosen), and create is one mkdir -p.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Folders, expand, isProtected, knownFolders, realIo } from '../src/folders.ts';
import type { FolderIo } from '../src/folders.ts';

const HOME = '/Users/demo';

// The real disk calls, counted: what a test may assert reads and writes on.
function counted(io: FolderIo = realIo) {
  const calls: [string, string][] = [];
  const c: FolderIo = {
    readdir: (p) => { calls.push(['readdir', p]); return io.readdir(p); },
    stat: (p) => { calls.push(['stat', p]); return io.stat(p); },
    mkdir: (p) => { calls.push(['mkdir', p]); return io.mkdir(p); },
  };
  return { io: c, calls };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-folders-'));

test('expand: ~ and ~/… under home, absolute paths as they are, nothing relative', () => {
  assert.equal(expand('~', HOME), HOME);
  assert.equal(expand('~/dev/demo-app/', HOME), `${HOME}/dev/demo-app`);
  assert.equal(expand(' /tmp/x/../y ', HOME), '/tmp/y');
  assert.equal(expand('dev/x', HOME), null);
  assert.equal(expand('', HOME), null);
});

test('isProtected: the folders macOS asks about, and other volumes', () => {
  for (const p of ['Desktop', 'Documents/notes', 'Downloads', 'Pictures/x', 'Music', 'Movies', 'Library/Mobile Documents/x']) assert.equal(isProtected(`${HOME}/${p}`, HOME), true, p);
  assert.equal(isProtected('/Volumes/backup/x', HOME), true);
  for (const p of [`${HOME}/dev/demo-app`, `${HOME}/DocumentsOld`, HOME, '/tmp/x']) assert.equal(isProtected(p, HOME), false, p);
});

test('knownFolders: one row per folder, sessions counted once, newest first, home always there', () => {
  const rows = knownFolders(
    [{ id: 'a', cwd: `${HOME}/dev/demo-app`, openedAt: 5000 }, { id: 'z', cwd: `${HOME}/work/api`, openedAt: 100 }],
    [
      { sessionId: 'a', cwd: `${HOME}/dev/demo-app`, lastModified: 3000 },
      { sessionId: 'b', cwd: `${HOME}/dev/demo-app`, lastModified: 4000 },
      { sessionId: 'c', cwd: `${HOME}/dev/notes`, lastModified: 4500 },
      { sessionId: 'd', lastModified: 9000 }, // no folder: not a row
    ],
    HOME,
  );
  assert.deepEqual(rows, [
    { path: '~/dev/demo-app', sessions: 2, lastUsed: 5000 },
    { path: '~/dev/notes', sessions: 1, lastUsed: 4500 },
    { path: '~/work/api', sessions: 1, lastUsed: 100 },
    { path: '~', sessions: 0, lastUsed: 0 },
  ]);
  assert.deepEqual(knownFolders([], [], HOME), [{ path: '~', sessions: 0, lastUsed: 0 }], 'a first launch knows only home');
});

test('complete: exactly one readdir, of the folder typed so far; its child folders only, never deeper', async () => {
  const home = tmp();
  for (const d of ['dev/demo-app/src', 'dev/notes', 'dev/.hidden', 'dev/blog']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'dev', 'README.md'), 'made up');
  const { io, calls } = counted();
  const f = new Folders(home, io);
  const r = await f.complete('~/dev/de');
  assert.deepEqual(r, { path: '~/dev/', names: ['.hidden', 'blog', 'demo-app', 'notes'] });
  assert.deepEqual(calls, [['readdir', path.join(home, 'dev')]], 'one read, of ~/dev, nothing else');
  calls.length = 0;
  assert.deepEqual((await f.complete('~/')).names, ['dev']);
  assert.deepEqual(calls, [['readdir', home]], '~/ then Tab reads ~, only then');
  calls.length = 0;
  const gone = await f.complete('~/nope/x');
  assert.equal(gone.names.length, 0);
  assert.match(gone.error ?? '', /no folder ~\/nope\//);
  assert.deepEqual(calls, [['readdir', path.join(home, 'nope')]]);
  calls.length = 0;
  assert.ok((await f.complete('dev/x')).error, 'a relative path reads nothing');
  assert.deepEqual(calls, []);
});

test('check: one stat per path named; inside a protected folder only when chosen', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'dev', 'demo-app'), { recursive: true });
  const { io, calls } = counted();
  const f = new Folders(home, io);
  const r = await f.check(['~/dev/demo-app', '~/dev/gone', '~/Documents/notes', 'relative']);
  assert.deepEqual(r, [{ path: '~/dev/demo-app', gone: false }, { path: '~/dev/gone', gone: true }]);
  assert.deepEqual(calls.map((c) => c[1]), [path.join(home, 'dev/demo-app'), path.join(home, 'dev/gone')], 'Documents is left for when you choose it');
  calls.length = 0;
  assert.deepEqual(await f.check(['~/Documents/notes'], true), [{ path: '~/Documents/notes', gone: true }]);
  assert.equal(calls.length, 1);
});

test('ready: an existing folder, refused when missing; create runs one mkdir -p of that path', async () => {
  const home = tmp();
  const { io, calls } = counted();
  const f = new Folders(home, io);
  const miss = await f.ready('~/dev/new-app', false);
  assert.ok('error' in miss && /no folder ~\/dev\/new-app/.test(miss.error), JSON.stringify(miss));
  assert.ok(!calls.some((c) => c[0] === 'mkdir'), 'nothing made without create');
  calls.length = 0;
  const r = await f.ready('~/dev/new-app', true);
  assert.deepEqual(r, { abs: path.join(home, 'dev/new-app') });
  assert.deepEqual(calls.filter((c) => c[0] === 'mkdir'), [['mkdir', path.join(home, 'dev/new-app')]]);
  assert.equal(fs.statSync(path.join(home, 'dev/new-app')).isDirectory(), true);
  assert.ok('error' in (await f.ready('dev/x', true)), 'a relative path is refused, nothing made');
});
