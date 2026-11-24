// daemon-files.ts: daemon.json (with `handover`), backend.lock, daemon.log rotation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  LockedError, acquireLock, clearStaleDaemonInfo, isLive, lockOwner, markHandover, ownStart, parseDaemonInfo, readDaemonInfo,
  removeDaemonInfo, rotateLog, writeDaemonInfo,
} from '../src/daemon-files.ts';
import type { DaemonInfo } from '../src/daemon-files.ts';
import { procStart } from '../src/macos.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-files-'));
const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
const TAKER = new URL('./support/lock-taker.ts', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const TOKEN = 'a'.repeat(64);
const info = (o: Partial<DaemonInfo> = {}): DaemonInfo => ({ pid: 4242, procStart: 'Tue Nov 24 10:00:00 2026', port: 4717, token: TOKEN, version: '0.1.0', code: '0123456789abcdef', v: 1, ...o });
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

test('daemon.json: a good file parses, any wrong field is null', () => {
  assert.deepEqual(parseDaemonInfo(JSON.stringify(info())), info());
  const h = info({ handover: { reason: 'update', successor: 4343 } });
  assert.deepEqual(parseDaemonInfo(JSON.stringify(h)), h);
  for (const bad of [
    '', '{', 'null', '[]', '{}',
    JSON.stringify(info({ pid: 0 })), JSON.stringify(info({ pid: 1.5 })), JSON.stringify({ ...info(), pid: '4242' }),
    JSON.stringify(info({ port: 0 })), JSON.stringify(info({ port: 70000 })),
    JSON.stringify(info({ token: 'short' })), JSON.stringify(info({ token: 'Z'.repeat(64) })),
    JSON.stringify({ ...info(), procStart: undefined }), JSON.stringify({ ...info(), version: 1 }),
    JSON.stringify({ ...info(), code: undefined }), JSON.stringify({ ...info(), v: '1' }),
    JSON.stringify({ ...info(), handover: null }), JSON.stringify({ ...info(), handover: { reason: 'idle', successor: 5 } }),
    JSON.stringify({ ...info(), handover: { reason: 'restart', successor: 0 } }),
  ]) assert.equal(parseDaemonInfo(bad), null, bad);
});

test('daemon.json is written atomically with mode 0600 and removed only by its own daemon', () => {
  const dir = tmp();
  writeDaemonInfo(dir, info());
  assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
  assert.deepEqual(readDaemonInfo(dir), info());
  assert.equal(existsSync(join(dir, 'daemon.json.4242.tmp')), false);
  removeDaemonInfo(dir, 1);
  assert.ok(existsSync(join(dir, 'daemon.json')), 'another pid leaves it');
  removeDaemonInfo(dir, 4242);
  assert.equal(readDaemonInfo(dir), null);
  writeFileSync(join(dir, 'daemon.json'), 'garbage');
  assert.equal(readDaemonInfo(dir), null);
  removeDaemonInfo(dir);
  assert.equal(existsSync(join(dir, 'daemon.json')), false);
});

test('handover: the old daemon marks its own daemon.json; the successor keeps a mark that names it', () => {
  const dir = tmp();
  assert.equal(markHandover(dir, 4242, { reason: 'update', successor: 4343 }), false, 'no file: nothing written');
  writeDaemonInfo(dir, info({ pid: 9 }));
  assert.equal(markHandover(dir, 4242, { reason: 'update', successor: 4343 }), false, "another daemon's file is left");
  assert.equal(readDaemonInfo(dir)?.handover, undefined);
  writeDaemonInfo(dir, info());
  assert.equal(markHandover(dir, 4242, { reason: 'restart', successor: 4343 }), true);
  assert.deepEqual(readDaemonInfo(dir), info({ handover: { reason: 'restart', successor: 4343 } }));
  assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
  clearStaleDaemonInfo(dir, 4444);
  assert.equal(readDaemonInfo(dir), null, 'a handover to another daemon is stale');
  writeDaemonInfo(dir, info({ handover: { reason: 'restart', successor: 4343 } }));
  clearStaleDaemonInfo(dir, 4343);
  assert.equal(readDaemonInfo(dir)?.handover?.successor, 4343, 'kept for the shell until the successor writes its own');
  writeDaemonInfo(dir, info({ pid: 4343 }));
  assert.equal(readDaemonInfo(dir)?.handover, undefined, 'the successor overwrites it');
});

test('a stale daemon.json is not live: dead pid, reused pid, or no recorded start', async () => {
  const probe = (alive: boolean, start: string | null) => ({ alive: () => alive, startOf: async () => start });
  const i = info();
  assert.equal(await isLive(i, probe(true, i.procStart)), true);
  assert.equal(await isLive(i, probe(false, i.procStart)), false, 'dead pid');
  assert.equal(await isLive(i, probe(true, 'Wed Nov 25 09:00:00 2026')), false, 'pid reused by another process');
  assert.equal(await isLive(i, probe(true, null)), false, 'ps failed');
  assert.equal(await isLive(info({ procStart: '' }), probe(true, '')), false);
  assert.equal(await isLive(null), false);
  // The real probe: this process is live under its own start time, a finished one isn't.
  assert.equal(await isLive(info({ pid: process.pid, procStart: await ownStart() })), true);
  assert.equal(await isLive(info({ pid: deadPid() })), false);
  assert.match(await ownStart(), /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
  assert.equal(await procStart(process.pid), await ownStart(), 'as printed, not squashed: the app compares the string');
});

test("ownStart: asks ps again after a failure, '' when it never answers", async () => {
  let n = 0;
  assert.equal(await ownStart(1, async () => (++n < 3 ? null : 'Tue Nov 24 10:00:00 2026')), 'Tue Nov 24 10:00:00 2026');
  assert.equal(n, 3);
  assert.equal(await ownStart(1, async () => null), '');
});

test('the lock: a second taker is refused with the owner pid; a release frees it; the file stays, emptied', () => {
  const dir = tmp();
  const lock = acquireLock(dir);
  assert.equal(readFileSync(join(dir, 'backend.lock'), 'utf8'), String(process.pid));
  assert.equal(lockOwner(dir), process.pid);
  assert.deepEqual(readdirSync(dir), ['backend.lock'], 'no temp file');
  // a second open in this process is a second taker too (flock is per open file)
  assert.throws(() => acquireLock(dir), (e) => e instanceof LockedError && e.pid === process.pid);
  lock.release();
  lock.release();
  assert.deepEqual(readdirSync(dir), ['backend.lock'], 'never removed (docs/Daemon files.md#lock)');
  assert.equal(lockOwner(dir), null, 'emptied on release');
  acquireLock(dir).release();
});

test('a lock file left by a dead daemon is no hold: the next taker gets it', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'backend.lock'), String(deadPid()));
  const lock = acquireLock(dir);
  assert.equal(lockOwner(dir), process.pid);
  lock.release();
});

