import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  IdleExit, UpdateCheck, codeHash, isLive, ownStart, parseDaemonInfo, readDaemonInfo, removeDaemonInfo, rotateLog, successorArgs,
  writeDaemonInfo,
} from '../src/daemon.ts';
import type { DaemonInfo } from '../src/daemon.ts';
import { procStart } from '../src/macos.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-daemon-'));
const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/claude', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const TOKEN = 'a'.repeat(64);
const info = (o: Partial<DaemonInfo> = {}): DaemonInfo => ({ pid: 4242, procStart: 'Tue Nov 24 10:00:00 2026', port: 4717, token: TOKEN, version: '0.1.0', code: '0123456789abcdef', ...o });

test('daemon.json: a good file parses, any wrong field is null', () => {
  assert.deepEqual(parseDaemonInfo(JSON.stringify(info())), info());
  for (const bad of [
    '', '{', 'null', '[]', '{}',
    JSON.stringify(info({ pid: 0 })), JSON.stringify(info({ pid: 1.5 })), JSON.stringify({ ...info(), pid: '4242' }),
    JSON.stringify(info({ port: 0 })), JSON.stringify(info({ port: 70000 })),
    JSON.stringify(info({ token: 'short' })), JSON.stringify(info({ token: 'Z'.repeat(64) })),
    JSON.stringify({ ...info(), procStart: undefined }), JSON.stringify({ ...info(), version: 1 }),
    JSON.stringify({ ...info(), code: undefined }),
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
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  assert.equal(await isLive(info({ pid: dead })), false);
  assert.match(await ownStart(), /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
  assert.equal(await procStart(process.pid), await ownStart(), 'as printed, not squashed: the app compares the string');
});

test("ownStart: asks ps again after a failure, '' when it never answers", async () => {
  let n = 0;
  assert.equal(await ownStart(1, async () => (++n < 3 ? null : 'Tue Nov 24 10:00:00 2026')), 'Tue Nov 24 10:00:00 2026');
  assert.equal(n, 3);
  assert.equal(await ownStart(1, async () => null), '');
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

test('code hash: every src .ts file and package-lock.json, nothing else', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2;\n');
  assert.equal(codeHash(dir), null, 'no package-lock.json: unreadable');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const h = codeHash(dir)!;
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(codeHash(dir), h, 'the same tree, the same hash');
  writeFileSync(join(dir, 'src', 'notes.md'), 'not code');
  writeFileSync(join(dir, 'README.md'), 'not code');
  assert.equal(codeHash(dir), h, 'other files are not code');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2; // a comment\n');
  const h2 = codeHash(dir)!;
  assert.notEqual(h2, h, 'a comment in a nested file changes it');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2;\n');
  assert.equal(codeHash(dir), h, 'reverted: back to the first');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
  assert.notEqual(codeHash(dir), h, 'the lock file counts');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, 'src', 'c.ts'), '');
  assert.notEqual(codeHash(dir), h, 'a new file counts');
  assert.match(codeHash(new URL('..', import.meta.url).pathname)!, /^[0-9a-f]{16}$/, 'the backend itself');
});

test('update rule: pending once a new hash holds for two reads; restart only when nothing runs', () => {
  const u = new UpdateCheck('aaaa');
  assert.equal(u.read('aaaa'), false);
  assert.equal(u.read('bbbb'), false, 'one read of a new hash: maybe a save in progress');
  assert.equal(u.pending, false);
  assert.equal(u.restartNow(false), false);
  assert.equal(u.read('cccc'), false, 'still changing');
  assert.equal(u.read('cccc'), true, 'steady: pending');
  assert.equal(u.pending, true);
  assert.equal(u.read(null), false, 'an unreadable tree is skipped');
  assert.equal(u.pending, true);
  assert.equal(u.restartNow(true), false, 'never while work runs');
  assert.equal(u.restartNow(false), true, 'at once when idle');
  assert.equal(u.read('aaaa'), true, 'the checkout went back to the running code');
  assert.equal(u.pending, false);
  assert.equal(u.restartNow(false), false);
  u.read('dddd'); u.read('dddd');
  assert.equal(u.pending, true);
  u.fail();
  assert.equal(u.pending, false, 'a new daemon that failed to start');
  assert.equal(u.read('dddd'), false, 'that hash is not tried again');
  assert.equal(u.restartNow(false), false);
  u.read('eeee');
  assert.equal(u.read('eeee'), true, 'the next change is');
});

test('the new daemon gets the same flags and --after the old pid', () => {
  assert.deepEqual(successorArgs(['/x/main.ts', '--state-dir', '/s', '--dry-run'], 7), ['/x/main.ts', '--state-dir', '/s', '--dry-run', '--after', '7']);
  assert.deepEqual(successorArgs(['/x/main.ts', '--after', '5', '--dry-run', '--after=6'], 7), ['/x/main.ts', '--dry-run', '--after', '7']);
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

// A page's socket on a daemon, authenticated, with its hello.
async function hello(i: DaemonInfo): Promise<{ ws: WebSocket; hello: Record<string, unknown> }> {
  const origin = `http://127.0.0.1:${i.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${i.port}/ws`, { origin });
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: i.token }));
  for (;;) {
    const [data] = await once(ws, 'message');
    const m = JSON.parse(String(data));
    if (m.t === 'hello') return { ws, hello: m };
  }
}

