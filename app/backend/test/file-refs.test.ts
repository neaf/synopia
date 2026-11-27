// file-refs.ts (R5.9, 2026-11-25): inline-code paths resolved against the session's folder and home, and the
// one image read the viewer makes. Over a temp tree of invented files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRefs, absOf, sniffImage } from '../src/file-refs.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-refs-')));
  const home = path.join(root, 'home'), cwd = path.join(home, 'dev', 'demo');
  fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs', 'Notes here.md'), '# notes\n');
  fs.writeFileSync(path.join(cwd, 'shot.png'), PNG);
  fs.writeFileSync(path.join(cwd, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(home, 'todo.txt'), 'x\n');
  fs.writeFileSync(path.join(home, 'Documents', 'private.txt'), 'x\n');
  return { root, home, cwd };
}
const by = (states: { p: string; path: string | null; kind: string | null }[]) => Object.fromEntries(states.map((s) => [s.p, [s.path, s.kind]]));

test('absOf: relative under cwd, ~ under home, absolute as is, nothing else', () => {
  assert.equal(absOf('a/b.ts', '/w/x', '/h'), '/w/x/a/b.ts');
  assert.equal(absOf('../c.md', '/w/x', '/h'), '/w/c.md');
  assert.equal(absOf('~/n.txt', '/w', '/h'), '/h/n.txt');
  assert.equal(absOf('/etc//hosts', '/w', '/h'), '/etc/hosts');
  assert.equal(absOf('a.ts', '', '/h'), null);
  assert.equal(absOf('a\0b', '/w', '/h'), null);
});

test('resolve: relative, ~, absolute, missing, folder; only existing ones get a path', async () => {
  const { root, home, cwd } = tree();
  const r = new FileRefs({ home });
  const s = by(await r.resolve('s1', cwd, ['docs/Notes here.md', '~/todo.txt', path.join(cwd, 'shot.png'), 'gone.md', 'docs', 'waiting-light.png', 42]));
  assert.deepEqual(s['docs/Notes here.md'], [path.join(cwd, 'docs', 'Notes here.md'), 'file']);
  assert.deepEqual(s['~/todo.txt'], [path.join(home, 'todo.txt'), 'file']);
  assert.deepEqual(s[path.join(cwd, 'shot.png')], [path.join(cwd, 'shot.png'), 'file']);
  assert.deepEqual(s['gone.md'], [null, null]);
  assert.deepEqual(s['docs'], [path.join(cwd, 'docs'), 'folder']);
  assert.deepEqual(s['waiting-light.png'], [null, null]); // a bare name not under cwd: no other folder is guessed
  assert.equal(Object.keys(s).length, 6); // not a string: left out
  fs.rmSync(root, { recursive: true });
});

test('resolve: a path in a folder macOS protects is not looked at, unless the session works there', async () => {
  const { root, home, cwd } = tree();
  const seen: string[] = [];
  const r = new FileRefs({ home, stat: (p) => { seen.push(p); return fs.promises.stat(p); } });
  assert.deepEqual(by(await r.resolve('s1', cwd, ['~/Documents/private.txt']))['~/Documents/private.txt'], [null, null]);
  assert.deepEqual(seen, []);
  const inside = path.join(home, 'Documents');
  assert.equal(by(await r.resolve('s2', inside, ['private.txt']))['private.txt'][1], 'file');
  fs.rmSync(root, { recursive: true });
});

test('image: only a file the session resolved, with an image name and image bytes', async () => {
  const { root, home, cwd } = tree();
  const r = new FileRefs({ home });
  const png = path.join(cwd, 'shot.png'), fake = path.join(cwd, 'fake.png'), md = path.join(cwd, 'docs', 'Notes here.md');
  assert.equal((await r.image('s1', 'file:' + png)).status, 404); // not resolved yet
  await r.resolve('s1', cwd, ['shot.png', 'fake.png', 'docs/Notes here.md']);
  const ok = await r.image('s1', 'file:' + png);
  assert.equal(ok.status, 200);
  assert.equal((ok as { type: string }).type, 'image/png');
  assert.equal((await r.image('s2', 'file:' + png)).status, 404); // another session's
  assert.equal((await r.image('s1', 'file:' + fake)).status, 415);
  assert.equal((await r.image('s1', 'file:' + md)).status, 415);
  assert.equal((await r.image('s1', 'file:relative.png')).status, 404);
  assert.equal(sniffImage(Buffer.from('GIF89a')), 'image/gif');
  fs.rmSync(root, { recursive: true });
});
