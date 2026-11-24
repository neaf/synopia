// daemon.ts: the idle exit, the code hash, the update rule, and the lifecycle of a real daemon (start,
// stop, idle end, a stale daemon.json, a restart's handover, a crash, the shutdown order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, openSync, closeSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CodeHasher, IdleExit, UpdateCheck, codeHash, successorArgs } from '../src/daemon.ts';
import { acquireLock, isLive, lockOwner, readDaemonInfo, writeDaemonInfo } from '../src/daemon-files.ts';
import type { DaemonInfo } from '../src/daemon-files.ts';
import { backendCopy, connectPage, scripted, shellDaemon, waitFor as until, watchDaemonJson } from './daemon-harness.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-daemon-'));
const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const TOKEN = 'a'.repeat(64);
const info = (o: Partial<DaemonInfo> = {}): DaemonInfo => ({ pid: 4242, procStart: 'Tue Nov 24 10:00:00 2026', port: 4717, token: TOKEN, version: '0.1.0', code: '0123456789abcdef', v: 1, ...o });

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

test('code hash: every src .ts file, package-lock.json and the page\'s protocol.js, nothing else', async () => {
  const dir = join(tmp(), 'backend');
  mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2;\n');
  assert.equal(await codeHash(dir), null, 'no package-lock.json: unreadable');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const h = (await codeHash(dir))!;
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(await codeHash(dir), h, 'the same tree, the same hash');
  writeFileSync(join(dir, 'src', 'notes.md'), 'not code');
  writeFileSync(join(dir, 'README.md'), 'not code');
  assert.equal(await codeHash(dir), h, 'other files are not code');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2; // a comment\n');
  const h2 = (await codeHash(dir))!;
  assert.notEqual(h2, h, 'a comment in a nested file changes it');
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2;\n');
  assert.equal(await codeHash(dir), h, 'reverted: back to the first');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
  assert.notEqual(await codeHash(dir), h, 'the lock file counts');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, 'src', 'c.ts'), '');
  assert.notEqual(await codeHash(dir), h, 'a new file counts');
  const h3 = (await codeHash(dir))!;
  mkdirSync(join(dir, '..', 'web', 'js'), { recursive: true });
  writeFileSync(join(dir, '..', 'web', 'js', 'protocol.js'), 'export const VERSION = 2;\n');
  const h4 = (await codeHash(dir))!;
  assert.notEqual(h4, h3, 'the page\'s protocol.js counts');
  writeFileSync(join(dir, '..', 'web', 'js', 'protocol.js'), 'export const VERSION = 3;\n');
  assert.notEqual(await codeHash(dir), h4, 'a protocol.js change alone is new code (final-daemon#B3)');
  assert.match((await codeHash(new URL('..', import.meta.url).pathname))!, /^[0-9a-f]{16}$/, 'the backend itself');
});

