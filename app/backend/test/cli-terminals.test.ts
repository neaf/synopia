import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTerminals, endTerminal, takeoverNote, ttyDevice, waitStable, EXIT_MS, SIGINT_MS } from '../src/cli-terminals.ts';
import type { EndDeps, Probe, Terminal } from '../src/cli-terminals.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const START = 'Tue Nov 24 10:02:03 2026';

// A fake ~/.claude/sessions with made-up pid files, and a fake process table. `failing` pids make
// `ps` fail (a timeout); `asked` counts the start-time probes.
function setup(end?: EndDeps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-terminals-'));
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const procs = new Map<number, { start: string; parent: number }>();
  const failing = new Set<number>();
  let asked = 0;
  const probe: Probe = {
    alive: (pid) => procs.has(pid),
    startOf: async (pid) => { asked++; return failing.has(pid) ? null : procs.get(pid)?.start ?? ''; },
    parentOf: async (pid) => procs.get(pid)?.parent ?? 0,
  };
  const logs: string[] = [];
  const reg = new CliTerminals({ dir, probe, self: 500, pollMs: 0, watch: false, log: (e) => logs.push(e), end });
  const write = (pid: number, over: Record<string, unknown> = {}) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: SID, cwd: '/tmp/x', startedAt: 1, procStart: START, kind: 'interactive', entrypoint: 'cli',
    status: 'idle', statusUpdatedAt: 10, ...over,
  }));
  return { root, dir, procs, failing, reg, write, logs, get asked() { return asked; } };
}

test('terminals: a live CLI with the same start time holds its session', async () => {
  const { reg, write, procs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  write(4242, { status: 'busy' });
  let changed = 0;
  reg.onChange(() => changed++);
  await reg.scan();
  assert.deepEqual(reg.holder(SID), { pid: 4242, sessionId: SID, procStart: START, cwd: '/tmp/x', status: 'busy', statusUpdatedAt: 10 });
  assert.equal(changed, 1);
  await reg.scan();
  assert.equal(changed, 1, 'no change, no news');
  write(4242, { status: 'idle', statusUpdatedAt: 11 });
  await reg.scan();
  assert.equal(changed, 2, 'a status change is news');
  assert.equal(reg.holder(SID)?.status, 'idle');
});

test('terminals: free (no Claude Code outside Synopia has it open) only after a scan, not while its ps fails', async () => {
  const s = setup();
  let changed = 0;
  s.reg.onChange(() => changed++);
  assert.equal(s.reg.free(SID), false, 'no scan yet: not known');
  await s.reg.scan();
  assert.equal(s.reg.free(SID), true, 'no pid file');
  assert.equal(changed, 1, 'the first scan tells, even with no terminal');
  s.procs.set(4242, { start: START, parent: 1 });
  s.failing.add(4242);
  s.write(4242);
  await s.reg.scan();
  assert.equal(s.reg.holder(SID), null);
  assert.equal(s.reg.free(SID), false, 'a live pid file ps could not check: not known');
  assert.equal(changed, 2);
  s.failing.delete(4242);
  await s.reg.scan();
  assert.equal(s.reg.holder(SID)?.pid, 4242);
  assert.equal(s.reg.free(SID), false, 'a terminal holds it');
  s.procs.delete(4242);
  await s.reg.scan();
  assert.equal(s.reg.free(SID), true, 'its CLI exited');
});

test("terminals: another app's SDK child is no terminal but has the session open; Synopia's own does not count", async () => {
  const s = setup();
  s.procs.set(4300, { start: START, parent: 1 });
  s.write(4300, { entrypoint: 'sdk-ts' });
  await s.reg.scan();
  assert.equal(s.reg.holder(SID), null, 'not a terminal: nothing to take over');
  assert.equal(s.reg.free(SID), false, 'but a live process has it open');
  const own = setup(); // Synopia's pid is 500
  own.procs.set(4301, { start: START, parent: 500 });
  own.write(4301, { entrypoint: 'sdk-ts' });
  await own.reg.scan();
  assert.equal(own.reg.free(SID), true, "Synopia's own process is known without its pid file");
  own.write(4302, { spare: true });
  own.procs.set(4302, { start: START, parent: 1 });
  await own.reg.scan();
  assert.equal(own.reg.free(SID), true, 'a spare holds nothing');
});

test('terminals: a dead pid or another start time (a reused pid) holds nothing', async () => {
  const { reg, write, procs } = setup();
  write(4242);
  await reg.scan();
  assert.equal(reg.holder(SID), null, 'dead');
  procs.set(4242, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 }); // local time, or another process
  await reg.scan();
  assert.equal(reg.holder(SID), null, 'procStart mismatch');
  procs.delete(4242);
  await reg.scan();
  procs.set(4242, { start: `  ${START.replace(' ', '  ')}`, parent: 1 }); // spacing as ps pads it
  await reg.scan();
  assert.equal(reg.holder(SID)?.pid, 4242, 'the same time, spacing aside');
  procs.delete(4242);
  await reg.scan();
  assert.equal(reg.holder(SID), null, 'exited');
});