test('the lock goes with the process, even on SIGKILL', async () => {
  const dir = tmp();
  const c = spawn(process.execPath, [...NODE_FLAGS, TAKER, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = createInterface({ input: c.stdout! });
  const said: string[] = [];
  out.on('line', (l) => said.push(l));
  while (!said.includes('ready')) await once(out, 'line');
  c.stdin!.write('go\n');
  while (said.length < 2) await once(out, 'line');
  assert.equal(said[1], 'won');
  assert.throws(() => acquireLock(dir), LockedError);
  c.kill('SIGKILL');
  await once(c, 'exit');
  acquireLock(dir).release();
});

test('eight starters racing for a stale lock: exactly one wins', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = tmp();
    writeFileSync(join(dir, 'backend.lock'), String(deadPid())); // a crashed daemon's
    const takers = Array.from({ length: 8 }, () => {
      const c = spawn(process.execPath, [...NODE_FLAGS, TAKER, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
      const said: string[] = [];
      const lines = createInterface({ input: c.stdout! });
      lines.on('line', (l) => said.push(l));
      return { c, said, lines };
    });
    try {
      for (const t of takers) while (!t.said.includes('ready')) await once(t.lines, 'line');
      for (const t of takers) t.c.stdin!.write('go\n'); // all at once, each still holding what it won
      for (const t of takers) while (t.said.length < 2) await once(t.lines, 'line');
      const results = takers.map((t) => t.said[1]).sort();
      assert.deepEqual(results, ['locked', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked', 'won'], `round ${round}`);
      const winner = takers.find((t) => t.said[1] === 'won')!;
      assert.equal(lockOwner(dir), winner.c.pid);
    } finally {
      for (const t of takers) { t.c.stdin!.end(); }
      await Promise.all(takers.map((t) => (t.c.exitCode === null ? once(t.c, 'exit') : null)));
    }
  }
});

test('a second backend on the same state folder exits 3, the first ends on SIGTERM', async () => {
  const dir = tmp();
  const first = spawn(process.execPath, [...NODE_FLAGS, MAIN, '--no-parent', '--state-dir', dir, '--claude-dir', tmp()], { stdio: ['pipe', 'pipe', 'pipe'] });
  const [line] = (await once(createInterface({ input: first.stdout! }), 'line')) as [string];
  const hello = JSON.parse(line);
  assert.ok(hello.port > 0);
  assert.match(hello.token, /^[0-9a-f]{64}$/);

  const second = spawnSync(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir], { input: '', encoding: 'utf8' });
  assert.equal(second.status, 3);
  assert.match(second.stderr, new RegExp(`Another Synopia backend \\(pid ${first.pid}\\)`));
  assert.equal(second.stdout, '');

  first.stdin!.end(); // no longer its lifetime
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(first.exitCode, null);
  first.kill('SIGTERM');
  const [code] = await once(first, 'exit');
  assert.equal(code, 0);
  assert.equal(lockOwner(dir), null);
  acquireLock(dir).release();
});

test('daemon.log rotates past its limit by copy and truncate', () => {
  const dir = tmp(), f = join(dir, 'daemon.log');
  writeFileSync(f, 'x'.repeat(100));
  assert.equal(rotateLog(f, 200), false);
  writeFileSync(f, 'y'.repeat(300));
  const fd = openSync(f, 'a'); // as the daemon's stdout: still writing after the rotation
  assert.equal(rotateLog(f, 200), true);
  assert.equal(readFileSync(`${f}.1`, 'utf8').length, 300);
  writeFileSync(fd, 'after\n');
  closeSync(fd);
  assert.equal(readFileSync(f, 'utf8'), 'after\n');
  assert.equal(rotateLog(join(dir, 'none.log')), false);
});
