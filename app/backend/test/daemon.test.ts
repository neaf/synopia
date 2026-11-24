import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  IdleExit, isLive, parseDaemonInfo, procStart, readDaemonInfo, removeDaemonInfo, rotateLog, writeDaemonInfo,
} from '../src/daemon.ts';
import type { DaemonInfo } from '../src/daemon.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-daemon-'));
const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/claude', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const TOKEN = 'a'.repeat(64);
const info = (o: Partial<DaemonInfo> = {}): DaemonInfo => ({ pid: 4242, procStart: 'Tue Nov 24 10:00:00 2026', port: 4717, token: TOKEN, version: '0.1.0', ...o });

test('daemon.json: a good file parses, any wrong field is null', () => {
  assert.deepEqual(parseDaemonInfo(JSON.stringify(info())), info());
  for (const bad of [
    '', '{', 'null', '[]', '{}',
    JSON.stringify(info({ pid: 0 })), JSON.stringify(info({ pid: 1.5 })), JSON.stringify({ ...info(), pid: '4242' }),
    JSON.stringify(info({ port: 0 })), JSON.stringify(info({ port: 70000 })),
    JSON.stringify(info({ token: 'short' })), JSON.stringify(info({ token: 'Z'.repeat(64) })),
    JSON.stringify({ ...info(), procStart: undefined }), JSON.stringify({ ...info(), version: 1 }),
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

test('a stale daemon.json is not live: dead pid, reused pid, or no recorded start', () => {
  const probe = (alive: boolean, start: string) => ({ alive: () => alive, startOf: () => start });
  const i = info();
  assert.equal(isLive(i, probe(true, i.procStart)), true);
  assert.equal(isLive(i, probe(false, i.procStart)), false, 'dead pid');
  assert.equal(isLive(i, probe(true, 'Wed Nov 25 09:00:00 2026')), false, 'pid reused by another process');
  assert.equal(isLive(info({ procStart: '' }), probe(true, '')), false);
  assert.equal(isLive(null), false);
  // The real probe: this process is live under its own start time, a finished one isn't.
  assert.equal(isLive(info({ pid: process.pid, procStart: procStart(process.pid) })), true);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  assert.equal(procStart(dead), '');
  assert.equal(isLive(info({ pid: dead })), false);
  assert.match(procStart(process.pid), /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
});

test('idle exit: only after the timeout with no page and nothing running', () => {
  const idle = new IdleExit(1000, 0);
  assert.equal(idle.check({ pages: 0, busy: false }, 999), false);
  assert.equal(idle.check({ pages: 0, busy: false }, 1000), true);
  const b = new IdleExit(1000, 0);
  assert.equal(b.check({ pages: 1, busy: false }, 900), false, 'a page resets the clock');
  assert.equal(b.check({ pages: 0, busy: false }, 1800), false);
  assert.equal(b.check({ pages: 0, busy: true }, 1850), false, 'running work resets it');
  assert.equal(b.check({ pages: 0, busy: true }, 5000), false, 'and holds it while it runs');
  assert.equal(b.check({ pages: 0, busy: false }, 5999), false);
  assert.equal(b.check({ pages: 0, busy: false }, 6000), true);
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

async function waitFor<T>(get: () => T | null | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

function daemon(dir: string, extra: string[] = []) {
  return spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir, '--fake', '--claude-dir', FIXTURES, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('the daemon writes daemon.json, answers ping and badge, and ends on POST /api/stop', async () => {
  const dir = tmp();
  const d = daemon(dir);
  let out = '';
  d.stdout!.on('data', (c) => { out += c; });
  const i = await waitFor(() => readDaemonInfo(dir));
  assert.equal(i.pid, d.pid);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
  assert.equal(isLive(i), true);
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${i.port}/api/${p}?token=${i.token}`, init);
  assert.deepEqual(await (await api('ping')).json(), { ok: true, pid: d.pid });
  assert.equal((await fetch(`http://127.0.0.1:${i.port}/api/ping?token=${'b'.repeat(64)}`)).status, 403);
  assert.equal(typeof (await (await api('badge')).json()).badge, 'number');
  assert.equal((await api('stop')).status, 404, 'stop is POST only');
  // A second daemon on the same folder is refused and leaves daemon.json alone.
  const second = spawnSync(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(second.status, 3);
  assert.deepEqual(readDaemonInfo(dir), i);
  assert.equal((await api('stop', { method: 'POST' })).status, 200);
  const [code] = await once(d, 'exit');
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, 'daemon.json')), false);
  assert.equal(existsSync(join(dir, 'backend.lock')), false);
  assert.equal(out, '', 'nothing on stdout: no token in daemon.log');
  assert.match(readFileSync(join(dir, 'backend.log'), 'utf8'), /backend\.stop reason=stopAll/);
});

test('the daemon outlives a closed stdin and ends itself when idle', async () => {
  const dir = tmp();
  // The real driver over an empty claude dir: nothing open, nothing running (the fake script's cards would hold it).
  const d = spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir, '--claude-dir', tmp(), '--exit-idle-ms', '800'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const guard = setTimeout(() => d.kill('SIGKILL'), 15_000);
  d.stdin!.end();
  await waitFor(() => readDaemonInfo(dir));
  const started = Date.now();
  const [code] = await once(d, 'exit');
  clearTimeout(guard);
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 600, 'not before the timeout');
  assert.match(readFileSync(join(dir, 'backend.log'), 'utf8'), /backend\.stop reason=idle/);
  assert.equal(existsSync(join(dir, 'daemon.json')), false);
});

test('a stale daemon.json is replaced by the next daemon', async () => {
  const dir = tmp();
  writeDaemonInfo(dir, info({ pid: spawnSync(process.execPath, ['-e', '0']).pid! }));
  const d = daemon(dir);
  const i = await waitFor(() => { const r = readDaemonInfo(dir); return r?.pid === d.pid ? r : null; });
  assert.equal(isLive(i), true);
  d.kill('SIGTERM');
  await once(d, 'exit');
});