test('terminals: a live pid whose start differs is logged once', async () => {
  const { reg, write, procs, logs } = setup();
  procs.set(4242, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 });
  procs.set(4243, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 });
  write(4242);
  write(4243);
  await reg.scan();
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.deepEqual(logs, ['terminals.startMismatch']);
});

test('terminals: a failed ps leaves the terminal unknown, and the next scan asks again', async () => {
  const s = setup();
  s.procs.set(4242, { start: START, parent: 1 });
  s.failing.add(4242);
  s.write(4242);
  await s.reg.scan();
  assert.equal(s.reg.holder(SID), null, 'unknown: not yielded to yet');
  const before = s.asked;
  await s.reg.scan();
  assert.equal(s.asked, before + 1, 'not cached: asked again');
  s.failing.delete(4242);
  await s.reg.scan();
  assert.equal(s.reg.holder(SID)?.pid, 4242, 'seen once ps answers');
  const after = s.asked;
  await s.reg.scan();
  assert.equal(s.asked, after, 'a verified terminal is not asked again');
});

test('terminals: recheck reads the files now; an unverified CLI counts until a scan says otherwise', async () => {
  const { reg, write, procs } = setup();
  let changed = 0;
  reg.onChange(() => changed++);
  procs.set(4242, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 }); // a reused pid behind a stale file
  write(4242);
  assert.equal(reg.recheck(SID)?.pid, 4242, 'not verified yet: one writer, so it holds');
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.equal(changed, 1, 'the scan tells Sessions it was no terminal');
  assert.equal(reg.recheck(SID), null, 'verified now: no terminal');
  procs.delete(4242);
  assert.equal(reg.recheck(SID), null);
});

test('terminals: confirm (the start check) verifies every live pid afresh; a failed ps holds', async () => {
  const { reg, write, procs, failing } = setup();
  procs.set(4242, { start: START, parent: 1 });
  write(4242);
  await reg.scan();
  assert.equal(reg.holder(SID)?.pid, 4242);
  procs.set(4242, { start: 'Tue Nov 24 11:02:03 2026', parent: 1 }); // the CLI died, its pid reused
  assert.equal(reg.recheck(SID)?.pid, 4242, 'recheck takes the stored verification');
  assert.equal(await reg.confirm(SID), null, 'confirm asks ps now: no terminal');
  assert.equal(reg.holder(SID), null);
  procs.set(4242, { start: START, parent: 1 });
  failing.add(4242);
  assert.equal((await reg.confirm(SID))?.pid, 4242, 'ps failed: one writer, so it holds');
  failing.delete(4242);
  procs.delete(4242);
  assert.equal(await reg.confirm(SID), null, 'gone');
});

test('terminals: a .key file is never read, and odd names are skipped', async () => {
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
    await reg.scan();
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = orig;
  }
  assert.deepEqual(opened, ['4242.json']);
  assert.equal(reg.holder(SID)?.pid, 4242);
});

test('terminals: only interactive cli processes count, and not spare ones', async () => {
  const { reg, write, procs } = setup();
  for (const pid of [1, 2, 3, 4, 5]) procs.set(4000 + pid, { start: START, parent: 1 });
  write(4001, { kind: 'background' });
  write(4002, { entrypoint: 'sdk-ts' }); // what an SDK child writes
  write(4003, { entrypoint: 'sdk-cli' });
  write(4004, { spare: true });
  write(4005, { kind: 'daemon-worker' });
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.equal(reg.recheck(SID), null, 'none of them counts at a recheck either');
});

test("terminals: Synopia's own children don't count (pid ancestry)", async () => {
  const { reg, write, procs } = setup();
  procs.set(600, { start: 'x', parent: 500 }); // a helper of Synopia (pid 500)
  procs.set(4242, { start: START, parent: 600 }); // a cli it started
  write(4242);
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.equal(reg.recheck(SID), null);
});

test('terminals: a changed format is no terminal, logged once', async () => {
  const { reg, procs, dir, logs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ pid: '4242', session: SID }));
  fs.writeFileSync(path.join(dir, '4243.json'), '{"pid": 42'); // mid-write: skipped quietly
  await reg.scan();
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.deepEqual(logs, ['terminals.format']);
});

