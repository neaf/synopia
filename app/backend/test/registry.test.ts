import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry, endTerminal, takeoverNote, ttyDevice, waitStable, EXIT_MS, SIGINT_MS } from '../src/registry.ts';
import type { EndDeps, Probe, Terminal } from '../src/registry.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const START = 'Tue Nov 24 10:02:03 2026';

// A fake ~/.claude/sessions with made-up pid files, and a fake process table.
function setup() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-registry-')), 'sessions');
  fs.mkdirSync(dir);
  const procs = new Map<number, { start: string; parent: number }>();
  const probe: Probe = {
    alive: (pid) => procs.has(pid),
    startOf: (pid) => procs.get(pid)?.start ?? '',
    parentOf: (pid) => procs.get(pid)?.parent ?? 0,
  };
  const logs: string[] = [];
  const reg = new Registry({ dir, probe, self: 500, pollMs: 0, watch: false, log: (e) => logs.push(e) });
  const write = (pid: number, over: Record<string, unknown> = {}) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: SID, cwd: '/tmp/x', startedAt: 1, procStart: START, kind: 'interactive', entrypoint: 'cli',
    status: 'idle', statusUpdatedAt: 10, ...over,
  }));
  return { dir, procs, reg, write, logs };
}

test('registry: a live CLI with the same start time holds its session', () => {
  const { reg, write, procs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  write(4242, { status: 'busy' });
  let changed = 0;
  reg.onChange(() => changed++);
  reg.scan();
  assert.deepEqual(reg.holder(SID), { pid: 4242, sessionId: SID, cwd: '/tmp/x', status: 'busy', statusUpdatedAt: 10 });
  assert.equal(changed, 1);
  reg.scan();
  assert.equal(changed, 1, 'no change, no news');
  write(4242, { status: 'idle', statusUpdatedAt: 11 });
  reg.scan();
  assert.equal(changed, 2, 'a status change is news');
  assert.equal(reg.holder(SID)?.status, 'idle');
});

test('registry: a dead pid or another start time (a reused pid) holds nothing', () => {
  const { reg, write, procs } = setup();
  write(4242);
  reg.scan();
  assert.equal(reg.holder(SID), null, 'dead');
  procs.set(4242, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 }); // local time, or another process
  reg.scan();
  assert.equal(reg.holder(SID), null, 'procStart mismatch');
  procs.set(4242, { start: `  ${START.replace(' ', '  ')}`, parent: 1 }); // spacing as ps pads it
  assert.equal(reg.recheck(SID)?.pid, 4242, 'the same time, spacing aside');
  procs.delete(4242);
  reg.scan();
  assert.equal(reg.holder(SID), null, 'exited');
});

test('registry: a .key file is never read, and odd names are skipped', () => {
  const { reg, write, procs, dir } = setup();
  procs.set(4242, { start: START, parent: 1 });
  write(4242);
  fs.writeFileSync(path.join(dir, '4242.abcdef.key'), 'secret');
  fs.chmodSync(path.join(dir, '4242.abcdef.key'), 0o000); // reading it would throw: the scan must not try
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ pid: 4242, sessionId: 'x' }));
  const opened: string[] = [];
  const orig = fs.readFileSync;
  (fs as { readFileSync: unknown }).readFileSync = (f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    opened.push(path.basename(String(f)));
    return (orig as (...a: unknown[]) => unknown)(f, ...rest);
  };
  try {
    reg.scan();
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = orig;
  }
  assert.deepEqual(opened, ['4242.json']);
  assert.equal(reg.holder(SID)?.pid, 4242);
});

test('registry: only interactive cli processes count, and not spare ones', () => {
  const { reg, write, procs } = setup();
  for (const pid of [1, 2, 3, 4, 5]) procs.set(4000 + pid, { start: START, parent: 1 });
  write(4001, { kind: 'background' });
  write(4002, { entrypoint: 'sdk-ts' }); // what an SDK child writes
  write(4003, { entrypoint: 'sdk-cli' });
  write(4004, { spare: true });
  write(4005, { kind: 'daemon-worker' });
  reg.scan();
  assert.equal(reg.holder(SID), null);
});

test("registry: Synopia's own children don't count (pid ancestry)", () => {
  const { reg, write, procs } = setup();
  procs.set(600, { start: 'x', parent: 500 }); // a helper of Synopia (pid 500)
  procs.set(4242, { start: START, parent: 600 }); // a cli it started
  write(4242);
  reg.scan();
  assert.equal(reg.holder(SID), null);
  procs.set(600, { start: 'x', parent: 77 }); // the same pid, a terminal's shell after a restart
  assert.equal(reg.recheck(SID)?.pid, 4242, 'a fresh check walks the parents again');
});