// The scripted SDK over a copy of the fixture tree (it writes to the transcripts as a CLI would).
function scriptedCopy(): string[] {
  const claude = join(mkdtempSync(join(tmpdir(), 'synopia-claude-')), 'claude');
  cpSync(FIXTURES, claude, { recursive: true });
  return ['--claude-dir', claude, '--sdk-script', join(claude, 'sdk-script.json')];
}

function daemon(dir: string, extra: string[] = []) {
  return spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir, ...scriptedCopy(), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.equal(await isLive(i), true);
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${i.port}/api/${p}?token=${i.token}`, init);
  assert.deepEqual(await (await api('ping')).json(), { ok: true, pid: d.pid, code: i.code });
  assert.equal(i.code, codeHash(new URL('..', import.meta.url).pathname), 'the code it runs');
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
  // The real driver over an empty claude dir: nothing open, nothing running (the fixture script's cards would hold it).
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
  assert.equal(await isLive(i), true);
  d.kill('SIGTERM');
  await once(d, 'exit');
});

test('POST /api/restart hands over to a new daemon on the same state folder', async () => {
  const dir = tmp();
  // The real driver over an empty claude dir: nothing runs. Its stdout and stderr are daemon.log,
  // as the shell starts it. The new daemon is detached: killed below.
  const log = openSync(join(dir, 'daemon.log'), 'a');
  const d = spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir, '--claude-dir', tmp()], { stdio: ['ignore', log, log] });
  closeSync(log);
  const i = await waitFor(() => readDaemonInfo(dir));
  // A page's UI state, sent just before: still in memory (state.json writes are spaced), so the
  // old daemon must write it on the way out for the new one's hello to have it.
  const page = await hello(i);
  page.ws.send(JSON.stringify({ t: 'ui', patch: { openList: { filter: 'handover' } } }));
  await new Promise((ok) => setTimeout(ok, 100));
  const closed = once(page.ws, 'close');
  assert.equal((await fetch(`http://127.0.0.1:${i.port}/api/restart?token=${i.token}`, { method: 'POST' })).status, 200);
  const [code] = await once(d, 'exit');
  assert.equal(code, 0);
  await closed;
  const n = await waitFor(() => { const r = readDaemonInfo(dir); return r && r.pid !== i.pid ? r : null; });
  try {
    const again = await hello(n);
    assert.deepEqual((again.hello.ui as { openList: unknown }).openList, { filter: 'handover' });
    again.ws.close();
    assert.equal(await isLive(n), true);
    assert.notEqual(n.token, i.token);
    assert.equal(n.code, i.code);
    assert.equal(readFileSync(join(dir, 'backend.lock'), 'utf8'), String(n.pid), 'the new daemon holds the lock');
    const lines = readFileSync(join(dir, 'backend.log'), 'utf8');
    assert.match(lines, /handover\.start reason=restart/);
    assert.match(lines, /backend\.stop reason=restart/);
    assert.match(readFileSync(join(dir, 'daemon.log'), 'utf8'), /Synopia backend: stop \(restart\)\n$/, 'the shell reads this line');
    assert.equal((await fetch(`http://127.0.0.1:${n.port}/api/stop?token=${n.token}`, { method: 'POST' })).status, 200);
    for (const end = Date.now() + 15_000; await isLive(n);) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((ok) => setTimeout(ok, 50));
    }
  } finally {
    try { process.kill(n.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});