test('terminals: no sessions folder is no terminal', async () => {
  const reg = new CliTerminals({ dir: path.join(os.tmpdir(), 'synopia-none', String(Math.random())), pollMs: 0, watch: false });
  await reg.scan();
  assert.equal(reg.holder(SID), null);
  assert.equal(reg.recheck(SID), null);
});

test('terminals: two files for one session: the newest status wins', async () => {
  const { reg, write, procs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  procs.set(4243, { start: START, parent: 1 });
  write(4242, { statusUpdatedAt: 5 });
  write(4243, { statusUpdatedAt: 9, status: 'waiting' });
  await reg.scan();
  assert.equal(reg.holder(SID)?.pid, 4243);
});

test('terminals: scans run one at a time; one asked during a scan runs after it', async () => {
  const { reg, write, procs } = setup();
  procs.set(4242, { start: START, parent: 1 });
  write(4242);
  const a = reg.scan();
  const b = reg.scan();
  assert.equal(a, b, 'the second call joins the running scan');
  await a;
  assert.equal(reg.holder(SID)?.pid, 4242);
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
    ttyOf: async () => 'ttys004',
    write: (dev, text) => { writes.push([dev, text]); order.push(`write@${exitsAt !== null && t >= exitsAt ? 'exited' : 'alive'}`); },
    stat: () => 'same',
    sleep: async (ms) => { t += ms; },
    now: () => t,
  };
  return { d, sent, writes, get order() { return order; }, reset() { order = []; } };
}
const TERM: Terminal = { pid: 54166, sessionId: SID, procStart: START, cwd: '/tmp/x', status: 'idle', statusUpdatedAt: 1 };

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
  f.d.ttyOf = async () => '??';
  const logs: string[] = [];
  assert.equal(await endTerminal(TERM, 'n', f.d, (e) => logs.push(e)), true);
  assert.deepEqual(logs, ['terminals.noTty']);
  const g = fakeEnd(100);
  g.d.write = () => { throw new Error('EACCES'); };
  assert.equal(await endTerminal(TERM, 'n', g.d, (e) => logs.push(e)), true);
  assert.deepEqual(logs, ['terminals.noTty', 'terminals.noteFailed']);
  const h = fakeEnd(100);
  h.d.ttyOf = async () => null; // ps failed
  assert.equal(await endTerminal(TERM, 'n', h.d, (e) => logs.push(e)), true);
  assert.deepEqual(h.writes, []);
});

test('end: the start time is checked afresh before the signal', async () => {
  const f = fakeEnd(100);
  const s = setup(f.d);
  s.procs.set(TERM.pid, { start: START, parent: 1 });
  s.write(TERM.pid);
  await s.reg.scan();
  const held = s.reg.holder(SID) as Terminal;
  s.procs.set(TERM.pid, { start: 'Wed Nov 25 09:00:00 2026', parent: 1 }); // the CLI exited and the pid was reused
  assert.equal(await s.reg.end(held, 'n', SID), true, 'gone: the take-over goes on');
  assert.deepEqual(f.sent, [], 'the other process gets no signal');
  s.procs.set(TERM.pid, { start: START, parent: 1 });
  s.failing.add(TERM.pid);
  assert.equal(await s.reg.end(held, 'n', SID), false, 'ps failed: no signal, the message stays');
  assert.deepEqual(f.sent, []);
  assert.ok(s.logs.includes('terminals.unverified'));
  s.failing.delete(TERM.pid);
  assert.equal(await s.reg.end(held, 'n', SID), true);
  assert.deepEqual(f.sent.map((x) => x[0]), ['SIGTERM']);
});

test('end: waits for the session transcript to settle', async () => {
  const f = fakeEnd(100);
  const s = setup(f.d);
  const file = path.join(s.root, 'projects', '-tmp-x', `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  let stats = 0;
  f.d.stat = (p) => { if (p === file) stats++; return 'same'; };
  s.procs.set(TERM.pid, { start: START, parent: 1 });
  assert.equal(await s.reg.end(TERM, 'n', SID), true);
  assert.ok(stats > 1, 'the transcript is watched');
});

test('takeoverNote and ttyDevice', () => {
  assert.equal(takeoverNote(SID, new Date(2026, 10, 24, 12, 4)), `Synopia took over this session at 12:04. To continue here instead: claude --resume ${SID}\n`);
  assert.equal(ttyDevice('ttys004'), '/dev/ttys004');
  assert.equal(ttyDevice('pts/3'), '/dev/pts/3');
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