test('registry: a changed format is no terminal, logged once', () => {
  const { reg, procs, dir, logs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ pid: '4242', session: SID }));
  fs.writeFileSync(path.join(dir, '4243.json'), '{"pid": 42'); // mid-write: skipped quietly
  reg.scan();
  reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.deepEqual(logs, ['registry.format']);
});

test('registry: no sessions folder is no terminal', () => {
  const reg = new Registry({ dir: path.join(os.tmpdir(), 'synopia-none', String(Math.random())), pollMs: 0, watch: false });
  reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.equal(reg.recheck(SID), null);
});

test('registry: two files for one session: the newest status wins', () => {
  const { reg, write, procs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  procs.set(4243, { start: START, parent: 1 });
  write(4242, { statusUpdatedAt: 5 });
  write(4243, { statusUpdatedAt: 9, status: 'waiting' });
  reg.scan();
  assert.equal(reg.holder(SID)?.pid, 4243);
});

// ---------- ending a terminal's CLI ----------

function fakeEnd(exitAfter: number | null, signalsToExit: ('SIGTERM' | 'SIGINT')[] = ['SIGTERM']) {
  let t = 0;
  let exitsAt: number | null = null;
  const sent: [string, number][] = [];
  const writes: [string, string][] = [];
  let order: string[] = [];
  const d: EndDeps = {
    kill: (_pid, sig) => {
      sent.push([sig, t]);
      order.push(sig);
      if (exitAfter !== null && signalsToExit.includes(sig) && exitsAt === null) exitsAt = t + exitAfter;
    },
    alive: () => exitsAt === null || t < exitsAt,
    ttyOf: () => 'ttys004',
    write: (dev, text) => { writes.push([dev, text]); order.push(`write@${exitsAt !== null && t >= exitsAt ? 'exited' : 'alive'}`); },
    stat: () => 'same',
    sleep: async (ms) => { t += ms; },
    now: () => t,
  };
  return { d, sent, writes, get order() { return order; }, reset() { order = []; } };
}
const TERM: Terminal = { pid: 54166, sessionId: SID, cwd: '/tmp/x', status: 'idle', statusUpdatedAt: 1 };

test('endTerminal: SIGTERM, the exit, then the note on its terminal', async () => {
  const f = fakeEnd(300);
  assert.equal(await endTerminal(TERM, 'note\n', f.d), true);
  assert.deepEqual(f.sent.map((s) => s[0]), ['SIGTERM']);
  assert.deepEqual(f.writes, [['/dev/ttys004', 'note\n']]);
  assert.deepEqual(f.order, ['SIGTERM', 'write@exited'], 'the note after the exit');
});

test('endTerminal: SIGINT after 5 s, never SIGKILL, false at 10 s', async () => {
  const f = fakeEnd(null);
  assert.equal(await endTerminal(TERM, 'note\n', f.d), false);
  assert.deepEqual(f.sent.map((s) => s[0]), ['SIGTERM', 'SIGINT']);
  assert.ok(f.sent[1][1] >= SIGINT_MS && f.sent[1][1] < EXIT_MS);
  assert.deepEqual(f.writes, [], 'no note when it stays');
  const g = fakeEnd(200, ['SIGINT']);
  assert.equal(await endTerminal(TERM, 'note\n', g.d), true, 'SIGINT did it');
});

test('endTerminal: no tty or a failed write is skipped, logged once', async () => {
  const f = fakeEnd(100);
  f.d.ttyOf = () => '??';
  const logs: string[] = [];
  assert.equal(await endTerminal(TERM, 'n', f.d, (e) => logs.push(e)), true);
  assert.deepEqual(logs, ['registry.noTty']);
  const g = fakeEnd(100);
  g.d.write = () => { throw new Error('EACCES'); };
  assert.equal(await endTerminal(TERM, 'n', g.d, (e) => logs.push(e)), true);
  assert.deepEqual(logs, ['registry.noTty', 'registry.noteFailed']);
});

test('takeoverNote and ttyDevice', () => {
  assert.equal(takeoverNote(SID, new Date(2026, 10, 24, 12, 4)), `Synopia took over this session at 12:04. To continue here instead: claude --resume ${SID}\n`);
  assert.equal(ttyDevice('ttys004'), '/dev/ttys004');
  assert.equal(ttyDevice('??'), '');
  assert.equal(ttyDevice('../disk0'), '');
});

test('waitStable: waits until the file is unchanged for 500 ms', async () => {
  let t = 0;
  const d = fakeEnd(0).d;
  d.now = () => t;
  d.sleep = async (ms) => { t += ms; };
  d.stat = () => (t < 1000 ? `size${Math.floor(t / 100)}` : 'done');
  await waitStable('/x', d);
  assert.ok(t >= 1500 && t < 1700, `took ${t}`);
});
