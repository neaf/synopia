import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { displayPath, displayIn } from '../src/paths.ts';
import { patchOf, toolLine } from '../src/transcript.ts';
import { fileEditOf } from '../src/claude-jsonl.ts';

const realTmp = fs.realpathSync('/tmp');

test('paths: the real path of /tmp reads /tmp, home reads ~, other paths stay', () => {
  assert.equal(displayPath(`${realTmp}/synopia-scratch/x`, '/Users/fixture'), '/tmp/synopia-scratch/x');
  assert.equal(displayPath('/tmp/x', '/Users/fixture'), '/tmp/x');
  assert.equal(displayPath('/Users/fixture/dev/a', '/Users/fixture'), '~/dev/a');
  assert.equal(displayPath('/Users/fixture', '/Users/fixture'), '~');
  assert.equal(displayPath('/Users/fixturefoo/a', '/Users/fixture'), '/Users/fixturefoo/a', 'only whole path parts');
  assert.equal(displayPath('/opt/x', ''), '/opt/x');
});

test('paths: a home reached through a link reads ~ by its real path too', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-paths-')));
  const realHome = path.join(dir, 'real-home');
  fs.mkdirSync(realHome);
  const link = path.join(dir, 'home');
  fs.symlinkSync(realHome, link);
  assert.equal(displayPath(path.join(realHome, 'dev', 'a'), link), '~/dev/a');
  assert.equal(displayPath(path.join(link, 'dev', 'a'), link), '~/dev/a');
  assert.equal(displayIn(`cat ${realHome}/notes.txt`, link), 'cat ~/notes.txt');
});

test('paths: files changed and tool lines show /tmp, not its real path', () => {
  const abs = `${realTmp}/synopia-scratch/s/notes.txt`;
  const p = patchOf(fileEditOf({ type: 'create', filePath: abs, structuredPatch: [] })!, '/Users/fixture');
  assert.deepEqual([p.file, p.abs], ['/tmp/synopia-scratch/s/notes.txt', abs], 'shown mapped, opened by its real path');
  assert.deepEqual(toolLine('Read', { file_path: abs }, '/Users/fixture'), ['Read', '/tmp/synopia-scratch/s/notes.txt']);
});

test('formats#B3: a path inside a text maps only where a path starts', () => {
  const home = '/Users/fixture';
  assert.equal(displayIn('see https://host/Users/fixture/a and /Users/fixture/b', home), 'see https://host/Users/fixture/a and ~/b');
  assert.equal(displayIn(`ls /mnt${realTmp}/a ${realTmp}/b`, home), `ls /mnt${realTmp}/a /tmp/b`);
  assert.equal(displayIn(`cd "/Users/fixture/x" && cat (/Users/fixture) --out=/Users/fixture/y,/Users/fixture/z`, home), 'cd "~/x" && cat (~) --out=~/y,~/z');
  assert.equal(displayIn('/Users/fixture/start', home), '~/start');
});