test('code hash: async, and an unchanged file is not read again (NFR-06)', async () => {
  const dir = join(tmp(), 'backend');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  const read: string[] = [];
  const io = {
    readdir: async (d: string) => readdirSync(d, { recursive: true }) as string[],
    stat: async (f: string) => statSync(f),
    readFile: async (f: string) => { read.push(f.slice(dir.length + 1)); return readFileSync(f); },
  };
  const hasher = new CodeHasher(dir, io);
  const pending = hasher.read();
  assert.ok(pending instanceof Promise);
  const h = await pending;
  assert.equal(h, await codeHash(dir), 'the same hash as a fresh reading');
  assert.deepEqual(read.sort(), ['package-lock.json', 'src/a.ts', 'src/b.ts']);
  read.length = 0;
  assert.equal(await hasher.read(), h);
  assert.deepEqual(read, [], 'nothing changed: nothing read');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 22;\n');
  const h2 = await hasher.read();
  assert.deepEqual(read, ['src/b.ts'], 'only the changed file');
  assert.notEqual(h2, h);
  assert.equal(h2, await codeHash(dir));
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

test('update rule: a deferred handover waits for the next reading, not the next idle second (backend-core#B10)', () => {
  const u = new UpdateCheck('aaaa');
  u.read('bbbb'); u.read('bbbb');
  assert.equal(u.restartNow(false), true);
  u.defer(); // work started while the new daemon loaded
  assert.equal(u.restartNow(false), false, 'idle again within the same reading');
  assert.equal(u.restartNow(false), false);
  assert.equal(u.read(null), false);
  assert.equal(u.restartNow(false), false, 'an unreadable tree is no new reading');
  assert.equal(u.read('bbbb'), false, 'still pending');
  assert.equal(u.restartNow(true), false, 'a new reading, but busy');
  assert.equal(u.restartNow(false), true, 'a new reading and idle');
});

test('the new daemon gets the same flags and --after the old pid', () => {
  assert.deepEqual(successorArgs(['/x/main.ts', '--state-dir', '/s', '--dry-run'], 7), ['/x/main.ts', '--state-dir', '/s', '--dry-run', '--after', '7']);
  assert.deepEqual(successorArgs(['/x/main.ts', '--after', '5', '--dry-run', '--after=6'], 7), ['/x/main.ts', '--dry-run', '--after', '7']);
});

async function waitFor<T>(get: () => T | null | undefined, ms = 15_000): Promise<T> {
  return until(get, ms);
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

function daemon(dir: string, extra: string[] = []) {
  return spawn(process.execPath, [...NODE_FLAGS, MAIN, '--state-dir', dir, ...scripted(), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('the daemon writes daemon.json, answers ping and badge, and ends on POST /api/stop', async () => {
  const dir = tmp();
  const d = daemon(dir);
  let out = '';
  d.stdout!.on('data', (c) => { out += c; });
  const i = await waitFor(() => readDaemonInfo(dir));
  assert.equal(i.pid, d.pid);
  assert.equal(i.handover, undefined);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
  assert.equal(await isLive(i), true);
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${i.port}/api/${p}?token=${i.token}`, init);
  assert.deepEqual(await (await api('ping')).json(), { ok: true, pid: d.pid, code: i.code, v: i.v });
  assert.equal(i.code, await codeHash(new URL('..', import.meta.url).pathname), 'the code it runs');
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
  assert.equal(lockOwner(dir), null, 'the lock is free');
  assert.equal(out, '', 'nothing on stdout: no token in daemon.log');
  assert.match(readFileSync(join(dir, 'backend.log'), 'utf8'), /backend\.stop reason=stopAll/);
});

test('a stopping daemon sends the pages nothing after the router refused: no card cleared on the way out', async () => {
  const d = await shellDaemon(scripted());
  try {
    const page = await connectPage(d.info);
    const shown = page.hello.pending as unknown[];
    assert.ok(Array.isArray(shown) && shown.length > 0, 'the script has cards waiting');
    await new Promise((ok) => setTimeout(ok, 300));
    const from = page.frames.length;
    const closed = once(page.ws, 'close');
    assert.equal((await fetch(`http://127.0.0.1:${d.info.port}/api/stop?token=${d.info.token}`, { method: 'POST' })).status, 200);
    await closed;
    const after = page.frames.slice(from).map((m) => m.t);
    assert.deepEqual(after.filter((t) => t !== 'ack'), [], `frames after the stop: ${after.join(', ')}`);
  } finally { await d.stop(); }
});

test('the daemon outlives a closed stdin and ends itself when idle', async () => {
  const dir = tmp();
  // The real SDK over an empty claude dir: nothing open, nothing running (the fixture script's cards would hold it).
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

test('an uncaught error writes state.json first, removes daemon.json and exits 1 (seams#B4)', async () => {
  const { main, dir: backend } = backendCopy();
  const trigger = join(backend, 'crash-now');
  // the copy throws from a timer once the trigger file appears: an error no handler catches
  writeFileSync(main, readFileSync(main, 'utf8') + `\nimport { existsSync as crashNow } from 'node:fs';\nsetInterval(() => { if (crashNow(${JSON.stringify(trigger)})) throw new Error('made-up crash'); }, 20);\n`);
  const d = await shellDaemon(['--claude-dir', tmp()], main);
  const page = await hello(d.info);
  // still in memory: state.json is written at most once a second
  page.ws.send(JSON.stringify({ t: 'ui', patch: { openList: { filter: 'crash' } } }));
  await new Promise((ok) => setTimeout(ok, 50));
  const exited = once(d.child, 'exit');
  writeFileSync(trigger, '');
  const [code] = await exited;
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(d.stateDir, 'state.json'), 'utf8')).ui.openList, { filter: 'crash' });
  assert.equal(existsSync(join(d.stateDir, 'daemon.json')), false);
  assert.match(d.log(), /backend\.crash kind=uncaughtException/);
  assert.match(d.daemonLog(), /Synopia backend: uncaughtException: Error: made-up crash/);
  acquireLock(d.stateDir).release(); // the kernel dropped the lock with the process
});

test('POST /api/restart hands over to a new daemon on the same state folder, through daemon.json handover', async () => {
  const dir = tmp();
  // The real SDK over an empty claude dir: nothing runs. Its stdout and stderr are daemon.log,
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
  const fresh = waitFor(() => { const r = readDaemonInfo(dir); return r && r.pid !== i.pid ? r : null; });
  const seen = watchDaemonJson(dir, fresh);
  assert.equal((await fetch(`http://127.0.0.1:${i.port}/api/restart?token=${i.token}`, { method: 'POST' })).status, 200);
  const [code] = await once(d, 'exit');
  assert.equal(code, 0);
  await closed;
  const n = await fresh;
  try {
    const marked = (await seen).find((x) => x.handover);
    assert.ok(marked, 'the old daemon left daemon.json with a handover');
    assert.deepEqual(marked, { ...i, handover: { reason: 'restart', successor: n.pid } });
    assert.equal(n.handover, undefined);
    const again = await hello(n);
    assert.deepEqual((again.hello.ui as { openList: unknown }).openList, { filter: 'handover' });
    again.ws.close();
    assert.equal(await isLive(n), true);
    assert.notEqual(n.token, i.token);
    assert.equal(n.code, i.code);
    assert.equal(lockOwner(dir), n.pid, 'the new daemon holds the lock');
    const lines = readFileSync(join(dir, 'backend.log'), 'utf8');
    assert.match(lines, /handover\.start reason=restart/);
    assert.match(lines, /backend\.stop reason=restart/);
    assert.equal((await fetch(`http://127.0.0.1:${n.port}/api/stop?token=${n.token}`, { method: 'POST' })).status, 200);
    for (const end = Date.now() + 15_000; await isLive(n);) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((ok) => setTimeout(ok, 50));
    }
  } finally {
    try { process.kill(n.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});
