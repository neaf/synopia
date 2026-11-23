import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { acquireLock, LockedError } from '../src/lock.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-lock-'));
const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

test('a second lock on the same folder is refused', () => {
  const dir = tmp();
  const lock = acquireLock(dir);
  assert.throws(() => acquireLock(dir), LockedError);
  lock.release();
  assert.equal(existsSync(join(dir, 'backend.lock')), false);
  acquireLock(dir).release();
});

test('a stale lock from a dead process is taken over', () => {
  const dir = tmp();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(join(dir, 'backend.lock'), String(dead));
  const lock = acquireLock(dir);
  lock.release();
});

test('a second backend on the same state folder exits, the first exits on stdin close', async () => {
  const dir = tmp();
  const first = spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const [line] = (await once(createInterface({ input: first.stdout! }), 'line')) as [string];
  const hello = JSON.parse(line);
  assert.ok(hello.port > 0);
  assert.match(hello.token, /^[0-9a-f]{64}$/);

  const second = spawnSync(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir], { input: '', encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Another Synopia backend/);
  assert.equal(second.stdout, '');

  first.stdin!.end();
  const [code] = await once(first, 'exit');
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, 'backend.lock')), false);
});
